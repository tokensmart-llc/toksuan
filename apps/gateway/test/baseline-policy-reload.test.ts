/**
 * v0.6.5 — file-watch + pg_notify hot-reload for baseline-policy.json.
 *
 * Closes the v0.6.4 follow-up: policy artifact refresh no longer needs an
 * operator-initiated gateway restart. The policy artifact is
 * re-read in-place via fs.watch (single-node) + pg_notify
 * (multi-replica), with a 300ms debounce that coalesces the
 * write-storms most filesystems emit.
 *
 * This file pins the contract:
 *   (a) reloadBaselinePolicy() picks up new artifact contents
 *   (b) failed reads keep the prior cached artifact (no nukes)
 *   (c) the per-(project, tag) loader cache is flushed on reload
 *       so SQLite + no-active-row Postgres callers see the new
 *       artifact within the debounce window (NOT after the 60s TTL)
 *   (d) file watcher fires reload when the file is rewritten
 *   (e) TOKENSMART_BASELINE_POLICY_WATCH=0 disables the watcher
 *   (f) pg_notify subscriber wires onto the right channel + is
 *       no-op when baseline policy is disabled
 *   (g) stop watcher is idempotent + clean
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? ":memory:";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  _resetBaselinePolicy,
  invalidateAllProjectPolicies,
  loadActivePolicy,
  loadBaselinePolicy,
  reloadBaselinePolicy,
  startBaselinePolicyFileWatcher,
  stopBaselinePolicyFileWatcher,
  subscribeToBaselinePolicyReload,
  type BaselinePolicy,
} from "../src/policy";

function syntheticPolicy(version: string, modelLabel: string): BaselinePolicy {
  return {
    version,
    generated_at: new Date(0).toISOString(),
    benchmarks: ["unit"],
    judge_model: null,
    default_eps: 0.05,
    buckets: [
      {
        task_type: "code",
        complexity: "medium",
        max_quality: 1,
        models: [
          {
            model: modelLabel,
            provider: "openai",
            avg_cost_micro_cents: 100,
            avg_input_tokens: 100,
            avg_output_tokens: 100,
            quality_score: 0.95,
            n: 50,
          },
        ],
      },
    ],
    lookup: {
      "code:medium": {
        task_type: "code",
        complexity: "medium",
        max_quality: 1,
        models: [
          {
            model: modelLabel,
            provider: "openai",
            avg_cost_micro_cents: 100,
            avg_input_tokens: 100,
            avg_output_tokens: 100,
            quality_score: 0.95,
            n: 50,
          },
        ],
      },
    },
  };
}

describe("baseline-policy reload — drop-in replace cached artifact", () => {
  let tmpDir: string;
  let artifactPath: string;
  let prevPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "ts-baseline-reload-"));
    artifactPath = path.join(tmpDir, "baseline-policy.json");
    prevPath = process.env.TOKENSMART_BASELINE_POLICY_PATH;
    process.env.TOKENSMART_BASELINE_POLICY_PATH = artifactPath;
    _resetBaselinePolicy();
  });

  afterEach(() => {
    if (prevPath !== undefined) process.env.TOKENSMART_BASELINE_POLICY_PATH = prevPath;
    else delete process.env.TOKENSMART_BASELINE_POLICY_PATH;
    _resetBaselinePolicy();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("reload observes an updated artifact (new version)", () => {
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1.first", "model-a")));
    expect(loadBaselinePolicy()!.version).toBe("v1.first");

    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1.second", "model-b")));
    // Without reload, we still see the cached v1.first.
    expect(loadBaselinePolicy()!.version).toBe("v1.first");
    // After reload, we see v1.second.
    const reloaded = reloadBaselinePolicy();
    expect(reloaded!.version).toBe("v1.second");
    expect(reloaded!.buckets[0]!.models[0]!.model).toBe("model-b");
  });

  test("reload with bad JSON does NOT nuke the prior cache (atomic-ish swap)", () => {
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1.good", "model-good")));
    expect(loadBaselinePolicy()!.version).toBe("v1.good");

    // Corrupt the file (e.g. mid-write race, hand-edit typo).
    writeFileSync(artifactPath, "{not valid json");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const r = reloadBaselinePolicy();
      // Failed read returns the PRIOR cached policy, not null.
      // A working policy should never be replaced by garbage.
      expect(r).not.toBeNull();
      expect(r!.version).toBe("v1.good");
      expect(warnings.some((w) => w.includes("failed to reload"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test("reload with missing file logs + keeps prior cache", () => {
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1.first", "model-a")));
    expect(loadBaselinePolicy()!.version).toBe("v1.first");

    rmSync(artifactPath);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const r = reloadBaselinePolicy();
      expect(r).not.toBeNull();
      expect(r!.version).toBe("v1.first");
      expect(
        logs.some((l) => l.includes("reload requested but") && l.includes("missing"))
      ).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});

describe("reload flushes the per-(project, tag) loader cache", () => {
  let tmpDir: string;
  let artifactPath: string;
  let prevPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "ts-baseline-cache-flush-"));
    artifactPath = path.join(tmpDir, "baseline-policy.json");
    prevPath = process.env.TOKENSMART_BASELINE_POLICY_PATH;
    process.env.TOKENSMART_BASELINE_POLICY_PATH = artifactPath;
    _resetBaselinePolicy();
    invalidateAllProjectPolicies();
  });

  afterEach(() => {
    if (prevPath !== undefined) process.env.TOKENSMART_BASELINE_POLICY_PATH = prevPath;
    else delete process.env.TOKENSMART_BASELINE_POLICY_PATH;
    _resetBaselinePolicy();
    invalidateAllProjectPolicies();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("SQLite-mode caller's cached entry sees the new baseline within the debounce window", async () => {
    // SQLite mode is the dbBackend the test runs under (`:memory:`).
    // loadActivePolicy(projectId="p1") falls through to the baseline
    // and CACHES it under key `p1::` for 60s. Without the flush, a
    // post-reload caller would still see the OLD baseline for up
    // to a minute.
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1.cached", "model-a")));
    loadBaselinePolicy(); // prime the index.ts cache

    const first = await loadActivePolicy("00000000-0000-0000-0000-000000000001", null);
    expect(first!.version).toBe("v1.cached");

    // Operator refreshes the policy artifact, file changes.
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v2.fresh", "model-b")));
    reloadBaselinePolicy();

    // Same projectId in same TTL window — without the flush this
    // would still return the stale v1.cached. With the flush, the
    // loader's per-(project, tag) entry was dropped → fall-through
    // re-runs → picks up v2.fresh.
    const second = await loadActivePolicy("00000000-0000-0000-0000-000000000001", null);
    expect(second!.version).toBe("v2.fresh");
  });
});

describe("file watcher — fs.watch triggers reload", () => {
  let tmpDir: string;
  let artifactPath: string;
  let prevPath: string | undefined;
  let prevWatch: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "ts-baseline-watch-"));
    artifactPath = path.join(tmpDir, "baseline-policy.json");
    prevPath = process.env.TOKENSMART_BASELINE_POLICY_PATH;
    prevWatch = process.env.TOKENSMART_BASELINE_POLICY_WATCH;
    process.env.TOKENSMART_BASELINE_POLICY_PATH = artifactPath;
    delete process.env.TOKENSMART_BASELINE_POLICY_WATCH;
    _resetBaselinePolicy();
  });

  afterEach(() => {
    stopBaselinePolicyFileWatcher();
    if (prevPath !== undefined) process.env.TOKENSMART_BASELINE_POLICY_PATH = prevPath;
    else delete process.env.TOKENSMART_BASELINE_POLICY_PATH;
    if (prevWatch !== undefined) process.env.TOKENSMART_BASELINE_POLICY_WATCH = prevWatch;
    else delete process.env.TOKENSMART_BASELINE_POLICY_WATCH;
    _resetBaselinePolicy();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("rewriting the artifact file triggers reload after debounce window", async () => {
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1.before", "model-a")));
    expect(loadBaselinePolicy()!.version).toBe("v1.before");

    startBaselinePolicyFileWatcher();
    // Rewrite the file — fs.watch on the directory should fire, debounce
    // for 300ms, then reload.
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v2.after", "model-b")));

    // Wait debounce + a small buffer.
    await new Promise((r) => setTimeout(r, 600));
    expect(loadBaselinePolicy()!.version).toBe("v2.after");
  });

  test("TOKENSMART_BASELINE_POLICY_WATCH=0 prevents watcher from starting", async () => {
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1.locked", "model-a")));
    expect(loadBaselinePolicy()!.version).toBe("v1.locked");

    process.env.TOKENSMART_BASELINE_POLICY_WATCH = "0";
    startBaselinePolicyFileWatcher();

    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v2.ignored", "model-b")));
    await new Promise((r) => setTimeout(r, 600));

    // Without watcher, the old cached version is still in place.
    expect(loadBaselinePolicy()!.version).toBe("v1.locked");
  });

  test("TOKENSMART_BASELINE_POLICY_ENABLED=0 prevents watcher from starting", async () => {
    const prevEnabled = process.env.TOKENSMART_BASELINE_POLICY_ENABLED;
    try {
      process.env.TOKENSMART_BASELINE_POLICY_ENABLED = "0";
      writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1.disabled", "model-a")));
      loadBaselinePolicy();
      startBaselinePolicyFileWatcher();
      writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v2.ignored", "model-b")));
      await new Promise((r) => setTimeout(r, 600));
      // Disabled subsystem → no watcher → no reload.
      expect(loadBaselinePolicy()!.version).toBe("v1.disabled");
    } finally {
      if (prevEnabled !== undefined) process.env.TOKENSMART_BASELINE_POLICY_ENABLED = prevEnabled;
      else delete process.env.TOKENSMART_BASELINE_POLICY_ENABLED;
    }
  });

  test("startBaselinePolicyFileWatcher is idempotent (multiple calls are no-ops)", async () => {
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v1", "model-a")));
    loadBaselinePolicy();
    startBaselinePolicyFileWatcher();
    startBaselinePolicyFileWatcher();
    startBaselinePolicyFileWatcher();
    // Should not crash, should not multi-fire on a single rewrite.
    writeFileSync(artifactPath, JSON.stringify(syntheticPolicy("v2", "model-b")));
    await new Promise((r) => setTimeout(r, 600));
    expect(loadBaselinePolicy()!.version).toBe("v2");
  });

  test("stopBaselinePolicyFileWatcher is safe to call when no watcher started", () => {
    // Should not throw.
    stopBaselinePolicyFileWatcher();
    stopBaselinePolicyFileWatcher();
  });
});

describe("pg_notify subscriber — subscribeToBaselinePolicyReload", () => {
  beforeEach(() => {
    _resetBaselinePolicy();
  });

  afterEach(() => {
    _resetBaselinePolicy();
  });

  test("LISTENs on tokensmart_baseline_reload channel", async () => {
    let listenedChannel: string | null = null;
    let listenCb: ((payload: string | null) => void) | null = null;
    const fakeSql = {
      listen: async (
        channel: string,
        cb: (payload: string | null) => void
      ) => {
        listenedChannel = channel;
        listenCb = cb;
        return {};
      },
    };

    await subscribeToBaselinePolicyReload(fakeSql);
    expect(listenedChannel).toBe("tokensmart_baseline_reload");
    expect(typeof listenCb).toBe("function");
  });

  test("subscribe is no-op when baseline policy is disabled", async () => {
    const prev = process.env.TOKENSMART_BASELINE_POLICY_ENABLED;
    process.env.TOKENSMART_BASELINE_POLICY_ENABLED = "0";
    let listenCalled = false;
    const fakeSql = {
      listen: async () => {
        listenCalled = true;
        return {};
      },
    };
    try {
      await subscribeToBaselinePolicyReload(fakeSql);
      expect(listenCalled).toBe(false);
    } finally {
      if (prev !== undefined) process.env.TOKENSMART_BASELINE_POLICY_ENABLED = prev;
      else delete process.env.TOKENSMART_BASELINE_POLICY_ENABLED;
    }
  });

  test("LISTEN failure is non-fatal (degrades to file-watch only)", async () => {
    const fakeSql = {
      listen: async () => {
        throw new Error("simulated network blip");
      },
    };
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await subscribeToBaselinePolicyReload(fakeSql);
      expect(warnings.some((w) => w.includes("LISTEN setup failed"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});
