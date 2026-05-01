/**
 * Pick a "first receipt" smoke pair the project page can always hand the
 * user as a working curl plus a clear routing prediction.
 *
 * Splits the contract along the same axis the gateway billing model uses:
 *
 *   * `asked` is fixed to a model in one of the user's BYO provider
 *     families. The user's own credentials get exercised on the asked
 *     side, so the curl call bills against THEIR account. Within the
 *     chosen BYO family we always pick the priciest model the policy
 *     has training data for (the family's flagship in policy terms).
 *
 *   * `route_to` is whatever the loaded baseline policy says is the
 *     cheapest acceptable-quality alternative in the same bucket — any
 *     provider, any family. We do NOT pre-filter by callability. Whether
 *     the route actually fires is the operator's deployment problem
 *     (gateway env credentials), not the picker's. If the operator
 *     forgot to set, say, `DEEPSEEK_API_KEY`, runtime's
 *     `applyBaselineRouting` falls through to the next cheapest the
 *     gateway CAN reach, and the receipt's "landed" line tells the truth.
 *     Naming the policy's first pick keeps the user's mental model
 *     ("this is what TokSuan wants to route to") aligned with the
 *     artifact, not with the deployment.
 *
 * Returns `null` only when the user has no BYO provider that appears in
 * the policy at all. The caller renders an "add a provider key"
 * fallback in that case — the only state where we genuinely can't put
 * something useful in the curl.
 *
 * Picking heuristic across buckets: largest expected cost gap (asked −
 * route_to) so the receipt's saved-money number is maximally visible.
 */

import type {
  BaselinePolicyMirror,
  PolicyBucketMirror,
  PolicyModelMirror,
} from "./baseline-policy-mirror";

export type SmokePair = {
  /** Asked-side model row — always inside one of the user's BYO families. */
  asked: PolicyModelMirror;
  /** Bucket the asked model was picked from (e.g. "code:hard"). */
  bucket: string;
  /** Prompt body — hand-tuned so the runtime task classifier maps it back
   *  into the same bucket we picked from. Without this, the runtime
   *  classifier might land in a different bucket and skip the routing
   *  decision we want to demonstrate. */
  prompt: string;
  /**
   * Policy's cheapest acceptable-quality alternative in the same bucket —
   * may be from any provider family. Whether the runtime actually lands
   * the request here depends on the operator's gateway env credentials
   * for that family.
   */
  route_to: PolicyModelMirror;
  /**
   * `true` when this gateway can definitely reach `route_to` (either
   * the user has a BYO key for that provider OR the gateway has env
   * credentials for it). When `false`, the dashboard surfaces a small
   * note so the user knows why the receipt's landed model might not
   * match — without gating the demo on it.
   */
  route_to_callable: boolean;
};

/**
 * Expected savings for a smoke pair, in micro_cents.
 */
export function smokePairExpectedSavingsMicroCents(p: SmokePair): number {
  return Math.max(0, p.asked.avg_cost_micro_cents - p.route_to.avg_cost_micro_cents);
}

/**
 * Per-bucket sample prompts. Worded to nudge the runtime task-classifier
 * heuristic (`inferTaskType` + `complexityScore` in
 * apps/gateway/src/policy/task-classifier.ts) toward the matching bucket
 * key. Anchors:
 *
 *   chat:simple        very short, no code, conversational greeting
 *   chat:medium        a paragraph-length explanatory ask, no code
 *   code:medium        explicit "write a function" cue, language hint
 *   code:hard          longer, names a non-trivial primitive (LRU cache)
 *
 * Keep these PURE TEXT (no fenced code blocks). The classifier counts
 * fences as a code signal and would force code:* even on a chat prompt.
 *
 * `reasoning:frontier` is intentionally omitted: the heuristic doesn't
 * reliably route a math word problem into the reasoning task type
 * without a tool-call surface, and a smoke prompt that lands in chat
 * instead silently bypasses the routing decision we're trying to demo.
 * If the user's callable providers ONLY span a routable pair in
 * `reasoning:frontier`, we'd rather render the "add another provider"
 * empty state than ship a curl that always shows "no rewrite".
 */
const BUCKET_PROMPTS: Record<string, string> = {
  "chat:simple": "Say hello in five words.",
  "chat:medium":
    "In one paragraph, explain the practical tradeoffs between SQL and NoSQL databases for a small startup choosing its first datastore.",
  "code:medium":
    "Write a small Python function fib(n) that returns the nth Fibonacci number iteratively. Include a one-line docstring.",
  "code:hard":
    "Implement a thread-safe LRU cache class in Python with O(1) get and put, supporting a configurable capacity and eviction on overflow. Use only the standard library.",
};

/**
 * Helper: drop the `custom:*` synthetic providers; they never appear in
 * the baseline policy and can't seed a smoke pair.
 */
function builtinProvidersOnly(providers: ReadonlyArray<string>): Set<string> {
  const out = new Set<string>();
  for (const p of providers) {
    if (!p.startsWith("custom:")) out.add(p);
  }
  return out;
}

/**
 * Backwards-compatible export for older callers that still pass a single
 * combined "callable" set into smoke-pair logic. New code should pass
 * `byoProviders` and `envProviders` separately into `pickSmokePair` so
 * the asked-side stays restricted to BYO families (where the user's
 * own credentials get billed) while route_to is free to span the whole
 * policy.
 */
export function callableProviderSet(
  userByoProviders: ReadonlyArray<string>,
  gatewayEnvProviders: ReadonlyArray<string>
): Set<string> {
  const out = builtinProvidersOnly(userByoProviders);
  for (const p of builtinProvidersOnly(gatewayEnvProviders)) out.add(p);
  return out;
}

function bestPairInBucket(
  bucket: PolicyBucketMirror,
  byo: ReadonlySet<string>,
  envOrByo: ReadonlySet<string>
): SmokePair | null {
  const bucketKey = `${bucket.task_type}:${bucket.complexity}`;
  // No matching prompt → we can't safely steer the runtime classifier
  // into this bucket. Skip rather than risk a curl that lands in a
  // different bucket and silently shows "no rewrite".
  const prompt = BUCKET_PROMPTS[bucketKey];
  if (!prompt) return null;

  // Asked-side candidates are restricted to the user's BYO families so
  // the curl bills against the user's own credentials. Without this,
  // a hosted gateway with env keys for every family would happily pick
  // a provider the user hasn't connected, defeating the purpose of
  // BYO entirely.
  const askedCandidates = bucket.models.filter((m) => byo.has(m.provider));
  if (askedCandidates.length === 0) return null;

  // Asked = priciest in BYO ∩ this bucket. The user's BYO family's
  // flagship — what their agent code typically asks for.
  const asked = [...askedCandidates].sort(
    (a, b) => b.avg_cost_micro_cents - a.avg_cost_micro_cents
  )[0]!;

  // Quality floor for route candidates. Mirrors the runtime's
  // chat-bucket effective eps (TOKENSMART_BASELINE_POLICY_EPS=0.05 ×
  // chat 2.0 multiplier × a 2x safety margin). Stricter buckets
  // (code, reasoning) at runtime may still reject our pick at request
  // time, in which case `applyBaselineRouting` falls through to the
  // next cheapest — same outcome as ours, just a different number on
  // the receipt's "landed" line.
  const QUALITY_FLOOR = bucket.max_quality - 0.2;

  // route_to mirrors the runtime: the cheapest acceptable-quality model
  // the gateway can ACTUALLY reach. "Reachable" = a provider the user
  // has BYO for OR the gateway has env credentials for. This makes
  // the dashboard's prediction match what `applyBaselineRouting` does
  // at request time — same exclude-and-retry logic, same outcome.
  //
  // For the most common BYO shape (anthropic only, no operator env
  // keys) this gives a same-family route target out of the box —
  // claude-opus-4-7 → claude-haiku-4-5 — without asking the user to
  // add another provider key just to see the demo work.
  let route_to: PolicyModelMirror | null = null;
  for (const m of bucket.models) {
    if (!envOrByo.has(m.provider)) continue;
    if (m.avg_cost_micro_cents >= asked.avg_cost_micro_cents) continue;
    if (m.quality_score < QUALITY_FLOOR) continue;
    if (!route_to || m.avg_cost_micro_cents < route_to.avg_cost_micro_cents) {
      route_to = m;
    }
  }
  // Asked is already at the bottom of its bucket among reachable
  // providers — no useful smoke pair to construct here. The picker's
  // outer loop will try other buckets; if none yield a pair, we
  // fall back to NoRoutableDemoHint.
  if (!route_to) return null;

  return {
    asked,
    bucket: bucketKey,
    prompt,
    route_to,
    // Always true here, since we pre-filtered route_to candidates by
    // `envOrByo`. Kept on the type so callers can still surface a
    // "this gateway can't reach the route target" warning if a future
    // picker variant relaxes the filter.
    route_to_callable: true,
  };
}

export function pickSmokePair(
  policy: BaselinePolicyMirror | null,
  byoProviders: ReadonlyArray<string>,
  envProviders: ReadonlyArray<string> = []
): SmokePair | null {
  if (!policy || !policy.enabled) return null;
  if (policy.buckets.length === 0) return null;
  const byo = builtinProvidersOnly(byoProviders);
  if (byo.size === 0) return null;
  const envOrByo = new Set<string>(byo);
  for (const p of builtinProvidersOnly(envProviders)) envOrByo.add(p);

  let best: SmokePair | null = null;
  let bestSavings = 0;
  for (const bucket of policy.buckets) {
    const pair = bestPairInBucket(bucket, byo, envOrByo);
    if (!pair) continue;
    const savings =
      pair.asked.avg_cost_micro_cents - pair.route_to.avg_cost_micro_cents;
    if (savings > bestSavings) {
      best = pair;
      bestSavings = savings;
    }
  }
  return best;
}

/**
 * Suggest which providers (not currently in the user's set) would unlock
 * a routable smoke demo. Used to phrase the "add another provider key"
 * empty state — a generic "go add a key" is less actionable than
 * "DeepSeek and Qwen both have cheap models in your policy".
 */
export function suggestUnlockProviders(
  policy: BaselinePolicyMirror | null,
  callable: ReadonlySet<string>,
  limit = 3
): string[] {
  if (!policy) return [];
  // For each provider absent from `callable`, score by the total cost
  // spread it would unlock when added. Higher spread = more visible
  // first-receipt savings, so surface it first.
  const candidateScore = new Map<string, number>();
  for (const bucket of policy.buckets) {
    const presentByProvider = new Map<string, number>();
    for (const m of bucket.models) {
      const cur = presentByProvider.get(m.provider);
      if (cur === undefined || m.avg_cost_micro_cents < cur) {
        presentByProvider.set(m.provider, m.avg_cost_micro_cents);
      }
    }
    let priciestCallable = -Infinity;
    for (const m of bucket.models) {
      if (!callable.has(m.provider)) continue;
      if (m.avg_cost_micro_cents > priciestCallable) {
        priciestCallable = m.avg_cost_micro_cents;
      }
    }
    if (priciestCallable === -Infinity) {
      // No callable model in this bucket — pretend the bucket's max is
      // the priciest entry overall, so adding ANY provider here counts.
      priciestCallable = Math.max(
        ...bucket.models.map((m) => m.avg_cost_micro_cents)
      );
    }
    for (const [provider, cheapest] of presentByProvider) {
      if (callable.has(provider)) continue;
      const unlocked = priciestCallable - cheapest;
      if (unlocked <= 0) continue;
      candidateScore.set(
        provider,
        (candidateScore.get(provider) ?? 0) + unlocked
      );
    }
  }
  return [...candidateScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([provider]) => provider);
}
