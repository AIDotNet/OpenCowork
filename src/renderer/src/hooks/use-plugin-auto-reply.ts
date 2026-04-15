/**
 * Plugin Auto-Reply Hook
 *
 * Listens for `plugin:auto-reply-task` window events and runs an
 * independent Agent Loop (same pattern as cron-agent-runner.ts) with
 * the full main-agent configuration: all tools, system prompt with
 * plugin context, thinking, context compression, etc.
 *
 * If the plugin supports streaming, wraps the agent run with CardKit
 * streaming by forwarding text deltas to the card in real-time.
 */

import { useEffect } from 'react'
import { nanoid } from 'nanoid'
import { runAgentViaSidecar } from '@renderer/lib/agent/run-agent-via-sidecar'
import { buildSidecarAgentRunRequest } from '@renderer/lib/ipc/sidecar-protocol'
import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import {
  buildSystemPrompt,
  resolvePromptEnvironmentContext
} from '@renderer/lib/agent/system-prompt'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { registerPluginTools, isPluginToolsRegistered } from '@renderer/lib/channel/plugin-tools'
import { DEFAULT_PLUGIN_PERMISSIONS } from '@renderer/lib/channel/types'
import { loadLayeredMemorySnapshot } from '@renderer/lib/agent/memory-files'
import type { UnifiedMessage, ProviderConfig, ContentBlock } from '@renderer/lib/api/types'
import type { Session } from '@renderer/stores/chat-store'
import { hasPendingSessionMessagesForSession } from '@renderer/hooks/use-chat-actions'
import { recordUsageEvent } from '@renderer/lib/usage-analytics'
import {
  summarizeToolInputForHistory,
  summarizeToolInputForLiveCard
} from '@renderer/lib/tools/tool-input-sanitizer'

interface PluginAutoReplyTask {
  sessionId: string
  pluginId: string
  pluginType: string
  chatId: string
  chatType?: 'p2p' | 'group'
  senderId: string
  senderName: string
  chatName?: string
  sessionTitle?: string
  content: string
  messageId: string
  supportsStreaming: boolean
  projectId?: string
  workingFolder?: string
  sshConnectionId?: string | null
  images?: Array<{ base64: string; mediaType: string }>
  audio?: { fileKey: string; fileName?: string; mediaType?: string; durationMs?: number }
}

const PLUGIN_STREAM_DELTA_FLUSH_MS = 66
const PLUGIN_PROCESSING_ACK_MESSAGE = '已收到消息，正在处理，请稍候。'
const pluginTaskChains = new Map<string, Promise<void>>()
const queuedPluginTasksByScope = new Map<string, number>()
const queuedPluginTasksBySession = new Map<string, number>()

function buildPluginMessageSessionKey(pluginId: string, chatId: string): string {
  return `plugin:${pluginId}:chat:${encodeURIComponent(chatId)}`
}

function buildPluginTaskScopeKey(pluginId: string, chatId: string): string {
  return `${pluginId}:${encodeURIComponent(chatId)}`
}

function adjustQueuedPluginTaskCount(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta
  if (next <= 0) {
    map.delete(key)
    return
  }
  map.set(key, next)
}

function shouldReplaceSessionTitle(
  currentTitle: string | undefined,
  nextTitle: string | undefined
): boolean {
  const current = (currentTitle ?? '').trim()
  const next = (nextTitle ?? '').trim()
  if (!next || current === next) return false

  return (
    current.length === 0 ||
    current === 'New Conversation' ||
    current === 'New Chat' ||
    /^oc_/i.test(current) ||
    /^Plugin\s+/i.test(current)
  )
}

async function _runPluginAgent(task: PluginAutoReplyTask): Promise<void> {
  const { sessionId, pluginId, pluginType, chatId, supportsStreaming } = task

  // ── Check feature toggles ──
  const channelMeta = useChannelStore.getState().channels.find((p) => p.id === pluginId)
  const features = channelMeta?.features ?? {
    autoReply: true,
    streamingReply: true,
    autoStart: true
  }
  const channelTypeFromStore = (channelMeta?.type ?? '').toLowerCase()
  const pluginTypeFromTask = (pluginType ?? '').toLowerCase()
  const isFeishuChannel =
    channelTypeFromStore === 'feishu-bot' ||
    pluginTypeFromTask === 'feishu-bot' ||
    channelTypeFromStore === 'feishu' ||
    pluginTypeFromTask === 'feishu'
  if (!features.autoReply) {
    console.log(`[PluginAutoReply] Auto-reply disabled for plugin ${pluginId}, skipping`)
    return
  }

  const shouldReplyToIncomingMessage =
    pluginType === 'qq-bot' && task.chatType === 'group' && Boolean(task.messageId)
  const shouldUseStreamingReply = supportsStreaming && features.streamingReply
  const streamId = nanoid()

  const sendPluginMessage = async (message: string): Promise<boolean> => {
    try {
      await ipcClient.invoke(IPC.PLUGIN_EXEC, {
        pluginId,
        action: shouldReplyToIncomingMessage ? 'replyMessage' : 'sendMessage',
        params: shouldReplyToIncomingMessage
          ? { messageId: task.messageId, content: message }
          : { chatId, content: message }
      })
      return true
    } catch (err) {
      console.error('[PluginAutoReply] Failed to send plugin message:', err)
      return false
    }
  }

  const sendChannelNotice = async (message: string): Promise<void> => {
    await sendPluginMessage(message)
  }

  let immediateAckSent = false
  const sendImmediateAck = async (): Promise<void> => {
    if (immediateAckSent) return
    immediateAckSent = true
    await sendChannelNotice(PLUGIN_PROCESSING_ACK_MESSAGE)
  }

  if (!shouldUseStreamingReply) {
    await sendImmediateAck()
  }

  // ── Provider config (with per-channel model override) ──
  const providerStore = useProviderStore.getState()
  const targetProviderId = channelMeta?.providerId ?? providerStore.activeProviderId
  if (targetProviderId) {
    const ready = await ensureProviderAuthReady(targetProviderId)
    if (!ready) {
      console.error('[PluginAutoReply] Provider auth missing')
      await sendChannelNotice('未配置或未完成认证的模型服务商，请在设置中完成配置后再试。')
      return
    }
  }

  const providerConfig = getProviderConfig(channelMeta?.providerId, channelMeta?.model)
  if (!providerConfig) {
    console.error('[PluginAutoReply] No provider config — API key not configured')
    await sendChannelNotice('未配置模型服务商或 API Key，请在设置中完成配置后再试。')
    return
  }

  const supportsVision = resolveModelSupportsVision(
    channelMeta?.providerId ?? providerStore.activeProviderId,
    channelMeta?.model ?? providerConfig.model
  )

  let effectiveContent = task.content

  if (task.audio && isFeishuChannel) {
    const speechProviderId = providerStore.activeSpeechProviderId
    const speechModelId = providerStore.activeSpeechModelId
    if (!speechProviderId || !speechModelId) {
      await sendChannelNotice(
        '已收到语音消息，但未配置语音识别模型。请在 设置 → 模型 → 语音识别模型 中选择后再试。'
      )
      return
    }

    const ready = await ensureProviderAuthReady(speechProviderId)
    if (!ready) {
      await sendChannelNotice('语音识别服务商认证未完成，请在 设置 → 模型 中完成认证后再试。')
      return
    }

    const openAiConfig = resolveOpenAiProviderConfig(speechProviderId, speechModelId)
    if (!openAiConfig) {
      await sendChannelNotice(
        '语音识别需要 OpenAI 兼容服务商。请在 设置 → 模型 → 语音识别模型 中选择 OpenAI 兼容模型后再试。'
      )
      return
    }

    try {
      const download = (await ipcClient.invoke(IPC.PLUGIN_FEISHU_DOWNLOAD_RESOURCE, {
        pluginId,
        messageId: task.messageId,
        fileKey: task.audio.fileKey,
        type: 'file'
      })) as { ok?: boolean; base64?: string; mediaType?: string; error?: string }

      if (!download?.base64 || download.error) {
        await sendChannelNotice(`语音下载失败：${download?.error ?? 'unknown error'}`)
        return
      }

      const reportedMediaType = (download.mediaType ?? '').trim().toLowerCase()
      const effectiveMediaType =
        (reportedMediaType && reportedMediaType !== 'application/octet-stream'
          ? reportedMediaType
          : task.audio.mediaType) ?? 'application/octet-stream'

      const transcript = await transcribeFeishuAudio({
        base64: download.base64,
        mediaType: effectiveMediaType,
        fileName: task.audio.fileName ?? 'audio',
        model: openAiConfig.config.model,
        apiKey: openAiConfig.config.apiKey,
        baseUrl: openAiConfig.config.baseUrl
      })

      effectiveContent = transcript.trim() ? transcript : '[语音已转写，但内容为空]'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await sendChannelNotice(`语音转写失败：${msg}`)
      return
    }
  } else if (task.audio) {
    console.warn('[PluginAutoReply] Skip audio transcription because plugin type is not Feishu', {
      pluginId,
      messageId: task.messageId,
      pluginTypeFromTask: pluginType,
      pluginTypeFromStore: channelMeta?.type
    })
  }

  // ── Start CardKit streaming card (only if streamingReply feature enabled) ──
  let streamingActive = false
  if (shouldUseStreamingReply) {
    try {
      const res = (await ipcClient.invoke('plugin:stream:start', {
        pluginId,
        chatId,
        streamId,
        initialContent: PLUGIN_PROCESSING_ACK_MESSAGE,
        messageId: task.messageId
      })) as { ok: boolean }
      streamingActive = !!res?.ok
      if (!streamingActive) {
        await sendImmediateAck()
      }
    } catch (err) {
      console.warn('[PluginAutoReply] Failed to start streaming card:', err)
      await sendImmediateAck()
    }
  }

  // ── Resolve permissions & homedir for security enforcement ──
  const permissions = channelMeta?.permissions ?? DEFAULT_PLUGIN_PERMISSIONS
  let homedir = ''
  try {
    homedir = (await ipcClient.invoke('app:homedir')) as string
  } catch {
    console.warn('[PluginAutoReply] Failed to get homedir, defaulting to empty')
  }

  // ── Ensure session exists in chat store ──
  // The session was created by auto-reply.ts in the main process DB.
  // Instead of calling loadFromDb() (which reloads ALL sessions and can hang),
  // check if it exists and create it in the store if missing.
  // workingFolder is passed directly from main process in the task payload
  const channelWorkDir = task.workingFolder ?? ''
  const channelProjectId = task.projectId
  const channelSshConnectionId = task.sshConnectionId ?? undefined

  const resolvedTitle = task.sessionTitle || task.chatName || task.senderName || task.chatId

  if (channelProjectId) {
    try {
      const existingProject = useChatStore
        .getState()
        .projects.find((project) => project.id === channelProjectId)
      if (!existingProject) {
        const row = (await ipcClient.invoke('db:projects:get', channelProjectId)) as {
          id: string
          name: string
          created_at: number
          updated_at: number
          working_folder?: string | null
          ssh_connection_id?: string | null
          plugin_id?: string | null
        } | null
        if (row) {
          useChatStore.setState((state) => {
            const projectExists = state.projects.some((project) => project.id === row.id)
            if (!projectExists) {
              state.projects.unshift({
                id: row.id,
                name: row.name,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                workingFolder: row.working_folder ?? undefined,
                sshConnectionId: row.ssh_connection_id ?? undefined,
                pluginId: row.plugin_id ?? undefined
              })
            }
          })
        }
      }
    } catch (err) {
      console.warn('[PluginAutoReply] Failed to upsert project from DB:', err)
    }
  }

  let session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session) {
    try {
      const row = (await ipcClient.invoke('db:sessions:get', sessionId)) as {
        session?: {
          title?: string
          mode?: string
          created_at?: number
          updated_at?: number
          project_id?: string | null
          working_folder?: string | null
          ssh_connection_id?: string | null
          provider_id?: string | null
          model_id?: string | null
        }
      } | null
      const dbSession = row?.session
      if (dbSession) {
        const newSession: Session = {
          id: sessionId,
          title: shouldReplaceSessionTitle(dbSession.title, resolvedTitle)
            ? resolvedTitle
            : dbSession.title || resolvedTitle,
          mode: (dbSession.mode as 'chat' | 'clarify' | 'cowork' | 'code' | 'acp') || 'cowork',
          messages: [],
          messageCount: 0,
          messagesLoaded: true,
          loadedRangeStart: 0,
          loadedRangeEnd: 0,
          createdAt: dbSession.created_at ?? Date.now(),
          updatedAt: dbSession.updated_at ?? Date.now(),
          projectId: dbSession.project_id ?? channelProjectId,
          workingFolder: dbSession.working_folder || channelWorkDir,
          sshConnectionId: dbSession.ssh_connection_id ?? channelSshConnectionId,
          pluginId,
          externalChatId: buildPluginMessageSessionKey(pluginId, task.chatId),
          providerId: dbSession.provider_id || channelMeta?.providerId || undefined,
          modelId: dbSession.model_id || channelMeta?.model || undefined
        }
        useChatStore.setState((state) => {
          state.sessions.push(newSession)
        })
        session = newSession
      }
    } catch (err) {
      console.warn('[PluginAutoReply] DB query failed:', err)
    }
  }

  if (!session) {
    const newSession: Session = {
      id: sessionId,
      title: resolvedTitle,
      mode: 'cowork' as const,
      messages: [],
      messageCount: 0,
      messagesLoaded: true,
      loadedRangeStart: 0,
      loadedRangeEnd: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectId: channelProjectId,
      workingFolder: channelWorkDir,
      sshConnectionId: channelSshConnectionId,
      pluginId,
      externalChatId: buildPluginMessageSessionKey(pluginId, task.chatId),
      providerId: channelMeta?.providerId || undefined,
      modelId: channelMeta?.model || undefined
    }
    useChatStore.setState((state) => {
      state.sessions.push(newSession)
    })
    session = newSession
  }

  if (!session) return

  useChatStore.setState((state) => {
    const s = state.sessions.find((sess) => sess.id === sessionId)
    if (s) {
      s.pluginChatType = task.chatType
      s.pluginSenderId = task.senderId
      s.pluginSenderName = task.senderName
      if (channelProjectId) {
        s.projectId = channelProjectId
      }
      if (channelWorkDir) {
        s.workingFolder = channelWorkDir
      }
      if (channelSshConnectionId !== undefined) {
        s.sshConnectionId = channelSshConnectionId
      }
    }
  })
  session = {
    ...session,
    pluginChatType: task.chatType,
    pluginSenderId: task.senderId,
    pluginSenderName: task.senderName,
    projectId: channelProjectId ?? session.projectId,
    workingFolder: channelWorkDir || session.workingFolder,
    sshConnectionId: channelSshConnectionId ?? session.sshConnectionId
  }

  // Update session title in store if we have a better name now
  if (session && shouldReplaceSessionTitle(session.title, resolvedTitle)) {
    useChatStore.setState((state) => {
      const s = state.sessions.find((s) => s.id === sessionId)
      if (s) s.title = resolvedTitle
    })
    session = { ...session, title: resolvedTitle }
  }

  // ── Ensure plugin tools are registered ──
  if (!isPluginToolsRegistered()) {
    registerPluginTools()
  }

  // ── Build tools (same as main agent's cowork branch) ──
  const allToolDefs = toolRegistry.getDefinitions()
  const cachedPromptSnapshot = session.promptSnapshot
  const canReusePromptSnapshot =
    !!cachedPromptSnapshot &&
    cachedPromptSnapshot.mode === 'cowork' &&
    cachedPromptSnapshot.planMode === false &&
    cachedPromptSnapshot.workingFolder === session.workingFolder &&
    cachedPromptSnapshot.projectId === session.projectId &&
    cachedPromptSnapshot.sshConnectionId === session.sshConnectionId &&
    // Discard stale snapshots that lack plugin tools (issue #73).
    cachedPromptSnapshot.toolDefs.some((t) => t.name === 'PluginSendMessage')

  let effectiveToolDefs = allToolDefs
  let systemPrompt = cachedPromptSnapshot?.systemPrompt ?? ''

  if (!canReusePromptSnapshot) {
    // ── Build system prompt with channel context ──
    const settings = useSettingsStore.getState()
    let userPrompt = settings.systemPrompt || ''

    const channelDescriptor = channelMeta
      ? useChannelStore.getState().getDescriptor(channelMeta.type)
      : undefined
    const channelToolNames = channelDescriptor?.tools ?? []
    const enabledTools = channelToolNames.filter((name) => channelMeta?.tools?.[name] !== false)

    const channelCtx = [
      `\n## Channel Auto-Reply Context`,
      `Channel: ${channelMeta?.name ?? pluginType} (channel_id: \`${pluginId}\`)`,
      `Chat ID: \`${chatId}\``,
      `Chat Type: ${task.chatType ?? 'unknown'}`,
      `Sender: ${task.senderName || task.senderId} (id: ${task.senderId})`,
      enabledTools.length > 0 ? `Available channel tools: ${enabledTools.join(', ')}` : '',
      `Reply directly to this incoming message in a natural way.`,
      `If you need channel tools, use plugin_id="${pluginId}" and chat_id="${chatId}".`
    ]
      .filter(Boolean)
      .join('\n')
    userPrompt = userPrompt ? `${userPrompt}\n${channelCtx}` : channelCtx

    const memorySnapshot = await loadLayeredMemorySnapshot(ipcClient, {
      workingFolder: session.workingFolder,
      scope: 'shared'
    })
    const sshConnection = session.sshConnectionId
      ? useSshStore
          .getState()
          .connections.find((connection) => connection.id === session.sshConnectionId)
      : undefined
    const environmentContext = resolvePromptEnvironmentContext({
      sshConnectionId: session.sshConnectionId,
      workingFolder: session.workingFolder,
      sshConnection
    })

    systemPrompt = buildSystemPrompt({
      mode: 'cowork',
      workingFolder: session.workingFolder,
      sessionId,
      userRules: userPrompt,
      toolDefs: allToolDefs,
      language: settings.language,
      memorySnapshot,
      sessionScope: 'shared',
      environmentContext
    })

    useChatStore.getState().setSessionPromptSnapshot(sessionId, {
      mode: 'cowork',
      planMode: false,
      systemPrompt,
      toolDefs: allToolDefs,
      projectId: session.projectId,
      workingFolder: session.workingFolder,
      sshConnectionId: session.sshConnectionId
    })
  } else {
    effectiveToolDefs = cachedPromptSnapshot.toolDefs.slice()
  }

  // ── Build user message ──
  let userContent: UnifiedMessage['content'] = effectiveContent
  if (task.images?.length) {
    if (supportsVision) {
      const blocks: ContentBlock[] = []
      for (const img of task.images) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', mediaType: img.mediaType, data: img.base64 }
        })
      }
      if (effectiveContent) {
        blocks.push({ type: 'text', text: effectiveContent })
      }
      userContent = blocks
    } else {
      const note = '[User sent an image, but the current model does not support vision.]'
      userContent = [effectiveContent, note].filter(Boolean).join('\n')
    }
  }

  const userMsg: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: userContent,
    createdAt: Date.now()
  }

  // Add user message to store + DB
  useChatStore.getState().addMessage(sessionId, userMsg)

  // Create assistant placeholder
  const assistantMsgId = nanoid()
  const assistantMsg: UnifiedMessage = {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    createdAt: Date.now()
  }
  useChatStore.getState().addMessage(sessionId, assistantMsg)
  useChatStore.getState().setStreamingMessageId(sessionId, assistantMsgId)

  // ── Build agent loop config ──
  const ac = new AbortController()

  const agentProviderConfig: ProviderConfig = {
    ...providerConfig,
    systemPrompt,
    sessionId
  }

  // Tool execution / channel permissions now live on the sidecar side. Plugin
  // and SSH context are propagated via buildSidecarAgentRunRequest → sidecar →
  // renderer-tool-bridge, so the static toolCtx/loopConfig are no longer needed.
  void permissions
  void homedir

  // ── Run Agent Loop ──
  const messages = await useChatStore.getState().getSessionMessagesForRequest(sessionId, {
    includeTrailingAssistantPlaceholder: false
  })

  // Filter out empty assistant messages (can occur if a previous run was interrupted
  // or duplicate triggers left orphaned placeholders) — API rejects empty assistant turns
  const historyMessages = messages.filter((m) => {
      if (m.role !== 'assistant') return true
      if (typeof m.content === 'string') return m.content.trim().length > 0
      if (Array.isArray(m.content)) return m.content.length > 0
      return false
    })

  const sidecarRequest = buildSidecarAgentRunRequest({
    messages: historyMessages,
    provider: agentProviderConfig,
    tools: effectiveToolDefs,
    sessionId,
    workingFolder: session.workingFolder,
    maxIterations: 15,
    forceApproval: false,
    pluginId,
    pluginChatId: chatId,
    pluginChatType: task.chatType,
    pluginSenderId: task.senderId,
    pluginSenderName: task.senderName,
    sshConnectionId: session.sshConnectionId
  })
  if (!sidecarRequest) {
    throw new Error('Failed to build sidecar agent request for plugin auto-reply')
  }
  const loop = runAgentViaSidecar(sidecarRequest, { signal: ac.signal })

  let fullText = ''
  let lastError: string | null = null
  let pendingText = ''
  let pendingPluginDelta = ''
  let pluginStreamUpdateInFlight: Promise<unknown> | null = null
  let pendingPluginStreamFlush = false
  const pendingToolInputs = new Map<string, Record<string, unknown>>()
  const liveToolNames = new Map<string, string>()
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null
  const toolInputThrottle = new Map<
    string,
    { lastFlush: number; pending?: Record<string, unknown>; timer?: ReturnType<typeof setTimeout> }
  >()

  const flushPluginStreamUpdate = (): void => {
    if (!streamingActive) return
    if (pluginStreamUpdateInFlight) {
      pendingPluginStreamFlush = true
      return
    }
    if (!pendingPluginDelta) return

    const delta = pendingPluginDelta
    pendingPluginDelta = ''
    pluginStreamUpdateInFlight = ipcClient
      .invoke(IPC.PLUGIN_STREAM_APPEND, {
        pluginId,
        chatId,
        streamId,
        delta
      })
      .then((res) => {
        const result = res as { ok?: boolean }
        if (!result?.ok) {
          throw new Error(`Plugin stream append rejected for ${pluginId}:${chatId}:${streamId}`)
        }
      })
      .catch(() => {
        pendingPluginDelta = `${delta}${pendingPluginDelta}`
      })
      .finally(() => {
        pluginStreamUpdateInFlight = null
        if (pendingPluginStreamFlush || pendingPluginDelta) {
          pendingPluginStreamFlush = false
          queueMicrotask(() => {
            flushPluginStreamUpdate()
          })
        }
      })
  }

  const flushStreamingState = (): void => {
    if (streamFlushTimer) {
      clearTimeout(streamFlushTimer)
      streamFlushTimer = null
    }
    if (pendingText) {
      useChatStore.getState().appendTextDelta(sessionId, assistantMsgId, pendingText)
      pendingText = ''
    }
    if (pendingToolInputs.size > 0) {
      for (const [toolCallId, partialInput] of pendingToolInputs) {
        useChatStore
          .getState()
          .updateToolUseInput(sessionId, assistantMsgId, toolCallId, partialInput)
      }
      pendingToolInputs.clear()
    }
    flushPluginStreamUpdate()
  }

  const scheduleStreamingFlush = (): void => {
    if (streamFlushTimer) return
    streamFlushTimer = setTimeout(() => {
      streamFlushTimer = null
      flushStreamingState()
    }, PLUGIN_STREAM_DELTA_FLUSH_MS)
  }

  const flushToolInput = (toolCallId: string): void => {
    const entry = toolInputThrottle.get(toolCallId)
    if (!entry?.pending) return
    entry.lastFlush = Date.now()
    const pending = entry.pending
    entry.pending = undefined
    useAgentStore.getState().updateToolCall(toolCallId, { input: pending })
  }

  const scheduleToolInputUpdate = (
    toolCallId: string,
    partialInput: Record<string, unknown>
  ): void => {
    const now = Date.now()
    const entry = toolInputThrottle.get(toolCallId) ?? { lastFlush: 0 }
    entry.pending = partialInput
    toolInputThrottle.set(toolCallId, entry)

    if (now - entry.lastFlush >= 60) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
      flushToolInput(toolCallId)
      return
    }

    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        flushToolInput(toolCallId)
      }, 60)
    }
  }

  for await (const event of loop) {
    if (ac.signal.aborted) break

    switch (event.type) {
      case 'thinking_encrypted':
        if (event.thinkingEncryptedContent && event.thinkingEncryptedProvider) {
          useChatStore
            .getState()
            .setThinkingEncryptedContent(
              sessionId,
              assistantMsgId,
              event.thinkingEncryptedContent,
              event.thinkingEncryptedProvider
            )
        }
        break

      case 'text_delta':
        fullText += event.text
        pendingText += event.text
        pendingPluginDelta += event.text
        scheduleStreamingFlush()
        break

      case 'tool_use_streaming_start':
        liveToolNames.set(event.toolCallId, event.toolName)
        flushStreamingState()
        // Show tool card immediately while args are still streaming
        useChatStore.getState().appendToolUse(sessionId, assistantMsgId, {
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

      case 'tool_use_args_delta': {
        const toolName = liveToolNames.get(event.toolCallId) ?? ''
        const liveCardInput = summarizeToolInputForLiveCard(toolName, event.partialInput)
        pendingToolInputs.set(event.toolCallId, liveCardInput)
        scheduleStreamingFlush()
        scheduleToolInputUpdate(event.toolCallId, liveCardInput)
        break
      }

      case 'tool_use_generated': {
        flushStreamingState()
        liveToolNames.set(event.toolUseBlock.id, event.toolUseBlock.name)
        console.log(`[PluginAutoReply] Tool call: ${event.toolUseBlock.name}`)
        const liveCardInput = summarizeToolInputForLiveCard(
          event.toolUseBlock.name,
          event.toolUseBlock.input
        )
        useChatStore
          .getState()
          .updateToolUseInput(sessionId, assistantMsgId, event.toolUseBlock.id, liveCardInput)
        flushToolInput(event.toolUseBlock.id)
        useAgentStore.getState().updateToolCall(event.toolUseBlock.id, {
          input: liveCardInput
        })
        break
      }

      case 'tool_call_start':
        useAgentStore.getState().addToolCall({
          ...event.toolCall,
          input: summarizeToolInputForLiveCard(event.toolCall.name, event.toolCall.input)
        })
        break

      case 'tool_call_result': {
        const settledInput =
          event.toolCall.status === 'completed' || event.toolCall.status === 'error'
            ? summarizeToolInputForHistory(event.toolCall.name, event.toolCall.input)
            : undefined
        if (settledInput) {
          useChatStore
            .getState()
            .updateToolUseInput(sessionId, assistantMsgId, event.toolCall.id, settledInput)
        }
        useAgentStore.getState().updateToolCall(event.toolCall.id, {
          ...(settledInput ? { input: settledInput } : {}),
          status: event.toolCall.status,
          output: event.toolCall.output,
          error: event.toolCall.error,
          completedAt: event.toolCall.completedAt
        })
        if (event.toolCall.status === 'completed' || event.toolCall.status === 'error') {
          liveToolNames.delete(event.toolCall.id)
        }
        break
      }

      case 'message_end':
        if (event.usage) {
          useChatStore.getState().updateMessage(sessionId, assistantMsgId, {
            usage: {
              ...event.usage,
              contextTokens: event.usage.contextTokens ?? event.usage.inputTokens
            },
            ...(event.providerResponseId ? { providerResponseId: event.providerResponseId } : {})
          })
          void recordUsageEvent({
            sessionId,
            messageId: assistantMsgId,
            sourceKind: 'plugin',
            providerId: agentProviderConfig.providerId,
            modelId: agentProviderConfig.model,
            usage: {
              ...event.usage,
              contextTokens: event.usage.contextTokens ?? event.usage.inputTokens
            },
            timing: event.timing,
            providerResponseId: event.providerResponseId,
            createdAt: Date.now(),
            meta: {
              pluginId,
              chatId,
              chatType: task.chatType,
              senderId: task.senderId
            }
          })
        }
        break

      case 'iteration_end':
        // Append tool_result user message so next iteration has proper context
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
          useChatStore.getState().addMessage(sessionId, toolResultMsg)
        }
        if (hasQueuedPluginTasks(sessionId) || hasPendingSessionMessagesForSession(sessionId)) {
          console.log(
            `[PluginAutoReply] Queued message detected at iteration_end, allowing current run to finish before processing queued input for session ${sessionId}`
          )
        }
        break

      case 'error':
        lastError = event.error instanceof Error ? event.error.message : String(event.error)
        console.error('[PluginAutoReply] Agent error:', event.error)
        break
    }
  }

  // ── Finalize ──
  flushStreamingState()
  useChatStore.getState().setStreamingMessageId(sessionId, null)

  // Persist the final message state to DB.
  // Do NOT overwrite content with fullText — the message content already contains
  // structured blocks (text + tool_use) built up during streaming via appendTextDelta
  // and appendToolUse. Overwriting with plain text would destroy tool_use blocks.
  // Trigger a DB flush by calling updateMessage with the current content.
  const finalSession = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  const finalMsg = finalSession?.messages.find((m) => m.id === assistantMsgId)
  if (finalMsg) {
    useChatStore.getState().updateMessage(sessionId, assistantMsgId, { content: finalMsg.content })
  }

  const fallbackMessage = lastError
    ? `模型运行失败：${lastError}`
    : '模型未返回文本回复，请检查当前模型配置'

  const finalText = fullText.trim() ? fullText : fallbackMessage
  let streamFinished = false

  // Finish CardKit card
  if (streamingActive) {
    try {
      const pendingPluginUpdate = pluginStreamUpdateInFlight
      if (pendingPluginUpdate) {
        await pendingPluginUpdate
      }
      const finishRes = (await ipcClient.invoke('plugin:stream:finish', {
        pluginId,
        chatId,
        streamId,
        content: finalText
      })) as { ok?: boolean }
      streamFinished = finishRes?.ok === true
      if (!streamFinished) {
        throw new Error(`Plugin stream finish rejected for ${pluginId}:${chatId}:${streamId}`)
      }
      console.log(`[PluginAutoReply] CardKit finished for ${pluginId}:${chatId}:${streamId}`)
    } catch (err) {
      console.warn('[PluginAutoReply] Failed to finish streaming card:', err)
      const fallbackSent = await sendPluginMessage(finalText)
      console.log(
        `[PluginAutoReply] Streaming fallback send ${fallbackSent ? 'succeeded' : 'failed'} for ${pluginId}:${chatId}:${streamId}`
      )
    }
  }

  if (!streamingActive && !fullText.trim()) {
    await sendChannelNotice(fallbackMessage)
  }

  if (!streamingActive && fullText.trim()) {
    const sent = await sendPluginMessage(fullText)
    if (sent) {
      console.log(
        `[PluginAutoReply] Sent non-streaming ${shouldReplyToIncomingMessage ? 'reply' : 'message'} for ${pluginId}:${chatId}`
      )
    }
  }

  console.log(`[PluginAutoReply] Completed for session=${sessionId}, ${fullText.length} chars`)
}

/**
 * Initialize the global plugin auto-reply listener.
 * Idempotent — safe to call multiple times.
 */
export function initPluginAutoReplyListener(): void {
  if (window.__pluginAutoReplyListenerActive) return
  window.__pluginAutoReplyListenerActive = true

  window.addEventListener('plugin:auto-reply-task', (e: Event) => {
    const task = (e as CustomEvent<PluginAutoReplyTask>).detail
    if (!task?.sessionId) return
    void handlePluginAutoReply(task)
  })

  console.log('[PluginAutoReply] Listener initialized')
}

/**
 * Hook: mounts the plugin auto-reply listener once.
 * Call from App.tsx.
 */
export function usePluginAutoReply(): void {
  useEffect(() => {
    initPluginAutoReplyListener()
  }, [])
}

// ── Helper Functions ──

function getProviderConfig(
  providerId?: string | null,
  modelOverride?: string | null
): ProviderConfig | null {
  const s = useSettingsStore.getState()
  const store = useProviderStore.getState()

  // If a specific provider+model is bound, use that provider directly
  if (providerId && modelOverride) {
    const overrideConfig = store.getProviderConfigById(providerId, modelOverride)
    if (overrideConfig?.apiKey) {
      return {
        ...overrideConfig,
        maxTokens: store.getEffectiveMaxTokens(s.maxTokens, modelOverride),
        temperature: s.temperature
      }
    }
  }

  const activeConfig = store.getActiveProviderConfig()
  if (activeConfig?.apiKey) {
    return {
      ...activeConfig,
      model: modelOverride || activeConfig.model,
      maxTokens: store.getEffectiveMaxTokens(s.maxTokens, modelOverride || activeConfig.model),
      temperature: s.temperature
    }
  }

  return null
}

function resolveModelSupportsVision(providerId: string | null, modelId: string): boolean {
  const store = useProviderStore.getState()
  const provider = store.providers.find((p) => p.id === providerId)
  if (!provider) return false
  const model = provider.models.find((m) => m.id === modelId)
  return modelSupportsVision(model, provider.type)
}

function resolveOpenAiProviderConfig(
  providerId: string,
  modelId: string
): { config: ProviderConfig; type: 'openai-chat' | 'openai-responses' } | null {
  const store = useProviderStore.getState()
  const provider = store.providers.find((p) => p.id === providerId)
  if (!provider) return null

  // Only OpenAI-compatible providers (openai-chat or openai-responses)
  if (provider.type !== 'openai-chat' && provider.type !== 'openai-responses') {
    return null
  }

  const config = store.getProviderConfigById(providerId, modelId)
  if (!config?.apiKey) return null

  return {
    config,
    type: provider.type as 'openai-chat' | 'openai-responses'
  }
}

async function transcribeFeishuAudio(params: {
  base64: string
  mediaType: string
  fileName: string
  model: string
  apiKey: string
  baseUrl?: string
}): Promise<string> {
  const { base64, mediaType, fileName, model, apiKey, baseUrl } = params

  // Convert base64 to blob
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  const blob = new Blob([bytes], { type: mediaType })

  // Create FormData
  const formData = new FormData()
  formData.append('file', blob, fileName)
  formData.append('model', model)

  // Call OpenAI-compatible transcription API
  const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/audio/transcriptions`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    throw new Error(`Transcription API error: ${response.status} ${errorText}`)
  }

  const result = (await response.json()) as { text?: string }
  return result.text ?? ''
}

function hasQueuedPluginTasks(sessionId: string): boolean {
  return (queuedPluginTasksBySession.get(sessionId) ?? 0) > 0
}

async function handlePluginAutoReply(task: PluginAutoReplyTask): Promise<void> {
  const scopeKey = buildPluginTaskScopeKey(task.pluginId, task.chatId)
  const previous = pluginTaskChains.get(scopeKey) ?? Promise.resolve()

  adjustQueuedPluginTaskCount(queuedPluginTasksByScope, scopeKey, 1)
  adjustQueuedPluginTaskCount(queuedPluginTasksBySession, task.sessionId, 1)

  const run = previous
    .catch(() => {})
    .then(async () => {
      adjustQueuedPluginTaskCount(queuedPluginTasksByScope, scopeKey, -1)
      adjustQueuedPluginTaskCount(queuedPluginTasksBySession, task.sessionId, -1)
      await _runPluginAgent(task)
    })
    .catch((err) => {
      console.error('[PluginAutoReply] Error handling plugin auto-reply:', err)
    })

  pluginTaskChains.set(scopeKey, run)

  try {
    await run
  } finally {
    if (pluginTaskChains.get(scopeKey) === run) {
      pluginTaskChains.delete(scopeKey)
    }
  }
}
