import type { Dictionary } from "./types";

/**
 * 简体中文文案。每次更新 `en.ts` 后请同步本文件。
 *
 * 风格约定：
 *   - 面向开发者，使用工程语境的中文，避免营销腔。
 *   - 标点优先半角；长句使用全角逗号、顿号。
 *   - 翻译产品概念词：provider → 服务商，receipt → 回执，
 *     gateway → 网关，frontier model → 旗舰模型，ledger → 账本。
 *   - 保留代码标识符与 SDK 字段名：base_url、API key、ts_、
 *     x-ts-* headers、token、agent / AI agent、benchmark、
 *     shadow（试验）、HTTP 状态码等。
 *   - 厂商名一律保留英文：OpenAI / Anthropic / Gemini / DeepSeek /
 *     Qwen / Doubao / Cursor / OpenClaw / Hermes / Cline / LangChain。
 *   - 不要写品牌口号式句子，用"做什么 / 看到什么 / 接下来做什么"。
 */
export const zhCN: Dictionary = {
  common: {
    autoRefresh: {
      live: "实时 · ",
      updating: "更新中…",
      justNow: "刚刚",
      secondsAgo: "{n} 秒前",
      minutesAgo: "{n} 分钟前",
      title: "每 {n} 秒自动刷新一次，切回本页时立即刷新。",
    },
    confirm: "确认",
    cancel: "取消",
    save: "保存",
    saving: "保存中…",
    saved: "已保存",
    delete: "删除",
    edit: "编辑",
    create: "创建",
    add: "添加",
    remove: "移除",
    rotate: "轮换",
    test: "测试",
    testing: "测试中…",
    copy: "复制",
    copied: "已复制",
    close: "关闭",
    open: "打开",
    back: "返回",
    backToDashboard: "← 返回 Dashboard",
    backHome: "← 返回首页",
    enabled: "已启用",
    disabled: "已停用",
    pending: "等待中",
    active: "运行中",
    inactive: "未启用",
    success: "成功",
    failed: "失败",
    error: "错误",
    warning: "警告",
    notConfigured: "未配置",
    optional: "可选",
    required: "必填",
    loading: "加载中…",
    none: "—",
    notAvailable: "无",
    today: "今日",
    thisMonth: "本月",
    signIn: "登录",
    signOut: "退出登录",
    docs: "文档",
  },

  nav: {
    dashboard: "概览",
    projects: "项目",
    agents: "Agents",
    routing: "路由",
    settings: "设置",
    docs: "文档 ↗",
    signOut: "退出登录",
    trust: "安全与信任",
    estimator: "节省评估",
    stateOfSpend: "Agent 成本现状",
    selfHost: "自部署 (Apache-2.0) ↗",
    footerMeta: "TokSuan · 由 TokenSmart LLC 运营",
    settingsAccount: "账户与密钥",
    settingsTeam: "团队",
    settingsBilling: "账单与套餐",
    settingsAudit: "审计日志",
    settingsReferrals: "推荐返利",
    settingsTrust: "安全与信任",
    settingsBack: "← 返回 Dashboard",
    settingsAriaLabel: "设置子导航",
  },

  landing: {
    metaDescription:
      "只改一行 base_url，让 AI agent 的每次请求都可见、可限额，并在回执验证安全后自动走更便宜的模型。",
    navStateOfSpend: "成本现状",
    navEstimate: "节省评估",
    navTrust: "安全",
    navOpenClaw: "OpenClaw",
    navHermes: "Hermes",
    ctaSignedIn: "进入 Dashboard",
    ctaAnonymous: "登录 / 免费开始",
    heroEyebrow: "面向 AI Agent 的成本控制与路由",
    heroTitle: "AI agent 不该让你看到账单时才发现问题。",
    heroSubtitle:
      "TokSuan 由 TokenSmart LLC 运营，接在你的 agent 与各家模型服务商之间，让每一次请求可见、可限额，并在安全前提下路由到更合适的模型。简单的 turn 不再消耗旗舰模型预算，复杂的 turn 仍保留所需质量。",
    heroPrimarySignedIn: "进入 Dashboard",
    heroPrimaryAnonymous: "用邮箱免费开始",
    heroSecondaryEstimate: "评估节省空间",
    heroSecondaryRoutingWins: "查看路由收益",
    heroSecondaryOpenClaw: "OpenClaw 接入指南",
    heroSecondaryHermes: "Hermes 接入指南",
    heroSecondarySelfHost: "自部署文档",
    heroFinePrint:
      "不抽 token 差价，自带服务商 API key，默认使用同一服务商家族的模型做复杂度判定，需要时可自部署。",
    receiptHeader: "回执示例",
    receiptSession: "OpenClaw 会话",
    receiptAskedModel: "请求模型",
    receiptLandedModel: "实际落地模型",
    receiptCheaperRoute: "更便宜路径",
    receiptCheaperRouteSub: "≈ $4.2k / 10 万次类似 turn",
    receiptQualityProof: "质量校验",
    receiptQualityProofValue: "质量已校验",
    receiptDescription:
      "回执把每次请求做了什么、为什么这样路由、是否可推全部讲清楚，方便团队复核与决策。",
    aggregateEyebrow: "聚合证据",
    aggregateTitleVisible: "TokSuan 回执已经记录到可公开的验证节省。",
    aggregateTitleWarming: "聚合证据正在积累。",
    aggregateBodyVisible:
      "来自托管流量和自部署显式 opt-in 聚合数据，且已经满足隐私阈值。",
    aggregateBodyWarming:
      "私有回执会立刻生效；公开的累计节省会在满足隐私阈值后自动显示。",
    aggregateSavingsLabel: "已验证节省",
    aggregateRequestsLabel: "过阈值后的累计请求数",
    aggregateLoopsLabel: "upstream 前拦截的循环",
    aggregateParticipantsLabel: "托管项目 / opt-in 部署",
    aggregateWarmingValue: "积累中",
    aggregateWarmingSavingsLabel: "私有回执立即可用",
    aggregateWarmingRequestsLabel: "过阈值后公开总量",
    aggregateWarmingParticipantsLabel: "仅托管 + opt-in 自部署",
    aggregatePrivacyNote:
      "不包含 prompt、响应、服务商 API key、邮箱、项目名称或单次请求日志。",
    quickstartEyebrow: "改一行 SDK 即可开始",
    quickstartTitle: "四步接入，无需重写 agent。",
    quickstartSubtitle:
      "添加你已有的服务商 API key，创建一个 TokSuan 项目 key，把 base_url 切过来，然后查看第一份回执。",
    quickstartStep1: "服务商 API key",
    quickstartStep2: "项目 key",
    quickstartStep3: "base_url",
    quickstartStep4: "回执",
    flowAgentSdk: "Agent SDK",
    flowGateway: "TokSuan",
    flowProvider: "服务商",
    flowReceipt: "回执 + 预算 + 路由证据",
    hostedEyebrow: "托管价值",
    hostedTitle: "开放运行时，托管策略运维。",
    hostedBody:
      "网关路径完全开放：预算、路由、服务商解析、回执与 key 处理都可审计。托管版 TokSuan 额外承担每周操作的繁琐工作：benchmark 名单、聚合路由情报、策略推全与回滚、服务商健康度、滥用复核。",
    hostedCtaTrust: "查看信任边界",
    hostedCtaProof: "查看聚合证据",
    hostedCard1Title: "策略工厂",
    hostedCard1Body:
      "私有 eval 配方与模型名单生成候选路由策略，过程不触碰运行时路径。",
    hostedCard2Title: "聚合情报",
    hostedCard2Body:
      "托管侧及自部署可选上报的聚合数据，在满足隐私阈值后呈现真正稳定省钱的路由对。",
    hostedCard3Title: "运维护栏",
    hostedCard3Body:
      "服务商健康度、数据库自检、事件快照、报告审批保证策略变更可回滚。",
    devEyebrow: "对开发者友好",
    devTitle: "保留你的 SDK，只换网关。",
    devBody:
      "Cursor、OpenClaw、Hermes、LangChain、Vercel AI SDK、Cline 以及内部机器人都可以保留 OpenAI 兼容的工作流，TokSuan 在中间补上回执、预算与路由层。",
    whyEyebrow: "为什么团队需要一个控制层",
    whyTitle: "模型网关提供访问，TokSuan 做路由决策。",
    whyBody:
      "Agent 流量并不是普通 API 流量：会重试、会调用工具、会跨多轮长会话，且很容易在用户毫不知情时从便宜模型切到旗舰模型。TokSuan 决定哪一轮可以下沉到更便宜的模型、哪一轮必须保留旗舰模型，并为每一次决策留下回执。",
    why1Title: "账单总是事后才发现",
    why1Body: "到底是哪一个 agent、哪一个项目、哪一段 prompt 把成本拉高了？",
    why2Title: "Agent 会重复犯昂贵的错误",
    why2Body: "陷入循环的会话可能在没人盯着的几分钟内持续消耗预算。",
    why3Title: "切到便宜模型需要证据",
    why3Body: "在生产流量切换之前，必须先证明便宜模型在你的场景下足够安全。",
    loopEyebrow: "控制闭环",
    loopTitle: "看清、限制、收敛。",
    loopBody:
      "三块产品共同工作：用账本实现可见，用预算守门提供控制，用路由证据在安全前提下持续省钱。",
    bento1Pill: "观测",
    bento1Title: "每次请求都成为一份回执。",
    bento1Body:
      "项目、服务商、模型、tag、延迟、输入 / 输出 token、路由原因与成本统一进入一个账本，团队可随时复核。",
    bento2Pill: "控制",
    bento2Title: "预算在 upstream 之前先生效。",
    bento2Body: "日预算与月预算可以在服务商计费前阻止失控开销。",
    bento3Pill: "Agent",
    bento3Title: "循环检测捕获重复行为。",
    bento3Body:
      "重复出现的请求指纹可以在 agent 再次烧钱之前被拦下来。",
    bento4Pill: "优化",
    bento4Title: "证据足够时，才走更便宜的模型。",
    bento4Body:
      "公开 benchmark 提供第一天的成本-质量前沿，shadow 试验与项目历史让 TokSuan 学到最适合你 agent 的服务商组合。",
    trustBand1Title: "不抽 token 差价",
    trustBand1Body:
      "你直接付服务商的费用，TokSuan 是控制层，不做转售。",
    trustBand2Title: "服务商 API key 加密",
    trustBand2Body:
      "你的 app 使用 ts_ 开头的项目 key，上游服务商 API key 在静态存储时加密。",
    trustBand3Title: "可自部署",
    trustBand3Body:
      "Apache-2.0 的代码可以配 Postgres 在自有基础设施上运行。",
    faqEyebrow: "在切流之前",
    faqTitle: "买家最先问的问题。",
    faqBody:
      "把生产 agent 调用接到网关之前，工程、财务、安全三方关心的简短回答。",
    faq1Q: "需要改我的 app 吗？",
    faq1A:
      "通常只改 base_url 和一个 API key，请求结构仍然兼容 OpenAI。",
    faq2Q: "这是 OpenRouter 吗？",
    faq2A:
      "不是。OpenRouter 提供多模型访问，TokSuan 决定每一次 agent turn 应该走哪个模型，强制预算，并基于你的工作流持续学习。",
    faq3Q: "能看到具体哪一次请求花了多少钱吗？",
    faq3A:
      "可以。账本记录模型、服务商、token、延迟、tag、成本及回执 header。",
    faq4Q: "会不会牺牲模型质量？",
    faq4A:
      "只有当策略与回执显示便宜模型在你的场景下安全时才会推全；shadow 试验让你在切换生产流量前先验证质量。",
    faq5Q: "Agent 进入循环怎么办？",
    faq5A: "循环检测和预算可以在重复 turn 抵达 upstream 之前直接拦下。",
    faq6Q: "只能用托管版吗？",
    faq6A:
      "不是。可以使用托管网关，也可以在自有基础设施上自部署。",
    finalEyebrow: "从一次真实请求开始",
    finalTitle: "发一次 agent 请求，拿到一份团队信得过的回执。",
    finalBody:
      "先评估节省空间，连接一个服务商 API key，看清第一次请求，再考虑切生产路由。",
    finalCtaSignedIn: "进入 Dashboard",
    finalCtaAnonymous: "免费开始",
    finalCtaQuickstart: "快速接入指南",
    publicNavAriaLabel: "公开页导航",
    quickstartAriaLabel: "TokSuan 如何接入",
  },

  login: {
    titleEmail: "登录或创建账户",
    titleCode: "输入验证码",
    sentToPrefix: "已发送至 ",
    sentToSuffix: "，15 分钟内有效。",
    subtitleEmail:
      "仅邮箱登录，无需密码，我们会向你发送一次性验证码。",
    fieldEmail: "邮箱",
    fieldCode: "6 位验证码",
    placeholderEmail: "you@example.com",
    placeholderCode: "000000",
    continue: "继续",
    verify: "校验验证码",
    sending: "发送中…",
    resend: "重新发送",
    resendIn: "{seconds} 秒后可重发",
    resendTooltipDisabled: "请稍候再请求新的验证码",
    resendTooltipReady:
      "再发一封新的 6 位验证码（旧验证码在过期前仍然有效）",
    devLogHint: "开发模式：验证码也会打印在 dashboard 服务端日志里。",
  },

  unsubscribe: {
    titleSuccess: "已退订",
    bodyPrefix: "",
    bodyMid: " 将不再收到 ",
    bodySuffix:
      "。事务性邮件（登录验证码、组织邀请、账单收据）不受影响，因为这些邮件是产品运行所必须的。",
    bodyChangedMind: "改主意了？登录后到这里重新打开订阅 ",
    backToDashboard: "返回 Dashboard",
    titleInvalid: "退订链接无效",
    bodyInvalid:
      "找不到与该链接匹配的订阅。可能是链接已轮换、已退订或被邮件客户端截断。你也可以登录后直接到这里管理邮件偏好 ",
    signIn: "去登录",
    listLabelWeeklyDigest: "每周节省日报",
  },

  estimate: {
    metaTitle: "节省评估",
    metaDescription:
      "评估 TokSuan 能为你的月度模型账单节省多少。两个输入，无需注册，先给出保守区间，再用你自己的真实流量验证。",
    title: "TokSuan 能为你节省多少？",
    subtitle:
      "两个输入，无需注册。先给出一个保守的规划区间，再在你自己的真实流量上验证准确数字。",
  },

  trust: {
    metaTitle: "安全与信任",
    metaDescription:
      "TokSuan 如何处理自带服务商 API key、请求数据、保留策略、可靠性与自部署。",
    title: "安全与信任",
    tagline:
      "可以直接发给安全审查同事的页面：TokSuan 看到了什么、保留了什么、服务商 API key 如何保护、当前可靠性边界在哪里。",
    shortVersionTitle: "简短版本",
    shortVersionBody:
      "TokSuan 代理你的模型请求，由你提供服务商 API key。我们将每个项目的请求元数据写入账本，便于你审计开销、把 turn 路由到更安全 / 更便宜的模型，并在 upstream 计费之前阻止失控的 agent 循环。",
    backToBilling: "返回账单",
    docsTrust: "信任说明",
    docsSubProcessors: "子处理方",
    docsRunbook: "生产 runbook",
    statusEnabled: "已启用",
    statusNotConfigured: "未配置",
    statusDisabled: "已关闭",
    liveTitle: "当前部署姿态",
    liveSubtitle: "来自 gateway /health · 缓存 30 秒",
    liveGatewayUnreachablePrefix:
      "Dashboard 暂时无法访问 gateway 健康状态。详情：",
    liveColControl: "控制项",
    liveColStatus: "状态",
    liveColWhy: "为什么安全团队关心",
    liveByoControl: "BYO key 加密",
    liveByoWhy: "使用 KMS 的托管部署可避免服务商 key 以明文静态存储。",
    liveBodyStorageControl: "请求体存储",
    liveBodyStorageWhy:
      "控制 prompt 是完整保留、采样保留，还是只保存占位摘要。",
    liveQualityControl: "质量 embedding",
    liveQualityWhy: "用于 shadow A/B 的语义相似度对比，提供质量证据。",
    liveReplayControl: "内部 replay",
    liveReplayWhy: "只有配置共享密钥时，replay endpoint 才会启用。",
    liveOtelControl: "OpenTelemetry 导出",
    liveOtelWhy: "说明 trace 是否会离开本部署，发送到外部观测后端。",
    liveBaselineControl: "Baseline 策略",
    liveBaselineBucketsTpl: "{n} 个任务桶",
    liveBaselineWhy: "说明自动下沉路由策略是否正在生效。",
    liveSettingsPrefix: "完整的运维集成列表请打开 ",
    liveSettingsLink: "设置 → 系统集成",
    liveSettingsSuffix: "。",
    dataTitle: "数据流向",
    dataColData: "数据",
    dataColWhere: "流向哪里",
    dataColWhy: "为什么需要",
    dataPrompt: "Prompt 与响应正文",
    dataPromptWhere: "你选择的上游服务商；TokSuan 请求账本",
    dataPromptWhy: "转发请求、计算成本、排查失败、证明节省",
    dataApiKey: "TokSuan API key",
    dataApiKeyWhere: "以 SHA-256 哈希存入 TokSuan 数据库",
    dataApiKeyWhy: "认证 gateway 请求，同时不保存明文",
    dataByoKey: "自带服务商 API key",
    dataByoKeyWhere: "KMS 加密的数据库行；gateway 热路径按需解密",
    dataByoKeyWhy: "用你自己的服务商账户调用上游",
    dataBilling: "账单元数据",
    dataBillingWhere: "Stripe + 本地订阅镜像",
    dataBillingWhy: "套餐限制、升级、取消订阅与收据",
    reliabilityTitle: "当前可靠性边界",
    reliabilityBody:
      "TokSuan 目前尚未提供正式托管 SLA。我们明确说明这一点，因为虚假的 99.9% 承诺比诚实边界更糟。如果可靠性是当前采购阻塞项，请在你自己的 SLO 下自部署同一份代码。",
    docsSecurity: "安全姿态",
    docsDpa: "DPA 模板",
    items: {
      byoTitle: "自带服务商 API key",
      byoBody:
        "OpenAI / Anthropic / DeepSeek 的合约与账单仍然在你这边，TokSuan 不转售 token，也不抽差价。",
      kmsTitle: "KMS 包封加密",
      kmsBody:
        "托管的 BYO key 使用 AES-256-GCM 加密，每行使用独立 DEK，由 AWS 或 GCP KMS 包封，主密钥不出 KMS。",
      bodyTitle: "请求体控制",
      bodyBody:
        "网关部署可以选择保存完整请求体、采样请求体或仅保存压缩占位。托管默认是有限的滚动窗口，并提供删除路径。",
      selfHostTitle: "自部署退路",
      selfHostBody:
        "如果托管的可靠性、采购或数据驻留是阻塞项，可以在自有基础设施上跑同一份 Apache-2.0 代码。",
    },
  },

  stateOfSpend: {
    metaTitle: "Agent 成本现状",
    metaDescription:
      "公开的 TokSuan 证据页：策略预览路由收益、自带服务商的覆盖度，以及未来托管聚合遥测的隐私规则。",
    eyebrow: "Agent 成本现状",
    title: "公开证据：什么时候 agent 可以安全切到更便宜的模型。",
    subtitle:
      "TokSuan 不是模型市场。本页展示控制层视角：策略预览的路由收益、服务商 API key 覆盖度，以及未来在流量足够大后才公开的托管聚合遥测的隐私阈值。",
    ctaEstimate: "评估节省",
    ctaTrust: "查看安全说明",
    modePillPreview: "预览模式",
    modeTitle: "目前还不是客户遥测。",
    modeBody:
      "下方数据来自 TokSuan 公开的 baseline 策略制品，并非托管私有流量。托管聚合数据将在满足隐私阈值之后才会出现。",
    modePolicyLabel: "策略",
    policyUnavailable: "暂不可用",
    statBuckets: "公开策略中的任务桶",
    statModels: "桶内被对比的模型",
    statProviders: "覆盖的服务商家族",
    statAvgSavings: "预览中典型路由收益",
    routingWinsEyebrow: "路由收益",
    routingWinsTitle: "TokSuan 真正提供的证据面。",
    routingWinsBody:
      "OpenRouter 排的是模型需求，TokSuan 排的是控制层结果：在当前质量策略下，哪些请求模型存在更便宜且可接受的替代。下方示例是策略预览候选，不代表你的私有流量。",
    routingWinsCta: "查看路由质量",
    routingWinsEmpty:
      "网关未能返回 baseline 制品，策略预览暂时不可用。",
    routingWinsPolicyEmpty: "策略预览暂不可用。",
    routingWinsAsked: "请求模型",
    routingWinsLanded: "更便宜的落地模型",
    routingWinsBucket: "任务桶",
    routingWinsSavings: "节省",
    routingWinsGuardrail: "护栏",
    routingWinsPerSampleSuffix: " / 样本",
    routingWinsQualityPass: "通过质量底线",
    routingWinsQualityDelta: "质量差值",
    providerEyebrow: "用你自己的 key",
    providerTitle: "覆盖多家服务商，不转售 token。",
    providerBody:
      "TokSuan 负责路由、限额和证据，你与服务商的关系仍归你。继续使用你已有的上游 key，TokSuan 在中间补上回执与策略，不抽 token 差价。",
    telemetryEyebrow: "托管 + 自部署可选上报的聚合遥测",
    telemetryTitle: "只有满足隐私阈值之后才公开的指标。",
    signal1Title: "近 7 天节省金额",
    signal1Body: "只有当足够多的项目共享同一路由模式时才公开。",
    signal2Title: "拦截的 agent 循环",
    signal2Body: "只统计重复指纹，永不上传 prompt 内容。",
    signal3Title: "Prompt 缓存节省",
    signal3Body: "按 tag 展示 cache-control 的影响，不上传原始内容。",
    signal4Title: "因质量被拒的模型",
    signal4Body: "便宜的路由不一定通过护栏。",
    privacyTitle: "公开统计的隐私规则",
    privacyBody:
      "托管流量与自部署可选上报的聚合行，要等到下方所有阈值都满足后才会公开。当某一路由出现得太少，本页会回退到策略预览，而不是暴露客户形态的信号。",
    privacyLabelProjects: "项目数",
    privacyLabelOrgs: "组织数",
    privacyLabelRequests: "请求数",
    privacyLabelWindow: "时间窗口",
    finalEyebrow: "控制 + 证据层",
    finalTitle: "很多 agent 工作流在持续超支，先证明哪一类 turn 可以更便宜地落地。",
    finalBody:
      "从一份请求回执开始，等质量与预算证据通过你的标准后再推全路由。",
    finalCtaEstimate: "先评估",
    finalCtaStart: "免费开始",
    finalCtaOpenClaw: "OpenClaw 指南",
    navEstimate: "节省评估",
    navTrust: "信任说明",
    navStart: "免费开始",
    publicNavAriaLabel: "公开页导航",
    proofGridAriaLabel: "公共策略预览统计",
    routingWinsTableAriaLabel: "路由收益预览",
  },

  routingQuality: {
    backHome: "← 返回首页",
    backDashboard: "← 返回 Dashboard",
  },

  dashboard: {
    pageTitle: "Dashboard",
    heroEyebrow: "Dashboard",
    heroTitle: "Agent 成本控制",
    heroSubtitle: "改一行 base_url，让 agent 调用可见、可限额，并自动切到更便宜的模型。",
    heroPillSee: "看清每一次调用",
    heroPillCap: "限制失控开销",
    heroPillShrink: "收敛安全路由",
    heroPillKeep: "持续稳定运行",
    heroPillsAriaLabel: "TokSuan 价值要点",
    tagline:
      "过去 7 天内通过 TokSuan 发出的全部请求：实际成本，以及如果按最初请求的模型计算会是多少。",
    statTotalSpend: "总开销",
    statRequests: "请求数",
    statSavings: "已节省",
    statSavingsPctSuffix: " 节省",
    statRouted: "已路由",
    statBlocked: "已拦截",
    statLoops: "检测到的循环",
    statBudget: "预算",
    sectionRecent: "最近请求",
    sectionTopRoutes: "最省钱的路由",
    sectionRecommendations: "建议",
    sectionTopLoops: "重复模式 · 24h",
    sectionQuality: "质量证据",
    sectionBudgets: "预算",
    sectionSpendByModel: "按模型分组的开销 · 7d",
    sectionSpendByTag: "按 tag 分组的开销 · 7d",
    sectionSavings: "节省回执",
    sectionDailySpend: "每日开销 · 7d",
    sectionFirstRequest: "发送第一条请求",
    emptyRecent: "还没有请求，发出第一条就会出现在这里。",
    emptyRecommendations: "暂无建议，可能流量过小或已优化。",
    emptyRoutes: "暂时还没有更便宜的路由。",
    emptyLoops:
      "暂无重复请求模式。当同一指纹在 24 小时内出现 3 次以上时会出现在此。",
    emptyBudgets: "尚未配置预算，给项目加日预算或月预算来控制开销。",
    emptySpendByModel: "还没有请求，先通过网关发一条开始统计。",
    askedModel: "请求模型",
    landedModel: "实际模型",
    routingReason: "路由原因",
    cost: "成本",
    saved: "节省",
    latency: "延迟",
    project: "项目",
    when: "时间",
    spikeTitle: "检测到成本异常上涨",
    spikeBaselineSuffix: " 小时基线",
    planCapTitlePrefix: "套餐上限在过去 24 小时内拦截了 ",
    planCapTitleSuffix: " 个请求",
    planCapBody:
      "本账户的请求正在返回 HTTP 402 (plan_limit_exceeded)，这是托管套餐的日开销或月请求上限，不是项目预算。升级套餐可解除限制。",
    planCapCta: "升级套餐 →",
    firstSetupAddProviderLabel: "添加服务商 API key",
    firstSetupAddProviderBody:
      "先粘贴一个上游服务商 API key。模型账单仍由服务商直接结算。",
    firstSetupCreateProjectLabel: "创建项目",
    firstSetupCreateProjectBody:
      "接下来创建一个 TokSuan 项目。项目页是生成与复制 ts_ API key 的地方，可直接给 agent 使用。",
    firstSetupOpenProjectLabel: "打开项目设置",
    firstSetupOpenProjectBody:
      "你已经有服务商 API key 和项目了。打开项目页，可复制现成的 curl 命令，或创建新的 ts_ key。",
    topPattern: "最常见模式：",
    attempts: "次尝试",
    showMorePatterns: "展开更多模式",
    budgetOverLimit: "已超出预算 — 新请求会返回 HTTP 429，直到下个周期重置。",

    savingsHeroLabel: "近 30 天节省",
    savingsHeroSubWithPct:
      "比按最初请求的模型计算便宜了 {pct}，来自自动路由到更便宜的模型与 prompt-cache 折扣。",
    savingsHeroSubEmpty:
      "通过 TokSuan 发一次请求即可拿到第一份省钱回执。请求落地后会显示请求模型、实际模型、成本、节省与路由原因。",
    savingsHeroBreakdownRouting: "路由节省",
    savingsHeroBreakdownCache: "Prompt 缓存",
    savingsHeroBreakdownPrevented: "另外拦截",
    savingsHeroRoutingNote: "{n} 个请求被下沉",
    savingsHeroCacheNote: "{n} 个请求命中缓存",
    savingsHeroPreventedNote: "{loops} 个失控循环 · {budget} 个超预算",

    receiptCardTitle: "最新一份省钱回执",
    receiptOpenRequest: "打开请求 →",
    receiptAskedModel: "请求模型",
    receiptLandedModel: "实际模型",
    receiptSavedOnThis: "本次请求节省",
    receiptVsAskedSuffix: "% 比请求的模型省",
    receiptActualCost: "实际成本",
    receiptTrackedApiCost: "记录的 API 成本",
    receiptCustomNote: "未包含自部署 / 自定义基础设施成本",
    receiptAskedWouldBe: "原本会是",
    receiptWhyHappened: "为什么这样路由：",
    receiptSelfHostNote: "自部署 / 自定义说明：",
    receiptSelfHostBody:
      "TokSuan 可以证明本次请求已切换到更便宜的模型，但金额节省不包含 GPU / 基础设施成本，除非你为该 endpoint 配置了价格元数据。",
    receiptStatusRoutedDown: "已路由到更便宜的模型",
    receiptStatusCacheSaved: "命中缓存",
    receiptQualityRisk: "质量风险",

    weekTitle: "近 7 天价值报告",
    weekUpgradeSignal: "升级参考信号",
    weekSavedThisWeek: "本周已节省",
    weekProFeeRatio: "$29 Pro 套餐的 {ratio} 倍",
    weekProFeePct: "$29 Pro 套餐的 {pct}%",
    weekTopDowngrade: "最大单笔下沉",
    weekNoneYet: "暂无",
    weekOverNRequests: "覆盖 {n} 次请求",
    weekPrevented: "已拦截",
    weekPreventedNote: "{loops} 次循环 · {budget} 次预算 / 套餐拦截",
    weekQualityProof: "质量证据",
    weekShadowTrials: "{n} 条 shadow 试验",
    weekNoShadowYet: "暂无 shadow 数据",
    weekTopDowngradeLabel: "最大单笔下沉：",
    weekRecommendedNextStep: "建议下一步：",
    weekNoisiestPrefix: " 当前最频繁的重复模式是 ",
    weekNoisiestMid: "，模型为 ",
    weekNoisiestSuffix: "。",
    weekActionAddShadow: "添加 shadow 规则",
    weekActionMoreTraffic: "继续发流量",
    weekActionUpgrade: "升级到 Pro",
    weekBodyAddShadow:
      "在切更多流量之前，先加一条 shadow 规则验证回答质量。",
    weekBodyMoreTraffic:
      "继续在真实流量上跑一段时间，等节省金额覆盖 $29 Pro 月费。",
    weekBodyUpgrade:
      "需要托管重训和零运维时再升级到 Pro。",

    dbErrColumnTitle: "数据库缺少 dashboard 需要的字段。",
    dbErrColumnBody: " 当前 schema 偏旧，请执行最新 migration：",
    dbErrColumnHint:
      " — 通常是缺 migration 006（请求 tag）或 007（shadow 相似度）。",
    dbErrColumnMissing: "缺少的字段：",
    dbErrTableTitle: "数据库中缺少表。",
    dbErrTableBodyPrefix: " 执行 ",
    dbErrTableBodyMid: " 重新基于 ",
    dbErrTableBodySuffix: " 初始化数据。",
    dbErrTableMissing: "缺少的表：",
    dbErrUnreachableTitle: "数据库无法连接。",
    dbErrUnreachableBody:
      " 请确认 docker compose up -d 已经在运行，并且 dashboard 配置了正确的 DATABASE_URL。",

    firstReqHeaderHint: "第一条请求一落地，本卡片即刻填好",
    firstReqIntro:
      "这张卡只引导你完成一件事：得到一行真实的请求记录，含请求模型、实际模型、路由原因、token、成本与节省。按下方高亮的下一步操作即可，无需先看文档。",
    firstReqStepProviderKey: "粘贴服务商 API key",
    firstReqStepProviderEnv: "配置服务商 env",
    firstReqStepCreateProject: "创建项目",
    firstReqStepCreateApiKey: "创建项目 API key",
    firstReqStepCopyCurl: "复制生成的 curl / base_url",
    firstReqStepReadReceipt: "阅读回执",
    firstReqActionManage: "管理",
    firstReqActionOpen: "打开",
    firstReqActionOpenProject: "打开项目",
    firstReqActionOpenSetup: "打开接入说明",
    firstReqNextStep: "下一步：",
    firstReqFooter:
      "项目页会生成对应的 curl 命令，包含网关 URL、项目 key、归因 header 与一个匹配你已保存的服务商 key 的 smoke 模型。",

    statGridSpend7d: "7 天开销",
    statGridCalls7d: "7 天调用",
    statGridBlocked24h: "24 小时拦截",
    statGridLoops24h: "24 小时循环",
    statGridRouted24h: "24 小时路由",
    statGridCached24h: "24 小时缓存命中",
    statGridCachedSavedPrefix: "节省 ",

    dailyPeakPrefix: "峰值 ",
    dailyBudgetCapPrefix: "日上限 ",
    dailyCallSingular: "次调用",
    dailyCallPlural: "次调用",

    budgetActiveSuffix: " 个生效",
    budgetEmptyPrefix: "暂无生效预算。可使用 ",
    budgetEmptyCommand: "bun run set-budget -- --period daily --micro-cents 200",
    budgetPeriodToday: "今日",
    budgetPeriodThisMonth: "本月",
    budgetOverLimitPrefix: "已超出预算 — 新请求会返回 ",
    budgetOverLimitHttpCode: "HTTP 429",
    budgetOverLimitSuffix: "，直到下个周期重置。",

    loopColFingerprint: "指纹",
    loopColModel: "模型",
    loopColAttempts: "尝试次数",
    loopColShare: "占比",
    loopColBlocked: "已拦截",
    loopColLastSeen: "最近一次",
    loopShowMore: "再展开 {n} 个模式",

    modelColModel: "模型",
    modelColCalls: "调用数",
    modelColSpend: "开销",
    modelColShare: "占比",
    modelShowMore: "再展开 {n} 个模型",

    tagSourceLabel: "来自 x-ts-tag header",
    tagColTag: "Tag",
    tagColCalls: "调用数",
    tagColSpend: "开销",
    tagColShare: "占比",
    tagShowMore: "再展开 {n} 个 tag",
    tagFooter:
      "在请求头加 x-ts-tag: feature=summarize,team=growth 即可按 tag 归因开销。带多个 tag 的请求在每个 tag 下都会出现，因此本表合计不会等于全局开销。",

    abTitle: "A/B 实验 · 7d",
    abSubtitle: "shadow 路由",
    abColPrimary: "主模型",
    abColShadow: "Shadow 模型",
    abColTrials: "试验数",
    abColPrimaryCost: "主模型 $",
    abColShadowCost: "Shadow $",
    abColDelta: "Δ（>0 表示节省）",
    abColLatency: "延迟",
    abColErrors: "错误",

    recentLatestPrefix: "最近 ",
    recentEmptyPrefix: "暂无数据。请通过 ",
    recentEmptySuffix: " 发一次请求，落地后会出现在这里。",
    recentColTime: "时间",
    recentColProvider: "服务商",
    recentColModel: "模型",
    recentColInput: "输入",
    recentColOutput: "输出",
    recentColCost: "成本",
    recentColSaved: "节省",
    recentColLatency: "延迟",
    recentColStatus: "状态",
    recentShowOlder: "再展开 {n} 条更早的请求",

    qpSwitchSafeLabel: "可安全切换（≥0.85）",
    qpSwitchSafeAcrossPrefix: "覆盖 ",
    qpSwitchSafeAcrossSuffix: " 条试验",
    qpSwitchSafeOfPrefix: "",
    qpSwitchSafeOfMid: " / ",
    qpSwitchSafeOfSuffix: " 条接近等价",
    qpFooterBody:
      "Shadow 试验会在主请求完成后，于后台并行调用更便宜的模型。Shadow 失败「不会」影响用户看到的回应。Shadow 成功率仅表示后台调用返回了 2xx，是是否可推全的信号，并非生产可用率。平均相似度对两侧回答做向量化后做余弦比对：0.95 以上「几乎等价」、0.85 以上「可安全切换」、低于 0.70「切换前先复核」。设置 TOKENSMART_QUALITY_EMBED_MODEL 后启用。",

    reasonLoopDetected:
      "循环检测拦下了一段重复指纹，未抵达 upstream。",
    reasonBudgetExceeded: "项目预算在 upstream 计费前阻止了本次请求。",
    reasonPlanLimitExceeded: "套餐上限在 upstream 计费前阻止了本次请求。",
    reasonOlderRewriteUnknown:
      "网关重写了模型，但这条早期记录没有保存路由原因。",
    reasonNoRewrite:
      "未发生模型重写，TokSuan 按原样记录与计价。",
    reasonBaseline:
      "Baseline 策略将本次请求归类{bucket}，并在策略容差内选择了更便宜的实际模型。",
    reasonBaselineBucketPrefix: "为 ",
    reasonRule: "命中项目路由规则，模型被重写。",
    reasonFallback: "网关在模型解析失败后自动回退到可用模型。",
    reasonNoCallableCheaper:
      "Baseline 策略将本次请求归类为 {taskType} / {complexity}，但该桶内每一个更便宜的模型都需要本网关无法调用的凭证（BYO 或 env）。补一个对应家族的服务商 key，下一次就会触发路由。",
    reasonNoCheaper:
      "Baseline 策略将本次请求归类为 {taskType} / {complexity}，但策略容差内没有更便宜的候选。请求模型已在该桶的成本前沿或之下。",
    reasonUnknownCallerModel:
      "请求模型不在当前 baseline 策略制品里、也不是已知的服务商前缀，因此 baseline 拒绝重写。请求按原样记录，回执仍保留请求模型名。",
    reasonDisabled:
      "本网关当前未启用 baseline 路由，请求按原样记录与计价。",
    reasonNoModel:
      "请求体中没有 `model` 字段，baseline 策略没有可查询的目标。",

    qualityDoNotRoute: "暂不要切流",
    qualityChecked: "质量已校验",
    qualityHttpSafe: "HTTP 层安全",
    qualityBaselineOnly: "仅 baseline 策略",
    qualityBodyDangerSimilarity:
      "Shadow A/B 已有 {n} 条带相似度评分的试验，平均相似度 {sim}。在复核失败案例之前请保留原本的高质量模型。",
    qualityBodyOkSimilarity:
      "Shadow A/B 已有 {n} 条带相似度评分的试验，平均相似度 {sim}，{pct}% 可安全切换。",
    qualityBodyDangerSuccess:
      "Shadow A/B 已有 {n} 条试验，但只有 {pct}% 的 shadow 调用返回 2xx。主调用仍按原模型回应，但暂不要推全此路由。",
    qualityBodyOkSuccess:
      "Shadow A/B 已有 {n} 条试验，{pct}% 的 shadow 调用返回 2xx。主调用仍按原模型回应；推全前请先开启内容质量评分。",
    qualityBodyBaselineOnly:
      "本回执仅基于路由策略与账本计算。在扩大切流之前，先用 shadow 规则在自己的流量上验证回答质量。",
    qualityActionReviewRouting: "查看路由质量",
    qualityActionReviewProof: "查看证据",
    qualityActionReviewBorderline: "复核边缘试验",
    qualityActionReviewFailures: "复核失败案例",
    qualityActionEnableScoring: "开启质量评分",
    qualityActionAddShadow: "添加 shadow 规则",

    recommendationsTitle: "重点行动",
    recProjectFallback: "（未命名项目）",
    recWastefulPattern:
      "近 7 天内 {project} 中 {fromModel} 收到 {n} 个短 prompt — 值得试一下。把它们路由到 {toModel} 预计可节省约 {saved}。",
    recAddRoutingRule: "添加路由规则",
    recLoopSpike:
      "{project} 在过去 24 小时内拦截到 {n} 次失控循环，建议收紧循环阈值或加告警。",
    recSetAlert: "设置告警",
    recUndersizedBudget:
      "{project} 近 7 天日均开销 {avg}，但日预算只有 {limit}。请求经常被拦下 — 适当上调上限。",
    recEditBudget: "调整预算",
    recNoBudget:
      "{project} 近 7 天开销 {spend}，但还没有设置日预算。一次失控循环就可能跑出几千美元 — 立刻设上限。",
    recSetBudget: "设置预算",

    qpTitle: "质量证据 · 7d",
    qpEmptyHeader: "暂无 shadow 试验",
    qpEmptyBody:
      "想知道更便宜的模型是否真的能处理你的流量、又不影响输出？给任意项目加一条 shadow A/B 路由规则，TokSuan 会在保留主模型的同时，并行调用更便宜的模型，并展示：",
    qpEmptyBullet1Title: "Shadow 成功率",
    qpEmptyBullet1:
      "更便宜模型的后台试验返回 2xx 的比例；用户看到的仍是主模型的输出。",
    qpEmptyBullet2Title: "Shadow 更快",
    qpEmptyBullet2: "更便宜模型在延迟上跑赢主模型的比例。",
    qpEmptyBullet3Title: "成本差",
    qpEmptyBullet3: "如果 shadow 是主模型，本可节省的金额。",
    qpEmptyBullet4Title: "语义相似度",
    qpEmptyBullet4Prefix:
      "对响应嵌入做余弦比较（设置 ",
    qpEmptyBullet4Suffix: " 即可启用）。",
    qpEmptyAddShadow: "添加 shadow 规则 →",
    qpEmptyCreateProject: "先创建一个项目 →",
    qpEmptyHintPrefix: "在「路由规则」中将 Mode 设为 ",
    qpEmptyHintMode1: "shadow",
    qpEmptyHintMode2: "both",
    qpEmptyHintConn: " 或 ",
    qpHeaderCounts: "{e} 个实验 · {t} 条 shadow 试验",
    qpStatSuccess: "Shadow 成功率",
    qpStatSuccessNote: "{n} / {total} 条 shadow 调用返回 2xx",
    qpStatSuccessDangerNote: "暂不要推全 — shadow 失败率过高。",
    qpStatSuccessOkNote: "用户仍然收到主模型的回应。",
    qpStatFaster: "Shadow 更快",
    qpStatFasterNote: "{n} 条试验在延迟上跑赢主模型",
    qpStatCostDiff: "成本差",
    qpStatCostDiffNote: "主模型 − shadow（正值表示 shadow 更便宜）",
    qpAvgSimilarity: "平均语义相似度",
  },

  agentsPage: {
    dayWordSingular: "天",
    dayWordPlural: "天",
    paragraph:
      "按 (agent, session) 配对显示最近 {days} {dayWord}的会话，每行可以下钻看每一轮调用了哪个模型、时间和开销分布。带高 declared/called 工具数 + 非零循环数的 session 通常是 agent 异常的第一现场。",
    windowLabel: "时间窗口：",
    window24h: "24 小时",
    window7d: "7 天",
    window30d: "30 天",
    countLine: "{n} 个会话 • 总开销 {spend}",
    colAgent: "Agent",
    colSession: "Session",
    colTurns: "轮次",
    colSpend: "开销",
    colTokensInOut: "Tokens（输入 / 输出）",
    colP50P95: "p50 / p95",
    colCounters: "工具 / 错误 / 循环 / 预算 / 套餐",
    colLastSeen: "最近活动",
    cellReqSuffix: "次请求",
    cellLastSeenSuffix: "前",

    titleToolCounts: "声明 tools 的请求 / 观察到工具调用的响应",
    titleErrorCounts: "上游错误",
    titleLoopBlocked: "循环检测拦截",
    titleBudgetBlocked: "超预算拦截",
    titlePlanBlocked:
      "托管套餐封顶拦截（Free / Pro / Team 日开销或月请求上限）",

    relSecondsAgo: "{n} 秒前",
    relMinutesAgo: "{n} 分钟前",
    relHoursAgo: "{n} 小时前",
    relDaysAgo: "{n} 天前",
  },

  routingQualityPage: {
    title: "路由质量",
    dayWordSingular: "天",
    dayWordPlural: "天",
    paragraph:
      "对最近 {days} {dayWord}内每一对 (asked → landed) 的模型重写，对比它的成功率与同一落地模型在原生调用时的成功率。成功率分母不计入拦截：循环 / 预算 / 套餐拦截在 upstream 调用之前触发，反映的是 TokSuan 保护层的工作而非路由质量；原始拦截数另行展示。重写在 ≥ 20 次调用样本（含拦截）下相对原生基线下降 ≥ 5 个百分点的会被标红。",
    statTotalRewrites: "总重写次数",
    statOverallSuccess: "整体重写成功率",
    statFlaggedPairs: "标红的重写对",
    statFlaggedNote: "≥ 5pp 下降，≥ 20 次调用",
    sectionRewrites: "重写对",
    rewritesAsked: "请求模型",
    rewritesLanded: "实际模型",
    rewritesCalls: "调用数",
    rewritesSuccess: "成功率",
    rewritesVsNative: "相对原生基线",
    rewritesErrors: "错误",
    rewritesLoopQuota: "循环 / 限额",
    rewritesAvgLatency: "平均延迟",
    rewritesTotalSpend: "总开销",
    sectionPerBucket: "按 baseline 策略桶分组",
    perBucketBody:
      "按 baseline 分类器选中的 (task_type, complexity) 桶分组的成功率。可以看出某个桶（例如 code:hard）路由稳定，而另一个（例如 reasoning:medium）质量在掉。这里只展示 baseline 策略的决定；项目自定义路由规则与未路由的流量不会出现在此。",
    bucketCol: "桶",
    bucketCalls: "调用数",
    bucketSuccess: "成功率",
    bucketErrors: "错误",
    bucketLoopQuota: "循环 / 限额",
    bucketAvgSavedCall: "单次平均节省",
    bucketTotalSpend: "总开销",
    sectionNative: "原生基线（未重写）",
    nativeBody:
      "调用方直接请求落地模型时的成功率，作为上方重写表的对照分母。",
    nativeCol: "模型",
    nativeCalls: "调用数",
    nativeSuccess: "成功率",
    nativeErrors: "错误",
    nativeAvgLatency: "平均延迟",
    nativeTotalSpend: "总开销",
    publicReadOnlyTitle: "公开只读视图。",
    publicReadOnlyBody:
      "登录后可查看你自己项目的路由质量数据。本匿名页永远不展示托管客户的流量。",
    publicSignInCta: "登录",
    emptyData: "本时间窗口暂无数据。",
    queryFailedPrefix:
      "查询失败。可能原因：本页依赖仅 Postgres 支持的聚合，而当前 gateway 在 SQLite 模式。把 DATABASE_URL 切到 Postgres 即可启用。",
    queryFailedDetailPrefix: " 详细：",
    emptyTitle: "最近 {n} 天内尚无路由重写。",
    emptyBodyPrefix:
      "当 baseline 策略或任意项目路由规则重写 ",
    emptyBodyMid:
      " 后，本页就会填充。请发送几次请求后刷新；或在 gateway 日志中查找 ",
    emptyBodySuffix: " 行。",
  },

  settingsPage: {
    sectionTelemetryTitle: "匿名社区遥测",
    sectionTelemetryStatusOff: "网关未开启",
    sectionTelemetryStatusOn: "已开启（匿名聚合）",
    sectionTelemetryBody:
      "通过分享自部署的每日匿名聚合，帮助 TokSuan 完善公开的路由地图。完全自愿；托管用户无需开启，自部署也只有当你的 gateway 进程主动跑下面的命令时才会上报。",
    sectionTelemetryWhatSent: "上报内容",
    sectionTelemetryWhatSentItem1: "每日请求 / 路由 / 拦截计数",
    sectionTelemetryWhatSentItem2: "类似 模型 A → 模型 B 的路由对",
    sectionTelemetryWhatSentItem3: "估算的路由与缓存节省金额",
    sectionTelemetryWhatSentItem4: "仅用于隐私阈值的项目数",
    sectionTelemetryNeverSent: "永不上报",
    sectionTelemetryNeverSentItem1: "Prompt、响应、请求体",
    sectionTelemetryNeverSentItem2: "服务商 API key、用户邮箱、项目名称",
    sectionTelemetryNeverSentItem3: "请求 ID 或精确到毫秒的时间戳",
    sectionTelemetryNeverSentItem4: "低于本地阈值的稀疏路由行",
    sectionTelemetryEndpointPrefix: "网关 endpoint：",
    sectionTelemetryThresholds: "本地阈值：5 个请求且 1 个项目",
    sectionTelemetryDryRunHint: "先在本地 dry-run 一次，查看具体上报的 JSON：",
    sectionTelemetryCronHint:
      "如果可以接受这份聚合数据被上报，再把下面这条加到 cron：",
    sectionTelemetryCopyCron: "复制 cron 命令",

    hostedTelemetryTitle: "社区聚合遥测",
    hostedTelemetryPill: "托管聚合",
    hostedTelemetryBody:
      "托管 TokSuan 流量可参与到「Agent 成本现状」等满足隐私阈值的公开路由统计中。我们仅聚合计数、路由对、节省金额、拦截循环数 — 永不上传 prompt、响应、服务商 API key、项目名称、用户邮箱或单客户级别的行。",
    hostedTelemetryWhat: "托管聚合可以支撑什么",
    hostedTelemetryWhat1: "积累足够流量后公开的路由收益示例",
    hostedTelemetryWhat2: "在护栏内反复证明可省钱的模型对",
    hostedTelemetryWhat3: "聚合层面的循环与预算拦截趋势",
    hostedTelemetryWhat4: "按 tag 的 prompt 缓存节省（不上传原始 prompt）",
    hostedTelemetryHow: "自部署如何后续加入",
    hostedTelemetryHow1: "自部署默认关闭",
    hostedTelemetryHow2: "其「设置」页会展示可一键复制的 cron 命令",
    hostedTelemetryHow3: "可在本地 dry-run 查看具体上报的 JSON",
    hostedTelemetryHow4: "删一行 env 或 cron 即停止上报",
    hostedTelemetryViewProof: "查看公开证据页 →",

    sectionTelemetryStatusUnknown: "网关状态未知",

    deletionScheduledTitle: "账户已计划注销",
    deletionScheduledBodyPrefix: "申请时间 ",
    deletionScheduledBodyMid: "。数据将在 ",
    deletionScheduledBodyDay: " 天",
    deletionScheduledBodyDays: " 天",
    deletionScheduledBodySuffix:
      " 后）按 DPA § 7.2 保留表硬删除。在那之前你仍可正常使用产品；改主意了？",
    deletionCancelBtn: "撤销注销",

    noKeysTitle: "尚未添加任何服务商 API key。",
    noKeysBody:
      " 没有 key 的情况下，网关会使用 env 中的凭证 — 也就是说，上游账单会算到平台运营方（托管时算到我们，自部署时算到你），而不是你自己的账户。",
    noKeysBodyMid:
      "为每个希望 TokSuan 考虑的服务商添加一把 key。复杂度判定默认走同一服务商的 BYO key，因此只配了 OpenAI key 的用户也无需向 Gemini 发送 prompt 来做任务分类。",
    noKeysHint:
      "↓ 在下方表单添加你的第一把 key：选择服务商、粘贴 API key、点击「保存」。",

    customColName: "名称",
    customColPrefix: "模型前缀",
    customColBaseUrl: "Base URL",
    customColKey: "Key",
    customColStatus: "状态",
    customNoAuth: "（无鉴权）",
    customEnabledPill: "已启用",
    customDisabledPill: "已停用",
    customEnableBtn: "启用",
    customDisableBtn: "停用",
    customDeleteBtn: "删除",

    sysCacheDisabled: "已关闭。重复 prompt 每次都会打到上游。",
    sysBaselineDisabled: "已关闭（TOKENSMART_BASELINE_POLICY_ENABLED=0）",

    sysCryptoAws: "AWS KMS 包封加密（生产级）。",
    sysCryptoGcp: "GCP KMS 包封加密（生产级）。",
    sysCryptoEnvMaster:
      "Env 主密钥（开发 / 单租户）。生产环境建议迁移到 KMS。",

    providerKeysNoneTitle: "尚未添加任何服务商 API key。",
    providerKeysNoneBody1:
      "没有 key 的情况下，网关会使用 env 中的凭证 — 也就是说，上游账单会算到平台运营方（托管时算到我们，自部署时算到你），而不是你自己的账户。",
    providerKeysNoneBody2:
      "为每个希望 TokSuan 考虑的服务商添加一把 key。复杂度判定默认走同一服务商的 BYO key，因此只配了 OpenAI key 的用户也无需向 Gemini 发送 prompt 来做任务分类。",
    providerKeysNoneHint:
      "↓ 在下方表单添加你的第一把 key：选择服务商、粘贴 API key、点击「保存」。",
    providerColLastErrorPrefix: "最近错误 ",

    providerHealthTestOk: "✓ 测试通过",
    providerHealthTestFail: "✗ 测试失败",

    emailNextDigestPrefix: "下一封日报：",
    emailNextDigestSuffix: " UTC（每周一 10:00 UTC）。",
    emailNeverSentHosted:
      "尚未发送 — 订阅后，第一封日报将在 {when} UTC 发出。",
    emailNeverSentSelfHost:
      "尚未发送 — 自部署需运维同学手动执行 cron 才会真正发送。",

    providerUsageReqSingular: " 个请求",
    providerUsageReqPlural: " 个请求",

    yourProviderKeysTitle: "你的服务商 API key",
    yourProviderKeysCount: "已配置 {n} 个",
    yourProviderKeysAddAnother: "+ 添加另一个",
    providerColProvider: "服务商",
    providerColKey: "Key",
    providerColUsage30d: "30 天用量",
    providerColHealth: "健康度",
    providerColUpdated: "更新时间",
    providerHealthNoTraffic: "暂无流量",
    providerHealthUsedPrefix: "✓ ",
    providerActionTest: "测试",
    providerActionDelete: "删除",

    quotaTitle: "BYO 上游配额护栏",
    quotaSubtitle: "上游侧上限",
    quotaIntro:
      "TokSuan 在 upstream 之前强制项目预算，但你的 BYO 服务商账号自己也应当设硬上限或账单告警。下表用本地真实流量帮你估算合理上限。",
    quotaColProvider: "服务商",
    quotaCol24h: "24 小时开销",
    quotaCol30d: "30 天开销",
    quotaColSuggested: "建议日上限",
    quotaColRisk: "风险",
    quotaRiskOk: "正常",
    quotaRiskNoTraffic: "暂无流量",
    quotaRiskOkBody:
      "流量较低，但仍建议在服务商侧开启账单告警。",
    quotaRiskNoTrafficBody: "该服务商 key 近期无流量。",
    quotaFooter:
      "建议上限是 TokSuan 账本基于实际用量给的保守提示，并非服务商账号的实际限制。请在 OpenAI、Anthropic、Gemini、DeepSeek、Qwen、Doubao 或自定义上游的控制台里设置真正的硬上限。",

    addProviderTitle: "添加或替换一个服务商 API key",
    addProviderSubtitle: "每个账号下每个服务商保留一条 key",
    addProviderKeyPlaceholder: "粘贴该服务商的 API key",
    addProviderSaveCta: "保存 key",
    addProviderCustomBaseUrl: "可选：自定义 base URL",
    addProviderCustomBaseUrlHelp:
      "只有 Azure OpenAI、私有 endpoint、或上游服务商的区域分支才需要自定义 base URL；标准的 api.openai.com / api.anthropic.com 等留空即可。",
    addProviderRoutingHint:
      "路由逻辑：网关按模型名前缀匹配服务商（claude-* → Anthropic、gpt-* → OpenAI 等）并使用对应 key；找不到 key 时回退到 gateway env 中配置的凭证（自部署通常由运维持有）。",
    addProviderStorageHint:
      "存储：AES-256-GCM 密文 + 末 4 位用于显示。明文在落 Postgres 之前已加密，不会写入日志。",

    rejectedTitle: "无法路由的模型（最近 7 天）",
    rejectedSubtitle: "{n} 个不同模型",
    rejectedIntro:
      "下表列出 agent 请求过、但网关无法路由的模型。修复方式：要么补上对应服务商的内置 key（上方「你的服务商 API key」），要么在下方「自定义上游服务商」里登记。",
    rejectedColModel: "模型",
    rejectedColReason: "原因",
    rejectedColProvider: "服务商（推断）",
    rejectedColHits: "命中次数",
    rejectedColProjects: "项目数",
    rejectedColLastSeen: "最近一次",
    rejectedActionRegister: "登记为自定义 ↓",
    rejectedActionAddKey: "添加 {provider} 的 key ↓",

    customTitle: "自定义上游服务商",
    customCount: "已登记 {n} 个",
    customIntro:
      "用于接入网关本身不识别的、任何 OpenAI 兼容的 endpoint — Groq、xAI、Mistral 直连、自部署 vLLM / Ollama、企业内部 endpoint 等。网关按 model_prefix 做不区分大小写的前缀匹配进行路由，请挑选足够具体的前缀以避免与其它服务商冲突。本地无需鉴权的 endpoint 可留空 API key。对于自部署模型，TokSuan 默认提供路由 / 容量证据；只有在你提供价格或资源池成本元数据后，才能给出精确的金额节省。",
    customNamePlaceholder: "名称（如 my-groq）",
    customPrefixPlaceholder: "模型前缀（如 groq/）",
    customBaseUrlPlaceholder: "base_url（如 https://api.groq.com/openai/v1）",
    customApiKeyPlaceholder: "API key（可选 — 本地无鉴权 endpoint 如 vLLM 可留空）",
    customRegisterCta: "登记",
    customWireFormatHint:
      "通信协议：自定义服务商必须支持 OpenAI 的 /v1/chat/completions 协议。Anthropic 原生 /v1/messages 在此处不受支持 — Claude 请通过上方 BYO-key 使用内置 Anthropic 服务商。",
    customPricingHint:
      "价格 + 自动路由：自定义服务商可以正常转发，但 TokSuan 无法自动得知你的自部署 GPU 成本。预留使用 global_max 安全预算；除非配置了 价格 / 资源池元数据，否则金额节省按「不可用」处理。需要为自定义 endpoint 加价格 + 质量 benchmark 时，请提一个 GitHub issue。",
    customResolutionHint:
      "解析顺序：自定义服务商优先于内置识别器，因此自定义的 gpt- 前缀会覆盖内置的 OpenAI 路由。请挑选不会冲突的具体前缀，除非你确实想覆盖。",

    sysIntegrationsTitle: "系统集成",
    sysIntegrationsSource: "来自 gateway /health · 缓存 30s",
    sysIntegrationsCol1: "集成项",
    sysIntegrationsCol2: "状态",
    sysIntegrationsCol3: "为何 / 如何启用",
    sysFailoverTitle: "跨服务商故障切换",
    sysFailoverStatusEmpty: "未配置 failover 映射。",
    sysFailoverHint:
      "在网关上设置 TOKENSMART_FAILOVER_MAP 环境变量，例如 \"gpt-4o=>claude-3-5-sonnet-latest,gpt-4o-mini=>claude-3-5-haiku-latest\"。在重试用尽后，遇到 5xx / 429 / 网络瞬时错误时触发。",
    sysMultiKeyTitle: "多 key 轮换",
    sysMultiKeySingle: "（单 key）",
    sysMultiKeyHint:
      "在环境变量中以逗号分隔多个 key（如 OPENAI_API_KEY=sk-1,sk-2,sk-3）。按请求轮询，遇到 429 时该 key 暂停 30 秒（或上游 Retry-After 指定的秒数）。",
    sysOtelTitle: "OpenTelemetry trace 上报",
    sysOtelStatusEmpty: "未配置，span 未上报。",
    sysOtelHint:
      "设置 OTEL_EXPORTER_OTLP_ENDPOINT（Langfuse / Datadog / Tempo / Honeycomb / Phoenix 都支持 OTLP/HTTP/JSON）。每次 chat completion 一个 span，带 gen_ai.* + tokensmart.* 属性。",
    sysQualityEmbedTitle: "质量嵌入（shadow A/B）",
    sysQualityEmbedStatusEmpty: "未配置。质量证据卡只显示状态信号。",
    sysQualityEmbedHint:
      "设置 TOKENSMART_QUALITY_EMBED_MODEL=text-embedding-3-small，即可对 shadow 与主模型的回答做余弦相似度比对。每条 shadow 试验约 $0.0002。",
    sysByoEncTitle: "BYO key 加密后端",
    sysByoEncStatusEmpty:
      "BYO key 未启用 — 网关只使用 env 中的凭证。",
    sysByoEncHint:
      "生产环境请配置 TOKENSMART_KMS_KEY_ARN（AWS）或 TOKENSMART_GCP_KMS_KEY_NAME（GCP）。本地开发用 env 主密钥即可。",
    sysCacheTitle: "语义缓存",
    sysCacheMaxEntries: "最大条目数：",
    sysCacheTtl: "TTL：",
    sysCacheSimThreshold: "相似度阈值：",
    sysCacheHint:
      "设置 TOKENSMART_CACHE_ENABLED=1 即可启用内存中的精确匹配缓存。再加 TOKENSMART_CACHE_SIMILARITY_THRESHOLD=0.95（与 TOKENSMART_QUALITY_EMBED_MODEL）即可启用基于嵌入的近似匹配。命中条目记为 cost=$0 的请求，并带 `cached_by` 标签。",
    sysBaselineTitle: "Baseline 路由策略",
    sysBaselineVersion: "版本：",
    sysBaselineBuckets: "已加载 {n} 个桶",
    sysBaselineHint:
      "基于公开 benchmark 的成本-质量前沿策略。简单 / 中等 turn 倾向更便宜的模型；除非有强证据，复杂 / 旗舰任务保留高质量模型。",

    emailPrefsTitle: "邮件偏好",
    emailWeeklyTitle: "每周节省日报",
    emailWeeklyBody:
      "每周一封邮件，汇总 TokSuan 上一周为你节省了多少 — 包含路由 + 缓存拆分、最值得关注的路由对、当前开销节奏。通过 Resend 发送。完全自愿（不会自动订阅）。",
    emailLastSentPrefix: "上次发送：",
    emailOperatorNote:
      "运维注：即便订阅了，也只有当有人执行 `bun run send-weekly-savings`（通常通过 cron / Fly Machines / GitHub Actions）时才会真正发出。自部署需要自己排定任务。",
    emailSubscribeBtn: "订阅",
    emailUnsubscribeBtn: "退订",
    emailSubscribed: "● 已订阅",
    emailUnsubscribed: "○ 未订阅",

    privacyTitle: "数据与隐私",
    privacySubtitle: "自助操作 · 与 DPA 一致",
    privacyExportTitle: "导出我的数据",
    privacyExportBody:
      "下载与本账号相关的全量 NDJSON 归档：账户资料、项目、API key 元数据、预算、路由 + 告警规则、prompt 模板。审计事件与请求各最多取最近 10000 行（重度 agent 队列一天就可能超过；如需完整历史 dump 请提一个 GitHub issue，我们会在 GDPR § 12 一个月内回应）。归档不含 API key 明文（只在创建那一刻显示过一次）。Stripe 发票详情也不在内 — 请走 Stripe 自己的数据主体请求流程。",
    privacyExportCta: "下载 NDJSON",
    privacyDeleteTitle: "注销账户",
    privacyDeleteBody:
      "标记账户为待删除。30 天宽限期内可在本页随时撤销。T+30 天后将按 DPA § 7.2 保留表硬删除一切，仅保留审计事件（SOC-2 要求 3 年）与账单记录（法律要求 7 年），且这两类数据将不再与活跃用户绑定。如果你拥有带其他成员的组织，请先转让所有权。",
    privacyDeleteConfirmHint:
      "请在下方输入框中精确输入大写的 DELETE 进行确认。",
    privacyDeletePlaceholder: "DELETE",
    privacyDeleteSchedule: "排期删除",
    apiKeyHashedAtRestTooltip: "静态存储为哈希",
    providerLastErrorTooltip: "该服务商最近一次上游错误",
    providerLastSuccessTooltip: "最近一次成功的上游调用",
    customPrefixTooltip:
      "前缀匹配，不区分大小写。例如：'groq/' 匹配 groq/mixtral-8x7b。",
  },

  projects: {
    listTitle: "项目",
    listTagline:
      "创建一个项目、获取一个 API key、改一行 base_url，然后在 Dashboard 看到你第一份省钱的回执。",
    createButton: "创建项目",
    namePlaceholder: "my-agent",
    emptyTitle: "还没有项目",
    emptyBody:
      "创建第一个项目，生成一个 TokSuan API key，作为 OpenAI 兼容的 base URL 直接给 agent 使用。",
    providerJustSavedTitle: "服务商 API key 已保存。下一步：创建项目 API key。",
    providerJustSavedBody:
      "你的上游服务商 API key 在「设置」中加密保存。Agent 不直接使用该 key，而是使用以 ts_ 开头的 TokSuan 项目 key。",
    providerJustSavedCta: "打开 {project} 并创建项目 API key →",
    cardCreated: "创建于",
    cardOpen: "打开 →",
    cardDelete: "删除",
    confirmDelete: "确定删除该项目？所有 API key 和请求历史都会被移除。",

    fastPathTitle: "快速路径：创建 POC 项目",
    fastPathBody:
      "先创建项目；下一屏会让你命名 API key，并一次性显示完整密钥与可直接运行的 curl / SDK 接入步骤，让你拿到第一份省钱回执。",
    fastPathCreateBtn: "创建默认项目",
    fastPathAddKeyBtn: "先添加服务商 API key",

    listColName: "名称",
    listColCreated: "创建时间",
    listColProjectId: "项目 ID",
    listDeleteTitle: "删除该项目并吊销其 API key",

    sidebarBackAll: "← 全部项目",
    sidebarGroupConfigure: "配置",
    sidebarGroupReference: "参考",
    sidebarApiKeys: "API key",
    sidebarBudgets: "预算",
    sidebarRouting: "路由规则",
    sidebarAlerts: "告警",
    sidebarTemplates: "Prompt 模板",
    sidebarTags: "成本标签",
    sidebarPolicy: "路由策略",
    sidebarSetup: "接入说明",
    sidebarGettingStarted: "快速开始",
    sidebarAriaLabel: "项目分区",
    sidebarMainTitleFallback: "项目",

    revealHeading: "新 API key — 请立即复制",
    revealBody:
      "完整 API key 仅在本页显示一次。离开或刷新后即不可见，我们仅保留 SHA-256 哈希与前缀 + 末 4 位用于展示。",
    revealUseInAgent: "在 agent 中使用此 key",
    revealOrCopyCurl: "或复制一段可直接运行的 smoke 测试：",
    revealCopyCurlBtn: "复制 curl 命令",
    revealOpenDashboard: "打开 Dashboard 查看回执 →",

    gettingStartedTitle: "下一步：发送第一条请求",
    gettingStartedHeaderHint: "首次回执准备",
    gettingStartedBody:
      "项目已经创建好，但近期没有请求落地。Agent 需要一个以 ts_ 开头的 TokSuan 项目 key。「设置」中的服务商 API key 用于上游计费；项目 key 才是 agent 真正发给 TokSuan 的凭证。",
    gettingStartedKeyNamePlaceholder: "key 名称，例如 cursor-demo",
    gettingStartedCreateBtn: "创建 API key 并显示 curl →",
    gettingStartedFreshKeyName: "key 名称，例如 first-receipt",
    gettingStartedFreshBtn: "创建新的 API key →",
    gettingStartedAlreadySent: "我已经发过请求",
    gettingStartedExistingHint:
      "本项目已有 {n} 个 API key，但完整密钥只在创建时显示一次。如未保存，请新建一个 — 下一屏会展示完整 ts_ key 与可直接运行的 curl 命令。",
    gettingStartedTemplateHint:
      "如果你仍保留着完整的 ts_ key，可以将它粘贴到下方模板：",

    setupTitle: "接入说明",
    setupHeaderHint: "base_url + API key",

    apiKeysTitle: "API key",
    apiKeysNamePlaceholder: "key 名称（必填）",
    apiKeysNewBtn: "新建 key",
    apiKeysEmpty: "暂无 API key，请在上方创建一个。",
    apiKeysColName: "名称",
    apiKeysColKey: "Key",
    apiKeysColCreated: "创建时间",
    apiKeysColLastUsed: "上次使用",
    apiKeysLastUsedNever: "从未使用",
    apiKeysGracePrefix: "● 宽限期 · ",
    apiKeysGraceExpiresHM: "{h} 小时 {m} 分后过期",
    apiKeysGraceExpiresM: "{m} 分钟后过期",
    apiKeysRotateBtn: "轮换",
    apiKeysRotateTitle:
      "生成一把替换 key，旧 key 仍保留 24 小时有效，让滚动部署不会 401。请在宽限期结束前更新 env。",
    apiKeysDeleteBtn: "删除",
    apiKeysDeleteNowBtn: "立即删除",
    apiKeysDeleteNowTitle: "立即作废该 key，提前结束 24 小时宽限期。",
    apiKeysFootnote:
      "新 key 仅以 SHA-256 哈希加上前缀 + 末 4 位形式存储用于展示。已存在的明文 legacy key 仍然有效 — 通过创建新 key 并删除旧 key 进行轮换。删除即时生效。",
    apiKeysHashedAtRestTooltip: "静态存储为哈希",

    tagsTitle: "为请求加 tag 做成本归因",
    tagsCopyHeaderBtn: "复制示例 header",

    templatesTitle: "Prompt 模板",
    templatesManageBtn: "管理 →",

    budgetsTitle: "预算",
    budgetsActiveSuffix: " 个生效",
    budgetsEmpty:
      "暂未配置预算。可从上方预设中选择，或自定义金额 — 支持低于 1 美分的限额（例如 0.001）。",
    budgetsColPeriod: "周期",
    budgetsColLimit: "上限",
    budgetsColStatus: "状态",
    budgetsColUpdated: "更新时间",

    routingTitle: "路由规则",
    routingPolicyChangelog: "策略变更日志 →",
    routingClassifierChangelog: "分类器变更日志 →",
    routingPolicyChangelogTooltip: "项目级路由策略版本，由每夜重训生成",
    routingClassifierChangelogTooltip:
      "项目级嵌入分类器版本 + 各类别指标 + 回滚",
    routingConfiguredSuffix: " 条已配置",
    routingEmpty:
      "暂无路由规则。可从上方预设中选择，或用模型选择器 + 阈值滑块自定义。内置 baseline 策略仍会自动路由 — 此处的项目级规则始终最先生效。",
    routingColMode: "模式",
    routingColFromPattern: "源 pattern",
    routingColToModel: "目标模型",
    routingColShadow: "Shadow 模型",
    routingColThreshold: "阈值",
    routingColSample: "采样",
    routingColStatus: "状态",

    alertsTitle: "告警",
    alertsSubscribedSuffix: " 项已订阅",
    alertsEmpty: "暂无告警订阅。",
    alertsColNotifyWhen: "触发条件",
    alertsColSendTo: "通知到",
    alertsColEmail: "邮箱",
    alertsColStatus: "状态",
    alertsColCreated: "创建时间",
    alertsStatusEnabled: "已启用",
    alertsStatusDisabled: "已停用",
    alertsDeleteBtn: "删除",
    alertsEmailOk:
      "✓ 邮件投递已开启 — 「Email」列里的订阅者会收到真实邮件",
    alertsEmailOkFromPrefix: "（发件人 ",
    alertsEmailNotConfigured:
      "⚠ 本服务器尚未启用邮件投递 — 暂时请通过群消息通知。邮件行仅会写入 gateway 的控制台日志。",
    alertsEmailSelfHostSummary: "自部署运维：如何启用邮件",
    alertsEmailSelfHostBody:
      "在 gateway 进程上设置 RESEND_API_KEY（可选 RESEND_FROM）后重启即可。Gateway 直接通过 Resend HTTP API 发送邮件，无需配置 SMTP。",
    alertsFooter:
      "告警事件触发时，gateway 会向你的群发送一条简短消息（如设置了邮件也会发邮件）。成本异常告警两次之间至少间隔 6 小时，避免某个糟糕的下午刷屏。订阅保存后，可点击行内「测试」立即触发一条样本，确认能正常收到。",
    alertsTestBtn: "测试",

    setupBody:
      "把你 OpenAI 兼容客户端的 base_url 改为上方的 gateway URL，使用下方任一 API key，继续按 OpenAI 协议调用 /v1/chat/completions。Gateway 会根据你已经在 model 字段里写的模型名挑选上游服务商 — 除了 base_url 不需要改任何代码。每条响应都会带 X-Tokensmart-* 证据 header，让你不必离开终端就能看到请求模型、实际模型、路由原因、实际成本与节省金额。",
    setupResolveTitle: "兼容一切 — 解析顺序如下",
    setupResolve1Title: "主流服务商，开箱即用。",
    setupResolve1Body:
      "我们内置了 OpenAI、Anthropic、Google Gemini、DeepSeek、Qwen、Doubao 的凭证 + 路由策略。把它们的任一模型名写入 model 字段即可立即使用。付费套餐会基于你自己的流量做后台学习；托管 catalog 的更新会在产品内同步呈现。",
    setupResolve2Title: "用你自己的账号调用以上任一家。",
    setupResolve2BodyPrefix: "在",
    setupResolve2BodyLink: "「设置 → 服务商 API key」",
    setupResolve2BodySuffix:
      "中上传你自己的服务商 API key，本项目流量便会通过你自己的账户结算，覆盖 gateway 默认凭证。",
    setupResolve3Title: "任何其它 OpenAI 兼容 endpoint。",
    setupResolve3BodyPrefix:
      "Groq、xAI、Mistral 直连、自部署 vLLM / Ollama — 在",
    setupResolve3BodyLink1: "「设置 → 服务商 API key」",
    setupResolve3BodyMid:
      "中按 base URL + model prefix 注册一个自定义上游即可。流量转发立即可用。对于自部署模型，TokSuan 可以证明流量已经从大模型 endpoint 切走；要给出精确金额节省则需要你提供价格或 GPU 资源池成本元数据（可在",
    setupResolve3BodyLink2: "GitHub issue",
    setupResolve3BodySuffix: " 中提需求，或等待下一次 catalog 更新）。",
    setupResolve4Title: "我们尚未收录的全新模型名。",
    setupResolve4Body:
      "只要前缀匹配某个已知服务商（例如刚发布的 gpt-* 或 claude-*），请求仍会正常转发。计价采用保守的安全预留，等下一次 catalog 更新补上精确数字。",
    setupPrincipleBodyPrefix:
      "原则：先证明价值，再做调优。先发一次请求、查看回执，再在数据指引下加预算、路由规则或 shadow 试验。各 agent 框架的快速接入参考",
    setupPrincipleBodyLink: "接入文档",
    setupPrincipleBodySuffix: "。",

    tagsBodyPrefix: "在通过本项目 API key 发出的请求里加上 ",
    tagsBodyMid:
      " 头，TokSuan 就会在 Dashboard 的",
    tagsBodySuffix:
      "卡片中按 tag 归因开销。逗号分隔的 key=value 对（每个请求最多 20 对，key 最多 64 字符，value 最多 256 字符）。无需任何额外配置 — 加 header 即可。",
    tagsExampleCurl: "curl",
    tagsExamplePythonSdk: "OpenAI Python SDK",
    tagsCommonDimsPrefix: "常用 tag 维度：",
    tagsCommonDimsSeparator: "、",
    tagsCommonDimsSuffix:
      "。可使用任意标识符样的字符串；value 中暂不支持逗号与等号。",
    tagsFrameworksHintPrefix:
      "各框架（LangChain、Vercel AI SDK、Cline、Cursor）的接入方式见",
    tagsFrameworksHintLink: "接入指南",
    tagsFrameworksHintSuffix: "。",

    templatesBodyPrefix:
      "在 TokSuan 中保存并版本化你的系统 prompt，然后让 agent 在请求中带上 ",
    templatesBodyMid:
      " 头。Gateway 会在请求时解析模板并将其作为 system message 注入，于是在 Dashboard 修改 prompt 后无需改一行代码即生效。可用 ",
    templatesBodySuffix:
      " 锁定特定版本；不带后缀则自动跟随当前版本。每次保存都会保留历史版本，便于回滚或 A/B。",
    templatesVarsHintPrefix: "变量 ",
    templatesVarsHintMid1: " 会从请求体中的 ",
    templatesVarsHintMid2:
      "（适合较大值）或 JSON 编码的 ",
    templatesVarsHintMid3:
      " header 中填入。每次解析模板的请求都会被打上 ",
    templatesVarsHintMid4: " + ",
    templatesVarsHintMid5:
      " 标签，因此 Dashboard 的「按 tag 分组的开销」卡片会自动按模板版本拆分成本。",
    templatesVarsHintSuffix: "",

    smokeIntroPrefix: "我们从当前 ",
    smokeIntroFamilyMid: " 家族中选了旗舰模型 ",
    smokeIntroBucketMid: "（位于 ",
    smokeIntroBucketSuffix: " 任务桶）— 你的 ",
    smokeKeyDirectPrefix: " key 会直接调用它，TokSuan 会路由到更便宜的 ",
    smokeKeyDirectSuffix: "",
    smokeRouteDownPrefix: "",
    smokeSameFamilyNote: "（同一家族）",
    smokeSavingsSuffix: "，预计每次调用节省约 {usd}。",

    noRoutableTitle: "添加一个服务商 API key 即可开始拿到回执。",
    noRoutableNoKey: "你还没有添加任何服务商 API key",
    noRoutableNoneInPolicy:
      "你的服务商 API key（{keys}）都不在当前策略中",
    noRoutableBody:
      "{prefix}{policyVer}，所以我们没法挑出一个肯定能调用 upstream 的 smoke 模型。任选一个我们 benchmark 过的服务商，加上 key 后即可生成可用的 curl。",
    noRoutableUnlockPrefix: "目前最容易开通的服务商：",
    noRoutableUnlockOr: " 或 ",
    noRoutableUnlockComma: "、",
    noRoutableAddBtn: "添加服务商 API key →",

    policyTitle: "路由策略",
    policyChangelogLink: "完整变更日志 →",
    policyActiveLabel: "当前版本",
    policyShippedBaseline: "内置 baseline",
    policyTrainedSamplesPrefix: "已基于 ",
    policyTrainedSamplesSingular: " 条样本训练",
    policyTrainedSamplesPlural: " 条样本训练",
    policyNoActive: "暂无激活的项目版本",
    policyNeverTrained: "尚未训练",
    policySaved30dLabel: "近 30 天节省",
    policySaved30dNote: "路由 + 缓存合计",
    policyLearningLabel: "学习",
    policyLearningOn: "已开启",
    policyLearningPaused: "已暂停",
    policyLearningOnNote: "每晚自动再训练",
    policyLearningFrozen: "当前策略已冻结",
    policyLearningEmptyNote: "尚无每晚再训练",
    policyShadowSetupBodyPrefix:
      "学习已开启，但还未训练出项目级版本 — 每晚再训练需要 shadow A/B 数据作为输入。请打开",
    policyShadowSetupRoutingLink: "「路由规则」",
    policyShadowSetupMid: "添加一条采样的 shadow 规则，或在",
    policyShadowSetupPolicyLink: "「策略页」",
    policyShadowSetupSuffix: "查看精确的 CLI 命令。",
  },

  settings: {
    title: "账户与密钥",
    tagline:
      "添加 TokSuan 代你调用的上游服务商 API key、管理账户级邮件偏好，以及导出或删除你的数据。",
    sectionByoProviders: "自带服务商 API key",
    byoIntro:
      "每个服务商 API key 都在静态存储时加密。TokSuan 会通过你在此处启用的服务商路由请求。",
    byoEnabledHelp: "已启用 — TokSuan 可以路由到该服务商。",
    byoDisabledHelp: "已停用 — 已保存，但选择路由时会跳过该服务商。",
    byoSavedAt: "保存时间",
    byoTestPass: "测试通过",
    byoTestFail: "测试失败",
    byoTesting: "测试中…",
    byoTestNever: "尚未测试",
    apiKeyLabel: "API key",
    apiKeyPlaceholder: "粘贴该服务商的 API key",
    apiKeyEnabledLabel: "用于路由",
    saveProvider: "保存",
    deleteProvider: "删除",
    confirmDeleteProvider:
      "确定移除该服务商 API key？TokSuan 会停止路由到该服务商，直到你重新添加 key。",
    sectionWeeklyDigest: "每周节省日报",
    weeklyDigestIntro:
      "周一会发一封简短邮件，包含上一周的开销、节省与最具代表性的路由收益，邮件中可一键退订。",
    weeklyDigestEnabled: "发送每周日报",
    weeklyDigestDay: "每周一上午（UTC）发送。",
    sectionDangerZone: "危险操作",
    dangerExportTitle: "导出数据",
    dangerExportBody:
      "下载 JSON 归档文件，包含本账户下的所有项目、请求、预算与路由规则。",
    dangerExportCta: "下载导出",
    dangerDeleteTitle: "注销账户",
    dangerDeleteBody:
      "标记账户为待删除。30 天内可以撤销，30 天后数据会被永久删除。",
    dangerDeleteCta: "标记为删除",
    dangerDeleteCancel: "撤销删除",
    accountDeletedBanner: "本账户已被标记为待删除。如果不是本意，请在下方撤销。",
  },

  agents: {
    title: "Agent 会话",
    tagline:
      "按 x-ts-agent + x-ts-session 头分组的请求集合，方便你跨多轮跟踪一段对话。",
    backDashboard: "← 返回 Dashboard",
    emptyTitle: "暂无 agent 会话",
    emptyBody:
      "请在每次请求中带上 x-ts-agent、x-ts-session、x-ts-turn 头，TokSuan 会按它们分组成会话。",
    columnAgent: "Agent",
    columnSession: "Session",
    columnTurns: "轮次",
    columnSpend: "开销",
    columnLast: "最近活动",
    sessionTitle: "会话",
    sessionBackAll: "← 全部 agent 会话",
    sessionTurns: "次请求",
    sessionOk: "成功",
    sessionErr: "非成功",
    sessionTools: "工具调用",
    sessionSpent: "开销",
    sessionElapsed: "时长",
  },

  requests: {
    title: "请求详情",
    backDashboard: "← 返回 Dashboard",
    sectionPromptMessages: "Prompt 消息",
    sectionAssistantText: "助手回复",
    sectionRouting: "路由决策",
    sectionReplay: "Replay",
    emptyMessages: "请求体里未解析到消息。",
    askedModel: "请求模型",
    landedModel: "实际模型",
    routingReason: "路由原因",
    cost: "成本",
    saved: "节省",
    latency: "延迟",
    inputTokens: "输入 token",
    outputTokens: "输出 token",
    totalTokens: "Token 合计",
    projectName: "项目",
    sessionId: "Session",
    turnId: "Turn",
    agentName: "Agent",
    channel: "Channel",
    requestId: "请求 ID",

    dbErrTitle: "数据库无法连接。",

    routedTitle: "已路由到更便宜的模型",
    routedSavedPill: "相比原始模型节省 {amount}",
    routedReplaceBody: "TokSuan 替换了请求的模型：",
    routedLockHeader:
      "希望本项目今后所有请求 {model} 都自动走这条路由？一键即可加为项目级规则（阈值之后可调整）。",
    routedLockButton: "锁定为项目规则",

    statCost: "成本",
    statInputTokens: "输入 token",
    statInputCachedSuffix: " 来自缓存",
    statOutputTokens: "输出 token",
    statLatency: "延迟",
    statProjectKey: "项目 · Key",
    statFingerprint: "指纹",

    replayTitle: "Replay 这条请求",
    replayHeaderHint: "新增一条记录，不修改原有请求",
    replayIntroPrefix:
      "用同一份请求体重新调用另一个模型。新请求会落到账本里，并打上 ",
    replayIntroMid: "",
    replayIntroSuffix:
      " 标签，便于并排对比成本与质量。会消耗你为对应服务商配置的 BYO 凭证。",
    replayModelPlaceholder: "要 replay 的模型",
    replayButton: "Replay",
    replaySetupPill: "需要先配置",
    replaySetupBody:
      "Replay 会用同一段 prompt 重新调用另一个模型，并写入一行新记录，便于并排对比成本与质量。它在 dashboard 与 gateway 之间使用共享密钥，仅本进程（而非公网任意来源）可以 POST gateway 的 /internal/replay endpoint。",
    replaySetupStep1: "生成一段 32 字节的共享密钥：",
    replaySetupStep2Prefix: "把",
    replaySetupStep2Same: "相同",
    replaySetupStep2Mid: "的值粘贴到",
    replaySetupStep2Both: "两个",
    replaySetupStep2Suffix: "进程的 env 文件中：",
    replaySetupStep3Prefix: "重启两个 ",
    replaySetupStep3Suffix: " 进程 — 此卡片随后会切换为 replay 表单。",
    replaySetupFooter:
      "两个进程中该值必须逐字节一致，不要加引号。也不要加 NEXT_PUBLIC_ 前缀，这只在服务端使用。",

    loopTimelineTitle: "循环时间线 · 24h",
    loopTimelineCallsSuffix: " 次调用",
    loopTimelineSpanSuffix: " 跨度",
    loopTimelineTotalSuffix: " 合计",
    loopTimelineBlockedSuffix: " 被拦截",
    loopTimelineBody:
      "下方展示所有共享指纹 {fingerprint} 的请求。高的标记是当前这条，点击其他刻度可跳转。",
    loopTimelineAriaTpl: "{n} 次调用时间线",

    errorTitle: "错误",

    rawRequestBody: "原始请求体",
    rawResponseBody: "原始响应体",
    emptyResponseBody: "无响应体 — 请求未抵达 upstream。",
  },

  agentSession: {
    summary:
      "{requests} {reqWord} • {ok} 成功 / {err} 非成功 • 声明 {tools} 个工具 / 实际调用 {observed} 个 • 开销 {spent}（输入 {tokensIn} / 输出 {tokensOut} token），耗时 {elapsed}，开始于 {when}",
    requestsSingular: "次请求",
    requestsPlural: "次请求",
    statusOk: "成功",
    statusLoop: "循环",
    statusBudget: "超预算",
    statusPlan: "套餐封顶",
    statusError: "错误",
    colIndex: "#",
    colTurn: "Turn",
    colModel: "模型",
    colStatus: "状态",
    colInOut: "输入 / 输出",
    colCost: "成本",
    colLatency: "延迟",
    colTools: "工具",
    colWhen: "时间",
    cellCachedSuffix: " 来自缓存",
    cellToolCalled: "已调用",
    cellToolDeclared: "已声明",
    cellToolNoneTitle: "未观察到工具调用",
    titleObservedTools: "观察到的工具调用：{names}",
    titleObservedFinish: "观察到 finish_reason 为工具调用",
    titleDeclaredTools: "声明的工具：{names}",
    titleDeclaredArray: "请求体中声明了 tools[] 数组",
    titleCachedTokens: "命中缓存的输入 token（不计 upstream 费用）",
    viewLink: "查看 →",
    nonSuccessTitle: "最近的非成功请求",
  },

  billing: {
    title: "账单与套餐",
    tagline:
      "当前套餐、本计费周期内的使用情况，以及如何变更套餐或取消。",
    sectionCurrentPlan: "当前套餐",
    planLabel: "套餐",
    upgradeCta: "升级",
    manageSubscription: "管理订阅",
    sectionSavings: "节省回执",
    savingsBody:
      "TokSuan 仅在托管套餐上收费。自部署同样使用相同的网关运行时，免费。",
    sectionTransfers: "待处理的账单转移",
    transfersEmpty: "暂无待处理的转移。",
    transferCancel: "取消转移",
    usageDailyLabel: "今日使用",
    usageMonthlyLabel: "本月使用",
    usageUnlimited: "无限制",

    paybackTitle: "Pro 回本测算",
    paybackPaysThisWeek: "本周节省即可覆盖 Pro 月费",
    paybackPaysIn: "约 {days} 天即可回本 Pro",
    paybackKeepProving: "再多积累一些数据再考虑升级",
    paybackRunFirst: "先跑些真实流量，再考虑升级",
    paybackBodyPrefix: "近 30 天累计节省 ",
    paybackBodyMid: "（相对最初请求的模型）。",
    paybackBodySuffix: "建议节省金额超过 $29/月 Pro 套餐费用后再升级。",
    paybackComparePlans: "对比套餐 →",
    paybackSendFirst: "发送第一条请求 →",
    paybackEstimate: "评估节省",
    paybackLast30: "近 30 天",
    paybackRoutedSuffix: " 次路由",
    paybackCacheSingular: " 次缓存命中",
    paybackCachePlural: " 次缓存命中",

    whyTitle: "团队为什么选择托管版",
    why1Title: "先看证据再付费。",
    why1Body:
      "Dashboard 显示请求模型、实际模型、路由原因、实际成本与预估节省，可在升级前用自己的真实流量验证价值。",
    why2Title: "服务商 API key 自带。",
    why2Body:
      "OpenAI / Anthropic 等服务商账单仍直接由你结算，TokSuan 不参与任何 token 收款。",
    why3Title: "目前固定 $29 / $99 / $499 月费。",
    why3Body:
      "Pro 适合个人，Team 适合小型工程团队，Scale 适合重度 agent 队列 + SSO。可预期：不抽 token 差价、不按请求计费、不会有意外的超额账单。（Enterprise 双向商谈，见下方卡片。）",
    why4Title: "完全相同的产品，自部署免费。",
    why4Body:
      "托管费覆盖：基于 KMS 的 BYO key 存储、Stripe 计费、定时任务、付费套餐的后台再训练，以及由我们值班，你不必自己 on-call。",
    why5Title: "包含 Trust 资料包。",
    why5BodyPrefix: " ",
    why5BodyLink: "安全审查同事",
    why5BodySuffix:
      "可一处看到 BYO key 流程、KMS 部署形态、请求保留策略、DPA 链接以及当前可靠性边界。",
    why6Title: "按月计费，可随时取消。",
    why6Body:
      "不退款 — 单次最大风险只是当月你已使用周期对应的订阅费。可在 Stripe 客户门户即时取消，无追溯收回，无离场访谈。",
    whyEstimateLink: "评估你的节省 →",

    notYetTitle: "暂时不必升级的情况",
    notYet1Title: "月支出不足 $50？",
    notYet1BodyPrefix: "免费版或",
    notYet1BodyLink: "自部署",
    notYet1BodySuffix: "更合适，节省金额本身就在噪声范围内。",
    notYet2Title: "已经全在用便宜模型？",
    notYet2Body: "先验证缓存 / 循环节省，路由层的上行空间可能有限。",
    notYet3Title: "今天就需要正式 SLA / SOC 2？",
    notYet3BodyLink1: "请走自部署",
    notYet3BodyMid: "，或在 ",
    notYet3BodyLink2: "GitHub issue",
    notYet3BodySuffix: " 中开启对话。托管 SLA 暂未正式化。",
    notYet4Title: "无法 BYO 服务商 API key？",
    notYet4Body: "TokSuan 不做 token 转售，目前托管套餐都假设 BYO。",

    roadmapTitle: "定价路线图 — 不是当前价格",
    roadmapBodyPrefix:
      "目前付费套餐为固定月费。计划在 2026 Q3 切换到 ",
    roadmapBodyCode: "max(下限, min(费率 × 当月节省, 上限))",
    roadmapBodySuffix: "，让轻度用户付得更少，同时重度用户也不会超过套餐封顶：",
    roadmapPro: "· Pro：max($9, min(10% × 节省, $29))",
    roadmapTeam: "· Team：max($29, min(10% × 节省, $99))",
    roadmapScale: "· Scale：max($99, min(12% × 节省, $499))",
    roadmapScaleNote: "（12% 费率反映重度使用价值）",
    roadmapAfterBody:
      "提前公告是为了让激励透明，不是要求你在购买前先理顺公式。已有用户在切换前会先看到与当前用量的并排对比。",
    roadmapTransitionFootnote: "过渡期内仍按固定月费计费。",

    reliabilityTitle: "可靠性与可用性",
    reliabilityBodyPrefix:
      "目前我们不提供正式 SLA — 我们是一个小团队，在销售页面写「99.9%」却无法兑现是不诚实的。内部目标：每月 TokSuan 可归因的停机时间小于 1 小时。公开的 status 页会在公开托管发布时同步上线；在那之前，事件通过直接邮件通知受影响的账户。正式 99.5% SLA 计划在 2026 Q4 多区域部署后给出。完整说明见 ",
    reliabilityBodyLink: "SECURITY.md",
    reliabilityBodySuffix: "。",

    checkoutSuccess: "支付完成。Webhook 抵达后，套餐将在数秒内激活。",
    checkoutCancelled: "已取消支付。可随时再次选择套餐。",

    stripeMissingHosted:
      "支付服务暂时不可达。当前套餐不受影响，gateway 会照常服务请求；升降级 checkout 稍后即可恢复。如长时间未恢复，请到项目的 GitHub Discussions 查看公告。",
    stripeMissingSelfHostPrefix:
      "本部署尚未配置账单功能。请设置 ",
    stripeMissingSelfHostSuffix: "，然后重新加载。",

    transferTitleSender: "正在转出 {org} 的账单",
    transferTitleReceiver: "接收 {org} 的账单转入",
    transferExpiresPrefix: "过期时间 ",
    transferSenderBodyPrefix: "你已发起：将 ",
    transferSenderBodyMid: " 的 Stripe 订阅交给 ",
    transferSenderBodySuffix:
      "。你当前的订阅仍然有效 — 暂时「不要」取消。一旦对方通过 Stripe Checkout 开通了自己的订阅，我们的 webhook 会自动取消你这边的订阅。",
    transferSenderHeadsUp: "提示：",
    transferSenderExpireSuffix:
      " 如果对方届时仍未订阅，本意向会静默过期，你的订阅会继续扣款。如仍想转出，可在下方 Stripe 客户门户手动取消，或到组织页发起新的转移。",
    transferReceiverBodyPrefix: "",
    transferReceiverBodyMid: " 希望由你接管这笔订阅，对应组织：",
    transferReceiverBodySuffix:
      "。请在下方对应套餐开始你自己的订阅；Stripe 一旦确认付款，我们的 webhook 会自动取消对方的订阅 — 不会断档，也不会重复扣款。",
    transferCancelButton: "取消该转移",

    currentPlanH3: "当前套餐",
    currentPlanPriceSuffix: "/月",
    currentPlanLimitsLabel: "限额：",
    usageDailyMeterLabel: "今日（滚动 24 小时）",
    usageMonthlyMeterLabel: "本月（滚动 30 天）",
    usageMonthlyDenomSuffix: " 次请求",
    usageNearCapBody:
      "已使用至少一项上限的 80% 以上。封顶后新请求会返回 HTTP 402 plan_limit_exceeded（Payment Required），直到滚动窗口翻页 — 升级后可获得更多余量。",
    manageSubscriptionBtn: "管理订阅",

    plansHeading: "套餐",
    plansFreeForever: "永久免费",
    plansAnnualSuffix: "/月（按年付，立省 17%）",
    plansBucketSeparator: " · ",
    plansCurrentPill: "当前",
    plansCurrentPlanBtn: "当前套餐",
    plansUpgradeBtn: "升级到 {plan}",
    plansFreeYouAreHere: "你已在此套餐",
    plansDowngradeViaPortal: "在客户门户降级",
    plansBillingNotConfigured: "尚未配置账单",
    plansEnterprisePricing: "定制定价",
    plansEnterpriseBilateral: "双向商谈",
    plansEnterpriseContact: "联系销售",
    planCards: {
      freeTagline: "端到端评估使用，不适合生产。",
      freeFeatures: [
        "每天 $1 或每月 10,000 次请求（先到者生效）",
        "不限项目数与 API key 数",
        "真实流量上的节省回执",
        "预算强制执行 + 循环检测 + 语义路由",
        "内置 baseline 策略（不含按 workload 学习）",
        "自部署不受限（Apache 2.0）— 可自行运行每晚重训",
      ],
      proTagline: "真实 workload。每周证明价值，零运维。",
      proFeatures: [
        "每天 $500 + 每月 100 万次请求",
        "包含 Free 的全部能力",
        "每周价值报告：节省金额、主要下沉路由、质量证据",
        "后台训练的路由策略（每晚、按项目）",
        "Judge LLM 成本已包含 — 使用越多路由越聪明",
        "托管定时任务 + 服务商 / 定价维护",
        "邮件支持",
      ],
      teamTagline: "生产 agent，多项目协作。",
      teamFeatures: [
        "不限跟踪开销 + 不限请求数",
        "包含 Pro 的全部能力",
        "按项目策略版本化 + 回滚",
        "按 tag 做策略隔离（一个项目，多种 workload）",
        "审计日志 CSV 导出（合规）",
        "多席位团队 + RBAC（admin / member / viewer）",
        "每个团队最多 5 个席位",
        "Slack / 微信支持频道",
      ],
      scaleTagline: "重度 agent 集群，中型工程团队。",
      scaleFeatures: [
        "不限跟踪开销 + 不限请求数",
        "包含 Team 的全部能力",
        "不限团队席位 + RBAC",
        "SSO / SAML 2.0（Okta、Azure AD、Google Workspace 等）",
        "适合安全审查的 trust package",
        "优先 Slack 支持频道（工作时间 4 小时响应）",
        "多区域 failover endpoint（计划中，目标 Q1 2027）",
      ],
      enterpriseName: "Enterprise",
      enterpriseTagline: "监管行业、专属基础设施、自定义 SLA。",
      enterpriseFeatures: [
        "包含 Scale 的全部能力",
        "专属单租户部署（你的 VPC 或我们的环境）",
        "BAA / DPA / 自定义安全审查",
        "自定义 SLA（多区域下可达 99.9%）",
        "指定技术联系人 + 季度复盘",
        "定制定价 — 通常 $1k+ / 月",
      ],
    },

    discountsBodyPrefix:
      "可申请折扣：年付立省 17%（已显示在每个套餐上方）；学生 / OSS 维护者免费 Pro；早期创业团队（融资 < $1M）首年 5 折。请到 ",
    discountsBodyLink: "GitHub issue",
    discountsBodySuffix: " 申请。",
    cancellationsBody:
      "降级与取消在 Stripe 客户门户操作，会在当前计费周期结束时生效。",

    limitUnlimited: "无限制",
    limitDailyTpl: "每天 ${n}",
    limitMonthlyTpl: "每月 {n} 次请求",
  },

  organization: {
    tagline:
      "个人用户可跳过本页 — 项目与预算在单用户模式下也完全可用。本页用于把一个 TokSuan 账户共享给团队成员：共享项目、跨成员的开销汇总以及基于角色的访问控制（owner / admin / member / viewer）。",
    dbErrTitle: "数据库无法连接。",
    pendingTitle: "待处理的邀请",
    invitedByPrefix: "邀请人：",
    invitedByExpires: " · 过期时间 ",
    acceptBtn: "接受",
    yourTeamsTitle: "你的团队",
    teamsCountSingular: " 个团队",
    teamsCountPlural: " 个团队",
    emptyTitle: "你还没加入任何团队。",
    emptyBody1: "个人项目仍可继续使用 — 团队功能用于与同事共享访问。",
    emptyBody2: " 套餐及以上包含多席位支持。",
    colName: "名称",
    colRole: "角色",
    colMembers: "成员数",
    colJoined: "加入时间",
    createTitle: "新建团队",
    createOwnerNote: "你将成为该团队的 owner",
    createPlanRequiredSuffix: " 套餐才可使用",
    createNamePlaceholder: "公司名称",
    createBtn: "创建团队",
    createGatedBodyPrefix: "多席位团队是 ",
    createGatedBodyMid: " 套餐功能。你当前处于 ",
    createGatedBodyPlanLink: "/billing",
    createGatedBodySuffix:
      "。升级即可创建团队 — 或接受上方已有邀请加入别人的团队（这条路径无套餐限制）。",
  },

  referrals: {
    taglinePrefix: "邀请别人加入 TokSuan。在被推荐用户付出的每张月度账单上，我们给你 ",
    taglineCommission: "20% 佣金",
    taglineMid: " — 持续 12 个月。Scale 套餐的被推荐人最高可达每年 ",
    taglineAnnualCap: "$1,197",
    taglineSuffix: " 佣金。所有返利都会直接抵扣到你的 Stripe 余额，无需配置任何提款渠道。",
    dbErrTitle: "数据库无法访问。",
    linkTitle: "你的推荐链接",
    linkEmptyBody: "你还没有推荐码，先生成一个，我们会给你一个个性化的分享链接。",
    linkGenerateBtn: "生成我的推荐码",
    linkYourCode: "推荐码：",
    linkShareHelp:
      "把这条链接分享到任何地方 — Twitter、邮件签名、个人博客均可。当有人通过此链接注册并支付月度账单时，我们会在你的账户上记录 20% 佣金。返利会以 \"等待中\" 状态出现在下方表格，并在每天 04:30 UTC 由 settle 任务结算到推荐人的 Stripe 余额。",
    statSignedUp: "已注册的推荐人",
    statSignedUpPayingSuffix: " 已付费",
    statTotalEarned: "累计收益",
    statPending: "等待结算",
    statPendingSubLabel: "每日 04:30 UTC 自动结算",
    referredByPrefix: "你由 ",
    referredBySuffix:
      " 推荐加入。在你最初 12 个月支付的每张 TokSuan 账单上，对方都将获得 20% 佣金 — 你的价格不变。",
    historyTitle: "返利明细",
    historyRowsSingular: " 行",
    historyRowsPlural: " 行",
    historyEmptyTitle: "暂无返利记录。",
    historyEmptyBody: " 一旦你推荐的用户支付月度账单，对应的佣金行就会出现在这里。",
    historyTipPrefix: "提示：访问者打开的链接需要带 ",
    historyTipPlaceholder: "?ref=YOUR_CODE",
    historyTipSuffix:
      "。中间件会写入一个 30 天 cookie，所以即便他们逛了别处再回来注册，归因依然有效。",
    historyColDate: "时间",
    historyColReferee: "推荐人",
    historyColInvoice: "对方账单",
    historyColCommission: "你的佣金",
    historyColStatus: "状态",
    historyStatusCredited: "✓ 已结算",
    historyStatusPending: "等待中",
    historyStatusCreditedTooltip: "已通过 Stripe 结算",
    historyStatusPendingTooltip:
      "将在下一次 04:30 UTC 的 settle 任务中结算（运维也可手动运行）",
    rulesTitle: "项目规则（详细条款）",
    rule1Prefix: "佣金为推荐人账单子合计（去税、去折扣）的 ",
    rule1Commission: "20%",
    rule1Suffix: "。",
    rule2Prefix: "佣金覆盖推荐人的 ",
    rule2Cap: "前 12 张已支付账单",
    rule2Suffix: " — 月度订阅一般等于 12 个月。",
    rule3:
      "返利将进入你的 Stripe 客户余额，并自动抵扣下一张 TokSuan 账单。余额不会过期。",
    rule4:
      "首次归因：cookie 写入后，后续若打开了带其他 ?ref=… 的链接，原归因不会被覆盖。",
    rule5: "禁止自荐：推荐人与被推荐人必须是不同账号。",
    rule6:
      "在退款、争议交易或滥用（虚假注册等）情况下，我们保留追回返利的权利。所有已结算条目可在双方的 Stripe 客户余额日志中复核。",
  },

  inviteAccept: {
    pageTitle: "团队邀请",
    notFoundTitle: "邀请不存在。",
    notFoundBody:
      "链接可能已被撤销或从未存在。请联系邀请你的人重新发送邀请。",
    backToOrgs: "返回团队列表",
    alreadyAcceptedTitle: "邀请已接受",
    alreadyAcceptedBodyPrefix: "你已加入 ",
    alreadyAcceptedBodySuffix: "。",
    openOrgBtn: "打开团队",
    expiredTitle: "邀请已过期",
    expiredBodyTpl:
      "本邀请已于 {date} 过期。请联系邀请你的人重新发送一份。",
    joinTitleTpl: "加入 {org}",
    introBodyPrefix: "你被邀请加入 ",
    introBodyMid: "，角色为 ",
    introBodySuffix:
      "。接受后，本账户将以该角色的权限访问该团队下的所有项目。",
    rowInvitedLabel: "邀请发往：",
    rowSignedInLabel: "当前登录：",
    rowInvitedByLabel: "邀请人：",
    emailMismatchTitle: "邮箱不一致。",
    emailMismatchBodyPrefix: "你以 ",
    emailMismatchBodyMid: " 登录，而邀请发给了 ",
    emailMismatchBodySuffix:
      "。请退出登录后用被邀请的邮箱重新登录，再打开本链接。",
    acceptBtn: "接受邀请",
  },

  organizationDetail: {
    backToList: "← 返回团队列表",
    yourRoleLabel: "你的角色：",
    cantManageNote: "（你只可查看，不能邀请或修改角色）",

    membersTitle: "成员",
    membersActiveSuffix: " 名活跃",
    membersPendingSuffix: " 个待接受",
    membersSeatsTpl: "{used}/{cap} 席位（{plan}）",
    memberColEmail: "邮箱",
    memberColRole: "角色",
    memberColJoined: "加入时间",
    memberSelfBadge: "（你）",
    memberSaveRoleBtn: "保存",
    memberRemoveBtn: "移除",

    invitesTitle: "待接受邀请",
    invitesPendingSuffix: " 个待接受",
    invitesEmpty: "暂无未处理的邀请。请使用下方表单邀请新成员。",
    inviteColEmail: "邮箱",
    inviteColRole: "角色",
    inviteColInvitedBy: "邀请人",
    inviteColExpires: "过期时间",
    inviteResendBtn: "重新发送",
    inviteResendTooltip:
      "用相同的 token 重新发送，并把过期时间延长 14 天。原有的接受链接仍然有效。",
    inviteRevokeBtn: "撤销",

    inviteFormTitle: "邀请新成员",
    inviteFormSeatLimitPill: "已达席位上限",
    inviteFormSeatLimitBodyPrefix: "本团队当前在 ",
    inviteFormSeatLimitBodyMid: " 套餐，最多 ",
    inviteFormSeatLimitBodySuffix:
      " 个席位（已加入成员 + 待接受邀请）。请到 ",
    inviteFormBillingLink: "/billing",
    inviteFormEmailPlaceholder: "teammate@company.com",
    inviteFormSendBtn: "发送邀请",
    inviteFormRolesHelpPrefix: "角色说明",
    inviteFormRolesHelpAdminBody: "可邀请成员、修改角色。",
    inviteFormRolesHelpMemberBody:
      "可在项目内修改资源（预算、路由、告警、prompt 模板）。",
    inviteFormRolesHelpViewerBody: "在团队范围内只读。",
    inviteFormRolesHelpOwnerHint:
      "只有当前 owner 才能转让所有权（如果你是 owner，请见下方 \"转让所有权\" 卡片）。",
    inviteFormDeliveryHelpPrefix: "邀请发送方式",
    inviteFormDeliveryHelpSuffix:
      "：配置 RESEND_API_KEY 后通过 Resend 发送；同时接受链接也会打印到 dashboard 的 stdout，方便没有邮件配置的本地开发环境使用。",

    ssoTitle: "单点登录（SAML 2.0）",
    ssoModeLabel: "模式：",
    ssoPlanRequiredSuffix: " 套餐才可用",
    ssoPlanGatedBodyPrefix: "SAML 2.0 单点登录是 ",
    ssoPlanGatedBodyMid1: " 套餐功能。本团队当前在 ",
    ssoPlanGatedBodyMid2:
      " 套餐 — 升级团队 owner 的套餐即可配置 IdP 端 SSO（Okta、Azure AD、Google Workspace 等）。",
    ssoPlanGatedBodyDocsPrefix: "接入指南：",
    ssoPlanGatedBodyDocsLinkText: "docs/integrations/sso-okta.md",
    ssoPlanGatedBodyDocsSuffix: "。",
    ssoReadOnlyPrefix: "本团队的 SAML SSO 当前为 ",
    ssoReadOnlyDomainSuffix: "",
    ssoReadOnlyAdminNote: "。仅 admin 可修改这些设置。",

    ssoIdpHelpBody:
      "IdP 端配置：把下面这两个 URL 粘贴到你的 IdP SAML 应用里。",
    ssoAcsLabel: "ACS / Reply URL：",
    ssoEntityIdLabel: "Entity ID / SP Metadata：",
    ssoEnforcementLabel: "强制模式",
    ssoEnforcementOff: "关闭（disabled）",
    ssoEnforcementOptional: "可选（SSO 可用，OTP 仍可登录）",
    ssoEnforcementRequired: "强制（匹配域名的用户必须走 SSO）",
    ssoEmailDomainLabel: "邮箱域名",
    ssoEmailDomainPlaceholder: "acme.com",
    ssoJitDefaultRoleLabel: "JIT 默认角色",
    ssoMetadataXmlLabel:
      "IdP 元数据 XML（推荐 — 从 IdP 的 \"federation metadata\" 导出后粘贴）",
    ssoMetadataXmlPlaceholder:
      "<EntityDescriptor xmlns=\"urn:oasis:names:tc:SAML:2.0:metadata\">...</EntityDescriptor>",
    ssoManualToggleLabel: "或手动填写 IdP 字段（无 XML 元数据时使用）",
    ssoIdpEntityIdLabel: "IdP entity ID",
    ssoIdpEntityIdPlaceholder: "https://idp.example.com/saml2",
    ssoIdpSsoUrlLabel: "IdP SSO URL（HTTP-Redirect）",
    ssoIdpSsoUrlPlaceholder: "https://idp.example.com/saml2/sso",
    ssoIdpCertLabel: "IdP 签名证书（PEM 或 base64）",
    ssoSaveBtn: "保存 SSO 配置",
    ssoTestLoginBtn: "测试登录 →",
    ssoReferenceTitle: "可参考的 IdP",
    ssoReferenceBodyPrefix:
      " — Okta、Azure AD / Entra、Google Workspace、JumpCloud、OneLogin、Auth0 都支持 SAML 2.0 元数据 XML 导出。端到端联通性已用 ",
    ssoReferenceBodyLinkText: "samltest.id",
    ssoReferenceBodySuffix:
      " 验证过。JIT provisioning 会在用户首次登录时创建账号并以默认角色加入本团队。设为 required 后，匹配域名的用户将无法回退到 OTP 登录（适用于身份策略严格的 Scale 客户）。",

    transferTitle: "转让所有权",
    transferOwnerOnlyPill: "仅 owner 可见",
    transferBodyPrefix: "把 ",
    transferBodyMid1: " 角色交给另一名成员。同一步操作会让你降为 ",
    transferBodyMid2: "。本团队当前付费的 Stripe 订阅会保留在 ",
    transferBodyMid3:
      " 账户上 — 如果新 owner 也希望承担付费，他们需要在 ",
    transferBillingLink: "/billing",
    transferBodySuffix:
      " 自行开始订阅；待对方支付确认后，你可手动取消自己的订阅。请输入本团队的完整名称以确认：",
    transferConfirmCodeWord: "owner",
    transferSelectPlaceholder: "选择新 owner…",
    transferConfirmPlaceholderTpl: "请输入 \"{name}\"",
    transferSubmitBtn: "转让",
    transferBillingLabel: "同时转让计费责任",
    transferBillingBodyPrefix:
      "（可选）。会在双方的 ",
    transferBillingBodyMid:
      " 页面创建一个待处理的转让意向。新 owner 自行开始订阅；Stripe 确认后，",
    transferBillingBodySuffix:
      " 的订阅会通过 webhook 自动取消。不勾选（默认）= 你的订阅会持续付费，直到你手动取消 — 这是更稳的常规姿势。",
  },

  audit: {
    tagline:
      "账户中每个重要操作都会追加记录。适合合规审查、事故复盘，以及追查某个 key 为什么突然不可用。",
    scopeLabel: "范围：",
    scopePersonal: "我的操作",
    scopeOrgTitleTpl: "{name} 内所有成员的事件（{role}）",
    scopeOrgSuffix: "全团队",
    dbErrTitle: "数据库无法访问。",
    recentTitle: "最近事件",
    eventSingular: "条事件",
    eventPlural: "条事件",
    filteredSuffix: "（已筛选）",
    exportCsvBtn: "导出 CSV",
    exportCsvTitle: "将匹配事件下载为 CSV（最多 50,000 条）。",
    exportJsonBtn: "导出 JSON",
    exportJsonTitle:
      "将匹配事件下载为 NDJSON — 每行一条事件，适合 SIEM 导入。",
    exportGatedBtnTpl: "导出（{plan}+）",
    exportGatedTitleTpl: "导出需要 {plan} 套餐。点击查看账单页。",
    filterEventLabel: "事件类别",
    filterAllEvents: "全部事件",
    filterSinceLabel: "开始时间（UTC）",
    filterUntilLabel: "结束时间（UTC）",
    filterApplyBtn: "应用",
    filterClearBtn: "清除",
    emptyBody:
      "暂无事件。退出后重新登录、创建项目或修改套餐后，这里就会出现记录。",
    colTime: "时间",
    colEvent: "事件",
    colProject: "项目",
    colTarget: "目标",
    colDetails: "详情",
    ipPrefix: "IP",
  },

  promptTemplates: {
    title: "Prompt 模板",
    tagline:
      "把 system prompt 保存为命名 + 版本化的模板。每个模板一行，每次保存生成一个新版本。可随时回滚而不丢失实验。",
    dbErrTitle: "数据库无法访问。",

    yourTitle: "你的模板",
    countSingular: " 个模板",
    countPlural: " 个模板",
    emptyTitle: "暂无模板。",
    emptyBodyPrefix: " 用下方表单创建第一个。常见命名比如 ",
    emptyBodyMid: " 或 ",
    emptyBodySuffix: " — 保持 URL 安全，后续会通过 header 引用。",
    colName: "名称",
    colActiveVersion: "激活版本",
    colVersions: "版本数",
    colUpdated: "更新时间",
    openBtn: "打开",

    formTitle: "新建或追加新版本",
    formReusing: "重复使用同名会追加为新版本",
    formNameLabel: "模板名称",
    formNamePlaceholder: "code-reviewer",
    formDescriptionLabel: "描述（可选）",
    formDescriptionPlaceholder: "本模板的用途",
    formBodyLabel: "正文（即 prompt 本体）",
    formBodyPlaceholder:
      "You are an expert code reviewer.\n\nReview the following code and return STRICT JSON of the form {issues: [...]}\n\n```\n{{code}}\n```",
    formNoteLabel: "变更说明（可选 — 会显示在版本历史中）",
    formNotePlaceholder: "例如：收紧 JSON schema 校验",
    formSaveBtn: "保存版本",
    formSyntaxHintPrefix: "模板语法",
    formSyntaxHintSuffix:
      "：Handlebars 风格的 {{variable}} 占位符。网关已支持服务端替换。",

    runtimeTitle: "运行时使用模板",
    runtimeHeaderHint: "x-ts-template 请求头",
    runtimeBody:
      "通过名称引用任意模板；网关会加载当前版本、替换 {{vars}}，并把渲染结果作为 system message 前置后再转发到上游。",
    runtimeBullet1Prefix: "用 ",
    runtimeBullet1Mid:
      " 锁定具体版本；省略后缀则跟随激活版本（目前为 ",
    runtimeBullet1Suffix: "）。",
    runtimeBullet2Prefix: "变量可以放在 body 的 ",
    runtimeBullet2Mid:
      " 字段（推荐大段值），或放在 JSON 编码的 ",
    runtimeBullet2Suffix: " header（key 冲突时 header 优先）。",
    runtimeBullet3:
      "未知占位符会保留原样 — 第一次响应里很容易看到。已有 system message 会被替换；否则前置一条新的。",
    runtimeBullet4Prefix: "通过模板渲染的每次请求会自动打上 ",
    runtimeBullet4Mid: " + ",
    runtimeBullet4Suffix:
      " 标签，dashboard 的 \"按标签拆分\" 卡片会按模板版本拆分成本。",
    runtimeTagBy: "按标签拆分",

    detailBackBtn: "← 返回模板列表",
    detailVersionsCountSingular: " 个版本",
    detailVersionsCountPlural: " 个版本",
    detailActiveVersionTpl: "激活版本（v{n}）",
    detailCopyBodyLabel: "复制正文",
    detailEmptyBody: "（空）",
    detailAppendTitle: "追加新版本",
    detailAppendNextVersionTpl: "将保存为 v{n}",
    detailAppendSubmitTpl: "保存为 v{n}",
    detailAppendNotePlaceholder: "变更说明（例如：收紧 JSON 要求）",
    detailHistoryTitle: "版本历史",
    detailHistoryNewestFirst: "最新在前",
    detailHistoryEmpty: "暂无版本。",
    detailHistoryActivePill: "已激活",
    detailHistoryByPrefix: "由 ",
    detailHistoryPinTitle: "把此版本固定为激活版（回滚时不会删除较新的版本）",
    detailHistoryPinBtn: "设为激活版",
    detailDangerTitle: "删除模板",
    detailDangerBody:
      "会删除模板及所有版本，不可撤销。已经按名称引用了本模板的请求会解析失败（网关会返回 400 并附带提示）。",
    detailDeleteSubmitTpl: "永久删除 {name}",
  },

  routingPolicy: {
    title: "路由策略",
    tagline:
      "TokSuan 起步于公开的 cost-quality 前沿，再结合本项目的真实请求与 shadow 试验持续学习。激活策略就是网关此刻路由所依据的策略；旧版本会保留以便回滚与审计。",
    activeTitle: "当前激活",
    pauseLearningBtn: "暂停学习",
    resumeLearningBtn: "恢复学习",
    pauseTooltip: "暂停本项目的每日重训。当前激活策略仍会服务请求。",
    resumeTooltip: "恢复每日重训。",
    upgradeRequiredTooltipTpl: "后台训练需要 {plan} 套餐。",
    activeStatusTpl: "{date} 激活 · 在 {n} {noun} 上训练",
    activeSampleSingular: "个样本",
    activeSamplePlural: "个样本",
    learningStatusPrefix: "学习状态：",
    learningStatusOn: "已开启",
    learningStatusOff: "已暂停",
    learningOnNote:
      "今晚的 cron 会基于近期请求与 shadow A/B 重训本项目，路由会更贴合该 agent。",
    learningPausedNote: "激活策略保持冻结 — 不会触发每日重训。",
    noActiveBodyPrefix:
      "本项目暂无定制策略 — 网关使用内置的前沿基线。要生成自定义 v1，需要两件事：",
    noActiveStep1Prefix:
      "一个 shadow A/B 规则，给重训提供观测数据。请到 ",
    noActiveStep1Link: "路由规则",
    noActiveStep1Mid: " 卡片创建一条，模式为 ",
    noActiveStep1Mode1: "shadow",
    noActiveStep1Or: " 或 ",
    noActiveStep1Mode2: "both",
    noActiveStep1Sample: "，并把 ",
    noActiveStep1ChipPrefix: "Sample",
    noActiveStep1ChipSuffix: " 拨片设为 5%。（CLI 等价命令：",
    noActiveStep1CliPrefix: "bun run set-routing -- --mode shadow --sample-rate 0.05",
    noActiveStep1CliSuffix: "。）",
    noActiveStep2Prefix: "等待下一次每晚 cron（云端）或手动运行 ",
    noActiveStep2Mid: "bun run retrain-project -- --project ",
    noActiveStep2Suffix: "。",

    dbErrTitle: "数据库无法访问。",
    historyTitle: "历史",
    historyVersionsSingular: " 个版本",
    historyVersionsPlural: " 个版本",
    historyEmpty: "暂无重训历史。网关使用内置基线策略路由。",
    colVersion: "版本",
    colStatus: "状态",
    colSource: "来源",
    colSamples: "样本数",
    colNotes: "备注",
    colGenerated: "生成时间",
    rollbackBtnTpl: "回滚到 v{n}",
    rollbackTooltipReadyTpl:
      "把 v{n} 重新提升为激活版。会创建一个 source=rollback 的新版本，保留审计轨迹。",
    rollbackTooltipGatedTpl: "回滚需要 {plan} 套餐。",

    howTitle: "重训机制",
    howBody1:
      "云端 cron 每晚读取本项目的近期请求与 A/B shadow 结果，与内置的多服务商基线策略融合（贝叶斯式 — 先验权重约 20 个样本），插入一个新版本。通过完整性校验后会被提升为激活版，原激活版降级为 superseded。",
    howBody2Prefix: "自部署用户可手动跑同一 job：",
    howBody2Suffix: "。详见 docs/self-host-retrain.md。",

    costTitle: "学习成本",
    costSubLabel: "shadow A/B 上游开销",
    costMtdLabel: "本月至今",
    costMtdShadowSingular: " 次 shadow 调用",
    costMtdShadowPlural: " 次 shadow 调用",
    costTrailing30dLabel: "近 30 天",
    costTrailing30dAvgPrefix: "平均 ",
    costTrailing30dAvgSuffix: " / 次",
    costSparklineTooltipTpl:
      "近 30 天每日 shadow 成本（旧 → 新）。最高单日：{peak}。",
    costLastShadowLabel: "最近一次 shadow",
    costLearningOn: "学习中",
    costLearningPaused: "学习已暂停",
    costFooterPrefix:
      "Shadow A/B 调用与你的正常流量并行运行，让每晚的重训能拿到可比的模型评估。它们使用你自己的上游 provider key，按你账户计费。要降低速率，请用 bun run set-routing 调小规则的 ",
    costFooterMid: "；要完全暂停，请点击上方的 ",
    costFooterSuffix: "。",
    costEmptyEnabledTitle: "暂无 shadow A/B 流量。",
    costEmptyEnabledBody:
      " 每晚的重训需要 A/B 观测数据来学习。请添加一条模式为 shadow 或 both 的路由规则，把 Sample 拨片设为 5%，让一小部分流量并行调用候选模型，aggregator 才能进行对比。",
    costEmptyEnabledTipBody:
      "5% 通常足以在一周内让单个 bucket 收敛，又不会让上游账单翻倍。新候选模型刚上线时可临时调到 100% 做校准爆发，攒到几百个样本后再调回去。",
    costEmptyEnabledCliHint: "也可以用 CLI：",
    costEmptyPausedTitle: "学习已暂停。",
    costEmptyPausedBody:
      " 不会收集 shadow A/B 观测数据，本项目的每晚重训也不会运行。请在上方恢复学习以重启闭环。",

    toastLearningPaused:
      "本项目的后台学习已暂停。当前激活策略仍会服务；不会触发每晚重训。",
    toastLearningResumed: "后台学习已恢复。下一次每晚 cron 会重训本项目。",
    toastUpgradeRequiredPrefix: "后台策略训练为付费功能。",
    toastUpgradeRequiredLink: "升级到 Pro+",
    toastUpgradeRequiredSuffix:
      " 以解锁。（你可以保留控件可见 — Free 套餐下不会触发。）",
    toastRollbackCompleteTpl:
      "已回滚到 v{from} — 提升为 v{to}。新路由会在 60 秒内在所有 gateway 副本生效。",
    toastRollbackFailedTpl: "回滚失败：{detail}。原激活策略保持不变。",
    toastRollbackFailedNoDetail: "（无详情）",
  },

  classifier: {
    title: "Embedding 分类器",
    tagline:
      "按项目每晚训练的 (task_type, complexity) 分类器。当两个 head 都越过校准好的置信度阈值时，路由决策会用它替代 regex 启发式。低于质量底线的重训保留为 rejected 用于回查；之前的 active 行继续服务。",
    dbErrTitle: "查询失败",
    dbErrHint:
      "最常见原因：migration 026（project_embedding_classifiers）未执行。重启 gateway — 启动时的自动 migrator 会拾取待执行文件。",
    activeTitle: "当前激活",
    activeNoVersionPill: "本项目暂无分类器",
    pauseTrainingBtn: "暂停训练",
    resumeTrainingBtn: "恢复训练",
    trainingOnNote: "今晚的每晚重训会产出一个新版本。",
    trainingPausedNote: "已暂停 — 在你恢复之前不会有新版本。",
    trainingRequiresPrefix: " 需要 ",
    trainingRequiresSuffix: " 或更高套餐。",
    tileTaskTypeAcc: "task_type 准确率",
    tileComplexityAcc: "complexity 准确率",
    tileTrainedOn: "训练样本",
    tileTrainedOnRowsTpl: "{n} 行",
    tileActivated: "激活时间",
    tileRejected30d: "rejected（30 天）",

    emptyActiveBody:
      "本项目尚无定制分类器。路由当前使用全局分类器（如已加载）或 regex 启发式。",
    emptyActiveHasHistory:
      "下方历史里的版本要么被质量底线标记为 rejected，要么从未激活就被 superseded。请累积更多流量，等待下一次每晚重训。",
    emptyActiveUpgradePrefix: "",
    emptyActiveUpgradeLinkPrefix: "升级到 ",
    emptyActiveUpgradeLinkSuffix: "",
    emptyActiveUpgradeSuffix: " 即可启用按项目的每晚分类器训练。",
    emptyActiveResumeMsg:
      "请在上方恢复训练，然后等待下一次每晚重训（03:00 UTC）— 也可以手动跑 bun run train-embedding-classifier -- --project …。",
    emptyActiveLearningOnMsg:
      "学习已开启。要么本项目流量不足（回看窗口内 ≥ 50 行），要么质量底线拒绝了近期的重训。请查看下方历史表了解原因。",

    perClassTitle: "按类别指标（激活版本）",
    perClassBodyTpl:
      "在 hold-out 验证集（{n} 条样本）上的 precision / recall / support。某个类别的 recall 偏低意味着分类器在运行时对该类别预测不足，相关请求会静默回退到启发式。",
    perClassTaskTypeHead: "task_type head",
    perClassComplexityHead: "complexity head",
    perClassEmpty: "本 artifact 中无按类别指标（v0.6.1 之前的训练产物）。",
    perClassColClass: "类别",
    perClassColPrecision: "precision",
    perClassColRecall: "recall",
    perClassColSupport: "support",

    historyTitle: "历史",
    historyEmptyPrefix:
      "暂无分类器版本。请在上方启用学习并等待下一次每晚重训 — 也可以手动跑 ",
    historyEmptySuffix: "。",
    colV: "v",
    colStatus: "状态",
    colSource: "来源",
    colTaskTypeAcc: "task_type 准确率",
    colComplexityAcc: "complexity 准确率",
    colSamples: "样本数",
    colGenerated: "生成时间",
    colNotes: "备注",
    rollbackBtn: "回滚",
    rollbackTooltipReadyTpl: "回滚到 v{n}",
    rollbackTooltipGated: "回滚需要付费套餐",

    toastLearningResumed: "本项目的分类器训练已恢复。",
    toastLearningPaused: "分类器训练已暂停。当前激活版本继续服务。",
    toastUpgradeRequiredPrefix: "启用按项目训练需要升级套餐。",
    toastUpgradeRequiredLink: "查看套餐",
    toastUpgradeRequiredSuffix: "。",
    toastRollbackCompleteTpl:
      "已回滚：v{from} 重新提升为 v{to}。所有在线 gateway 已通过 pg_notify 重载。",
    toastRollbackFailedTpl: "回滚失败：{detail}",
    toastRollbackFailedNoDetail: "未知错误",
  },

  errors: {
    notFoundTitle: "页面不存在",
    notFoundBodyPrefix:
      "你访问的 URL 不存在。如果是从应用内的链接进来的，对应资源可能已被删除（项目、某条请求记录、邀请等）。如果是从外部链接进来的且确信应该有效，请提一个",
    notFoundBodyLink: "GitHub issue",
    notFoundBodySuffix: "。",
    notFoundBackBtn: "返回 Dashboard",
    notFoundEstimatorBtn: "节省评估",
  },

  forms: {
    budget: {
      presetsLabel: "预设",
      presetDailyTpl: "${usd}/天",
      presetMonthlyTpl: "${usd}/月",
      periodDaily: "日预算",
      periodMonthly: "月预算",
      limitPlaceholder: "限额（美元，例如 5.00）",
      enabledLabel: "启用",
      saveBtn: "保存预算",
      updateBtn: "更新",
      cancelBtn: "取消",
      savedPill: "✓ 已保存",
      previewMonthlyEquiv: "≈ 每月 {amount}",
      previewDailyEquivAvg: "≈ 日均 {amount}",
      previewNoTraffic24h: "近期无流量 — 此上限只对未来流量生效。",
      previewNoTraffic30d: "近 30 天无流量 — 纯前瞻性上限。",
      previewPast24hLine: "过去 24 小时开销：{spent}（占本上限 {pct}%）",
      previewPast30dLine: "过去 30 天开销：{spent}（占本上限 {pct}%）",
      previewPast7dSuffix: " · 7 天：{spent}",
      previewWarn24hOver:
        "过去 24 小时已超出本上限 — 新请求当时本会被拦截。",
      previewWarn24hHigh:
        "过去 24 小时已超过本上限的 80% — 如属正常请上调。",
      previewWarn30dOver: "过去 30 天已超出本上限。",
      previewWarn30dHigh: "过去 30 天已超过本上限的 80%。",
      previewSubCentHint: "支持小于 1 美分的预算 — 适合 demo / 开发项目。",
      previewEnterAmount: "请输入正数美元金额。",
      rowEditBtn: "编辑",
      rowDeleteBtn: "删除",
      rowEnabledPill: "已启用",
      rowDisabledPill: "已停用",
      rowEditTitle: "点击编辑",
      forecastTodayLabel: "今日",
      forecastMonthLabel: "本月",
      forecastEtaMinutes:
        "按当前速率，{periodLabel}预算预计 {n} 分钟后耗尽",
      forecastEtaHours:
        "按当前速率，{periodLabel}预算预计 {n} 小时后耗尽",
      forecastEtaDays:
        "按当前速率，{periodLabel}预算预计 {n} 天后耗尽",
    },

    routing: {
      presetsLabel: "预设",
      preset1Label: "下沉简单的 GPT 调用",
      preset1Desc:
        "复杂度较低时，把 GPT-4 类模型转到 gpt-4o-mini。",
      preset2Label: "下沉简单的 Claude 调用",
      preset2Desc:
        "复杂度较低时，把 sonnet 类 Claude 转到 haiku。",
      preset3Label: "在 shadow 中 A/B 对比 DeepSeek 与当前模型",
      preset3Desc:
        "保留当前模型继续上线，让 deepseek-chat 在 5% 流量上做 shadow 对比成本与质量。",
      preset4Label: "把所有简单流量转到 Qwen",
      preset4Desc:
        "激进省钱路由 — 复杂度低于 0.5 全部走 qwen3-next-80b。",
      whenAsks: "当请求模型为",
      switchToRegex: "切换到正则模式",
      switchToModel: "切换到模型选择器",
      regexPlaceholder: "^gpt-(4|5).*",
      routeTo: "路由到",
      tierFrontier: "旗舰",
      tierMid: "中等",
      tierCheap: "经济",
      tierSuffix: "档",
      thresholdLabel: "复杂度 ≤ 时触发",
      landmarkExample1: "你好",
      landmarkExample2: "现在几点？",
      landmarkExample3: "用两行总结这段文字。",
      landmarkExample4: "写一个 Python 函数，实现……",
      landmarkExample5: "重构鉴权层，把……",
      landmarkExample6: "设计一个分布式调度器，要求……",
      landmarkTooltipTpl: "复杂度 ≈ {score}",
      modeLabel: "模式",
      modeRouteTitle: "Route",
      modeShadowTitle: "Shadow",
      modeBothTitle: "Route + Shadow",
      modeRouteBodyPrefix: "重写 ",
      modeRouteBodySuffix:
        " 为更便宜的模型，原模型不再被调用。",
      modeShadowBody:
        "不重写。让更便宜的模型在后台并行调用并记录对比，适合切换前先验证。",
      modeBothBody:
        "重写并同时 shadow 原模型，验证下沉是否会损失质量。",
      shadowTargetLabel: "Shadow 目标模型",
      shadowTargetDefaultBoth: "（默认：shadow 原模型）",
      shadowTargetPick: "选择要 shadow 的模型…",
      sampleRateLabel: "触发频率",
      sampleRateAlwaysLabel: "总是",
      sampleRateAlwaysDesc: "每次匹配请求都触发。",
      sampleRate100Desc:
        "校准爆发 — 一两天内每次匹配都触发，之后再调低。",
      sampleRate10Desc: "激进的学习速率。",
      sampleRate5Desc: "shadow / both 模式的稳态推荐值。",
      sampleRate1Desc:
        "仅做漂移检测 — 适合估计已稳定的高流量项目。",
      sampleAlwaysExplain: "规则在每次匹配请求时触发。",
      sampleAlwaysShadowExplainPrefix: "在 ",
      sampleAlwaysShadowExplainSuffix:
        " 模式下，这意味着每条主请求旁都会并行一次调用 — 命中流量的上游账单会翻倍。建议选低于 100% 的采样率，让 shadow 保持涓流。",
      sampleAlwaysRouteExplain: " ROUTE 规则通常就是这个设置。",
      sampleSubExplainPrefix: "规则在符合条件的请求中随机 ",
      sampleSubExplainOf: " 触发。",
      sampleSubExplainShadowSuffix:
        " Shadow A/B 流量保持在命中流量的约 {pct}% — 足以为每晚再训练提供数据，又不会让上游账单翻倍。",
      sampleSubExplainRouteSuffix:
        " 注意：在 ROUTE 模式下，这意味着 {pct}% 匹配请求仍会按原模型执行。ROUTE 规则通常应保持「总是」。",
      previewLabel: "近 7 天命中预览",
      previewLoading: "计算中…",
      previewEmpty:
        "近 7 天没有请求匹配此 pattern。规则仍会对未来流量生效，只是暂无历史佐证。",
      previewMatchedPrefix: "{n}",
      previewMatchedSingular: " 个请求",
      previewMatchedPlural: " 个请求",
      previewMatchedSpentSuffix: " 命中 · 共开销 {spent}",
      previewModelsHit: "命中的模型：",
      previewThresholdHint:
        "阈值 ≤ {n} 实际只会重写其中运行时复杂度评分低于上限的子集。建议先用 shadow 模式验证后再切流。",
      previewUnavailable: "（预览暂不可用）",
      enabledLabel: "启用",
      saveBtn: "保存规则",
      updateBtn: "更新规则",
      cancelBtn: "取消",
      savedPill: "✓ 已保存",
      rowEditBtn: "编辑",
      rowDeleteBtn: "删除",
      rowEnabledPill: "已启用",
      rowDisabledPill: "已停用",
      rowEditTitle: "点击编辑该规则",
      rowSampleAlways: "总是",
      rowSampleNever: "从不",
      rowSampleAlwaysTooltip:
        "每次匹配请求都触发，是 v0.5 之前规则的默认行为。",
      rowSampleSubTooltip: "在符合条件的请求中随机以 {label} 概率触发。",
    },

    alert: {
      notifyMeWhen: "在以下情况通知我",
      channelWebhookLabel: "在 Slack / Discord / 飞书发送消息",
      channelWebhookOptional: "（可选）",
      channelWebhookHelpPrefix:
        "粘贴聊天工具中机器人频道的 URL。要拿到一个，请在聊天工具的设置中搜索 ",
      channelWebhookHelpEmphasis: "「incoming webhook」",
      channelWebhookHelpSuffix:
        "：Slack 在 Apps → Incoming Webhooks；Discord 在 Channel settings → Integrations → Webhooks；飞书在 群 → 设置 → 机器人 → 自定义机器人。PagerDuty 等任何接受 JSON 的 URL 也都支持。",
      channelEmailLabel: "邮件通知地址",
      channelEmailHelp:
        "我们会发一封简短的纯文本邮件。是否真正发送、还是只写日志，取决于 gateway 的邮件配置 — 详见本表单下方的提示。",
      addBtn: "添加订阅",
      atLeastOneRule: "请至少填写一个通道 — 两者都填则两边都会触发。",
      savedPill: "✓ 已保存",
    },

    quickBudget: {
      title: "你尚未设置任何预算 — 一次失控循环就可能在你发现前烧掉数千美元。",
      capLabel: "上限",
      onLabel: "项目",
      enableBtn: "启用预算",
      presetDailyTpl: "${usd}/天",
      presetMonthlyTpl: "${usd}/月",
    },

    alertEvents: {
      budgetExceeded: {
        title: "开销触及预算上限",
        desc: "当某次请求即将让项目的日 / 周 / 月预算超出上限时立即触发，该请求会被同时拦截。",
      },
      loopDetected: {
        title: "Agent 陷入循环",
        desc: "当 gateway 观察到同一请求指纹在很短时间内反复出现时触发 — 通常是 agent 自我重试。重复请求会被拦截。",
      },
      costAnomaly: {
        title: "过去一小时开销出现异常激增",
        desc: "当本项目过去一小时的开销在统计上远超 7 天基线时触发。每个项目 6 小时冷却，避免一次激增持续刷屏。",
      },
      retrainFailed: {
        title: "每晚的模型策略再训练失败",
        desc: "当项目级路由策略的再训练（cron 或自部署 CLI）失败时触发。当前策略仍在服务 — 告警只是告诉你今晚没刷新到新版本。",
      },
    },
  },

  errorBoundary: {
    title: "出错了",
    bodyPrefix:
      "Dashboard 在渲染本页时遇到未处理的错误。你的数据是安全的 — gateway 仍然在转发请求、记录开销、强制预算。请重试本页；如果仍然复现，请提一个 ",
    bodyLink: "GitHub issue",
    bodySuffix: "，并附上下方的 digest，我们可据此在服务器日志中定位你的堆栈。",
    digestLabel: "digest：",
    retryBtn: "重试",
    backBtn: "返回 Dashboard",
  },

  copyButton: {
    copyTooltip: "复制到剪贴板",
    copiedTooltip: "已复制",
    copyLabel: "复制",
    copiedLabel: "已复制",
  },

  themeToggle: {
    switchToLight: "切换到浅色模式",
    switchToDark: "切换到深色模式",
  },

  toasts: {
    projectCreated: "已创建项目「{arg}」。",
    projectCreatedNoArg: "已创建项目。",
    projectDeleted: "已删除项目「{arg}」。",
    projectDeletedNoArg: "已删除项目。",
    keyCreated: "已生成新的 API key。",
    keyNameRequired:
      "请先给 API key 命名（例如 cursor-demo） — 我们不会自动生成名为「default」的 key。",
    keyCreateFailed:
      "创建 API key 失败。数据库可能需要应用最新 migration；等 gateway 重新部署后再试。",
    keyCreatedNoReveal:
      "API key 已创建，但无法设置一次性查看 cookie。请删除该 key 并重新创建，便于复制密钥。",
    keyDeleted: "API key 已删除。",
    keyRotated:
      "Key 已轮换 — 请在下方复制新 key。旧 key 仍保留 24 小时有效，避免滚动部署 401。",
    keyRotateNotFound:
      "无法轮换 — key 不存在或不属于本项目。",
    budgetSaved: "已保存预算。",
    budgetDeleted: "已移除预算。",
    budgetInvalid: "预算上限必须是正数。",
    routingSaved: "已保存路由规则。",
    routingDeleted: "已移除路由规则。",
    routingLocked:
      "已锁定。今后请求该模型将自动走此路由。",
    routingInvalid: "路由规则需要同时填写源 pattern 与目标模型。",
    routingBadRegex: "源 pattern 必须是合法的 JavaScript 正则。",
    testKeyOk: "服务商 API key 测试通过。",
    testKeyFail:
      "服务商 API key 测试失败 — 详情见「设置」页。",
    alertTestOk: "测试告警已发送（{arg}）。",
    alertTestOkNoArg: "测试告警已发送。",
    alertTestFailNoInternalToken:
      "测试告警失败：dashboard 缺少 TOKENSMART_INTERNAL_TOKEN，无法访问 gateway。",
    alertTestFailNoTarget:
      "测试告警失败：本规则既未配置 webhook URL 也未配置 email 收件人。",
    alertTestFailWithReason: "测试告警失败：{arg}。",
    alertTestFailNoReason: "测试告警失败。",
    alertSaved: "已保存告警订阅。",
    alertDeleted: "已移除告警订阅。",
    alertNoTarget: "请至少填写 webhook URL 或 email 中的一项。",
    alertBadUrl: "Webhook URL 必须是合法的 http(s) URL。",
    alertInvalid: "未知的告警事件类型。",
    digestEnabled:
      "已订阅。当运维同学将 `bun run send-weekly-savings` 接入定时任务后，你每周会收到一封节省汇总邮件。",
    digestEnabledHosted:
      "已订阅。每周一会收到一封节省汇总邮件。",
    digestDisabled: "已退订每周日报。",
    providerKeySaved: "已保存 {arg} key。",
    providerKeySavedNoArg: "已保存服务商 API key。",
    providerKeyDeleted: "已移除服务商 API key。",
    providerKeyEncryptionMissing:
      "本 dashboard 未设置 TOKENSMART_PROVIDER_KEY_ENCRYPTION。",
    providerKeyInvalid: "未知的服务商。",
    providerKeyTooShort:
      "服务商 API key 看起来过短 — 请粘贴完整密钥。",
    providerKeyBadUrl: "Base URL 覆盖必须是合法的 http(s) URL。",
    referralCodeReady: "你的推荐码已生成：{arg}",
    referralCodeReadyNoArg: "推荐码已生成。",
    referralSettled: "结算完成（{arg}）。",
    referralSettledNoArg: "待结算积分已结清。",
    referralSettleUnauth:
      "仅运维可执行结算操作（请配置 TOKENSMART_OPS_EMAILS）。",
    requestReplayQueued:
      "已对 {arg} 发起 replay。新结果将出现在「最近请求」中。",
    requestReplayQueuedNoArg:
      "Replay 已入队。新结果将出现在「最近请求」中。",
    requestReplayFailedNoEnv:
      "Replay 需要在两个服务上同时设置 TOKENSMART_INTERNAL_REPLAY_ENABLED=1 和 TOKENSMART_INTERNAL_TOKEN。",
    requestReplayFailedWithReason: "Replay 失败：{arg}",
    requestReplayFailedNoReason: "Replay 失败。",
    templateSaved: "Prompt 模板已保存。",
    templateDeleted: "Prompt 模板已删除。",
    templateBadInput: "模板名称与正文均为必填。",
    orgCreated: "已创建团队「{arg}」。",
    orgCreatedNoArg: "已创建团队。",
    orgBadName: "团队名称为必填。",
    orgBadRole: "未知的角色。",
    orgBadEmail: "请输入合法的邮箱地址。",
    orgNotAllowed: "仅 owner 与 admin 可管理成员。",
    orgNotFound: "未找到团队。",
    orgInvited: "邀请已发送至 {arg}。",
    orgInvitedNoArg: "邀请已发送。",
    orgInviteRevoked: "邀请已撤销。",
    orgInviteResent: "邀请已重新发送至 {arg}（14 天内有效）。",
    orgInviteResentNoArg: "邀请已重新发送（14 天内有效）。",
    orgTransferComplete:
      "所有权已转移。你在该团队中已变为 admin。",
    orgTransferNotOwner: "只有当前 owner 可以转移所有权。",
    orgTransferBadSuccessor:
      "指定的接管人不是该团队成员。",
    orgTransferSameUser:
      "接管人必须与当前 owner 是不同用户。",
    orgTransferConfirmMismatch:
      "请准确输入团队名称以确认转移。",
    accountDeleteConfirmMismatch:
      "请在确认框中精确输入大写的 DELETE 以排期注销。",
    accountDeleteScheduled:
      "账户已排期注销 — 30 天宽限期内可在本页随时撤销。",
    accountDeleteCancelled: "已撤销注销。欢迎回来。",
    accountDeleteOrgOwner:
      "请先转出团队「{arg}」的所有权 — 现在删除会让该团队没有 owner。",
    accountDeleteOrgOwnerNoArg:
      "请先转出名下团队的所有权，再删除账户。",
    billingTransferCancelled: "账单转移意向已取消。",
    billingTransferCancelFailed:
      "无法取消 — 该意向可能已完成或已过期。",
    billingTransferCompleted:
      "账单已转移 — 旧订阅已被取消。",
    orgRoleChanged: "角色已更新。",
    orgMemberRemoved: "成员已移除。",
    orgInviteBadToken: "邀请无效、已过期或已被接受。",
    orgInviteEmailMismatch:
      "本邀请发给了另一个邮箱，请用对应邮箱登录后再接受。",
    orgJoined: "已加入团队。",
    orgPlanRequired: "本功能需要 {arg} 套餐。",
    orgPlanRequiredNoArg: "本功能需要更高套餐。",
    orgSeatLimit:
      "已达座位上限（{arg} 个）。请升级团队 owner 的套餐再邀请。",
    orgSeatLimitNoArg:
      "已达座位上限。请升级团队 owner 的套餐。",
    ssoSaved: "SSO 配置已保存。",
    ssoNoPermission: "仅 owner 与 admin 可修改 SSO 配置。",
    ssoBadMode: "请选择有效的 SSO 模式（关闭 / 可选 / 强制）。",
    ssoBadDefaultRole: "请选择有效的默认角色（admin / member / viewer）。",
    ssoBadDomain: "邮箱域名格式无效（请填写裸域名，例如 acme.com）。",
    ssoIncomplete:
      "启用 SSO 前，请提供 IdP 元数据 XML，或同时填写实体 ID、SSO URL、证书三个手动字段。",
    actionViewPlans: "查看套餐",
  },

  estimator: {
    modeQuick: "快速估算",
    modeCsv: "上传用量 CSV",

    workloadAgentLabel: "重度 agent（Cline / LangGraph / 自主循环）",
    workloadAgentExplainer:
      "Agent 流量最适合接入 — 反复的规划 / 工具调用循环带来路由与拦截重复的空间。区间上端需要真实流量验证，仅靠快速估算还不够。",
    workloadIdeLabel: "IDE 助手（Cursor / Continue / Copilot 类）",
    workloadIdeExplainer:
      "IDE 流量通常是大量短 prompt，可下沉路由；具体收益取决于已经有多少调用走的是便宜模型。",
    workloadChatLabel: "对话 / 客服",
    workloadChatExplainer:
      "复杂度混合，路由会更保守。长 system prompt 与重复上下文仍可解锁缓存节省，Anthropic 上尤为明显。",
    workloadMixedLabel: "混合工作流",
    workloadMixedExplainer:
      "面向生产组合的保守区间。实际数字取决于旗舰模型占比、prompt 重复率以及 shadow 试验是否能证明可安全下沉。",

    quickTitle: "告诉我们你的工作流",
    quickSpendLabel: "月度 LLM 开销（美元，所有服务商合计）",
    quickSpendPerMonth: "/ 月",
    quickSpendHintPrefix:
      "看一下最近的 OpenAI / Anthropic 账单，估个大致数即可。",
    quickSpendHintEmphasis:
      "或切换到上方「上传用量 CSV」获取更准确的数字。",
    quickWorkloadPrompt: "属于哪一类工作流？",
    quickPlanningRangePrefix: "规划区间 ",
    quickPlanningRangeSuffix: "%",

    csvTitle: "上传你的用量 CSV",
    csvIntroPrefix:
      "从你的服务商导出，粘贴或上传到这里。完全在浏览器内解析 — ",
    csvIntroEmphasis: "不会上传到 TokSuan 服务器",
    csvIntroSuffix: "。各服务商的导出入口：",
    csvSourceOpenAI: " → 「Export」",
    csvSourceAnthropic: " → 「Export usage」",
    csvSourceOpenRouter: " → CSV 导出",
    csvSourceDeepSeekSuffix:
      " → 选择月份 → 「Export」（下载的 ZIP 内有两个 CSV，使用 `amount` 那一份）",
    csvSourceQwenSuffix:
      " → 商品名筛选「大模型服务平台百炼」→ 右上角「导出」",
    csvSourceDoubaoSuffix:
      " → 筛选豆包 / 方舟相关产品 → 「导出账单」",
    csvSourceGoogleSuffix:
      " 查看 dashboard 视图，或在 Google Cloud Billing → Reports → Export 导出（如果是通过 Vertex AI 调用 Gemini）。AI Studio 的原生 CSV 导出仍在灰度，目前可能需要手动复制表格到电子表格里。",
    csvSourceColumnsHint:
      "我们需要类似 `model` 与 `cost` / `cost_usd` 的列名，其它列会被忽略。任何自定义 CSV 都行，只要这两列存在 — 中文导出也可（在表格中先把 `模型` → `model`、`应付金额` / `实付金额` → `cost` 重命名再粘贴）。",
    csvChooseFile: "选择 CSV 文件",
    csvOrPaste: "……或直接粘贴 CSV 内容：",
    csvPastePlaceholder:
      "Day,Model,Input tokens,Output tokens,Cost\n2024-01-01,gpt-4o,1234,567,0.0345\n...",
    csvErrorParseFile: "读取文件失败。",
    csvErrorMissingColsFile:
      "未在 CSV 中找到 `model` 与 `cost` 列。请尝试 OpenAI 在 https://platform.openai.com/usage 的 `Export usage`，或 Anthropic 的账单导出。",
    csvErrorMissingColsPaste:
      "未在粘贴文本中找到 `model` 与 `cost` 列。请确认第一行是表头，包含类似 `model` 与 `cost_usd` 的列名。",
    csvFilenamePasted: "（粘贴）",
    csvFileMetaRows: " 行",
    csvFileMetaModels: " 个不同模型",

    resultLabel: "估算区间",
    resultMidpointPrefix: "约 ",
    resultMidpointSuffix: "/月（中位）",
    resultBasedOnPrefix: "（折合 ",
    resultBasedOnSuffix:
      "/年）。来源：{source}。请把它当成规划区间使用；最终以 dashboard 回执与 shadow A/B 为准。",
    resultMinSpendPrefix: "请至少输入 ",
    resultMinSpendEmphasis: "$50/月",
    resultMinSpendSuffix:
      " 的开销才有意义。低于这个量级，基础设施层的节省都是噪声。",
    resultSourceCsv: "你上传的用量数据（{n} 行）",
    resultSourceQuick: "「{label}」工作流分桶",

    paybackProLabel: "Pro $29/月",
    paybackTeamLabel: "Team $99/月",
    paybackScaleLabel: "Scale $499/月",
    paybackPaysBackPrefix: "回本约 ",
    paybackHoursUnit: " 小时",
    paybackDaysUnit: " 天",
    paybackNa: "n/a",
    paybackProNote: "$500/天上限，每月 100 万次请求",
    paybackTeamNote: "无限额 + 审计 CSV 导出",
    paybackScaleNote: "+ SSO + RBAC + 多区域（规划中）",

    breakdownTitle: "按模型拆分",
    breakdownFromCsvSuffix: "来自 {n} 行 CSV",
    breakdownColModel: "模型",
    breakdownColTier: "档位",
    breakdownColSpent: "开销",
    breakdownColEstSaved: "估算节省",
    breakdownColSavedPct: "节省占比",
    breakdownColWhy: "原因",
    breakdownTierFrontier: "旗舰",
    breakdownTierMid: "中等",
    breakdownTierCheap: "经济",
    breakdownTierUnknown: "未知",
    breakdownWhyFrontier:
      "旗舰模型 — 部分 prompt 可下沉到中等档",
    breakdownWhyMid:
      "中等档 — 简单 prompt 可下沉到 mini / haiku / flash",
    breakdownWhyCheap:
      "本就便宜 — 主要靠 prompt 缓存获益",
    breakdownWhyUnknown:
      "未分类 — 保守按中等档估算",
    breakdownTopNFooter:
      "按开销排序，仅显示前 30 / 共 {total} 个模型。",

    howTitle: "估算逻辑",
    howCsvBody:
      "按模型启发式：旗舰模型（gpt-5*、claude-opus*、o3 / o4*）规划路由节省 35–55%；中等档（gpt-4o、sonnet、gemini-pro）20–35%；本就便宜的模型（mini / haiku / flash）路由节省 0–5%，叠加可能的 prompt 缓存。Anthropic 家族额外保守加 10–18% 的 cache_control 红利。",
    howFooter:
      "区间来自 TokSuan 公开 baseline 策略运行（旗舰模型上的 `public_agent_eval_mix`），并对售前用途做了刻意的保守缩水。装作能精确预测节省到美元那是不诚实的；产品的工作是把这个估算变成回执 — 请求模型、实际模型、实际成本、节省金额，以及在你启用 shadow A/B 时给出的质量证据。",
    howSelfHostNote:
      "对付费 API 模型，节省金额按公开 token 价计算。对自部署或自定义 endpoint，TokSuan 可以证明流量从大模型 endpoint 切走，但精确的金额节省需要你提供 GPU / endpoint 成本元数据。",

    notYetTitle: "暂时不必付费的情况",
    notYetUnder50Prefix: "你的合并 LLM 月开销低于 ",
    notYetUnder50Spend: "$50",
    notYetUnder50AmountPrefix: "/月。请使用免费版或",
    notYetUnder50Link: "自部署",
    notYetUnder50Suffix: " — 基础设施层的节省可能就是噪声。",
    notYetCheapModels:
      "几乎所有流量已经走在 mini / haiku / flash 类模型上。请先验证缓存或循环节省。",
    notYetSlaPrefix: "采购今天就要正式 SLA 或 SOC 2。",
    notYetSlaLink1: "请走自部署",
    notYetSlaMid: "（Apache-2.0），或在 ",
    notYetSlaLink2: "GitHub issue",
    notYetSlaSuffix: " 中开启对话。",
    notYetByo:
      "无法 BYO 服务商 API key。TokSuan 托管版是 BYO-key 控制层，不是 token 转售商。",

    ctaTitle: "用真实流量验证一下",
    ctaBody:
      "估算只是估算。最快的验证是发一次真实请求：TokSuan 会显示请求模型、实际模型、路由原因、实际成本与节省金额。更深入的验证是让真实流量在 shadow 模式下跑一周，再看「质量证据」卡。",
    ctaStartFree: "免费开始",
    ctaSelfHostDocs: "自部署文档",
    ctaFinePrintPrefix:
      "我们不抽你 token 的差价。你 BYO 服务商 API key，由服务商直接向你计费。TokSuan 收入是固定的 $29 / $99 月费（2026 Q3 将切换为按结果计费 ",
    ctaFinePrintCode: "max(下限, min(10% × 节省, 上限))",
    ctaFinePrintSuffix:
      "，永远不会超过套餐封顶）。按月计费、随时取消 — 单次最大风险只是当月你已使用周期对应的费用。不退款，无追溯收回，无离场访谈。",
  },

  emails: {
    otpSubject: "你的 TokSuan 登录验证码",
    otpHeading: "登录 TokSuan",
    otpIntro: "请用下方 6 位验证码完成登录，请勿与他人分享。",
    otpExpiry: "验证码 15 分钟内有效。",
    otpFooter: "如果不是你本人请求登录，可忽略此邮件，账号是安全的。",
    otpTextLine1: "你的 TokSuan 登录验证码：{code}",
    otpTextLink: "或者点击下方链接直接登录：",
    otpTextExpiry: "验证码 {ttl} 分钟内有效。",
    otpTextFooter: "如果不是你本人请求登录，可忽略此邮件。",
    otpSubjectTpl: "你的 TokSuan 登录验证码：{code}",
    otpHtmlBrand: "TokSuan",
    otpHtmlSignInBtn: "一键登录",

    inviteSubject: "{inviter} 邀请你加入 TokSuan 上的 {org}",
    inviteTextLine1:
      "{inviter} 邀请你以 {role} 身份加入 TokSuan 上的 {org} 团队。",
    inviteTextLink: "接受邀请：",
    inviteTextFooter1:
      "如果你还没有 TokSuan 账户，接受邀请时会自动为你创建。",
    inviteTextFooter2: "邀请 14 天内有效。",
    inviteHtmlLine:
      "{inviter} 邀请你以 <strong>{role}</strong> 身份加入 TokSuan 上的 <strong>{org}</strong> 团队。",
    inviteHtmlBtn: "接受邀请",
    inviteHtmlFallback: "如果按钮无法点击，请复制此 URL：",
    inviteHtmlFooter:
      "如果你还没有 TokSuan 账户，接受邀请时会自动为你创建。邀请 14 天内有效。",

    digestSubject: "TokSuan 本周节省日报",
    digestSubjectTpl: "TokSuan · 本周节省 {amount}",
    digestHeading: "上周 TokSuan 总览",
    digestIntro:
      "你的 agent 上一周花了多少、TokSuan 路由省了多少、最值得关注的几个模式简要汇总。",
    digestSpendLabel: "开销",
    digestSavedLabel: "节省",
    digestRequestsLabel: "请求",
    digestCta: "打开 Dashboard",
    digestUnsubscribe: "退订日报",
    digestGreeting: "{name} 你好，",
    digestGreetingFallbackName: "同学",
    digestRecapLine: "近 7 天通过 TokSuan：节省 {amount}。",
    digestRoutingLabel: "路由：",
    digestRoutingNote: "（{n} 次请求被下沉）",
    digestCacheLabel: "Prompt 缓存：",
    digestCacheNote: "（{n} 次缓存命中）",
    digestAlsoCaughtLabel: "另外拦截：",
    digestAlsoCaughtNote:
      "{loops} 次失控循环 + {budget} 次超预算调用",
    digestTopRoutesLabel: "最省钱的路由对：",
    digestTotalSpendLabel: "近 7 天总开销：{amount}",
    digestViewDashboardLabel: "打开 Dashboard：{url}",
    digestUnsubscribeLine: "退订每周日报：{url}",
    digestUnsubscribeNote:
      "（事务性邮件如登录验证码、账单收据仍会照常收到。）",
    digestFooterTagline:
      "TokSuan · 开源的 agent 预算网关",
    digestHtmlBrand: "TokSuan · 每周节省日报",
    digestHtmlSavedLabel: "已节省",
    digestHtmlVsSpendPrefix: "对比实际开销 ",
    digestHtmlVsSpendSuffix: "",
    digestHtmlReqsSuffix: " 次请求",
    digestHtmlHitsSuffix: " 次命中",
    digestHtmlAlsoCaught: "另外拦截",
    digestHtmlLoopsSuffix: " 次失控循环",
    digestHtmlOverBudgetSuffix: " 次超预算",
    digestHtmlTopRoutesLabel: "最省钱的路由对",
    digestHtmlReqAbbrev: " 次",
    digestHtmlViewBtn: "打开 Dashboard",
    digestHtmlUnsubPrefix: "不想再收每周日报？",
    digestHtmlUnsubLink: "一键退订",
    digestHtmlUnsubSuffix:
      " — 事务性邮件（登录、账单）不会受影响。",
  },

  languageToggle: {
    ariaLabel: "切换语言",
    currentEn: "English",
    currentZh: "中文",
    switchToTpl: "切换到 {label}",
  },
};
