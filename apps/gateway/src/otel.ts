/**
 * Lightweight OTLP/HTTP JSON span exporter for the TokSuan gateway.
 *
 * Why hand-rolled instead of `@opentelemetry/sdk-trace-node`:
 *   - The gateway emits ONE span per request — we don't need auto-
 *     instrumentation, propagators, samplers, batchers tuned for high-fan-out
 *     instrumented apps. The official SDK is ~500KB after tree-shake; this
 *     module is ~150 lines you can audit at a glance.
 *   - Compatible with every OTLP/HTTP/JSON endpoint: Langfuse, Datadog OTel
 *     collector, Honeycomb, Tempo, Jaeger, Phoenix. (Most also accept
 *     OTLP/HTTP/protobuf, which is more efficient — we deliberately pick
 *     JSON for zero-dep simplicity. Wire the official SDK if perf matters.)
 *   - Zero new runtime dependencies — pays no bundle cost when disabled.
 *
 * Configuration:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
 *     # OR https://otel-collector.example.com/v1/traces
 *   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer xxx,X-Scope-OrgID=tokensmart
 *     # Optional. Comma-separated `key=value` pairs.
 *   OTEL_SERVICE_NAME=tokensmart-gateway   # default
 *   OTEL_SERVICE_VERSION=v0.2.0            # default
 *
 * If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, every export call is a no-op
 * — zero runtime cost beyond the env-var check.
 *
 * Spans are batched in-memory and flushed every 5 seconds OR when the buffer
 * hits 100 spans. Batches that fail to send are dropped after a single retry
 * so a degraded OTel backend never backs up the gateway.
 */

import { randomBytes } from "node:crypto";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "tokensmart-gateway";
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION ?? "v0.2.0";
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 100;

type AttrValue = string | number | boolean | null | undefined;
type Attrs = Record<string, AttrValue>;

type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** OTel SpanKind: 1=internal, 2=server, 3=client, 4=producer, 5=consumer */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attrs;
  /** OTel StatusCode: 0=unset, 1=ok, 2=error */
  status: { code: 0 | 1 | 2; message?: string };
};

type Endpoint = {
  url: string;
  headers: Record<string, string>;
};

let _endpoint: Endpoint | null = null;
let _buffer: SpanRecord[] = [];
let _timer: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the exporter. Call once at gateway boot. Idempotent: re-calls
 * are no-ops. When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, prints a single
 * info line and disables export — every later `recordSpan()` becomes a noop.
 */
export function initOtel(): void {
  const endpointRaw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpointRaw) {
    console.log("[tokensmart] OTel export DISABLED (OTEL_EXPORTER_OTLP_ENDPOINT unset)");
    return;
  }
  if (_endpoint) return;

  // Normalize endpoint — append /v1/traces if the operator gave the base URL
  // alone. Most OTLP backends expose both /v1/traces and /v1/metrics under
  // the same root.
  const url = /\/v1\/traces$/.test(endpointRaw)
    ? endpointRaw
    : `${endpointRaw.replace(/\/$/, "")}/v1/traces`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const headersRaw = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (headersRaw) {
    for (const pair of headersRaw.split(",")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k) headers[k] = v;
    }
  }

  _endpoint = { url, headers };
  _timer = setInterval(() => {
    flush().catch((e) => console.warn("[otel] flush error:", e));
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive on Bun — gateway shutdown stays clean.
  // Bun's Timer.unref exists; some Node versions don't have it on setInterval.
  if (typeof (_timer as { unref?: () => void }).unref === "function") {
    (_timer as { unref?: () => void }).unref!();
  }
  console.log(`[tokensmart] OTel export ENABLED → ${url}`);
}

/**
 * Generate a 128-bit trace ID (32 hex) per OTLP spec. Random — no
 * propagation across service boundaries (TokSuan is the edge here).
 */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** 64-bit span ID (16 hex). */
export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Record a completed span. No-op if OTel isn't initialized.
 *
 * The span is buffered and flushed on the next tick. Call sites pay
 * essentially zero — single object construction + array push.
 */
export function recordSpan(args: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: "internal" | "server" | "client";
  startTimeMs: number;
  endTimeMs: number;
  attributes?: Attrs;
  status?: "ok" | "error";
  errorMessage?: string;
}): void {
  if (!_endpoint) return;
  const kindCode = args.kind === "client" ? 3 : args.kind === "server" ? 2 : 1;
  const statusCode = args.status === "error" ? 2 : args.status === "ok" ? 1 : 0;
  _buffer.push({
    traceId: args.traceId,
    spanId: args.spanId,
    parentSpanId: args.parentSpanId,
    name: args.name,
    kind: kindCode,
    startTimeUnixNano: msToNano(args.startTimeMs),
    endTimeUnixNano: msToNano(args.endTimeMs),
    attributes: args.attributes ?? {},
    status: {
      code: statusCode as 0 | 1 | 2,
      ...(args.errorMessage ? { message: args.errorMessage } : {}),
    },
  });
  if (_buffer.length >= FLUSH_BATCH_SIZE) {
    flush().catch((e) => console.warn("[otel] flush error:", e));
  }
}

function msToNano(ms: number): string {
  // OTLP wants 64-bit integer nanoseconds. JS numbers lose precision past
  // 2^53 — we represent as string so the JSON payload is correct even at
  // very large epoch nanos.
  return `${BigInt(Math.floor(ms)) * 1_000_000n}`;
}

function attrsToOtlp(attrs: Attrs): Array<{ key: string; value: object }> {
  const out: Array<{ key: string; value: object }> = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out.push({ key: k, value: { stringValue: v } });
    else if (typeof v === "boolean") out.push({ key: k, value: { boolValue: v } });
    else if (Number.isInteger(v))
      out.push({ key: k, value: { intValue: String(v) } });
    else if (typeof v === "number")
      out.push({ key: k, value: { doubleValue: v } });
  }
  return out;
}

/** Flush buffered spans to the OTLP endpoint. Single best-effort retry on failure. */
export async function flush(): Promise<void> {
  if (!_endpoint || _buffer.length === 0) return;
  const batch = _buffer;
  _buffer = [];

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: attrsToOtlp({
            "service.name": SERVICE_NAME,
            "service.version": SERVICE_VERSION,
          }),
        },
        scopeSpans: [
          {
            scope: { name: "tokensmart", version: SERVICE_VERSION },
            spans: batch.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: s.startTimeUnixNano,
              endTimeUnixNano: s.endTimeUnixNano,
              attributes: attrsToOtlp(s.attributes),
              status: s.status,
            })),
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(_endpoint.url, {
      method: "POST",
      headers: _endpoint.headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Read + drop body to free the socket; one-line warn is enough.
      await res.text().catch(() => {});
      console.warn(`[otel] export HTTP ${res.status} (${batch.length} spans dropped)`);
    }
  } catch (err) {
    console.warn(
      `[otel] export failed (${batch.length} spans dropped):`,
      err instanceof Error ? err.message : err
    );
  }
}

/** Test-only: reset module state between tests. */
export function _resetForTests(): void {
  _endpoint = null;
  _buffer = [];
  if (_timer) clearInterval(_timer);
  _timer = null;
}
