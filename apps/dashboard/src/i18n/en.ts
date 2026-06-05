import type { Dictionary } from "./types";

/**
 * English dictionary. This is the SOURCE OF TRUTH for the user-facing
 * surface — when copy changes, change it here first, then mirror to
 * `zh-CN.ts`. The `Dictionary` interface guarantees both stay in sync.
 *
 * Style:
 *   - Conversational, second-person, present tense.
 *   - Keep an engineering tone: no marketing fluff, no exclamation marks.
 *   - Numbers, model ids, project names are interpolated by the caller —
 *     never bake them in here.
 */
export const en: Dictionary = {
  common: {
    autoRefresh: {
      live: "Live · updated ",
      updating: "updating…",
      justNow: "just now",
      secondsAgo: "{n}s ago",
      minutesAgo: "{n}m ago",
      title:
        "Auto-refreshes every {n}s and immediately when you return to this tab.",
    },
    confirm: "Confirm",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving…",
    saved: "Saved",
    delete: "Delete",
    edit: "Edit",
    create: "Create",
    add: "Add",
    remove: "Remove",
    rotate: "Rotate",
    test: "Test",
    testing: "Testing…",
    copy: "Copy",
    copied: "Copied",
    close: "Close",
    open: "Open",
    back: "Back",
    backToDashboard: "← Dashboard",
    backHome: "← Home",
    enabled: "Enabled",
    disabled: "Disabled",
    pending: "Pending",
    active: "Active",
    inactive: "Inactive",
    success: "Success",
    failed: "Failed",
    error: "Error",
    warning: "Warning",
    notConfigured: "Not configured",
    optional: "Optional",
    required: "Required",
    loading: "Loading…",
    none: "—",
    notAvailable: "N/A",
    today: "Today",
    thisMonth: "This month",
    signIn: "Sign in",
    signOut: "Sign out",
    docs: "Docs",
  },

  nav: {
    dashboard: "Dashboard",
    projects: "Projects",
    agents: "Agents",
    routing: "Routing",
    settings: "Settings",
    docs: "Docs ↗",
    signOut: "Sign out",
    trust: "Trust & security",
    estimator: "Savings estimator",
    stateOfSpend: "State of Agent Spend",
    selfHost: "Self-host (Apache-2.0) ↗",
    footerMeta: "TokSuan · operated by TokenSmart LLC",
    settingsAccount: "Account & keys",
    settingsTeam: "Team",
    settingsBilling: "Billing & plan",
    settingsAudit: "Audit log",
    settingsReferrals: "Referrals",
    settingsTrust: "Security & trust",
    settingsBack: "← Dashboard",
    settingsAriaLabel: "Settings sub-navigation",
  },

  landing: {
    metaDescription:
      "Change one base_url so your agent bill becomes visible, capped, and automatically cheaper when the per-request receipt proves the trade worked.",
    navStateOfSpend: "State of spend",
    navEstimate: "Estimate",
    navTrust: "Trust",
    navOpenClaw: "OpenClaw",
    navHermes: "Hermes",
    ctaSignedIn: "Go to dashboard",
    ctaAnonymous: "Sign in / Start free",
    heroEyebrow: "The spend-control plane for AI agents",
    heroTitle: "Your AI agents are spending in the dark.",
    heroSubtitle:
      "One OpenAI-compatible proxy gives every turn a receipt, caps runaway loops before upstream billing, routes simple work to cheaper models, and compresses bulky tool context before it reaches the LLM.",
    heroPrimarySignedIn: "Go to dashboard",
    heroPrimaryAnonymous: "Start free with email",
    heroSecondaryEstimate: "Estimate savings",
    heroSecondaryRoutingWins: "View routing wins",
    heroSecondaryOpenClaw: "OpenClaw guide",
    heroSecondaryHermes: "Hermes guide",
    heroSecondarySelfHost: "Self-host docs",
    heroFinePrint:
      "See it. Cap it. Shrink it. Keep it running. No token markup. Bring your own provider keys.",
    receiptHeader: "sample receipt",
    receiptSession: "OpenClaw session",
    receiptAskedModel: "Asked model",
    receiptLandedModel: "Landed model",
    receiptCheaperRoute: "Cheaper route",
    receiptCheaperRouteSub: "≈$4.2k / 100k similar turns",
    receiptQualityProof: "Quality proof",
    receiptQualityProofValue: "Quality checked",
    receiptDescription:
      "A receipt tells your team what changed, why it changed, how much context was compressed, and whether the cheaper route is ready to promote.",
    aggregateEyebrow: "Aggregate proof",
    aggregateTitleVisible: "Verified savings tracked by TokSuan receipts.",
    aggregateTitleWarming: "Aggregate proof is warming up.",
    aggregateBodyVisible:
      "Privacy-thresholded totals across hosted traffic and opt-in self-host aggregates.",
    aggregateBodyWarming:
      "Private receipts work immediately. Public aggregate savings appear automatically after privacy thresholds are met.",
    aggregateSavingsLabel: "verified savings tracked",
    aggregateRequestsLabel: "requests included after thresholds",
    aggregateLoopsLabel: "loops blocked before upstream",
    aggregateParticipantsLabel: "hosted projects / opt-in deployments",
    aggregateWarmingValue: "Warming up",
    aggregateWarmingSavingsLabel: "private receipts now",
    aggregateWarmingRequestsLabel: "public totals after thresholds",
    aggregateWarmingParticipantsLabel: "hosted + opt-in self-host only",
    aggregatePrivacyNote:
      "No prompts, responses, provider keys, emails, project names, or per-request logs are included.",
    quickstartEyebrow: "Get started in one SDK change",
    quickstartTitle: "Four steps, no agent rewrite.",
    quickstartSubtitle:
      "Add the provider key you already use, mint a TokSuan project key, swap base_url, then inspect the first receipt.",
    quickstartStep1: "Provider key",
    quickstartStep2: "Project key",
    quickstartStep3: "base_url",
    quickstartStep4: "Receipt",
    flowAgentSdk: "Agent SDK",
    flowGateway: "TokSuan",
    flowProvider: "Provider",
    flowReceipt: "Receipt + budget + route proof",
    hostedEyebrow: "Hosted value",
    hostedTitle: "Open runtime. Hosted policy operations.",
    hostedBody:
      "The gateway path is inspectable: budgets, routing, provider resolution, receipts, and key handling are open. Hosted TokSuan adds the work nobody wants to operate every week: benchmark rosters, aggregate routing intelligence, policy promotion, rollback, provider health, and abuse review.",
    hostedCtaTrust: "See trust boundary",
    hostedCtaProof: "See aggregate proof",
    hostedCard1Title: "Policy factory",
    hostedCard1Body:
      "Private eval recipes and model rosters produce candidate routing policies without touching the runtime path.",
    hostedCard2Title: "Aggregate intelligence",
    hostedCard2Body:
      "Hosted and opt-in self-host aggregates surface route pairs that repeatedly save money after privacy thresholds.",
    hostedCard3Title: "Ops guardrails",
    hostedCard3Body:
      "Provider health, DB sanity, incident snapshots, and report approvals keep policy changes reversible.",
    devEyebrow: "Developer friendly",
    devTitle: "Keep the SDK. Swap the gateway.",
    devBody:
      "Cursor, OpenClaw, Hermes, LangChain, Vercel AI SDK, Cline, and internal bots can keep their OpenAI-compatible workflow. TokSuan adds receipts, budgets, routing, and deterministic context compression in the middle.",
    whyEyebrow: "Why teams add a control plane",
    whyTitle: "Model gateways give access. TokSuan controls spend.",
    whyBody:
      "Agent workloads are not normal API traffic. They retry, call tools, branch into long sessions, replay bulky context, and silently swap from cheap to frontier models. TokSuan decides when a turn can move down, when context can shrink, and when it must stay untouched — then gives each decision a receipt.",
    why1Title: "Bills arrive after the damage",
    why1Body: "Which agent, project, or prompt created the spike?",
    why2Title: "Agents repeat expensive mistakes",
    why2Body:
      "Looping sessions can keep spending while nobody is watching.",
    why3Title: "Routing needs proof",
    why3Body:
      "Cheaper models need evidence before production traffic moves.",
    loopEyebrow: "Control loop",
    loopTitle: "See it. Cap it. Shrink it. Keep it running.",
    loopBody:
      "Four product surfaces work together: a ledger for visibility, budget guards for control, routing proof for safe savings, and reversible context compression for bulky tool output.",
    bento1Pill: "See it",
    bento1Title: "See every turn.",
    bento1Body:
      "Every request becomes a receipt: asked model, landed model, tokens, latency, routing reason, compression savings, and exact cost.",
    bento2Pill: "Cap it",
    bento2Title: "Cap runaway spend.",
    bento2Body:
      "Daily budgets, plan caps, and loop detection stop bad agent behavior before the provider bills you.",
    bento3Pill: "Shrink it",
    bento3Title: "Shrink the replay tax.",
    bento3Body:
      "Agents replay tool output. TokSuan compresses JSON rows, logs, diffs, stack traces, and shell output before they become input tokens.",
    bento4Pill: "Keep it running",
    bento4Title: "Route and compress with proof.",
    bento4Body:
      "Public benchmarks provide the day-one routing frontier. Audit/optimize compression modes show byte savings before prompts are rewritten, and reversible storage keeps original tool output available.",
    trustBand1Title: "No token markup",
    trustBand1Body:
      "Keep paying providers directly. TokSuan is the control layer, not a reseller.",
    trustBand2Title: "Encrypted BYO keys",
    trustBand2Body:
      "Your app uses ts_ project keys while upstream secrets stay encrypted at rest.",
    trustBand3Title: "Self-hostable",
    trustBand3Body:
      "Run the Apache-2.0 code with Postgres when your team needs full control.",
    faqEyebrow: "Before you route traffic",
    faqTitle: "The questions buyers ask first.",
    faqBody:
      "The short version for engineering, finance, and security before you put production agent calls behind a gateway.",
    faq1Q: "Do I need to change my app?",
    faq1A:
      "Usually one base_url and one API key. Your request shape stays OpenAI-compatible.",
    faq2Q: "Is this OpenRouter?",
    faq2A:
      "No. OpenRouter gives access to many models. TokSuan decides which model an agent turn should use, enforces budgets, and learns from your workload.",
    faq3Q: "Can I see the exact request that spent money?",
    faq3A:
      "Yes. The ledger stores model, provider, tokens, latency, tags, cost, receipt headers, and, when reversible context compression is enabled, the original tool output.",
    faq4Q: "Will this hurt model quality?",
    faq4A:
      "Routes promote only when the policy and your receipts show the cheaper model is safe; shadow trials let you prove quality before switching production traffic.",
    faq5Q: "What if an agent loops?",
    faq5A:
      "Loop detection and budgets can stop repeated turns before they reach upstream.",
    faq6Q: "Is hosted the only option?",
    faq6A:
      "No. Use the hosted gateway or self-host when deployment control matters more.",
    finalEyebrow: "Start with one real request",
    finalTitle: "Send one agent request. Get one receipt your team can trust.",
    finalBody:
      "Estimate the opportunity, connect a provider key, and inspect the first request before changing a production route.",
    finalCtaSignedIn: "Go to dashboard",
    finalCtaAnonymous: "Start free",
    finalCtaQuickstart: "Quickstart guide",
    publicNavAriaLabel: "Public navigation",
    quickstartAriaLabel: "How TokSuan starts",
  },

  login: {
    titleEmail: "Sign in or create an account",
    titleCode: "Enter your code",
    sentToPrefix: "Sent to ",
    sentToSuffix: ". Expires in 15 minutes.",
    subtitleEmail:
      "Email-only login. No password — we'll send you a one-time code.",
    fieldEmail: "Email",
    fieldCode: "6-digit code",
    placeholderEmail: "you@example.com",
    placeholderCode: "000000",
    continue: "Continue",
    verify: "Verify code",
    sending: "Sending…",
    resend: "Resend",
    resendIn: "Resend in {seconds}s",
    resendTooltipDisabled:
      "Wait a few seconds before requesting another code",
    resendTooltipReady:
      "Email a new 6-digit code (the previous one stays valid until it expires)",
    devLogHint:
      "Dev installs: the code is also printed in the dashboard server log.",
  },

  unsubscribe: {
    titleSuccess: "Unsubscribed",
    bodyPrefix: "",
    bodyMid: " will no longer receive the ",
    bodySuffix:
      ". Transactional emails (sign-in codes, org invitations, billing receipts) are unaffected — they're required for the service to work.",
    bodyChangedMind: "Changed your mind? Sign in and flip the toggle back on under ",
    backToDashboard: "Back to dashboard",
    titleInvalid: "Unsubscribe link invalid",
    bodyInvalid:
      "We couldn't find a matching subscription for this link. It may have been rotated, already unsubscribed, or clipped by your mail client. You can also manage email preferences directly by signing in and visiting ",
    signIn: "Sign in",
    listLabelWeeklyDigest: "weekly savings digest",
  },

  estimate: {
    metaTitle: "Savings estimator",
    metaDescription:
      "Estimate how much TokSuan will save on your monthly LLM bill. Two inputs, no signup — conservative planning ranges, then prove the actual savings on your own traffic.",
    title: "Estimate first. Prove it on your own traffic.",
    subtitle:
      "This calculator gives a conservative planning range. TokSuan then turns that estimate into receipts from real requests: asked model, landed model, actual cost, routing savings, prompt-cache savings, and context-compression savings.",
  },

  trust: {
    metaTitle: "Trust",
    metaDescription:
      "How TokSuan handles BYO provider keys, request data, retention, reliability, and self-hosting.",
    title: "Trust",
    tagline:
      "The page to send to your security reviewer: what TokSuan sees, what we store, how provider keys are protected, and where the current reliability boundary is.",
    shortVersionTitle: "Short version",
    shortVersionBody:
      "TokSuan proxies model requests on your behalf. You bring the provider key. We store request metadata in a per-project ledger so you can audit spend, route turns to safer/cheaper models, and stop runaway agent loops before upstream billing.",
    backToBilling: "Back to billing",
    docsTrust: "Trust notes",
    docsSubProcessors: "Sub-processors",
    docsRunbook: "Production runbook",
    statusEnabled: "enabled",
    statusNotConfigured: "not configured",
    statusDisabled: "disabled",
    liveTitle: "Live deployment posture",
    liveSubtitle: "from gateway /health · cached 30s",
    liveGatewayUnreachablePrefix:
      "Gateway health is not reachable from the dashboard. Detail: ",
    liveColControl: "Control",
    liveColStatus: "Status",
    liveColWhy: "Why security cares",
    liveByoControl: "BYO key encryption",
    liveByoWhy:
      "KMS-backed hosted deployments avoid raw provider keys at rest.",
    liveBodyStorageControl: "Request body storage",
    liveBodyStorageWhy:
      "Controls whether prompts are retained fully, sampled, or stubbed.",
    liveQualityControl: "Quality embedding",
    liveQualityWhy:
      "Enables semantic comparison for shadow A/B quality proof.",
    liveReplayControl: "Internal replay",
    liveReplayWhy:
      "Replay endpoint stays disabled unless the shared secret is set.",
    liveOtelControl: "OpenTelemetry export",
    liveOtelWhy:
      "Shows whether traces leave the deployment for an external backend.",
    liveBaselineControl: "Baseline policy",
    liveBaselineBucketsTpl: "{n} bucket(s)",
    liveBaselineWhy:
      "Explains whether automatic route-down policy is active.",
    liveSettingsPrefix: "For the full operator-facing integration list, open ",
    liveSettingsLink: "Settings → System integrations",
    liveSettingsSuffix: ".",
    dataTitle: "What data moves where",
    dataColData: "Data",
    dataColWhere: "Where it goes",
    dataColWhy: "Why",
    dataPrompt: "Prompt and response body",
    dataPromptWhere:
      "Your chosen upstream provider; TokSuan request ledger",
    dataPromptWhy:
      "Forward the request, compute cost, debug failures, prove savings",
    dataApiKey: "TokSuan API key",
    dataApiKeyWhere: "TokSuan database as SHA-256 hash",
    dataApiKeyWhy:
      "Authenticate gateway requests without storing plaintext",
    dataByoKey: "BYO provider key",
    dataByoKeyWhere:
      "KMS-encrypted database row; decrypted on the gateway hot path",
    dataByoKeyWhy: "Call upstream using your own provider account",
    dataBilling: "Billing metadata",
    dataBillingWhere: "Stripe + local subscription mirror",
    dataBillingWhy: "Plan enforcement, upgrades, cancellation, receipts",
    reliabilityTitle: "Current reliability boundary",
    reliabilityBody:
      "TokSuan does not offer a formal hosted SLA yet. We are explicit about that because a false 99.9% promise would be worse than an honest boundary. If reliability is a procurement blocker today, self-host the same code under your own SLO.",
    docsSecurity: "Security posture",
    docsDpa: "DPA template",
    items: {
      byoTitle: "BYO provider keys",
      byoBody:
        "You keep the OpenAI / Anthropic / DeepSeek provider relationship and bill. TokSuan does not resell tokens or take a spend spread.",
      kmsTitle: "KMS envelope encryption",
      kmsBody:
        "Hosted BYO keys are AES-256-GCM encrypted with per-row DEKs wrapped by AWS or GCP KMS. Master keys never leave KMS.",
      bodyTitle: "Request body controls",
      bodyBody:
        "Gateway deployments can store full bodies, sampled bodies, or compact stubs. Hosted defaults to a limited rolling window with deletion paths.",
      selfHostTitle: "Self-host escape hatch",
      selfHostBody:
        "If hosted reliability, procurement, or data residency is a blocker, run the same Apache-2.0 code on your own infrastructure.",
    },
  },

  stateOfSpend: {
    metaTitle: "State of Agent Spend",
    metaDescription:
      "A public TokSuan proof surface showing policy-preview routing wins, BYO provider coverage, and the privacy rules for future hosted aggregate telemetry.",
    eyebrow: "State of Agent Spend",
    title: "Public proof for when agents can safely land cheaper.",
    subtitle:
      "TokSuan is not a model marketplace. This page shows the control-plane view: policy-preview routing wins, provider-key coverage, and the privacy thresholds that will govern hosted aggregate telemetry once traffic is large enough to publish.",
    ctaEstimate: "Estimate your savings",
    ctaTrust: "Read trust notes",
    modePillPreview: "Preview mode",
    modeTitle: "Not customer telemetry yet.",
    modeBody:
      "Numbers below come from TokSuan's public baseline policy artifact, not private hosted traffic. Hosted aggregate stats will appear only after privacy thresholds are met.",
    modePolicyLabel: "Policy",
    policyUnavailable: "unavailable",
    statBuckets: "task buckets in public policy",
    statModels: "models compared across buckets",
    statProviders: "provider families covered",
    statAvgSavings: "avg cheaper route among preview wins",
    routingWinsEyebrow: "Routing wins",
    routingWinsTitle: "The proof surface TokSuan owns.",
    routingWinsBody:
      "OpenRouter ranks model demand. TokSuan ranks control-plane outcomes: which asked models have cheaper acceptable alternatives under the active quality policy. These examples are policy-preview candidates, not claims about your private traffic.",
    routingWinsCta: "See routing quality",
    routingWinsEmpty:
      "Policy preview is unavailable because the gateway could not return a baseline artifact.",
    routingWinsPolicyEmpty: "Policy preview unavailable.",
    routingWinsAsked: "Asked model",
    routingWinsLanded: "Cheaper landed model",
    routingWinsBucket: "Bucket",
    routingWinsSavings: "Savings",
    routingWinsGuardrail: "Guardrail",
    routingWinsPerSampleSuffix: " / sample",
    routingWinsQualityPass: "quality floor passed",
    routingWinsQualityDelta: "quality delta",
    providerEyebrow: "Works with your keys",
    providerTitle: "Provider coverage without token resale.",
    providerBody:
      "TokSuan routes, caps, and proves savings while your provider relationship stays yours. Bring the upstream keys you already use; TokSuan adds receipts and policy in the middle, not a token spread.",
    telemetryEyebrow: "Hosted + opt-in self-host aggregate telemetry",
    telemetryTitle: "What becomes public only after privacy thresholds.",
    signal1Title: "$ saved last 7 days",
    signal1Body:
      "Only after enough projects share the same route pattern.",
    signal2Title: "Agent loops blocked",
    signal2Body: "Counts repeated fingerprints, never prompt bodies.",
    signal3Title: "Prompt cache saved",
    signal3Body: "Shows cache-control impact by tag, not raw content.",
    signal4Title: "Models rejected by quality",
    signal4Body: "A route can be cheap and still fail the guardrail.",
    privacyTitle: "Privacy rule for public stats",
    privacyBody:
      "Aggregate rows from hosted traffic and opt-in self-host deployments stay private until every threshold below is met. When a route is too rare, the public page falls back to policy preview rather than exposing a customer-shaped signal.",
    privacyLabelProjects: "Projects",
    privacyLabelOrgs: "Organizations",
    privacyLabelRequests: "Requests",
    privacyLabelWindow: "Window",
    finalEyebrow: "Control + proof layer",
    finalTitle:
      "Many agent workloads overspend. Prove which turns can land cheaper.",
    finalBody:
      "Start with one request receipt, then promote routes only when the quality and budget evidence clears your bar.",
    finalCtaEstimate: "Estimate first",
    finalCtaStart: "Start free",
    finalCtaOpenClaw: "OpenClaw guide",
    navEstimate: "Estimate",
    navTrust: "Trust",
    navStart: "Start free",
    publicNavAriaLabel: "Public navigation",
    proofGridAriaLabel: "Public policy preview stats",
    routingWinsTableAriaLabel: "Routing wins preview",
  },

  routingQuality: {
    backHome: "← Home",
    backDashboard: "← Dashboard",
  },

  dashboard: {
    pageTitle: "Dashboard",
    heroEyebrow: "Dashboard",
    heroTitle: "Agent spend control",
    heroSubtitle:
      "Change one base_url to make every request visible, capped, and cheaper when the receipt proves the route is safe.",
    heroPillSee: "See every call",
    heroPillCap: "Cap runaway spend",
    heroPillShrink: "Shrink safe routes",
    heroPillKeep: "Keep it running",
    heroPillsAriaLabel: "TokSuan value pillars",
    tagline:
      "Everything you sent through TokSuan in the last 7 days, with what it cost and what it would have cost on the originally-asked model.",
    statTotalSpend: "Total spend",
    statRequests: "Requests",
    statSavings: "Savings",
    statSavingsPctSuffix: " saved",
    statRouted: "Routed",
    statBlocked: "Blocked",
    statLoops: "Loops detected",
    statBudget: "Budget",
    sectionRecent: "Recent requests",
    sectionTopRoutes: "Top routes that saved",
    sectionRecommendations: "Recommendations",
    sectionTopLoops: "Top repeating patterns · 24h",
    sectionQuality: "Quality proof",
    sectionBudgets: "Budgets",
    sectionSpendByModel: "Spend by model · 7d",
    sectionSpendByTag: "Spend by tag · 7d",
    sectionSavings: "Savings receipt",
    sectionDailySpend: "Daily spend · 7d",
    sectionFirstRequest: "Send your first request",
    emptyRecent: "No requests yet. Send your first one to see it land here.",
    emptyRecommendations:
      "No recommendations yet — your traffic is too small or already optimized.",
    emptyRoutes: "No cheaper routes yet.",
    emptyLoops:
      "No repeating request patterns yet. A pattern shows up once the same fingerprint fires 3+ times in the last 24h.",
    emptyBudgets:
      "No budgets configured. Add a daily or monthly cap on a project to control spend.",
    emptySpendByModel:
      "No requests yet. Send one through the gateway to start tracking.",
    askedModel: "Asked",
    landedModel: "Landed",
    routingReason: "Reason",
    cost: "Cost",
    saved: "Saved",
    latency: "Latency",
    project: "Project",
    when: "When",
    spikeTitle: "Cost spike detected",
    spikeBaselineSuffix: "h baseline",
    planCapTitlePrefix: "Your plan cap blocked ",
    planCapTitleSuffix: " in the last 24h",
    planCapBody:
      "Requests through this account are returning HTTP 402 (plan_limit_exceeded). This is the hosted-tier daily-spend or monthly-request ceiling — not a project budget. Upgrade to lift the cap.",
    planCapCta: "Upgrade plan →",
    firstSetupAddProviderLabel: "Add provider key",
    firstSetupAddProviderBody:
      "Start by pasting one upstream provider key. Your model bill stays with that provider.",
    firstSetupCreateProjectLabel: "Create project",
    firstSetupCreateProjectBody:
      "Next, create a TokSuan project. The project page is where you mint and copy a ts_ API key for your agent.",
    firstSetupOpenProjectLabel: "Open project setup",
    firstSetupOpenProjectBody:
      "You already have provider keys and a project. Open the project page to copy the generated curl command or create a fresh ts_ key.",
    topPattern: "Top pattern:",
    attempts: "attempts",
    showMorePatterns: "Show more patterns",
    budgetOverLimit:
      "Over limit — new requests return HTTP 429 until reset.",

    savingsHeroLabel: "Saved · last 30 days",
    savingsHeroSubWithPct:
      "{pct} off what the originally-requested models would have cost — via automatic routing, prompt-cache discounts, and context compression.",
    savingsHeroSubEmpty:
      "Send a request through TokSuan to get the first saved-money receipt. The dashboard will show asked model, landed model, cost, saved cost, and routing reason once traffic lands.",
    savingsHeroBreakdownRouting: "Routing",
    savingsHeroBreakdownCache: "Prompt cache",
    savingsHeroBreakdownToolCompress: "Context compression",
    savingsHeroBreakdownPrevented: "Also prevented",
    savingsHeroRoutingNote: "{n} requests downgraded",
    savingsHeroCacheNote: "{n} requests cached",
    savingsHeroToolCompressNote: "{n} requests with shrunk context",
    savingsHeroPreventedNote: "{loops} runaway loops · {budget} over-budget",

    receiptCardTitle: "Latest savings receipt",
    receiptOpenRequest: "Open request →",
    receiptAskedModel: "Asked model",
    receiptLandedModel: "Landed model",
    receiptSavedOnThis: "Saved on this request",
    receiptVsAskedSuffix: "% vs asked model",
    receiptActualCost: "Actual cost",
    receiptTrackedApiCost: "Tracked API cost",
    receiptCustomNote: "custom/self-host infra cost not included",
    receiptAskedWouldBe: "asked would be",
    receiptWhyHappened: "Why this happened:",
    receiptSelfHostNote: "Self-host/custom note:",
    receiptSelfHostBody:
      "TokSuan can prove this request moved off the asked model, but dollar savings do not include your GPU/infra cost unless you add pricing metadata for that endpoint.",
    receiptStatusRoutedDown: "routed down",
    receiptStatusCacheSaved: "cache saved",
    receiptQualityRisk: "Quality risk",

    weekTitle: "7-day value report",
    weekUpgradeSignal: "upgrade signal",
    weekSavedThisWeek: "Saved this week",
    weekProFeeRatio: "{ratio}x the $29 Pro fee",
    weekProFeePct: "{pct}% of the $29 Pro fee",
    weekTopDowngrade: "Top downgrade",
    weekNoneYet: "none yet",
    weekOverNRequests: "over {n} requests",
    weekPrevented: "Prevented",
    weekPreventedNote: "{loops} loops · {budget} budget/plan blocks",
    weekQualityProof: "Quality proof",
    weekShadowTrials: "{n} shadow trials",
    weekNoShadowYet: "no shadow data yet",
    weekTopDowngradeLabel: "Top downgrade:",
    weekRecommendedNextStep: "Recommended next step:",
    weekNoisiestPrefix: " Your noisiest repeated pattern is ",
    weekNoisiestMid: " on ",
    weekNoisiestSuffix: ".",
    weekActionAddShadow: "Add shadow rule",
    weekActionMoreTraffic: "Send more traffic",
    weekActionUpgrade: "Upgrade to Pro",
    weekBodyAddShadow:
      "Add a shadow rule to prove answer quality before routing more traffic.",
    weekBodyMoreTraffic:
      "Keep running real traffic until the receipt clears the $29 Pro fee.",
    weekBodyUpgrade:
      "Upgrade to Pro when you want hosted retraining and zero-ops maintenance.",

    dbErrColumnTitle: "Database is missing a column the dashboard needs.",
    dbErrColumnBody: " You have an older schema; apply the latest migrations:",
    dbErrColumnHint:
      " — likely needs migrations 006 (request tags) or 007 (shadow similarity).",
    dbErrColumnMissing: "Missing column:",
    dbErrTableTitle: "Database table is missing.",
    dbErrTableBodyPrefix: " Run ",
    dbErrTableBodyMid: " to re-seed from ",
    dbErrTableBodySuffix: ".",
    dbErrTableMissing: "Missing relation:",
    dbErrUnreachableTitle: "Database not reachable.",
    dbErrUnreachableBody:
      " Make sure docker compose up -d is running and the dashboard has the right DATABASE_URL.",

    firstReqHeaderHint: "the dashboard fills in the moment this lands",
    firstReqIntro:
      "This card walks you to one concrete outcome: a real request row with asked model, landed model, routing reason, tokens, cost, and savings. Do the highlighted next step below; you do not need to read docs to get the first receipt.",
    firstReqStepProviderKey: "Paste provider key",
    firstReqStepProviderEnv: "Set provider env",
    firstReqStepCreateProject: "Create project",
    firstReqStepCreateApiKey: "Create project API key",
    firstReqStepCopyCurl: "Copy generated curl/base_url",
    firstReqStepReadReceipt: "Read the receipt",
    firstReqActionManage: "manage",
    firstReqActionOpen: "open",
    firstReqActionOpenProject: "open project",
    firstReqActionOpenSetup: "open setup",
    firstReqNextStep: "Next step:",
    firstReqFooter:
      "The project page generates a curl command with the correct gateway URL, project key, attribution headers, and a smoke model that matches one of your saved provider keys.",

    statGridSpend7d: "Spend · 7d",
    statGridCalls7d: "Calls · 7d",
    statGridBlocked24h: "Blocked · 24h",
    statGridLoops24h: "Loops · 24h",
    statGridRouted24h: "Routed · 24h",
    statGridCached24h: "Cached · 24h",
    statGridCachedSavedPrefix: "saved ",

    dailyPeakPrefix: "peak ",
    dailyBudgetCapPrefix: "daily cap ",
    dailyCallSingular: "call",
    dailyCallPlural: "calls",

    budgetActiveSuffix: " active",
    budgetEmptyPrefix: "No active budgets. Set one with ",
    budgetEmptyCommand: "bun run set-budget -- --period daily --micro-cents 200",
    budgetPeriodToday: "Today",
    budgetPeriodThisMonth: "This month",
    budgetOverLimitPrefix: "Over limit — new requests return ",
    budgetOverLimitHttpCode: "HTTP 429",
    budgetOverLimitSuffix: " until reset.",

    loopColFingerprint: "Fingerprint",
    loopColModel: "Model",
    loopColAttempts: "Attempts",
    loopColShare: "Share",
    loopColBlocked: "Blocked",
    loopColLastSeen: "Last seen",
    loopShowMore: "Show {n} more pattern{s}",

    modelColModel: "Model",
    modelColCalls: "Calls",
    modelColSpend: "Spend",
    modelColShare: "Share",
    modelShowMore: "Show {n} more model{s}",

    tagSourceLabel: "from x-ts-tag header",
    tagColTag: "Tag",
    tagColCalls: "Calls",
    tagColSpend: "Spend",
    tagColShare: "Share",
    tagShowMore: "Show {n} more tag{s}",
    tagFooter:
      "Send x-ts-tag: feature=summarize,team=growth in the request header to attribute spend. Multi-tagged requests appear under each tag — totals here won't sum to global spend.",

    abTitle: "A/B experiments · 7d",
    abSubtitle: "shadow-routed",
    abColPrimary: "Primary",
    abColShadow: "Shadow",
    abColTrials: "Trials",
    abColPrimaryCost: "Primary $",
    abColShadowCost: "Shadow $",
    abColDelta: "Δ (saved if > 0)",
    abColLatency: "Latency",
    abColErrors: "Errors",

    recentLatestPrefix: "Latest ",
    recentEmptyPrefix: "Nothing yet. Send a request through ",
    recentEmptySuffix: " to see it land here.",
    recentColTime: "Time",
    recentColProvider: "Provider",
    recentColModel: "Model",
    recentColInput: "Input",
    recentColOutput: "Output",
    recentColCost: "Cost",
    recentColSaved: "Saved",
    recentColLatency: "Latency",
    recentColStatus: "Status",
    recentShowOlder: "Show {n} older request{s}",

    qpSwitchSafeLabel: "Switch-safe (≥0.85)",
    qpSwitchSafeAcrossPrefix: "across ",
    qpSwitchSafeAcrossSuffix: " trial{s}",
    qpSwitchSafeOfPrefix: "",
    qpSwitchSafeOfMid: " of ",
    qpSwitchSafeOfSuffix: " look equivalent",
    qpFooterBody:
      "Shadow trials run a cheaper model in the background after the primary request completes. A shadow failure does NOT fail the user-facing response. Shadow success only means the background call returned 2xx; it is a promotion signal, not production uptime. Avg similarity embeds both responses and cosine-compares them — 0.95+ is \u201Calmost certainly equivalent\u201D, 0.85+ is \u201Cswitch-safe\u201D, <0.70 is \u201Cinvestigate before switching\u201D. Set TOKENSMART_QUALITY_EMBED_MODEL to enable.",

    reasonLoopDetected:
      "Loop detector blocked a repeated fingerprint before it hit upstream.",
    reasonBudgetExceeded:
      "Project budget stopped this request before upstream spend.",
    reasonPlanLimitExceeded:
      "Plan cap stopped this request before upstream spend.",
    reasonOlderRewriteUnknown:
      "The gateway rewrote the model, but this older row did not store a routing reason.",
    reasonNoRewrite:
      "No model rewrite happened; TokSuan logged and priced the request as-is.",
    reasonBaseline:
      "Baseline policy classified this request{bucket} and chose the cheaper landed model within the policy tolerance.",
    reasonBaselineBucketPrefix: " as ",
    reasonRule:
      "A project routing rule matched this request and rewrote the model.",
    reasonFallback:
      "The gateway recovered from a model-resolution failure and fell back automatically.",
    reasonNoCallableCheaper:
      "Baseline policy classified this request as {taskType} / {complexity}, but every cheaper model in that bucket needs credentials this gateway can't reach (BYO or env). Add a provider key for one of those families and the route fires next time.",
    reasonNoCheaper:
      "Baseline policy classified this request as {taskType} / {complexity} but found no cheaper candidate inside the policy's quality tolerance. The asked model was already at or below the bucket's frontier.",
    reasonUnknownCallerModel:
      "Baseline policy refused to rewrite because the asked model isn't in the live policy artifact and isn't a known provider prefix. Logged as-is so the asked model name is still on the receipt.",
    reasonDisabled:
      "Baseline routing is currently disabled on this gateway; the request was logged and priced as-is.",
    reasonNoModel:
      "The request didn't carry a `model` field, so baseline policy had nothing to look up.",

    qualityDoNotRoute: "Do not route yet",
    qualityChecked: "Quality-checked",
    qualityHttpSafe: "HTTP-safe",
    qualityBaselineOnly: "Baseline only",
    qualityBodyDangerSimilarity:
      "Shadow A/B has {n} similarity-scored trial(s); avg similarity is {sim}. Keep the expensive model until you review failures.",
    qualityBodyOkSimilarity:
      "Shadow A/B has {n} similarity-scored trial(s); avg similarity {sim}, {pct}% switch-safe.",
    qualityBodyDangerSuccess:
      "Shadow A/B has {n} trial(s); only {pct}% of shadow calls returned 2xx. Primary responses were still served, but do not promote this route yet.",
    qualityBodyOkSuccess:
      "Shadow A/B has {n} trial(s); {pct}% of shadow calls returned 2xx. Primary responses were still served. Enable content quality scoring before promoting broadly.",
    qualityBodyBaselineOnly:
      "This cost receipt is based on routing policy and ledger math. Add a shadow rule to prove answer quality on your own traffic before widening routes.",
    qualityActionReviewRouting: "Review routing quality",
    qualityActionReviewProof: "Review proof",
    qualityActionReviewBorderline: "Review borderline trials",
    qualityActionReviewFailures: "Review failures",
    qualityActionEnableScoring: "Enable quality scoring",
    qualityActionAddShadow: "Add shadow rule",

    recommendationsTitle: "Priority actions",
    recProjectFallback: "(unnamed project)",
    recWastefulPattern:
      "{n} short prompts on {fromModel} last 7d in {project} — worth testing. Estimated savings: ~{saved} routing them to {toModel}.",
    recAddRoutingRule: "Add routing rule",
    recLoopSpike:
      "{project} caught {n} runaway loop attempts in the last 24h. Worth tightening the loop threshold or adding an alert.",
    recSetAlert: "Set alert",
    recUndersizedBudget:
      "{project} averages {avg}/day over the past 7d but its daily budget is {limit}. Requests are getting blocked routinely — bump the cap.",
    recEditBudget: "Edit budget",
    recNoBudget:
      "{project} spent {spend} in the past 7d with no daily budget set. One runaway loop could turn that into $1000s — set a cap.",
    recSetBudget: "Set budget",

    qpTitle: "Quality proof · 7d",
    qpEmptyHeader: "no shadow trials yet",
    qpEmptyBody:
      "Want to know if a cheaper model would actually work for your traffic — without changing your output? Set up a shadow A/B routing rule on any project. TokSuan will run the cheaper model in parallel against your primary, then show:",
    qpEmptyBullet1Title: "Shadow success",
    qpEmptyBullet1:
      "% of background cheap-model trials that returned 2xx; primary output is still served",
    qpEmptyBullet2Title: "Shadow faster",
    qpEmptyBullet2:
      "% where the background cheap-model trial beat primary on latency",
    qpEmptyBullet3Title: "Cost delta",
    qpEmptyBullet3: "$ you would have saved if shadow had been primary",
    qpEmptyBullet4Title: "Semantic similarity",
    qpEmptyBullet4Prefix:
      "cosine-compare of embedded responses (set ",
    qpEmptyBullet4Suffix: " to enable)",
    qpEmptyAddShadow: "Add a shadow rule →",
    qpEmptyCreateProject: "Create a project first →",
    qpEmptyHintPrefix: "Routing rules → Mode: ",
    qpEmptyHintMode1: "shadow",
    qpEmptyHintMode2: "both",
    qpEmptyHintConn: " or ",
    qpHeaderCounts: "{e} experiment(s) · {t} shadow trial(s)",
    qpStatSuccess: "Shadow success",
    qpStatSuccessNote: "{n} / {total} shadow calls returned 2xx",
    qpStatSuccessDangerNote:
      "Do not promote yet — shadow failures are too high.",
    qpStatSuccessOkNote: "Primary responses were still served to users.",
    qpStatFaster: "Shadow faster",
    qpStatFasterNote: "{n} trial(s) beat primary on latency",
    qpStatCostDiff: "Cost diff",
    qpStatCostDiffNote: "primary − shadow (positive = shadow cheaper)",
    qpAvgSimilarity: "Avg semantic similarity",
  },

  agentsPage: {
    dayWordSingular: "day",
    dayWordPlural: "days",
    paragraph:
      "One row per (agent, session) pair from the last {days} {dayWord}. Drill in to see every turn, which model ran it, and where the time/spend went. Sessions with a high declared/called tool count and a non-zero loop count are the first place to look when an agent is misbehaving.",
    windowLabel: "Window:",
    window24h: "24h",
    window7d: "7d",
    window30d: "30d",
    countLine: "{n} session(s) • total spend {spend}",
    colAgent: "Agent",
    colSession: "Session",
    colTurns: "Turns",
    colSpend: "Spend",
    colTokensInOut: "Tokens (in / out)",
    colP50P95: "p50 / p95",
    colCounters: "Tools / Err / Loop / Budget / Plan",
    colLastSeen: "Last seen",
    cellReqSuffix: "req(s)",
    cellLastSeenSuffix: "ago",

    titleToolCounts:
      "requests declaring tools / responses with observed tool calls",
    titleErrorCounts: "upstream errors",
    titleLoopBlocked: "loop-detected blocks",
    titleBudgetBlocked: "budget-exceeded blocks",
    titlePlanBlocked:
      "hosted plan-tier cap blocks (Free/Pro/Team daily-spend or monthly-request)",

    relSecondsAgo: "{n}s ago",
    relMinutesAgo: "{n}m ago",
    relHoursAgo: "{n}h ago",
    relDaysAgo: "{n}d ago",
  },

  routingQualityPage: {
    title: "Routing quality",
    dayWordSingular: "day",
    dayWordPlural: "days",
    paragraph:
      "For every (asked → landed) rewrite over the last {days} {dayWord}, compares its success rate to the same landing model when asked natively. Success rate denominator excludes blocks — loop / budget / plan-cap blocks fire before the upstream call, so they reflect TokSuan's protection layers doing their job, not routing quality. Raw block counts are surfaced separately. A rewrite that drops ≥ 5pp below baseline on a sample of ≥ 20 calls (counting blocks too) is flagged below.",
    statTotalRewrites: "Total rewrites",
    statOverallSuccess: "Overall rewrite success",
    statFlaggedPairs: "Flagged rewrite pairs",
    statFlaggedNote: "≥ 5pp drop, ≥ 20 calls",
    sectionRewrites: "Rewrite pairs",
    rewritesAsked: "Asked",
    rewritesLanded: "Landed",
    rewritesCalls: "Calls",
    rewritesSuccess: "Success",
    rewritesVsNative: "vs native baseline",
    rewritesErrors: "Errors",
    rewritesLoopQuota: "Loop / Quota",
    rewritesAvgLatency: "Avg latency",
    rewritesTotalSpend: "Total spend",
    sectionPerBucket: "Per baseline-policy bucket",
    perBucketBody:
      "Success rate broken down by the (task_type, complexity) bucket the baseline classifier picked. Surfaces whether some bucket — say code:hard — is reliably routed correctly, while another — say reasoning:medium — leaks quality. Only baseline-policy decisions appear here; project routing rules and non-routed traffic don't populate routing_bucket.",
    bucketCol: "Bucket",
    bucketCalls: "Calls",
    bucketSuccess: "Success",
    bucketErrors: "Errors",
    bucketLoopQuota: "Loop / Quota",
    bucketAvgSavedCall: "Avg saved/call",
    bucketTotalSpend: "Total spend",
    sectionNative: "Native baseline (no rewrite)",
    nativeBody:
      "Success rate of every landing model when the caller asked for it directly. This is the denominator the rewrite table above compares against.",
    nativeCol: "Model",
    nativeCalls: "Calls",
    nativeSuccess: "Success",
    nativeErrors: "Errors",
    nativeAvgLatency: "Avg latency",
    nativeTotalSpend: "Total spend",
    publicReadOnlyTitle: "Public read-only view.",
    publicReadOnlyBody:
      "Sign in to see your own project's routing quality data. This anonymous view never exposes hosted customer traffic.",
    publicSignInCta: "Sign in",
    emptyData: "No data yet for this window.",
    queryFailedPrefix:
      "Query failed. Likely cause: this page uses Postgres-only aggregations and the gateway is on SQLite mode. Switch DATABASE_URL to Postgres to enable.",
    queryFailedDetailPrefix: " Detail: ",
    emptyTitle: "No routing rewrites in the last {n} days yet.",
    emptyBodyPrefix:
      "This page populates as soon as the baseline policy or any project routing rule rewrites ",
    emptyBodyMid:
      ". Send a few requests and refresh; or check the gateway logs for ",
    emptyBodySuffix: " lines.",
  },

  settingsPage: {
    sectionTelemetryTitle: "Anonymous community telemetry",
    sectionTelemetryStatusOff: "off on gateway",
    sectionTelemetryStatusOn: "on (anonymous aggregates)",
    sectionTelemetryBody:
      "Help improve TokSuan's public routing map by sharing daily anonymous aggregates from this self-hosted deployment. This is opt-in only; hosted users don't need it, and self-host installs never phone home unless your gateway process runs the command below.",
    sectionTelemetryWhatSent: "What is sent",
    sectionTelemetryWhatSentItem1: "Daily request / routed / blocked counts",
    sectionTelemetryWhatSentItem2: "Route pairs like model A → model B",
    sectionTelemetryWhatSentItem3: "Estimated routing and cache savings",
    sectionTelemetryWhatSentItem4: "Project counts only for privacy thresholds",
    sectionTelemetryNeverSent: "Never sent",
    sectionTelemetryNeverSentItem1: "Prompts, responses, request bodies",
    sectionTelemetryNeverSentItem2: "Provider keys, user emails, project names",
    sectionTelemetryNeverSentItem3: "Request IDs or exact per-request timestamps",
    sectionTelemetryNeverSentItem4: "Low-count route rows below local thresholds",
    sectionTelemetryEndpointPrefix: "Gateway endpoint:",
    sectionTelemetryThresholds: "local thresholds: 5 requests and 1 project",
    sectionTelemetryDryRunHint: "First, dry-run locally to inspect the exact JSON:",
    sectionTelemetryCronHint:
      "Then add this to cron if you're comfortable sharing the aggregate:",
    sectionTelemetryCopyCron: "Copy cron command",

    hostedTelemetryTitle: "Community telemetry",
    hostedTelemetryPill: "hosted aggregate",
    hostedTelemetryBody:
      "Hosted TokSuan traffic can contribute to privacy-thresholded public routing stats like State of Agent Spend. We aggregate counts, route pairs, savings, and blocked-loop totals — never prompts, responses, provider keys, project names, user emails, or per-customer rows.",
    hostedTelemetryWhat: "What hosted aggregate can power",
    hostedTelemetryWhat1: "Public routing-win examples after enough traffic lands",
    hostedTelemetryWhat2: "Model pairs that repeatedly save money under guardrails",
    hostedTelemetryWhat3: "Loop and budget-block trends at aggregate level",
    hostedTelemetryWhat4: "Prompt-cache savings by tag, never by raw prompt",
    hostedTelemetryHow: "How self-host joins later",
    hostedTelemetryHow1: "Self-host installs are off by default",
    hostedTelemetryHow2: "Their Settings page shows a copy-ready cron command",
    hostedTelemetryHow3: "They can dry-run locally to inspect the exact JSON",
    hostedTelemetryHow4: "They can stop sharing by deleting one env var / cron line",
    hostedTelemetryViewProof: "View public proof page →",

    sectionTelemetryStatusUnknown: "gateway status unknown",

    deletionScheduledTitle: "Account scheduled for deletion",
    deletionScheduledBodyPrefix: "Requested at ",
    deletionScheduledBodyMid: ". Your data will be hard-deleted at ",
    deletionScheduledBodyDay: " day",
    deletionScheduledBodyDays: " days",
    deletionScheduledBodySuffix:
      " from now) per the DPA § 7.2 retention table. Until then you can still use the product normally; changed your mind?",
    deletionCancelBtn: "Cancel deletion",

    noKeysTitle: "No provider keys yet.",
    noKeysBody:
      " Without one, the gateway uses its env-configured credentials — meaning upstream calls bill the host operator (us in hosted, you in self-hosted), not your own account.",
    noKeysBodyMid:
      "Add one key per provider you want TokSuan to consider. The complexity judge also uses your same-provider BYO key by default, so a user with only an OpenAI key never needs to send prompts to Gemini just to classify a task.",
    noKeysHint:
      "↓ Use the form below to add your first key. Pick a provider, paste the API key, hit Save.",

    customColName: "Name",
    customColPrefix: "Model prefix",
    customColBaseUrl: "Base URL",
    customColKey: "Key",
    customColStatus: "Status",
    customNoAuth: "(no auth)",
    customEnabledPill: "enabled",
    customDisabledPill: "disabled",
    customEnableBtn: "Enable",
    customDisableBtn: "Disable",
    customDeleteBtn: "Delete",

    sysCacheDisabled: "Disabled. Repeat prompts hit upstream every time.",
    sysBaselineDisabled: "Disabled (TOKENSMART_BASELINE_POLICY_ENABLED=0)",

    sysCryptoAws: "AWS KMS envelope encryption (production-grade).",
    sysCryptoGcp: "GCP KMS envelope encryption (production-grade).",
    sysCryptoEnvMaster:
      "Env master key (development / single-tenant). Consider migrating to KMS for production.",

    providerKeysNoneTitle: "No provider keys yet.",
    providerKeysNoneBody1:
      "Without one, the gateway uses its env-configured credentials — meaning upstream calls bill the host operator (us in hosted, you in self-hosted), not your own account.",
    providerKeysNoneBody2:
      "Add one key per provider you want TokSuan to consider. The complexity judge also uses your same-provider BYO key by default, so a user with only an OpenAI key never needs to send prompts to Gemini just to classify a task.",
    providerKeysNoneHint:
      "↓ Use the form below to add your first key. Pick a provider, paste the API key, hit Save.",
    providerColLastErrorPrefix: "last error ",

    providerHealthTestOk: "✓ test OK",
    providerHealthTestFail: "✗ test failed",

    emailNextDigestPrefix: "Next digest: ",
    emailNextDigestSuffix: " UTC (Mondays 10:00 UTC).",
    emailNeverSentHosted:
      "Never sent yet — your first digest will land at {when} UTC once you subscribe.",
    emailNeverSentSelfHost:
      "Never sent yet — operator must run the cron job for this to actually fire.",

    providerUsageReqSingular: " request",
    providerUsageReqPlural: " requests",

    yourProviderKeysTitle: "Your provider keys",
    yourProviderKeysCount: "{n} configured",
    yourProviderKeysAddAnother: "+ Add another",
    providerColProvider: "Provider",
    providerColKey: "Key",
    providerColUsage30d: "30d usage",
    providerColHealth: "Health",
    providerColUpdated: "Updated",
    providerHealthNoTraffic: "no traffic",
    providerHealthUsedPrefix: "✓ used ",
    providerActionTest: "Test",
    providerActionDelete: "Delete",

    quotaTitle: "BYO quota guardrails",
    quotaSubtitle: "upstream-side caps",
    quotaIntro:
      "TokSuan enforces project budgets before upstream, but your BYO provider account should still have its own hard cap or billing alert. Use this table to size caps from actual gateway traffic.",
    quotaColProvider: "Provider",
    quotaCol24h: "24h spend",
    quotaCol30d: "30d spend",
    quotaColSuggested: "Suggested daily cap",
    quotaColRisk: "Risk",
    quotaRiskOk: "ok",
    quotaRiskNoTraffic: "no traffic",
    quotaRiskOkBody:
      "Traffic is low, but provider-side alerts are still recommended.",
    quotaRiskNoTrafficBody: "No recent usage through this provider key.",
    quotaFooter:
      "Suggested caps are conservative hints from TokSuan ledger usage, not provider-account limits. Set the actual cap in OpenAI, Anthropic, Gemini, DeepSeek, Qwen, Doubao, or your custom upstream console.",

    addProviderTitle: "Add or replace a provider key",
    addProviderSubtitle: "One key per provider per account",
    addProviderKeyPlaceholder: "Paste your provider API key",
    addProviderSaveCta: "Save key",
    addProviderCustomBaseUrl: "Optional: custom base URL",
    addProviderCustomBaseUrlHelp:
      "base URL only needed for Azure OpenAI, private endpoints, or regional forks of an upstream provider. Leave empty for the standard api.openai.com / api.anthropic.com / etc.",
    addProviderRoutingHint:
      "Routing logic: gateway picks the provider by model name pattern (claude-* → Anthropic, gpt-* → OpenAI, etc.) and uses the matching key from above. Missing-key requests fall back to gateway env-configured credentials (typically operator-owned for self-hosters).",
    addProviderStorageHint:
      "Storage: AES-256-GCM ciphertext + last-4 for display. Plaintext is encrypted before it touches Postgres and never written to logs.",

    rejectedTitle: "Models we couldn't route (last 7 days)",
    rejectedSubtitle: "{n} distinct",
    rejectedIntro:
      "Every rejected request you see here is a model an agent asked for but the gateway couldn't route. Fix: either add the provider's built-in key (Provider keys above) OR register it as a Custom provider below.",
    rejectedColModel: "Model",
    rejectedColReason: "Reason",
    rejectedColProvider: "Provider (guess)",
    rejectedColHits: "Hits",
    rejectedColProjects: "Projects",
    rejectedColLastSeen: "Last seen",
    rejectedActionRegister: "Register as custom ↓",
    rejectedActionAddKey: "Add key for {provider} ↓",

    customTitle: "Custom upstream providers",
    customCount: "{n} registered",
    customIntro:
      "Use these to wire up ANY OpenAI-compatible endpoint the gateway doesn't already know about — Groq, xAI, Mistral direct, self-hosted vLLM / Ollama, corporate private endpoints, etc. Gateway routes by model_prefix (case-insensitive prefix match) so pick something specific enough to not alias against other providers. Leave the API key blank for unauthed local endpoints. For self-hosted models, TokSuan shows routing/capacity proof by default; dollar savings are only exact after you provide pricing or pool-cost metadata.",
    customNamePlaceholder: "name (e.g. my-groq)",
    customPrefixPlaceholder: "model prefix (e.g. groq/)",
    customBaseUrlPlaceholder: "base_url (e.g. https://api.groq.com/openai/v1)",
    customApiKeyPlaceholder:
      "API key (optional — leave blank for unauthed local endpoints like vLLM)",
    customRegisterCta: "Register",
    customWireFormatHint:
      "Wire format: all custom providers must speak OpenAI's /v1/chat/completions shape. Anthropic-native /v1/messages isn't supported here — use the built-in Anthropic provider via BYO-key above for Claude.",
    customPricingHint:
      "Pricing + auto-routing: custom providers forward fine, but TokSuan cannot know your self-hosted GPU cost automatically. Reservations use a global_max safety budget; dollar savings are treated as unavailable unless pricing/pool metadata is configured. Open a GitHub issue to add pricing + quality benchmarks for a custom endpoint.",
    customResolutionHint:
      "Resolution order: custom providers win before built-in recognizers, so a custom gpt- prefix overrides the built-in OpenAI route. Pick specific prefixes that don't collide unless you mean to.",

    sysIntegrationsTitle: "System integrations",
    sysIntegrationsSource: "from gateway /health · cached 30s",
    sysIntegrationsCol1: "Integration",
    sysIntegrationsCol2: "Status",
    sysIntegrationsCol3: "Why / how to enable",
    sysFailoverTitle: "Cross-provider failover",
    sysFailoverStatusEmpty: "No failover map configured.",
    sysFailoverHint:
      "Set TOKENSMART_FAILOVER_MAP env on the gateway, e.g. \"gpt-4o=>claude-3-5-sonnet-latest,gpt-4o-mini=>claude-3-5-haiku-latest\". Triggers on transient 5xx / 429 / network errors after retry exhaustion.",
    sysMultiKeyTitle: "Multi-key rotation",
    sysMultiKeySingle: "(single key)",
    sysMultiKeyHint:
      "Comma-separate keys in env vars (e.g. OPENAI_API_KEY=sk-1,sk-2,sk-3). Round-robin per request; benched for 30s on 429 (or upstream's Retry-After).",
    sysOtelTitle: "OpenTelemetry trace export",
    sysOtelStatusEmpty: "Not configured. Spans not exported.",
    sysOtelHint:
      "Set OTEL_EXPORTER_OTLP_ENDPOINT (Langfuse / Datadog / Tempo / Honeycomb / Phoenix all accept OTLP/HTTP/JSON). One span per chat completion with gen_ai.* + tokensmart.* attributes.",
    sysQualityEmbedTitle: "Quality embedding (shadow A/B)",
    sysQualityEmbedStatusEmpty:
      "Not configured. Quality Proof card shows status-only signal.",
    sysQualityEmbedHint:
      "Set TOKENSMART_QUALITY_EMBED_MODEL=text-embedding-3-small to enable cosine-similarity comparison of shadow vs primary responses. ~$0.0002 per shadow trial.",
    sysByoEncTitle: "BYO key encryption backend",
    sysByoEncStatusEmpty:
      "BYO keys disabled — gateway uses env-only credentials.",
    sysByoEncHint:
      "Configure TOKENSMART_KMS_KEY_ARN (AWS) or TOKENSMART_GCP_KMS_KEY_NAME (GCP) for production. Fall-back env-master-key works fine for local dev.",
    sysCacheTitle: "Semantic cache",
    sysCacheMaxEntries: "Max entries:",
    sysCacheTtl: "TTL:",
    sysCacheSimThreshold: "Similarity threshold:",
    sysCacheHint:
      "Set TOKENSMART_CACHE_ENABLED=1 to enable in-memory exact-match cache. Add TOKENSMART_CACHE_SIMILARITY_THRESHOLD=0.95 (and TOKENSMART_QUALITY_EMBED_MODEL) for embedding-based near-match. Cache hits are recorded as cost=$0 requests with a `cached_by` tag.",
    sysBaselineTitle: "Baseline routing policy",
    sysBaselineVersion: "Version:",
    sysBaselineBuckets: "{n} bucket(s) loaded",
    sysBaselineHint:
      "Frontier-aware policy from public benchmarks. Routes simple/medium turns toward cheaper models, keeps hard/frontier work on advanced models unless evidence is strong.",

    emailPrefsTitle: "Email preferences",
    emailWeeklyTitle: "Weekly savings digest",
    emailWeeklyBody:
      "One email per week summarizing how much TokSuan saved you in the previous 7 days — routing + cache breakdown, top routed pairs, current spend rate. Sent via Resend. Opt-in (we never auto-subscribe).",
    emailLastSentPrefix: "Last sent:",
    emailOperatorNote:
      "Operator note: even if you opt in, the email only fires when someone runs `bun run send-weekly-savings` (typically via cron / Fly Machines / GitHub Actions). Self-hosted installs need to schedule that themselves.",
    emailSubscribeBtn: "Subscribe",
    emailUnsubscribeBtn: "Unsubscribe",
    emailSubscribed: "● Subscribed",
    emailUnsubscribed: "○ Not subscribed",

    privacyTitle: "Data & privacy",
    privacySubtitle: "self-serve · matches the DPA",
    privacyExportTitle: "Export my data",
    privacyExportBody:
      "Download a full NDJSON archive of everything tied to your account — profile, projects, API-key metadata, budgets, routing + alert rules, prompt templates. Audit events and requests are capped at the 10,000 most recent rows each (heavy agent fleets can exceed that in a single day; for a complete historical dump, open a GitHub issue — we'll respond within the GDPR § 12 one-month window). API key plaintext is NOT in the archive (it was only ever shown once at mint time). Stripe invoice detail is also NOT included — use Stripe's own data-subject-request process for that.",
    privacyExportCta: "Download NDJSON",
    privacyDeleteTitle: "Delete my account",
    privacyDeleteBody:
      "Marks your account for deletion. 30-day grace period — you can cancel any time from this page before then. At T+30d, everything is hard-deleted per the DPA § 7.2 retention table except for audit events (3-yr SOC-2 retention) and billing records (7-yr legal retention), both of which are no longer associated with an active user after the sweep. If you own an organization with other members, transfer ownership first.",
    privacyDeleteConfirmHint:
      "To confirm, type DELETE (exact, uppercase) in the field below.",
    privacyDeletePlaceholder: "DELETE",
    privacyDeleteSchedule: "Schedule deletion",
    apiKeyHashedAtRestTooltip: "Hashed at rest",
    providerLastErrorTooltip: "Most recent upstream error against this provider",
    providerLastSuccessTooltip: "Most recent successful upstream call",
    customPrefixTooltip:
      "Prefix match, case-insensitive. Example: 'groq/' matches groq/mixtral-8x7b.",
  },

  projects: {
    listTitle: "Projects",
    listTagline:
      "Create one project, get one API key, swap one base_url, then read your first saved-money receipt on the dashboard.",
    createButton: "Create project",
    namePlaceholder: "my-agent",
    emptyTitle: "No projects yet",
    emptyBody:
      "Create your first project to mint a TokSuan API key your agent can use as a drop-in OpenAI-compatible base URL.",
    providerJustSavedTitle: "Provider key saved. Next: create a project API key.",
    providerJustSavedBody:
      "Your upstream provider key stays encrypted in Settings. Agents do not use that key directly. They use a TokSuan project key that starts with ts_.",
    providerJustSavedCta: "Open {project} and create a project API key →",
    cardCreated: "Created",
    cardOpen: "Open →",
    cardDelete: "Delete",
    confirmDelete:
      "Delete this project? All API keys and request history are removed.",

    fastPathTitle: "Fast path: create your POC project",
    fastPathBody:
      "This creates a project first. On the next screen you will name an API key, then we show the secret once with the exact curl/SDK setup needed to produce your first savings receipt.",
    fastPathCreateBtn: "Create default project",
    fastPathAddKeyBtn: "Add provider key first",

    listColName: "Name",
    listColCreated: "Created",
    listColProjectId: "Project ID",
    listDeleteTitle: "Delete this project and revoke its API keys",

    sidebarBackAll: "← All projects",
    sidebarGroupConfigure: "Configure",
    sidebarGroupReference: "Reference",
    sidebarApiKeys: "API keys",
    sidebarBudgets: "Budgets",
    sidebarRouting: "Routing rules",
    sidebarAlerts: "Alerts",
    sidebarTemplates: "Prompt templates",
    sidebarTags: "Cost tags",
    sidebarPolicy: "Routing policy",
    sidebarSetup: "Setup instructions",
    sidebarGettingStarted: "Get started",
    sidebarAriaLabel: "Project sections",
    sidebarMainTitleFallback: "Project",

    revealHeading: "New key — copy it now",
    revealBody:
      "This is the only page view that will show the full key. It stays visible until you leave or refresh; after that we only keep a SHA-256 hash and the prefix + last-4 for display.",
    revealUseInAgent: "Use this key in your agent",
    revealOrCopyCurl: "Or copy one ready-to-run smoke test:",
    revealCopyCurlBtn: "Copy curl command",
    revealOpenDashboard: "Open dashboard receipt →",

    gettingStartedTitle: "Next: send your first request",
    gettingStartedHeaderHint: "first receipt setup",
    gettingStartedBody:
      "This project exists, but no recent requests have landed. Agents need a TokSuan project key that starts with ts_. Provider keys in Settings pay upstream bills; project keys are what your agent sends to TokSuan.",
    gettingStartedKeyNamePlaceholder: "key name, e.g. cursor-demo",
    gettingStartedCreateBtn: "Create API key and show curl →",
    gettingStartedFreshKeyName: "key name, e.g. first-receipt",
    gettingStartedFreshBtn: "Create fresh API key →",
    gettingStartedAlreadySent: "I already sent a request",
    gettingStartedExistingHint:
      "You already have {n} project key{s}, but full secrets are shown only once. If you did not copy one, create a fresh key now; the next screen will show the full ts_ key and a ready-to-run curl command.",
    gettingStartedTemplateHint:
      "If you still have your full ts_ key, paste it into this template:",

    setupTitle: "Setup instructions",
    setupHeaderHint: "base_url + API key",

    apiKeysTitle: "API keys",
    apiKeysNamePlaceholder: "key name (required)",
    apiKeysNewBtn: "New key",
    apiKeysEmpty: "No keys yet. Create one above.",
    apiKeysColName: "Name",
    apiKeysColKey: "Key",
    apiKeysColCreated: "Created",
    apiKeysColLastUsed: "Last used",
    apiKeysLastUsedNever: "never",
    apiKeysGracePrefix: "● grace · ",
    apiKeysGraceExpiresHM: "expires in {h}h {m}m",
    apiKeysGraceExpiresM: "expires in {m}m",
    apiKeysRotateBtn: "Rotate",
    apiKeysRotateTitle:
      "Mint a replacement key; the old one stays valid for 24h so rolling deploys don't 401. Don't forget to update your env before the grace window expires.",
    apiKeysDeleteBtn: "Delete",
    apiKeysDeleteNowBtn: "Delete now",
    apiKeysDeleteNowTitle:
      "Immediately invalidate this key, cutting the 24h grace short.",
    apiKeysFootnote:
      "New keys are stored as a SHA-256 hash plus prefix + last-4 for display. Existing legacy plaintext keys remain valid — rotate them by issuing a new key and deleting the old one. Revocation is instant via Delete.",
    apiKeysHashedAtRestTooltip: "Hashed at rest",

    tagsTitle: "Tag your requests for cost attribution",
    tagsCopyHeaderBtn: "Copy example header",

    templatesTitle: "Prompt templates",
    templatesManageBtn: "Manage →",

    budgetsTitle: "Budgets",
    budgetsActiveSuffix: " active",
    budgetsEmpty:
      "No budgets set. Pick a preset above, or type a custom amount — sub-cent limits work (e.g. 0.001).",
    budgetsColPeriod: "Period",
    budgetsColLimit: "Limit",
    budgetsColStatus: "Status",
    budgetsColUpdated: "Updated",

    routingTitle: "Routing rules",
    routingPolicyChangelog: "Policy changelog →",
    routingClassifierChangelog: "Classifier changelog →",
    routingPolicyChangelogTooltip:
      "Per-project routing policy versions, generated by the nightly retrain",
    routingClassifierChangelogTooltip:
      "Per-project embedding-classifier versions + per-class metrics + rollback",
    routingConfiguredSuffix: " configured",
    routingEmpty:
      "No routing rules yet. Pick a preset above, or use the model picker + threshold slider to author one. The built-in baseline policy will still route automatically — these are project-level overrides that always run first.",
    routingColMode: "Mode",
    routingColFromPattern: "From pattern",
    routingColToModel: "To model",
    routingColShadow: "Shadow",
    routingColThreshold: "Threshold",
    routingColSample: "Sample",
    routingColStatus: "Status",

    alertsTitle: "Alerts",
    alertsSubscribedSuffix: " subscribed",
    alertsEmpty: "No alert subscriptions yet.",
    alertsColNotifyWhen: "Notify when",
    alertsColSendTo: "Send to",
    alertsColEmail: "Email",
    alertsColStatus: "Status",
    alertsColCreated: "Created",
    alertsStatusEnabled: "enabled",
    alertsStatusDisabled: "disabled",
    alertsDeleteBtn: "Delete",
    alertsEmailOk:
      "✓ Email delivery is on — subscribers in the Email column will receive real messages",
    alertsEmailOkFromPrefix: " (from ",
    alertsEmailNotConfigured:
      "⚠ Email delivery isn't set up on this server yet — for now, post messages to your chat group instead. Email rows are logged to the gateway console only.",
    alertsEmailSelfHostSummary: "Self-host operator: how to enable email",
    alertsEmailSelfHostBody:
      "Set RESEND_API_KEY (and optionally RESEND_FROM) on the gateway process and restart it. The gateway sends through Resend's HTTP API directly — no SMTP wiring needed.",
    alertsFooter:
      "When an event fires, the gateway sends a short message to your chat group (and an email if you set one). Cost-spike alerts wait at least 6 hours between repeats so one bad afternoon doesn't spam you. After you save a subscription, click Test on its row to fire a sample now and confirm it arrives.",
    alertsTestBtn: "Test",

    setupBody:
      "Change your OpenAI-compatible client's base_url to the gateway URL above, use one of the API keys below, and keep sending calls to /v1/chat/completions in OpenAI shape. The gateway picks the upstream provider from the model field you already send — no code changes beyond base_url. Each response also carries X-Tokensmart-* proof headers so you can see asked model, landed model, routing reason, actual cost, and saved cost without leaving your terminal.",
    setupResolveTitle: "Works with anything — here's how it resolves",
    setupResolve1Title: "Major providers, out of the box.",
    setupResolve1Body:
      "We ship credentials + routing policy for OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, and Doubao. Drop any of their model names in the model field and it works immediately. Paid plans add background learning on your own traffic; hosted catalog freshness is surfaced in-product as that operation is rolled out.",
    setupResolve2Title: "Your own account for any of the above.",
    setupResolve2BodyPrefix: "Upload your provider key in ",
    setupResolve2BodyLink: "Settings → Provider keys",
    setupResolve2BodySuffix:
      " to route your project's traffic through your own billing. Overrides the gateway's built-in credentials for that project.",
    setupResolve3Title: "Any other OpenAI-compatible endpoint.",
    setupResolve3BodyPrefix:
      "Groq, xAI, Mistral direct, self-hosted vLLM / Ollama — register a custom upstream in ",
    setupResolve3BodyLink1: "Settings → Provider keys",
    setupResolve3BodyMid:
      " with its base URL + model prefix. Passthrough routing works immediately. For self-hosted models, TokSuan proves that traffic moved off the large-model endpoint; exact dollar savings require pricing or GPU-pool cost metadata (request it in ",
    setupResolve3BodyLink2: "GitHub issues",
    setupResolve3BodySuffix: " or wait for the next catalog sweep).",
    setupResolve4Title: "Brand-new model name we haven't indexed.",
    setupResolve4Body:
      "The request still forwards if it matches a known provider prefix (e.g. a just-released gpt-* or claude-*). Pricing uses a conservative safety reservation until the catalog refresh adds exact numbers.",
    setupPrincipleBodyPrefix:
      "Principle: first prove value, then tune. Send one request, inspect the receipt, then add budgets, routing rules, or shadow tests where the data says they matter. See ",
    setupPrincipleBodyLink: "integration docs",
    setupPrincipleBodySuffix: " for per-agent quickstarts.",

    tagsBodyPrefix: "Send the ",
    tagsBodyMid:
      " header on requests through this project's API key, and TokSuan will group spend by tag on the dashboard's ",
    tagsBodySuffix:
      " card. Comma-separated key=value pairs (max 20 per request, max 64-char keys, max 256-char values). No setup required — just add the header.",
    tagsExampleCurl: "curl",
    tagsExamplePythonSdk: "OpenAI Python SDK",
    tagsCommonDimsPrefix: "Common tag dimensions: ",
    tagsCommonDimsSeparator: ", ",
    tagsCommonDimsSuffix:
      ". Use any identifier-shaped strings; commas + equals signs in values aren't supported.",
    tagsFrameworksHintPrefix:
      "Per-framework setup (LangChain, Vercel AI SDK, Cline, Cursor): see ",
    tagsFrameworksHintLink: "integration guides",
    tagsFrameworksHintSuffix: ".",

    templatesBodyPrefix:
      "Save and version your system prompts in TokSuan, then send the ",
    templatesBodyMid:
      " request header from your agent. The gateway resolves the template + injects it as the system message at request time, so editing the prompt in the dashboard takes effect without changing your code. Pin a specific version with ",
    templatesBodySuffix:
      "; omit the suffix to track the current version. Every save keeps prior versions queryable for rollback or A/B work.",
    templatesVarsHintPrefix: "Variables in ",
    templatesVarsHintMid1: " are filled from ",
    templatesVarsHintMid2:
      " in the body (preferred for large values) or from a JSON-encoded ",
    templatesVarsHintMid3:
      " header. Each request that resolves a template stamps ",
    templatesVarsHintMid4: " + ",
    templatesVarsHintMid5:
      " on the row, so the dashboard's Spend-by-tag card breaks out cost per template version automatically.",
    templatesVarsHintSuffix: "",

    smokeIntroPrefix: "We picked the ",
    smokeIntroFamilyMid: " family flagship ",
    smokeIntroBucketMid: " from the live ",
    smokeIntroBucketSuffix: " bucket — your ",
    smokeKeyDirectPrefix: " key calls it directly. TokSuan routes this down to ",
    smokeKeyDirectSuffix: "",
    smokeRouteDownPrefix: "",
    smokeSameFamilyNote: " in the same family",
    smokeSavingsSuffix: ", expected to save ~{usd} per call.",

    noRoutableTitle: "Add a provider key to start receiving receipts.",
    noRoutableNoKey: "You haven't added a provider key yet",
    noRoutableNoneInPolicy:
      "None of your provider keys ({keys}) appear in the live policy",
    noRoutableBody:
      "{prefix}{policyVer}, so we can't pick a smoke model that's guaranteed to call upstream. Pick any provider we've benchmarked and we'll generate a working curl right after.",
    noRoutableUnlockPrefix: "Easiest providers to start with right now: ",
    noRoutableUnlockOr: " or ",
    noRoutableUnlockComma: ", ",
    noRoutableAddBtn: "Add a provider key →",

    policyTitle: "Routing policy",
    policyChangelogLink: "Full changelog →",
    policyActiveLabel: "Active",
    policyShippedBaseline: "Shipped baseline",
    policyTrainedSamplesPrefix: "trained on ",
    policyTrainedSamplesSingular: " sample",
    policyTrainedSamplesPlural: " samples",
    policyNoActive: "no active per-project version",
    policyNeverTrained: "never trained",
    policySaved30dLabel: "Saved (30d)",
    policySaved30dNote: "routing + cache savings",
    policyLearningLabel: "Learning",
    policyLearningOn: "ON",
    policyLearningPaused: "PAUSED",
    policyLearningOnNote: "nightly retrain runs",
    policyLearningFrozen: "current policy frozen",
    policyLearningEmptyNote: "no nightly retrain yet",
    policyShadowSetupBodyPrefix:
      "Learning is on but no per-project version has been trained yet — the nightly retrain needs shadow A/B observations to learn from. Open ",
    policyShadowSetupRoutingLink: "Routing rules",
    policyShadowSetupMid:
      " to set up a sampled shadow rule, or read the ",
    policyShadowSetupPolicyLink: "policy page",
    policyShadowSetupSuffix: " for the exact CLI command.",
  },

  settings: {
    title: "Account & keys",
    tagline:
      "Add the upstream provider keys TokSuan should use on your behalf, manage account-level email preferences, and export or delete your data.",
    sectionByoProviders: "Bring-your-own provider keys",
    byoIntro:
      "Each provider key is encrypted at rest. TokSuan routes requests through whichever providers you've enabled here.",
    byoEnabledHelp:
      "Enabled — TokSuan can route requests to this provider.",
    byoDisabledHelp:
      "Disabled — saved but TokSuan will skip this provider when picking a route.",
    byoSavedAt: "Saved",
    byoTestPass: "Test passed",
    byoTestFail: "Test failed",
    byoTesting: "Testing…",
    byoTestNever: "Not tested yet",
    apiKeyLabel: "API key",
    apiKeyPlaceholder: "Paste the provider's API key",
    apiKeyEnabledLabel: "Use for routing",
    saveProvider: "Save",
    deleteProvider: "Delete",
    confirmDeleteProvider:
      "Remove this provider key? TokSuan will stop routing to this provider until you re-add a key.",
    sectionWeeklyDigest: "Weekly savings digest",
    weeklyDigestIntro:
      "A short Monday email with last week's spend, savings, and biggest routing wins. You can unsubscribe in one click from the email itself.",
    weeklyDigestEnabled: "Send the weekly digest",
    weeklyDigestDay: "Sent every Monday morning UTC.",
    sectionDangerZone: "Danger zone",
    dangerExportTitle: "Export your data",
    dangerExportBody:
      "Download a JSON archive of every project, request, budget, and routing rule attached to this account.",
    dangerExportCta: "Download export",
    dangerDeleteTitle: "Delete account",
    dangerDeleteBody:
      "Mark this account for deletion. You'll have 30 days to cancel before the data is removed permanently.",
    dangerDeleteCta: "Mark for deletion",
    dangerDeleteCancel: "Cancel deletion",
    accountDeletedBanner:
      "This account is scheduled for deletion. Cancel below if that wasn't intended.",
  },

  agents: {
    title: "Agent sessions",
    tagline:
      "Group of requests that shared an x-ts-agent + x-ts-session header. Use this to follow a single conversation across many turns.",
    backDashboard: "← Dashboard",
    emptyTitle: "No agent sessions yet",
    emptyBody:
      "Send the request headers x-ts-agent, x-ts-session, and x-ts-turn on each call so TokSuan can group them into sessions.",
    columnAgent: "Agent",
    columnSession: "Session",
    columnTurns: "Turns",
    columnSpend: "Spend",
    columnLast: "Last seen",
    sessionTitle: "Session",
    sessionBackAll: "← All agent sessions",
    sessionTurns: "requests",
    sessionOk: "ok",
    sessionErr: "non-success",
    sessionTools: "tools called",
    sessionSpent: "spent",
    sessionElapsed: "elapsed",
  },

  requests: {
    title: "Request",
    backDashboard: "← Back to dashboard",
    sectionPromptMessages: "Prompt messages",
    sectionAssistantText: "Assistant response",
    sectionRouting: "Routing decision",
    sectionReplay: "Replay",
    emptyMessages: "No messages parsed from request body.",
    askedModel: "Asked model",
    landedModel: "Landed model",
    routingReason: "Routing reason",
    cost: "Cost",
    saved: "Saved",
    latency: "Latency",
    inputTokens: "Input tokens",
    outputTokens: "Output tokens",
    totalTokens: "Total tokens",
    projectName: "Project",
    sessionId: "Session",
    turnId: "Turn",
    agentName: "Agent",
    channel: "Channel",
    requestId: "Request id",

    dbErrTitle: "Database not reachable.",

    routedTitle: "Routed down",
    routedSavedPill: "saved {amount} vs original model",
    routedReplaceBody: "TokSuan replaced the requested model:",
    routedLockHeader:
      "Want every future request for {model} in this project to auto-route here? One click adds it as a project-level rule (you can edit the threshold later).",
    routedLockButton: "Lock as project rule",

    statCost: "Cost",
    statInputTokens: "Input tokens",
    statInputCachedSuffix: " cached",
    statOutputTokens: "Output tokens",
    statLatency: "Latency",
    statProjectKey: "Project · Key",
    statFingerprint: "Fingerprint",

    replayTitle: "Replay this request",
    replayHeaderHint: "writes a new row, doesn't modify this one",
    replayIntroPrefix:
      "Re-issue the same body against another model. The new request lands in your ledger tagged ",
    replayIntroMid: "",
    replayIntroSuffix:
      " so you can compare cost and quality side-by-side. Consumes your BYO credentials for the chosen provider.",
    replayModelPlaceholder: "Model to run against",
    replayButton: "Replay",
    replaySetupPill: "setup needed",
    replaySetupBody:
      "Replay re-issues the same prompt against another model and writes a new row so you can compare cost and quality side-by-side. It uses a shared secret between the dashboard and gateway so only this process — not anyone on the public internet — can POST to the gateway's /internal/replay endpoint.",
    replaySetupStep1: "Generate a 32-byte shared secret:",
    replaySetupStep2Prefix: "Paste the ",
    replaySetupStep2Same: "same",
    replaySetupStep2Mid: " value into ",
    replaySetupStep2Both: "both",
    replaySetupStep2Suffix: " processes' env files:",
    replaySetupStep3Prefix: "Restart both ",
    replaySetupStep3Suffix:
      " processes — this card will turn into the replay form.",
    replaySetupFooter:
      "The value must be byte-identical between the two processes. Don't wrap in quotes. Never prefix it with NEXT_PUBLIC_ — it's a server-only secret.",

    loopTimelineTitle: "Loop timeline · 24h",
    loopTimelineCallsSuffix: " calls",
    loopTimelineSpanSuffix: " span",
    loopTimelineTotalSuffix: " total",
    loopTimelineBlockedSuffix: " blocked",
    loopTimelineBody:
      "Every request that shares fingerprint {fingerprint}. The tall marker is this one. Click any other tick to jump to it.",
    loopTimelineAriaTpl: "{n} call timeline",

    errorTitle: "Error",

    contextCompressionTitle: "Context compression originals",
    contextCompressionBody:
      "TokSuan compressed this tool/function message before forwarding it upstream. Reversible storage is enabled, so the original bytes are retained here for audit and recovery.",
    contextCompressionOriginal: "Original content",
    contextCompressionCompressed: "Compressed content",
    contextCompressionSavedPrefix: "saved ",
    contextCompressionSavedSuffix: " chars",

    rawRequestBody: "Raw request body",
    rawResponseBody: "Raw response body",
    emptyResponseBody: "No response body — request never hit upstream.",
  },

  agentSession: {
    summary:
      "{requests} {reqWord} • {ok} ok / {err} non-success • {tools} declared tools / {observed} called tools • spent {spent} ({tokensIn} in / {tokensOut} out tokens) over {elapsed} from {when}",
    requestsSingular: "request",
    requestsPlural: "requests",
    statusOk: "ok",
    statusLoop: "loop",
    statusBudget: "budget",
    statusPlan: "plan",
    statusError: "error",
    colIndex: "#",
    colTurn: "Turn",
    colModel: "Model",
    colStatus: "Status",
    colInOut: "In / Out",
    colCost: "Cost",
    colLatency: "Latency",
    colTools: "Tools",
    colWhen: "When",
    cellCachedSuffix: " cached",
    cellToolCalled: "called",
    cellToolDeclared: "declared",
    cellToolNoneTitle: "no tool calls observed",
    titleObservedTools: "observed tool calls: {names}",
    titleObservedFinish: "observed tool call finish reason",
    titleDeclaredTools: "declared tools: {names}",
    titleDeclaredArray: "request body declared tools[]",
    titleCachedTokens: "cached input tokens (no upstream charge)",
    viewLink: "view →",
    nonSuccessTitle: "Most recent non-success",
  },

  billing: {
    title: "Billing & plan",
    tagline:
      "Your current plan, usage so far this billing window, and how to change plan or cancel.",
    sectionCurrentPlan: "Current plan",
    planLabel: "Plan",
    upgradeCta: "Upgrade",
    manageSubscription: "Manage subscription",
    sectionSavings: "Savings receipt",
    savingsBody:
      "TokSuan only earns on hosted plans. Self-hosters keep the same gateway runtime free.",
    sectionTransfers: "Pending billing transfers",
    transfersEmpty: "No pending transfers.",
    transferCancel: "Cancel transfer",
    usageDailyLabel: "Today's usage",
    usageMonthlyLabel: "This month's usage",
    usageUnlimited: "Unlimited",

    paybackTitle: "Pro payback check",
    paybackPaysThisWeek: "Pro can pay for itself this week",
    paybackPaysIn: "Pro pays back in about {days} days",
    paybackKeepProving: "Keep proving value before upgrading",
    paybackRunFirst: "Run traffic first, then upgrade",
    paybackBodyPrefix: "Your last 30 days show ",
    paybackBodyMid: " saved against asked models. ",
    paybackBodySuffix:
      "Upgrade only when that receipt is larger than the $29/month Pro fee.",
    paybackComparePlans: "Compare plans →",
    paybackSendFirst: "Send first request →",
    paybackEstimate: "Estimate savings",
    paybackLast30: "Last 30 days",
    paybackRoutedSuffix: " routed",
    paybackCacheSingular: " cache hit",
    paybackCachePlural: " cache hits",

    whyTitle: "Why teams pay for hosted",
    why1Title: "Proof before commitment.",
    why1Body:
      "The dashboard shows asked model, landed model, routing reason, actual cost, and estimated saved cost so you can verify value on your own traffic before upgrading.",
    why2Title: "You BYO provider keys.",
    why2Body:
      "Your OpenAI / Anthropic / etc. invoice goes directly to you. We never touch the money flow for tokens.",
    why3Title: "Flat $29 / $99 / $499 per month today.",
    why3Body:
      "Pro for individuals, Team for small eng orgs, Scale for heavy agent fleets + SSO. Predictable: no per-token markup, no per-request fee, no surprise overage bills. (Enterprise pricing is bilateral — see the card below.)",
    why4Title: "Same product, self-hostable for free.",
    why4Body:
      "The hosted fee covers KMS-backed BYO storage, Stripe billing, scheduled jobs, paid-plan background retraining, and us being on-call so you don't have to be.",
    why5Title: "Trust package included.",
    why5BodyPrefix: " ",
    why5BodyLink: "Security reviewers",
    why5BodySuffix:
      " can see BYO-key flow, KMS posture, request retention, DPA links, and the current reliability boundary in one place.",
    why6Title: "Monthly billing, cancel any time.",
    why6Body:
      "No refunds — instead the maximum you ever risk is one month's subscription for the period you actually used. Cancellation is instant via the Stripe customer portal. No clawbacks, no exit interview.",
    whyEstimateLink: "Estimate your savings →",

    notYetTitle: "Who should not pay yet",
    notYet1Title: "Under $50/mo spend?",
    notYet1BodyPrefix: "Use Free or ",
    notYet1BodyLink: "self-host",
    notYet1BodySuffix: ". The savings are probably noise.",
    notYet2Title: "Already all cheap models?",
    notYet2Body: "Prove cache/loop savings first; routing upside may be limited.",
    notYet3Title: "Need formal SLA/SOC 2 today?",
    notYet3BodyLink1: "Self-host",
    notYet3BodyMid: " or start a ",
    notYet3BodyLink2: "GitHub issue",
    notYet3BodySuffix: ". Hosted SLA is not formal yet.",
    notYet4Title: "Cannot BYO provider keys?",
    notYet4Body:
      "TokSuan is not a token reseller. Current hosted plans assume BYO.",

    roadmapTitle: "Pricing roadmap — not what you pay today",
    roadmapBodyPrefix:
      "Today, paid plans are flat monthly subscriptions. The planned Q3 2026 model is ",
    roadmapBodyCode: "max(floor, min(rate × monthly_savings, cap))",
    roadmapBodySuffix:
      " so lighter users pay less while heavy users never pay above the tier cap:",
    roadmapPro: "· Pro: max($9, min(10% × savings, $29))",
    roadmapTeam: "· Team: max($29, min(10% × savings, $99))",
    roadmapScale: "· Scale: max($99, min(12% × savings, $499))",
    roadmapScaleNote: " (12% rate captures heavier usage value)",
    roadmapAfterBody:
      "This is pre-announced so the incentives are clear, not because you need to reason through the formula before buying. Existing customers will see a side-by-side comparison against their actual usage before any switch.",
    roadmapTransitionFootnote:
      "Current billing remains flat-fee during the transition window.",

    reliabilityTitle: "Reliability & uptime",
    reliabilityBodyPrefix:
      "We don't offer a formal SLA today — we're a small team and writing 99.9% on a sales page when we can't honestly hit it would be dishonest. Internal target: <1h of TokSuan-attributable downtime per month. A public status page will go up alongside our public hosted launch; until then, incidents are communicated via direct email to affected accounts. Formal 99.5% SLA targeted Q4 2026 once multi-region lands. Full posture in our ",
    reliabilityBodyLink: "SECURITY.md",
    reliabilityBodySuffix: ".",

    checkoutSuccess:
      "Checkout complete. Your plan will activate within a few seconds once the webhook arrives.",
    checkoutCancelled: "Checkout cancelled. You can pick a plan again any time.",

    stripeMissingHosted:
      "Our payment provider is temporarily unreachable. Your current plan is unaffected and the gateway keeps serving requests as normal — checkout for upgrades or downgrades will be back shortly. If this persists, check the project's GitHub Discussions for updates.",
    stripeMissingSelfHostPrefix:
      "Billing isn't configured on this deployment. Set ",
    stripeMissingSelfHostSuffix: ", then reload.",

    transferTitleSender: "Transferring billing for {org}",
    transferTitleReceiver: "Take over billing for {org}",
    transferExpiresPrefix: "expires ",
    transferSenderBodyPrefix: "You asked to hand off Stripe billing for ",
    transferSenderBodyMid: " to ",
    transferSenderBodySuffix:
      ". Your current subscription stays active — do NOT cancel it yet. The moment they start their own subscription through Stripe Checkout, our webhook will auto-cancel yours.",
    transferSenderHeadsUp: "Heads-up:",
    transferSenderExpireSuffix:
      ", this intent quietly expires and your subscription keeps charging. If you still want to hand off after that, cancel manually in the Stripe customer portal below or open a new transfer from the organization page.",
    transferReceiverBodyPrefix: "",
    transferReceiverBodyMid: " wants you to take over the subscription paying for ",
    transferReceiverBodySuffix:
      ". Start your own subscription for the appropriate tier below; the moment Stripe confirms your payment, our webhook auto-cancels theirs — no gap, no double-charge.",
    transferCancelButton: "Cancel this transfer",

    currentPlanH3: "Current plan",
    currentPlanPriceSuffix: "/month",
    currentPlanLimitsLabel: "Limits: ",
    usageDailyMeterLabel: "Today (rolling 24h)",
    usageMonthlyMeterLabel: "This month (rolling 30d)",
    usageMonthlyDenomSuffix: " req",
    usageNearCapBody:
      "Over 80% of at least one cap. New requests at the cap return HTTP 402 plan_limit_exceeded (Payment Required) until the rolling window rolls over — upgrade below for headroom.",
    manageSubscriptionBtn: "Manage subscription",

    plansHeading: "Plans",
    plansFreeForever: "Free forever",
    plansAnnualSuffix: "/mo annual (save 17%)",
    plansBucketSeparator: " · ",
    plansCurrentPill: "Current",
    plansCurrentPlanBtn: "Current plan",
    plansUpgradeBtn: "Upgrade to {plan}",
    plansFreeYouAreHere: "You're here",
    plansDowngradeViaPortal: "Downgrade via portal",
    plansBillingNotConfigured: "Billing not configured",
    plansEnterprisePricing: "Custom pricing",
    plansEnterpriseBilateral: "Bilateral negotiation",
    plansEnterpriseContact: "Contact sales",
    planCards: {
      freeTagline: "Evaluate end-to-end. Not for production.",
      freeFeatures: [
        "$1/day OR 10,000 requests/month (whichever first)",
        "Unlimited projects + API keys",
        "Savings receipts on real traffic",
        "Budget enforcement + loop detection + semantic router",
        "Shipped baseline policy (no per-workload learning)",
        "Self-host unrestricted (Apache 2.0) — run nightly retrain yourself",
      ],
      proTagline: "Real workloads. Weekly proof, zero ops.",
      proFeatures: [
        "$500/day + 1M requests/month",
        "Everything in Free",
        "Weekly value report: saved $, top downgrades, quality proof",
        "Background-trained routing policy (nightly, per-project)",
        "Judge LLM cost included — your routing gets smarter as you use it",
        "Hosted scheduled jobs + provider/pricing maintenance",
        "Email support",
      ],
      teamTagline: "Production agents, multiple projects.",
      teamFeatures: [
        "Unlimited tracked spend + unlimited requests",
        "Everything in Pro",
        "Per-project policy versioning + rollback",
        "Per-tag policy isolation (one project, multiple workloads)",
        "Audit log CSV export (compliance)",
        "Multi-seat orgs + RBAC (admin / member / viewer)",
        "Up to 5 seats per org",
        "Slack / WeChat support channel",
      ],
      scaleTagline: "Heavy agent fleets, mid-market eng orgs.",
      scaleFeatures: [
        "Unlimited tracked spend + unlimited requests",
        "Everything in Team",
        "Unlimited seats per org + RBAC",
        "SSO / SAML 2.0 (Okta, Azure AD, Google Workspace, etc.)",
        "Security-review friendly trust package",
        "Priority Slack support channel (4h business-hour response)",
        "Multi-region failover endpoint (planned, target Q1 2027)",
      ],
      enterpriseName: "Enterprise",
      enterpriseTagline: "Regulated industries, dedicated infra, custom SLA.",
      enterpriseFeatures: [
        "Everything in Scale",
        "Dedicated single-tenant deployment (your VPC or ours)",
        "BAA / DPA / custom security review",
        "Custom SLA (99.9% available with multi-region)",
        "Named technical contact + quarterly reviews",
        "Custom pricing — typically $1k+ / month",
      ],
    },

    discountsBodyPrefix:
      "Discounts available: 17% off on annual billing (shown above each tier). Free Pro for verified students, OSS maintainers, and 50% off Year 1 for early-stage startups (<$1M raised). Open a ",
    discountsBodyLink: "GitHub issue",
    discountsBodySuffix: " to request one.",
    cancellationsBody:
      "Downgrades and cancellations happen in the Stripe customer portal. They take effect at the end of your current billing period.",

    limitUnlimited: "Unlimited",
    limitDailyTpl: "${n}/day",
    limitMonthlyTpl: "{n} req/mo",
  },

  organization: {
    tagline:
      "Solo users can skip this — your projects and budgets work fine as a single user. This page is for sharing one TokSuan account with teammates: shared projects, roll-up spend across the team, and role-based access (owner / admin / member / viewer).",
    dbErrTitle: "Database not reachable.",
    pendingTitle: "Pending invitations",
    invitedByPrefix: "invited by ",
    invitedByExpires: " · expires ",
    acceptBtn: "Accept",
    yourTeamsTitle: "Your teams",
    teamsCountSingular: " team",
    teamsCountPlural: " teams",
    emptyTitle: "You're not in any team yet.",
    emptyBody1:
      "Personal projects keep working — teams are for sharing access with teammates. The ",
    emptyBody2: " plan and above include multi-seat support.",
    colName: "Name",
    colRole: "Role",
    colMembers: "Members",
    colJoined: "Joined",
    createTitle: "Create a new team",
    createOwnerNote: "You become the owner",
    createPlanRequiredSuffix: " plan required",
    createNamePlaceholder: "Acme Corp",
    createBtn: "Create team",
    createGatedBodyPrefix: "Hosting a multi-seat team is a ",
    createGatedBodyMid: " plan feature. You're currently on ",
    createGatedBodyPlanLink: "/billing",
    createGatedBodySuffix:
      ". Upgrade there to create one — or accept an existing invitation above to join someone else's team (that path has no plan requirement).",
  },

  referrals: {
    taglinePrefix: "Invite people to TokSuan. We pay you ",
    taglineCommission: "20% commission",
    taglineMid:
      " on every monthly invoice they pay — for their first 12 months. Up to ",
    taglineAnnualCap: "$1,197/year",
    taglineSuffix:
      " per Scale referee. Credits are applied directly to your Stripe balance, no payouts to set up.",
    dbErrTitle: "Database not reachable.",
    linkTitle: "Your referral link",
    linkEmptyBody:
      "You don't have a referral code yet. Generate one and we'll give you a personalized link to share.",
    linkGenerateBtn: "Generate my referral code",
    linkYourCode: "Your code:",
    linkShareHelp:
      "Share this link anywhere — Twitter, email signature, your blog. When someone signs up via the link and pays a monthly invoice, we record a 20% commission on your account. Credits land below as \"pending\" and are applied to the referrer's Stripe balance by the daily 04:30 UTC settle cron.",
    statSignedUp: "Referees signed up",
    statSignedUpPayingSuffix: " paying",
    statTotalEarned: "Total earned (lifetime)",
    statPending: "Pending (not yet credited)",
    statPendingSubLabel: "credited daily 04:30 UTC",
    referredByPrefix: "You were referred by ",
    referredBySuffix:
      ". They earn 20% on every TokSuan invoice you pay for the first 12 months — pricing for you is unchanged.",
    historyTitle: "Credit history",
    historyRowsSingular: " row",
    historyRowsPlural: " rows",
    historyEmptyTitle: "No credits yet.",
    historyEmptyBody:
      " Once someone you referred pays a monthly invoice, the commission row will land here.",
    historyTipPrefix: "Tip: the URL anyone clicks needs to be ",
    historyTipPlaceholder: "?ref=YOUR_CODE",
    historyTipSuffix:
      " on its way into the dashboard. Middleware drops a 30-day cookie so the attribution sticks even if they wander before signing up.",
    historyColDate: "Date",
    historyColReferee: "Referee",
    historyColInvoice: "Their invoice",
    historyColCommission: "Your commission",
    historyColStatus: "Status",
    historyStatusCredited: "✓ credited",
    historyStatusPending: "pending",
    historyStatusCreditedTooltip: "Credited via Stripe",
    historyStatusPendingTooltip:
      "Applied at the next daily 04:30 UTC settle cron (operators can also run it manually)",
    rulesTitle: "Program rules (the boring stuff)",
    rule1Prefix: "Commission rate is ",
    rule1Commission: "20%",
    rule1Suffix: " of the referee's invoice subtotal (pre-tax, pre-discount).",
    rule2Prefix: "Capped at the referee's ",
    rule2Cap: "first 12 paid invoices",
    rule2Suffix: " — typically 12 months on a monthly subscription.",
    rule3:
      "Credits land on your Stripe customer balance and are automatically applied against your next TokSuan invoice. They don't expire.",
    rule4:
      "First-touch attribution: once the cookie is set, a later visit with a different ?ref=… link won't overwrite it.",
    rule5:
      "No self-referrals: the referrer and referee must be different users.",
    rule6:
      "We reserve the right to claw back credits for refunds, chargebacks, or abuse (fake signups, etc.). All settled rows are auditable in the Stripe customer-balance log on both ends.",
  },

  inviteAccept: {
    pageTitle: "Invitation",
    notFoundTitle: "Invitation not found.",
    notFoundBody:
      "The link may have been revoked or never existed. Ask the person who invited you to send a fresh invitation.",
    backToOrgs: "Back to organizations",
    alreadyAcceptedTitle: "Invitation already accepted",
    alreadyAcceptedBodyPrefix: "You've already joined ",
    alreadyAcceptedBodySuffix: ".",
    openOrgBtn: "Open organization",
    expiredTitle: "Invitation expired",
    expiredBodyTpl:
      "This invitation expired on {date}. Ask the person who invited you to send a fresh one.",
    joinTitleTpl: "Join {org}",
    introBodyPrefix: "You've been invited to ",
    introBodyMid: " as ",
    introBodySuffix:
      ". Accepting gives this account access to every project the organization owns, with the permissions of that role.",
    rowInvitedLabel: "Invited:",
    rowSignedInLabel: "Signed in as:",
    rowInvitedByLabel: "Invited by:",
    emailMismatchTitle: "Email mismatch.",
    emailMismatchBodyPrefix: "You signed in as ",
    emailMismatchBodyMid: " but the invitation was sent to ",
    emailMismatchBodySuffix:
      ". Sign out and sign in with the invited email, then re-open this link.",
    acceptBtn: "Accept invitation",
  },

  organizationDetail: {
    backToList: "← All organizations",
    yourRoleLabel: "Your role:",
    cantManageNote: "(you can view but not invite or change roles)",

    membersTitle: "Members",
    membersActiveSuffix: " active",
    membersPendingSuffix: " pending",
    membersSeatsTpl: "{used}/{cap} seats ({plan})",
    memberColEmail: "Email",
    memberColRole: "Role",
    memberColJoined: "Joined",
    memberSelfBadge: "(you)",
    memberSaveRoleBtn: "Save",
    memberRemoveBtn: "Remove",

    invitesTitle: "Pending invitations",
    invitesPendingSuffix: " pending",
    invitesEmpty:
      "No outstanding invitations. Use the form below to invite someone.",
    inviteColEmail: "Email",
    inviteColRole: "Role",
    inviteColInvitedBy: "Invited by",
    inviteColExpires: "Expires",
    inviteResendBtn: "Resend",
    inviteResendTooltip:
      "Re-send with the same token + bump expiry +14d. The original accept link still works.",
    inviteRevokeBtn: "Revoke",

    inviteFormTitle: "Invite a new member",
    inviteFormSeatLimitPill: "seat limit reached",
    inviteFormSeatLimitBodyPrefix: "This organization is on the ",
    inviteFormSeatLimitBodyMid:
      " plan, capped at ",
    inviteFormSeatLimitBodySuffix:
      " total seats (members + pending invites). Upgrade the org owner's plan at ",
    inviteFormBillingLink: "/billing",
    inviteFormEmailPlaceholder: "teammate@company.com",
    inviteFormSendBtn: "Send invite",
    inviteFormRolesHelpPrefix: "Roles",
    inviteFormRolesHelpAdminBody: "can invite + change roles.",
    inviteFormRolesHelpMemberBody:
      "can mutate per-project resources (budgets, routing, alerts, prompt templates).",
    inviteFormRolesHelpViewerBody: "is read-only across the org.",
    inviteFormRolesHelpOwnerHint:
      "Only the current owner can transfer ownership (see the \"Transfer ownership\" card below if you're the owner).",
    inviteFormDeliveryHelpPrefix: "Invitation delivery",
    inviteFormDeliveryHelpSuffix:
      ": we send via Resend when RESEND_API_KEY is configured; the accept link is also printed to the dashboard stdout so dev installs work without email.",

    ssoTitle: "Single sign-on (SAML 2.0)",
    ssoModeLabel: "mode:",
    ssoPlanRequiredSuffix: " plan required",
    ssoPlanGatedBodyPrefix: "SAML 2.0 single sign-on is a ",
    ssoPlanGatedBodyMid1: " plan feature. This organization is on the ",
    ssoPlanGatedBodyMid2:
      " plan — upgrade the org owner's plan to configure IdP-side SSO (Okta, Azure AD, Google Workspace, etc.).",
    ssoPlanGatedBodyDocsPrefix: " Integration guide: ",
    ssoPlanGatedBodyDocsLinkText: "docs/integrations/sso-okta.md",
    ssoPlanGatedBodyDocsSuffix: ".",
    ssoReadOnlyPrefix: "SAML SSO is ",
    ssoReadOnlyDomainSuffix: " for this organization",
    ssoReadOnlyAdminNote: ". Only admins can change these settings.",

    ssoIdpHelpBody:
      "IdP-side configuration: paste these two URLs into your IdP SAML application.",
    ssoAcsLabel: "ACS / Reply URL:",
    ssoEntityIdLabel: "Entity ID / SP Metadata:",
    ssoEnforcementLabel: "Enforcement mode",
    ssoEnforcementOff: "off (disabled)",
    ssoEnforcementOptional: "optional (SSO available, OTP still works)",
    ssoEnforcementRequired:
      "required (matched-domain users MUST use SSO)",
    ssoEmailDomainLabel: "Email domain",
    ssoEmailDomainPlaceholder: "acme.com",
    ssoJitDefaultRoleLabel: "JIT default role",
    ssoMetadataXmlLabel:
      "IdP metadata XML (preferred — paste from IdP's \"federation metadata\" export)",
    ssoMetadataXmlPlaceholder:
      "<EntityDescriptor xmlns=\"urn:oasis:names:tc:SAML:2.0:metadata\">...</EntityDescriptor>",
    ssoManualToggleLabel:
      "Or enter IdP fields manually (when no metadata XML is available)",
    ssoIdpEntityIdLabel: "IdP entity ID",
    ssoIdpEntityIdPlaceholder: "https://idp.example.com/saml2",
    ssoIdpSsoUrlLabel: "IdP SSO URL (HTTP-Redirect)",
    ssoIdpSsoUrlPlaceholder: "https://idp.example.com/saml2/sso",
    ssoIdpCertLabel: "IdP signing certificate (PEM or base64)",
    ssoSaveBtn: "Save SSO settings",
    ssoTestLoginBtn: "Test login →",
    ssoReferenceTitle: "Reference IdPs",
    ssoReferenceBodyPrefix:
      " — Okta, Azure AD / Entra, Google Workspace, JumpCloud, OneLogin, Auth0 all support SAML 2.0 with metadata XML export. Tested against ",
    ssoReferenceBodyLinkText: "samltest.id",
    ssoReferenceBodySuffix:
      " for end-to-end validation. JIT provisioning creates users + adds them to this org at the default role on first login. Set required to block OTP fallback for matching emails (recommended for Scale-tier customers with strict identity policies).",

    transferTitle: "Transfer ownership",
    transferOwnerOnlyPill: "owner only",
    transferBodyPrefix: "Hand the ",
    transferBodyMid1: " role to another member. You drop to ",
    transferBodyMid2:
      " in the same move. The Stripe subscription paying for this org stays on ",
    transferBodyMid3:
      " account — if the new owner should also pay, they'll need to start their own subscription at ",
    transferBillingLink: "/billing",
    transferBodySuffix:
      " and you can cancel yours after verifying their payment lands. To confirm, type this organization's exact name: ",
    transferConfirmCodeWord: "owner",
    transferSelectPlaceholder: "Select new owner…",
    transferConfirmPlaceholderTpl: "type \"{name}\"",
    transferSubmitBtn: "Transfer",
    transferBillingLabel: "Also transfer billing responsibility",
    transferBillingBodyPrefix:
      " (opt-in). Creates a pending intent that appears on both of our ",
    transferBillingBodyMid:
      " pages. The new owner starts their own subscription; once Stripe confirms, ",
    transferBillingBodySuffix:
      " subscription is auto-cancelled via webhook. Unchecked (default) = your subscription keeps paying until you cancel it manually — the usual safe posture.",
  },

  audit: {
    tagline:
      "Every consequential action on your account, append-only. Useful for compliance, post-incident reviews, and figuring out why a key just stopped working.",
    scopeLabel: "Scope:",
    scopePersonal: "My actions",
    scopeOrgTitleTpl: "Every member's events in {name} ({role})",
    scopeOrgSuffix: "org-wide",
    dbErrTitle: "Database not reachable.",
    recentTitle: "Recent events",
    eventSingular: "event",
    eventPlural: "events",
    filteredSuffix: " (filtered)",
    exportCsvBtn: "Export CSV",
    exportCsvTitle: "Download matching events as CSV (up to 50,000).",
    exportJsonBtn: "Export JSON",
    exportJsonTitle:
      "Download matching events as NDJSON — one event per line, SIEM-ingestion friendly.",
    exportGatedBtnTpl: "Export ({plan}+)",
    exportGatedTitleTpl:
      "Export requires the {plan} plan. Click to view billing.",
    filterEventLabel: "Event category",
    filterAllEvents: "All events",
    filterSinceLabel: "From (UTC)",
    filterUntilLabel: "Until (UTC)",
    filterApplyBtn: "Apply",
    filterClearBtn: "Clear",
    emptyBody:
      "No events yet. Sign out and back in, create a project, or change your plan to populate this view.",
    colTime: "Time",
    colEvent: "Event",
    colProject: "Project",
    colTarget: "Target",
    colDetails: "Details",
    ipPrefix: "ip",
  },

  promptTemplates: {
    title: "Prompt templates",
    tagline:
      "Save your system prompts as named, versioned templates. One row per template; every save creates a new version row. Roll back without losing experiments.",
    dbErrTitle: "Database not reachable.",

    yourTitle: "Your templates",
    countSingular: " template",
    countPlural: " templates",
    emptyTitle: "No templates yet.",
    emptyBodyPrefix:
      " Use the form below to create your first one. A typical name is ",
    emptyBodyMid: " or ",
    emptyBodySuffix:
      " — keep it URL-safe, you'll reference it by header later.",
    colName: "Name",
    colActiveVersion: "Active version",
    colVersions: "Versions",
    colUpdated: "Updated",
    openBtn: "Open",

    formTitle: "Create or append a version",
    formReusing: "Reusing a name appends a new version",
    formNameLabel: "Template name",
    formNamePlaceholder: "code-reviewer",
    formDescriptionLabel: "Description (optional)",
    formDescriptionPlaceholder: "What this template is for",
    formBodyLabel: "Body (the prompt itself)",
    formBodyPlaceholder:
      "You are an expert code reviewer.\n\nReview the following code and return STRICT JSON of the form {issues: [...]}\n\n```\n{{code}}\n```",
    formNoteLabel: "Change note (optional — shows up in version history)",
    formNotePlaceholder: "e.g. tightened JSON schema requirement",
    formSaveBtn: "Save version",
    formSyntaxHintPrefix: "Templating syntax",
    formSyntaxHintSuffix:
      ": Handlebars-style {{variable}} placeholders. Server-side substitution by the gateway is live.",

    runtimeTitle: "Use a template at runtime",
    runtimeHeaderHint: "x-ts-template request header",
    runtimeBody:
      "Reference any template by name; the gateway loads its current version, substitutes {{vars}}, and prepends the result as a system message before forwarding to your provider.",
    runtimeBullet1Prefix: "Pin a specific version with ",
    runtimeBullet1Mid:
      "; omit the suffix to track the active version (currently ",
    runtimeBullet1Suffix: ").",
    runtimeBullet2Prefix: "Variables can come from the body ",
    runtimeBullet2Mid: " field (preferred for large values) or from a JSON-encoded ",
    runtimeBullet2Suffix:
      " header (latter wins on key collision).",
    runtimeBullet3:
      "Unknown placeholders are left literal — easy to spot in the first response. Existing system messages are replaced; otherwise a new one is prepended.",
    runtimeBullet4Prefix:
      "Each request rendered through a template is auto-tagged ",
    runtimeBullet4Mid: " + ",
    runtimeBullet4Suffix:
      ", so the dashboard's Spend by tag card breaks out cost per template version.",
    runtimeTagBy: "Spend by tag",

    detailBackBtn: "← All templates",
    detailVersionsCountSingular: " version",
    detailVersionsCountPlural: " versions",
    detailActiveVersionTpl: "Active version (v{n})",
    detailCopyBodyLabel: "Copy body",
    detailEmptyBody: "(empty)",
    detailAppendTitle: "Append new version",
    detailAppendNextVersionTpl: "Will be v{n}",
    detailAppendSubmitTpl: "Save as v{n}",
    detailAppendNotePlaceholder:
      "Change note (e.g. tightened JSON requirement)",
    detailHistoryTitle: "Version history",
    detailHistoryNewestFirst: "newest first",
    detailHistoryEmpty: "No versions yet.",
    detailHistoryActivePill: "active",
    detailHistoryByPrefix: "by ",
    detailHistoryPinTitle:
      "Pin this version as active (rolls back without deleting newer versions)",
    detailHistoryPinBtn: "Pin as active",
    detailDangerTitle: "Delete template",
    detailDangerBody:
      "Removes the template + every version. Cannot be undone. Existing requests that referenced this template by name will fail to resolve (the gateway returns a 400 with a hint).",
    detailDeleteSubmitTpl: "Delete {name} permanently",
  },

  routingPolicy: {
    title: "Routing policy",
    tagline:
      "TokSuan starts with a public cost-quality frontier, then learns from this project's real requests and shadow trials. The active policy is what the gateway routes against right now; older versions stay around for rollback and audit.",
    activeTitle: "Currently active",
    pauseLearningBtn: "Pause learning",
    resumeLearningBtn: "Resume learning",
    pauseTooltip:
      "Pause nightly retraining for this project. The current active policy keeps serving.",
    resumeTooltip: "Resume nightly retraining.",
    upgradeRequiredTooltipTpl:
      "Background training requires the {plan} plan.",
    activeStatusTpl: "activated {date} · trained on {n} {noun}",
    activeSampleSingular: "sample",
    activeSamplePlural: "samples",
    learningStatusPrefix: "Learning is ",
    learningStatusOn: "ON",
    learningStatusOff: "PAUSED",
    learningOnNote:
      "Tonight's cron will retrain this project from recent requests and shadow A/B, so routing gets more specific to this agent.",
    learningPausedNote:
      "The active policy stays frozen — no nightly retraining runs.",
    noActiveBodyPrefix:
      "No per-project policy yet — gateway is using the shipped frontier baseline. To generate a custom v1, you need two things:",
    noActiveStep1Prefix: "A shadow A/B rule so we have observations to train on. Set one up on the ",
    noActiveStep1Link: "Routing rules",
    noActiveStep1Mid: " card with mode ",
    noActiveStep1Mode1: "shadow",
    noActiveStep1Or: " or ",
    noActiveStep1Mode2: "both",
    noActiveStep1Sample: " and a ",
    noActiveStep1ChipPrefix: "Sample",
    noActiveStep1ChipSuffix: " chip set to 5%. (Or via CLI: ",
    noActiveStep1CliPrefix: "bun run set-routing -- --mode shadow --sample-rate 0.05",
    noActiveStep1CliSuffix: ".)",
    noActiveStep2Prefix: "Wait for the next nightly cron (cloud) OR run ",
    noActiveStep2Mid: "bun run retrain-project -- --project ",
    noActiveStep2Suffix: " manually.",

    dbErrTitle: "Database not reachable.",
    historyTitle: "History",
    historyVersionsSingular: " version",
    historyVersionsPlural: " versions",
    historyEmpty:
      "No retrain history yet. The gateway is routing against the shipped baseline policy.",
    colVersion: "Version",
    colStatus: "Status",
    colSource: "Source",
    colSamples: "Samples",
    colNotes: "Notes",
    colGenerated: "Generated",
    rollbackBtnTpl: "Rollback to v{n}",
    rollbackTooltipReadyTpl:
      "Promote v{n} back to active. A new version will be created with source=rollback to keep the audit trail.",
    rollbackTooltipGatedTpl: "Rollback requires the {plan} plan.",

    howTitle: "How retraining works",
    howBody1:
      "Each night the cloud cron reads recent requests plus A/B shadow results for this project, blends them with the shipped multi-provider baseline policy (Bayesian-style — prior weight ≈ 20 samples), and inserts a new version. If sanity checks pass, the new version is promoted to active and the previous one drops to superseded.",
    howBody2Prefix: "Self-hosted users run the same job manually: ",
    howBody2Suffix: ". See docs/self-host-retrain.md.",

    costTitle: "Learning cost",
    costSubLabel: "shadow A/B upstream spend",
    costMtdLabel: "Month-to-date",
    costMtdShadowSingular: " shadow call",
    costMtdShadowPlural: " shadow calls",
    costTrailing30dLabel: "Trailing 30 days",
    costTrailing30dAvgPrefix: "avg ",
    costTrailing30dAvgSuffix: " / call",
    costSparklineTooltipTpl:
      "Daily shadow cost over the trailing 30 days (oldest → newest). Peak: {peak} on a single day.",
    costLastShadowLabel: "Last shadow",
    costLearningOn: "learning ON",
    costLearningPaused: "learning paused",
    costFooterPrefix:
      "Shadow A/B calls run alongside your normal traffic to give the nightly retrain comparable model evaluations. They use your own upstream provider keys and bill to your account. To dial the rate down, lower the rule's ",
    costFooterMid:
      " with bun run set-routing; to pause entirely, hit ",
    costFooterSuffix: " above.",
    costEmptyEnabledTitle: "No shadow A/B traffic yet.",
    costEmptyEnabledBody:
      " The nightly retrain needs A/B observations to learn from. Add a routing rule with mode shadow or both and a Sample chip set to 5%, so a small fraction of your traffic runs a parallel call to a candidate model that the aggregator can compare against.",
    costEmptyEnabledTipBody:
      "5% is usually enough to converge a bucket within a week without doubling your upstream bill. Use 100% for a calibration burst on a brand-new candidate model, then dial down once you have a few hundred samples.",
    costEmptyEnabledCliHint: "CLI alternative if you prefer:",
    costEmptyPausedTitle: "Learning is paused.",
    costEmptyPausedBody:
      " No shadow A/B observations will be collected and the nightly retrain won't run on this project. Resume learning above to start the loop.",

    toastLearningPaused:
      "Background learning paused for this project. The current active policy will keep serving; no nightly retrain will run.",
    toastLearningResumed:
      "Background learning resumed. The next nightly cron will retrain this project.",
    toastUpgradeRequiredPrefix: "Background policy training is a paid feature. ",
    toastUpgradeRequiredLink: "Upgrade to Pro+",
    toastUpgradeRequiredSuffix:
      " to unlock it. (You can keep the controls visible — they just don't fire on Free.)",
    toastRollbackCompleteTpl:
      "Rolled back to v{from} — promoted as v{to}. New routing is live within 60s on every gateway replica.",
    toastRollbackFailedTpl:
      "Rollback failed: {detail}. The previously active policy is unchanged.",
    toastRollbackFailedNoDetail: "(no detail)",
  },

  classifier: {
    title: "Embedding classifier",
    tagline:
      "Nightly-trained (task_type, complexity) classifier per project. Replaces the regex heuristic for routing decisions when both heads cross their calibrated confidence thresholds. Below-floor retrains are kept as rejected for forensics; the prior active row keeps serving.",
    dbErrTitle: "Query failed",
    dbErrHint:
      "Most common cause: migration 026 (project_embedding_classifiers) hasn't run yet. Restart the gateway — the auto-migrator picks up pending files at boot.",
    activeTitle: "Currently active",
    activeNoVersionPill: "no per-project classifier yet",
    pauseTrainingBtn: "Pause training",
    resumeTrainingBtn: "Resume training",
    trainingOnNote:
      "Tonight's nightly retrain will produce a new classifier version.",
    trainingPausedNote: "Paused — no new versions until you resume.",
    trainingRequiresPrefix: " Requires ",
    trainingRequiresSuffix: " or higher.",
    tileTaskTypeAcc: "task_type accuracy",
    tileComplexityAcc: "complexity accuracy",
    tileTrainedOn: "trained on",
    tileTrainedOnRowsTpl: "{n} rows",
    tileActivated: "activated",
    tileRejected30d: "rejected (30d)",

    emptyActiveBody:
      "No per-project classifier for this project yet. Routing currently uses the global classifier (if one is loaded) or the regex heuristic.",
    emptyActiveHasHistory:
      "Previous versions below were all marked rejected by the quality floor OR superseded without ever activating. Accumulate more traffic and wait for the next nightly retrain.",
    emptyActiveUpgradePrefix: "",
    emptyActiveUpgradeLinkPrefix: "Upgrade to ",
    emptyActiveUpgradeLinkSuffix: "",
    emptyActiveUpgradeSuffix:
      " to enable nightly per-project classifier training.",
    emptyActiveResumeMsg:
      "Resume training above, then wait for the next nightly retrain (03:00 UTC) — or trigger one manually with bun run train-embedding-classifier -- --project ….",
    emptyActiveLearningOnMsg:
      "Learning is on. Either the project needs more traffic (≥50 rows in the lookback window) OR the quality floor rejected recent retrains. Inspect the history table below for reasons.",

    perClassTitle: "Per-class metrics (active version)",
    perClassBodyTpl:
      "Precision / recall / support on the held-out validation set ({n} examples). Low recall for a specific class means the classifier under-predicts that class at runtime and those requests silently fall back to the heuristic.",
    perClassTaskTypeHead: "task_type head",
    perClassComplexityHead: "complexity head",
    perClassEmpty:
      "No per-class metrics in this artifact (pre-v0.6.1 training run).",
    perClassColClass: "class",
    perClassColPrecision: "precision",
    perClassColRecall: "recall",
    perClassColSupport: "support",

    historyTitle: "History",
    historyEmptyPrefix:
      "No classifier versions yet. Enable learning above and wait for the next nightly retrain — or trigger one manually with ",
    historyEmptySuffix: ".",
    colV: "v",
    colStatus: "status",
    colSource: "source",
    colTaskTypeAcc: "task_type acc",
    colComplexityAcc: "complexity acc",
    colSamples: "samples",
    colGenerated: "generated",
    colNotes: "notes",
    rollbackBtn: "Rollback",
    rollbackTooltipReadyTpl: "Roll back to v{n}",
    rollbackTooltipGated: "Rollback requires a paid plan",

    toastLearningResumed: "Classifier training resumed for this project.",
    toastLearningPaused:
      "Classifier training paused. Existing active version keeps serving.",
    toastUpgradeRequiredPrefix:
      "Upgrade required to enable per-project training. ",
    toastUpgradeRequiredLink: "View plans",
    toastUpgradeRequiredSuffix: ".",
    toastRollbackCompleteTpl:
      "Rolled back: v{from} re-promoted as v{to}. Live gateways reloaded via pg_notify.",
    toastRollbackFailedTpl: "Rollback failed: {detail}",
    toastRollbackFailedNoDetail: "unknown error",
  },

  errors: {
    notFoundTitle: "Page not found",
    notFoundBodyPrefix:
      "The URL you followed doesn't exist here. If you got here from a link inside the app, the resource was probably deleted (a project, a request row, an invitation). If you got here from an external link and think it should work, open a ",
    notFoundBodyLink: "GitHub issue",
    notFoundBodySuffix: ".",
    notFoundBackBtn: "Back to dashboard",
    notFoundEstimatorBtn: "Savings estimator",
  },

  forms: {
    budget: {
      presetsLabel: "Presets",
      presetDailyTpl: "${usd}/day",
      presetMonthlyTpl: "${usd}/month",
      periodDaily: "Daily",
      periodMonthly: "Monthly",
      limitPlaceholder: "limit in USD, e.g. 5.00",
      enabledLabel: "on",
      saveBtn: "Save budget",
      updateBtn: "Update",
      cancelBtn: "Cancel",
      savedPill: "✓ Saved",
      previewMonthlyEquiv: "≈ {amount}/month",
      previewDailyEquivAvg: "≈ {amount}/day average",
      previewNoTraffic24h: "No recent traffic — this caps brand-new usage.",
      previewNoTraffic30d: "No traffic in the last 30 days — pure forward-looking cap.",
      previewPast24hLine: "Past 24h spend: {spent} ({pct}% of this cap)",
      previewPast30dLine: "Past 30d spend: {spent} ({pct}% of this cap)",
      previewPast7dSuffix: " · 7d: {spent}",
      previewWarn24hOver:
        "Last 24h exceeded this cap — new requests would have been blocked.",
      previewWarn24hHigh:
        "Last 24h was above 80% of this cap — set higher if normal.",
      previewWarn30dOver: "Last 30d already exceeded this cap.",
      previewWarn30dHigh: "Last 30d was above 80% of this cap.",
      previewSubCentHint:
        "Sub-cent budgets work — useful for demo / dev projects.",
      previewEnterAmount: "Enter a positive USD amount.",
      rowEditBtn: "Edit",
      rowDeleteBtn: "Delete",
      rowEnabledPill: "enabled",
      rowDisabledPill: "disabled",
      rowEditTitle: "Click to edit",
      forecastTodayLabel: "today",
      forecastMonthLabel: "this month",
      forecastEtaMinutes:
        "at current rate, ETA {n}m before {periodLabel}'s budget is exhausted",
      forecastEtaHours:
        "at current rate, ETA {n}h before {periodLabel}'s budget is exhausted",
      forecastEtaDays:
        "at current rate, ETA {n}d before {periodLabel}'s budget is exhausted",
    },

    routing: {
      presetsLabel: "Presets",
      preset1Label: "Downgrade simple GPT calls",
      preset1Desc:
        "Send GPT-4-class models to gpt-4o-mini when complexity is low.",
      preset2Label: "Downgrade simple Claude calls",
      preset2Desc:
        "Send sonnet-class Claude to haiku when complexity is low.",
      preset3Label: "A/B test DeepSeek vs your current model",
      preset3Desc:
        "Keep your current model live, run deepseek-chat in shadow on 5% of traffic for cost/quality comparison.",
      preset4Label: "Route everything simple to Qwen",
      preset4Desc:
        "Aggressive cost route — anything below complexity 0.5 goes to qwen3-next-80b.",
      whenAsks: "When request asks for",
      switchToRegex: "switch to regex",
      switchToModel: "switch to model picker",
      regexPlaceholder: "^gpt-(4|5).*",
      routeTo: "Route to",
      tierFrontier: "frontier",
      tierMid: "mid",
      tierCheap: "cheap",
      tierSuffix: " tier",
      thresholdLabel: "Fire when complexity ≤",
      landmarkExample1: "hi",
      landmarkExample2: "What time is it?",
      landmarkExample3: "Summarize this paragraph in 2 lines.",
      landmarkExample4: "Write a Python function that ...",
      landmarkExample5: "Refactor the authentication layer ...",
      landmarkExample6: "Design a distributed scheduler that ...",
      landmarkTooltipTpl: "Complexity ≈ {score}",
      modeLabel: "Mode",
      modeRouteTitle: "Route",
      modeShadowTitle: "Shadow",
      modeBothTitle: "Route + Shadow",
      modeRouteBodyPrefix: "Rewrite ",
      modeRouteBodySuffix:
        " to the cheaper one. The expensive one is never called.",
      modeShadowBody:
        "Don't rewrite. Run the cheaper model in PARALLEL and log the comparison. Useful for testing before committing.",
      modeBothBody:
        "Rewrite AND shadow the original. Verifies that your downgrade isn't losing quality.",
      shadowTargetLabel: "Shadow target",
      shadowTargetDefaultBoth: "(default: shadow the original model)",
      shadowTargetPick: "Pick a model to shadow…",
      sampleRateLabel: "Fire on",
      sampleRateAlwaysLabel: "Always",
      sampleRateAlwaysDesc: "Fire on every matching request.",
      sampleRate100Desc:
        "Calibration burst — fire on every match for a day or two, then dial down.",
      sampleRate10Desc: "Aggressive learning rate.",
      sampleRate5Desc: "Recommended steady-state for shadow / both modes.",
      sampleRate1Desc:
        "Drift-detection only — high-traffic projects with stable estimates.",
      sampleAlwaysExplain: "Rule fires on every matching request.",
      sampleAlwaysShadowExplainPrefix: " In ",
      sampleAlwaysShadowExplainSuffix:
        " mode that's a parallel call alongside every primary — it doubles your upstream bill on matched traffic. Pick a sub-100% rate to keep the shadow as a sampled trickle.",
      sampleAlwaysRouteExplain: " This is what you want for ROUTE rules.",
      sampleSubExplainPrefix: "Rule fires on a random ",
      sampleSubExplainOf: " of qualifying requests.",
      sampleSubExplainShadowSuffix:
        " Shadow A/B traffic stays at ~{pct}% of your matched volume — enough to feed the nightly retrain without doubling your upstream bill.",
      sampleSubExplainRouteSuffix:
        " Note: in ROUTE mode this means {pct}% of matching requests will run on the ORIGINAL model unchanged. Usually you want ROUTE to be Always.",
      previewLabel: "Past 7-day match preview",
      previewLoading: "computing…",
      previewEmpty:
        "No requests in the last 7 days matched this pattern. Rule still applies forward; you just have no historical evidence.",
      previewMatchedPrefix: "{n}",
      previewMatchedSingular: " request",
      previewMatchedPlural: " requests",
      previewMatchedSpentSuffix: " matched · {spent} spent",
      previewModelsHit: "Models hit:",
      previewThresholdHint:
        "Threshold ≤ {n} would actually rewrite the subset of these whose runtime complexity score falls below the cap. Use shadow mode first if you want to verify before committing.",
      previewUnavailable: "(preview unavailable)",
      enabledLabel: "enabled",
      saveBtn: "Save rule",
      updateBtn: "Update rule",
      cancelBtn: "Cancel",
      savedPill: "✓ Saved",
      rowEditBtn: "Edit",
      rowDeleteBtn: "Delete",
      rowEnabledPill: "enabled",
      rowDisabledPill: "disabled",
      rowEditTitle: "Click to edit this rule",
      rowSampleAlways: "always",
      rowSampleNever: "never",
      rowSampleAlwaysTooltip:
        "Fires on every matching request. Default behavior for pre-v0.5 rules.",
      rowSampleSubTooltip:
        "Fires on a random {label} of qualifying requests.",
    },

    alert: {
      notifyMeWhen: "Notify me when",
      channelWebhookLabel: "Post a message in Slack / Discord / 飞书",
      channelWebhookOptional: "(optional)",
      channelWebhookHelpPrefix:
        "Paste a bot-channel URL from your chat tool. To get one, search for ",
      channelWebhookHelpEmphasis: '"incoming webhook"',
      channelWebhookHelpSuffix:
        " in your chat tool's settings — Slack: Apps → Incoming Webhooks; Discord: Channel settings → Integrations → Webhooks; 飞书: group → Settings → Bots → Custom Bot. PagerDuty and any other URL that accepts JSON also work.",
      channelEmailLabel: "Email me at",
      channelEmailHelp:
        "We'll send a short plain-text email. Whether it actually ships or just logs depends on the gateway's email setup — see the notice below this form.",
      addBtn: "Add subscription",
      atLeastOneRule:
        "Fill at least one channel — you can fill both, they'll both fire.",
      savedPill: "✓ Saved",
    },

    quickBudget: {
      title:
        "You have no budget set yet — one runaway loop can burn $1000s before you notice.",
      capLabel: "Cap",
      onLabel: "on",
      enableBtn: "Enable budget",
      presetDailyTpl: "${usd}/day",
      presetMonthlyTpl: "${usd}/month",
    },

    alertEvents: {
      budgetExceeded: {
        title: "Spending hits a budget cap",
        desc: "Fires the moment a request would push the project's daily / weekly / monthly budget over the limit. The request is blocked at the same time.",
      },
      loopDetected: {
        title: "An agent gets stuck in a loop",
        desc: "Fires when the gateway sees the same request fingerprint repeat suspiciously fast — usually a misbehaving agent retrying itself. The repeating request is blocked.",
      },
      costAnomaly: {
        title: "Hourly spend spikes vs the usual",
        desc: "Fires when this project's spend in the last hour is statistically far above its 7-day baseline. 6-hour cooldown per project so one spike doesn't spam you.",
      },
      retrainFailed: {
        title: "The nightly model-policy retrain fails",
        desc: "Fires when the per-project routing-policy retrain (cron or self-host CLI) errors out. The current policy keeps serving — the alert just tells you tonight's run didn't refresh anything.",
      },
    },
  },

  errorBoundary: {
    title: "Something went wrong",
    bodyPrefix:
      "The dashboard hit an unhandled error rendering this page. Your data is safe — the gateway keeps forwarding requests, spend gets logged, budgets still enforce. Retry the page; if it reproduces, open a ",
    bodyLink: "GitHub issue",
    bodySuffix:
      " and quote the digest below so we can find your stack in the server logs.",
    digestLabel: "digest:",
    retryBtn: "Retry",
    backBtn: "Back to dashboard",
  },

  copyButton: {
    copyTooltip: "Copy to clipboard",
    copiedTooltip: "Copied",
    copyLabel: "copy",
    copiedLabel: "copied",
  },

  themeToggle: {
    switchToLight: "Switch to light mode",
    switchToDark: "Switch to dark mode",
  },

  toasts: {
    projectCreated: "Project “{arg}” created.",
    projectCreatedNoArg: "Project created.",
    projectDeleted: "Project “{arg}” deleted.",
    projectDeletedNoArg: "Project deleted.",
    keyCreated: "New API key generated.",
    keyNameRequired:
      "Name your API key first (e.g. cursor-demo) — we won't auto-create a 'default' key.",
    keyCreateFailed:
      "Couldn't create the API key. The database may need the latest migrations; retry after the gateway redeploy applies them.",
    keyCreatedNoReveal:
      "The API key was created, but the one-time reveal cookie could not be set. Delete it and create a fresh key so you can copy the secret.",
    keyDeleted: "API key deleted.",
    keyRotated:
      "Key rotated — copy the new one below. The old key stays valid for 24h so rolling deploys don't 401.",
    keyRotateNotFound:
      "Couldn't rotate — key not found or not in this project.",
    budgetSaved: "Budget saved.",
    budgetDeleted: "Budget removed.",
    budgetInvalid: "Budget limit must be a positive number.",
    routingSaved: "Routing rule saved.",
    routingDeleted: "Routing rule removed.",
    routingLocked:
      "Locked. Future requests for that model will route here automatically.",
    routingInvalid: "Routing rule needs both a from-pattern and a to-model.",
    routingBadRegex: "From-pattern must be a valid JavaScript regex.",
    testKeyOk: "Provider key works.",
    testKeyFail:
      "Provider key test failed — see Settings page for details.",
    alertTestOk: "Test alert dispatched ({arg}).",
    alertTestOkNoArg: "Test alert dispatched.",
    alertTestFailNoInternalToken:
      "Test alert failed: dashboard is missing TOKENSMART_INTERNAL_TOKEN, so it can't reach the gateway.",
    alertTestFailNoTarget:
      "Test alert failed: this rule has neither a webhook URL nor an email target.",
    alertTestFailWithReason: "Test alert failed: {arg}.",
    alertTestFailNoReason: "Test alert failed.",
    alertSaved: "Alert subscription saved.",
    alertDeleted: "Alert subscription removed.",
    alertNoTarget: "Provide at least one of webhook URL or email.",
    alertBadUrl: "Webhook URL must be a valid http(s) URL.",
    alertInvalid: "Unknown alert event type.",
    digestEnabled:
      "Subscribed. You'll get a weekly savings summary email once the operator wires `bun run send-weekly-savings` into a scheduler.",
    digestEnabledHosted:
      "Subscribed. You'll get a weekly savings summary email every Monday.",
    digestDisabled: "Unsubscribed from weekly digest.",
    providerKeySaved: "{arg} key saved.",
    providerKeySavedNoArg: "Provider key saved.",
    providerKeyDeleted: "Provider key removed.",
    providerKeyEncryptionMissing:
      "TOKENSMART_PROVIDER_KEY_ENCRYPTION is not set on this dashboard.",
    providerKeyInvalid: "Unknown provider.",
    providerKeyTooShort: "Provider key looks too short — paste the full secret.",
    providerKeyBadUrl: "Base URL override must be a valid http(s) URL.",
    referralCodeReady: "Your referral code is ready: {arg}",
    referralCodeReadyNoArg: "Referral code minted.",
    referralSettled: "Settle pass complete ({arg}).",
    referralSettledNoArg: "Pending credits settled.",
    referralSettleUnauth:
      "Only operators can run a settle pass (set TOKENSMART_OPS_EMAILS).",
    requestReplayQueued:
      "Replay queued against {arg}. New result will appear under Recent requests.",
    requestReplayQueuedNoArg:
      "Replay queued. New result will appear under Recent requests.",
    requestReplayFailedNoEnv:
      "Replay needs TOKENSMART_INTERNAL_REPLAY_ENABLED=1 and TOKENSMART_INTERNAL_TOKEN on both services.",
    requestReplayFailedWithReason: "Replay failed: {arg}",
    requestReplayFailedNoReason: "Replay failed.",
    templateSaved: "Prompt template saved.",
    templateDeleted: "Prompt template deleted.",
    templateBadInput: "Template name + body are both required.",
    orgCreated: "Organization \"{arg}\" created.",
    orgCreatedNoArg: "Organization created.",
    orgBadName: "Organization name is required.",
    orgBadRole: "Unknown role.",
    orgBadEmail: "Enter a valid email address.",
    orgNotAllowed: "Only owners and admins can manage members.",
    orgNotFound: "Organization not found.",
    orgInvited: "Invitation sent to {arg}.",
    orgInvitedNoArg: "Invitation sent.",
    orgInviteRevoked: "Invitation revoked.",
    orgInviteResent: "Invitation re-sent to {arg} (expires in 14 days).",
    orgInviteResentNoArg: "Invitation re-sent (expires in 14 days).",
    orgTransferComplete:
      "Ownership transferred. You're now an admin on this org.",
    orgTransferNotOwner: "Only the current owner can transfer ownership.",
    orgTransferBadSuccessor:
      "Designated successor is not a member of this organization.",
    orgTransferSameUser:
      "Successor must be a different user than the current owner.",
    orgTransferConfirmMismatch:
      "Type the organization's exact name to confirm the transfer.",
    accountDeleteConfirmMismatch:
      "Type DELETE (uppercase) in the confirm field to schedule deletion.",
    accountDeleteScheduled:
      "Account scheduled for deletion — 30-day grace period. Cancel any time from this page.",
    accountDeleteCancelled: "Account deletion cancelled. Welcome back.",
    accountDeleteOrgOwner:
      "Transfer ownership of \"{arg}\" first — deleting now would orphan the org.",
    accountDeleteOrgOwnerNoArg:
      "Transfer ownership of your organizations before deleting your account.",
    billingTransferCancelled: "Billing-transfer intent cancelled.",
    billingTransferCancelFailed:
      "Couldn't cancel — intent may already be completed or expired.",
    billingTransferCompleted:
      "Billing transferred — the old subscription has been cancelled.",
    orgRoleChanged: "Role updated.",
    orgMemberRemoved: "Member removed.",
    orgInviteBadToken:
      "Invitation is invalid, expired, or already accepted.",
    orgInviteEmailMismatch:
      "This invitation was sent to a different email. Sign in with that address to accept.",
    orgJoined: "Joined organization.",
    orgPlanRequired: "This feature requires the {arg} plan.",
    orgPlanRequiredNoArg: "This feature requires a higher plan.",
    orgSeatLimit:
      "Seat limit reached ({arg} seats). Upgrade the org owner's plan to invite more.",
    orgSeatLimitNoArg:
      "Seat limit reached. Upgrade the org owner's plan.",
    ssoSaved: "SSO settings saved.",
    ssoNoPermission: "Only owners and admins can change SSO settings.",
    ssoBadMode: "Pick a valid SSO mode (off / optional / required).",
    ssoBadDefaultRole: "Pick a valid default role (admin / member / viewer).",
    ssoBadDomain: "Email domain looks invalid (use a bare domain like acme.com).",
    ssoIncomplete:
      "Provide either an IdP metadata XML or all three manual fields (entity ID, SSO URL, certificate) before enabling SSO.",
    actionViewPlans: "View plans",
  },

  estimator: {
    modeQuick: "Quick estimate",
    modeCsv: "Upload usage CSV",

    workloadAgentLabel: "Heavy agent (Cline / LangGraph / autonomous loops)",
    workloadAgentExplainer:
      "Agent traffic is the best fit because repeated planning/tool loops create routing, loop-prevention, and context-compression opportunities. The high end requires real traffic proof, not just the quick estimate.",
    workloadIdeLabel: "IDE assistant (Cursor / Continue / Copilot-style)",
    workloadIdeExplainer:
      "IDE traffic often has many short prompts that can route down, plus repeated tool output, diffs, and stack traces that can compress. The exact gain depends on how much already uses cheap models.",
    workloadChatLabel: "Chat / customer support",
    workloadChatExplainer:
      "Mixed complexity makes routing more conservative. Long system prompts and repeated context can still unlock cache savings, especially on Anthropic.",
    workloadMixedLabel: "Mixed workload",
    workloadMixedExplainer:
      "A cautious planning range for production stacks. The real number depends on frontier-model share, prompt repetition, and whether shadow tests prove safe downgrades.",

    quickTitle: "Tell us about your workload",
    quickSpendLabel: "Monthly LLM spend (USD, all providers combined)",
    quickSpendPerMonth: "/ month",
    quickSpendHintPrefix:
      "Look at your last OpenAI / Anthropic invoice. Roughly is fine.",
    quickSpendHintEmphasis:
      "Or switch to “Upload usage CSV” above for a precise number.",
    quickWorkloadPrompt: "What kind of workload?",
    quickPlanningRangePrefix: "planning range ",
    quickPlanningRangeSuffix: "%",

    csvTitle: "Upload your usage CSV",
    csvIntroPrefix:
      "Export from your provider, paste or upload here. Parsed entirely in your browser — ",
    csvIntroEmphasis: "nothing is uploaded to TokSuan's servers",
    csvIntroSuffix: ". Where to get the export:",
    csvSourceOpenAI: " → \"Export\"",
    csvSourceAnthropic: " → \"Export usage\"",
    csvSourceOpenRouter: " → CSV export",
    csvSourceDeepSeekSuffix:
      " → pick a month → \"Export\" (downloads a ZIP with two CSVs; use the `amount` file)",
    csvSourceQwenSuffix:
      " → 商品名筛选 \"大模型服务平台百炼\" → 右上角 \"导出\"",
    csvSourceDoubaoSuffix:
      " → 筛选豆包 / 方舟相关产品 → \"导出账单\"",
    csvSourceGoogleSuffix:
      " for the dashboard view, or Google Cloud Billing → Reports → Export if you call Gemini through Vertex AI. Native CSV export from AI Studio is still rolling out — for now you may need to copy the table into a spreadsheet manually.",
    csvSourceColumnsHint:
      "We need columns named like `model` and `cost` / `cost_usd`. Other columns are ignored. Custom CSVs work too as long as those two are present — including the Chinese exports (rename `模型` → `model` and `应付金额` / `实付金额` → `cost` in your spreadsheet before pasting).",
    csvChooseFile: "Choose CSV file",
    csvOrPaste: "...or paste the CSV directly:",
    csvPastePlaceholder:
      "Day,Model,Input tokens,Output tokens,Cost\n2024-01-01,gpt-4o,1234,567,0.0345\n...",
    csvErrorParseFile: "Failed to read the file.",
    csvErrorMissingColsFile:
      "Couldn't find `model` and `cost` columns in this CSV. Try OpenAI's `Export usage` CSV from https://platform.openai.com/usage, or Anthropic's billing export.",
    csvErrorMissingColsPaste:
      "Couldn't find `model` and `cost` columns in the pasted text. Make sure the first line is the header row and includes columns named like `model` and `cost_usd`.",
    csvFilenamePasted: "(pasted)",
    csvFileMetaRows: " rows",
    csvFileMetaModels: " distinct models",

    resultLabel: "Planning estimate",
    resultMidpointPrefix: "~",
    resultMidpointSuffix: "/month at the midpoint",
    resultBasedOnPrefix: " (",
    resultBasedOnSuffix:
      "/year). Based on {source}. Treat this as a planning range; the dashboard receipt and shadow A/B are the source of truth.",
    resultMinSpendPrefix: "Enter at least ",
    resultMinSpendEmphasis: "$50/month",
    resultMinSpendSuffix:
      " in spend to get a meaningful estimate. Below that, infrastructure savings are noise.",
    resultSourceCsv: "your uploaded usage data ({n} rows)",
    resultSourceQuick: "the “{label}” workload bucket",

    paybackProLabel: "Pro $29/mo",
    paybackTeamLabel: "Team $99/mo",
    paybackScaleLabel: "Scale $499/mo",
    paybackPaysBackPrefix: "pays back in ",
    paybackHoursUnit: "h",
    paybackDaysUnit: " days",
    paybackNa: "n/a",
    paybackProNote: "$500/day cap, 1M req/mo",
    paybackTeamNote: "Unlimited + audit CSV",
    paybackScaleNote: "+ SSO + RBAC + multi-region (planned)",

    breakdownTitle: "Breakdown by model",
    breakdownFromCsvSuffix: "from {n} CSV rows",
    breakdownColModel: "Model",
    breakdownColTier: "Tier",
    breakdownColSpent: "Spent",
    breakdownColEstSaved: "Est. saved",
    breakdownColSavedPct: "Saved %",
    breakdownColWhy: "Why",
    breakdownTierFrontier: "frontier",
    breakdownTierMid: "mid",
    breakdownTierCheap: "cheap",
    breakdownTierUnknown: "unknown",
    breakdownWhyFrontier:
      "Frontier model — some prompts can route to mid-tier",
    breakdownWhyMid:
      "Mid-tier — trivial prompts route to mini/haiku/flash",
    breakdownWhyCheap:
      "Already cheap — gains mostly from prompt-cache and context compression",
    breakdownWhyUnknown:
      "Unclassified — assumed mid-tier conservatively",
    breakdownTopNFooter:
      "Showing top 30 of {total} models by spend.",

    howTitle: "How we estimated this",
    howCsvBody:
      "Per-model heuristic: frontier models (gpt-5*, claude-opus*, o3/o4*) get 35–55% routing savings in the planner. Mid-tier (gpt-4o, sonnet, gemini-pro) gets 20–35%. Already-cheap models (mini/haiku/flash) get 0–5% routing plus possible prompt-cache. Anthropic family gets a conservative +10–18% cache_control bonus. Agent and IDE workloads may see additional input-token savings from context compression when they replay large tool outputs; TokSuan measures that separately in audit/optimize mode and shows it as Context compression in the dashboard.",
    howFooter:
      "The ranges start from TokSuan's public baseline policy run (`public_agent_eval_mix` across frontier models), then we deliberately haircut them for pre-sales use. Pretending we can predict your exact savings to the dollar would be dishonest. The product's job is to turn this estimate into a receipt: asked model, landed model, actual cost, saved cost, context-compression bytes saved, and quality evidence from shadow A/B where you enable it.",
    howSelfHostNote:
      "For paid API models, savings are dollar savings from published token prices. For self-hosted or custom endpoints, TokSuan can show that traffic moved off a large-model endpoint, but exact dollar savings require your GPU / endpoint cost metadata.",

    notYetTitle: "Do not pay yet if...",
    notYetUnder50Prefix: "Your combined LLM spend is under ",
    notYetUnder50Spend: "$50",
    notYetUnder50AmountPrefix: "/month. Use Free or ",
    notYetUnder50Link: "self-host",
    notYetUnder50Suffix: "; infrastructure savings are probably noise.",
    notYetCheapModels:
      "Nearly all traffic already lands on mini / haiku / flash-class models. Prove cache or loop savings first.",
    notYetSlaPrefix: "Procurement requires a formal hosted SLA or SOC 2 today. ",
    notYetSlaLink1: "Self-host",
    notYetSlaMid: " the Apache-2.0 product or start a ",
    notYetSlaLink2: "GitHub issue",
    notYetSlaSuffix: ".",
    notYetByo:
      "You cannot bring your own provider keys. TokSuan hosted is a BYO-key control plane, not a token reseller.",

    ctaTitle: "Try it for real",
    ctaBody:
      "Estimates are estimates. The fastest proof is one real request: TokSuan shows the asked model, landed model, routing reason, actual cost, and saved cost. The deeper proof is a week of your real traffic in shadow mode, then the Quality Proof card.",
    ctaStartFree: "Start free",
    ctaSelfHostDocs: "Self-host docs",
    ctaFinePrintPrefix:
      "We don't take a spread on your tokens. You BYO provider keys; your provider bills you directly. TokSuan's revenue is the flat $29 or $99 monthly fee (moving to outcome-aligned ",
    ctaFinePrintCode: "max(floor, min(10% × savings, cap))",
    ctaFinePrintSuffix:
      " in Q3 2026 — you'll never pay more than the cap). Monthly billing, cancel any time — max risk is one month for the period you actually used. No refunds, no clawbacks, no exit interview.",
  },

  emails: {
    otpSubject: "Your TokSuan sign-in code",
    otpHeading: "Sign in to TokSuan",
    otpIntro:
      "Use the 6-digit code below to finish signing in. Don't share it with anyone.",
    otpExpiry: "This code expires in 15 minutes.",
    otpFooter:
      "If you didn't try to sign in, you can ignore this email — your account is safe.",
    otpTextLine1: "Your TokSuan sign-in code is: {code}",
    otpTextLink: "Or click this link to sign in directly:",
    otpTextExpiry: "This code expires in {ttl} minutes.",
    otpTextFooter:
      "If you didn't request this, you can safely ignore this email.",
    otpSubjectTpl: "Your TokSuan sign-in code: {code}",
    otpHtmlBrand: "TokSuan",
    otpHtmlSignInBtn: "Sign in with one click",

    inviteSubject:
      "{inviter} invited you to {org} on TokSuan",
    inviteTextLine1:
      "{inviter} invited you to join {org} on TokSuan as {role}.",
    inviteTextLink: "Accept the invitation:",
    inviteTextFooter1:
      "If you don't already have a TokSuan account, you'll create one when you accept.",
    inviteTextFooter2: "Invitations expire in 14 days.",
    inviteHtmlLine:
      "{inviter} invited you to join <strong>{org}</strong> on TokSuan as <strong>{role}</strong>.",
    inviteHtmlBtn: "Accept the invitation",
    inviteHtmlFallback: "If the button doesn't work, copy-paste this URL: ",
    inviteHtmlFooter:
      "If you don't already have a TokSuan account, you'll create one when you accept. Invitations expire in 14 days.",

    digestSubject: "Your TokSuan weekly savings",
    digestSubjectTpl: "TokSuan · {amount} saved last week",
    digestHeading: "Last week on TokSuan",
    digestIntro:
      "A quick recap of what your agents spent, what TokSuan routed cheaper, and the most useful patterns to look at.",
    digestSpendLabel: "Spend",
    digestSavedLabel: "Saved",
    digestRequestsLabel: "Requests",
    digestCta: "Open dashboard",
    digestUnsubscribe: "Unsubscribe from this digest",
    digestGreeting: "Hi {name},",
    digestGreetingFallbackName: "there",
    digestRecapLine: "Last 7 days through TokSuan: {amount} saved.",
    digestRoutingLabel: "Routing:",
    digestRoutingNote: "({n} requests downgraded)",
    digestCacheLabel: "Prompt cache:",
    digestCacheNote: "({n} cache hits)",
    digestAlsoCaughtLabel: "Also caught:",
    digestAlsoCaughtNote:
      "{loops} runaway loops + {budget} over-budget calls",
    digestTopRoutesLabel: "Top routed pairs:",
    digestTotalSpendLabel: "Total spend last 7d: {amount}",
    digestViewDashboardLabel: "View dashboard: {url}",
    digestUnsubscribeLine:
      "Unsubscribe from the weekly digest: {url}",
    digestUnsubscribeNote:
      "(You'll keep receiving transactional emails like sign-in codes and billing receipts.)",
    digestFooterTagline:
      "TokSuan · the open-source agent budget gateway",
    digestHtmlBrand: "TokSuan · weekly digest",
    digestHtmlSavedLabel: "Saved",
    digestHtmlVsSpendPrefix: "vs ",
    digestHtmlVsSpendSuffix: " actual spend",
    digestHtmlReqsSuffix: " reqs",
    digestHtmlHitsSuffix: " hits",
    digestHtmlAlsoCaught: "Also caught",
    digestHtmlLoopsSuffix: " runaway loops",
    digestHtmlOverBudgetSuffix: " over budget",
    digestHtmlTopRoutesLabel: "Top routed pairs",
    digestHtmlReqAbbrev: " req",
    digestHtmlViewBtn: "View dashboard",
    digestHtmlUnsubPrefix: "Don't want the weekly digest? ",
    digestHtmlUnsubLink: "Unsubscribe with one click",
    digestHtmlUnsubSuffix:
      " — transactional emails (sign-in, billing) keep working.",
  },

  languageToggle: {
    ariaLabel: "Switch language",
    currentEn: "English",
    currentZh: "中文",
    switchToTpl: "Switch to {label}",
  },
};
