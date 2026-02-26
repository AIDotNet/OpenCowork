import { useCallback, useEffect } from 'react'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { runAgentLoop } from '@renderer/lib/agent/agent-loop'
import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { buildSystemPrompt } from '@renderer/lib/agent/system-prompt'
import { subAgentEvents } from '@renderer/lib/agent/sub-agents/events'
import { abortAllTeammates } from '@renderer/lib/agent/teams/teammate-runner'
import { TEAM_TOOL_NAMES } from '@renderer/lib/agent/teams/register'
import { teamEvents } from '@renderer/lib/agent/teams/events'
import { useTeamStore } from '@renderer/stores/team-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { clearPendingQuestions } from '@renderer/lib/tools/ask-user-tool'

import { PLAN_MODE_ALLOWED_TOOLS } from '@renderer/lib/tools/plan-tool'
import { usePlanStore } from '@renderer/stores/plan-store'
import { createProvider } from '@renderer/lib/api/provider'
import { generateSessionTitle } from '@renderer/lib/api/generate-title'
import type {
  UnifiedMessage,
  ProviderConfig,
  TokenUsage,
  RequestDebugInfo,
  ContentBlock,
  RequestTiming
} from '@renderer/lib/api/types'
import { setLastDebugInfo } from '@renderer/lib/debug-store'
import type { ImageAttachment } from '@renderer/components/chat/InputArea'
import type { AgentLoopConfig } from '@renderer/lib/agent/types'
import { ApiStreamError } from '@renderer/lib/ipc/api-stream'
import { compressMessages } from '@renderer/lib/agent/context-compression'
import type { CompressionConfig } from '@renderer/lib/agent/context-compression'
import { usePluginStore } from '@renderer/stores/plugin-store'
import { registerPluginTools, unregisterPluginTools, isPluginToolsRegistered } from '@renderer/lib/plugins/plugin-tools'
import { useMcpStore } from '@renderer/stores/mcp-store'
import { registerMcpTools, unregisterMcpTools, isMcpToolsRegistered } from '@renderer/lib/mcp/mcp-tools'
import {
  joinFsPath,
  loadOptionalMemoryFile,
  loadGlobalMemorySnapshot
} from '@renderer/lib/agent/memory-files'

/** Per-session abort controllers — module-level so concurrent sessions don't overwrite each other */
const sessionAbortControllers = new Map<string, AbortController>()

type MessageSource = 'team' | 'queued'

interface QueuedSessionMessage {
  id: string
  text: string
  images?: ImageAttachment[]
  source?: MessageSource
  createdAt: number
}

/** Per-session pending user sends while the agent is already running. */
const pendingSessionMessages = new Map<string, QueuedSessionMessage[]>()
const pendingSessionMessageViews = new Map<string, PendingSessionMessageItem[]>()
const pendingSessionMessageListeners = new Set<() => void>()

const QUEUED_MESSAGE_SYSTEM_REMIND = `<system-reminder>
A new user message was queued while you were still processing the previous request.
This message was inserted after that run finished.
Treat the following user query as the latest instruction and respond to it directly.
</system-reminder>`

const QUEUED_IMAGE_ONLY_TEXT = '[User attached images without additional text.]'

function cloneImageAttachments(images?: ImageAttachment[]): ImageAttachment[] | undefined {
  if (!images || images.length === 0) return undefined
  return images.map((img) => ({ ...img }))
}

function notifyPendingSessionMessageListeners(): void {
  for (const listener of pendingSessionMessageListeners) {
    listener()
  }
}

function replaceSessionPendingMessages(sessionId: string, next: QueuedSessionMessage[]): void {
  if (next.length === 0) {
    pendingSessionMessages.delete(sessionId)
    pendingSessionMessageViews.delete(sessionId)
  } else {
    pendingSessionMessages.set(sessionId, next)
    pendingSessionMessageViews.set(sessionId, next.map(toPendingItem))
  }
  notifyPendingSessionMessageListeners()
}

export interface PendingSessionMessageItem {
  id: string
  text: string
  images: ImageAttachment[]
  createdAt: number
}

const EMPTY_PENDING_SESSION_MESSAGES: PendingSessionMessageItem[] = []

function toPendingItem(msg: QueuedSessionMessage): PendingSessionMessageItem {
  return {
    id: msg.id,
    text: msg.text,
    images: cloneImageAttachments(msg.images) ?? [],
    createdAt: msg.createdAt,
  }
}

export function subscribePendingSessionMessages(listener: () => void): () => void {
  pendingSessionMessageListeners.add(listener)
  return () => {
    pendingSessionMessageListeners.delete(listener)
  }
}

export function getPendingSessionMessages(sessionId: string): PendingSessionMessageItem[] {
  return pendingSessionMessageViews.get(sessionId) ?? EMPTY_PENDING_SESSION_MESSAGES
}

export function updatePendingSessionMessageText(sessionId: string, messageId: string, text: string): boolean {
  const queue = pendingSessionMessages.get(sessionId)
  if (!queue || queue.length === 0) return false
  let changed = false
  const next = queue.map((msg) => {
    if (msg.id !== messageId) return msg
    changed = true
    return { ...msg, text }
  })
  if (!changed) return false
  replaceSessionPendingMessages(sessionId, next)
  return true
}

export function removePendingSessionMessage(sessionId: string, messageId: string): boolean {
  const queue = pendingSessionMessages.get(sessionId)
  if (!queue || queue.length === 0) return false
  const next = queue.filter((msg) => msg.id !== messageId)
  if (next.length === queue.length) return false
  replaceSessionPendingMessages(sessionId, next)
  return true
}

function hasActiveSessionRun(sessionId: string): boolean {
  const hasAbortController = sessionAbortControllers.has(sessionId)
  const hasStreamingMessage = Boolean(useChatStore.getState().streamingMessages[sessionId])
  return hasAbortController || hasStreamingMessage
}

export function hasActiveSessionRunForSession(sessionId: string): boolean {
  return hasActiveSessionRun(sessionId)
}

function enqueuePendingSessionMessage(
  sessionId: string,
  msg: Omit<QueuedSessionMessage, 'id' | 'createdAt'>
): number {
  const queue = pendingSessionMessages.get(sessionId) ?? []
  const next = [
    ...queue,
    {
      id: nanoid(),
      createdAt: Date.now(),
      text: msg.text,
      images: cloneImageAttachments(msg.images),
      source: msg.source,
    },
  ]
  replaceSessionPendingMessages(sessionId, next)
  return next.length
}

function dequeuePendingSessionMessage(sessionId: string): QueuedSessionMessage | null {
  const queue = pendingSessionMessages.get(sessionId)
  if (!queue || queue.length === 0) return null
  const [head, ...rest] = queue
  replaceSessionPendingMessages(sessionId, rest)
  return {
    ...head,
    text: head.text,
    images: cloneImageAttachments(head.images),
  }
}

function hasPendingSessionMessages(sessionId: string): boolean {
  const queue = pendingSessionMessages.get(sessionId)
  return !!queue && queue.length > 0
}

export function hasPendingSessionMessagesForSession(sessionId: string): boolean {
  return hasPendingSessionMessages(sessionId)
}

// ── Team lead auto-trigger: teammate messages → new agent turn ──

/** Module-level ref to the latest sendMessage function from the hook */
let _sendMessageFn:
  | ((text: string, images?: ImageAttachment[], source?: MessageSource, targetSessionId?: string) => Promise<void>)
  | null = null

/** Queue of teammate messages to lead waiting to be processed */
const pendingLeadMessages: { from: string; content: string }[] = []

/** Whether the global team-message listener is registered */
let _teamLeadListenerActive = false

/** Counter for consecutive auto-triggered turns (reset on user-initiated sendMessage) */
let _autoTriggerCount = 0
const MAX_AUTO_TRIGGERS = 10
// 0 => unlimited iterations (run until loop_end by completion/error/abort)
const DEFAULT_AGENT_MAX_ITERATIONS = 0

/** Debounce timer for batching teammate reports before draining */
let _drainTimer: ReturnType<typeof setTimeout> | null = null
const DRAIN_DEBOUNCE_MS = 800

/** Schedule a debounced drain — collects reports arriving within the window into one batch */
function scheduleDrain(): void {
  if (_drainTimer) clearTimeout(_drainTimer)
  _drainTimer = setTimeout(() => {
    _drainTimer = null
    drainLeadMessages()
  }, DRAIN_DEBOUNCE_MS)
}

/** Global pause flag — set by stopStreaming to halt all auto-triggering */
let _autoTriggerPaused = false

/**
 * Reset the team auto-trigger state. Called from stopStreaming
 * to break the dead loop: abort → completion message → new turn → re-spawn.
 */
export function resetTeamAutoTrigger(): void {
  pendingLeadMessages.length = 0
  _autoTriggerCount = 0
  _autoTriggerPaused = true
}

/**
 * Set up a persistent listener on teamEvents that captures messages
 * addressed to "lead" and auto-triggers a new main agent turn.
 *
 * Called once; idempotent.
 */
function ensureTeamLeadListener(): void {
  if (_teamLeadListenerActive) return
  _teamLeadListenerActive = true

  teamEvents.on((event) => {
    if (event.type === 'team_message' && event.message.to === 'lead') {
      pendingLeadMessages.push({ from: event.message.from, content: event.message.content })
      scheduleDrain()
    }
    // Clear queue and reset counter when team is deleted
    if (event.type === 'team_end') {
      pendingLeadMessages.length = 0
      _autoTriggerCount = 0
      if (_drainTimer) { clearTimeout(_drainTimer); _drainTimer = null }
    }
  })
}

/**
 * Drain ALL pending lead messages as a single batched message.
 * Appends team progress info so the lead knows the overall status.
 * Skips if the active session's agent is already running.
 */
function drainLeadMessages(): void {
  if (pendingLeadMessages.length === 0) return
  if (!_sendMessageFn) return
  if (_autoTriggerPaused) return

  // Safety: stop auto-triggering after too many consecutive turns
  if (_autoTriggerCount >= MAX_AUTO_TRIGGERS) {
    console.warn(
      `[Team] Auto-trigger limit reached (${MAX_AUTO_TRIGGERS}). ` +
        `${pendingLeadMessages.length} messages pending. Waiting for user input.`
    )
    return
  }

  const activeSessionId = useChatStore.getState().activeSessionId
  if (!activeSessionId) return

  const status = useAgentStore.getState().runningSessions[activeSessionId]
  if (status === 'running') return // will be retried via scheduleDrain from finally block

  // Batch all pending messages into one combined message
  const batch = pendingLeadMessages.splice(0, pendingLeadMessages.length)
  const parts = batch.map((msg) => `[Team message from ${msg.from}]:\n${msg.content}`)

  // Append team progress summary so the lead can decide whether to wait or summarize
  const team = useTeamStore.getState().activeTeam
  if (team) {
    const total = team.tasks.length
    const completed = team.tasks.filter((t) => t.status === 'completed').length
    const inProgress = team.tasks.filter((t) => t.status === 'in_progress').length
    const pending = team.tasks.filter((t) => t.status === 'pending').length
    parts.push(
      `\n---\n**Team Progress**: ${completed}/${total} tasks completed` +
        (inProgress > 0 ? `, ${inProgress} in progress` : '') +
        (pending > 0 ? `, ${pending} pending` : '') +
        (completed < total
          ? '. Other teammates are still working — review the report(s) above, then end your turn and wait for remaining reports unless immediate action is needed.'
          : '. All tasks completed — compile the final summary from all reports and then call TeamDelete to clean up the team.')
    )
  }

  const text = parts.join('\n\n')
  _autoTriggerCount++
  _sendMessageFn(text, undefined, 'team')
}

function dispatchNextQueuedMessage(sessionId: string): boolean {
  if (!_sendMessageFn) return false

  const sessionExists = useChatStore.getState().sessions.some((s) => s.id === sessionId)
  if (!sessionExists) {
    replaceSessionPendingMessages(sessionId, [])
    return false
  }

  if (hasActiveSessionRun(sessionId)) return false

  const next = dequeuePendingSessionMessage(sessionId)
  if (!next) return false

  setTimeout(() => {
    void _sendMessageFn?.(next.text, next.images, next.source ?? 'queued', sessionId)
  }, 0)
  return true
}

export function dispatchNextQueuedMessageForSession(sessionId: string): boolean {
  return dispatchNextQueuedMessage(sessionId)
}

/**
 * Abort all running tasks for a specific session (agent loop + teammates).
 * Safe to call even if the session has nothing running.
 */
export function abortSession(sessionId: string): void {
  // Abort session agent loop
  const ac = sessionAbortControllers.get(sessionId)
  if (ac) {
    ac.abort()
    sessionAbortControllers.delete(sessionId)
  }
  // Clean up streaming / status state
  useChatStore.getState().setStreamingMessageId(sessionId, null)
  useAgentStore.getState().setSessionStatus(sessionId, null)

  // Clear any pending AskUserQuestion promises
  clearPendingQuestions()

  // If the active team belongs to this session, abort all teammates
  const team = useTeamStore.getState().activeTeam
  if (team?.sessionId === sessionId) {
    resetTeamAutoTrigger()
    abortAllTeammates()
    useAgentStore.getState().clearPendingApprovals()
  }

  // Derive global isRunning from remaining running sessions
  const hasOtherRunning = Object.values(useAgentStore.getState().runningSessions).some(
    (s) => s === 'running'
  )
  if (!hasOtherRunning) {
    useAgentStore.getState().setRunning(false)
    useAgentStore.getState().abort()
  }
}

// 60fps flush causes expensive markdown + layout work during panel resizing.
// 33ms keeps streaming smooth while lowering render/reflow pressure.
const STREAM_DELTA_FLUSH_MS = 33

interface StreamDeltaBuffer {
  pushThinking: (chunk: string) => void
  pushText: (chunk: string) => void
  setToolInput: (toolUseId: string, input: Record<string, unknown>) => void
  flushNow: () => void
  dispose: () => void
}

function createStreamDeltaBuffer(sessionId: string, assistantMsgId: string): StreamDeltaBuffer {
  let thinkingBuffer = ''
  let textBuffer = ''
  const toolInputBuffer = new Map<string, Record<string, unknown>>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    if (!thinkingBuffer && !textBuffer && toolInputBuffer.size === 0) return

    const store = useChatStore.getState()

    if (thinkingBuffer) {
      store.appendThinkingDelta(sessionId, assistantMsgId, thinkingBuffer)
      thinkingBuffer = ''
    }

    if (textBuffer) {
      store.appendTextDelta(sessionId, assistantMsgId, textBuffer)
      textBuffer = ''
    }

    if (toolInputBuffer.size > 0) {
      for (const [toolUseId, input] of toolInputBuffer) {
        store.updateToolUseInput(sessionId, assistantMsgId, toolUseId, input)
      }
      toolInputBuffer.clear()
    }
  }

  const scheduleFlush = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      flushNow()
    }, STREAM_DELTA_FLUSH_MS)
  }

  return {
    pushThinking: (chunk: string) => {
      if (!chunk) return
      thinkingBuffer += chunk
      scheduleFlush()
    },
    pushText: (chunk: string) => {
      if (!chunk) return
      textBuffer += chunk
      scheduleFlush()
    },
    setToolInput: (toolUseId: string, input: Record<string, unknown>) => {
      toolInputBuffer.set(toolUseId, input)
      scheduleFlush()
    },
    flushNow,
    dispose: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      thinkingBuffer = ''
      textBuffer = ''
      toolInputBuffer.clear()
    }
  }
}

export function useChatActions(): {
  sendMessage: (
    text: string,
    images?: ImageAttachment[],
    source?: MessageSource,
    targetSessionId?: string
  ) => Promise<void>
  stopStreaming: () => void
  retryLastMessage: () => Promise<void>
  editAndResend: (newContent: string) => Promise<void>
  manualCompressContext: (focusPrompt?: string) => Promise<void>
} {
  const sendMessage = useCallback(async (
    text: string,
    images?: ImageAttachment[],
    source?: MessageSource,
    targetSessionId?: string
  ): Promise<void> => {
    // Reset auto-trigger counter and unpause when user manually sends a message
    if (source !== 'team') {
      _autoTriggerCount = 0
      _autoTriggerPaused = false
    }

    const chatStore = useChatStore.getState()
    const settings = useSettingsStore.getState()
    const agentStore = useAgentStore.getState()
    const uiStore = useUIStore.getState()

    // Build provider config from provider-store (new system) with fallback to settings-store
    const providerConfig = useProviderStore.getState().getActiveProviderConfig()
    const effectiveMaxTokens = useProviderStore.getState().getEffectiveMaxTokens(settings.maxTokens)
    const activeModelThinkingConfig = useProviderStore.getState().getActiveModelThinkingConfig()
    const thinkingEnabled = settings.thinkingEnabled && !!activeModelThinkingConfig
    const activeModelConfig = useProviderStore.getState().getActiveModelConfig()
    const baseProviderConfig: ProviderConfig | null = providerConfig
      ? {
          ...providerConfig,
          maxTokens: effectiveMaxTokens,
          temperature: settings.temperature,
          systemPrompt: settings.systemPrompt || undefined,
          thinkingEnabled,
          thinkingConfig: activeModelThinkingConfig,
          reasoningEffort: settings.reasoningEffort,
          responseSummary: activeModelConfig?.responseSummary,
          enablePromptCache: activeModelConfig?.enablePromptCache,
          enableSystemPromptCache: activeModelConfig?.enableSystemPromptCache
        }
      : settings.apiKey
        ? {
            type: settings.provider,
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl || undefined,
            model: settings.model,
            maxTokens: effectiveMaxTokens,
            temperature: settings.temperature,
            systemPrompt: settings.systemPrompt || undefined,
            thinkingEnabled,
            thinkingConfig: activeModelThinkingConfig,
            reasoningEffort: settings.reasoningEffort,
            responseSummary: activeModelConfig?.responseSummary,
            enablePromptCache: activeModelConfig?.enablePromptCache,
            enableSystemPromptCache: activeModelConfig?.enableSystemPromptCache
          }
        : null

    if (!baseProviderConfig || (!baseProviderConfig.apiKey && baseProviderConfig.requiresApiKey !== false)) {
      toast.error('API key required', {
        description: 'Please configure an AI provider in Settings',
        action: { label: 'Open Settings', onClick: () => uiStore.openSettingsPage('provider') }
      })
      return
    }

    if (targetSessionId && !chatStore.sessions.some((s) => s.id === targetSessionId)) {
      // Session may have been created externally (e.g. plugin auto-reply in main process).
      // Try reloading from DB before giving up.
      console.log(`[sendMessage] Session ${targetSessionId} not in store, reloading from DB...`)
      await useChatStore.getState().loadFromDb()
      const refreshedStore = useChatStore.getState()
      if (!refreshedStore.sessions.some((s) => s.id === targetSessionId)) {
        console.warn(`[sendMessage] Session ${targetSessionId} still not found after DB reload, aborting`)
        replaceSessionPendingMessages(targetSessionId, [])
        return
      }
    }

    // Ensure we have an active session
    let sessionId = targetSessionId ?? chatStore.activeSessionId
    if (!sessionId) {
      sessionId = chatStore.createSession(uiStore.mode)
    }
    await chatStore.loadSessionMessages(sessionId)

    const sessionForSsh = chatStore.sessions.find((s) => s.id === sessionId)
    if (sessionForSsh?.sshConnectionId) {
      const sshStore = useSshStore.getState()
      const connectionId = sessionForSsh.sshConnectionId
      const connectionName =
        sshStore.connections.find((c) => c.id === connectionId)?.name ?? connectionId
      const existing = Object.values(sshStore.sessions).find(
        (s) => s.connectionId === connectionId && s.status === 'connected'
      )
      if (!existing) {
        const connectedId = await sshStore.connect(connectionId)
        if (!connectedId) {
          toast.error('SSH connection unavailable', {
            description: connectionName,
          })
          return
        }
      }

      const workingFolder = sessionForSsh.workingFolder?.trim()
      if (workingFolder) {
        const mkdirResult = (await ipcClient.invoke(IPC.SSH_FS_MKDIR, {
          connectionId,
          path: workingFolder,
        })) as { error?: string }
        if (mkdirResult?.error) {
          toast.error('SSH working directory unavailable', {
            description: mkdirResult.error,
          })
          return
        }
      }
    }

    const hasActiveRun = hasActiveSessionRun(sessionId)
    const statusIsRunning = useAgentStore.getState().runningSessions[sessionId] === 'running'
    const shouldQueue = hasActiveRun || (statusIsRunning && source !== 'queued')

    if (shouldQueue) {
      enqueuePendingSessionMessage(sessionId, { text, images, source })
      return
    }

    // After a manual abort, stale errored/orphaned tool blocks can remain at tail
    // and break the next request. Clean them before appending new user input.
    chatStore.sanitizeToolErrorsForResend(sessionId)

    // Strip old system-reminder blocks from previous messages to prevent accumulation
    chatStore.stripOldSystemReminders(sessionId)

    baseProviderConfig.sessionId = sessionId

    // Override provider config if session has a bound provider+model (e.g. plugin sessions)
    // Only apply session-specific model overrides for plugin sessions (with pluginId)
    // Regular user sessions should use the global active provider/model from ModelSwitcher
    const sessionForProvider = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    if (sessionForProvider?.pluginId && sessionForProvider?.providerId && sessionForProvider?.modelId) {
      const sessionProviderConfig = useProviderStore.getState().getProviderConfigById(
        sessionForProvider.providerId, sessionForProvider.modelId
      )
      if (sessionProviderConfig?.apiKey) {
        baseProviderConfig.type = sessionProviderConfig.type
        baseProviderConfig.apiKey = sessionProviderConfig.apiKey
        baseProviderConfig.baseUrl = sessionProviderConfig.baseUrl
        baseProviderConfig.model = sessionProviderConfig.model
        baseProviderConfig.requiresApiKey = sessionProviderConfig.requiresApiKey
        baseProviderConfig.responseSummary = sessionProviderConfig.responseSummary
          ?? useProviderStore.getState().getActiveModelConfig()?.responseSummary
        baseProviderConfig.enablePromptCache = sessionProviderConfig.enablePromptCache
          ?? useProviderStore.getState().getActiveModelConfig()?.enablePromptCache
        baseProviderConfig.enableSystemPromptCache = sessionProviderConfig.enableSystemPromptCache
          ?? useProviderStore.getState().getActiveModelConfig()?.enableSystemPromptCache
      }
    }

    const sessionSnapshot = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    const sessionMode = sessionSnapshot?.mode ?? uiStore.mode

    // Add user message (multi-modal when images attached)
    let userContent: string | ContentBlock[]
    const isQueuedInsertion = source === 'queued'
    const normalizedText = text.trim()
    const textForUserBlock = normalizedText || (images && images.length > 0 ? QUEUED_IMAGE_ONLY_TEXT : '')

    if (isQueuedInsertion) {
      const queuedBlocks: ContentBlock[] = [
        { type: 'text', text: QUEUED_MESSAGE_SYSTEM_REMIND },
        { type: 'text', text: textForUserBlock || text }
      ]
      if (images && images.length > 0) {
        queuedBlocks.push(
          ...images.map((img) => {
            const base64 = img.dataUrl.replace(/^data:[^;]+;base64,/, '')
            return {
              type: 'image' as const,
              source: { type: 'base64' as const, mediaType: img.mediaType, data: base64 }
            }
          })
        )
      }
      userContent = queuedBlocks
    } else if (images && images.length > 0) {
      // Images present: always use ContentBlock[] format
      userContent = [
        ...images.map((img) => {
          const base64 = img.dataUrl.replace(/^data:[^;]+;base64,/, '')
          return {
            type: 'image' as const,
            source: { type: 'base64' as const, mediaType: img.mediaType, data: base64 }
          }
        }),
        ...(text ? [{ type: 'text' as const, text }] : [])
      ]
    } else {
      // No images: use simple string
      userContent = text
    }

    const userMsg: UnifiedMessage = {
      id: nanoid(),
      role: 'user',
      content: userContent,
      createdAt: Date.now(),
      ...(source && { source })
    }
    chatStore.addMessage(sessionId, userMsg)

    // Auto-title: fire-and-forget AI title + icon generation for the first message (skip for team notifications)
    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    if (session && session.title === 'New Conversation') {
      const capturedSessionId = sessionId
      generateSessionTitle(text)
        .then((result) => {
          if (result) {
            const store = useChatStore.getState()
            store.updateSessionTitle(capturedSessionId, result.title)
            store.updateSessionIcon(capturedSessionId, result.icon)
          }
        })
        .catch(() => {
          /* keep default title on failure */
        })
    }

    // Create assistant placeholder message
    const assistantMsgId = nanoid()
    const assistantMsg: UnifiedMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: Date.now()
    }
    chatStore.addMessage(sessionId, assistantMsg)
    chatStore.setStreamingMessageId(sessionId, assistantMsgId)

    // Setup abort controller (per-session)
    // If this session already has a running agent, abort it first
    const existingAc = sessionAbortControllers.get(sessionId)
    if (existingAc) existingAc.abort()
    const abortController = new AbortController()
    sessionAbortControllers.set(sessionId, abortController)

    const mode = sessionMode

    if (mode === 'chat') {
      // Simple chat mode: single API call, no tools
      const chatSystemPrompt = [
        'You are OpenCowork, a helpful AI assistant. Be concise, accurate, and friendly.',
        "Before responding, follow this thinking process: (1) Understand — identify what the user truly needs, not just the literal words; consider context and implicit constraints. (2) Expand — think about the best way to solve the problem, consider edge cases, potential pitfalls, and better alternatives the user may not have thought of. (3) Validate — before finalizing, verify your answer is logically consistent: does it actually help the user achieve their stated goal? Check the full causal chain — if the user follows your advice, will they accomplish what they want? Watch for hidden contradictions (e.g. if someone needs to wash their car, they must bring the car — suggesting they walk defeats the purpose). (4) Respond — deliver a well-reasoned, logically sound answer that best fits the user's real needs. Think first, answer second — never rush to conclusions.",
        'CRITICAL RULE: Before giving your final answer, always ask yourself: "If the user follows my advice step by step, will they actually achieve their stated goal?" If the answer is no, your response has a logical flaw — stop and reconsider. The user\'s goal defines the constraints; never give advice that makes the goal impossible.',
        'Use markdown formatting in your responses. Use code blocks with language identifiers for code.',
        settings.systemPrompt ? `\n## Additional Instructions\n${settings.systemPrompt}` : ''
      ]
        .filter(Boolean)
        .join('\n')
      // NOTE: thinkingEnabled is handled below when building the final config
      const chatConfig: ProviderConfig = { ...baseProviderConfig, systemPrompt: chatSystemPrompt }
      agentStore.setSessionStatus(sessionId, 'running')
      try {
        await runSimpleChat(sessionId, assistantMsgId, chatConfig, abortController.signal)
      } finally {
        agentStore.setSessionStatus(sessionId, 'completed')
        sessionAbortControllers.delete(sessionId)
        dispatchNextQueuedMessage(sessionId)
      }
    } else {
      // Cowork / Code mode: agent loop with tools
      const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)

      // Dynamic plugin tool registration based on active plugins
      const activePlugins = usePluginStore.getState().getActivePlugins()
      if (activePlugins.length > 0 && !isPluginToolsRegistered()) {
        registerPluginTools()
      } else if (activePlugins.length === 0 && isPluginToolsRegistered()) {
        unregisterPluginTools()
      }

      // Dynamic MCP tool registration based on active MCPs
      const activeMcps = useMcpStore.getState().getActiveMcps()
      const activeMcpTools = useMcpStore.getState().getActiveMcpTools()
      if (activeMcps.length > 0 && Object.keys(activeMcpTools).length > 0) {
        registerMcpTools(activeMcps, activeMcpTools)
      } else if (activeMcps.length === 0 && isMcpToolsRegistered()) {
        unregisterMcpTools()
      }

      // Filter out team tools when the feature is disabled. Capture after registration changes.
      const allToolDefs = toolRegistry.getDefinitions()
      const finalToolDefs = allToolDefs
      let finalEffectiveToolDefs = settings.teamToolsEnabled
        ? finalToolDefs
        : finalToolDefs.filter((t) => !TEAM_TOOL_NAMES.has(t.name))

      // Plan mode: restrict to read-only + planning tools
      const isPlanMode = useUIStore.getState().planMode
      if (isPlanMode) {
        finalEffectiveToolDefs = finalEffectiveToolDefs.filter((t) => PLAN_MODE_ALLOWED_TOOLS.has(t.name))
      }

      // Build plugin info for system prompt — inject plugin metadata + per-plugin system prompts
      let userPrompt = settings.systemPrompt || ''
      if (activePlugins.length > 0) {
        const pluginLines: string[] = ['\n## Active Plugins']
        for (const p of activePlugins) {
          pluginLines.push(`- **${p.name}** (plugin_id: \`${p.id}\`, type: ${p.type})`)
          if (p.userSystemPrompt?.trim()) {
            pluginLines.push(`  Plugin instructions: ${p.userSystemPrompt.trim()}`)
          }
        }
        // Check if any active plugin is Feishu (has file/image send capability)
        const hasFeishuPlugin = activePlugins.some((p) => p.type === 'feishu-bot')

        pluginLines.push(
          '',
          'Use the plugin_id parameter when calling Plugin* tools (PluginSendMessage, PluginReplyMessage, PluginGetGroupMessages, PluginListGroups, PluginSummarizeGroup).',
          'Always confirm with the user before sending messages on their behalf.',
          '',
          '### Generating & Delivering Files via Plugins',
          'When the user asks you to generate reports, documents, or any deliverable and wants it sent to a chat:',
          '1. **Write the file** using the Write tool (e.g. `report.md`, `analysis.csv`, `summary.html`).',
          hasFeishuPlugin
            ? '2. **Send the file** using FeishuSendFile (for Feishu chats) or share key content via PluginSendMessage (for other platforms).'
            : '2. **Share the content** via PluginSendMessage, or inform the user where the file was saved.',
          '3. **Provide a brief summary** in your response so the user knows what was generated.',
          'Prefer writing to a file + sending it over pasting long content (>30 lines) directly in chat messages.'
        )
        const pluginSection = pluginLines.join('\n')
        userPrompt = userPrompt ? `${userPrompt}\n${pluginSection}` : pluginSection
      }

      // Build MCP info for system prompt — inject active MCP server metadata and tool mappings
      if (activeMcps.length > 0) {
        const mcpLines: string[] = ['\n## Active MCP Servers']
        for (const srv of activeMcps) {
          const tools = activeMcpTools[srv.id] ?? []
          mcpLines.push(`- **${srv.name}** (${tools.length} tools, transport: ${srv.transport})`)
          if (srv.description?.trim()) {
            mcpLines.push(`  ${srv.description.trim()}`)
          }
          if (tools.length > 0) {
            mcpLines.push(`  Available tools: ${tools.map((t) => `\`mcp__${srv.id}__${t.name}\``).join(', ')}`)
          }
        }
        mcpLines.push(
          '',
          'MCP tools are prefixed with `mcp__{serverId}__{toolName}`. Call them like any other tool — they are routed to the corresponding MCP server automatically.',
          'MCP tools require user approval before execution.'
        )
        const mcpSection = mcpLines.join('\n')
        userPrompt = userPrompt ? `${userPrompt}\n${mcpSection}` : mcpSection
      }

      // Plugin session context: inject reply instructions when this session belongs to a plugin
      if (session?.pluginId && session?.externalChatId) {
        const pluginMeta = usePluginStore.getState().plugins.find((p) => p.id === session.pluginId)
        const chatId = session.externalChatId.replace(/^plugin:[^:]+:chat:/, '')
        const isFeishu = pluginMeta?.type === 'feishu-bot'
        const pluginCtx = [
          `\n## Plugin Auto-Reply Context`,
          `This session is handling messages from plugin **${pluginMeta?.name ?? session.pluginId}** (plugin_id: \`${session.pluginId}\`).`,
          `Chat ID: \`${chatId}\``,
          `Your response will be streamed directly to the user in real-time via the plugin.`,
          `Just respond naturally — the streaming pipeline handles delivery automatically.`,
          `If you need to send an additional message, use PluginSendMessage with plugin_id="${session.pluginId}" and chat_id="${chatId}".`,
          isFeishu ? [
            `\n### Feishu Media Tools`,
            `You can send images and files to this chat:`,
            `- **FeishuSendImage**: Send an image file (screenshot, generated image, etc.)`,
            `- **FeishuSendFile**: Send a file (PDF, document, spreadsheet, etc.)`,
            `Both require plugin_id="${session.pluginId}" and chat_id="${chatId}".`,
          ].join('\n') : '',
          pluginMeta?.userSystemPrompt?.trim() ? `\nPlugin-specific instructions: ${pluginMeta.userSystemPrompt.trim()}` : '',
        ].filter(Boolean).join('\n')
        userPrompt = userPrompt ? `${userPrompt}\n${pluginCtx}` : pluginCtx
      }

      // Load AGENTS.md memory file from working directory
      let agentsMemory: string | undefined
      let globalMemory: string | undefined
      if (session?.workingFolder) {
        const projectMemoryPath = joinFsPath(session.workingFolder, 'AGENTS.md')
        agentsMemory = await loadOptionalMemoryFile(ipcClient, projectMemoryPath)
      }

      const globalMemorySnapshot = await loadGlobalMemorySnapshot(ipcClient)
      globalMemory = globalMemorySnapshot.content
      const globalMemoryPath = globalMemorySnapshot.path

      const agentSystemPrompt = buildSystemPrompt({
        mode: mode as 'cowork' | 'code',
        workingFolder: session?.workingFolder,
        userSystemPrompt: userPrompt || undefined,
        toolDefs: finalEffectiveToolDefs,
        language: useSettingsStore.getState().language,
        planMode: isPlanMode,
        agentsMemory,
        globalMemory,
        globalMemoryPath
      })
      const agentProviderConfig: ProviderConfig = {
        ...baseProviderConfig,
        systemPrompt: agentSystemPrompt
      }
      // Context compression setup
      const activeModelCfg = useProviderStore.getState().getActiveModelConfig()
      const compressionConfig: CompressionConfig | null =
        settings.contextCompressionEnabled && activeModelCfg?.contextLength
          ? { enabled: true, contextLength: activeModelCfg.contextLength, threshold: 0.8, preCompressThreshold: 0.65 }
          : null

      const loopConfig: AgentLoopConfig = {
        maxIterations: DEFAULT_AGENT_MAX_ITERATIONS,
        provider: agentProviderConfig,
        tools: finalEffectiveToolDefs,
        systemPrompt: agentSystemPrompt,
        workingFolder: session?.workingFolder,
        signal: abortController.signal,
        ...(compressionConfig && {
          contextCompression: {
            config: compressionConfig,
            compressFn: async (msgs) => {
              // If session has an active plan, pin its file path so compression preserves plan context
              let planPinnedContext: string | undefined
              if (sessionId) {
                const plan = usePlanStore.getState().getPlanBySession(sessionId)
                if (plan && plan.filePath) {
                  planPinnedContext = `[Active plan: ${plan.title} — file: ${plan.filePath}]`
                }
              }
              const { messages: compressed } = await compressMessages(
                msgs,
                agentProviderConfig, // use main model
                abortController.signal,
                undefined,
                undefined,
                planPinnedContext
              )
              // Sync compressed messages to chat store
              if (sessionId) {
                useChatStore.getState().replaceSessionMessages(sessionId, compressed)
              }
              return compressed
            }
          }
        })
      }

      agentStore.setRunning(true)
      agentStore.setSessionStatus(sessionId, 'running')
      agentStore.clearToolCalls()

      // Accumulate usage across all iterations + SubAgent runs
      const accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
      const requestTimings: RequestTiming[] = []
      const loopStartedAt = Date.now()

      // Subscribe to SubAgent events during agent loop
      const unsubSubAgent = subAgentEvents.on((event) => {
        useAgentStore.getState().handleSubAgentEvent(event, sessionId!)
        // Accumulate SubAgent token usage into the parent message
        if (event.type === 'sub_agent_end' && event.result?.usage) {
          mergeUsage(accumulatedUsage, event.result.usage)
          useChatStore
            .getState()
            .updateMessage(sessionId!, assistantMsgId, { usage: { ...accumulatedUsage } })
        }
      })

      // NOTE: Team events are handled by a persistent global subscription
      // in register.ts — not scoped here, because teammate loops outlive the lead's loop.

      // Request notification permission on first agent run
      if (Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {})
      }

      let streamDeltaBuffer: StreamDeltaBuffer | null = null

      // Extract plugin context from session so tools like CronAdd can auto-inject plugin routing
      const sessionPluginId = session?.pluginId
      const sessionPluginChatId = session?.externalChatId
        ? session.externalChatId.replace(/^plugin:[^:]+:chat:/, '')
        : undefined

      try {
        const messages = useChatStore.getState().getSessionMessages(sessionId)
        let messagesToSend = messages.slice(0, -1) // Exclude the empty assistant placeholder

        // Build and inject dynamic context into the last user message
        const sessionSnapshot = useChatStore.getState().sessions.find((s) => s.id === sessionId)
        const sessionMode = sessionSnapshot?.mode ?? uiStore.mode
        const shouldInjectContext = (sessionMode === 'cowork' || sessionMode === 'code')

        if (shouldInjectContext && messagesToSend.length > 0) {
          const { buildDynamicContext } = await import('@renderer/lib/agent/dynamic-context')
          const dynamicContext = buildDynamicContext({ sessionId })

          if (dynamicContext) {
            // Find the last user message and prepend dynamic context to its content
            const lastUserIndex = messagesToSend.findLastIndex(m => m.role === 'user')
            if (lastUserIndex >= 0) {
              const lastUserMsg = messagesToSend[lastUserIndex]
              const contextBlock = { type: 'text' as const, text: dynamicContext }

              let newContent: ContentBlock[]
              if (typeof lastUserMsg.content === 'string') {
                newContent = [contextBlock, { type: 'text' as const, text: lastUserMsg.content }]
              } else {
                newContent = [contextBlock, ...lastUserMsg.content]
              }

              console.log('[Dynamic Context] Injecting context into last user message:', {
                messageId: lastUserMsg.id,
                originalContentType: typeof lastUserMsg.content,
                newContentLength: newContent.length,
                contextPreview: dynamicContext.substring(0, 100)
              })

              messagesToSend = [
                ...messagesToSend.slice(0, lastUserIndex),
                { ...lastUserMsg, content: newContent },
                ...messagesToSend.slice(lastUserIndex + 1)
              ]
            }
          }
        }

        const loop = runAgentLoop(
          messagesToSend,
          loopConfig,
          {
            sessionId,
            workingFolder: session?.workingFolder,
            sshConnectionId: session?.sshConnectionId,
            signal: abortController.signal,
            ipc: ipcClient,
            ...(sessionPluginId && sessionPluginChatId && {
              pluginId: sessionPluginId,
              pluginChatId: sessionPluginChatId,
            }),
          },
          async (tc) => {
            const autoApprove = useSettingsStore.getState().autoApprove
            if (autoApprove) return true
            // Per-session tool approval memory: skip re-approval for previously approved tools
            const approved = useAgentStore.getState().approvedToolNames
            if (approved.includes(tc.name)) return true
            const result = await agentStore.requestApproval(tc.id)
            if (result) useAgentStore.getState().addApprovedTool(tc.name)
            return result
          }
        )

        let thinkingDone = false
        let hasThinkingDelta = false
        streamDeltaBuffer = createStreamDeltaBuffer(sessionId!, assistantMsgId)
        for await (const event of loop) {
          if (abortController.signal.aborted) break

          switch (event.type) {
            case 'thinking_delta':
              hasThinkingDelta = true
              streamDeltaBuffer.pushThinking(event.thinking)
              break

            case 'thinking_encrypted':
              if (event.thinkingEncryptedContent && event.thinkingEncryptedProvider) {
                useChatStore.getState().setThinkingEncryptedContent(
                  sessionId!,
                  assistantMsgId,
                  event.thinkingEncryptedContent,
                  event.thinkingEncryptedProvider
                )
              }
              break

            case 'text_delta':
              if (!thinkingDone) {
                const chunk = event.text ?? ''
                const closeThinkTagMatch = hasThinkingDelta
                  ? chunk.match(/<\s*\/\s*think\s*>/i)
                  : null
                const keepThinkingOpen = hasThinkingDelta && !closeThinkTagMatch
                if (!keepThinkingOpen) {
                  if (closeThinkTagMatch && closeThinkTagMatch.index !== undefined) {
                    const beforeClose = chunk.slice(0, closeThinkTagMatch.index)
                    const afterClose = chunk.slice(
                      closeThinkTagMatch.index + closeThinkTagMatch[0].length
                    )
                    if (beforeClose) {
                      streamDeltaBuffer.pushThinking(beforeClose)
                    }
                    streamDeltaBuffer.flushNow()
                    thinkingDone = true
                    useChatStore.getState().completeThinking(sessionId!, assistantMsgId)
                    if (afterClose) {
                      streamDeltaBuffer.pushText(afterClose)
                    }
                    break
                  }
                  thinkingDone = true
                  streamDeltaBuffer.flushNow()
                  useChatStore.getState().completeThinking(sessionId!, assistantMsgId)
                }
              }
              streamDeltaBuffer.pushText(event.text)
              break

            case 'tool_use_streaming_start':
              // Preserve stream order: flush any pending thinking/text before inserting tool block.
              streamDeltaBuffer.flushNow()
              if (!thinkingDone) {
                thinkingDone = true
                useChatStore.getState().completeThinking(sessionId!, assistantMsgId)
              }
              // Immediately show tool card with name while args are still streaming
              useChatStore.getState().appendToolUse(sessionId!, assistantMsgId, {
                type: 'tool_use',
                id: event.toolCallId,
                name: event.toolName,
                input: {}
              })
              useAgentStore.getState().addToolCall({
                id: event.toolCallId,
                name: event.toolName,
                input: {},
                status: 'streaming',
                requiresApproval: false
              })
              break

            case 'tool_use_args_delta':
              // Real-time partial args update via partial-json parsing
              streamDeltaBuffer.setToolInput(event.toolCallId, event.partialInput)
              useAgentStore.getState().updateToolCall(event.toolCallId, {
                input: event.partialInput
              })
              break

            case 'tool_use_generated':
              // Args fully streamed — update the existing block's input (final)
              streamDeltaBuffer.setToolInput(event.toolUseBlock.id, event.toolUseBlock.input)
              streamDeltaBuffer.flushNow()
              useAgentStore.getState().updateToolCall(event.toolUseBlock.id, {
                input: event.toolUseBlock.input
              })
              break

            case 'tool_call_start':
              useAgentStore.getState().addToolCall(event.toolCall)
              break

            case 'tool_call_approval_needed': {
              // Skip adding to pendingToolCalls when auto-approve is active —
              // the callback will return true immediately, so no dialog needed.
              const willAutoApprove =
                useSettingsStore.getState().autoApprove ||
                useAgentStore.getState().approvedToolNames.includes(event.toolCall.name)
              if (!willAutoApprove) {
                useAgentStore.getState().addToolCall(event.toolCall)
              }
              break
            }

            case 'tool_call_result':
              useAgentStore.getState().updateToolCall(event.toolCall.id, {
                status: event.toolCall.status,
                output: event.toolCall.output,
                error: event.toolCall.error,
                completedAt: event.toolCall.completedAt
              })
              break

            case 'iteration_end':
              streamDeltaBuffer.flushNow()
              // Reset so the next iteration's thinking block gets properly completed
              thinkingDone = false
              // When an iteration ends with tool results, append tool_result user message.
              // The next iteration's text/tool_use will continue appending to the same assistant message.
              if (event.toolResults && event.toolResults.length > 0) {
                const toolResultMsg: UnifiedMessage = {
                  id: nanoid(),
                  role: 'user',
                  content: event.toolResults.map((tr) => ({
                    type: 'tool_result' as const,
                    toolUseId: tr.toolUseId,
                    content: tr.content,
                    isError: tr.isError
                  })),
                  createdAt: Date.now()
                }
                useChatStore.getState().addMessage(sessionId!, toolResultMsg)
              }
              // If there are queued user messages, abort the loop now.
              // At this point tools have finished and tool_results are appended,
              // so aborting here prevents the next API request from starting
              // and lets the finally block dispatch the queued message immediately.
              if (hasPendingSessionMessages(sessionId!)) {
                console.log(`[ChatActions] Queued message detected at iteration_end, aborting loop for session ${sessionId}`)
                abortController.abort()
              }
              break

            case 'message_end':
              streamDeltaBuffer.flushNow()
              if (!thinkingDone) {
                thinkingDone = true
                useChatStore.getState().completeThinking(sessionId!, assistantMsgId)
              }
              if (event.usage) {
                mergeUsage(accumulatedUsage, event.usage)
                // contextTokens = last API call's input tokens (overwrite, not accumulate)
                accumulatedUsage.contextTokens = event.usage.contextTokens ?? event.usage.inputTokens
              }
              if (event.timing) {
                requestTimings.push(event.timing)
                accumulatedUsage.requestTimings = [...requestTimings]
              }
              if (event.usage || event.timing) {
                useChatStore
                  .getState()
                  .updateMessage(sessionId!, assistantMsgId, { usage: { ...accumulatedUsage } })
              }
              break

            case 'loop_end': {
              streamDeltaBuffer.flushNow()
              accumulatedUsage.totalDurationMs = Date.now() - loopStartedAt
              if (requestTimings.length > 0) {
                accumulatedUsage.requestTimings = [...requestTimings]
              }
              useChatStore
                .getState()
                .updateMessage(sessionId!, assistantMsgId, { usage: { ...accumulatedUsage } })
              break
            }

            case 'request_debug':
              streamDeltaBuffer.flushNow()
              if (useSettingsStore.getState().devMode && event.debugInfo) {
                setLastDebugInfo(assistantMsgId, event.debugInfo)
              }
              break

            case 'context_compression_start':
              toast.info('正在压缩上下文...', { description: '历史消息将被压缩为记忆摘要' })
              break

            case 'context_compressed':
              toast.success('上下文已压缩', {
                description: `${event.originalCount} 条消息 → ${event.newCount} 条（核心信息已保留）`
              })
              break

            case 'error':
              streamDeltaBuffer.flushNow()
              console.error('[Agent Loop Error]', event.error)
              toast.error('Agent Error', { description: event.error.message })
              break
          }
        }
      } catch (err) {
        streamDeltaBuffer?.flushNow()
        console.error('[Agent Loop Exception]', err)
        if (!abortController.signal.aborted) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error('[Agent Loop Exception]', err)
          toast.error('Agent failed', { description: errMsg })
          useChatStore
            .getState()
            .appendTextDelta(sessionId!, assistantMsgId, `\n\n> **Error:** ${errMsg}`)
          if (err instanceof ApiStreamError && useSettingsStore.getState().devMode) {
            setLastDebugInfo(assistantMsgId, err.debugInfo as RequestDebugInfo)
          }
        }
      } finally {
        streamDeltaBuffer?.flushNow()
        streamDeltaBuffer?.dispose()
        // Defensive cleanup: if provider stream ended without completing a tool call,
        // avoid leaving tool cards stuck at "receiving args".
        const { executedToolCalls, pendingToolCalls, updateToolCall } = useAgentStore.getState()
        for (const tc of [...executedToolCalls, ...pendingToolCalls]) {
          if (tc.status === 'streaming') {
            updateToolCall(tc.id, {
              status: 'error',
              error: 'Tool call stream ended before execution',
              completedAt: Date.now()
            })
          }
        }
        unsubSubAgent()
        agentStore.setSessionStatus(sessionId, 'completed')
        chatStore.setStreamingMessageId(sessionId, null)
        sessionAbortControllers.delete(sessionId)
        // Derive global isRunning from remaining running sessions
        const hasOtherRunning = Object.values(useAgentStore.getState().runningSessions).some(
          (s) => s === 'running'
        )
        agentStore.setRunning(hasOtherRunning)
        dispatchNextQueuedMessage(sessionId)
        // Notify when agent finishes and window is not focused
        if (!document.hasFocus() && Notification.permission === 'granted') {
          new Notification('OpenCowork', { body: 'Agent finished working', silent: true })
        }

        // If there's an active team, set up the lead message listener
        // and drain any messages that arrived while the loop was running.
        if (useTeamStore.getState().activeTeam) {
          ensureTeamLeadListener()
          // Schedule a debounced drain to batch reports that arrive close together
          scheduleDrain()
        }
      }
    }
  }, [])

  useEffect(() => {
    ensureTeamLeadListener()
    if (useTeamStore.getState().activeTeam) {
      scheduleDrain()
    }
  }, [])

  // Cron session delivery is now handled by cron-agent-runner.ts (deliveryMode='session')
  // No cron event subscription needed here.

  // Keep module-level ref updated for team lead auto-trigger + plugin auto-reply
  _sendMessageFn = sendMessage

  const stopStreaming = useCallback(() => {
    // Stop the active session's agent
    const activeId = useChatStore.getState().activeSessionId
    if (activeId) {
      const ac = sessionAbortControllers.get(activeId)
      if (ac) {
        ac.abort()
        sessionAbortControllers.delete(activeId)
      }
      useChatStore.getState().setStreamingMessageId(activeId, null)
      useAgentStore.getState().setSessionStatus(activeId, null)
    }
    // Only do global abort (which denies ALL pending approvals) when
    // no other sessions are still running — prevents cross-session interference.
    const otherRunning = Object.entries(useAgentStore.getState().runningSessions).some(
      ([id, s]) => id !== activeId && s === 'running'
    )
    if (!otherRunning) {
      useAgentStore.getState().setRunning(false)
      useAgentStore.getState().abort()
    }
    // Clear any pending AskUserQuestion promises so they don't hang
    clearPendingQuestions()
    // Reset team auto-trigger BEFORE aborting teammates.
    // abortAllTeammates() causes each teammate's finally block to run,
    // and we must ensure the queue is paused so no new turns are triggered.
    resetTeamAutoTrigger()
    abortAllTeammates()
  }, [])

  const retryLastMessage = useCallback(async () => {
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.activeSessionId
    if (!sessionId) return
    await chatStore.loadSessionMessages(sessionId)
    const lastUserText = chatStore.removeLastAssistantMessage(sessionId)
    if (lastUserText) {
      // Also remove the last user message — sendMessage will re-add it
      chatStore.removeLastUserMessage(sessionId)
      await sendMessage(lastUserText)
    }
  }, [sendMessage])

  const editAndResend = useCallback(
    async (newContent: string) => {
      stopStreaming()
      const chatStore = useChatStore.getState()
      const sessionId = chatStore.activeSessionId
      if (!sessionId) return
      await chatStore.loadSessionMessages(sessionId)
      const messages = chatStore.getSessionMessages(sessionId)
      // Find the last real user message (has text content, not just tool_result blocks)
      let editIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'user') {
          if (typeof m.content === 'string') {
            editIdx = i
            break
          }
          if (m.content.some((b) => b.type === 'text')) {
            editIdx = i
            break
          }
        }
      }
      if (editIdx < 0) return
      // Truncate from the edited message onward (removes it + all subsequent messages)
      chatStore.truncateMessagesFrom(sessionId, editIdx)
      // Re-send with edited content
      await sendMessage(newContent)
    },
    [sendMessage]
  )

  const manualCompressContext = useCallback(async (focusPrompt?: string) => {
    const chatStore = useChatStore.getState()
    const agentStore = useAgentStore.getState()
    const sessionId = chatStore.activeSessionId
    if (!sessionId) {
      toast.error('无法压缩', { description: '没有活跃的会话' })
      return
    }
    await chatStore.loadSessionMessages(sessionId)

    // Limitation 1: agent must not be running
    const sessionStatus = agentStore.runningSessions[sessionId]
    if (sessionStatus === 'running') {
      toast.error('无法压缩', { description: 'Agent 正在运行中，请等待完成后再手动压缩' })
      return
    }

    const messages = chatStore.getSessionMessages(sessionId)
    const MIN_MESSAGES = 8

    // Limitation 2: minimum message count
    if (messages.length < MIN_MESSAGES) {
      toast.error('无法压缩', { description: `至少需要 ${MIN_MESSAGES} 条消息才能进行压缩（当前 ${messages.length} 条）` })
      return
    }

    // Limitation 3: check if there's already a compressed summary as the 2nd message — avoid double-compressing too soon
    const hasRecentSummary = messages.length > 1 &&
      typeof messages[1]?.content === 'string' &&
      messages[1].content.startsWith('[Context Memory')
    if (hasRecentSummary && messages.length < MIN_MESSAGES + 4) {
      toast.error('无法压缩', { description: '上次压缩后消息过少，请继续对话后再尝试' })
      return
    }

    // Build provider config (same as sendMessage)
    const settings = useSettingsStore.getState()
    const providerConfig = useProviderStore.getState().getActiveProviderConfig()
    const effectiveMaxTokens = useProviderStore.getState().getEffectiveMaxTokens(settings.maxTokens)
    const activeModelThinkingConfig = useProviderStore.getState().getActiveModelThinkingConfig()
    const thinkingEnabled = settings.thinkingEnabled && !!activeModelThinkingConfig

    const config: ProviderConfig | null = providerConfig
      ? {
          ...providerConfig,
          maxTokens: effectiveMaxTokens,
          temperature: settings.temperature,
          systemPrompt: settings.systemPrompt || undefined,
          thinkingEnabled,
          thinkingConfig: activeModelThinkingConfig,
          reasoningEffort: settings.reasoningEffort
        }
      : null

    if (!config) {
      toast.error('无法压缩', { description: '未配置 AI 服务商' })
      return
    }

    // Override with session-bound provider if available
    const compressSession = chatStore.sessions.find((s) => s.id === sessionId)
    if (compressSession?.providerId && compressSession?.modelId) {
      const sessionProviderConfig = useProviderStore.getState().getProviderConfigById(
        compressSession.providerId, compressSession.modelId
      )
      if (sessionProviderConfig?.apiKey) {
        config.type = sessionProviderConfig.type
        config.apiKey = sessionProviderConfig.apiKey
        config.baseUrl = sessionProviderConfig.baseUrl
        config.model = sessionProviderConfig.model
      }
    }

    toast.info('正在压缩上下文...', { description: '使用主模型生成详细记忆摘要' })

    try {
      const { messages: compressed, result } = await compressMessages(
        messages,
        config,
        undefined, // no abort signal for manual
        undefined, // adaptive preserve count
        focusPrompt || undefined
      )
      if (!result.compressed) {
        toast.warning('无需压缩', { description: '当前消息数量不足以进行有效压缩' })
        return
      }
      chatStore.replaceSessionMessages(sessionId, compressed)
      toast.success('上下文已压缩', {
        description: `${result.originalCount} 条消息 → ${result.newCount} 条（核心信息已保留）`
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error('[Manual Compress Error]', err)
      toast.error('压缩失败', { description: errMsg })
    }
  }, [])

  return { sendMessage, stopStreaming, retryLastMessage, editAndResend, manualCompressContext }
}

// ── Plan Implement: programmatic message trigger ──

/**
 * Trigger plan implementation by sending a message to the agent.
 * Called from PlanPanel "Implement" button — bypasses the input box.
 */
export function sendImplementPlan(planId: string): void {
  if (!_sendMessageFn) return

  const plan = usePlanStore.getState().plans[planId]
  if (!plan) return

  // 1. Mark plan as implementing
  usePlanStore.getState().startImplementing(planId)

  // 2. Exit plan mode
  useUIStore.getState().exitPlanMode()

  // 3. Switch to Steps tab
  useUIStore.getState().setRightPanelTab('steps')

  // 4. Build implementation prompt and send directly
  const prompt = [
    `Please implement the plan: **${plan.title}**`,
    '',
    plan.filePath ? `Plan file: \`${plan.filePath}\`` : '',
    '',
    'Read the plan file first for full details, then begin implementation step by step.',
  ].filter(Boolean).join('\n')

  _sendMessageFn(prompt)
}

/**
 * Simple chat mode: single API call with streaming text, no tools.
 */
async function runSimpleChat(
  sessionId: string,
  assistantMsgId: string,
  config: ProviderConfig,
  signal: AbortSignal
): Promise<void> {
  const provider = createProvider(config)
  const chatStore = useChatStore.getState()
  const messages = chatStore.getSessionMessages(sessionId)
  const streamDeltaBuffer = createStreamDeltaBuffer(sessionId, assistantMsgId)

  try {
    const stream = provider.sendMessage(
      messages.slice(0, -1), // Exclude empty assistant placeholder
      [], // No tools in chat mode
      config,
      signal
    )

    let thinkingDone = false
    let hasThinkingDelta = false
    for await (const event of stream) {
      if (signal.aborted) break

      switch (event.type) {
        case 'thinking_delta':
          hasThinkingDelta = true
          streamDeltaBuffer.pushThinking(event.thinking!)
          break
        case 'thinking_encrypted':
          if (event.thinkingEncryptedContent && event.thinkingEncryptedProvider) {
            useChatStore.getState().setThinkingEncryptedContent(
              sessionId,
              assistantMsgId,
              event.thinkingEncryptedContent,
              event.thinkingEncryptedProvider
            )
          }
          break
        case 'text_delta':
          if (!thinkingDone) {
            const chunk = event.text ?? ''
            const closeThinkTagMatch = hasThinkingDelta
              ? chunk.match(/<\s*\/\s*think\s*>/i)
              : null
            const keepThinkingOpen = hasThinkingDelta && !closeThinkTagMatch
            if (!keepThinkingOpen) {
              if (closeThinkTagMatch && closeThinkTagMatch.index !== undefined) {
                const beforeClose = chunk.slice(0, closeThinkTagMatch.index)
                const afterClose = chunk.slice(
                  closeThinkTagMatch.index + closeThinkTagMatch[0].length
                )
                if (beforeClose) {
                  streamDeltaBuffer.pushThinking(beforeClose)
                }
                streamDeltaBuffer.flushNow()
                thinkingDone = true
                useChatStore.getState().completeThinking(sessionId, assistantMsgId)
                if (afterClose) {
                  streamDeltaBuffer.pushText(afterClose)
                }
                break
              }
              thinkingDone = true
              streamDeltaBuffer.flushNow()
              useChatStore.getState().completeThinking(sessionId, assistantMsgId)
            }
          }
          streamDeltaBuffer.pushText(event.text!)
          break
        case 'message_end':
          streamDeltaBuffer.flushNow()
          if (!thinkingDone) {
            thinkingDone = true
            useChatStore.getState().completeThinking(sessionId, assistantMsgId)
          }
          if (event.usage) {
            useChatStore.getState().updateMessage(sessionId, assistantMsgId, {
              usage: { ...event.usage, contextTokens: event.usage.contextTokens ?? event.usage.inputTokens }
            })
          }
          break
        case 'request_debug':
          streamDeltaBuffer.flushNow()
          if (useSettingsStore.getState().devMode && event.debugInfo) {
            setLastDebugInfo(assistantMsgId, event.debugInfo)
          }
          break
        case 'error':
          streamDeltaBuffer.flushNow()
          console.error('[Chat Error]', event.error)
          toast.error('Chat Error', { description: event.error?.message ?? 'Unknown error' })
          break
      }
    }
  } catch (err) {
    streamDeltaBuffer.flushNow()
    if (!signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error('[Chat Exception]', err)
      toast.error('Chat failed', { description: errMsg })
      useChatStore
        .getState()
        .appendTextDelta(sessionId, assistantMsgId, `\n\n> **Error:** ${errMsg}`)
      if (err instanceof ApiStreamError && useSettingsStore.getState().devMode) {
        setLastDebugInfo(assistantMsgId, err.debugInfo as RequestDebugInfo)
      }
    }
  } finally {
    streamDeltaBuffer.flushNow()
    streamDeltaBuffer.dispose()
    useChatStore.getState().setStreamingMessageId(sessionId, null)
  }
}

/**
 * Trigger sendMessage from outside the hook (e.g. plugin auto-reply).
 * Must be called after useChatActions has mounted at least once.
 */
export function triggerSendMessage(
  text: string,
  targetSessionId: string,
  images?: ImageAttachment[]
): void {
  if (!_sendMessageFn) {
    console.error('[triggerSendMessage] sendMessage not initialized yet')
    return
  }
  void _sendMessageFn(text, images, undefined, targetSessionId)
}

function mergeUsage(target: TokenUsage, incoming: TokenUsage): void {
  target.inputTokens += incoming.inputTokens
  target.outputTokens += incoming.outputTokens
  if (incoming.cacheCreationTokens) {
    target.cacheCreationTokens = (target.cacheCreationTokens ?? 0) + incoming.cacheCreationTokens
  }
  if (incoming.cacheReadTokens) {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + incoming.cacheReadTokens
  }
  if (incoming.reasoningTokens) {
    target.reasoningTokens = (target.reasoningTokens ?? 0) + incoming.reasoningTokens
  }
}
