import type { OpenAIChatRequest } from "./providers/openai";
import { getRoutingRules, type RoutingMode } from "./db";
import { scoreComplexity } from "./classifier";
import { env, findProviderTemplate } from "./config";
import { resolveProvider } from "./provider-resolve";
import {
  classifyTask,
  classifyTaskForProject,
  loadActivePolicy,
  recommendModel,
  type BaselinePolicy,
  type ComplexityBucket,
  type TaskType,
} from "./policy";

export type RoutingDecision =
  | {
      routed: false;
      score: number;
      shadow_model: string | null;
      mode: RoutingMode | null;
    }
  | {
      routed: true;
      score: number;
      rule_id: string;
      from_model: string;
      to_model: string;
      threshold: number;
      shadow_model: string | null;
      mode: RoutingMode;
    };

/**
 * Score the request, walk the project's routing rules in creation order, and
 * rewrite `body.model` in place on the first matching rule.
 *
 * Modes:
 *   - "route"  (default) rewrite body.model to `to_model`
 *   - "shadow" leave body.model alone, but request a parallel shadow call
 *              against `shadow_to_model` for cost/quality comparison
 *   - "both"   rewrite + ALSO shadow the original (so you can see what you
 *              would have gotten if the route hadn't fired)
 *
 * A rule matches when:
 *   - `enabled = TRUE`
 *   - `complexityScore(body) < rule.threshold`
 *   - `rule.from_pattern` (a regex) matches the current model
 *   - For mode "route"/"both": `rule.to_model` is different from current
 *
 * Rules are evaluated in order and the first match wins.
 */
export async function applyRouting(
  projectId: string,
  body: OpenAIChatRequest,
  opts: {
    userId?: string | null;
    classifierModelOverride?: string | null;
  } = {}
): Promise<RoutingDecision> {
  const rules = await getRoutingRules(projectId);
  if (rules.length === 0) {
    // No user rules means there is nothing for this layer to evaluate. Avoid
    // scoring here because the baseline policy will score/classify the same
    // request if it is enabled; doing both doubles classifier work on the
    // common "baseline only" path.
    return { routed: false, score: 0, shadow_model: null, mode: null };
  }

  const score = await scoreComplexity(body, {
    userId: opts.userId,
    requestedModel: String(body.model ?? ""),
    classifierModelOverride: opts.classifierModelOverride,
  });

  const originalModel = String(body.model ?? "");

  for (const rule of rules) {
    if (score >= rule.threshold) continue;

    let rx: RegExp;
    try {
      rx = new RegExp(rule.from_pattern);
    } catch {
      continue; // bad regex in DB — skip, don't crash the request path
    }
    if (!rx.test(originalModel)) continue;

    // Sample-rate gate (migration 020). NULL or 1.0 fires on every
    // match (legacy). A value in (0, 1) fires on a random draw so a
    // shadow rule can be configured to keep a small steady trickle
    // of A/B rows in `ab_results` without doubling upstream bills.
    // Done AFTER pattern + threshold so the gate is observable in
    // logs as "matched a rule, then declined to fire".
    if (rule.sample_rate != null && rule.sample_rate < 1) {
      if (rule.sample_rate <= 0) continue;
      if (Math.random() >= rule.sample_rate) continue;
    }

    const mode = rule.mode;

    // Pure-shadow rule: don't rewrite, just remember the shadow target.
    if (mode === "shadow") {
      const shadow = rule.shadow_to_model ?? rule.to_model;
      if (!shadow || shadow === originalModel) continue;
      return {
        routed: false,
        score,
        shadow_model: shadow,
        mode: "shadow",
      };
    }

    // Routes: skip no-op rewrites.
    if (rule.to_model === originalModel) continue;
    body.model = rule.to_model;

    // For mode "both" the shadow target defaults to the ORIGINAL model so
    // you can verify the route didn't lose quality.
    const shadow =
      mode === "both"
        ? (rule.shadow_to_model ?? originalModel)
        : (rule.shadow_to_model ?? null);

    return {
      routed: true,
      score,
      rule_id: rule.id,
      from_model: originalModel,
      to_model: rule.to_model,
      threshold: rule.threshold,
      shadow_model: shadow && shadow !== rule.to_model ? shadow : null,
      mode,
    };
  }

  return { routed: false, score, shadow_model: null, mode: null };
}

// =========================================================================
// Baseline (cold-start) routing policy
// =========================================================================
//
// Fires AFTER applyRouting() when the per-project rules didn't match. It
// uses an artifact produced offline by running public agent benchmarks
// across all supported models. The artifact maps
// (task_type, complexity_bucket) → Pareto-frontier of (model, cost, quality),
// and we downgrade whenever a cheaper model is within `eps` quality of the
// caller's chosen model.
//
// Zero DB calls, zero network calls — one in-memory lookup on the hot path.

export type BaselineDecision =
  | {
      applied: true;
      from_model: string;
      to_model: string;
      task_type: TaskType;
      complexity: ComplexityBucket;
      reason: string;
      expected_quality: number;
    }
  | {
      applied: false;
      reason: string;
    };

function baselineEnabled(): boolean {
  return env.TOKENSMART_BASELINE_POLICY_ENABLED === "1";
}

function rescueUnknownEnabled(): boolean {
  return env.TOKENSMART_BASELINE_RESCUE_UNKNOWN_MODELS === "1";
}

/**
 * v0.6.4 — is the caller's model a name the gateway can actually route
 * to OR has training-data evidence for? If neither, we bail out of
 * baseline rewriting and let `resolveProvider` produce a clean 400 +
 * stamp the L5 `ops_model_rejections` table. The two acceptance
 * gates are:
 *
 *   (a) `findProviderTemplate(original) !== null` — the model name
 *       matches one of the six built-in provider prefix regexes
 *       (gpt-, claude-, deepseek-, qwen, doubao-/ep-). The user CAN reach
 *       this model directly via env or BYO key, even if our policy
 *       artifact has never benchmarked this exact variant. Rescue is
 *       safe — we're staying inside the same provider family.
 *
 *   (b) `bucketContainsModel(policy, original)` — the artifact
 *       includes this exact model in some bucket, which means the
 *       benchmarks DID measure it. Rescue is grounded in real data.
 *
 * NOT in either bucket → the model name is something we don't know
 * how to call (no template) AND don't have benchmark numbers for. The
 * v0.6.0 code path used `bucket.max_quality` as the anchor and
 * silently rewrote — turning a `grok-2-latest` request into a
 * `gemini-2.5-flash-lite` 200 response. The user thought they were
 * talking to xAI; they were actually talking to Google. Worse: the
 * `ops_model_rejections` table never saw `grok-2-latest` because the
 * silent rewrite preempted the resolver's no_template error path. The
 * operator's "Models we couldn't route" dashboard card was a
 * subset-of-the-real-truth.
 *
 * NOTE: Custom providers (`user_custom_providers`) are NOT consulted
 * here — that would require an async DB call on the hot path, and
 * custom-provider users typically configure project-level routing
 * rules to opt their own upstream into baseline routing. We could
 * thread userId + a custom-provider lookup through here in a future
 * iteration; for now custom-prefix model names also fall through to
 * resolveProvider, which DOES match them and serves the request
 * unchanged. So nothing breaks for custom-provider users; their
 * traffic just doesn't get the baseline-policy downgrade until they
 * register an explicit project rule.
 */
function bucketContainsModel(
  policy: BaselinePolicy,
  model: string
): boolean {
  for (const bucket of policy.buckets) {
    for (const m of bucket.models) {
      if (m.model === model) return true;
    }
  }
  return false;
}

export async function applyBaselineRouting(
  projectId: string | null,
  body: OpenAIChatRequest,
  tag: string | null = null,
  opts: {
    userId?: string | null;
    classifierModelOverride?: string | null;
  } = {}
): Promise<BaselineDecision> {
  if (!baselineEnabled()) {
    return { applied: false, reason: "disabled" };
  }
  // (project, tag)-aware lookup: prefer a tag-specific active policy,
  // then the project-default active policy, then the shipped baseline.
  // The loader memoizes per (project, tag) for 60s so this stays one
  // process-local lookup on the hot path.
  const policy = await loadActivePolicy(projectId, tag);
  if (!policy) {
    return { applied: false, reason: "no_artifact" };
  }

  const original = String(body.model ?? "");
  if (!original) {
    return { applied: false, reason: "no_model" };
  }

  // v0.6.4: refuse-rewrite on unknown-caller-model. Closes the
  // "silent grok-2-latest → gemini-2.5-flash-lite swap + missing L5
  // telemetry" footgun. See `bucketContainsModel` doc comment.
  // Operators running a fleet of agents with stale model names can
  // restore the legacy rescue path with the env opt-in.
  if (!rescueUnknownEnabled()) {
    const knownToTemplate = findProviderTemplate(original) !== null;
    const knownToPolicy = bucketContainsModel(policy, original);
    if (!knownToTemplate && !knownToPolicy) {
      return { applied: false, reason: "unknown_caller_model" };
    }
  }

  const complexityScore = await scoreComplexity(body, {
    userId: opts.userId,
    requestedModel: original,
    classifierModelOverride: opts.classifierModelOverride,
  });
  const { task_type, complexity } = await classifyTaskForProject(body, projectId, {
    complexityScoreOverride: complexityScore,
  });
  const eps = env.TOKENSMART_BASELINE_POLICY_EPS ?? policy.default_eps;
  const excludedModels = new Set<string>();

  for (;;) {
    const rec = recommendModel(policy, task_type, complexity, original, eps, {
      excludedModels,
    });
    if (!rec) {
      return {
        applied: false,
        reason:
          excludedModels.size > 0
            ? `no_callable_cheaper:${task_type}:${complexity}`
            : `no_cheaper:${task_type}:${complexity}`,
      };
    }

    const resolved = await resolveProvider(opts.userId ?? null, rec.recommended);
    if (!resolved.ok) {
      excludedModels.add(rec.recommended);
      continue;
    }

    body.model = rec.recommended;
    return {
      applied: true,
      from_model: original,
      to_model: rec.recommended,
      task_type,
      complexity,
      reason: rec.reason,
      expected_quality: rec.expected_quality,
    };
  }
}
