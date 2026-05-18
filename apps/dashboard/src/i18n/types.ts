/**
 * Single source of truth for every user-facing string in the dashboard.
 *
 * Conventions:
 *   - Group by page or shared surface, not by alphabetical order.
 *   - Keys are camelCase and READABLE in English (`heroTitle`, not `h1`).
 *   - Values are user-visible copy. NEVER put a model id, project name,
 *     URL, or other dynamic data in this file — those are inserted by
 *     the caller via template strings or React composition.
 *   - Keep both `en` and `zh-CN` synchronized: both must satisfy this
 *     `Dictionary` interface. TypeScript will catch missing keys.
 *   - When the same phrase appears in N places, put it in `common`, not
 *     in N section-specific keys. This is what makes the toggle feel
 *     polished — buttons say the same thing everywhere.
 */

export type Dictionary = {
  // -----------------------------------------------------------------------
  // Common — buttons, status pills, generic verbs that recur in many pages
  // -----------------------------------------------------------------------
  common: {
    /** Used by `<AutoRefresh>` — labels for the live indicator that
     *  every server-rendered analytics page shows in its header. */
    autoRefresh: {
      /** Static prefix shown before the relative timestamp. */
      live: string;
      /** Text shown until the client mounts and computes a relative time. */
      updating: string;
      /** Less than 5s since render. */
      justNow: string;
      /** Template for "Xs ago" — `{n}` is the integer seconds. */
      secondsAgo: string;
      /** Template for "Xm ago" — `{n}` is the integer minutes. */
      minutesAgo: string;
      /** Tooltip on the indicator — `{n}` is the configured interval seconds. */
      title: string;
    };
    /** Default CTA for "go ahead and do the action". */
    confirm: string;
    cancel: string;
    save: string;
    saving: string;
    saved: string;
    delete: string;
    edit: string;
    create: string;
    add: string;
    remove: string;
    rotate: string;
    test: string;
    testing: string;
    copy: string;
    copied: string;
    close: string;
    open: string;
    /** "Back" arrow phrasing. */
    back: string;
    backToDashboard: string;
    backHome: string;
    /** Status pill words. */
    enabled: string;
    disabled: string;
    pending: string;
    active: string;
    inactive: string;
    success: string;
    failed: string;
    error: string;
    warning: string;
    notConfigured: string;
    optional: string;
    required: string;
    /** "Loading…" / "—" placeholders. */
    loading: string;
    none: string;
    notAvailable: string;
    /** Time / number adverbs. */
    today: string;
    thisMonth: string;
    /** Sign in / out, account chrome. */
    signIn: string;
    signOut: string;
    docs: string;
  };

  // -----------------------------------------------------------------------
  // Top-level navigation (AppNav / AppFooter)
  // -----------------------------------------------------------------------
  nav: {
    dashboard: string;
    projects: string;
    agents: string;
    routing: string;
    settings: string;
    docs: string;
    signOut: string;
    /** Footer links. */
    trust: string;
    estimator: string;
    stateOfSpend: string;
    selfHost: string;
    footerMeta: string;
    /** Settings family sidebar labels (rendered by `<SettingsLayout>`). */
    settingsAccount: string;
    settingsTeam: string;
    settingsBilling: string;
    settingsAudit: string;
    settingsReferrals: string;
    settingsTrust: string;
    settingsBack: string;
    /** aria-label for the `<aside>` sub-navigation rail in `<SettingsLayout>`. */
    settingsAriaLabel: string;
  };

  // -----------------------------------------------------------------------
  // Public landing page (`/`)
  // -----------------------------------------------------------------------
  landing: {
    metaDescription: string;
    navStateOfSpend: string;
    navEstimate: string;
    navTrust: string;
    navOpenClaw: string;
    navHermes: string;
    ctaSignedIn: string;
    ctaAnonymous: string;
    heroEyebrow: string;
    heroTitle: string;
    heroSubtitle: string;
    heroPrimarySignedIn: string;
    heroPrimaryAnonymous: string;
    heroSecondaryEstimate: string;
    heroSecondaryRoutingWins: string;
    heroSecondaryOpenClaw: string;
    heroSecondaryHermes: string;
    heroSecondarySelfHost: string;
    heroFinePrint: string;
    receiptHeader: string;
    receiptSession: string;
    receiptAskedModel: string;
    receiptLandedModel: string;
    receiptCheaperRoute: string;
    receiptCheaperRouteSub: string;
    receiptQualityProof: string;
    receiptQualityProofValue: string;
    receiptDescription: string;
    aggregateEyebrow: string;
    aggregateTitleVisible: string;
    aggregateTitleWarming: string;
    aggregateBodyVisible: string;
    aggregateBodyWarming: string;
    aggregateSavingsLabel: string;
    aggregateRequestsLabel: string;
    aggregateLoopsLabel: string;
    aggregateParticipantsLabel: string;
    aggregateWarmingValue: string;
    aggregateWarmingSavingsLabel: string;
    aggregateWarmingRequestsLabel: string;
    aggregateWarmingParticipantsLabel: string;
    aggregatePrivacyNote: string;
    quickstartEyebrow: string;
    quickstartTitle: string;
    quickstartSubtitle: string;
    quickstartStep1: string;
    quickstartStep2: string;
    quickstartStep3: string;
    quickstartStep4: string;
    flowAgentSdk: string;
    flowGateway: string;
    flowProvider: string;
    flowReceipt: string;
    hostedEyebrow: string;
    hostedTitle: string;
    hostedBody: string;
    hostedCtaTrust: string;
    hostedCtaProof: string;
    hostedCard1Title: string;
    hostedCard1Body: string;
    hostedCard2Title: string;
    hostedCard2Body: string;
    hostedCard3Title: string;
    hostedCard3Body: string;
    devEyebrow: string;
    devTitle: string;
    devBody: string;
    whyEyebrow: string;
    whyTitle: string;
    whyBody: string;
    why1Title: string;
    why1Body: string;
    why2Title: string;
    why2Body: string;
    why3Title: string;
    why3Body: string;
    loopEyebrow: string;
    loopTitle: string;
    loopBody: string;
    bento1Pill: string;
    bento1Title: string;
    bento1Body: string;
    bento2Pill: string;
    bento2Title: string;
    bento2Body: string;
    bento3Pill: string;
    bento3Title: string;
    bento3Body: string;
    bento4Pill: string;
    bento4Title: string;
    bento4Body: string;
    trustBand1Title: string;
    trustBand1Body: string;
    trustBand2Title: string;
    trustBand2Body: string;
    trustBand3Title: string;
    trustBand3Body: string;
    faqEyebrow: string;
    faqTitle: string;
    faqBody: string;
    faq1Q: string;
    faq1A: string;
    faq2Q: string;
    faq2A: string;
    faq3Q: string;
    faq3A: string;
    faq4Q: string;
    faq4A: string;
    faq5Q: string;
    faq5A: string;
    faq6Q: string;
    faq6A: string;
    finalEyebrow: string;
    finalTitle: string;
    finalBody: string;
    finalCtaSignedIn: string;
    finalCtaAnonymous: string;
    finalCtaQuickstart: string;

    /** Accessibility labels for landmark sections that don't have visible headings. */
    publicNavAriaLabel: string;
    quickstartAriaLabel: string;
  };

  // -----------------------------------------------------------------------
  // Login (`/login`) + verify code flow
  // -----------------------------------------------------------------------
  login: {
    titleEmail: string;
    titleCode: string;
    /** "Sent to {email}. Expires in 15 minutes." — caller substitutes. */
    sentToPrefix: string;
    sentToSuffix: string;
    subtitleEmail: string;
    fieldEmail: string;
    fieldCode: string;
    placeholderEmail: string;
    placeholderCode: string;
    continue: string;
    verify: string;
    sending: string;
    resend: string;
    resendIn: string;
    resendTooltipDisabled: string;
    resendTooltipReady: string;
    devLogHint: string;
  };

  // -----------------------------------------------------------------------
  // Unsubscribe (`/unsubscribe`)
  // -----------------------------------------------------------------------
  unsubscribe: {
    titleSuccess: string;
    bodyPrefix: string;
    bodyMid: string;
    bodySuffix: string;
    bodyChangedMind: string;
    backToDashboard: string;
    titleInvalid: string;
    bodyInvalid: string;
    signIn: string;
    listLabelWeeklyDigest: string;
  };

  // -----------------------------------------------------------------------
  // Savings estimator (`/estimate`)
  // -----------------------------------------------------------------------
  estimate: {
    metaTitle: string;
    metaDescription: string;
    title: string;
    subtitle: string;
  };

  // -----------------------------------------------------------------------
  // Trust (`/trust`)
  // -----------------------------------------------------------------------
  trust: {
    metaTitle: string;
    metaDescription: string;
    title: string;
    tagline: string;
    shortVersionTitle: string;
    shortVersionBody: string;
    backToBilling: string;
    docsTrust: string;
    docsSubProcessors: string;
    docsRunbook: string;
    statusEnabled: string;
    statusNotConfigured: string;
    statusDisabled: string;
    liveTitle: string;
    liveSubtitle: string;
    liveGatewayUnreachablePrefix: string;
    liveColControl: string;
    liveColStatus: string;
    liveColWhy: string;
    liveByoControl: string;
    liveByoWhy: string;
    liveBodyStorageControl: string;
    liveBodyStorageWhy: string;
    liveQualityControl: string;
    liveQualityWhy: string;
    liveReplayControl: string;
    liveReplayWhy: string;
    liveOtelControl: string;
    liveOtelWhy: string;
    liveBaselineControl: string;
    /** "{n} bucket(s)" / "{n} 个任务桶" */
    liveBaselineBucketsTpl: string;
    liveBaselineWhy: string;
    liveSettingsPrefix: string;
    liveSettingsLink: string;
    liveSettingsSuffix: string;
    dataTitle: string;
    dataColData: string;
    dataColWhere: string;
    dataColWhy: string;
    dataPrompt: string;
    dataPromptWhere: string;
    dataPromptWhy: string;
    dataApiKey: string;
    dataApiKeyWhere: string;
    dataApiKeyWhy: string;
    dataByoKey: string;
    dataByoKeyWhere: string;
    dataByoKeyWhy: string;
    dataBilling: string;
    dataBillingWhere: string;
    dataBillingWhy: string;
    reliabilityTitle: string;
    reliabilityBody: string;
    docsSecurity: string;
    docsDpa: string;
    items: {
      byoTitle: string;
      byoBody: string;
      kmsTitle: string;
      kmsBody: string;
      bodyTitle: string;
      bodyBody: string;
      selfHostTitle: string;
      selfHostBody: string;
    };
  };

  // -----------------------------------------------------------------------
  // State of agent spend (`/state-of-agent-spend`)
  // -----------------------------------------------------------------------
  stateOfSpend: {
    metaTitle: string;
    metaDescription: string;
    eyebrow: string;
    title: string;
    subtitle: string;
    ctaEstimate: string;
    ctaTrust: string;
    modePillPreview: string;
    modeTitle: string;
    modeBody: string;
    modePolicyLabel: string;
    policyUnavailable: string;
    statBuckets: string;
    statModels: string;
    statProviders: string;
    statAvgSavings: string;
    routingWinsEyebrow: string;
    routingWinsTitle: string;
    routingWinsBody: string;
    routingWinsCta: string;
    routingWinsEmpty: string;
    routingWinsPolicyEmpty: string;
    routingWinsAsked: string;
    routingWinsLanded: string;
    routingWinsBucket: string;
    routingWinsSavings: string;
    routingWinsGuardrail: string;
    routingWinsPerSampleSuffix: string;
    routingWinsQualityPass: string;
    routingWinsQualityDelta: string;
    providerEyebrow: string;
    providerTitle: string;
    providerBody: string;
    telemetryEyebrow: string;
    telemetryTitle: string;
    signal1Title: string;
    signal1Body: string;
    signal2Title: string;
    signal2Body: string;
    signal3Title: string;
    signal3Body: string;
    signal4Title: string;
    signal4Body: string;
    privacyTitle: string;
    privacyBody: string;
    privacyLabelProjects: string;
    privacyLabelOrgs: string;
    privacyLabelRequests: string;
    privacyLabelWindow: string;
    finalEyebrow: string;
    finalTitle: string;
    finalBody: string;
    finalCtaEstimate: string;
    finalCtaStart: string;
    finalCtaOpenClaw: string;
    navEstimate: string;
    navTrust: string;
    navStart: string;
    /** Accessibility labels for landmark sections without visible headings. */
    publicNavAriaLabel: string;
    proofGridAriaLabel: string;
    routingWinsTableAriaLabel: string;
  };

  // -----------------------------------------------------------------------
  // Routing quality (`/routing-quality`) — public surface, light translation
  // -----------------------------------------------------------------------
  routingQuality: {
    backHome: string;
    backDashboard: string;
  };

  // -----------------------------------------------------------------------
  // Dashboard summary (`/dashboard`)
  // -----------------------------------------------------------------------
  dashboard: {
    pageTitle: string;
    /** Brand-hero header. */
    heroEyebrow: string;
    heroTitle: string;
    heroSubtitle: string;
    heroPillSee: string;
    heroPillCap: string;
    heroPillShrink: string;
    heroPillKeep: string;
    /** Accessibility label for the four-pill brand-hero band. */
    heroPillsAriaLabel: string;
    tagline: string;
    statTotalSpend: string;
    statRequests: string;
    statSavings: string;
    statSavingsPctSuffix: string;
    statRouted: string;
    statBlocked: string;
    statLoops: string;
    statBudget: string;
    sectionRecent: string;
    sectionTopRoutes: string;
    sectionRecommendations: string;
    sectionTopLoops: string;
    sectionQuality: string;
    sectionBudgets: string;
    sectionSpendByModel: string;
    sectionSpendByTag: string;
    sectionSavings: string;
    sectionDailySpend: string;
    sectionFirstRequest: string;
    emptyRecent: string;
    emptyRecommendations: string;
    emptyRoutes: string;
    emptyLoops: string;
    emptyBudgets: string;
    emptySpendByModel: string;
    askedModel: string;
    landedModel: string;
    routingReason: string;
    cost: string;
    saved: string;
    latency: string;
    project: string;
    when: string;
    /** Cost-spike banner. */
    spikeTitle: string;
    spikeBaselineSuffix: string;
    /** Plan-cap blocked banner. */
    planCapTitlePrefix: string;
    planCapTitleSuffix: string;
    planCapBody: string;
    planCapCta: string;
    /** First-setup empty-state CTA labels. */
    firstSetupAddProviderLabel: string;
    firstSetupAddProviderBody: string;
    firstSetupCreateProjectLabel: string;
    firstSetupCreateProjectBody: string;
    firstSetupOpenProjectLabel: string;
    firstSetupOpenProjectBody: string;
    /** Loops/patterns labels. */
    topPattern: string;
    attempts: string;
    showMorePatterns: string;
    /** Budget over-limit hint. */
    budgetOverLimit: string;

    /** Savings hero card. */
    savingsHeroLabel: string;
    /** "{pct} off ..." — caller substitutes `{pct}` with the localised percent. */
    savingsHeroSubWithPct: string;
    savingsHeroSubEmpty: string;
    savingsHeroBreakdownRouting: string;
    savingsHeroBreakdownCache: string;
    /**
     * Tool-result compressor savings cell. Only rendered when the
     * compressor actually fired in the time window — invisible UI
     * for self-hosters who haven't enabled it.
     */
    savingsHeroBreakdownToolCompress: string;
    savingsHeroBreakdownPrevented: string;
    /** "{n} requests downgraded" / "{n} requests cached" — `{n}` is substituted. */
    savingsHeroRoutingNote: string;
    savingsHeroCacheNote: string;
    /** "{n} requests had tool messages compressed". */
    savingsHeroToolCompressNote: string;
    /** "{loops} runaway loops · {budget} over-budget". */
    savingsHeroPreventedNote: string;

    /** SavingsReceiptCard. */
    receiptCardTitle: string;
    receiptOpenRequest: string;
    receiptAskedModel: string;
    receiptLandedModel: string;
    receiptSavedOnThis: string;
    receiptVsAskedSuffix: string;
    receiptActualCost: string;
    receiptTrackedApiCost: string;
    receiptCustomNote: string;
    /** "asked would be" prefix for the sub-label under actual cost. */
    receiptAskedWouldBe: string;
    receiptWhyHappened: string;
    receiptSelfHostNote: string;
    receiptSelfHostBody: string;
    receiptStatusRoutedDown: string;
    receiptStatusCacheSaved: string;
    receiptQualityRisk: string;

    /** SevenDayValueReportCard. */
    weekTitle: string;
    weekUpgradeSignal: string;
    weekSavedThisWeek: string;
    /** "{ratio}x the $29 Pro fee" — `{ratio}` substituted with formatted multiplier. */
    weekProFeeRatio: string;
    /** "{pct}% of the $29 Pro fee" — `{pct}` substituted. */
    weekProFeePct: string;
    weekTopDowngrade: string;
    weekNoneYet: string;
    /** "over {n} requests" — `{n}` substituted. */
    weekOverNRequests: string;
    weekPrevented: string;
    /** "{loops} loops · {budget} budget/plan blocks". */
    weekPreventedNote: string;
    weekQualityProof: string;
    /** "{n} shadow trials". */
    weekShadowTrials: string;
    weekNoShadowYet: string;
    weekTopDowngradeLabel: string;
    weekRecommendedNextStep: string;
    weekNoisiestPrefix: string;
    weekNoisiestMid: string;
    weekNoisiestSuffix: string;
    weekActionAddShadow: string;
    weekActionMoreTraffic: string;
    weekActionUpgrade: string;
    weekBodyAddShadow: string;
    weekBodyMoreTraffic: string;
    weekBodyUpgrade: string;

    /** Database failure cards. */
    dbErrColumnTitle: string;
    dbErrColumnBody: string;
    dbErrColumnHint: string;
    dbErrColumnMissing: string;
    dbErrTableTitle: string;
    dbErrTableBodyPrefix: string;
    dbErrTableBodyMid: string;
    dbErrTableBodySuffix: string;
    dbErrTableMissing: string;
    dbErrUnreachableTitle: string;
    dbErrUnreachableBody: string;

    /** First-request onboarding card. */
    firstReqHeaderHint: string;
    firstReqIntro: string;
    firstReqStepProviderKey: string;
    firstReqStepProviderEnv: string;
    firstReqStepCreateProject: string;
    firstReqStepCreateApiKey: string;
    firstReqStepCopyCurl: string;
    firstReqStepReadReceipt: string;
    firstReqActionManage: string;
    firstReqActionOpen: string;
    firstReqActionOpenProject: string;
    firstReqActionOpenSetup: string;
    firstReqNextStep: string;
    firstReqFooter: string;

    /** Spend hero stat-grid (7-day / 24-hour cards beside the savings hero). */
    statGridSpend7d: string;
    statGridCalls7d: string;
    statGridBlocked24h: string;
    statGridLoops24h: string;
    statGridRouted24h: string;
    statGridCached24h: string;
    statGridCachedSavedPrefix: string;

    /** Daily-spend chart. */
    dailyPeakPrefix: string;
    dailyBudgetCapPrefix: string;
    /** "{n} call" / "{n} calls" — lowercased noun used in chart tooltips. */
    dailyCallSingular: string;
    dailyCallPlural: string;

    /** Budgets card. */
    budgetActiveSuffix: string;
    budgetEmptyPrefix: string;
    budgetEmptyCommand: string;
    budgetPeriodToday: string;
    budgetPeriodThisMonth: string;
    budgetOverLimitPrefix: string;
    budgetOverLimitHttpCode: string;
    budgetOverLimitSuffix: string;

    /** Top-loops table. */
    loopColFingerprint: string;
    loopColModel: string;
    loopColAttempts: string;
    loopColShare: string;
    loopColBlocked: string;
    loopColLastSeen: string;
    loopShowMore: string;

    /** Spend-by-model table. */
    modelColModel: string;
    modelColCalls: string;
    modelColSpend: string;
    modelColShare: string;
    modelShowMore: string;

    /** Spend-by-tag table + explanation. */
    tagSourceLabel: string;
    tagColTag: string;
    tagColCalls: string;
    tagColSpend: string;
    tagColShare: string;
    tagShowMore: string;
    tagFooter: string;

    /** A/B experiments card. */
    abTitle: string;
    abSubtitle: string;
    abColPrimary: string;
    abColShadow: string;
    abColTrials: string;
    abColPrimaryCost: string;
    abColShadowCost: string;
    abColDelta: string;
    abColLatency: string;
    abColErrors: string;

    /** Recent-requests table. */
    recentLatestPrefix: string;
    recentEmptyPrefix: string;
    recentEmptySuffix: string;
    recentColTime: string;
    recentColProvider: string;
    recentColModel: string;
    recentColInput: string;
    recentColOutput: string;
    recentColCost: string;
    recentColSaved: string;
    recentColLatency: string;
    recentColStatus: string;
    recentShowOlder: string;

    /** Quality proof — extra similarity sub-stat. */
    qpSwitchSafeLabel: string;
    qpSwitchSafeAcrossPrefix: string;
    qpSwitchSafeAcrossSuffix: string;
    qpSwitchSafeOfPrefix: string;
    qpSwitchSafeOfMid: string;
    qpSwitchSafeOfSuffix: string;
    qpFooterBody: string;

    /** humanRoutingReason() outputs — keep as full sentences and let the
     *  function pick which one based on routing_reason. Some are templates
     *  with `{bucket}` / `{taskType}` / `{complexity}` placeholders that
     *  the function replaces at call time. */
    reasonLoopDetected: string;
    reasonBudgetExceeded: string;
    reasonPlanLimitExceeded: string;
    reasonOlderRewriteUnknown: string;
    reasonNoRewrite: string;
    /** "Baseline policy classified this request{bucket} and chose the
     *  cheaper landed model within the policy tolerance." — bucket is
     *  optional; caller passes the localised bucket fragment. */
    reasonBaseline: string;
    reasonBaselineBucketPrefix: string;
    reasonRule: string;
    reasonFallback: string;
    /** "Baseline policy classified this request as {taskType} / {complexity},
     *  but every cheaper model in that bucket needs credentials..." */
    reasonNoCallableCheaper: string;
    /** "Baseline policy classified this request as {taskType} / {complexity}
     *  but found no cheaper candidate inside the policy's quality tolerance." */
    reasonNoCheaper: string;
    reasonUnknownCallerModel: string;
    reasonDisabled: string;
    reasonNoModel: string;

    /** qualityProofLabel() outputs. */
    qualityDoNotRoute: string;
    qualityChecked: string;
    qualityHttpSafe: string;
    qualityBaselineOnly: string;
    /** "Shadow A/B has {n} similarity-scored trial(s); avg similarity {sim}.
     *  Keep the expensive model until you review failures." */
    qualityBodyDangerSimilarity: string;
    /** "Shadow A/B has {n} similarity-scored trial(s); avg similarity {sim}, {pct}% switch-safe." */
    qualityBodyOkSimilarity: string;
    /** "Shadow A/B has {n} trial(s); only {pct}% of shadow calls returned 2xx..." */
    qualityBodyDangerSuccess: string;
    /** "Shadow A/B has {n} trial(s); {pct}% of shadow calls returned 2xx..." */
    qualityBodyOkSuccess: string;
    qualityBodyBaselineOnly: string;
    qualityActionReviewRouting: string;
    qualityActionReviewProof: string;
    qualityActionReviewBorderline: string;
    qualityActionReviewFailures: string;
    qualityActionEnableScoring: string;
    qualityActionAddShadow: string;

    /** Recommendations card titles + CTAs. */
    recommendationsTitle: string;
    recProjectFallback: string;
    /** "{n} short prompts on {fromModel} last 7d in {project} — worth testing.
     *  Estimated savings: ~{saved} routing them to {toModel}." — caller substitutes. */
    recWastefulPattern: string;
    recAddRoutingRule: string;
    /** "{project} caught {n} runaway loop attempts in the last 24h..." */
    recLoopSpike: string;
    recSetAlert: string;
    /** "{project} averages {avg}/day over the past 7d but its daily budget is {limit}..." */
    recUndersizedBudget: string;
    recEditBudget: string;
    /** "{project} spent {spend} in the past 7d with no daily budget set..." */
    recNoBudget: string;
    recSetBudget: string;

    /** Quality proof card (`/dashboard`). */
    qpTitle: string;
    qpEmptyHeader: string;
    qpEmptyBody: string;
    qpEmptyBullet1Title: string;
    qpEmptyBullet1: string;
    qpEmptyBullet2Title: string;
    qpEmptyBullet2: string;
    qpEmptyBullet3Title: string;
    qpEmptyBullet3: string;
    qpEmptyBullet4Title: string;
    qpEmptyBullet4Prefix: string;
    qpEmptyBullet4Suffix: string;
    qpEmptyAddShadow: string;
    qpEmptyCreateProject: string;
    qpEmptyHintPrefix: string;
    qpEmptyHintMode1: string;
    qpEmptyHintMode2: string;
    qpEmptyHintConn: string;
    /** "{n} experiment · {n} shadow trial(s)" — singular forms inline OK in CN. */
    qpHeaderCounts: string;
    qpStatSuccess: string;
    /** "{n1} / {n2} shadow calls returned 2xx" */
    qpStatSuccessNote: string;
    qpStatSuccessDangerNote: string;
    qpStatSuccessOkNote: string;
    qpStatFaster: string;
    /** "{n} trial(s) beat primary on latency" */
    qpStatFasterNote: string;
    qpStatCostDiff: string;
    qpStatCostDiffNote: string;
    qpAvgSimilarity: string;
  };

  /** /agents page (table + window selector). */
  agentsPage: {
    /** Day-word forms used to fill the `{dayWord}` placeholder in the
     *  paragraph template. EN switches between "day" / "days" by count;
     *  CN uses "天" for both. */
    dayWordSingular: string;
    dayWordPlural: string;
    paragraph: string;
    windowLabel: string;
    window24h: string;
    window7d: string;
    window30d: string;
    /** "{n} session(s) • total spend {spend}" — caller substitutes. */
    countLine: string;
    /** Singular / plural agnostic — used as raw labels in column headers. */
    colAgent: string;
    colSession: string;
    colTurns: string;
    colSpend: string;
    colTokensInOut: string;
    colP50P95: string;
    colCounters: string;
    colLastSeen: string;
    /** "{n} req(s)" cell suffix. */
    cellReqSuffix: string;
    cellLastSeenSuffix: string;

    /** Tooltip titles for the counter cell. */
    titleToolCounts: string;
    titleErrorCounts: string;
    titleLoopBlocked: string;
    titleBudgetBlocked: string;
    titlePlanBlocked: string;

    /** Relative-time helper words. */
    relSecondsAgo: string;
    relMinutesAgo: string;
    relHoursAgo: string;
    relDaysAgo: string;
  };

  /** /routing-quality page (operator-facing, but still user-visible). */
  routingQualityPage: {
    title: string;
    dayWordSingular: string;
    dayWordPlural: string;
    paragraph: string;
    statTotalRewrites: string;
    statOverallSuccess: string;
    statFlaggedPairs: string;
    statFlaggedNote: string;
    sectionRewrites: string;
    rewritesAsked: string;
    rewritesLanded: string;
    rewritesCalls: string;
    rewritesSuccess: string;
    rewritesVsNative: string;
    rewritesErrors: string;
    rewritesLoopQuota: string;
    rewritesAvgLatency: string;
    rewritesTotalSpend: string;
    sectionPerBucket: string;
    perBucketBody: string;
    bucketCol: string;
    bucketCalls: string;
    bucketSuccess: string;
    bucketErrors: string;
    bucketLoopQuota: string;
    bucketAvgSavedCall: string;
    bucketTotalSpend: string;
    sectionNative: string;
    nativeBody: string;
    nativeCol: string;
    nativeCalls: string;
    nativeSuccess: string;
    nativeErrors: string;
    nativeAvgLatency: string;
    nativeTotalSpend: string;
    publicReadOnlyTitle: string;
    publicReadOnlyBody: string;
    publicSignInCta: string;
    emptyData: string;
    queryFailedPrefix: string;
    queryFailedDetailPrefix: string;
    emptyTitle: string;
    emptyBodyPrefix: string;
    emptyBodyMid: string;
    emptyBodySuffix: string;
  };

  /** /settings page — large surface, only the user-visible parts that
   *  show up on the BYO key flow. Deeper engineering tables stay
   *  English-friendly via inline copy that's already there. */
  settingsPage: {
    sectionTelemetryTitle: string;
    sectionTelemetryStatusOff: string;
    sectionTelemetryStatusOn: string;
    sectionTelemetryBody: string;
    sectionTelemetryWhatSent: string;
    sectionTelemetryWhatSentItem1: string;
    sectionTelemetryWhatSentItem2: string;
    sectionTelemetryWhatSentItem3: string;
    sectionTelemetryWhatSentItem4: string;
    sectionTelemetryNeverSent: string;
    sectionTelemetryNeverSentItem1: string;
    sectionTelemetryNeverSentItem2: string;
    sectionTelemetryNeverSentItem3: string;
    sectionTelemetryNeverSentItem4: string;
    sectionTelemetryEndpointPrefix: string;
    sectionTelemetryThresholds: string;
    sectionTelemetryDryRunHint: string;
    sectionTelemetryCronHint: string;
    sectionTelemetryCopyCron: string;

    /** Hosted (vs self-host) variant — same panel, slightly different copy. */
    hostedTelemetryTitle: string;
    hostedTelemetryPill: string;
    hostedTelemetryBody: string;
    hostedTelemetryWhat: string;
    hostedTelemetryWhat1: string;
    hostedTelemetryWhat2: string;
    hostedTelemetryWhat3: string;
    hostedTelemetryWhat4: string;
    hostedTelemetryHow: string;
    hostedTelemetryHow1: string;
    hostedTelemetryHow2: string;
    hostedTelemetryHow3: string;
    hostedTelemetryHow4: string;
    hostedTelemetryViewProof: string;

    /** Self-host telemetry status text when `gateway` returns no data. */
    sectionTelemetryStatusUnknown: string;

    /** Account-deletion banner. */
    deletionScheduledTitle: string;
    deletionScheduledBodyPrefix: string;
    deletionScheduledBodyMid: string;
    deletionScheduledBodyDay: string;
    deletionScheduledBodyDays: string;
    deletionScheduledBodySuffix: string;
    deletionCancelBtn: string;

    /** No-keys empty body inside provider keys card. */
    noKeysTitle: string;
    noKeysBody: string;
    noKeysBodyMid: string;
    noKeysHint: string;

    /** Custom-providers table extras. */
    customColName: string;
    customColPrefix: string;
    customColBaseUrl: string;
    customColKey: string;
    customColStatus: string;
    customNoAuth: string;
    customEnabledPill: string;
    customDisabledPill: string;
    customEnableBtn: string;
    customDisableBtn: string;
    customDeleteBtn: string;

    /** Cache "disabled" empty pill in sysIntegrations. */
    sysCacheDisabled: string;
    /** Baseline "disabled" empty pill in sysIntegrations. */
    sysBaselineDisabled: string;

    /** Crypto detail labels in sysIntegrations. */
    sysCryptoAws: string;
    sysCryptoGcp: string;
    sysCryptoEnvMaster: string;

    /** Provider keys card "no keys yet" hint. */
    providerKeysNoneTitle: string;
    providerKeysNoneBody1: string;
    providerKeysNoneBody2: string;
    providerKeysNoneHint: string;
    providerColLastErrorPrefix: string;

    /** "Test passed/failed" pills + provider table relative-time. */
    providerHealthTestOk: string;
    providerHealthTestFail: string;

    /** "Next digest:" hint in email preferences. */
    emailNextDigestPrefix: string;
    emailNextDigestSuffix: string;
    emailNeverSentHosted: string;
    emailNeverSentSelfHost: string;

    /** Provider usage cell sub-text. */
    providerUsageReqSingular: string;
    providerUsageReqPlural: string;

    yourProviderKeysTitle: string;
    yourProviderKeysCount: string;
    yourProviderKeysAddAnother: string;
    providerColProvider: string;
    providerColKey: string;
    providerColUsage30d: string;
    providerColHealth: string;
    providerColUpdated: string;
    providerHealthNoTraffic: string;
    /** "✓ used {ago}" / "{ago}已使用" */
    providerHealthUsedPrefix: string;
    providerActionTest: string;
    providerActionDelete: string;

    quotaTitle: string;
    quotaSubtitle: string;
    quotaIntro: string;
    quotaColProvider: string;
    quotaCol24h: string;
    quotaCol30d: string;
    quotaColSuggested: string;
    quotaColRisk: string;
    quotaRiskOk: string;
    quotaRiskNoTraffic: string;
    quotaRiskOkBody: string;
    quotaRiskNoTrafficBody: string;
    quotaFooter: string;

    addProviderTitle: string;
    addProviderSubtitle: string;
    addProviderKeyPlaceholder: string;
    addProviderSaveCta: string;
    addProviderCustomBaseUrl: string;
    addProviderCustomBaseUrlHelp: string;
    addProviderRoutingHint: string;
    addProviderStorageHint: string;

    rejectedTitle: string;
    rejectedSubtitle: string;
    rejectedIntro: string;
    rejectedColModel: string;
    rejectedColReason: string;
    rejectedColProvider: string;
    rejectedColHits: string;
    rejectedColProjects: string;
    rejectedColLastSeen: string;
    rejectedActionRegister: string;
    rejectedActionAddKey: string;

    customTitle: string;
    customCount: string;
    customIntro: string;
    customNamePlaceholder: string;
    customPrefixPlaceholder: string;
    customBaseUrlPlaceholder: string;
    customApiKeyPlaceholder: string;
    customRegisterCta: string;
    customWireFormatHint: string;
    customPricingHint: string;
    customResolutionHint: string;

    sysIntegrationsTitle: string;
    sysIntegrationsSource: string;
    sysIntegrationsCol1: string;
    sysIntegrationsCol2: string;
    sysIntegrationsCol3: string;
    sysFailoverTitle: string;
    sysFailoverStatusEmpty: string;
    sysFailoverHint: string;
    sysMultiKeyTitle: string;
    sysMultiKeySingle: string;
    sysMultiKeyHint: string;
    sysOtelTitle: string;
    sysOtelStatusEmpty: string;
    sysOtelHint: string;
    sysQualityEmbedTitle: string;
    sysQualityEmbedStatusEmpty: string;
    sysQualityEmbedHint: string;
    sysByoEncTitle: string;
    sysByoEncStatusEmpty: string;
    sysByoEncHint: string;
    sysCacheTitle: string;
    sysCacheMaxEntries: string;
    sysCacheTtl: string;
    sysCacheSimThreshold: string;
    sysCacheHint: string;
    sysBaselineTitle: string;
    sysBaselineVersion: string;
    sysBaselineBuckets: string;
    sysBaselineHint: string;

    emailPrefsTitle: string;
    emailWeeklyTitle: string;
    emailWeeklyBody: string;
    emailLastSentPrefix: string;
    emailOperatorNote: string;
    emailSubscribeBtn: string;
    emailUnsubscribeBtn: string;
    emailSubscribed: string;
    emailUnsubscribed: string;

    privacyTitle: string;
    privacySubtitle: string;
    privacyExportTitle: string;
    privacyExportBody: string;
    privacyExportCta: string;
    privacyDeleteTitle: string;
    privacyDeleteBody: string;
    privacyDeleteConfirmHint: string;
    privacyDeletePlaceholder: string;
    privacyDeleteSchedule: string;

    /** Tooltips for tiny status pills + masked-key chips in the providers table. */
    apiKeyHashedAtRestTooltip: string;
    providerLastErrorTooltip: string;
    providerLastSuccessTooltip: string;
    /** Tooltip on the custom-provider model_prefix input. */
    customPrefixTooltip: string;
  };

  // -----------------------------------------------------------------------
  // Projects list (`/projects`) + per-project shell
  // -----------------------------------------------------------------------
  projects: {
    listTitle: string;
    listTagline: string;
    createButton: string;
    namePlaceholder: string;
    emptyTitle: string;
    emptyBody: string;
    providerJustSavedTitle: string;
    providerJustSavedBody: string;
    providerJustSavedCta: string;
    cardCreated: string;
    cardOpen: string;
    cardDelete: string;
    confirmDelete: string;

    /** Fast-path POC card on the projects list page. */
    fastPathTitle: string;
    fastPathBody: string;
    fastPathCreateBtn: string;
    fastPathAddKeyBtn: string;

    /** Projects table column headers. */
    listColName: string;
    listColCreated: string;
    listColProjectId: string;
    listDeleteTitle: string;
    sidebarBackAll: string;
    sidebarGroupConfigure: string;
    sidebarGroupReference: string;
    sidebarApiKeys: string;
    sidebarBudgets: string;
    sidebarRouting: string;
    sidebarAlerts: string;
    sidebarTemplates: string;
    sidebarTags: string;
    sidebarPolicy: string;
    sidebarSetup: string;
    sidebarGettingStarted: string;
    sidebarAriaLabel: string;
    sidebarMainTitleFallback: string;

    /** "New key" reveal banner shown after createApiKeyAction. */
    revealHeading: string;
    revealBody: string;
    revealUseInAgent: string;
    revealOrCopyCurl: string;
    revealCopyCurlBtn: string;
    revealOpenDashboard: string;

    /** Get-started card. */
    gettingStartedTitle: string;
    gettingStartedHeaderHint: string;
    gettingStartedBody: string;
    gettingStartedKeyNamePlaceholder: string;
    gettingStartedCreateBtn: string;
    gettingStartedFreshKeyName: string;
    gettingStartedFreshBtn: string;
    gettingStartedAlreadySent: string;
    gettingStartedExistingHint: string;
    gettingStartedTemplateHint: string;

    /** Setup instructions section. */
    setupTitle: string;
    setupHeaderHint: string;

    /** API keys card. */
    apiKeysTitle: string;
    apiKeysNamePlaceholder: string;
    apiKeysNewBtn: string;
    apiKeysEmpty: string;
    apiKeysColName: string;
    apiKeysColKey: string;
    apiKeysColCreated: string;
    apiKeysColLastUsed: string;
    apiKeysLastUsedNever: string;
    apiKeysGracePrefix: string;
    apiKeysGraceExpiresHM: string;
    apiKeysGraceExpiresM: string;
    apiKeysRotateBtn: string;
    apiKeysRotateTitle: string;
    apiKeysDeleteBtn: string;
    apiKeysDeleteNowBtn: string;
    apiKeysDeleteNowTitle: string;
    apiKeysFootnote: string;
    /** Tooltip on the masked-key code chip in the API keys table. */
    apiKeysHashedAtRestTooltip: string;

    /** Tags card. */
    tagsTitle: string;
    tagsCopyHeaderBtn: string;

    /** Templates card. */
    templatesTitle: string;
    templatesManageBtn: string;

    /** Budgets card. */
    budgetsTitle: string;
    budgetsActiveSuffix: string;
    budgetsEmpty: string;
    budgetsColPeriod: string;
    budgetsColLimit: string;
    budgetsColStatus: string;
    budgetsColUpdated: string;

    /** Routing rules card. */
    routingTitle: string;
    routingPolicyChangelog: string;
    routingClassifierChangelog: string;
    /** `title=` tooltip on the routing policy / classifier changelog header links. */
    routingPolicyChangelogTooltip: string;
    routingClassifierChangelogTooltip: string;
    routingConfiguredSuffix: string;
    routingEmpty: string;
    routingColMode: string;
    routingColFromPattern: string;
    routingColToModel: string;
    routingColShadow: string;
    routingColThreshold: string;
    routingColSample: string;
    routingColStatus: string;

    /** Alerts card. */
    alertsTitle: string;
    alertsSubscribedSuffix: string;
    alertsEmpty: string;
    alertsColNotifyWhen: string;
    alertsColSendTo: string;
    alertsColEmail: string;
    alertsColStatus: string;
    alertsColCreated: string;
    alertsStatusEnabled: string;
    alertsStatusDisabled: string;
    alertsDeleteBtn: string;
    alertsEmailOk: string;
    alertsEmailOkFromPrefix: string;
    alertsEmailNotConfigured: string;
    alertsEmailSelfHostSummary: string;
    alertsEmailSelfHostBody: string;
    alertsFooter: string;
    alertsTestBtn: string;

    /** Setup instructions body. */
    setupBody: string;
    setupResolveTitle: string;
    setupResolve1Title: string;
    setupResolve1Body: string;
    setupResolve2Title: string;
    setupResolve2BodyPrefix: string;
    setupResolve2BodyLink: string;
    setupResolve2BodySuffix: string;
    setupResolve3Title: string;
    setupResolve3BodyPrefix: string;
    setupResolve3BodyLink1: string;
    setupResolve3BodyMid: string;
    setupResolve3BodyLink2: string;
    setupResolve3BodySuffix: string;
    setupResolve4Title: string;
    setupResolve4Body: string;
    setupPrincipleBodyPrefix: string;
    setupPrincipleBodyLink: string;
    setupPrincipleBodySuffix: string;

    /** Tags hint body + helper labels. */
    tagsBodyPrefix: string;
    tagsBodyMid: string;
    tagsBodySuffix: string;
    tagsExampleCurl: string;
    tagsExamplePythonSdk: string;
    tagsCommonDimsPrefix: string;
    tagsCommonDimsSeparator: string;
    tagsCommonDimsSuffix: string;
    tagsFrameworksHintPrefix: string;
    tagsFrameworksHintLink: string;
    tagsFrameworksHintSuffix: string;

    /** Templates hint body. */
    templatesBodyPrefix: string;
    templatesBodyMid: string;
    templatesBodySuffix: string;
    templatesVarsHintPrefix: string;
    templatesVarsHintMid1: string;
    templatesVarsHintMid2: string;
    templatesVarsHintMid3: string;
    templatesVarsHintMid4: string;
    templatesVarsHintMid5: string;
    templatesVarsHintSuffix: string;

    /** Smoke-pair summary (asked → routed pair). */
    smokeIntroPrefix: string;
    smokeIntroFamilyMid: string;
    smokeIntroBucketMid: string;
    smokeIntroBucketSuffix: string;
    smokeKeyDirectPrefix: string;
    smokeKeyDirectSuffix: string;
    smokeRouteDownPrefix: string;
    smokeSameFamilyNote: string;
    smokeSavingsSuffix: string;

    /** No-routable-demo hint card. */
    noRoutableTitle: string;
    noRoutableNoKey: string;
    noRoutableNoneInPolicy: string;
    noRoutableBody: string;
    noRoutableUnlockPrefix: string;
    noRoutableUnlockOr: string;
    noRoutableUnlockComma: string;
    noRoutableAddBtn: string;

    /** Policy mini card on the project home. */
    policyTitle: string;
    policyChangelogLink: string;
    policyActiveLabel: string;
    policyShippedBaseline: string;
    policyTrainedSamplesPrefix: string;
    policyTrainedSamplesSingular: string;
    policyTrainedSamplesPlural: string;
    policyNoActive: string;
    policyNeverTrained: string;
    policySaved30dLabel: string;
    policySaved30dNote: string;
    policyLearningLabel: string;
    policyLearningOn: string;
    policyLearningPaused: string;
    policyLearningOnNote: string;
    policyLearningFrozen: string;
    policyLearningEmptyNote: string;
    policyShadowSetupBodyPrefix: string;
    policyShadowSetupRoutingLink: string;
    policyShadowSetupMid: string;
    policyShadowSetupPolicyLink: string;
    policyShadowSetupSuffix: string;
  };

  // -----------------------------------------------------------------------
  // Settings (`/settings`) — Account & keys, BYO providers, weekly digest
  // -----------------------------------------------------------------------
  settings: {
    title: string;
    tagline: string;
    sectionByoProviders: string;
    byoIntro: string;
    byoEnabledHelp: string;
    byoDisabledHelp: string;
    byoSavedAt: string;
    byoTestPass: string;
    byoTestFail: string;
    byoTesting: string;
    byoTestNever: string;
    apiKeyLabel: string;
    apiKeyPlaceholder: string;
    apiKeyEnabledLabel: string;
    saveProvider: string;
    deleteProvider: string;
    confirmDeleteProvider: string;
    sectionWeeklyDigest: string;
    weeklyDigestIntro: string;
    weeklyDigestEnabled: string;
    weeklyDigestDay: string;
    sectionDangerZone: string;
    dangerExportTitle: string;
    dangerExportBody: string;
    dangerExportCta: string;
    dangerDeleteTitle: string;
    dangerDeleteBody: string;
    dangerDeleteCta: string;
    dangerDeleteCancel: string;
    accountDeletedBanner: string;
  };

  // -----------------------------------------------------------------------
  // Agents (`/agents` + `/agents/[agent]/[session]`)
  // -----------------------------------------------------------------------
  agents: {
    title: string;
    tagline: string;
    backDashboard: string;
    emptyTitle: string;
    emptyBody: string;
    columnAgent: string;
    columnSession: string;
    columnTurns: string;
    columnSpend: string;
    columnLast: string;
    sessionTitle: string;
    sessionBackAll: string;
    sessionTurns: string;
    sessionOk: string;
    sessionErr: string;
    sessionTools: string;
    sessionSpent: string;
    sessionElapsed: string;
  };

  // -----------------------------------------------------------------------
  // Requests detail (`/requests/[id]`)
  // -----------------------------------------------------------------------
  requests: {
    title: string;
    backDashboard: string;
    sectionPromptMessages: string;
    sectionAssistantText: string;
    sectionRouting: string;
    sectionReplay: string;
    emptyMessages: string;
    askedModel: string;
    landedModel: string;
    routingReason: string;
    cost: string;
    saved: string;
    latency: string;
    inputTokens: string;
    outputTokens: string;
    totalTokens: string;
    projectName: string;
    sessionId: string;
    turnId: string;
    agentName: string;
    channel: string;
    requestId: string;

    /** Database failure card. */
    dbErrTitle: string;

    /** Routed-down callout. */
    routedTitle: string;
    routedSavedPill: string;
    routedReplaceBody: string;
    routedLockHeader: string;
    routedLockButton: string;

    /** Stat grid. */
    statCost: string;
    statInputTokens: string;
    statInputCachedSuffix: string;
    statOutputTokens: string;
    statLatency: string;
    statProjectKey: string;
    statFingerprint: string;

    /** Replay card. */
    replayTitle: string;
    replayHeaderHint: string;
    replayIntroPrefix: string;
    replayIntroMid: string;
    replayIntroSuffix: string;
    replayModelPlaceholder: string;
    replayButton: string;
    replaySetupPill: string;
    replaySetupBody: string;
    replaySetupStep1: string;
    replaySetupStep2Prefix: string;
    replaySetupStep2Same: string;
    replaySetupStep2Mid: string;
    replaySetupStep2Both: string;
    replaySetupStep2Suffix: string;
    replaySetupStep3Prefix: string;
    replaySetupStep3Suffix: string;
    replaySetupFooter: string;

    /** Loop timeline card. */
    loopTimelineTitle: string;
    loopTimelineCallsSuffix: string;
    loopTimelineSpanSuffix: string;
    loopTimelineTotalSuffix: string;
    loopTimelineBlockedSuffix: string;
    loopTimelineBody: string;
    /** SVG aria-label template — `{n}` is the number of ticks rendered. */
    loopTimelineAriaTpl: string;

    /** Error card. */
    errorTitle: string;

    /** Prompt + response sections. */
    rawRequestBody: string;
    rawResponseBody: string;
    emptyResponseBody: string;
  };

  // -----------------------------------------------------------------------
  // Agents session detail (`/agents/[agent]/[session]`)
  // -----------------------------------------------------------------------
  agentSession: {
    /** Header summary line — uses {requests} {ok} {err} {tools} {observed} {spent} {tokensIn} {tokensOut} {elapsed} {when} */
    summary: string;
    requestsSingular: string;
    requestsPlural: string;
    statusOk: string;
    statusLoop: string;
    statusBudget: string;
    statusPlan: string;
    statusError: string;
    /** Table column headers. */
    colIndex: string;
    colTurn: string;
    colModel: string;
    colStatus: string;
    colInOut: string;
    colCost: string;
    colLatency: string;
    colTools: string;
    colWhen: string;
    /** Cell text. */
    cellCachedSuffix: string;
    cellToolCalled: string;
    cellToolDeclared: string;
    cellToolNoneTitle: string;
    /** Title attributes. */
    titleObservedTools: string;
    titleObservedFinish: string;
    titleDeclaredTools: string;
    titleDeclaredArray: string;
    titleCachedTokens: string;
    /** "view →" cell link label. */
    viewLink: string;
    /** Bottom error section. */
    nonSuccessTitle: string;
  };

  // -----------------------------------------------------------------------
  // Billing (`/billing`)
  // -----------------------------------------------------------------------
  billing: {
    title: string;
    tagline: string;
    sectionCurrentPlan: string;
    planLabel: string;
    upgradeCta: string;
    manageSubscription: string;
    sectionSavings: string;
    savingsBody: string;
    sectionTransfers: string;
    transfersEmpty: string;
    transferCancel: string;
    usageDailyLabel: string;
    usageMonthlyLabel: string;
    usageUnlimited: string;

    /** Pro-payback hero card. */
    paybackTitle: string;
    paybackPaysThisWeek: string;
    paybackPaysIn: string;
    paybackKeepProving: string;
    paybackRunFirst: string;
    paybackBodyPrefix: string;
    paybackBodyMid: string;
    paybackBodySuffix: string;
    paybackComparePlans: string;
    paybackSendFirst: string;
    paybackEstimate: string;
    paybackLast30: string;
    paybackRoutedSuffix: string;
    paybackCacheSingular: string;
    paybackCachePlural: string;

    /** "Why teams pay for hosted" card. */
    whyTitle: string;
    why1Title: string;
    why1Body: string;
    why2Title: string;
    why2Body: string;
    why3Title: string;
    why3Body: string;
    why4Title: string;
    why4Body: string;
    why5Title: string;
    why5BodyPrefix: string;
    why5BodyLink: string;
    why5BodySuffix: string;
    why6Title: string;
    why6Body: string;
    whyEstimateLink: string;

    /** "Who should not pay yet" card. */
    notYetTitle: string;
    notYet1Title: string;
    notYet1BodyPrefix: string;
    notYet1BodyLink: string;
    notYet1BodySuffix: string;
    notYet2Title: string;
    notYet2Body: string;
    notYet3Title: string;
    notYet3BodyLink1: string;
    notYet3BodyMid: string;
    notYet3BodyLink2: string;
    notYet3BodySuffix: string;
    notYet4Title: string;
    notYet4Body: string;

    /** Pricing roadmap card. */
    roadmapTitle: string;
    roadmapBodyPrefix: string;
    roadmapBodyCode: string;
    roadmapBodySuffix: string;
    roadmapPro: string;
    roadmapTeam: string;
    roadmapScale: string;
    roadmapScaleNote: string;
    roadmapAfterBody: string;
    roadmapTransitionFootnote: string;

    /** Reliability card. */
    reliabilityTitle: string;
    reliabilityBodyPrefix: string;
    reliabilityBodyLink: string;
    reliabilityBodySuffix: string;

    /** Checkout status banners. */
    checkoutSuccess: string;
    checkoutCancelled: string;

    /** Stripe-not-configured banners. */
    stripeMissingHosted: string;
    stripeMissingSelfHostPrefix: string;
    stripeMissingSelfHostSuffix: string;

    /** Billing transfers. */
    transferTitleSender: string;
    transferTitleReceiver: string;
    transferExpiresPrefix: string;
    transferSenderBodyPrefix: string;
    transferSenderBodyMid: string;
    transferSenderBodySuffix: string;
    transferSenderHeadsUp: string;
    transferSenderExpireSuffix: string;
    transferReceiverBodyPrefix: string;
    transferReceiverBodyMid: string;
    transferReceiverBodySuffix: string;
    transferCancelButton: string;

    /** Current-plan + usage card. */
    currentPlanH3: string;
    currentPlanPriceSuffix: string;
    currentPlanLimitsLabel: string;
    usageDailyMeterLabel: string;
    usageMonthlyMeterLabel: string;
    usageMonthlyDenomSuffix: string;
    usageNearCapBody: string;
    manageSubscriptionBtn: string;

    /** Plans grid. */
    plansHeading: string;
    plansFreeForever: string;
    plansAnnualSuffix: string;
    plansBucketSeparator: string;
    plansCurrentPill: string;
    plansCurrentPlanBtn: string;
    plansUpgradeBtn: string;
    plansFreeYouAreHere: string;
    plansDowngradeViaPortal: string;
    plansBillingNotConfigured: string;
    plansEnterprisePricing: string;
    plansEnterpriseBilateral: string;
    plansEnterpriseContact: string;
    planCards: {
      freeTagline: string;
      freeFeatures: string[];
      proTagline: string;
      proFeatures: string[];
      teamTagline: string;
      teamFeatures: string[];
      scaleTagline: string;
      scaleFeatures: string[];
      enterpriseName: string;
      enterpriseTagline: string;
      enterpriseFeatures: string[];
    };

    /** Discounts + cancellation note. */
    discountsBodyPrefix: string;
    discountsBodyLink: string;
    discountsBodySuffix: string;
    cancellationsBody: string;

    /** Helper labels. */
    limitUnlimited: string;
    limitDailyTpl: string;
    limitMonthlyTpl: string;
  };

  // -----------------------------------------------------------------------
  // Organization list (`/organization`) — Settings → Team landing
  // -----------------------------------------------------------------------
  organization: {
    tagline: string;
    dbErrTitle: string;
    pendingTitle: string;
    invitedByPrefix: string;
    invitedByExpires: string;
    acceptBtn: string;
    yourTeamsTitle: string;
    teamsCountSingular: string;
    teamsCountPlural: string;
    emptyTitle: string;
    emptyBody1: string;
    emptyBody2: string;
    colName: string;
    colRole: string;
    colMembers: string;
    colJoined: string;
    createTitle: string;
    createOwnerNote: string;
    createPlanRequiredSuffix: string;
    createNamePlaceholder: string;
    createBtn: string;
    createGatedBodyPrefix: string;
    createGatedBodyMid: string;
    createGatedBodyPlanLink: string;
    createGatedBodySuffix: string;
  };

  // -----------------------------------------------------------------------
  // Invite acceptance (`/organization/accept?token=…`) — first-run path
  // for new teammates clicking the email link. Small surface (~140 lines)
  // but very high impact: it's the first dashboard page they see.
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Referrals (`/referrals`) — invite-friends program. Operator-only
  // settle controls intentionally STAY English; this section covers the
  // user-facing pieces (link, stats, history table, program rules).
  // -----------------------------------------------------------------------
  referrals: {
    /** Hero tagline. Templates `{commission}` (e.g. "20%") and
     *  `{annualCap}` (e.g. "$1,197") so the same sentence can adapt
     *  if the program rules ever change. */
    taglinePrefix: string;
    taglineCommission: string;
    taglineMid: string;
    taglineAnnualCap: string;
    taglineSuffix: string;
    /** Database-failure card. */
    dbErrTitle: string;
    /** "Your referral link" card. */
    linkTitle: string;
    linkEmptyBody: string;
    linkGenerateBtn: string;
    linkYourCode: string;
    linkShareHelp: string;
    /** Stat tiles. */
    statSignedUp: string;
    statSignedUpPayingSuffix: string;
    statTotalEarned: string;
    statPending: string;
    statPendingSubLabel: string;
    /** "Referred by …" banner shown when the user themselves was
     *  referred. `{commission}` substituted. */
    referredByPrefix: string;
    referredBySuffix: string;
    /** Credit history card + table. */
    historyTitle: string;
    historyRowsSingular: string;
    historyRowsPlural: string;
    historyEmptyTitle: string;
    historyEmptyBody: string;
    historyTipPrefix: string;
    historyTipPlaceholder: string;
    historyTipSuffix: string;
    historyColDate: string;
    historyColReferee: string;
    historyColInvoice: string;
    historyColCommission: string;
    historyColStatus: string;
    historyStatusCredited: string;
    historyStatusPending: string;
    historyStatusCreditedTooltip: string;
    historyStatusPendingTooltip: string;
    /** "Program rules" footer. */
    rulesTitle: string;
    rule1Prefix: string;
    rule1Commission: string;
    rule1Suffix: string;
    rule2Prefix: string;
    rule2Cap: string;
    rule2Suffix: string;
    rule3: string;
    rule4: string;
    rule5: string;
    rule6: string;
  };

  inviteAccept: {
    /** Generic page title used while we don't yet know which org. */
    pageTitle: string;
    /** Token-not-found state. */
    notFoundTitle: string;
    notFoundBody: string;
    backToOrgs: string;
    /** Already-accepted state. */
    alreadyAcceptedTitle: string;
    alreadyAcceptedBodyPrefix: string;
    alreadyAcceptedBodySuffix: string;
    openOrgBtn: string;
    /** Expired state. `{date}` is the localised expiry date. */
    expiredTitle: string;
    expiredBodyTpl: string;
    /** Live invite. `{org}` is the organization name; `{role}` is the
     *  role (kept English — `admin` / `member` / `viewer` ARE the API
     *  values). */
    joinTitleTpl: string;
    introBodyPrefix: string;
    introBodyMid: string;
    introBodySuffix: string;
    /** Three info rows above the Accept button. */
    rowInvitedLabel: string;
    rowSignedInLabel: string;
    rowInvitedByLabel: string;
    /** Email-mismatch warning shown when the signed-in user's email
     *  doesn't match the invite. `{signedIn}` and `{invited}` are
     *  substituted with the two emails. */
    emailMismatchTitle: string;
    emailMismatchBodyPrefix: string;
    emailMismatchBodyMid: string;
    emailMismatchBodySuffix: string;
    /** Button label. */
    acceptBtn: string;
  };

  // -----------------------------------------------------------------------
  // Team admin (`/organization/[id]`) — members, pending invitations,
  // invite form, SAML SSO config, transfer ownership. The largest single
  // surface in the app. Roles (admin/member/viewer/owner) and SSO mode
  // values (off/optional/required) stay in English because they ARE
  // the API values used by the gateway and the URL-driven actions.
  // -----------------------------------------------------------------------
  organizationDetail: {
    /** Header strip. */
    backToList: string;
    yourRoleLabel: string;
    cantManageNote: string;

    /** Members card. */
    membersTitle: string;
    membersActiveSuffix: string;
    membersPendingSuffix: string;
    /** "{used}/{cap} seats ({plan})" */
    membersSeatsTpl: string;
    memberColEmail: string;
    memberColRole: string;
    memberColJoined: string;
    memberSelfBadge: string;
    memberSaveRoleBtn: string;
    memberRemoveBtn: string;

    /** Pending invitations card. */
    invitesTitle: string;
    invitesPendingSuffix: string;
    invitesEmpty: string;
    inviteColEmail: string;
    inviteColRole: string;
    inviteColInvitedBy: string;
    inviteColExpires: string;
    inviteResendBtn: string;
    inviteResendTooltip: string;
    inviteRevokeBtn: string;

    /** Invite-new-member form. */
    inviteFormTitle: string;
    inviteFormSeatLimitPill: string;
    inviteFormSeatLimitBodyPrefix: string;
    inviteFormSeatLimitBodyMid: string;
    inviteFormSeatLimitBodySuffix: string;
    inviteFormBillingLink: string;
    inviteFormEmailPlaceholder: string;
    inviteFormSendBtn: string;
    /** Roles-help footer. Keeps the role names (admin/member/viewer)
     *  in English so they match dropdowns + API. */
    inviteFormRolesHelpPrefix: string;
    inviteFormRolesHelpAdminBody: string;
    inviteFormRolesHelpMemberBody: string;
    inviteFormRolesHelpViewerBody: string;
    inviteFormRolesHelpOwnerHint: string;
    /** Delivery-mechanism help line. */
    inviteFormDeliveryHelpPrefix: string;
    inviteFormDeliveryHelpSuffix: string;

    /** SSO/SAML card. */
    ssoTitle: string;
    ssoModeLabel: string;
    ssoPlanRequiredSuffix: string;
    ssoPlanGatedBodyPrefix: string;
    ssoPlanGatedBodyMid1: string;
    ssoPlanGatedBodyMid2: string;
    ssoPlanGatedBodyDocsPrefix: string;
    ssoPlanGatedBodyDocsLinkText: string;
    ssoPlanGatedBodyDocsSuffix: string;
    /** Read-only banner shown to non-admins. `{mode}` is the literal
     *  off / optional / required value. */
    ssoReadOnlyPrefix: string;
    ssoReadOnlyDomainSuffix: string;
    ssoReadOnlyAdminNote: string;
    /** Editor body. */
    ssoIdpHelpBody: string;
    ssoAcsLabel: string;
    ssoEntityIdLabel: string;
    ssoEnforcementLabel: string;
    ssoEnforcementOff: string;
    ssoEnforcementOptional: string;
    ssoEnforcementRequired: string;
    ssoEmailDomainLabel: string;
    ssoEmailDomainPlaceholder: string;
    ssoJitDefaultRoleLabel: string;
    ssoMetadataXmlLabel: string;
    ssoMetadataXmlPlaceholder: string;
    ssoManualToggleLabel: string;
    ssoIdpEntityIdLabel: string;
    ssoIdpEntityIdPlaceholder: string;
    ssoIdpSsoUrlLabel: string;
    ssoIdpSsoUrlPlaceholder: string;
    ssoIdpCertLabel: string;
    ssoSaveBtn: string;
    ssoTestLoginBtn: string;
    /** Long footnote about reference IdPs. */
    ssoReferenceTitle: string;
    ssoReferenceBodyPrefix: string;
    ssoReferenceBodyLinkText: string;
    ssoReferenceBodySuffix: string;

    /** Transfer ownership card. */
    transferTitle: string;
    transferOwnerOnlyPill: string;
    transferBodyPrefix: string;
    transferBodyMid1: string;
    transferBodyMid2: string;
    transferBodyMid3: string;
    transferBillingLink: string;
    transferBodySuffix: string;
    transferConfirmCodeWord: string;
    transferSelectPlaceholder: string;
    transferConfirmPlaceholderTpl: string;
    transferSubmitBtn: string;
    transferBillingLabel: string;
    transferBillingBodyPrefix: string;
    transferBillingBodyMid: string;
    transferBillingBodySuffix: string;
  };

  // -----------------------------------------------------------------------
  // Audit log (`/audit`) — operator/compliance surface for account and
  // org-scoped audit events. Event ids, metadata keys, target types, and
  // DB enum values stay literal because they are machine-readable audit
  // facts. Surrounding chrome, filters, buttons, and helper copy localise.
  // -----------------------------------------------------------------------
  audit: {
    tagline: string;
    scopeLabel: string;
    scopePersonal: string;
    /** Tooltip for org-wide scope selector. `{name}` and `{role}` are substituted. */
    scopeOrgTitleTpl: string;
    scopeOrgSuffix: string;
    dbErrTitle: string;
    recentTitle: string;
    eventSingular: string;
    eventPlural: string;
    filteredSuffix: string;
    exportCsvBtn: string;
    exportCsvTitle: string;
    exportJsonBtn: string;
    exportJsonTitle: string;
    exportGatedBtnTpl: string;
    exportGatedTitleTpl: string;
    filterEventLabel: string;
    filterAllEvents: string;
    filterSinceLabel: string;
    filterUntilLabel: string;
    filterApplyBtn: string;
    filterClearBtn: string;
    emptyBody: string;
    colTime: string;
    colEvent: string;
    colProject: string;
    colTarget: string;
    colDetails: string;
    ipPrefix: string;
  };

  // -----------------------------------------------------------------------
  // Prompt templates (`/projects/[id]/templates` + per-template detail).
  // The list page lets you create new templates / new versions; the
  // detail page shows the active body, version history, and the runtime
  // hint. Both share back-link + table headers, so we keep a single
  // section. Variable names (`{{var}}`), header names (`x-ts-template`)
  // and CLI snippets stay in English — they ARE the API surface.
  // -----------------------------------------------------------------------
  promptTemplates: {
    /** List page header. */
    title: string;
    tagline: string;
    dbErrTitle: string;

    /** "Your templates" card. */
    yourTitle: string;
    countSingular: string;
    countPlural: string;
    emptyTitle: string;
    emptyBodyPrefix: string;
    emptyBodyMid: string;
    emptyBodySuffix: string;
    /** Table headers. */
    colName: string;
    colActiveVersion: string;
    colVersions: string;
    colUpdated: string;
    openBtn: string;

    /** Create / append form. */
    formTitle: string;
    formReusing: string;
    formNameLabel: string;
    formNamePlaceholder: string;
    formDescriptionLabel: string;
    formDescriptionPlaceholder: string;
    formBodyLabel: string;
    formBodyPlaceholder: string;
    formNoteLabel: string;
    formNotePlaceholder: string;
    formSaveBtn: string;
    formSyntaxHintPrefix: string;
    formSyntaxHintSuffix: string;

    /** Runtime usage card. */
    runtimeTitle: string;
    runtimeHeaderHint: string;
    runtimeBody: string;
    runtimeBullet1Prefix: string;
    runtimeBullet1Mid: string;
    runtimeBullet1Suffix: string;
    runtimeBullet2Prefix: string;
    runtimeBullet2Mid: string;
    runtimeBullet2Suffix: string;
    runtimeBullet3: string;
    runtimeBullet4Prefix: string;
    runtimeBullet4Mid: string;
    runtimeBullet4Suffix: string;
    runtimeTagBy: string;

    /** Detail page (per-template). */
    detailBackBtn: string;
    detailVersionsCountSingular: string;
    detailVersionsCountPlural: string;
    /** "Active version (v{n})" — `{n}` substituted at render time. */
    detailActiveVersionTpl: string;
    detailCopyBodyLabel: string;
    detailEmptyBody: string;
    detailAppendTitle: string;
    /** "Will be v{n}" / "保存为 v{n}". */
    detailAppendNextVersionTpl: string;
    detailAppendSubmitTpl: string;
    detailAppendNotePlaceholder: string;
    detailHistoryTitle: string;
    detailHistoryNewestFirst: string;
    detailHistoryEmpty: string;
    detailHistoryActivePill: string;
    detailHistoryByPrefix: string;
    detailHistoryPinTitle: string;
    detailHistoryPinBtn: string;
    detailDangerTitle: string;
    detailDangerBody: string;
    /** "Delete {name} permanently". */
    detailDeleteSubmitTpl: string;
  };

  // -----------------------------------------------------------------------
  // Routing policy (`/projects/[id]/policy`) — per-project policy
  // changelog + learning controls. Engineering-heavy page; CLI snippets
  // and column shortnames stay verbatim. Status pill labels (active /
  // pending / superseded / rejected) and source values stay English
  // because they're DB enum values surfaced one-to-one.
  // -----------------------------------------------------------------------
  routingPolicy: {
    title: string;
    tagline: string;
    /** Active card. */
    activeTitle: string;
    pauseLearningBtn: string;
    resumeLearningBtn: string;
    pauseTooltip: string;
    resumeTooltip: string;
    /** "Background training requires the {plan} plan." */
    upgradeRequiredTooltipTpl: string;
    /** "activated {date} · trained on {n} sample(s)" — `{date}` is the
     *  localised activation timestamp; `{n}` is the formatted sample
     *  count; `{noun}` is "sample" / "samples" (EN switches by count,
     *  CN uses 个样本 always). */
    activeStatusTpl: string;
    activeSampleSingular: string;
    activeSamplePlural: string;
    learningStatusPrefix: string;
    learningStatusOn: string;
    learningStatusOff: string;
    learningOnNote: string;
    learningPausedNote: string;
    /** Empty active state. */
    noActiveBodyPrefix: string;
    noActiveStep1Prefix: string;
    noActiveStep1Link: string;
    noActiveStep1Mid: string;
    noActiveStep1Mode1: string;
    noActiveStep1Or: string;
    noActiveStep1Mode2: string;
    noActiveStep1Sample: string;
    noActiveStep1ChipPrefix: string;
    noActiveStep1ChipSuffix: string;
    noActiveStep1CliPrefix: string;
    noActiveStep1CliSuffix: string;
    noActiveStep2Prefix: string;
    noActiveStep2Mid: string;
    noActiveStep2Suffix: string;
    /** DB error card (shared shape). */
    dbErrTitle: string;
    /** History card. */
    historyTitle: string;
    historyVersionsSingular: string;
    historyVersionsPlural: string;
    historyEmpty: string;
    colVersion: string;
    colStatus: string;
    colSource: string;
    colSamples: string;
    colNotes: string;
    colGenerated: string;
    /** "Rollback to v{n}" — `{n}` substituted at render time. */
    rollbackBtnTpl: string;
    /** "Promote v{n} back to active. A new version will be created with
     *  source=rollback to keep the audit trail." */
    rollbackTooltipReadyTpl: string;
    /** "Rollback requires the {plan} plan." */
    rollbackTooltipGatedTpl: string;
    /** "How retraining works" card. */
    howTitle: string;
    howBody1: string;
    howBody2Prefix: string;
    howBody2Suffix: string;
    /** Learning cost card. */
    costTitle: string;
    costSubLabel: string;
    costMtdLabel: string;
    costMtdShadowSingular: string;
    costMtdShadowPlural: string;
    costTrailing30dLabel: string;
    costTrailing30dAvgPrefix: string;
    costTrailing30dAvgSuffix: string;
    /** "Daily shadow cost over the trailing 30 days (oldest → newest).
     *  Peak: {peak} on a single day." */
    costSparklineTooltipTpl: string;
    costLastShadowLabel: string;
    costLearningOn: string;
    costLearningPaused: string;
    costFooterPrefix: string;
    costFooterMid: string;
    costFooterSuffix: string;
    /** Empty-state branch when no shadow A/B has fired yet. */
    costEmptyEnabledTitle: string;
    costEmptyEnabledBody: string;
    costEmptyEnabledTipBody: string;
    costEmptyEnabledCliHint: string;
    costEmptyPausedTitle: string;
    costEmptyPausedBody: string;
    /** Toast banners surfaced via `?toast=…`. */
    toastLearningPaused: string;
    toastLearningResumed: string;
    toastUpgradeRequiredPrefix: string;
    toastUpgradeRequiredLink: string;
    toastUpgradeRequiredSuffix: string;
    /** "Rolled back to v{from} — promoted as v{to}. New routing is live
     *  within 60s on every gateway replica." */
    toastRollbackCompleteTpl: string;
    /** "Rollback failed: {detail}. The previously active policy is
     *  unchanged." */
    toastRollbackFailedTpl: string;
    toastRollbackFailedNoDetail: string;
  };

  // -----------------------------------------------------------------------
  // Embedding classifier (`/projects/[id]/classifier`) — same shape as
  // routing-policy: active card, per-class metrics, history, toasts.
  // Status pill text + DB column names stay English (they're enum
  // values). CLI commands stay English (they ARE the API).
  // -----------------------------------------------------------------------
  classifier: {
    title: string;
    tagline: string;
    /** DB-failure card. */
    dbErrTitle: string;
    dbErrHint: string;
    /** Active card. */
    activeTitle: string;
    activeNoVersionPill: string;
    pauseTrainingBtn: string;
    resumeTrainingBtn: string;
    trainingOnNote: string;
    trainingPausedNote: string;
    trainingRequiresPrefix: string;
    trainingRequiresSuffix: string;
    tileTaskTypeAcc: string;
    tileComplexityAcc: string;
    tileTrainedOn: string;
    tileTrainedOnRowsTpl: string;
    tileActivated: string;
    tileRejected30d: string;
    /** Empty-state branches. */
    emptyActiveBody: string;
    emptyActiveHasHistory: string;
    emptyActiveUpgradePrefix: string;
    emptyActiveUpgradeLinkPrefix: string;
    emptyActiveUpgradeLinkSuffix: string;
    emptyActiveUpgradeSuffix: string;
    emptyActiveResumeMsg: string;
    emptyActiveLearningOnMsg: string;
    /** Per-class metrics. */
    perClassTitle: string;
    /** "Precision / recall / support on the held-out validation set
     *  ({n} examples). Low recall…" */
    perClassBodyTpl: string;
    perClassTaskTypeHead: string;
    perClassComplexityHead: string;
    perClassEmpty: string;
    perClassColClass: string;
    perClassColPrecision: string;
    perClassColRecall: string;
    perClassColSupport: string;
    /** History. */
    historyTitle: string;
    historyEmptyPrefix: string;
    historyEmptySuffix: string;
    colV: string;
    colStatus: string;
    colSource: string;
    colTaskTypeAcc: string;
    colComplexityAcc: string;
    colSamples: string;
    colGenerated: string;
    colNotes: string;
    rollbackBtn: string;
    /** "Roll back to v{n}". */
    rollbackTooltipReadyTpl: string;
    rollbackTooltipGated: string;
    /** Toast banners. */
    toastLearningResumed: string;
    toastLearningPaused: string;
    toastUpgradeRequiredPrefix: string;
    toastUpgradeRequiredLink: string;
    toastUpgradeRequiredSuffix: string;
    /** "Rolled back: v{from} re-promoted as v{to}. Live gateways reloaded
     *  via pg_notify." */
    toastRollbackCompleteTpl: string;
    /** "Rollback failed: {detail}". */
    toastRollbackFailedTpl: string;
    toastRollbackFailedNoDetail: string;
  };

  // -----------------------------------------------------------------------
  // 404 + error pages
  // -----------------------------------------------------------------------
  errors: {
    notFoundTitle: string;
    notFoundBodyPrefix: string;
    notFoundBodyLink: string;
    notFoundBodySuffix: string;
    notFoundBackBtn: string;
    notFoundEstimatorBtn: string;
  };

  // -----------------------------------------------------------------------
  // Client form components — `<BudgetForm>`, `<RoutingRuleForm>`,
  // `<AlertRuleForm>`, `<QuickBudgetCTA>`. These cannot read cookies, so
  // server pages pass `t.forms` down as a prop.
  // -----------------------------------------------------------------------
  forms: {
    /** `<BudgetForm>` strings. */
    budget: {
      presetsLabel: string;
      /** Preset chip templates. `{usd}` is the integer dollar amount
       *  (no `$` — the template provides the currency glyph for the
       *  locale, so EN gets "$1/day" and CN gets "$1 / 天"). */
      presetDailyTpl: string;
      presetMonthlyTpl: string;
      periodDaily: string;
      periodMonthly: string;
      limitPlaceholder: string;
      enabledLabel: string;
      saveBtn: string;
      updateBtn: string;
      cancelBtn: string;
      savedPill: string;
      previewMonthlyEquiv: string;
      previewDailyEquivAvg: string;
      previewNoTraffic24h: string;
      previewNoTraffic30d: string;
      previewPast24hLine: string;
      previewPast30dLine: string;
      previewPast7dSuffix: string;
      previewWarn24hOver: string;
      previewWarn24hHigh: string;
      previewWarn30dOver: string;
      previewWarn30dHigh: string;
      previewSubCentHint: string;
      previewEnterAmount: string;
      /** Editable row labels. */
      rowEditBtn: string;
      rowDeleteBtn: string;
      rowEnabledPill: string;
      rowDisabledPill: string;
      rowEditTitle: string;
      forecastTodayLabel: string;
      forecastMonthLabel: string;
      forecastEtaMinutes: string;
      forecastEtaHours: string;
      forecastEtaDays: string;
    };

    /** `<RoutingRuleForm>` strings. */
    routing: {
      presetsLabel: string;
      preset1Label: string;
      preset1Desc: string;
      preset2Label: string;
      preset2Desc: string;
      preset3Label: string;
      preset3Desc: string;
      preset4Label: string;
      preset4Desc: string;
      whenAsks: string;
      switchToRegex: string;
      switchToModel: string;
      regexPlaceholder: string;
      routeTo: string;
      tierFrontier: string;
      tierMid: string;
      tierCheap: string;
      tierSuffix: string;
      thresholdLabel: string;
      /** Six anchor prompts shown beneath the complexity slider. They
       *  illustrate roughly where on the 0..1 scale a request of that
       *  shape would land. Numbered to keep `THRESHOLD_LANDMARKS` in
       *  the form aligned to the dictionary at compile time. */
      landmarkExample1: string;
      landmarkExample2: string;
      landmarkExample3: string;
      landmarkExample4: string;
      landmarkExample5: string;
      landmarkExample6: string;
      /** Tooltip rendered on each landmark chip — `{score}` is the
       *  rounded 0..1 anchor value (e.g. "0.40"). */
      landmarkTooltipTpl: string;
      modeLabel: string;
      modeRouteTitle: string;
      modeShadowTitle: string;
      modeBothTitle: string;
      modeRouteBodyPrefix: string;
      modeRouteBodySuffix: string;
      modeShadowBody: string;
      modeBothBody: string;
      shadowTargetLabel: string;
      shadowTargetDefaultBoth: string;
      shadowTargetPick: string;
      sampleRateLabel: string;
      sampleRateAlwaysLabel: string;
      sampleRateAlwaysDesc: string;
      sampleRate100Desc: string;
      sampleRate10Desc: string;
      sampleRate5Desc: string;
      sampleRate1Desc: string;
      sampleAlwaysExplain: string;
      sampleAlwaysShadowExplainPrefix: string;
      sampleAlwaysShadowExplainSuffix: string;
      sampleAlwaysRouteExplain: string;
      sampleSubExplainPrefix: string;
      sampleSubExplainOf: string;
      sampleSubExplainShadowSuffix: string;
      sampleSubExplainRouteSuffix: string;
      previewLabel: string;
      previewLoading: string;
      previewEmpty: string;
      previewMatchedPrefix: string;
      previewMatchedSingular: string;
      previewMatchedPlural: string;
      previewMatchedSpentSuffix: string;
      previewModelsHit: string;
      previewThresholdHint: string;
      previewUnavailable: string;
      enabledLabel: string;
      saveBtn: string;
      updateBtn: string;
      cancelBtn: string;
      savedPill: string;
      /** Editable row labels. */
      rowEditBtn: string;
      rowDeleteBtn: string;
      rowEnabledPill: string;
      rowDisabledPill: string;
      rowEditTitle: string;
      rowSampleAlways: string;
      rowSampleNever: string;
      rowSampleAlwaysTooltip: string;
      rowSampleSubTooltip: string;
    };

    /** `<AlertRuleForm>` strings. */
    alert: {
      notifyMeWhen: string;
      channelWebhookLabel: string;
      channelWebhookOptional: string;
      channelWebhookHelpPrefix: string;
      channelWebhookHelpEmphasis: string;
      channelWebhookHelpSuffix: string;
      channelEmailLabel: string;
      channelEmailHelp: string;
      addBtn: string;
      atLeastOneRule: string;
      savedPill: string;
    };

    /** `<QuickBudgetCTA>` strings. */
    quickBudget: {
      title: string;
      capLabel: string;
      onLabel: string;
      enableBtn: string;
      /** Preset chip templates shared with `<BudgetForm>` — `{usd}` is
       *  the integer dollar amount. Duplicated here so the page can
       *  pass a single sub-tree (`t.forms.quickBudget`) without also
       *  threading `t.forms.budget`. */
      presetDailyTpl: string;
      presetMonthlyTpl: string;
    };

    /** Alert-event-type catalogue. Each event type has a short
     *  `title` (used by the form dropdown + saved-rows table) and
     *  a one-sentence `desc` shown under the dropdown. */
    alertEvents: {
      budgetExceeded: { title: string; desc: string };
      loopDetected: { title: string; desc: string };
      costAnomaly: { title: string; desc: string };
      retrainFailed: { title: string; desc: string };
    };
  };

  // -----------------------------------------------------------------------
  // Global error boundary (`error.tsx`)
  // -----------------------------------------------------------------------
  errorBoundary: {
    title: string;
    bodyPrefix: string;
    bodyLink: string;
    bodySuffix: string;
    digestLabel: string;
    retryBtn: string;
    backBtn: string;
  };

  // -----------------------------------------------------------------------
  // CopyButton + ThemeToggle aria/tooltip labels
  // -----------------------------------------------------------------------
  copyButton: {
    copyTooltip: string;
    copiedTooltip: string;
    copyLabel: string;
    copiedLabel: string;
  };

  themeToggle: {
    switchToLight: string;
    switchToDark: string;
  };

  // -----------------------------------------------------------------------
  // ToastHost — every URL-driven toast slug. Keys are the slug verbatim
  // (camelCase) and templates use `{arg}` for the optional second URL
  // parameter (`?toast_arg=...`).
  // -----------------------------------------------------------------------
  toasts: {
    projectCreated: string;
    projectCreatedNoArg: string;
    projectDeleted: string;
    projectDeletedNoArg: string;
    keyCreated: string;
    keyNameRequired: string;
    keyCreateFailed: string;
    keyCreatedNoReveal: string;
    keyDeleted: string;
    keyRotated: string;
    keyRotateNotFound: string;
    budgetSaved: string;
    budgetDeleted: string;
    budgetInvalid: string;
    routingSaved: string;
    routingDeleted: string;
    routingLocked: string;
    routingInvalid: string;
    routingBadRegex: string;
    testKeyOk: string;
    testKeyFail: string;
    alertTestOk: string;
    alertTestOkNoArg: string;
    alertTestFailNoInternalToken: string;
    alertTestFailNoTarget: string;
    alertTestFailWithReason: string;
    alertTestFailNoReason: string;
    alertSaved: string;
    alertDeleted: string;
    alertNoTarget: string;
    alertBadUrl: string;
    alertInvalid: string;
    digestEnabled: string;
    digestEnabledHosted: string;
    digestDisabled: string;
    providerKeySaved: string;
    providerKeySavedNoArg: string;
    providerKeyDeleted: string;
    providerKeyEncryptionMissing: string;
    providerKeyInvalid: string;
    providerKeyTooShort: string;
    providerKeyBadUrl: string;
    referralCodeReady: string;
    referralCodeReadyNoArg: string;
    referralSettled: string;
    referralSettledNoArg: string;
    referralSettleUnauth: string;
    requestReplayQueued: string;
    requestReplayQueuedNoArg: string;
    requestReplayFailedNoEnv: string;
    requestReplayFailedWithReason: string;
    requestReplayFailedNoReason: string;
    templateSaved: string;
    templateDeleted: string;
    templateBadInput: string;
    orgCreated: string;
    orgCreatedNoArg: string;
    orgBadName: string;
    orgBadRole: string;
    orgBadEmail: string;
    orgNotAllowed: string;
    orgNotFound: string;
    orgInvited: string;
    orgInvitedNoArg: string;
    orgInviteRevoked: string;
    orgInviteResent: string;
    orgInviteResentNoArg: string;
    orgTransferComplete: string;
    orgTransferNotOwner: string;
    orgTransferBadSuccessor: string;
    orgTransferSameUser: string;
    orgTransferConfirmMismatch: string;
    accountDeleteConfirmMismatch: string;
    accountDeleteScheduled: string;
    accountDeleteCancelled: string;
    accountDeleteOrgOwner: string;
    accountDeleteOrgOwnerNoArg: string;
    billingTransferCancelled: string;
    billingTransferCancelFailed: string;
    billingTransferCompleted: string;
    orgRoleChanged: string;
    orgMemberRemoved: string;
    orgInviteBadToken: string;
    orgInviteEmailMismatch: string;
    orgJoined: string;
    orgPlanRequired: string;
    orgPlanRequiredNoArg: string;
    orgSeatLimit: string;
    orgSeatLimitNoArg: string;
    /** SSO/SAML config save flow on the team admin page. The action emits
     *  these slugs from `saveOrgSamlConfigAction`; without entries here
     *  ToastHost would silently render nothing on save / validation
     *  failure. */
    ssoSaved: string;
    ssoNoPermission: string;
    ssoBadMode: string;
    ssoBadDefaultRole: string;
    ssoBadDomain: string;
    ssoIncomplete: string;
    /** Action labels rendered in toasts. */
    actionViewPlans: string;
  };

  // -----------------------------------------------------------------------
  // Savings estimator (`/estimate` — `<SavingsEstimator>` client component)
  // -----------------------------------------------------------------------
  estimator: {
    /** Tabs at the top. */
    modeQuick: string;
    modeCsv: string;

    /** Workload bucket presets. */
    workloadAgentLabel: string;
    workloadAgentExplainer: string;
    workloadIdeLabel: string;
    workloadIdeExplainer: string;
    workloadChatLabel: string;
    workloadChatExplainer: string;
    workloadMixedLabel: string;
    workloadMixedExplainer: string;

    /** Quick mode card. */
    quickTitle: string;
    quickSpendLabel: string;
    quickSpendPerMonth: string;
    quickSpendHintPrefix: string;
    quickSpendHintEmphasis: string;
    quickWorkloadPrompt: string;
    quickPlanningRangePrefix: string;
    quickPlanningRangeSuffix: string;

    /** CSV mode card. */
    csvTitle: string;
    csvIntroPrefix: string;
    csvIntroEmphasis: string;
    csvIntroSuffix: string;
    csvSourceOpenAI: string;
    csvSourceAnthropic: string;
    csvSourceOpenRouter: string;
    csvSourceDeepSeekSuffix: string;
    csvSourceQwenSuffix: string;
    csvSourceDoubaoSuffix: string;
    csvSourceGoogleSuffix: string;
    csvSourceColumnsHint: string;
    csvChooseFile: string;
    csvOrPaste: string;
    csvPastePlaceholder: string;
    csvErrorParseFile: string;
    csvErrorMissingColsFile: string;
    csvErrorMissingColsPaste: string;
    csvFilenamePasted: string;
    csvFileMetaRows: string;
    csvFileMetaModels: string;

    /** Result hero. */
    resultLabel: string;
    resultMidpointPrefix: string;
    resultMidpointSuffix: string;
    resultBasedOnPrefix: string;
    resultBasedOnSuffix: string;
    resultMinSpendPrefix: string;
    resultMinSpendEmphasis: string;
    resultMinSpendSuffix: string;
    resultSourceCsv: string;
    resultSourceQuick: string;

    /** Plan-payback breakdown cards. */
    paybackProLabel: string;
    paybackTeamLabel: string;
    paybackScaleLabel: string;
    paybackPaysBackPrefix: string;
    paybackHoursUnit: string;
    paybackDaysUnit: string;
    paybackNa: string;
    paybackProNote: string;
    paybackTeamNote: string;
    paybackScaleNote: string;

    /** Per-model breakdown table (CSV mode). */
    breakdownTitle: string;
    breakdownFromCsvSuffix: string;
    breakdownColModel: string;
    breakdownColTier: string;
    breakdownColSpent: string;
    breakdownColEstSaved: string;
    breakdownColSavedPct: string;
    breakdownColWhy: string;
    breakdownTierFrontier: string;
    breakdownTierMid: string;
    breakdownTierCheap: string;
    breakdownTierUnknown: string;
    breakdownWhyFrontier: string;
    breakdownWhyMid: string;
    breakdownWhyCheap: string;
    breakdownWhyUnknown: string;
    breakdownTopNFooter: string;

    /** "How we estimated" card. */
    howTitle: string;
    howCsvBody: string;
    howFooter: string;
    howSelfHostNote: string;

    /** "Don't pay yet" card. */
    notYetTitle: string;
    notYetUnder50Prefix: string;
    notYetUnder50Spend: string;
    notYetUnder50AmountPrefix: string;
    notYetUnder50Link: string;
    notYetUnder50Suffix: string;
    notYetCheapModels: string;
    notYetSlaPrefix: string;
    notYetSlaLink1: string;
    notYetSlaMid: string;
    notYetSlaLink2: string;
    notYetSlaSuffix: string;
    notYetByo: string;

    /** Final CTA card. */
    ctaTitle: string;
    ctaBody: string;
    ctaStartFree: string;
    ctaSelfHostDocs: string;
    ctaFinePrintPrefix: string;
    ctaFinePrintCode: string;
    ctaFinePrintSuffix: string;
  };

  // -----------------------------------------------------------------------
  // Email — OTP login + weekly digest
  // -----------------------------------------------------------------------
  emails: {
    /** OTP login. */
    otpSubject: string;
    otpHeading: string;
    otpIntro: string;
    otpExpiry: string;
    otpFooter: string;
    /** Plain-text body templates (separate from HTML so line-by-line layout
     *  reads naturally in mail clients that strip HTML). */
    otpTextLine1: string;
    otpTextLink: string;
    otpTextExpiry: string;
    otpTextFooter: string;
    /** Subject template — `{code}` is the OTP. */
    otpSubjectTpl: string;
    /** HTML body labels. */
    otpHtmlBrand: string;
    otpHtmlSignInBtn: string;

    /** Org invitation email. `{inviter}` `{org}` `{role}` substituted. */
    inviteSubject: string;
    inviteTextLine1: string;
    inviteTextLink: string;
    inviteTextFooter1: string;
    inviteTextFooter2: string;
    inviteHtmlLine: string;
    inviteHtmlBtn: string;
    inviteHtmlFallback: string;
    inviteHtmlFooter: string;

    /** Weekly digest. */
    digestSubject: string;
    digestSubjectTpl: string;
    digestHeading: string;
    digestIntro: string;
    digestSpendLabel: string;
    digestSavedLabel: string;
    digestRequestsLabel: string;
    digestCta: string;
    digestUnsubscribe: string;
    /** Plain-text + HTML weekly digest body. */
    digestGreeting: string;
    digestGreetingFallbackName: string;
    digestRecapLine: string;
    digestRoutingLabel: string;
    digestRoutingNote: string;
    digestCacheLabel: string;
    digestCacheNote: string;
    digestAlsoCaughtLabel: string;
    digestAlsoCaughtNote: string;
    digestTopRoutesLabel: string;
    digestTotalSpendLabel: string;
    digestViewDashboardLabel: string;
    digestUnsubscribeLine: string;
    digestUnsubscribeNote: string;
    digestFooterTagline: string;
    digestHtmlBrand: string;
    digestHtmlSavedLabel: string;
    digestHtmlVsSpendPrefix: string;
    digestHtmlVsSpendSuffix: string;
    digestHtmlReqsSuffix: string;
    digestHtmlHitsSuffix: string;
    digestHtmlAlsoCaught: string;
    digestHtmlLoopsSuffix: string;
    digestHtmlOverBudgetSuffix: string;
    digestHtmlTopRoutesLabel: string;
    digestHtmlReqAbbrev: string;
    digestHtmlViewBtn: string;
    digestHtmlUnsubPrefix: string;
    digestHtmlUnsubLink: string;
    digestHtmlUnsubSuffix: string;
  };

  // -----------------------------------------------------------------------
  // Language toggle aria/labels
  // -----------------------------------------------------------------------
  languageToggle: {
    ariaLabel: string;
    /** "中文" / "English" — current language label. */
    currentEn: string;
    currentZh: string;
    /** Templated aria-label rendered on the toggle button itself —
     *  `{label}` is the OPPOSITE locale's name (e.g. "中文" / "English")
     *  so screen readers say "切换到中文" / "Switch to English". */
    switchToTpl: string;
  };
};
