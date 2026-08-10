import React, { useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useApp } from 'ink'
import { AgentPanel } from './components/agent-panel.js'
import { AskUserPrompt } from './components/ask-user-prompt.js'
import { ConfigPanel } from './components/config-panel.js'
import { ModelConfigPanel } from './components/model-config-panel.js'
import { ModelPicker } from './components/model-picker.js'
import { PlanPanel } from './components/plan-panel.js'
import { PermissionPrompt } from './components/permission-prompt.js'
import { PromptInput } from './components/prompt-input.js'
import { StatusLine } from './components/status-line.js'
import { TaskList } from './components/task-list.js'
import { Transcript } from './components/transcript.js'
import { WelcomeCard } from './components/welcome-card.js'
import { useTerminalSize } from './hooks/use-terminal-size.js'
import { formatTokenCount, formatUsdCost } from './lib/metrics.js'
import { theme } from './theme.js'
import type {
  AgentRuntime,
  AgentOption,
  AskUserRequest,
  ConfigCatalog,
  ConfigSettingValue,
  ContextSnapshot,
  Message,
  ModelCatalog,
  ModelConfiguration,
  ModelConfigurationPatch,
  ModelSelection,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PlanApprovalMode,
  PlanSnapshot,
  RewindAction,
  RewindCheckpoint,
  RewindResult,
  UiEvent,
  TaskItem,
  TuiMode,
  UsageSnapshot
} from './types.js'

interface CliAppProps {
  cwd: string
  initialPermissionMode: PermissionMode
  initialPrompt: string
  runtime: AgentRuntime
  tuiMode: TuiMode
  version: string
}

const permissionModes: PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto']
const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

interface RuntimeMetrics {
  context: ContextSnapshot | null
  usage: UsageSnapshot | null
}

function readRuntimeMetrics(runtime: AgentRuntime): RuntimeMetrics {
  let context: ContextSnapshot | null = null
  let usage: UsageSnapshot | null = null
  try {
    context = runtime.getContextSnapshot?.() ?? null
  } catch {
    // Status metrics must never make the prompt unavailable when shared settings are being edited.
  }
  try {
    usage = runtime.getUsageSnapshot?.() ?? null
  } catch {
    // A missing usage projection is rendered explicitly instead of failing the terminal UI.
  }
  return { context, usage }
}

function nowTimestamp(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date())
}

export function CliApp({
  cwd,
  initialPermissionMode,
  initialPrompt,
  runtime,
  tuiMode,
  version
}: CliAppProps): React.JSX.Element {
  const { exit } = useApp()
  const { columns, rows } = useTerminalSize()
  const initialCatalogRef = useRef<ModelCatalog | null>(null)
  initialCatalogRef.current ??= runtime.getModelCatalog()
  const [messages, setMessages] = useState<Message[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [agents, setAgents] = useState<AgentOption[]>(() => runtime.getAgentCatalog())
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(initialCatalogRef.current)
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    initialCatalogRef.current.active
  )
  const [permissionMode, setPermissionMode] = useState(initialPermissionMode)
  const [effort, setEffort] = useState(() => {
    const active = initialCatalogRef.current?.active
    if (!active || !runtime.getModelConfiguration) return 'medium'
    try {
      return runtime.getModelConfiguration(active).reasoningEffort
    } catch {
      return 'medium'
    }
  })
  const [showHelp, setShowHelp] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [modelPickerPurpose, setModelPickerPurpose] = useState<'session' | 'compression' | null>(
    null
  )
  const [modelPickerReturnToConfig, setModelPickerReturnToConfig] = useState(false)
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfiguration | null>(null)
  const [modelConfigurationReturnToConfig, setModelConfigurationReturnToConfig] = useState(false)
  const [modelConfigurationSaving, setModelConfigurationSaving] = useState(false)
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [configCatalog, setConfigCatalog] = useState<ConfigCatalog | null>(null)
  const [configSavingKey, setConfigSavingKey] = useState<string>()
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const [askUserRequest, setAskUserRequest] = useState<AskUserRequest | null>(null)
  const [plan, setPlan] = useState<PlanSnapshot | null>(null)
  const [planActionPending, setPlanActionPending] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [activity, setActivity] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [transcriptEpoch, setTranscriptEpoch] = useState(0)
  const [runtimeMetrics, setRuntimeMetrics] = useState<RuntimeMetrics>(() =>
    readRuntimeMetrics(runtime)
  )
  const abortControllerRef = useRef<AbortController | undefined>(undefined)
  const noticeTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const messageIdRef = useRef(0)

  const contentWidth = Math.max(36, columns)
  const fullscreen = tuiMode === 'fullscreen'
  const maxVisibleMessages = Math.max(3, Math.floor((rows - 9) / (showDetails ? 4 : 2)))
  const firstMutableMessage = messages.findIndex(
    (message) =>
      (message.kind === 'assistant' && message.streaming) ||
      (message.kind === 'tool' && message.status === 'running')
  )
  const committedMessages = fullscreen
    ? []
    : messages.slice(0, firstMutableMessage < 0 ? messages.length : firstMutableMessage)
  const dynamicMessages = fullscreen
    ? messages.slice(-maxVisibleMessages)
    : messages.slice(firstMutableMessage < 0 ? messages.length : firstMutableMessage)

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const showNotice = (message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(undefined), 1_600)
  }

  const refreshRuntimeMetrics = (): void => {
    setRuntimeMetrics(readRuntimeMetrics(runtime))
  }

  const refreshConfigCatalog = (): ConfigCatalog | null => {
    const catalog = runtime.getConfigCatalog?.() ?? null
    setConfigCatalog(catalog)
    return catalog
  }

  const openModelPicker = (
    purpose: 'session' | 'compression' = 'session',
    returnToConfig = false
  ): void => {
    const catalog = runtime.getModelCatalog()
    const configuredCompressionModel =
      purpose === 'compression'
        ? (runtime.getConfigCatalog?.().compressionModel ?? null)
        : modelSelection
    const currentAvailable = configuredCompressionModel
      ? catalog.groups.some(
          (group) =>
            group.providerId === configuredCompressionModel.providerId &&
            group.models.some((option) => option.modelId === configuredCompressionModel.modelId)
        )
      : purpose === 'compression'
    const nextSelection = currentAvailable
      ? configuredCompressionModel
      : purpose === 'session'
        ? catalog.active
        : null
    setModelCatalog(catalog)
    if (purpose === 'session') setModelSelection(nextSelection)
    if (purpose === 'session' && nextSelection && !currentAvailable) {
      runtime.configure?.({
        model: nextSelection.modelId,
        providerId: nextSelection.providerId
      })
    }
    setModelPickerReturnToConfig(returnToConfig)
    setModelPickerPurpose(purpose)
  }

  const openConfig = (): void => {
    const catalog = refreshConfigCatalog()
    if (!catalog || !runtime.updateConfig) {
      showNotice('Configuration is unavailable in this runtime')
      return
    }
    setConfigOpen(true)
  }

  const openAgentPanel = (): void => {
    setAgents(runtime.getAgentCatalog())
    setAgentPanelOpen(true)
  }

  const appendSystem = (
    text: string,
    tone: Extract<Message, { kind: 'system' }>['tone'] = 'muted'
  ): void => {
    messageIdRef.current += 1
    setMessages((current) => [
      ...current,
      { id: `system-${Date.now()}-${messageIdRef.current}`, kind: 'system', text, tone }
    ])
  }

  const applyRuntimeEvent = (event: UiEvent): void => {
    if (event.type === 'turn.done') {
      refreshRuntimeMetrics()
      return
    }

    if (event.type === 'runtime.activity') {
      setActivity(event.activity === 'compressing' ? 'Compressing context…' : 'Working…')
      return
    }

    if (event.type === 'context-compression.start') {
      setActivity('Compressing context…')
      return
    }

    if (event.type === 'context-compression.done') {
      setActivity('Working…')
      appendSystem(
        event.summarizerFailed
          ? event.error ||
              'Context compression failed; the Native Worker preserved the original history.'
          : `Context compressed · ${event.originalCount} → ${event.newCount} messages${event.messagesSummarized === undefined ? '' : ` · ${event.messagesSummarized} summarized`}`,
        event.summarizerFailed ? 'warning' : 'success'
      )
      return
    }

    if (event.type === 'assistant.start') {
      setActivity('Working…')
      setMessages((current) => [
        ...current,
        {
          id: event.id,
          kind: 'assistant',
          model: event.model,
          streaming: true,
          text: '',
          timestamp: nowTimestamp()
        }
      ])
      return
    }

    if (event.type === 'assistant.delta') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'assistant'
            ? { ...message, text: message.text + event.text }
            : message
        )
      )
      return
    }

    if (event.type === 'assistant.thinking') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'assistant'
            ? { ...message, thinking: (message.thinking ?? '') + event.thinking }
            : message
        )
      )
      return
    }

    if (event.type === 'assistant.done') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'assistant'
            ? { ...message, streaming: false }
            : message
        )
      )
      return
    }

    if (event.type === 'tool.start') {
      setActivity('Working…')
      setMessages((current) => [
        ...current,
        {
          id: event.id,
          kind: 'tool',
          title: event.title,
          detail: event.detail,
          status: 'running'
        }
      ])
      return
    }

    if (event.type === 'tool.done') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'tool'
            ? { ...message, status: event.status, summary: event.summary }
            : message
        )
      )
      return
    }

    if (event.type === 'tool.update') {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.id && message.kind === 'tool'
            ? {
                ...message,
                ...(event.title ? { title: event.title } : {}),
                ...(event.detail ? { detail: event.detail } : {}),
                ...(event.summary ? { summary: event.summary } : {})
              }
            : message
        )
      )
      return
    }

    if (event.type === 'permission.request') {
      setPermissionRequest(event.request)
      return
    }

    if (event.type === 'permission.cancel') {
      setPermissionRequest((current) => (current?.id === event.requestId ? null : current))
      return
    }

    if (event.type === 'askUser.request') {
      setAskUserRequest(event.request)
      return
    }

    if (event.type === 'askUser.cancel') {
      setAskUserRequest((current) => (current?.id === event.requestId ? null : current))
      return
    }

    if (event.type === 'plan.update') {
      setPlan(event.plan)
      return
    }

    if (event.type === 'tasks.update') {
      setTasks(event.tasks)
      return
    }

    if (event.type === 'system') setMessages((current) => [...current, event.message])
  }

  const runPrompt = async (prompt: string): Promise<void> => {
    if (isRunning) {
      showNotice('A turn is already running · Esc to interrupt')
      return
    }

    setMessages((current) => [...current, { id: `user-${Date.now()}`, kind: 'user', text: prompt }])
    const controller = new AbortController()
    abortControllerRef.current = controller
    setIsRunning(true)
    setActivity('Working…')

    try {
      for await (const event of runtime.send(prompt, controller.signal)) {
        if (controller.signal.aborted) break
        applyRuntimeEvent(event)
      }
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      abortControllerRef.current = undefined
      refreshRuntimeMetrics()
      setIsRunning(false)
      setActivity(undefined)
    }
  }

  const runCompact = async (focusPrompt?: string): Promise<void> => {
    if (!runtime.compactContext) {
      appendSystem('Manual context compression is unavailable in this runtime.', 'warning')
      return
    }
    if (isRunning) {
      showNotice('A Worker operation is already running')
      return
    }

    const controller = new AbortController()
    abortControllerRef.current = controller
    setIsRunning(true)
    setActivity('Compressing context…')
    try {
      const result = await runtime.compactContext(focusPrompt, controller.signal)
      if (result.summarizerFailed) {
        appendSystem(
          result.error || 'Context compression failed; the original history was preserved.',
          'error'
        )
      } else if (!result.compressed) {
        appendSystem('No compressible context is available yet.', 'warning')
      } else {
        appendSystem(
          `Context compressed · ${result.originalCount} → ${result.newCount} messages${result.messagesSummarized === undefined ? '' : ` · ${result.messagesSummarized} summarized`}`,
          'success'
        )
      }
    } catch (error) {
      if (controller.signal.aborted) showNotice('Context compression interrupted')
      else appendSystem(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      abortControllerRef.current = undefined
      refreshRuntimeMetrics()
      setIsRunning(false)
      setActivity(undefined)
    }
  }

  const resetConversation = async (startNewSession: boolean): Promise<void> => {
    const operation = startNewSession ? runtime.newSession : runtime.clearContext
    if (!operation) {
      appendSystem(
        startNewSession
          ? 'Starting a new Worker session is unavailable in this runtime.'
          : 'Clearing canonical context is unavailable in this runtime.',
        'warning'
      )
      return
    }
    setIsRunning(true)
    setActivity(startNewSession ? 'Starting new session…' : 'Clearing context…')
    try {
      await operation.call(runtime)
      if (!fullscreen) process.stdout.write('\u001B[2J\u001B[3J\u001B[H')
      setMessages([])
      if (startNewSession) setTasks([])
      setPlan(null)
      if (startNewSession) setShowTasks(false)
      showNotice(startNewSession ? 'New Native Worker session ready' : 'Canonical context cleared')
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      refreshRuntimeMetrics()
      setIsRunning(false)
      setActivity(undefined)
    }
  }

  const runDoctor = async (): Promise<void> => {
    if (!runtime.doctor) {
      appendSystem('Native Worker diagnostics are unavailable in this runtime.', 'warning')
      return
    }
    setIsRunning(true)
    setActivity('Checking Native Worker…')
    try {
      const result = await runtime.doctor()
      appendSystem(
        [
          `Native Worker ready · ${result.runtime} ${result.runtimeVersion}`,
          `IPC v${result.protocolVersion} · Agent v${result.agentProtocolVersion} · ${result.routeCount} routes`,
          `PID ${result.pid} · ${result.configuredModel}`,
          result.executable
        ].join('\n'),
        'success'
      )
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      refreshRuntimeMetrics()
      setIsRunning(false)
      setActivity(undefined)
    }
  }

  const updateConfigValue = (key: string, value: ConfigSettingValue): void => {
    if (!runtime.updateConfig || configSavingKey) return
    setConfigSavingKey(key)
    void runtime
      .updateConfig(key, value)
      .then(() => {
        refreshConfigCatalog()
        refreshRuntimeMetrics()
        showNotice('Configuration saved to OpenCowork')
      })
      .catch((error) =>
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
      )
      .finally(() => setConfigSavingKey(undefined))
  }

  const readContextSnapshot = (): ContextSnapshot | null => {
    try {
      return runtime.getContextSnapshot?.() ?? null
    } catch {
      return null
    }
  }

  const listRewindCheckpoints = async (): Promise<RewindCheckpoint[]> => {
    if (!runtime.listRewindCheckpoints) {
      throw new Error('Rewind checkpoints are unavailable in this runtime.')
    }
    return runtime.listRewindCheckpoints()
  }

  const runRewind = async (
    checkpointId: string,
    action: RewindAction,
    instructions: string | undefined,
    signal: AbortSignal
  ): Promise<RewindResult> => {
    if (!runtime.rewind) throw new Error('Rewind is unavailable in this runtime.')
    if (isRunning) throw new Error('Wait for the active Worker operation before rewinding.')

    const changesConversation =
      action === 'restore-code-and-conversation' ||
      action === 'restore-conversation' ||
      action === 'summarize-from' ||
      action === 'summarize-up-to'
    setIsRunning(true)
    setActivity(
      action === 'summarize-from' || action === 'summarize-up-to'
        ? 'Summarizing conversation…'
        : action === 'restore-code'
          ? 'Restoring code…'
          : action === 'restore-code-and-conversation'
            ? 'Restoring code and conversation…'
            : 'Restoring conversation…'
    )

    try {
      const result = await runtime.rewind(checkpointId, action, instructions, signal)
      if (changesConversation) {
        if (!fullscreen) process.stdout.write('\u001B[2J\u001B[3J\u001B[H')
        setTranscriptEpoch((current) => current + 1)
        setMessages(() => {
          if (!result.summarized) return result.transcript
          const marker: Message = {
            id: `rewind-summary-${Date.now()}`,
            kind: 'system',
            text:
              result.action === 'summarize-from'
                ? 'Summarized conversation from this checkpoint.'
                : 'Summarized conversation up to this checkpoint.',
            tone: 'success'
          }
          return [...result.transcript, marker]
        })
      }

      if (result.conversationForked) {
        setTasks([])
        setPlan(null)
        setShowTasks(false)
      }
      if (result.failedFiles.length > 0) {
        appendSystem(
          `Rewind completed with ${result.failedFiles.length} skipped file${result.failedFiles.length === 1 ? '' : 's'}:\n${result.failedFiles.join('\n')}`,
          'warning'
        )
      } else if (result.action === 'restore-code') {
        appendSystem(
          `Restored ${result.restoredFileCount} tracked file${result.restoredFileCount === 1 ? '' : 's'}; conversation unchanged.`,
          'success'
        )
      }

      showNotice(
        result.summarized
          ? 'Conversation summarized'
          : result.conversationForked
            ? `Conversation forked${result.restoredFileCount > 0 ? ` · ${result.restoredFileCount} files restored` : ''}`
            : `${result.restoredFileCount} tracked file${result.restoredFileCount === 1 ? '' : 's'} restored`
      )
      return result
    } finally {
      setIsRunning(false)
      setActivity(undefined)
    }
  }

  const handleCommand = (submission: string): boolean => {
    const [rawName, ...args] = submission.trim().split(/\s+/u)
    const name = rawName?.toLowerCase()

    if (name === '/clear' || name === '/new') {
      void resetConversation(name === '/new')
      return true
    }
    if (name === '/help') {
      setShowHelp((current) => !current)
      return true
    }
    if (name === '/model') {
      openModelPicker()
      return true
    }
    if (name === '/config') {
      openConfig()
      return true
    }
    if (name === '/compact') {
      void runCompact(args.join(' ') || undefined)
      return true
    }
    if (name === '/agents') {
      openAgentPanel()
      return true
    }
    if (name === '/permissions') {
      const requested = args[0] as PermissionMode | undefined
      if (requested && permissionModes.includes(requested)) {
        setPermissionMode(requested)
        runtime.configure?.({ permissionMode: requested })
        appendSystem(`Permission mode set to ${requested}.`, 'success')
      } else if (requested) {
        appendSystem('Usage: /permissions manual|acceptEdits|plan|auto', 'warning')
      } else {
        appendSystem(
          `${permissionMode} permission mode is active. Use /permissions manual|acceptEdits|plan|auto to change it.`
        )
      }
      return true
    }
    if (name === '/context') {
      const snapshot = readContextSnapshot()
      if (!snapshot) {
        appendSystem('Context statistics are unavailable in this runtime.', 'warning')
      } else {
        const usage =
          snapshot.contextLength > 0
            ? `${formatTokenCount(snapshot.estimatedTokens)} / ${formatTokenCount(snapshot.contextLength)}`
            : `${formatTokenCount(snapshot.estimatedTokens)} tokens`
        const ratio =
          snapshot.contextLength > 0
            ? ` · ${Math.round((snapshot.estimatedTokens / snapshot.contextLength) * 100)}%`
            : ''
        appendSystem(
          `Context · ${usage}${ratio}\n${snapshot.messageCount} canonical messages · auto-compact ${snapshot.compressionEnabled ? `at ${formatTokenCount(snapshot.triggerTokens)}` : 'off'}`,
          'success'
        )
      }
      return true
    }
    if (name === '/cost') {
      const usage = runtime.getUsageSnapshot?.()
      if (!usage) {
        appendSystem('Usage statistics are unavailable in this runtime.', 'warning')
      } else {
        const cost =
          usage.estimatedCostUsd === null
            ? 'pricing unavailable'
            : formatUsdCost(usage.estimatedCostUsd)
        appendSystem(
          `Usage · ${usage.requestCount} requests · ${formatTokenCount(usage.inputTokens)} input · ${formatTokenCount(usage.outputTokens)} output\nBillable input ${formatTokenCount(usage.billableInputTokens)} · cache read ${formatTokenCount(usage.cacheReadTokens)} · reasoning ${formatTokenCount(usage.reasoningTokens)}\nEstimated cost ${cost} · ${usage.model}`,
          'success'
        )
      }
      return true
    }
    if (name === '/doctor') {
      void runDoctor()
      return true
    }
    if (name === '/tasks') {
      setShowTasks((current) => !current)
      return true
    }
    if (name === '/plan') {
      setPermissionMode('plan')
      runtime.configure?.({ permissionMode: 'plan' })
      showNotice('Plan mode enabled')
      return true
    }
    if (name === '/codegraph') {
      if (!runtime.getCodeGraphStatus) {
        appendSystem('CodeGraph status is unavailable in this runtime.', 'warning')
        return true
      }
      void runtime
        .getCodeGraphStatus()
        .then((status) => {
          const catalog = status.toolNames.length > 0 ? ` · ${status.toolNames.join(', ')}` : ''
          appendSystem(
            `${status.message} · ${status.indexed ? 'indexed' : 'not indexed'}${catalog}`,
            status.enabled ? (status.indexed ? 'success' : 'warning') : 'muted'
          )
        })
        .catch((error) =>
          appendSystem(error instanceof Error ? error.message : String(error), 'error')
        )
      return true
    }
    if (name === '/effort') {
      const requested = args[0]
      let availableLevels = effortLevels
      if (modelSelection && runtime.getModelConfiguration) {
        try {
          const configured = runtime.getModelConfiguration(modelSelection).reasoningEffortLevels
          if (configured.length > 0) availableLevels = configured
        } catch {
          // Keep the generic effort list if the provider store changes while the CLI is open.
        }
      }
      const requestedIndex = requested ? availableLevels.indexOf(requested) : -1
      if (requested && requestedIndex < 0) {
        appendSystem(`Usage: /effort ${availableLevels.join('|')}`, 'warning')
        return true
      }
      const currentIndex = Math.max(0, availableLevels.indexOf(effort))
      const nextEffort =
        availableLevels[
          requestedIndex >= 0 ? requestedIndex : (currentIndex + 1) % availableLevels.length
        ] ?? 'medium'
      setEffort(nextEffort)
      runtime.configure?.({ effort: nextEffort })
      return true
    }
    if (name === '/status') {
      const modelStatus = modelSelection
        ? `${modelSelection.providerName} / ${modelSelection.modelName}`
        : 'No configured model'
      appendSystem(
        `${modelStatus} · ${effort} effort · ${permissionMode} permissions · ${tuiMode} renderer`,
        'success'
      )
      return true
    }
    if (name === '/tui') {
      const target = args[0]
      if (target && target !== 'classic' && target !== 'fullscreen') {
        appendSystem('Usage: /tui classic|fullscreen', 'warning')
        return true
      }
      appendSystem(
        target && target !== tuiMode
          ? `Restart with --tui ${target} to switch renderers without losing shell state.`
          : `The ${tuiMode} renderer is active.`
      )
      return true
    }
    if (name === '/exit') {
      exit()
      return true
    }

    return false
  }

  const handleSubmit = (submission: string): void => {
    setShowHelp(false)
    if (submission.trimStart().startsWith('/')) {
      if (handleCommand(submission)) return
      const commandName = submission.trim().split(/\s+/u)[0] ?? submission.trim()
      appendSystem(`Unknown CLI command: ${commandName}`, 'warning')
      return
    }
    void runPrompt(submission)
  }

  const handlePermissionDecision = (decision: PermissionDecision): void => {
    const request = permissionRequest
    if (!request) return
    setPermissionRequest(null)
    const labels: Record<PermissionDecision, string> = {
      allow_once: 'Allowed once',
      allow_session: 'Allowed for this session',
      deny: 'Denied'
    }
    appendSystem(
      `${labels[decision]} · ${request.tool}: ${request.title}`,
      decision === 'deny' ? 'warning' : 'success'
    )
    void runtime.respondToPermission?.(request.id, decision)
  }

  const handleAskUserSubmit = (
    payload: Parameters<NonNullable<AgentRuntime['respondToAskUser']>>[1]
  ): void => {
    const request = askUserRequest
    if (!request) return
    setAskUserRequest(null)
    appendSystem('Answers submitted to the Native Worker.', 'success')
    void runtime.respondToAskUser?.(request.id, payload)
  }

  const handleAskUserCancel = (): void => {
    setAskUserRequest(null)
    abortControllerRef.current?.abort()
    showNotice('AskUserQuestion cancelled · turn interrupted')
  }

  const handlePlanApprove = (mode: PlanApprovalMode): void => {
    const currentPlan = plan
    if (!currentPlan || !runtime.approvePlan || planActionPending) return
    setPlanActionPending(true)
    void runtime
      .approvePlan(currentPlan, mode)
      .then(() => {
        setPlan({ ...currentPlan, status: 'implementing', updatedAt: Date.now() })
        const nextMode: PermissionMode = mode === 'auto' ? 'auto' : mode
        setPermissionMode(nextMode)
        runtime.configure?.({ permissionMode: nextMode })
        appendSystem('Plan approved · starting implementation in the Native Worker.', 'success')
        void runPrompt('Implement the approved plan.')
      })
      .catch((error) =>
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
      )
      .finally(() => setPlanActionPending(false))
  }

  const handlePlanRevise = (feedback: string): void => {
    const currentPlan = plan
    if (!currentPlan || !runtime.revisePlan || planActionPending) return
    setPlanActionPending(true)
    void runtime
      .revisePlan(currentPlan, feedback)
      .then(() => {
        setPlan({ ...currentPlan, status: 'drafting', content: undefined, updatedAt: Date.now() })
        setPermissionMode('plan')
        runtime.configure?.({ permissionMode: 'plan' })
        appendSystem('Plan revision requested · returning to planning.', 'muted')
        void runPrompt(feedback)
      })
      .catch((error) =>
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
      )
      .finally(() => setPlanActionPending(false))
  }

  const cyclePermissionMode = (): void => {
    setPermissionMode((current) => {
      const index = permissionModes.indexOf(current)
      const next = permissionModes[(index + 1) % permissionModes.length] ?? 'manual'
      runtime.configure?.({ permissionMode: next })
      return next
    })
  }

  const closeModelPicker = (): void => {
    setModelPickerPurpose(null)
    if (modelPickerReturnToConfig) setConfigOpen(true)
    setModelPickerReturnToConfig(false)
  }

  const persistSelectedModel = (selection: ModelSelection): void => {
    if (runtime.selectModel) {
      runtime.selectModel(selection)
    } else {
      runtime.configure?.({ model: selection.modelId, providerId: selection.providerId })
    }
    setModelSelection(selection)
    setModelCatalog(runtime.getModelCatalog())
    refreshConfigCatalog()
    refreshRuntimeMetrics()
  }

  const beginModelConfiguration = (selection: ModelSelection): void => {
    if (!runtime.getModelConfiguration) {
      try {
        persistSelectedModel(selection)
        closeModelPicker()
        showNotice(`Model switched to ${selection.providerName} / ${selection.modelName}`)
      } catch (error) {
        appendSystem(
          `Failed to persist model selection: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      }
      return
    }

    try {
      const configuration = runtime.getModelConfiguration(selection)
      setModelConfiguration(configuration)
      setModelConfigurationReturnToConfig(modelPickerReturnToConfig)
      setModelPickerReturnToConfig(false)
      setModelPickerPurpose(null)
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const cancelModelConfiguration = (): void => {
    const returnToConfig = modelConfigurationReturnToConfig
    setModelConfiguration(null)
    setModelConfigurationReturnToConfig(false)
    setModelPickerReturnToConfig(returnToConfig)
    setModelPickerPurpose('session')
  }

  const applyModelConfiguration = (patch: ModelConfigurationPatch): void => {
    const configuration = modelConfiguration
    if (!configuration || modelConfigurationSaving) return
    setModelConfigurationSaving(true)
    const save = runtime.configureModel
      ? runtime.configureModel(configuration.selection, patch)
      : Promise.resolve()
    void save
      .then(() => {
        persistSelectedModel(configuration.selection)
        setEffort(patch.reasoningEffort ?? configuration.reasoningEffort)
        runtime.configure?.({ effort: patch.reasoningEffort ?? configuration.reasoningEffort })
        setModelConfiguration(null)
        if (modelConfigurationReturnToConfig) setConfigOpen(true)
        setModelConfigurationReturnToConfig(false)
        showNotice(
          `Model switched to ${configuration.selection.providerName} / ${configuration.selection.modelName} · configuration saved`
        )
      })
      .catch((error) =>
        appendSystem(
          `Failed to save model configuration: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      )
      .finally(() => setModelConfigurationSaving(false))
  }

  const saveCompressionModel = (selection: ModelSelection | null): void => {
    if (!runtime.selectCompressionModel) {
      closeModelPicker()
      appendSystem('Compression model selection is unavailable in this runtime.', 'warning')
      return
    }
    setModelPickerPurpose(null)
    if (modelPickerReturnToConfig) setConfigOpen(true)
    setModelPickerReturnToConfig(false)
    setConfigSavingKey('contextCompressionModel')
    void runtime
      .selectCompressionModel(selection)
      .then(() => {
        refreshConfigCatalog()
        showNotice(
          selection
            ? `Compression model set to ${selection.providerName} / ${selection.modelName}`
            : 'Compression model follows the current session model'
        )
      })
      .catch((error) =>
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
      )
      .finally(() => setConfigSavingKey(undefined))
  }

  const planOverlay = Boolean(
    plan && (plan.status === 'drafting' || plan.status === 'awaiting_review')
  )
  const inputActive =
    !askUserRequest &&
    !planOverlay &&
    !permissionRequest &&
    !modelConfiguration &&
    !modelPickerPurpose &&
    !agentPanelOpen &&
    !configOpen
  const hasTranscript = messages.length > 0

  return (
    <>
      {!fullscreen && committedMessages.length > 0 ? (
        <Static items={committedMessages} key={transcriptEpoch}>
          {(message) => (
            <Transcript
              key={message.id}
              messages={[message]}
              showDetails={showDetails}
              width={contentWidth}
            />
          )}
        </Static>
      ) : null}
      <Box
        flexDirection="column"
        height={fullscreen ? rows : undefined}
        justifyContent={fullscreen ? 'space-between' : 'flex-start'}
        width={contentWidth}
      >
        <Box flexDirection="column" flexGrow={fullscreen ? 1 : 0}>
          {agentPanelOpen ? null : !hasTranscript ? (
            <WelcomeCard
              cwd={cwd}
              model={modelSelection?.modelName ?? 'No model configured'}
              version={version}
              width={contentWidth}
            />
          ) : dynamicMessages.length > 0 ? (
            <Transcript messages={dynamicMessages} showDetails={showDetails} width={contentWidth} />
          ) : null}
        </Box>

        <Box flexDirection="column" flexShrink={0}>
          {showTasks &&
          !askUserRequest &&
          !planOverlay &&
          !permissionRequest &&
          !modelConfiguration &&
          !modelPickerPurpose &&
          !agentPanelOpen &&
          !configOpen ? (
            <TaskList tasks={tasks} width={contentWidth} />
          ) : null}

          {askUserRequest ? (
            <AskUserPrompt
              onCancel={handleAskUserCancel}
              onNotice={showNotice}
              onSubmit={handleAskUserSubmit}
              request={askUserRequest}
              width={contentWidth}
            />
          ) : planOverlay && plan ? (
            <PlanPanel
              isRunning={isRunning || planActionPending}
              maxVisibleLines={Math.max(5, Math.min(16, rows - 14))}
              onAbort={() => {
                abortControllerRef.current?.abort()
                showNotice('Interrupted')
              }}
              onApprove={handlePlanApprove}
              onNotice={showNotice}
              onRevise={handlePlanRevise}
              plan={plan}
              width={contentWidth}
            />
          ) : permissionRequest ? (
            <PermissionPrompt
              onDecision={handlePermissionDecision}
              request={permissionRequest}
              width={contentWidth}
            />
          ) : modelConfiguration ? (
            <ModelConfigPanel
              configuration={modelConfiguration}
              maxVisible={Math.max(6, Math.min(12, rows - 13))}
              onApply={applyModelConfiguration}
              onCancel={cancelModelConfiguration}
              saving={modelConfigurationSaving}
              width={contentWidth}
            />
          ) : modelPickerPurpose ? (
            <ModelPicker
              catalog={modelCatalog}
              current={
                modelPickerPurpose === 'compression'
                  ? (configCatalog?.compressionModel ?? null)
                  : modelSelection
              }
              heading={
                modelPickerPurpose === 'compression'
                  ? 'Select compression model'
                  : 'Select model · Step 1 of 2'
              }
              maxVisible={Math.max(4, Math.min(12, rows - 12))}
              onCancel={closeModelPicker}
              onSelect={(nextModel) => {
                if (modelPickerPurpose === 'compression') {
                  saveCompressionModel(nextModel)
                  return
                }
                beginModelConfiguration(nextModel)
              }}
              onUseCurrent={
                modelPickerPurpose === 'compression' ? () => saveCompressionModel(null) : undefined
              }
              summary={
                modelPickerPurpose === 'compression'
                  ? 'Use any enabled model from a connected provider, or follow the current session model'
                  : undefined
              }
              width={contentWidth}
            />
          ) : configOpen && configCatalog ? (
            <ConfigPanel
              catalog={configCatalog}
              maxVisible={Math.max(5, Math.min(11, rows - 13))}
              onCancel={() => setConfigOpen(false)}
              onChange={updateConfigValue}
              onOpenCompressionModel={() => {
                setConfigOpen(false)
                openModelPicker('compression', true)
              }}
              onOpenModel={() => {
                setConfigOpen(false)
                openModelPicker('session', true)
              }}
              savingKey={configSavingKey}
              width={contentWidth}
            />
          ) : agentPanelOpen ? (
            <AgentPanel
              agents={agents}
              maxVisible={Math.max(3, Math.min(8, rows - 11))}
              onCancel={() => setAgentPanelOpen(false)}
              width={contentWidth}
            />
          ) : (
            <PromptInput
              active={inputActive}
              initialValue={initialPrompt}
              isRunning={isRunning}
              onAbort={() => {
                abortControllerRef.current?.abort()
                showNotice('Interrupted')
              }}
              onCycleMode={cyclePermissionMode}
              onExit={exit}
              onListRewindCheckpoints={listRewindCheckpoints}
              onNotice={showNotice}
              onOpenAgents={openAgentPanel}
              onOpenModel={openModelPicker}
              onRewind={runRewind}
              onSubmit={handleSubmit}
              onToggleDetails={() => setShowDetails((current) => !current)}
              onToggleHelp={() => setShowHelp((current) => !current)}
              onToggleTasks={() => setShowTasks((current) => !current)}
              showHelp={showHelp}
              width={contentWidth}
            />
          )}

          <StatusLine
            activity={activity}
            context={runtimeMetrics.context}
            effort={effort}
            model={modelSelection?.modelName ?? 'No model'}
            mode={permissionMode}
            notice={notice}
            usage={runtimeMetrics.usage}
            width={contentWidth}
          />
          {fullscreen ? <Text color={theme.dim}> </Text> : null}
        </Box>
      </Box>
    </>
  )
}
