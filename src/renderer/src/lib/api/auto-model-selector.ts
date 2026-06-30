import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useUIStore } from '@renderer/stores/ui-store'
import type {
  AppMode,
  AutoModelConfidence,
  AutoModelDecisionSource,
  AutoModelRoute,
  AutoModelRoutingComplexity,
  AutoModelRoutingRisk,
  AutoModelSelectionStatus,
  AutoModelTaskType
} from '@renderer/stores/ui-store'
import { agentBridge, canSidecarHandle, runSidecarCleanup } from '@renderer/lib/ipc/agent-bridge'
import {
  buildSidecarAgentRunRequest,
  isNativeSidecarProviderConfig
} from '@renderer/lib/ipc/sidecar-protocol'
import { agentStream } from '@renderer/lib/ipc/agent-stream-receiver'
import { toAgentEvent } from '@renderer/lib/agent/stream-event-adapter'
import {
  RESPONSES_SESSION_SCOPE_AUTO_MODEL_ROUTING,
  withAuxiliaryResponsesRequestPolicy
} from './responses-session-policy'
import type { ProviderConfig, UnifiedMessage } from './types'

const AUTO_MODEL_CLASSIFIER_PROMPT = [
  'You are a strict task router for a desktop AI coding product.',
  'Classify ONLY the current user request.',
  'You will receive routing signals and the raw user text.',
  'Return ONLY valid compact JSON with keys taskType, route, confidence.',
  'Allowed taskType values: rewrite, summarize, translate, format, qa, explain, compare, extract, plan, debug, implement, analyze, other.',
  'Allowed route values: main, fast.',
  'Allowed confidence values: high, medium, low.',
  'Choose fast only for straightforward, bounded, low-risk, single-turn requests that can likely be answered directly without tools.',
  'Choose main for repository/file/terminal/tool tasks, coding implementation, debugging, refactoring, architecture, multi-step planning, ambiguous requests, long-context analysis, or anything likely to require deeper reasoning.',
  'Do not route requests involving local files, codebases, commands, tests, builds, linting, typechecking, or tool usage to fast.',
  'Simple translation, rewrite, formatting, short extraction, short summary, and short Q&A can use fast when routing signals are low risk.',
  'Respect MODE and ROUTING_SIGNALS as hidden context; do not mention them.',
  'Never output markdown, prose, or code fences.'
].join(' ')

interface ToolIntentResult {
  requiresTools: boolean
  reasons: string[]
}

interface AutoRoutingSignals {
  taskType: AutoModelTaskType
  requiresTools: boolean
  complexity: AutoModelRoutingComplexity
  risk: AutoModelRoutingRisk
  reasons: string[]
  heuristicRoute?: AutoModelRoute
  heuristicConfidence?: AutoModelConfidence
  heuristicFallbackReason?: string
}

interface AutoClassifierResult {
  taskType: AutoModelTaskType
  route: AutoModelRoute
  confidence: AutoModelConfidence
}

interface AutoRoutingPolicyDecision {
  route: AutoModelRoute
  taskType: AutoModelTaskType
  confidence: AutoModelConfidence
  decisionSource: AutoModelDecisionSource
  fallbackReason?: string
}

function stripRoutingArtifacts(value: string): string {
  return value
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<system-command\b[^>]*>[\s\S]*?<\/system-command>/gi, '')
    .trim()
}

function extractTextContent(content: UnifiedMessage['content']): string {
  if (typeof content === 'string') {
    return stripRoutingArtifacts(content)
  }

  return stripRoutingArtifacts(
    content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  )
}

export function extractLatestUserInput(messages: UnifiedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = extractTextContent(message.content)
    if (text) return text
  }
  return ''
}

function resolveDescriptor(
  config: ProviderConfig | null
): Pick<AutoModelSelectionStatus, 'providerId' | 'modelId' | 'providerName' | 'modelName'> {
  if (!config?.providerId || !config.model) {
    return {
      providerId: config?.providerId,
      modelId: config?.model,
      providerName: undefined,
      modelName: config?.model
    }
  }

  const provider = useProviderStore
    .getState()
    .providers.find((item) => item.id === config.providerId)
  const model = provider?.models.find((item) => item.id === config.model)

  return {
    providerId: config.providerId,
    modelId: config.model,
    providerName: provider?.name,
    modelName: model?.name ?? config.model
  }
}

function buildSelectionStatus(options: {
  target: AutoModelSelectionStatus['target']
  config: ProviderConfig | null
  mode?: AppMode
  taskType?: AutoModelTaskType
  confidence?: AutoModelConfidence
  decisionSource?: AutoModelDecisionSource
  toolsAllowed?: boolean
  complexity?: AutoModelRoutingComplexity
  risk?: AutoModelRoutingRisk
  reasons?: string[]
  classifierRoute?: AutoModelRoute
  heuristicRoute?: AutoModelRoute
  fallbackReason?: string
  routingDurationMs?: number
}): AutoModelSelectionStatus {
  const {
    target,
    config,
    mode,
    taskType,
    confidence,
    decisionSource,
    toolsAllowed,
    complexity,
    risk,
    reasons,
    classifierRoute,
    heuristicRoute,
    fallbackReason,
    routingDurationMs
  } = options
  return {
    source: 'auto',
    ...(mode ? { mode } : {}),
    target,
    ...resolveDescriptor(config),
    ...(taskType ? { taskType } : {}),
    ...(confidence ? { confidence } : {}),
    ...(decisionSource ? { decisionSource } : {}),
    ...(toolsAllowed !== undefined ? { toolsAllowed } : {}),
    ...(complexity ? { complexity } : {}),
    ...(risk ? { risk } : {}),
    ...(reasons?.length ? { reasons } : {}),
    ...(classifierRoute ? { classifierRoute } : {}),
    ...(heuristicRoute ? { heuristicRoute } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(routingDurationMs !== undefined ? { routingDurationMs } : {}),
    selectedAt: Date.now()
  }
}

function normalizeRoute(value: string): AutoModelRoute | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'main' || normalized === 'fast') return normalized
  const matched = normalized.match(/\b(main|fast)\b/)
  if (matched?.[1] === 'main') return 'main'
  if (matched?.[1] === 'fast') return 'fast'
  return null
}

function normalizeTaskType(value: string | undefined): AutoModelTaskType | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  const allowed = new Set<AutoModelTaskType>([
    'rewrite',
    'summarize',
    'translate',
    'format',
    'qa',
    'explain',
    'compare',
    'extract',
    'plan',
    'debug',
    'implement',
    'analyze',
    'other'
  ])
  return allowed.has(normalized as AutoModelTaskType) ? (normalized as AutoModelTaskType) : null
}

function normalizeConfidence(value: string | undefined): AutoModelConfidence | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized
  }
  return null
}

function tryParseClassifierResult(value: string): AutoClassifierResult | null {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  const jsonText = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned

  try {
    const parsed = JSON.parse(jsonText) as {
      taskType?: string
      route?: string
      confidence?: string
    }
    const taskType = normalizeTaskType(parsed.taskType)
    const route = normalizeRoute(parsed.route ?? '')
    const confidence = normalizeConfidence(parsed.confidence)
    if (!taskType || !route || !confidence) return null
    return { taskType, route, confidence }
  } catch {
    return null
  }
}

function addReason(reasons: Set<string>, condition: boolean, reason: string): void {
  if (condition) reasons.add(reason)
}

function hasPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function detectTaskType(input: string): AutoModelTaskType {
  const normalized = input.toLowerCase()

  if (hasPattern(normalized, [/\btranslate\b/, /翻译|译成|翻成/])) return 'translate'
  if (
    hasPattern(normalized, [
      /\b(rewrite|rephrase|polish|proofread)\b/,
      /改写|润色|校对|更正式|更自然|优化(这段|这句|文案|表达)/
    ])
  ) {
    return 'rewrite'
  }
  if (hasPattern(normalized, [/\b(summarize|summary|tl;dr)\b/, /总结|摘要|概括/])) {
    return 'summarize'
  }
  if (
    hasPattern(normalized, [
      /\b(format|prettify|convert to|json|yaml|markdown|table)\b/,
      /格式化|排版|转成|转换成|表格/
    ])
  ) {
    return 'format'
  }
  if (hasPattern(normalized, [/\b(extract|pull out)\b/, /提取|抽取|摘出/])) return 'extract'
  if (hasPattern(normalized, [/\b(compare|versus|vs\.)\b/, /比较|对比|区别/])) return 'compare'
  if (
    hasPattern(normalized, [
      /\b(debug|bug|error|exception|stack trace|fix failing|failure)\b/,
      /调试|报错|错误|异常|失败|修复.*(错误|报错|bug|问题)/
    ])
  ) {
    return 'debug'
  }
  if (
    hasPattern(normalized, [
      /\b(implement|build|add|create|refactor|migrate|optimi[sz]e|improve)\b/,
      /实现|开发|新增|添加|创建|重构|迁移|优化|改进|修复/
    ])
  ) {
    return 'implement'
  }
  if (
    hasPattern(normalized, [
      /\b(plan|design|architecture|roadmap|strategy)\b/,
      /计划|规划|设计|架构|方案|路线图|策略/
    ])
  ) {
    return 'plan'
  }
  if (hasPattern(normalized, [/\b(analyze|analyse|inspect|investigate|research)\b/, /分析|调研/])) {
    return 'analyze'
  }
  if (
    hasPattern(normalized, [/\b(explain|what is|why|how does)\b/, /解释|说明|原理|是什么|为什么/])
  ) {
    return 'explain'
  }
  if (hasPattern(normalized, [/\?$|\b(who|what|when|where|why|how|which)\b/, /[？?]$/])) {
    return 'qa'
  }

  return 'other'
}

function detectToolIntent(options: {
  latestUserInput: string
  mode?: AppMode
  isContinue?: boolean
  projectId?: string | null
  allowTools?: boolean
}): ToolIntentResult {
  const input = options.latestUserInput.trim()
  const normalized = input.toLowerCase()
  const reasons = new Set<string>()

  addReason(reasons, !!options.isContinue, 'continue_run')
  addReason(
    reasons,
    hasPattern(normalized, [
      /\b(read|open|inspect|search|find|grep|glob|list|ls|locate|scan)\b/,
      /读取|打开|查看|搜索|查找|检索|列出|定位|扫描/
    ]),
    'explicit_lookup_intent'
  )
  addReason(
    reasons,
    hasPattern(normalized, [
      /\b(edit|modify|change|update|patch|refactor|rename|implement|fix|debug)\b/,
      /修改|编辑|更新|补丁|重构|重命名|实现|修复|调试|改代码|写代码/
    ]),
    'explicit_code_change_intent'
  )
  addReason(
    reasons,
    hasPattern(normalized, [
      /\b(run|execute|test|build|lint|typecheck|compile|benchmark|terminal|command|shell|bash|powershell)\b/,
      /运行|执行|测试|构建|编译|命令|终端|脚本|typecheck|lint/
    ]),
    'explicit_execution_intent'
  )
  addReason(
    reasons,
    hasPattern(normalized, [
      /\b(file|files|folder|directory|repo|repository|codebase|workspace|project)\b/,
      /文件|目录|文件夹|仓库|代码库|工作区|项目/
    ]),
    'workspace_reference'
  )
  addReason(
    reasons,
    hasPattern(normalized, [
      /\b(web search|browse|fetch|scrape|internet|online|latest news|current news)\b/,
      /联网|网页|浏览器|抓取|爬取|搜索网页|最新消息|实时信息/
    ]),
    'external_lookup_intent'
  )
  addReason(
    reasons,
    hasPattern(normalized, [
      /\b(tool|tools|subagent|agent|plan mode|task list)\b/,
      /工具调用|子代理|智能体|计划模式|任务列表/
    ]),
    'agent_tool_reference'
  )
  addReason(
    reasons,
    !!options.projectId &&
      hasPattern(normalized, [
        /\b(this|current|existing)\s+(repo|repository|project|codebase|workspace)\b/,
        /当前(项目|仓库|代码库|工作区|目录)|现有(逻辑|实现|代码|机制)|这个(项目|仓库|代码库)/
      ]),
    'current_workspace_context'
  )
  addReason(reasons, !!options.allowTools, 'tools_allowed_by_policy')

  return {
    requiresTools: reasons.size > 0,
    reasons: [...reasons]
  }
}

function classifyByHeuristics(options: {
  latestUserInput: string
  mode?: AppMode
  isContinue?: boolean
  projectId?: string | null
  allowTools?: boolean
}): AutoRoutingSignals {
  const input = options.latestUserInput.trim()
  const normalized = input.toLowerCase()
  const taskType = detectTaskType(input)
  const toolIntent = detectToolIntent(options)
  const reasons = new Set(toolIntent.reasons)
  const lineCount = input ? input.split(/\r?\n/).length : 0
  const inputLength = input.length
  const hasCodeFence = /```/.test(input)
  const hasPathLikeText = /(?:^|[\s'"`])(?:[\w.-]+\/)+[\w.-]+/.test(input)
  const hasLongContext = inputLength > 1800 || lineCount > 24
  const hasMediumContext = inputLength > 700 || lineCount > 10
  const hasMultiStepSignal = hasPattern(normalized, [
    /\b(step by step|multi-step|end-to-end|full implementation|then|after that)\b/,
    /分步骤|多步骤|端到端|完整实现|然后|接着|再去/
  ])
  const hasComplexCodeSignal = hasPattern(normalized, [
    /\b(debug|bug|error|exception|stack trace|failing|failure|typecheck|lint|test|build|compile|benchmark)\b/,
    /\b(implement|refactor|migrate|architecture|repository|codebase|workspace|terminal|command|shell)\b/,
    /调试|报错|错误|异常|失败|实现|开发|重构|迁移|架构|仓库|代码库|终端|命令|运行|测试|构建|编译/
  ])
  const hasArchitectureSignal = hasPattern(normalized, [
    /\b(architecture|system design|routing|router|scheduler|orchestration|strategy)\b/,
    /架构|系统设计|路由|调度|编排|策略|机制|原理/
  ])
  const modeIsAgentic =
    options.mode === 'cowork' || options.mode === 'code' || options.mode === 'acp'
  const modeIsConservative = modeIsAgentic || options.mode === 'clarify'
  const requiresTools = toolIntent.requiresTools

  addReason(reasons, hasCodeFence, 'contains_code_block')
  addReason(reasons, hasPathLikeText, 'contains_path_like_text')
  addReason(reasons, hasLongContext, 'long_context')
  addReason(reasons, hasMultiStepSignal, 'multi_step_signal')
  addReason(reasons, hasComplexCodeSignal, 'complex_code_signal')
  addReason(reasons, hasArchitectureSignal, 'architecture_or_routing_signal')
  addReason(reasons, modeIsAgentic, 'agentic_mode')
  addReason(reasons, options.mode === 'clarify', 'clarify_mode')

  let complexity: AutoModelRoutingComplexity = 'simple'
  if (
    options.isContinue ||
    requiresTools ||
    hasLongContext ||
    hasComplexCodeSignal ||
    hasArchitectureSignal ||
    hasMultiStepSignal ||
    hasPathLikeText ||
    taskType === 'debug' ||
    taskType === 'implement'
  ) {
    complexity = 'complex'
  } else if (
    hasMediumContext ||
    modeIsConservative ||
    taskType === 'plan' ||
    taskType === 'analyze'
  ) {
    complexity = 'medium'
  }

  let risk: AutoModelRoutingRisk = 'low'
  if (
    options.isContinue ||
    requiresTools ||
    hasComplexCodeSignal ||
    hasArchitectureSignal ||
    taskType === 'debug' ||
    taskType === 'implement'
  ) {
    risk = 'high'
  } else if (complexity === 'medium' || taskType === 'plan' || taskType === 'analyze') {
    risk = 'medium'
  }

  const simpleTaskTypes = new Set<AutoModelTaskType>([
    'rewrite',
    'summarize',
    'translate',
    'format',
    'qa',
    'explain',
    'compare',
    'extract'
  ])
  const modeAllowsFast =
    !options.mode ||
    options.mode === 'chat' ||
    (modeIsConservative && simpleTaskTypes.has(taskType) && inputLength <= 420)
  const isBoundedSimpleRequest =
    simpleTaskTypes.has(taskType) &&
    complexity === 'simple' &&
    risk === 'low' &&
    inputLength <= (taskType === 'summarize' ? 1200 : 800) &&
    lineCount <= 12 &&
    modeAllowsFast

  if (options.isContinue) {
    return {
      taskType,
      requiresTools,
      complexity,
      risk,
      reasons: [...reasons],
      heuristicRoute: 'main',
      heuristicConfidence: 'high',
      heuristicFallbackReason: 'heuristic_complex_main'
    }
  }

  if (requiresTools || complexity === 'complex' || risk === 'high') {
    return {
      taskType,
      requiresTools,
      complexity,
      risk,
      reasons: [...reasons],
      heuristicRoute: 'main',
      heuristicConfidence: 'high',
      heuristicFallbackReason: requiresTools ? 'tool_required_main' : 'heuristic_complex_main'
    }
  }

  if (isBoundedSimpleRequest) {
    return {
      taskType,
      requiresTools,
      complexity,
      risk,
      reasons: [...reasons, 'bounded_simple_request'],
      heuristicRoute: 'fast',
      heuristicConfidence: 'high',
      heuristicFallbackReason: 'heuristic_simple_fast'
    }
  }

  return {
    taskType,
    requiresTools,
    complexity,
    risk,
    reasons: [...reasons]
  }
}

function buildClassifierInput(options: {
  latestUserInput: string
  mode: AppMode
  allowTools: boolean
  isContinue?: boolean
  projectId?: string | null
  signals: AutoRoutingSignals
}): string {
  const signals = options.signals
  return [
    `MODE=${options.mode}`,
    `ALLOW_TOOLS=${options.allowTools ? 'true' : 'false'}`,
    `IS_CONTINUE=${options.isContinue ? 'true' : 'false'}`,
    `PROJECT_BOUND=${options.projectId ? 'true' : 'false'}`,
    `SIGNAL_TASK_TYPE=${signals.taskType}`,
    `SIGNAL_REQUIRES_TOOLS=${signals.requiresTools ? 'true' : 'false'}`,
    `SIGNAL_COMPLEXITY=${signals.complexity}`,
    `SIGNAL_RISK=${signals.risk}`,
    `SIGNAL_REASONS=${signals.reasons.slice(0, 10).join(',') || 'none'}`,
    '',
    options.latestUserInput.slice(0, 4000)
  ].join('\n')
}

function getLastHighConfidenceSelection(
  sessionId: string | undefined
): AutoModelSelectionStatus | null {
  if (!sessionId) return null
  return useUIStore.getState().getAutoModelHighConfidenceSelection(sessionId)
}

function getFastModelSupportsTools(): boolean {
  const fastConfig = useProviderStore.getState().getFastProviderConfig()
  if (!fastConfig?.providerId || !fastConfig.model) return false
  const provider = useProviderStore
    .getState()
    .providers.find((item) => item.id === fastConfig.providerId)
  const model = provider?.models.find((item) => item.id === fastConfig.model)
  return model?.supportsFunctionCall === true
}

function canReusePreviousHighConfidence(options: {
  previous: AutoModelSelectionStatus
  mode?: AppMode
  allowTools: boolean
  signals: AutoRoutingSignals
}): boolean {
  if (options.previous.mode !== options.mode) return false
  if (options.previous.toolsAllowed !== options.allowTools) return false
  if (options.signals.risk === 'high' && options.previous.target === 'fast') return false
  if (options.signals.requiresTools && options.previous.target === 'fast') return false
  return true
}

function resolveLowConfidenceRoute(options: {
  sessionId?: string
  mode?: AppMode
  allowTools: boolean
  signals: AutoRoutingSignals
}): AutoRoutingPolicyDecision {
  const previousHighConfidence = getLastHighConfidenceSelection(options.sessionId)
  if (
    previousHighConfidence &&
    canReusePreviousHighConfidence({
      previous: previousHighConfidence,
      mode: options.mode,
      allowTools: options.allowTools,
      signals: options.signals
    })
  ) {
    return {
      route: previousHighConfidence.target,
      taskType: options.signals.taskType,
      confidence: 'low',
      decisionSource: 'fallback-last-high-confidence',
      fallbackReason: 'low_confidence_reuse_last_route'
    }
  }

  const conservativeMode =
    options.mode === 'cowork' || options.mode === 'code' || options.mode === 'acp'
  const clarifyNeedsMain =
    options.mode === 'clarify' &&
    !(options.signals.complexity === 'simple' && options.signals.risk === 'low')

  if (
    conservativeMode ||
    clarifyNeedsMain ||
    options.signals.requiresTools ||
    options.signals.risk !== 'low' ||
    options.signals.complexity === 'complex'
  ) {
    return {
      route: 'main',
      taskType: options.signals.taskType,
      confidence: 'low',
      decisionSource: 'fallback-main',
      fallbackReason: 'low_confidence_main'
    }
  }

  return {
    route: 'fast',
    taskType: options.signals.taskType,
    confidence: 'low',
    decisionSource: 'fallback-fast',
    fallbackReason: 'low_confidence_fast'
  }
}

function applyAutoRoutingPolicy(options: {
  classifierResult: AutoClassifierResult
  signals: AutoRoutingSignals
  sessionId?: string
  mode?: AppMode
  allowTools: boolean
}): AutoRoutingPolicyDecision {
  const { classifierResult, signals } = options

  if (classifierResult.confidence === 'low') {
    return resolveLowConfidenceRoute({
      sessionId: options.sessionId,
      mode: options.mode,
      allowTools: options.allowTools,
      signals
    })
  }

  if (
    classifierResult.route === 'fast' &&
    (signals.requiresTools || signals.risk === 'high' || signals.complexity === 'complex')
  ) {
    return {
      route: 'main',
      taskType: classifierResult.taskType,
      confidence: classifierResult.confidence,
      decisionSource: 'policy',
      fallbackReason: signals.requiresTools ? 'tool_required_main' : 'classifier_overridden_main'
    }
  }

  return {
    route: classifierResult.route,
    taskType: classifierResult.taskType,
    confidence: classifierResult.confidence,
    decisionSource: 'classifier'
  }
}

function signalStatusFields(
  signals: AutoRoutingSignals
): Pick<
  AutoModelSelectionStatus,
  'taskType' | 'complexity' | 'risk' | 'reasons' | 'heuristicRoute'
> {
  return {
    taskType: signals.taskType,
    complexity: signals.complexity,
    risk: signals.risk,
    reasons: signals.reasons,
    ...(signals.heuristicRoute ? { heuristicRoute: signals.heuristicRoute } : {})
  }
}

export function shouldAllowToolsForRequest(options: {
  latestUserInput: string
  mode?: AppMode
  isContinue?: boolean
  projectId?: string | null
}): boolean {
  const input = options.latestUserInput.trim()
  if (!input) return false
  return detectToolIntent(options).requiresTools
}

export async function selectAutoModel(options: {
  latestUserInput: string
  sessionId?: string
  mode?: AppMode
  allowTools?: boolean
  isContinue?: boolean
  projectId?: string | null
  signal?: AbortSignal
}): Promise<AutoModelSelectionStatus> {
  const routingStartedAt = Date.now()
  const finishSelection = (
    selectionOptions: Parameters<typeof buildSelectionStatus>[0]
  ): AutoModelSelectionStatus =>
    buildSelectionStatus({
      ...selectionOptions,
      routingDurationMs: Date.now() - routingStartedAt
    })
  const providerStore = useProviderStore.getState()
  const mainConfig = providerStore.getActiveProviderConfig()
  const fastConfig = providerStore.getFastProviderConfig()
  const latestUserInput = options.latestUserInput.trim()
  const mode = options.mode
  const allowTools =
    options.allowTools ??
    shouldAllowToolsForRequest({
      latestUserInput,
      mode,
      isContinue: options.isContinue,
      projectId: options.projectId
    })
  let routingSignals: AutoRoutingSignals | null = null

  if (!mainConfig) {
    return finishSelection({
      target: 'main',
      config: null,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'main_unavailable'
    })
  }

  if (!latestUserInput) {
    return finishSelection({
      target: 'main',
      config: mainConfig,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'empty_input'
    })
  }

  if (!fastConfig) {
    return finishSelection({
      target: 'main',
      config: mainConfig,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'fast_unavailable'
    })
  }

  routingSignals = classifyByHeuristics({
    latestUserInput,
    mode,
    isContinue: options.isContinue,
    projectId: options.projectId,
    allowTools
  })

  if (routingSignals.heuristicRoute === 'main') {
    return finishSelection({
      target: 'main',
      config: mainConfig,
      mode,
      ...signalStatusFields(routingSignals),
      confidence: routingSignals.heuristicConfidence,
      toolsAllowed: allowTools,
      decisionSource: 'heuristic',
      fallbackReason: routingSignals.heuristicFallbackReason
    })
  }

  if (allowTools && !getFastModelSupportsTools()) {
    return finishSelection({
      target: 'main',
      config: mainConfig,
      mode,
      ...signalStatusFields(routingSignals),
      confidence: 'high',
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'fast_model_tools_unsupported'
    })
  }

  if (fastConfig.requiresApiKey !== false && !fastConfig.apiKey) {
    return finishSelection({
      target: 'main',
      config: mainConfig,
      mode,
      ...signalStatusFields(routingSignals),
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'fast_auth_missing'
    })
  }

  if (fastConfig.providerId) {
    const fastReady = await ensureProviderAuthReady(fastConfig.providerId)
    if (!fastReady) {
      return finishSelection({
        target: 'main',
        config: mainConfig,
        mode,
        ...signalStatusFields(routingSignals),
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'fast_auth_unavailable'
      })
    }
  }

  if (routingSignals.heuristicRoute === 'fast') {
    return finishSelection({
      target: 'fast',
      config: fastConfig,
      mode,
      ...signalStatusFields(routingSignals),
      confidence: routingSignals.heuristicConfidence,
      toolsAllowed: allowTools,
      decisionSource: 'heuristic',
      fallbackReason: routingSignals.heuristicFallbackReason
    })
  }

  const abortController = new AbortController()
  const abort = (): void => abortController.abort()
  const timeout = setTimeout(abort, 10000)
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const routingInput = buildClassifierInput({
      latestUserInput,
      mode: mode ?? 'chat',
      allowTools,
      isContinue: options.isContinue,
      projectId: options.projectId,
      signals: routingSignals
    })
    const routingConfig = withAuxiliaryResponsesRequestPolicy(
      {
        ...fastConfig,
        maxTokens: 96,
        temperature: 0,
        thinkingEnabled: false,
        systemPrompt: AUTO_MODEL_CLASSIFIER_PROMPT
      },
      RESPONSES_SESSION_SCOPE_AUTO_MODEL_ROUTING
    )

    const messages: UnifiedMessage[] = [
      {
        id: 'auto-model-route',
        role: 'user',
        content: routingInput,
        createdAt: Date.now()
      }
    ]

    const sidecarRequest = buildSidecarAgentRunRequest({
      messages,
      provider: routingConfig,
      tools: [],
      maxIterations: 1,
      forceApproval: false
    })
    if (!sidecarRequest) {
      return finishSelection({
        target: 'main',
        config: mainConfig,
        mode,
        ...signalStatusFields(routingSignals),
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'sidecar_request_build_failed'
      })
    }

    if (!isNativeSidecarProviderConfig(routingConfig)) {
      return finishSelection({
        target: 'main',
        config: mainConfig,
        mode,
        ...signalStatusFields(routingSignals),
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'sidecar_provider_not_native'
      })
    }

    const supportsAgentRun = await canSidecarHandle('agent.run')
    const supportsProvider = await canSidecarHandle(`provider.${routingConfig.type}`)
    if (!supportsAgentRun || !supportsProvider) {
      return finishSelection({
        target: 'main',
        config: mainConfig,
        mode,
        ...signalStatusFields(routingSignals),
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'sidecar_capability_unavailable'
      })
    }

    const initialized = await agentBridge.initialize()
    if (!initialized) {
      return finishSelection({
        target: 'main',
        config: mainConfig,
        mode,
        ...signalStatusFields(routingSignals),
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'sidecar_unavailable'
      })
    }

    const result = await agentBridge.runAgent(sidecarRequest)
    let output = ''
    let finished = false
    let unsubscribe: (() => void) | null = null

    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = async (): Promise<void> => {
          try {
            await agentBridge.cancelAgent(result.runId)
          } catch {
            // ignore cancellation races
          }
          reject(new Error('aborted'))
        }

        if (abortController.signal.aborted) {
          void onAbort()
          return
        }

        abortController.signal.addEventListener(
          'abort',
          () => {
            void onAbort()
          },
          { once: true }
        )

        unsubscribe = agentStream.subscribeAll((eventRunId, _sessionId, streamEvent) => {
          if (eventRunId !== result.runId) return
          const event = toAgentEvent(streamEvent)
          if (!event) return

          if (event.type === 'text_delta' && event.text) {
            output += event.text
            if (output.length >= 512) {
              finished = true
              resolve()
            }
            return
          }

          if (event.type === 'loop_end') {
            finished = true
            resolve()
            return
          }

          if (event.type === 'error') {
            finished = true
            reject(event.error)
          }
        })
      })
    } finally {
      runSidecarCleanup(unsubscribe)
      if (!finished) {
        try {
          await agentBridge.cancelAgent(result.runId)
        } catch {
          // ignore cancellation races
        }
      }
    }

    const normalizedOutput = stripRoutingArtifacts(output)
    const parsed = tryParseClassifierResult(normalizedOutput)
    if (!parsed) {
      return finishSelection({
        target: 'main',
        config: mainConfig,
        mode,
        ...signalStatusFields(routingSignals),
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'invalid_classifier_output'
      })
    }

    if (allowTools && parsed.route === 'fast' && !getFastModelSupportsTools()) {
      return finishSelection({
        target: 'main',
        config: mainConfig,
        mode,
        ...signalStatusFields(routingSignals),
        taskType: parsed.taskType,
        confidence: parsed.confidence,
        classifierRoute: parsed.route,
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'fast_model_tools_unsupported'
      })
    }

    const policyDecision = applyAutoRoutingPolicy({
      classifierResult: parsed,
      signals: routingSignals,
      sessionId: options.sessionId,
      mode,
      allowTools
    })

    return policyDecision.route === 'fast'
      ? finishSelection({
          target: 'fast',
          config: fastConfig,
          mode,
          ...signalStatusFields(routingSignals),
          taskType: policyDecision.taskType,
          confidence: policyDecision.confidence,
          classifierRoute: parsed.route,
          toolsAllowed: allowTools,
          decisionSource: policyDecision.decisionSource,
          ...(policyDecision.fallbackReason
            ? { fallbackReason: policyDecision.fallbackReason }
            : {})
        })
      : finishSelection({
          target: 'main',
          config: mainConfig,
          mode,
          ...signalStatusFields(routingSignals),
          taskType: policyDecision.taskType,
          confidence: policyDecision.confidence,
          classifierRoute: parsed.route,
          toolsAllowed: allowTools,
          decisionSource: policyDecision.decisionSource,
          ...(policyDecision.fallbackReason
            ? { fallbackReason: policyDecision.fallbackReason }
            : {})
        })
  } catch {
    return finishSelection({
      target: 'main',
      config: mainConfig,
      mode,
      ...(routingSignals ? signalStatusFields(routingSignals) : {}),
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'classification_failed'
    })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
