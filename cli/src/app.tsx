import { spawn } from 'node:child_process'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useApp, useInput } from 'ink'
import { AgentPanel } from './components/agent-panel.js'
import { AskUserPrompt } from './components/ask-user-prompt.js'
import { ConfigPanel } from './components/config-panel.js'
import { EffortPanel } from './components/effort-panel.js'
import { ModelConfigPanel } from './components/model-config-panel.js'
import { ModelPicker } from './components/model-picker.js'
import { PlanPanel } from './components/plan-panel.js'
import { PermissionPrompt } from './components/permission-prompt.js'
import { PromptInput } from './components/prompt-input.js'
import { ProviderSetupPanel } from './components/provider-setup-panel.js'
import { ResumePanel } from './components/resume-panel.js'
import { StatusLine } from './components/status-line.js'
import { TaskList } from './components/task-list.js'
import { Transcript } from './components/transcript.js'
import { pickSpinnerVerb, TurnStatusLine } from './components/turn-status-line.js'
import { WelcomeCard } from './components/welcome-card.js'
import { useTerminalSize } from './hooks/use-terminal-size.js'
import { t } from './i18n.js'
import { appendAssistantSegment, finalizeAssistantSegments } from './lib/assistant-content.js'
import { computeTranscriptWindow, estimateChromeLines } from './lib/message-height.js'
import { formatTokenCount, formatUsdCost } from './lib/metrics.js'
import {
  formatThinkingNotice,
  formatThinkingStatus,
  parseThinkingIntensity,
  thinkingIntensityPatch,
  thinkingIntensityUsage
} from './lib/thinking-intensity.js'
import {
  containsMouseSequence,
  isLeftClickPress,
  parseMouseEvents,
  wheelDelta
} from './terminal/mouse.js'
import { theme } from './theme.js'
import { checkForUpdate } from './update.js'
import type {
  AgentRuntime,
  AgentOption,
  AskUserRequest,
  ConfigCatalog,
  ConfigSettingValue,
  ContextSnapshot,
  FileReferenceCandidate,
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
  PromptImageAttachment,
  PromptReference,
  ProviderSetupCatalog,
  ProviderSetupInput,
  RewindAction,
  RewindCheckpoint,
  RewindResult,
  ResumeResult,
  ResumeSessionSummary,
  UiEvent,
  TaskItem,
  TuiMode,
  TurnStatusSnapshot,
  UsageSnapshot
} from './types.js'

interface CliAppProps {
  cwd: string
  initialPermissionMode: PermissionMode
  initialPrompt: string
  /** Session restored by --continue / --resume before the UI mounted. */
  initialResume?: ResumeResult
  onRequestRedraw(): void
  runtime: AgentRuntime
  tuiMode: TuiMode
  version: string
}

const permissionModes: PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto']

const initWorkspacePrompt = `OpenCowork /init workflow: initialize this workspace's root AGENTS.md.

First inspect the repository with read-only tools. Determine the project structure, commands used for validation, conventions, and any existing root AGENTS.md guidance. Do not write or edit any file while inspecting.

Then draft the complete resulting root AGENTS.md. Preserve useful existing guidance rather than replacing it blindly. Keep the file concise, specific to this workspace, and focused on instructions that help future coding agents.

Before making any file change, call AskUserQuestion with exactly two single-select options: "Create or update AGENTS.md" and "Cancel". Put the full proposed AGENTS.md content in the create/update option's preview. If the user cancels, make no changes. If the user confirms create/update, use the Worker-owned Write or Edit tool to create or update only the root AGENTS.md, then report the resulting action and any validation performed. Never write outside this workspace root.`

function permissionModeNotice(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return t('cli.statuses.acceptEditsOn', 'Accept edits mode on ? Shift+Tab to cycle')
    case 'plan':
      return t(
        'cli.statuses.planOn',
        'Plan mode on ? implementation waits for your approval ? Shift+Tab to cycle'
      )
    case 'auto':
      return t(
        'cli.statuses.autoOn',
        'Auto mode on ? tools may run without confirmation ? Shift+Tab to cycle'
      )
    default:
      return t('cli.statuses.manualOn', 'Manual approval mode ? Shift+Tab to cycle')
  }
}

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

function isActiveThinkingMessage(message: Message): boolean {
  if (message.kind !== 'assistant' || !message.streaming) return false
  const segments = message.segments ?? []
  if (segments.length === 0) return !message.text
  return segments.at(-1)?.kind === 'thinking'
}

/**
 * Update one message located by ID without mapping the whole transcript. Streaming targets
 * live at the tail, so the reverse scan finds them in O(1) during a turn; the shallow array
 * copy is the only per-delta O(n) cost left.
 */
function updateMessageById<K extends Message['kind']>(
  current: Message[],
  id: string,
  kind: K,
  update: (message: Extract<Message, { kind: K }>) => Message
): Message[] {
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const message = current[index]
    if (message && message.id === id && message.kind === kind) {
      const next = current.slice()
      next[index] = update(message as Extract<Message, { kind: K }>)
      return next
    }
  }
  return current
}

/** Stream deltas may be coalesced and applied on a frame budget instead of per event. */
function isCoalescibleEvent(event: UiEvent): boolean {
  return (
    event.type === 'assistant.delta' ||
    event.type === 'assistant.thinking' ||
    event.type === 'tool.update'
  )
}

const STREAM_FLUSH_INTERVAL_MS = 33

export function CliApp({
  cwd,
  initialPermissionMode,
  initialPrompt,
  initialResume,
  onRequestRedraw,
  runtime,
  tuiMode,
  version
}: CliAppProps): React.JSX.Element {
  const { exit } = useApp()
  const { columns, revision: terminalRevision, rows } = useTerminalSize()
  const initialCatalogRef = useRef<ModelCatalog | null>(null)
  initialCatalogRef.current ??= runtime.getModelCatalog()
  const [messages, setMessages] = useState<Message[]>(() => {
    if (!initialResume) return []
    const banner: Message[] = [
      {
        id: 'startup-resume',
        kind: 'system',
        text: t('cli.runtime.resumedSession', 'Resumed session · {{count}} canonical messages', {
          count: initialResume.session.messageCount
        }),
        tone: 'success'
      }
    ]
    if (initialResume.warning) {
      banner.push({
        id: 'startup-resume-warning',
        kind: 'system',
        text: initialResume.warning,
        tone: 'warning'
      })
    }
    return [...initialResume.transcript, ...banner]
  })
  const [promptImages, setPromptImages] = useState<PromptImageAttachment[]>([])
  const [promptReferences, setPromptReferences] = useState<PromptReference[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [agents, setAgents] = useState<AgentOption[]>(() => runtime.getAgentCatalog())
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(initialCatalogRef.current)
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    initialResume ? initialResume.modelSelection : initialCatalogRef.current.active
  )
  const [permissionMode, setPermissionMode] = useState(initialPermissionMode)
  const initialModelConfigurationRef = useRef<ModelConfiguration | null | undefined>(undefined)
  if (initialModelConfigurationRef.current === undefined) {
    const active = initialCatalogRef.current?.active
    if (!active || !runtime.getModelConfiguration) {
      initialModelConfigurationRef.current = null
    } else {
      try {
        initialModelConfigurationRef.current = runtime.getModelConfiguration(active)
      } catch {
        initialModelConfigurationRef.current = null
      }
    }
  }
  const [effort, setEffort] = useState(
    initialModelConfigurationRef.current?.reasoningEffort ?? 'medium'
  )
  const [availableEffortLevels, setAvailableEffortLevels] = useState(
    initialModelConfigurationRef.current?.reasoningEffortLevels ?? []
  )
  const [supportsThinking, setSupportsThinking] = useState(
    initialModelConfigurationRef.current?.supportsThinking ?? false
  )
  const [thinkingEnabled, setThinkingEnabled] = useState(
    initialModelConfigurationRef.current?.thinkingEnabled ?? false
  )
  const [showHelp, setShowHelp] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  // Fullscreen scroll lock: index of the bottom-most visible message, null follows the tail.
  const [scrollAnchor, setScrollAnchor] = useState<number | null>(null)
  const [expandedMessageIds, setExpandedMessageIds] = useState<ReadonlySet<string>>(() => new Set())
  const [modelPickerPurpose, setModelPickerPurpose] = useState<'session' | 'compression' | null>(
    null
  )
  const [modelPickerReturnToConfig, setModelPickerReturnToConfig] = useState(false)
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfiguration | null>(null)
  const [modelConfigurationReturnToConfig, setModelConfigurationReturnToConfig] = useState(false)
  const [modelConfigurationSaving, setModelConfigurationSaving] = useState(false)
  const [effortConfiguration, setEffortConfiguration] = useState<ModelConfiguration | null>(null)
  const [effortSaving, setEffortSaving] = useState(false)
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [providerSetupCatalog, setProviderSetupCatalog] = useState<ProviderSetupCatalog | null>(
    null
  )
  const [providerSetupReturnToConfig, setProviderSetupReturnToConfig] = useState(false)
  const [providerSetupOnboarding, setProviderSetupOnboarding] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [configCatalog, setConfigCatalog] = useState<ConfigCatalog | null>(null)
  const [configSavingKey, setConfigSavingKey] = useState<string>()
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const [askUserRequest, setAskUserRequest] = useState<AskUserRequest | null>(null)
  const [plan, setPlan] = useState<PlanSnapshot | null>(null)
  const [planActionPending, setPlanActionPending] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [activity, setActivity] = useState<string>()
  const [turnStatus, setTurnStatus] = useState<TurnStatusSnapshot | null>(null)
  const [notice, setNotice] = useState<string>()
  const [transcriptEpoch, setTranscriptEpoch] = useState(0)
  const [runtimeMetrics, setRuntimeMetrics] = useState<RuntimeMetrics>(() =>
    readRuntimeMetrics(runtime)
  )
  const abortControllerRef = useRef<AbortController | undefined>(undefined)
  const noticeTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const messageIdRef = useRef(0)
  const terminalRevisionRef = useRef(terminalRevision)

  const contentWidth = Math.max(35, columns - 1)
  const fullscreen = tuiMode === 'fullscreen'
  // Ink falls back to ansiEscapes.clearTerminal when its dynamic output occupies at least
  // stdout.rows. Reserve one terminal row so a streaming fullscreen frame always stays below
  // that threshold; otherwise every spinner/token update can become a whole-screen flash.
  const frameRows = fullscreen ? Math.max(1, rows - 1) : rows
  const selectedModelOption = modelSelection
    ? modelCatalog.groups
        .flatMap((group) => group.models)
        .find(
          (option) =>
            option.providerId === modelSelection.providerId &&
            option.modelId === modelSelection.modelId
        )
    : undefined
  const supportsVision = selectedModelOption?.supportsVision === true
  const firstMutableMessage = messages.findIndex(
    (message) =>
      (message.kind === 'assistant' && message.streaming) ||
      (message.kind === 'tool' && message.status === 'running')
  )
  const committedMessages = fullscreen
    ? []
    : messages.slice(0, firstMutableMessage < 0 ? messages.length : firstMutableMessage)
  // Window by estimated per-message line heights, reserving bottom chrome (turn status,
  // prompt, status line). Classic also windows its dynamic frame: Ink redraws that tree
  // every spinner tick, and letting it grow past the terminal height causes flicker/OOM.
  const bottomOverlayOpen = Boolean(
    askUserRequest ||
    permissionRequest ||
    effortConfiguration ||
    modelConfiguration ||
    modelPickerPurpose ||
    providerSetupCatalog ||
    resumeOpen ||
    agentPanelOpen ||
    configOpen ||
    (permissionMode === 'plan' && plan)
  )
  const chromeLines = estimateChromeLines({
    hasTurnStatus: Boolean(turnStatus),
    overlayOpen: bottomOverlayOpen,
    scrollLocked: fullscreen && scrollAnchor !== null
  })
  const transcriptBudget = Math.max(3, frameRows - chromeLines)
  const windowSource =
    fullscreen || firstMutableMessage < 0 ? messages : messages.slice(firstMutableMessage)
  const windowArgs = {
    anchorIndex: fullscreen ? scrollAnchor : null,
    expandedIds: expandedMessageIds,
    messages: windowSource,
    showDetails,
    width: contentWidth
  }
  const preliminaryWindow = computeTranscriptWindow({
    ...windowArgs,
    budgetLines: transcriptBudget
  })
  // Classic live truncation shows a one-line hint inside the same budget; recompute so the
  // hint cannot push the frame one row past the terminal and reintroduce flicker.
  const classicNeedsTruncationHint =
    !fullscreen && firstMutableMessage >= 0 && preliminaryWindow.hiddenAbove > 0
  const transcriptWindow = classicNeedsTruncationHint
    ? computeTranscriptWindow({
        ...windowArgs,
        budgetLines: Math.max(2, transcriptBudget - 1)
      })
    : preliminaryWindow
  // Classic keeps committed history in <Static>; only the live tail is windowed here.
  const dynamicMessages = fullscreen || firstMutableMessage >= 0 ? transcriptWindow.messages : []
  const assistantThinking = dynamicMessages.some(isActiveThinkingMessage)
  const hiddenAboveDynamic = classicNeedsTruncationHint ? transcriptWindow.hiddenAbove : 0

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  /**
   * Abort delivery is asynchronous in some runtimes. Close the local streaming projection
   * immediately so an interrupted thought cannot remain rendered as active while the Worker
   * unwinds its stream.
   */
  const interruptActiveOperation = (): void => {
    const controller = abortControllerRef.current
    if (!controller || controller.signal.aborted) return

    controller.abort()
    const completedAt = Date.now()
    setMessages((current) =>
      current.map((message) => {
        if (message.kind === 'assistant' && message.streaming) {
          return {
            ...message,
            segments: finalizeAssistantSegments(
              message.segments,
              message.reasoningTokens,
              completedAt
            ),
            streaming: false
          }
        }
        if (message.kind === 'tool' && message.status === 'running') {
          return {
            ...message,
            status: 'error',
            summary: message.summary ?? t('cli.statuses.interrupted', 'Interrupted')
          }
        }
        return message
      })
    )
    setTurnStatus(null)
    setActivity(undefined)
    showNotice(t('cli.statuses.interrupted', 'Interrupted'))
  }

  // The update probe runs after the UI is interactive so startup never blocks on npm.
  // A newer version surfaces as a persistent transcript notice instead of a modal prompt.
  useEffect(() => {
    let cancelled = false
    void checkForUpdate(version).then((latest) => {
      if (cancelled || !latest) return
      messageIdRef.current += 1
      setMessages((current) => [
        ...current,
        {
          id: `system-update-${messageIdRef.current}`,
          kind: 'system',
          text: t(
            'cli.runtime.updateAvailable',
            'OpenCowork {{version}} is available ? run `cowork update` to upgrade',
            { version: latest }
          ),
          tone: 'muted'
        }
      ])
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one startup probe per process
  }, [])

  useEffect(() => {
    if (terminalRevisionRef.current === terminalRevision) return
    terminalRevisionRef.current = terminalRevision
    onRequestRedraw()
    setTranscriptEpoch((current) => current + 1)
  }, [onRequestRedraw, terminalRevision])

  const redraw = (): void => {
    onRequestRedraw()
    setTranscriptEpoch((current) => current + 1)
  }

  const toggleDetails = (): void => {
    setShowDetails((current) => !current)
    redraw()
  }

  // Fullscreen scroll lock: moving the anchor off the tail freezes the viewport while
  // new messages keep streaming below; reaching the newest message re-enables follow.
  const scrollTranscript = (delta: number): void => {
    if (!fullscreen || messages.length === 0) return
    setScrollAnchor((current) => {
      const last = messages.length - 1
      const base = current === null ? last : current
      const next = Math.max(0, Math.min(last, base + delta))
      return next >= last ? null : next
    })
  }

  const toggleMessageExpanded = (id: string): void => {
    setExpandedMessageIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Maps a click row (1-based screen coordinates; the fullscreen transcript starts at
  // the top of the alt screen) onto the visible message and toggles tool detail.
  const handleTranscriptClick = (row: number): void => {
    let cursor = 0
    for (let index = 0; index < transcriptWindow.messages.length; index += 1) {
      const height = transcriptWindow.heights[index] ?? 0
      if (row > cursor && row <= cursor + height) {
        const target = transcriptWindow.messages[index]
        if (target && target.kind === 'tool' && (target.detail || target.summary)) {
          toggleMessageExpanded(target.id)
        }
        return
      }
      cursor += height
    }
  }

  useInput(
    (input, key) => {
      if (containsMouseSequence(input)) {
        for (const event of parseMouseEvents(input)) {
          const delta = wheelDelta(event)
          if (delta !== 0) scrollTranscript(delta)
          else if (isLeftClickPress(event)) handleTranscriptClick(event.row)
        }
        return
      }
      const pageSize = Math.max(1, transcriptWindow.messages.length || 3)
      if (key.pageUp) scrollTranscript(-pageSize)
      else if (key.pageDown) scrollTranscript(pageSize)
    },
    { isActive: fullscreen }
  )

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

  const refreshSelectedModelConfiguration = (
    selection: ModelSelection | null = modelSelection
  ): ModelConfiguration | null => {
    if (!selection || !runtime.getModelConfiguration) {
      setAvailableEffortLevels([])
      setSupportsThinking(false)
      setThinkingEnabled(false)
      return null
    }

    try {
      const configuration = runtime.getModelConfiguration(selection)
      setEffort(configuration.reasoningEffort)
      setAvailableEffortLevels(configuration.reasoningEffortLevels)
      setSupportsThinking(configuration.supportsThinking)
      setThinkingEnabled(configuration.supportsThinking && configuration.thinkingEnabled)
      return configuration
    } catch {
      setAvailableEffortLevels([])
      setSupportsThinking(false)
      setThinkingEnabled(false)
      return null
    }
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
      showNotice(
        t('cli.runtime.configurationUnavailable', 'Configuration is unavailable in this runtime')
      )
      return
    }
    setConfigOpen(true)
  }

  const [providerSetupDeviceLogin, setProviderSetupDeviceLogin] = useState(false)

  const openProviderSetup = (returnToConfig = false, options?: { deviceLogin?: boolean }): void => {
    if (!runtime.getProviderSetupCatalog || !runtime.configureProvider) {
      showNotice(
        t('cli.runtime.providerSetupUnavailable', 'Provider setup is unavailable in this runtime')
      )
      return
    }
    try {
      setProviderSetupCatalog(runtime.getProviderSetupCatalog())
      setProviderSetupReturnToConfig(returnToConfig)
      setProviderSetupOnboarding(false)
      setProviderSetupDeviceLogin(Boolean(options?.deviceLogin))
      setConfigOpen(false)
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const openRoutinDeviceLogin = (): void => {
    openProviderSetup(false, { deviceLogin: true })
  }

  const closeProviderSetup = (): void => {
    setProviderSetupCatalog(null)
    setProviderSetupOnboarding(false)
    setProviderSetupDeviceLogin(false)
    if (providerSetupReturnToConfig) setConfigOpen(true)
    setProviderSetupReturnToConfig(false)
  }

  const finishProviderSetup = (selection: ModelSelection): void => {
    const catalog = runtime.getModelCatalog()
    setModelCatalog(catalog)
    setModelSelection(selection)
    const configuration = refreshSelectedModelConfiguration(selection)
    if (configuration) runtime.configure?.({ effort: configuration.reasoningEffort })
    refreshConfigCatalog()
    refreshRuntimeMetrics()
    setProviderSetupCatalog(null)
    setProviderSetupOnboarding(false)
    setProviderSetupDeviceLogin(false)
    if (providerSetupReturnToConfig) setConfigOpen(true)
    setProviderSetupReturnToConfig(false)
    showNotice(
      t('cli.runtime.providerReady', 'Provider ready ? {{provider}} / {{model}}', {
        provider: selection.providerName,
        model: selection.modelName
      })
    )
  }

  const saveProviderSetup = async (input: ProviderSetupInput): Promise<void> => {
    if (!runtime.configureProvider)
      throw new Error(
        t('cli.runtime.providerSetupUnavailable', 'Provider setup is unavailable in this runtime.')
      )
    const selection = await runtime.configureProvider(input)
    finishProviderSetup(selection)
  }

  const completeProviderSetupFromStore = async (selection: ModelSelection): Promise<void> => {
    finishProviderSetup(selection)
  }

  const openAgentPanel = (): void => {
    setAgents(runtime.getAgentCatalog())
    setAgentPanelOpen(true)
  }

  // CLI-only first run: with no provider configured anywhere, the prompt cannot start a
  // turn, so open the provider wizard immediately instead of leaving only a welcome tip.
  // Onboarding mode leads with the recommended provider; Esc still dismisses it.
  const firstRunSetupRef = useRef(false)
  useEffect(() => {
    if (firstRunSetupRef.current) return
    firstRunSetupRef.current = true
    const catalog = initialCatalogRef.current
    const unconfigured = !catalog?.active && (catalog?.groups.length ?? 0) === 0
    if (!unconfigured) return
    if (!runtime.getProviderSetupCatalog || !runtime.configureProvider) return
    try {
      const setupCatalog = runtime.getProviderSetupCatalog()
      setProviderSetupCatalog(setupCatalog)
      setProviderSetupOnboarding(setupCatalog.configuredCount === 0)
      setProviderSetupReturnToConfig(false)
    } catch {
      // The welcome tip and /provider remain available when the catalog cannot be read.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot first-run detection
  }, [])

  const searchFiles = useCallback(
    async (query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> => {
      if (!runtime.searchFiles) return []
      return runtime.searchFiles(query, signal)
    },
    [runtime]
  )

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
      setTurnStatus(null)
      return
    }

    if (event.type === 'runtime.activity') {
      setActivity(
        event.activity === 'compressing'
          ? t('cli.statuses.compressing', 'Compressing context?')
          : t('cli.statuses.working', 'Working?')
      )
      if (event.activity === 'working') {
        setTurnStatus((current) => (current ? { ...current, phase: 'requesting' } : current))
      }
      return
    }

    if (event.type === 'runtime.usage') {
      refreshRuntimeMetrics()
      setTurnStatus((current) => {
        if (!current) return current
        const estimatedOutputTokens = Math.round(current.activeResponseCharacters / 4)
        const outputTokens =
          event.outputTokens !== undefined && event.outputTokens > 0
            ? event.outputTokens
            : estimatedOutputTokens
        const reportedRequestTokens = event.contextTokens ?? event.inputTokens
        return {
          ...current,
          activeResponseCharacters: 0,
          completedOutputTokens: current.completedOutputTokens + outputTokens,
          phase: current.phase === 'requesting' ? 'responding' : current.phase,
          requestTokens:
            reportedRequestTokens !== undefined && reportedRequestTokens > 0
              ? reportedRequestTokens
              : current.requestTokens
        }
      })
      return
    }

    if (event.type === 'runtime.retry') {
      const delay =
        event.delayMs >= 1_000
          ? `${(event.delayMs / 1_000).toFixed(event.delayMs % 1_000 === 0 ? 0 : 1)}s`
          : `${event.delayMs}ms`
      setActivity(
        `${t('cli.runtime.retry', 'Retry')} ${event.attempt}/${event.maxAttempts}${event.statusCode ? ` ? HTTP ${event.statusCode}` : ''} ? ${t('cli.runtime.retryIn', 'in')} ${delay}${event.reason ? ` ? ${event.reason}` : ''}`
      )
      setTurnStatus((current) => (current ? { ...current, phase: 'requesting' } : current))
      return
    }

    if (event.type === 'context-compression.start') {
      setActivity(t('cli.statuses.compressing', 'Compressing context?'))
      return
    }

    if (event.type === 'context-compression.done') {
      setActivity(t('cli.statuses.working', 'Working?'))
      appendSystem(
        event.summarizerFailed
          ? event.error ||
              'Context compression failed; the Native Worker preserved the original history.'
          : `Context compressed ? ${event.originalCount} ? ${event.newCount} messages${event.messagesSummarized === undefined ? '' : ` ? ${event.messagesSummarized} summarized`}`,
        event.summarizerFailed ? 'warning' : 'success'
      )
      return
    }

    if (event.type === 'assistant.start') {
      setActivity(t('cli.statuses.working', 'Working?'))
      setTurnStatus((current) => (current ? { ...current, phase: 'responding' } : current))
      setMessages((current) => [
        ...current,
        {
          id: event.id,
          kind: 'assistant',
          model: event.model,
          segments: [],
          streaming: true,
          text: '',
          timestamp: nowTimestamp()
        }
      ])
      return
    }

    if (event.type === 'assistant.delta') {
      setTurnStatus((current) =>
        current
          ? {
              ...current,
              activeResponseCharacters: current.activeResponseCharacters + event.text.length,
              firstResponseAt: current.firstResponseAt ?? Date.now(),
              phase: 'responding'
            }
          : current
      )
      setMessages((current) =>
        updateMessageById(current, event.id, 'assistant', (message) => ({
          ...message,
          segments: appendAssistantSegment(message.segments, 'text', event.text, Date.now()),
          text: message.text + event.text
        }))
      )
      return
    }

    if (event.type === 'assistant.thinking') {
      setTurnStatus((current) =>
        current
          ? {
              ...current,
              activeResponseCharacters: current.activeResponseCharacters + event.thinking.length,
              firstResponseAt: current.firstResponseAt ?? Date.now(),
              phase: 'thinking'
            }
          : current
      )
      setMessages((current) =>
        updateMessageById(current, event.id, 'assistant', (message) => ({
          ...message,
          segments: appendAssistantSegment(message.segments, 'thinking', event.thinking, Date.now())
        }))
      )
      return
    }

    if (event.type === 'assistant.done') {
      if (!event.preserveResponseCharacters) {
        setTurnStatus((current) => {
          if (!current || current.activeResponseCharacters <= 0) return current
          return {
            ...current,
            activeResponseCharacters: 0,
            completedOutputTokens:
              current.completedOutputTokens + Math.round(current.activeResponseCharacters / 4)
          }
        })
      }
      setMessages((current) =>
        updateMessageById(current, event.id, 'assistant', (message) => ({
          ...message,
          ...(event.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: event.reasoningTokens }),
          segments: finalizeAssistantSegments(
            message.segments,
            event.reasoningTokens ?? message.reasoningTokens,
            Date.now()
          ),
          streaming: false
        }))
      )
      return
    }

    if (event.type === 'tool.start') {
      setActivity(t('cli.statuses.working', 'Working?'))
      setTurnStatus((current) => (current ? { ...current, phase: 'tool-use' } : current))
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
        updateMessageById(current, event.id, 'tool', (message) => ({
          ...message,
          status: event.status,
          summary: event.summary,
          ...(event.title ? { title: event.title } : {}),
          ...(event.diff ? { diff: event.diff } : {})
        }))
      )
      return
    }

    if (event.type === 'tool.update') {
      setMessages((current) =>
        updateMessageById(current, event.id, 'tool', (message) => ({
          ...message,
          ...(event.title ? { title: event.title } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.summary ? { summary: event.summary } : {})
        }))
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
      setShowTasks(event.tasks.length > 0)
      return
    }

    if (event.type === 'system') {
      setMessages((current) => {
        const previous = current.at(-1)
        // Collapse identical consecutive system lines (legacy spam / reconnect noise)
        // so the live Ink frame stays within the terminal height budget.
        if (
          previous &&
          previous.kind === 'system' &&
          previous.text === event.message.text &&
          previous.tone === event.message.tone
        ) {
          return current
        }
        return [...current, event.message]
      })
      return
    }
  }

  const appendUserTranscript = (
    prompt: string,
    images: PromptImageAttachment[],
    references: PromptReference[]
  ): void => {
    messageIdRef.current += 1
    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}-${messageIdRef.current}`,
        kind: 'user',
        text: prompt,
        ...(images.length > 0
          ? {
              images: images.map((image) => ({
                id: image.id,
                name: image.name,
                mediaType: image.mediaType,
                size: image.size
              }))
            }
          : {}),
        ...(references.length > 0
          ? { references: references.map((reference) => ({ ...reference })) }
          : {})
      }
    ])
  }

  const runPrompt = async (
    prompt: string,
    images: PromptImageAttachment[] = [],
    references: PromptReference[] = []
  ): Promise<void> => {
    if (images.length > 0 && !supportsVision) {
      showNotice(
        t(
          'cli.runtime.visionUnsupported',
          'Current model does not support image input ? choose a vision model with Alt-P'
        )
      )
      return
    }

    const submission = { text: prompt, images, references }
    if (isRunning) {
      if (!runtime.appendToActiveRun) {
        showNotice(t('cli.runtime.turnRunning', 'A turn is already running ? Esc to interrupt'))
        return
      }
      try {
        await runtime.appendToActiveRun(submission)
      } catch (error) {
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
        return
      }
      setScrollAnchor(null)
      appendUserTranscript(prompt, images, references)
      refreshRuntimeMetrics()
      showNotice(
        t(
          'cli.runtime.turnAppended',
          'Inserted into the current turn · the agent will see it on the next step'
        )
      )
      return
    }

    // A new turn always returns the fullscreen viewport to follow-the-tail mode.
    setScrollAnchor(null)
    const startedAt = Date.now()
    let requestTokens = Math.max(1, Math.ceil(prompt.length / 4))
    try {
      requestTokens = Math.max(
        1,
        runtime.estimateRequestTokens?.(submission) ??
          (runtime.getContextSnapshot?.().estimatedTokens ?? 0) + requestTokens
      )
    } catch {
      // The live transfer indicator remains available even if optional context metrics fail.
    }

    appendUserTranscript(prompt, images, references)
    const controller = new AbortController()
    abortControllerRef.current = controller
    setIsRunning(true)
    setActivity(t('cli.statuses.working', 'Working?'))
    setTurnStatus({
      activeResponseCharacters: 0,
      completedOutputTokens: 0,
      id: `turn-${startedAt}`,
      phase: 'requesting',
      requestTokens,
      startedAt,
      verb: pickSpinnerVerb()
    })

    // High-rate stream deltas are buffered and applied on a ~33ms frame budget so React
    // renders once per frame instead of once per token. Interactive events (approvals,
    // AskUser, plan, tool start/done) flush the buffer and apply immediately in order.
    const pendingEvents: UiEvent[] = []
    let flushTimer: NodeJS.Timeout | null = null
    const flushPendingEvents = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (pendingEvents.length === 0) return
      for (const event of pendingEvents.splice(0)) applyRuntimeEvent(event)
    }
    const enqueueEvent = (event: UiEvent): void => {
      if (!isCoalescibleEvent(event)) {
        flushPendingEvents()
        applyRuntimeEvent(event)
        return
      }
      const tail = pendingEvents.at(-1)
      if (
        tail &&
        tail.type === 'assistant.delta' &&
        event.type === 'assistant.delta' &&
        tail.id === event.id
      ) {
        tail.text += event.text
      } else if (
        tail &&
        tail.type === 'assistant.thinking' &&
        event.type === 'assistant.thinking' &&
        tail.id === event.id
      ) {
        tail.thinking += event.thinking
      } else {
        pendingEvents.push(event)
      }
      flushTimer ??= setTimeout(flushPendingEvents, STREAM_FLUSH_INTERVAL_MS)
    }

    try {
      for await (const event of runtime.send(submission, controller.signal)) {
        if (controller.signal.aborted) break
        enqueueEvent(event)
      }
      flushPendingEvents()
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
      pendingEvents.length = 0
      abortControllerRef.current = undefined
      refreshRuntimeMetrics()
      setIsRunning(false)
      setActivity(undefined)
      setTurnStatus(null)
    }
  }

  const runCompact = async (focusPrompt?: string): Promise<void> => {
    if (!runtime.compactContext) {
      appendSystem(
        t(
          'cli.runtime.compactUnavailable',
          'Manual context compression is unavailable in this runtime.'
        ),
        'warning'
      )
      return
    }
    if (isRunning) {
      showNotice(t('cli.runtime.workerRunning', 'A Worker operation is already running'))
      return
    }

    const controller = new AbortController()
    abortControllerRef.current = controller
    setIsRunning(true)
    setActivity(t('cli.statuses.compressing', 'Compressing context?'))
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
          `Context compressed ? ${result.originalCount} ? ${result.newCount} messages${result.messagesSummarized === undefined ? '' : ` ? ${result.messagesSummarized} summarized`}`,
          'success'
        )
      }
    } catch (error) {
      if (controller.signal.aborted) {
        showNotice(t('cli.runtime.compactInterrupted', 'Context compression interrupted'))
      } else appendSystem(error instanceof Error ? error.message : String(error), 'error')
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
    setActivity(
      startNewSession
        ? t('cli.runtime.startingSession', 'Starting new session?')
        : t('cli.runtime.clearingContext', 'Clearing context?')
    )
    try {
      await operation.call(runtime)
      if (!fullscreen) process.stdout.write('\u001B[2J\u001B[3J\u001B[H')
      setMessages([])
      setPromptImages([])
      setPromptReferences([])
      if (startNewSession) setTasks([])
      setPlan(null)
      if (startNewSession) setShowTasks(false)
      showNotice(
        startNewSession
          ? t('cli.runtime.newSessionReady', 'New Native Worker session ready')
          : t('cli.runtime.contextCleared', 'Canonical context cleared')
      )
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
    setActivity(t('cli.runtime.checkingWorker', 'Checking Native Worker?'))
    try {
      const result = await runtime.doctor()
      appendSystem(
        [
          `Native Worker ready ? ${result.runtime} ${result.runtimeVersion}`,
          `IPC v${result.protocolVersion} ? Agent v${result.agentProtocolVersion} ? ${result.routeCount} routes`,
          `PID ${result.pid} ? ${result.configuredModel}`,
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
        if (key === 'thinkingEnabled' || key === 'thinkingIntensity') {
          refreshSelectedModelConfiguration()
        }
        showNotice(t('cli.runtime.configurationSaved', 'Configuration saved to OpenCowork'))
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

  const listResumableSessions = async (signal: AbortSignal): Promise<ResumeSessionSummary[]> => {
    if (!runtime.listResumableSessions) {
      throw new Error('Durable session resume is unavailable in this runtime.')
    }
    return runtime.listResumableSessions(signal)
  }

  const runResume = async (sessionId: string, signal: AbortSignal): Promise<ResumeResult> => {
    if (!runtime.resumeSession) {
      throw new Error('Durable session resume is unavailable in this runtime.')
    }
    if (isRunning) throw new Error('Wait for the active Worker operation before resuming.')
    setIsRunning(true)
    setActivity(t('cli.runtime.resumingSession', 'Resuming session…'))
    try {
      return await runtime.resumeSession(sessionId, signal)
    } finally {
      setIsRunning(false)
      setActivity(undefined)
    }
  }

  const completeResume = (result: ResumeResult): void => {
    if (!fullscreen) process.stdout.write('[2J[3J[H')
    setMessages(result.transcript)
    setPromptImages([])
    setPromptReferences([])
    setTasks([])
    setPlan(null)
    setShowTasks(false)
    setPermissionRequest(null)
    setAskUserRequest(null)
    setTurnStatus(null)
    setResumeOpen(false)
    setTranscriptEpoch((current) => current + 1)
    const catalog = runtime.getModelCatalog()
    setModelCatalog(catalog)
    setModelSelection(result.modelSelection)
    refreshSelectedModelConfiguration(result.modelSelection)
    refreshConfigCatalog()
    refreshRuntimeMetrics()
    if (result.warning) appendSystem(result.warning, 'warning')
    showNotice(
      t('cli.runtime.resumedSession', 'Resumed session · {{count}} canonical messages', {
        count: result.session.messageCount
      })
    )
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
        ? t('cli.runtime.summarizingConversation', 'Summarizing conversation?')
        : action === 'restore-code'
          ? t('cli.runtime.restoringCode', 'Restoring code?')
          : action === 'restore-code-and-conversation'
            ? t('cli.runtime.restoringCodeConversation', 'Restoring code and conversation?')
            : t('cli.runtime.restoringConversation', 'Restoring conversation?')
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
            ? `Conversation forked${result.restoredFileCount > 0 ? ` ? ${result.restoredFileCount} files restored` : ''}`
            : `${result.restoredFileCount} tracked file${result.restoredFileCount === 1 ? '' : 's'} restored`
      )
      return result
    } finally {
      setIsRunning(false)
      setActivity(undefined)
    }
  }

  const readEffortConfiguration = (): ModelConfiguration | null => {
    if (!modelSelection || !runtime.getModelConfiguration || !runtime.configureModel) {
      appendSystem('Thinking intensity is unavailable until a model is configured.', 'warning')
      return null
    }

    try {
      const configuration = runtime.getModelConfiguration(modelSelection)
      if (!configuration.supportsThinking) {
        appendSystem(`${configuration.selection.modelName} does not support thinking.`, 'warning')
        return null
      }
      return configuration
    } catch (error) {
      appendSystem(error instanceof Error ? error.message : String(error), 'error')
      return null
    }
  }

  const saveThinkingIntensity = (configuration: ModelConfiguration, intensity: string): void => {
    if (!runtime.configureModel || effortSaving) return
    setEffortSaving(true)
    const patch = thinkingIntensityPatch(configuration, intensity)

    void runtime
      .configureModel(configuration.selection, patch)
      .then(() => {
        const refreshed = refreshSelectedModelConfiguration(configuration.selection)
        if (refreshed) runtime.configure?.({ effort: refreshed.reasoningEffort })
        setEffortConfiguration(null)
        refreshConfigCatalog()
        showNotice(formatThinkingNotice(configuration, intensity, refreshed))
      })
      .catch((error) =>
        appendSystem(
          `Failed to update thinking intensity: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      )
      .finally(() => setEffortSaving(false))
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
    if (name === '/init') {
      if (args.length > 0) {
        appendSystem('Usage: /init', 'warning')
      } else {
        void runPrompt(initWorkspacePrompt)
      }
      return true
    }
    if (name === '/resume') {
      if (args.length > 0) {
        appendSystem('Usage: /resume', 'warning')
      } else if (isRunning) {
        showNotice('Wait for the active Worker operation before resuming')
      } else if (!runtime.listResumableSessions || !runtime.resumeSession) {
        appendSystem('Durable session resume is unavailable in this runtime.', 'warning')
      } else {
        setResumeOpen(true)
      }
      return true
    }
    if (name === '/model') {
      openModelPicker()
      return true
    }
    if (name === '/provider') {
      if (args.length === 1 && ['login', 'routin'].includes(args[0].toLocaleLowerCase())) {
        openRoutinDeviceLogin()
      } else if (args.length > 0) {
        appendSystem('Usage: /provider | /provider login', 'warning')
      } else {
        openProviderSetup()
      }
      return true
    }
    if (name === '/login') {
      if (args.length > 0) {
        appendSystem('Usage: /login', 'warning')
      } else {
        openRoutinDeviceLogin()
      }
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
            ? ` ? ${Math.round((snapshot.estimatedTokens / snapshot.contextLength) * 100)}%`
            : ''
        appendSystem(
          `Context ? ${usage}${ratio}\n${snapshot.messageCount} canonical messages ? auto-compact ${snapshot.compressionEnabled ? `at ${formatTokenCount(snapshot.triggerTokens)}` : 'off'}`,
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
          `Usage ? ${usage.requestCount} requests ? ${formatTokenCount(usage.inputTokens)} input ? ${formatTokenCount(usage.outputTokens)} output\nBillable input ${formatTokenCount(usage.billableInputTokens)} ? cache read ${formatTokenCount(usage.cacheReadTokens)} ? reasoning ${formatTokenCount(usage.reasoningTokens)}\nEstimated cost ${cost} ? ${usage.model}`,
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
      const action = args[0]?.toLocaleLowerCase()
      if (action && !['on', 'off', 'toggle'].includes(action)) {
        appendSystem('Usage: /plan [on|off|toggle]', 'warning')
        return true
      }
      const nextMode: PermissionMode =
        action === 'off' || (action === 'toggle' && permissionMode === 'plan') ? 'manual' : 'plan'
      setPermissionMode(nextMode)
      runtime.configure?.({ permissionMode: nextMode })
      showNotice(permissionModeNotice(nextMode))
      return true
    }
    if (name === '/skills') {
      if (!runtime.listSkills) {
        appendSystem('Skill listing is unavailable in this runtime.', 'warning')
        return true
      }
      void runtime
        .listSkills()
        .then((skills) => {
          if (skills.length === 0) {
            appendSystem(
              'No skills installed. Add skills under ~/.agents/skills (SKILL.md per folder).',
              'muted'
            )
            return
          }
          appendSystem(
            [
              `${skills.length} skill${skills.length === 1 ? '' : 's'} available via the Skill tool:`,
              ...skills.map((skill) => `- ${skill.name}: ${skill.description}`)
            ].join('\n'),
            'success'
          )
        })
        .catch((error) =>
          appendSystem(error instanceof Error ? error.message : String(error), 'error')
        )
      return true
    }
    if (name === '/mcp') {
      if (!runtime.getMcpStatus) {
        appendSystem('MCP hosting is unavailable in this runtime.', 'warning')
        return true
      }
      const action = args[0]?.toLowerCase()
      if (action && action !== 'enable' && action !== 'disable' && action !== 'reload') {
        appendSystem('Usage: /mcp [enable <id>|disable <id>|reload]', 'warning')
        return true
      }
      const renderStatus = async (): Promise<void> => {
        const status = await runtime.getMcpStatus!()
        if (status.servers.length === 0) {
          appendSystem(
            'No MCP servers configured. Add servers in the OpenCowork desktop app or edit ~/.open-cowork/mcp-servers.json, then run /mcp reload.',
            'muted'
          )
          return
        }
        const lines = status.servers.map((server) => {
          const state = server.projectBound
            ? 'project-bound ? desktop only'
            : !server.enabled
              ? 'disabled'
              : server.status === 'connected'
                ? `connected ? ${server.toolCount} tools${server.resourceCount > 0 ? ` ? ${server.resourceCount} resources` : ''}`
                : server.status === 'error'
                  ? `error ? ${server.error ?? 'connection failed'}`
                  : server.status
          return `${server.name} (${server.id}) ? ${server.transport} ? ${state}`
        })
        const hasError = status.servers.some(
          (server) => server.enabled && server.status === 'error'
        )
        appendSystem(
          [...lines, `${status.hostedToolCount} MCP tools exposed to the agent`].join('\n'),
          hasError ? 'warning' : 'success'
        )
      }
      const run = async (): Promise<void> => {
        if (action === 'enable' || action === 'disable') {
          const id = args[1]
          if (!id) {
            appendSystem(`Usage: /mcp ${action} <server-id>`, 'warning')
            return
          }
          if (!runtime.setMcpServerEnabled) {
            appendSystem('MCP configuration updates are unavailable in this runtime.', 'warning')
            return
          }
          await runtime.setMcpServerEnabled(id, action === 'enable')
        }
        await renderStatus()
      }
      void run().catch((error) =>
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
      )
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
          const catalog = status.toolNames.length > 0 ? ` ? ${status.toolNames.join(', ')}` : ''
          appendSystem(
            `${status.message} ? ${status.indexed ? 'indexed' : 'not indexed'}${catalog}`,
            status.enabled ? (status.indexed ? 'success' : 'warning') : 'muted'
          )
        })
        .catch((error) =>
          appendSystem(error instanceof Error ? error.message : String(error), 'error')
        )
      return true
    }
    if (name === '/effort' || name === '/think') {
      if (args.length > 1) {
        appendSystem('Usage: /effort [off|on|auto|level]', 'warning')
        return true
      }
      const configuration = readEffortConfiguration()
      if (!configuration) return true
      const requested = args[0]?.toLocaleLowerCase()
      if (!requested) {
        setEffortConfiguration(configuration)
        return true
      }
      const intensity = parseThinkingIntensity(configuration, requested)
      if (!intensity) {
        appendSystem(`Usage: ${thinkingIntensityUsage(configuration)}`, 'warning')
        return true
      }
      saveThinkingIntensity(configuration, intensity)
      return true
    }
    if (name === '/status') {
      const modelStatus = modelSelection
        ? `${modelSelection.providerName} / ${modelSelection.modelName}`
        : 'No configured model'
      const thinkingStatus = formatThinkingStatus({
        reasoningEffort: effort,
        reasoningEffortLevels: availableEffortLevels,
        supportsThinking,
        thinkingEnabled
      })
      appendSystem(
        [modelStatus, thinkingStatus, `${permissionMode} permissions`, `${tuiMode} renderer`]
          .filter(Boolean)
          .join(' · '),
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

  // `!` shell mode: run the rest of the prompt as a local shell command without an
  // agent turn. Output lands in the transcript as a tool block (click / Ctrl-O expands),
  // and Esc/Ctrl-C reuse the normal interrupt path to kill the child.
  const SHELL_OUTPUT_LIMIT = 16_000
  const runShellCommand = (command: string): void => {
    messageIdRef.current += 1
    const id = `shell-${Date.now()}-${messageIdRef.current}`
    setMessages((current) => [
      ...current,
      { id, kind: 'tool', title: `$ ${command}`, status: 'running' }
    ])
    setScrollAnchor(null)
    setIsRunning(true)
    setActivity(t('cli.statuses.runningShell', 'Running shell command?'))
    const controller = new AbortController()
    abortControllerRef.current = controller
    const child = spawn(command, { shell: true, cwd, env: process.env })
    let output = ''
    let truncated = false
    const appendOutput = (chunk: Buffer): void => {
      if (output.length >= SHELL_OUTPUT_LIMIT) {
        truncated = true
        return
      }
      output += chunk.toString('utf8')
    }
    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)
    const killChild = (): void => {
      child.kill('SIGTERM')
    }
    controller.signal.addEventListener('abort', killChild, { once: true })

    let finished = false
    const finish = (code: number | null, errorMessage?: string): void => {
      if (finished) return
      finished = true
      controller.signal.removeEventListener('abort', killChild)
      setIsRunning(false)
      setActivity(undefined)
      const interrupted = controller.signal.aborted
      const failed = Boolean(errorMessage) || interrupted || (code !== null && code !== 0)
      const trimmed = output.replace(/\s+$/u, '')
      const detail = trimmed
        ? truncated
          ? `${trimmed.slice(0, SHELL_OUTPUT_LIMIT)}\n? output truncated`
          : trimmed
        : undefined
      const firstLine = trimmed.split('\n', 1)[0]
      const summary =
        errorMessage ??
        (interrupted
          ? t('cli.statuses.interrupted', 'Interrupted')
          : failed
            ? `exit ${code}${firstLine ? ` ? ${firstLine}` : ''}`
            : firstLine || t('cli.statuses.completed', 'Completed'))
      setMessages((current) =>
        updateMessageById(current, id, 'tool', (message) => ({
          ...message,
          status: failed ? 'error' : 'success',
          summary,
          ...(detail ? { detail } : {})
        }))
      )
    }
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
  }

  const handleSubmit = (
    submission: string,
    images: PromptImageAttachment[],
    references: PromptReference[]
  ): void => {
    setShowHelp(false)
    const shellCandidate = submission.trimStart()
    if (shellCandidate.startsWith('!') || shellCandidate.startsWith('/')) {
      if (isRunning) {
        showNotice(
          t(
            'cli.runtime.commandWhileRunning',
            'Wait for the current turn to finish, or Esc to interrupt, before running a command'
          )
        )
        return
      }
    }
    if (shellCandidate.startsWith('!')) {
      if (images.length > 0 || references.length > 0) {
        showNotice('Remove attached images and references before running a shell command')
        return
      }
      const command = shellCandidate.slice(1).trim()
      if (!command) {
        showNotice(t('cli.prompt.shellUsage', '!<command> runs a shell command in the cwd'))
        return
      }
      runShellCommand(command)
      return
    }
    if (submission.trimStart().startsWith('/')) {
      if (images.length > 0 || references.length > 0) {
        showNotice('Remove attached images and references before running a CLI command')
        return
      }
      if (handleCommand(submission)) return
      const commandName = submission.trim().split(/\s+/u)[0] ?? submission.trim()
      appendSystem(`Unknown CLI command: ${commandName}`, 'warning')
      return
    }
    void runPrompt(submission, images, references)
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
      `${labels[decision]} ? ${request.tool}: ${request.title}`,
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
    interruptActiveOperation()
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
        appendSystem('Plan approved ? starting implementation in the Native Worker.', 'success')
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
        appendSystem('Plan revision requested ? returning to planning.', 'muted')
        void runPrompt(feedback)
      })
      .catch((error) =>
        appendSystem(error instanceof Error ? error.message : String(error), 'error')
      )
      .finally(() => setPlanActionPending(false))
  }

  const cyclePermissionMode = (): void => {
    const index = permissionModes.indexOf(permissionMode)
    const next = permissionModes[(index + 1) % permissionModes.length] ?? 'manual'
    if (permissionMode === 'plan' && next !== 'plan' && isRunning) {
      // Leaving Plan mode while a planning turn is running must also stop the active
      // Worker turn; otherwise a Bash tool can continue running behind the prompt.
      abortControllerRef.current?.abort()
    }
    setPermissionMode(next)
    runtime.configure?.({ permissionMode: next })
    showNotice(permissionModeNotice(next))
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
    const configuration = refreshSelectedModelConfiguration(selection)
    if (configuration) runtime.configure?.({ effort: configuration.reasoningEffort })
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
        const refreshed = refreshSelectedModelConfiguration(configuration.selection)
        if (refreshed) runtime.configure?.({ effort: refreshed.reasoningEffort })
        setModelConfiguration(null)
        if (modelConfigurationReturnToConfig) setConfigOpen(true)
        setModelConfigurationReturnToConfig(false)
        showNotice(
          `Model switched to ${configuration.selection.providerName} / ${configuration.selection.modelName} ? configuration saved`
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
    permissionMode === 'plan' &&
    plan &&
    (plan.status === 'drafting' || plan.status === 'awaiting_review')
  )
  const inputActive =
    !askUserRequest &&
    !planOverlay &&
    !permissionRequest &&
    !effortConfiguration &&
    !modelConfiguration &&
    !modelPickerPurpose &&
    !providerSetupCatalog &&
    !resumeOpen &&
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
        height={fullscreen ? frameRows : undefined}
        justifyContent={fullscreen ? 'space-between' : 'flex-start'}
        width={contentWidth}
      >
        <Box
          flexDirection="column"
          flexGrow={fullscreen ? 1 : 0}
          // Fullscreen always owns a fixed alt-screen band. Classic only clamps when the
          // live tail was truncated; otherwise a fixed height leaves a blank gap above
          // the prompt on short turns.
          height={fullscreen || hiddenAboveDynamic > 0 ? transcriptBudget : undefined}
          overflow={fullscreen || hiddenAboveDynamic > 0 ? 'hidden' : undefined}
        >
          {agentPanelOpen ? null : !hasTranscript ? (
            <WelcomeCard
              cwd={cwd}
              model={modelSelection?.modelName ?? t('cli.welcome.noModel', 'No model configured')}
              version={version}
              width={contentWidth}
            />
          ) : dynamicMessages.length > 0 ? (
            <>
              {hiddenAboveDynamic > 0 ? (
                <Text color={theme.dim}>
                  {t(
                    'cli.statuses.transcriptTruncated',
                    '? {{count}} earlier live lines hidden to fit the terminal',
                    { count: hiddenAboveDynamic }
                  )}
                </Text>
              ) : null}
              <Transcript
                expandedMessageIds={expandedMessageIds}
                hideStreamingStatus={Boolean(turnStatus)}
                messages={dynamicMessages}
                showDetails={showDetails}
                width={contentWidth}
              />
            </>
          ) : null}
        </Box>

        <Box flexDirection="column" flexShrink={0}>
          {fullscreen && scrollAnchor !== null ? (
            <Text color={theme.warning}>
              {t(
                'cli.statuses.scrollLocked',
                '? {{count}} newer ? PgDn / wheel down to follow, click a tool row to expand',
                { count: transcriptWindow.hiddenBelow }
              )}
            </Text>
          ) : null}
          {turnStatus ? (
            <TurnStatusLine
              effort={effort}
              status={turnStatus}
              supportsEffort={availableEffortLevels.length > 0}
              width={contentWidth}
            />
          ) : null}

          {showTasks &&
          !askUserRequest &&
          !planOverlay &&
          !permissionRequest &&
          !effortConfiguration &&
          !modelConfiguration &&
          !modelPickerPurpose &&
          !providerSetupCatalog &&
          !resumeOpen &&
          !agentPanelOpen &&
          !configOpen ? (
            <TaskList rows={rows} tasks={tasks} width={contentWidth} />
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
              onAbort={interruptActiveOperation}
              onApprove={handlePlanApprove}
              onCycleMode={cyclePermissionMode}
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
          ) : resumeOpen ? (
            <ResumePanel
              loadSessions={listResumableSessions}
              maxVisible={Math.max(3, Math.min(10, rows - 13))}
              onCancel={() => setResumeOpen(false)}
              onComplete={completeResume}
              onResume={runResume}
              width={contentWidth}
            />
          ) : providerSetupCatalog ? (
            <ProviderSetupPanel
              catalog={providerSetupCatalog}
              maxVisible={Math.max(4, Math.min(10, rows - 13))}
              onboarding={providerSetupOnboarding}
              startDeviceLogin={providerSetupDeviceLogin}
              onCancel={closeProviderSetup}
              onReadyFromStore={completeProviderSetupFromStore}
              onSave={saveProviderSetup}
              width={contentWidth}
            />
          ) : effortConfiguration ? (
            <EffortPanel
              configuration={effortConfiguration}
              onApply={(intensity) => saveThinkingIntensity(effortConfiguration, intensity)}
              onCancel={() => setEffortConfiguration(null)}
              saving={effortSaving}
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
                  ? t('cli.model.selectCompression', 'Select compression model')
                  : t('cli.model.selectStepOne', 'Select model ? Step 1 of 2')
              }
              maxVisible={Math.max(4, Math.min(12, rows - 12))}
              onCancel={closeModelPicker}
              onConfigureProvider={() => {
                const returnToConfig = modelPickerReturnToConfig
                setModelPickerPurpose(null)
                setModelPickerReturnToConfig(false)
                openProviderSetup(returnToConfig)
              }}
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
                  ? t(
                      'cli.model.compressionSummary',
                      'Use any enabled model from a connected provider, or follow the current session model'
                    )
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
              onOpenProvider={() => openProviderSetup(true)}
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
              images={promptImages}
              initialValue={initialPrompt}
              isRunning={isRunning}
              onAbort={interruptActiveOperation}
              onCycleMode={cyclePermissionMode}
              onExit={exit}
              onListRewindCheckpoints={listRewindCheckpoints}
              onNotice={showNotice}
              onOpenAgents={openAgentPanel}
              onOpenModel={openModelPicker}
              onRedraw={redraw}
              onImagesChange={setPromptImages}
              onReferencesChange={setPromptReferences}
              onRewind={runRewind}
              onSearchFiles={searchFiles}
              onSubmit={handleSubmit}
              onToggleDetails={toggleDetails}
              onToggleHelp={() => setShowHelp((current) => !current)}
              onToggleTasks={() => setShowTasks((current) => !current)}
              showHelp={showHelp}
              supportsVision={supportsVision}
              references={promptReferences}
              width={contentWidth}
            />
          )}

          <StatusLine
            activity={
              turnStatus ||
              (assistantThinking && activity === t('cli.statuses.working', 'Working?'))
                ? undefined
                : activity
            }
            context={runtimeMetrics.context}
            hideIdleHint={Boolean(turnStatus) || assistantThinking}
            model={modelSelection?.modelName ?? t('cli.statusLine.noModel', 'No model')}
            mode={permissionMode}
            notice={notice}
            thinking={formatThinkingStatus({
              reasoningEffort: effort,
              reasoningEffortLevels: availableEffortLevels,
              supportsThinking,
              thinkingEnabled
            })}
            turnStatus={turnStatus}
            usage={runtimeMetrics.usage}
            width={contentWidth}
          />
        </Box>
      </Box>
    </>
  )
}
