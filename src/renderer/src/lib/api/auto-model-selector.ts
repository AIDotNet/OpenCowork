import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useMcpStore } from '@renderer/stores/mcp-store'
import type {
  AppMode,
  AutoModelConfidence,
  AutoModelDecisionSource,
  AutoModelSelectionStatus,
  AutoModelTaskType
} from '@renderer/stores/ui-store'
import { agentBridge, canSidecarHandle, runSidecarCleanup } from '@renderer/lib/ipc/agent-bridge'
import {
  buildSidecarAgentRunRequest,
  normalizeSidecarAgentEvent,
  normalizeSidecarRecord
} from '@renderer/lib/ipc/sidecar-protocol'
import {
  RESPONSES_SESSION_SCOPE_AUTO_MODEL_ROUTING,
  withAuxiliaryResponsesRequestPolicy
} from './responses-session-policy'
import type { ProviderConfig, UnifiedMessage } from './types'

const AUTO_MODEL_LEGACY_SELECTOR_PROMPT = [
  'You are a strict model router.',
  'Decide whether the latest user input should use the main model or the fast model.',
  'Return ONLY one token: main or fast.',
  'Choose main for complex reasoning, multi-step coding/debugging, architecture, long analysis, or ambiguous tasks that likely need deeper thinking.',
  'Choose fast for simple Q&A, short rewrites, lightweight summaries, quick formatting, or other straightforward requests.',
  'Never output anything except main or fast.'
].join(' ')

const AUTO_MODEL_CLASSIFIER_PROMPT = [
  'You are a strict task router for a desktop AI coding product.',
  'Classify ONLY the current user request.',
  'You will receive a short routing header and the raw user text.',
  'Return ONLY valid compact JSON with keys taskType, route, confidence.',
  'Allowed taskType values: rewrite, summarize, translate, format, qa, explain, compare, extract, plan, debug, implement, analyze, other.',
  'Allowed route values: main, fast.',
  'Allowed confidence values: high, medium, low.',
  'Default to route=fast for any straightforward, bounded, single-turn request that can likely be answered directly.',
  'Use route=main only for clearly complex reasoning, multi-step execution, ambiguous or underspecified asks, code-writing-heavy tasks, debugging-heavy tasks, architecture-heavy tasks, or requests that are likely to require tools.',
  'Simple qa, explain, compare, and extract requests should usually use route=fast unless they are clearly complex.',
  'Respect the MODE in the routing header as hidden context, but classify primarily from the user text.',
  'Never output markdown, prose, or code fences.'
].join(' ')

const MODE_AWARE_AUTO_ROUTING_MODES = new Set<AppMode>(['clarify', 'cowork', 'code', 'acp'])

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
  fallbackReason?: string
}): AutoModelSelectionStatus {
  const {
    target,
    config,
    mode,
    taskType,
    confidence,
    decisionSource,
    toolsAllowed,
    fallbackReason
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
    ...(fallbackReason ? { fallbackReason } : {}),
    selectedAt: Date.now()
  }
}

function normalizeRoute(value: string): 'main' | 'fast' | null {
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

function tryParseClassifierResult(
  value: string
): { taskType: AutoModelTaskType; route: 'main' | 'fast'; confidence: AutoModelConfidence } | null {
  try {
    const parsed = JSON.parse(value) as {
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

function shouldUseModeAwareRouting(mode: AppMode | undefined): mode is AppMode {
  return !!mode && MODE_AWARE_AUTO_ROUTING_MODES.has(mode)
}

function buildClassifierInput(options: {
  latestUserInput: string
  mode: AppMode
  allowTools: boolean
  isContinue?: boolean
}): string {
  return [
    `MODE=${options.mode}`,
    `ALLOW_TOOLS=${options.allowTools ? 'true' : 'false'}`,
    `IS_CONTINUE=${options.isContinue ? 'true' : 'false'}`,
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
  return model?.supportsFunctionCall !== false
}

function hasChatModeToolsAvailable(projectId?: string | null): boolean {
  if (useSettingsStore.getState().webSearchEnabled) return true
  return Object.keys(useMcpStore.getState().getActiveMcpTools(projectId)).length > 0
}

export function shouldAllowToolsForRequest(options: {
  latestUserInput: string
  mode?: AppMode
  isContinue?: boolean
  projectId?: string | null
}): boolean {
  if (options.isContinue) return true

  const input = options.latestUserInput.trim()
  if (!input) return false

  if (options.mode === 'chat') {
    return hasChatModeToolsAvailable(options.projectId)
  }

  const normalized = input.toLowerCase()

  const explicitToolPatterns = [
    /\b(read|open|inspect|search|find|grep|glob|list|ls)\b/,
    /\b(edit|modify|change|update|patch|refactor|rename|rewrite the file|implement|fix|debug)\b/,
    /\b(run|execute|test|build|lint|typecheck|compile|benchmark)\b/,
    /\b(file|files|folder|directory|repo|repository|codebase|project|terminal|command|shell|bash|powershell)\b/,
    /\b(tool|tools|agent|subagent|task|plan mode|plan)\b/,
    /[\u4e00-\u9fff](读取|打开|查看|搜索|查找|检索|列出|修改|编辑|更新|重构|重命名|实现|修复|调试|运行|执行|测试|构建|编译|代码|文件|目录|仓库|项目|终端|命令|工具|任务|计划)/
  ]

  return explicitToolPatterns.some((pattern) => pattern.test(normalized))
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

  if (!mainConfig) {
    return buildSelectionStatus({
      target: 'main',
      config: null,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'main_unavailable'
    })
  }

  if (!latestUserInput) {
    return buildSelectionStatus({
      target: 'main',
      config: mainConfig,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'empty_input'
    })
  }

  if (!fastConfig) {
    return buildSelectionStatus({
      target: 'main',
      config: mainConfig,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'fast_unavailable'
    })
  }

  if (allowTools && !getFastModelSupportsTools()) {
    return buildSelectionStatus({
      target: 'main',
      config: mainConfig,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'fast_model_tools_unsupported'
    })
  }

  if (fastConfig.requiresApiKey !== false && !fastConfig.apiKey) {
    return buildSelectionStatus({
      target: 'main',
      config: mainConfig,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'fast_auth_missing'
    })
  }

  if (fastConfig.providerId) {
    const fastReady = await ensureProviderAuthReady(fastConfig.providerId)
    if (!fastReady) {
      return buildSelectionStatus({
        target: 'main',
        config: mainConfig,
        mode,
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'fast_auth_unavailable'
      })
    }
  }

  const abortController = new AbortController()
  const abort = (): void => abortController.abort()
  const timeout = setTimeout(abort, 10000)
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const useModeAwareRouting = shouldUseModeAwareRouting(mode)
    const routingPrompt = useModeAwareRouting
      ? AUTO_MODEL_CLASSIFIER_PROMPT
      : AUTO_MODEL_LEGACY_SELECTOR_PROMPT
    const routingInput = useModeAwareRouting
      ? buildClassifierInput({
          latestUserInput,
          mode,
          allowTools,
          isContinue: options.isContinue
        })
      : latestUserInput.slice(0, 4000)
    const routingConfig = withAuxiliaryResponsesRequestPolicy(
      {
        ...fastConfig,
        maxTokens: useModeAwareRouting ? 64 : 8,
        temperature: 0,
        thinkingEnabled: false,
        systemPrompt: routingPrompt
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
      return buildSelectionStatus({
        target: 'main',
        config: mainConfig,
        mode,
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'sidecar_request_build_failed'
      })
    }

    const supportsAgentRun = await canSidecarHandle('agent.run')
    const supportsProvider = await canSidecarHandle(`provider.${routingConfig.type}`)
    if (!supportsAgentRun || !supportsProvider) {
      return buildSelectionStatus({
        target: 'main',
        config: mainConfig,
        mode,
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'sidecar_capability_unavailable'
      })
    }

    const initialized = await agentBridge.initialize()
    if (!initialized) {
      return buildSelectionStatus({
        target: 'main',
        config: mainConfig,
        mode,
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

        unsubscribe = agentBridge.on('agent/event', (payload) => {
          const record = normalizeSidecarRecord(payload)
          if (String(record.runId ?? '') !== result.runId) return
          const event = normalizeSidecarAgentEvent(record.event)
          if (!event) return

          if (event.type === 'text_delta' && event.text) {
            output += event.text
            if (useModeAwareRouting ? output.length >= 256 : output.length >= 32) {
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

    if (!useModeAwareRouting) {
      const target = normalizeRoute(normalizedOutput)
      if (!target) {
        return buildSelectionStatus({
          target: 'main',
          config: mainConfig,
          mode,
          toolsAllowed: allowTools,
          decisionSource: 'fallback-main',
          fallbackReason: 'invalid_classifier_output'
        })
      }

      return target === 'fast'
        ? buildSelectionStatus({
            target: 'fast',
            config: fastConfig,
            mode,
            toolsAllowed: allowTools,
            decisionSource: 'legacy-classifier'
          })
        : buildSelectionStatus({
            target: 'main',
            config: mainConfig,
            mode,
            toolsAllowed: allowTools,
            decisionSource: 'legacy-classifier'
          })
    }

    const parsed = tryParseClassifierResult(normalizedOutput)
    if (!parsed) {
      return buildSelectionStatus({
        target: 'main',
        config: mainConfig,
        mode,
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'invalid_classifier_output'
      })
    }

    if (allowTools && parsed.route === 'fast' && !getFastModelSupportsTools()) {
      return buildSelectionStatus({
        target: 'main',
        config: mainConfig,
        mode,
        taskType: parsed.taskType,
        confidence: parsed.confidence,
        toolsAllowed: allowTools,
        decisionSource: 'fallback-main',
        fallbackReason: 'fast_model_tools_unsupported'
      })
    }

    const lowConfidence = parsed.confidence === 'low'
    if (lowConfidence) {
      const previousHighConfidence = getLastHighConfidenceSelection(options.sessionId)
      if (previousHighConfidence) {
        return previousHighConfidence.target === 'fast'
          ? buildSelectionStatus({
              target: 'fast',
              config: fastConfig,
              mode,
              taskType: parsed.taskType,
              confidence: parsed.confidence,
              toolsAllowed: allowTools,
              decisionSource: 'fallback-last-high-confidence',
              fallbackReason: 'low_confidence_reuse_last_route'
            })
          : buildSelectionStatus({
              target: 'main',
              config: mainConfig,
              mode,
              taskType: parsed.taskType,
              confidence: parsed.confidence,
              toolsAllowed: allowTools,
              decisionSource: 'fallback-last-high-confidence',
              fallbackReason: 'low_confidence_reuse_last_route'
            })
      }
    }

    const target = lowConfidence ? 'fast' : parsed.route
    return target === 'fast'
      ? buildSelectionStatus({
          target: 'fast',
          config: fastConfig,
          mode,
          taskType: parsed.taskType,
          confidence: parsed.confidence,
          toolsAllowed: allowTools,
          decisionSource: lowConfidence ? 'fallback-fast' : 'classifier',
          ...(lowConfidence ? { fallbackReason: 'low_confidence_fast' } : {})
        })
      : buildSelectionStatus({
          target: 'main',
          config: mainConfig,
          mode,
          taskType: parsed.taskType,
          confidence: parsed.confidence,
          toolsAllowed: allowTools,
          decisionSource: 'classifier'
        })
  } catch {
    return buildSelectionStatus({
      target: 'main',
      config: mainConfig,
      mode,
      toolsAllowed: allowTools,
      decisionSource: 'fallback-main',
      fallbackReason: 'classification_failed'
    })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
