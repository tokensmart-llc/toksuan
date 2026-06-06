import { beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? ":memory:";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-fixture";
process.env.TOKENSMART_CACHE_AWARE_ROUTING = "1";
process.env.TOKENSMART_CACHE_AWARE_MIN_INPUT_TOKENS = "1000";
process.env.TOKENSMART_CACHE_AWARE_MIN_SAVINGS_RATIO = "0.05";

const {
  _resetSessionRouteGuardForTests,
  evaluateCacheAwareRouting,
  recordSessionRouteState,
} = await import("../src/session-route-guard");

const projectId = "project_cache_aware_test";
const sessionId = "session_1";

function longBody(model: string) {
  return {
    model,
    max_tokens: 100,
    messages: [
      {
        role: "system",
        content: "You are a coding agent.\n" + "stable context ".repeat(4000),
      },
      { role: "user", content: "Make the next small edit." },
    ],
  };
}

describe("session route guard", () => {
  beforeEach(() => {
    _resetSessionRouteGuardForTests();
  });

  test("keeps the previous warm model when its measured cache makes a switch a net loss", () => {
    // Previous turn on sonnet served ~93% of the prompt from cache.
    recordSessionRouteState({
      projectId,
      sessionId,
      landedModel: "claude-3-5-sonnet-latest",
      provider: "anthropic",
      inputTokens: 14_000,
      cachedInputTokens: 13_000,
    });

    const decision = evaluateCacheAwareRouting({
      projectId,
      sessionId,
      body: longBody("gpt-4o"),
      candidateModel: "gpt-4o",
      candidateProvider: "openai",
      automaticRouting: true,
    });

    expect(decision.action).toBe("stay");
    expect(decision.finalModel).toBe("claude-3-5-sonnet-latest");
    expect(decision.switchCostMicroCents).toBeGreaterThan(
      decision.stayCostMicroCents
    );
  });

  test("allows a switch when the candidate still wins even against a warm prefix", () => {
    recordSessionRouteState({
      projectId,
      sessionId,
      landedModel: "gpt-4o",
      provider: "openai",
      inputTokens: 14_000,
      cachedInputTokens: 13_000,
    });

    const decision = evaluateCacheAwareRouting({
      projectId,
      sessionId,
      body: longBody("gpt-4o-mini"),
      candidateModel: "gpt-4o-mini",
      candidateProvider: "openai",
      automaticRouting: true,
    });

    expect(decision.action).toBe("switch");
    expect(decision.finalModel).toBe("gpt-4o-mini");
    expect(decision.savingsMicroCents).toBeGreaterThan(0);
  });

  test("does not protect a model whose previous turn measured ~no cache hits", () => {
    // Big context, but the provider cached almost none of it last turn —
    // there is no warm prefix worth defending, so the cheaper candidate wins.
    recordSessionRouteState({
      projectId,
      sessionId,
      landedModel: "claude-3-5-sonnet-latest",
      provider: "anthropic",
      inputTokens: 14_000,
      cachedInputTokens: 0,
    });

    const decision = evaluateCacheAwareRouting({
      projectId,
      sessionId,
      body: longBody("gpt-4o-mini"),
      candidateModel: "gpt-4o-mini",
      candidateProvider: "openai",
      automaticRouting: true,
    });

    expect(decision.action).toBe("no_cache_benefit");
    expect(decision.finalModel).toBe("gpt-4o-mini");
  });

  test("does not change routing without a session route state", () => {
    const decision = evaluateCacheAwareRouting({
      projectId,
      sessionId,
      body: longBody("gpt-4o-mini"),
      candidateModel: "gpt-4o-mini",
      candidateProvider: "openai",
      automaticRouting: true,
    });

    expect(decision.action).toBe("no_state");
    expect(decision.finalModel).toBe("gpt-4o-mini");
  });

  test("does not guard tiny contexts even when the prefix was fully cached", () => {
    recordSessionRouteState({
      projectId,
      sessionId,
      turnId: 1,
      landedModel: "claude-3-5-sonnet-latest",
      provider: "anthropic",
      inputTokens: 20,
      cachedInputTokens: 20,
    });

    const decision = evaluateCacheAwareRouting({
      projectId,
      sessionId,
      body: {
        model: "gpt-4o",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
      candidateModel: "gpt-4o",
      candidateProvider: "openai",
      automaticRouting: true,
    });

    expect(decision.action).toBe("no_cache_benefit");
    expect(decision.finalModel).toBe("gpt-4o");
  });

  test("ignores older numeric turns that finish after a newer turn", () => {
    recordSessionRouteState({
      projectId,
      sessionId,
      turnId: 2,
      landedModel: "gpt-4o",
      provider: "openai",
      inputTokens: 14_000,
      cachedInputTokens: 13_000,
    });

    // Simulates turn=1 finishing late. It should not replace turn=2's state.
    recordSessionRouteState({
      projectId,
      sessionId,
      turnId: 1,
      landedModel: "claude-3-5-sonnet-latest",
      provider: "anthropic",
      inputTokens: 14_000,
      cachedInputTokens: 13_000,
    });

    const decision = evaluateCacheAwareRouting({
      projectId,
      sessionId,
      body: longBody("gpt-4o-mini"),
      candidateModel: "gpt-4o-mini",
      candidateProvider: "openai",
      automaticRouting: true,
    });

    expect(decision.action).toBe("switch");
    expect(decision.previousModel).toBe("gpt-4o");
  });

  test("keeps best-effort behavior when x-ts-turn is absent or non-numeric", () => {
    recordSessionRouteState({
      projectId,
      sessionId,
      turnId: "not-a-number",
      landedModel: "gpt-4o",
      provider: "openai",
      inputTokens: 14_000,
      cachedInputTokens: 13_000,
    });

    recordSessionRouteState({
      projectId,
      sessionId,
      turnId: null,
      landedModel: "claude-3-5-sonnet-latest",
      provider: "anthropic",
      inputTokens: 14_000,
      cachedInputTokens: 13_000,
    });

    const decision = evaluateCacheAwareRouting({
      projectId,
      sessionId,
      body: longBody("gpt-4o"),
      candidateModel: "gpt-4o",
      candidateProvider: "openai",
      automaticRouting: true,
    });

    expect(decision.action).toBe("stay");
    expect(decision.previousModel).toBe("claude-3-5-sonnet-latest");
  });
});
