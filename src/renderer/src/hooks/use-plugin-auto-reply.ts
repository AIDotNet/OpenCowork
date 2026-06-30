/**
 * Plugin Auto-Reply Hook
 *
 * Listens for `plugin:auto-reply-task` window events and runs an
 * independent native sidecar Agent Loop with
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
import { agentBridge } from '@renderer/lib/ipc/agent-bridge'
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
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  DB_PROJECTS_GET_MSGPACK_CHANNEL,
  DB_SESSIONS_GET_MSGPACK_CHANNEL
} from '../../../shared/messagepack/binary-ipc'
import {
  registerPluginTools,
  isPluginToolsRegistered,
  getDefaultPluginToolNamesForType
} from '@renderer/lib/channel/plugin-tools'
import { DEFAULT_PLUGIN_PERMISSIONS } from '@renderer/lib/channel/types'
import {
  loadLayeredMemorySnapshot,
  type SessionMemoryScope
} from '@renderer/lib/agent/memory-files'
import type {
  UnifiedMessage,
  ProviderConfig,
  ContentBlock,
  ToolUseBlock
} from '@renderer/lib/api/types'
import { hasPendingSessionMessagesForSession } from '@renderer/hooks/use-chat-actions'
import { recordUsageEvent } from '@renderer/lib/usage-analytics'
import { emitSessionRuntimeSync } from '@renderer/lib/session-runtime-sync'
import {
  buildSystemPromptContextCacheKey,
  haveSameToolDefinitions
} from '@renderer/lib/chat-mode-tools'
import { ensureRequestToolCatalogFresh } from '@renderer/lib/tools/dynamic-tool-catalog'
import {
  summarizeToolInputForHistory,
  summarizeToolInputForLiveCard
} from '@renderer/lib/tools/tool-input-sanitizer'
import { filterTeamToolDefinitions } from '@renderer/lib/agent/teams/register'

interface PluginSessionSummaryRow {
  id: string
  title: string
  icon: string | null
  mode: string
  created_at: number
  updated_at: number
  project_id?: string | null
  working_folder: string | null
  ssh_connection_id?: string | null
  plan_id?: string | null
  pinned: number
  message_count?: number
  plugin_id?: string | null
  external_chat_id?: string | null
  provider_id?: string | null
  model_id?: string | null
}

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
const OPENAI_AUDIO_NATIVE_TIMEOUT_MS = 10 * 60 * 1000
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

function buildPluginSessionSummaryRow(args: {
  id: string
  title: string
  mode?: string
  icon?: string | null
  createdAt?: number
  updatedAt?: number
  projectId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  planId?: string | null
  pinned?: boolean | number
  messageCount?: number
  pluginId: string
  chatId: string
  externalChatId?: string | null
  providerId?: string | null
  modelId?: string | null
}): PluginSessionSummaryRow {
  const now = Date.now()
  return {
    id: args.id,
    title: args.title,
    icon: args.icon ?? null,
    mode: args.mode || 'cowork',
    created_at: args.createdAt ?? now,
    updated_at: args.updatedAt ?? now,
    project_id: args.projectId ?? null,
    working_folder: args.workingFolder || null,
    ssh_connection_id: args.sshConnectionId ?? null,
    plan_id: args.planId ?? null,
    pinned: typeof args.pinned === 'number' ? args.pinned : args.pinned ? 1 : 0,
    message_count: args.messageCount ?? 0,
    plugin_id: args.pluginId,
    external_chat_id:
      args.externalChatId ?? buildPluginMessageSessionKey(args.pluginId, args.chatId),
    provider_id: args.providerId ?? null,
    model_id: args.modelId ?? null
  }
}

function stripThinkTagMarkers(text: string): string {
  return text.replace(/<\s*\/?\s*think\s*>/gi, '')
}

function beginPluginRuntimeTurn(
  sessionId: string,
  userMsg: UnifiedMessage,
  assistantMsg: UnifiedMessage,
  assistantMsgId: string
): void {
  useChatStore.getState().beginUserTurn(sessionId, userMsg, assistantMsg, assistantMsgId)
  emitSessionRuntimeSync({ kind: 'add_message', sessionId, message: userMsg })
  emitSessionRuntimeSync({ kind: 'add_message', sessionId, message: assistantMsg })
  emitSessionRuntimeSync({ kind: 'set_streaming_message', sessionId, messageId: assistantMsgId })
}

function addPluginRuntimeMessage(sessionId: string, message: UnifiedMessage): void {
  useChatStore.getState().addMessage(sessionId, message)
  emitSessionRuntimeSync({ kind: 'add_message', sessionId, message })
}

function setPluginRuntimeStreamingMessage(sessionId: string, messageId: string | null): void {
  useChatStore.getState().setStreamingMessageId(sessionId, messageId)
  emitSessionRuntimeSync({ kind: 'set_streaming_message', sessionId, messageId })
}

function updatePluginRuntimeMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<UnifiedMessage>
): void {
  useChatStore.getState().updateMessage(sessionId, messageId, patch)
  emitSessionRuntimeSync({ kind: 'update_message', sessionId, messageId, patch })
}

function appendPluginRuntimeTextDelta(sessionId: string, messageId: string, text: string): void {
  if (!text) return
  useChatStore.getState().appendTextDelta(sessionId, messageId, text)
  emitSessionRuntimeSync({ kind: 'append_text_delta', sessionId, messageId, text })
}

function appendPluginRuntimeThinkingDelta(
  sessionId: string,
  messageId: string,
  thinking: string
): void {
  const cleanedThinking = stripThinkTagMarkers(thinking)
  if (!cleanedThinking) return
  useChatStore.getState().appendThinkingDelta(sessionId, messageId, cleanedThinking)
  emitSessionRuntimeSync({
    kind: 'append_thinking_delta',
    sessionId,
    messageId,
    thinking: cleanedThinking
  })
}

function setPluginRuntimeThinkingEncryptedContent(
  sessionId: string,
  messageId: string,
  encryptedContent: string,
  provider: 'anthropic' | 'openai-responses' | 'google'
): void {
  if (!encryptedContent) return
  useChatStore
    .getState()
    .setThinkingEncryptedContent(sessionId, messageId, encryptedContent, provider)
  emitSessionRuntimeSync({
    kind: 'set_thinking_encrypted',
    sessionId,
    messageId,
    encryptedContent,
    provider
  })
}

function completePluginRuntimeThinking(sessionId: string, messageId: string): void {
  useChatStore.getState().completeThinking(sessionId, messageId)
  emitSessionRuntimeSync({ kind: 'complete_thinking', sessionId, messageId })
}

function appendPluginRuntimeToolUse(
  sessionId: string,
  messageId: string,
  toolUse: ToolUseBlock
): void {
  const normalizedToolUse: ToolUseBlock = {
    ...toolUse,
    input: summarizeToolInputForHistory(toolUse.name, toolUse.input)
  }
  useChatStore.getState().appendToolUse(sessionId, messageId, normalizedToolUse)
  emitSessionRuntimeSync({
    kind: 'append_tool_use',
    sessionId,
    messageId,
    toolUse: normalizedToolUse
  })
}

function updatePluginRuntimeToolUseInput(
  sessionId: string,
  messageId: string,
  toolUseId: string,
  input: Record<string, unknown>
): void {
  useChatStore.getState().updateToolUseInput(sessionId, messageId, toolUseId, input)
  emitSessionRuntimeSync({
    kind: 'update_tool_use_input',
    sessionId,
    messageId,
    toolUseId,
    input
  })
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

  // ── Provider config (with per-channel model override) ──
  const providerStore = useProviderStore.getState()
  const targetProviderId = channelMeta?.providerId ?? providerStore.activeProviderId
  if (targetProviderId) {
    const ready = await ensureProviderAuthReady(targetProviderId)
    if (!ready) {
      console.error('[PluginAutoReply] Provider auth missing')
      await sendChannelNotice(
        'Model provider not configured or authentication incomplete, please configure in settings and try again.'
      )
      return
    }
  }

  const providerConfig = getProviderConfig(channelMeta?.providerId, channelMeta?.model)
  if (!providerConfig) {
    console.error('[PluginAutoReply] No provider config — API key not configured')
    await sendChannelNotice(
      'Model provider or API Key not configured, please configure in settings and try again.'
    )
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
        'Voice message received, but speech recognition model not configured. Please select one in Settings → Model → Speech Recognition Model and try again.'
      )
      return
    }

    const ready = await ensureProviderAuthReady(speechProviderId)
    if (!ready) {
      await sendChannelNotice(
        'Speech recognition provider authentication incomplete, please complete authentication in Settings → Model and try again.'
      )
      return
    }

    const openAiConfig = resolveOpenAiProviderConfig(speechProviderId, speechModelId)
    if (!openAiConfig) {
      await sendChannelNotice(
        'Speech recognition requires an OpenAI-compatible provider. Please select an OpenAI-compatible model in Settings → Model → Speech Recognition Model and try again.'
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
        await sendChannelNotice(`Voice download failed: ${download?.error ?? 'unknown error'}`)
        return
      }

      const reportedMediaType = (download.mediaType ?? '').trim().toLowerCase()
      const effectiveMediaType =
        (reportedMediaType && reportedMediaType !== 'application/octet-stream'
          ? reportedMediaType
          : task.audio.mediaType) ?? 'application/octet-stream'

      const transcript = await transcribeFeishuAudio({
        config: openAiConfig.config,
        base64: download.base64,
        mediaType: effectiveMediaType,
        fileName: task.audio.fileName ?? 'audio'
      })

      effectiveContent = transcript.trim()
        ? transcript
        : '[Voice transcribed, but content is empty]'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await sendChannelNotice(`Voice transcription failed: ${msg}`)
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
        initialContent: '',
        messageId: task.messageId
      })) as { ok: boolean }
      streamingActive = !!res?.ok
    } catch (err) {
      console.warn('[PluginAutoReply] Failed to start streaming card:', err)
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
        const row = await invokeMessagePackBinary<{
          id: string
          name: string
          created_at: number
          updated_at: number
          working_folder?: string | null
          ssh_connection_id?: string | null
          plugin_id?: string | null
        } | null>(DB_PROJECTS_GET_MSGPACK_CHANNEL, channelProjectId)
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
  if (session) {
    useChatStore.getState().upsertSessionFromSync(
      buildPluginSessionSummaryRow({
        id: sessionId,
        title: shouldReplaceSessionTitle(session.title, resolvedTitle)
          ? resolvedTitle
          : session.title || resolvedTitle,
        icon: session.icon ?? null,
        mode: session.mode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        projectId: channelProjectId ?? session.projectId ?? null,
        workingFolder: channelWorkDir || session.workingFolder || null,
        sshConnectionId: channelSshConnectionId ?? session.sshConnectionId ?? null,
        planId: session.planId ?? null,
        pinned: session.pinned,
        messageCount: session.messageCount,
        pluginId: session.pluginId ?? pluginId,
        chatId: task.chatId,
        externalChatId:
          session.externalChatId ?? buildPluginMessageSessionKey(pluginId, task.chatId),
        providerId: session.providerId ?? channelMeta?.providerId ?? null,
        modelId: session.modelId ?? channelMeta?.model ?? null
      }),
      { preserveLoadedMessages: true }
    )
    session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  }
  if (!session) {
    try {
      const row = await invokeMessagePackBinary<{
        session?: Partial<PluginSessionSummaryRow>
      } | null>(DB_SESSIONS_GET_MSGPACK_CHANNEL, sessionId)
      const dbSession = row?.session
      if (dbSession) {
        const sessionRow = buildPluginSessionSummaryRow({
          id: dbSession.id || sessionId,
          title: shouldReplaceSessionTitle(dbSession.title, resolvedTitle)
            ? resolvedTitle
            : dbSession.title || resolvedTitle,
          icon: dbSession.icon ?? null,
          mode: dbSession.mode || 'cowork',
          createdAt: dbSession.created_at ?? Date.now(),
          updatedAt: dbSession.updated_at ?? Date.now(),
          projectId: dbSession.project_id ?? channelProjectId ?? null,
          workingFolder: dbSession.working_folder || channelWorkDir || null,
          sshConnectionId: dbSession.ssh_connection_id ?? channelSshConnectionId ?? null,
          planId: dbSession.plan_id ?? null,
          pinned: dbSession.pinned ?? 0,
          messageCount: dbSession.message_count ?? 0,
          pluginId: dbSession.plugin_id ?? pluginId,
          chatId: task.chatId,
          externalChatId:
            dbSession.external_chat_id ?? buildPluginMessageSessionKey(pluginId, task.chatId),
          providerId: dbSession.provider_id || channelMeta?.providerId || null,
          modelId: dbSession.model_id || channelMeta?.model || null
        })
        useChatStore.getState().upsertSessionFromSync(sessionRow, { preserveLoadedMessages: true })
        session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
      }
    } catch (err) {
      console.warn('[PluginAutoReply] DB query failed:', err)
    }
  }

  if (!session) {
    const now = Date.now()
    const sessionRow = buildPluginSessionSummaryRow({
      id: sessionId,
      title: resolvedTitle,
      mode: 'cowork',
      createdAt: now,
      updatedAt: now,
      projectId: channelProjectId ?? null,
      workingFolder: channelWorkDir || null,
      sshConnectionId: channelSshConnectionId ?? null,
      pluginId,
      chatId: task.chatId,
      providerId: channelMeta?.providerId || null,
      modelId: channelMeta?.model || null
    })
    useChatStore.getState().upsertSessionFromSync(sessionRow, { preserveLoadedMessages: true })
    session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
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

  await ensureRequestToolCatalogFresh()

  // ── Build tools (same as main agent's cowork branch) ──
  const settings = useSettingsStore.getState()
  const allToolDefs = filterTeamToolDefinitions(
    toolRegistry.getStableDefinitions(),
    settings.teamToolsEnabled
  )
  let userPrompt = settings.systemPrompt || ''

  const channelDescriptor = channelMeta
    ? useChannelStore.getState().getDescriptor(channelMeta.type)
    : undefined
  const channelToolNames = Array.from(
    new Set([
      ...(channelDescriptor?.tools ?? []),
      ...getDefaultPluginToolNamesForType(channelMeta?.type ?? pluginType)
    ])
  )
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

  const sessionScope: SessionMemoryScope = 'channel'
  const memorySnapshot = await loadLayeredMemorySnapshot(ipcClient, {
    workingFolder: session.workingFolder,
    sshConnectionId: session.sshConnectionId,
    scope: sessionScope
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
  const promptContextCacheKey = buildSystemPromptContextCacheKey({
    language: settings.language,
    userRules: userPrompt,
    environmentContext,
    memorySnapshot
  })
  const cachedPromptSnapshot = session.promptSnapshot
  const canReusePromptSnapshot =
    !!cachedPromptSnapshot &&
    cachedPromptSnapshot.mode === 'cowork' &&
    cachedPromptSnapshot.planMode === false &&
    cachedPromptSnapshot.workingFolder === session.workingFolder &&
    cachedPromptSnapshot.projectId === session.projectId &&
    cachedPromptSnapshot.sshConnectionId === session.sshConnectionId &&
    cachedPromptSnapshot.contextCacheKey === promptContextCacheKey &&
    haveSameToolDefinitions(cachedPromptSnapshot.toolDefs, allToolDefs) &&
    // Discard stale snapshots that lack plugin tools (issue #73).
    cachedPromptSnapshot.toolDefs.some((t) => t.name === 'PluginSendMessage')

  let effectiveToolDefs = allToolDefs
  let systemPrompt = cachedPromptSnapshot?.systemPrompt ?? ''

  if (!canReusePromptSnapshot) {
    systemPrompt = buildSystemPrompt({
      mode: 'cowork',
      workingFolder: session.workingFolder,
      sessionId,
      userRules: userPrompt,
      toolDefs: allToolDefs,
      language: settings.language,
      memorySnapshot,
      sessionScope,
      environmentContext
    })

    useChatStore.getState().setSessionPromptSnapshot(sessionId, {
      mode: 'cowork',
      planMode: false,
      systemPrompt,
      toolDefs: allToolDefs,
      projectId: session.projectId,
      workingFolder: session.workingFolder,
      sshConnectionId: session.sshConnectionId,
      contextCacheKey: promptContextCacheKey
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

  const assistantMsgId = nanoid()
  const assistantMsg: UnifiedMessage = {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    createdAt: Date.now()
  }
  useAgentStore.getState().setRunning(true)
  useAgentStore.getState().setSessionStatus(sessionId, 'running')
  beginPluginRuntimeTurn(sessionId, userMsg, assistantMsg, assistantMsgId)

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

  let fullText = ''
  let lastError: string | null = null
  let pendingText = ''
  let pendingPluginDelta = ''
  let pluginStreamUpdateInFlight: Promise<unknown> | null = null
  let pendingPluginStreamFlush = false
  let deliveredChannelTextLength = 0
  const pendingToolInputs = new Map<string, Record<string, unknown>>()
  const liveToolNames = new Map<string, string>()
  const visibleToolUseIds = new Set<string>()
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null
  let hasThinkingDelta = false
  let thinkingDone = true
  const toolInputThrottle = new Map<
    string,
    { lastFlush: number; pending?: Record<string, unknown>; timer?: ReturnType<typeof setTimeout> }
  >()
  const unthrottledLiveToolInputs = new Set(['TaskCreate', 'TaskUpdate'])

  const flushPluginStreamUpdate = async (): Promise<void> => {
    if (!streamingActive) return
    if (pluginStreamUpdateInFlight) {
      pendingPluginStreamFlush = true
      await pluginStreamUpdateInFlight
    }

    if (!pendingPluginDelta) return

    const delta = pendingPluginDelta
    pendingPluginDelta = ''
    let appendSucceeded = false
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
        appendSucceeded = true
      })
      .catch(() => {
        pendingPluginDelta = `${delta}${pendingPluginDelta}`
      })
      .finally(() => {
        pluginStreamUpdateInFlight = null
      })

    await pluginStreamUpdateInFlight
    const shouldFlushAgain = appendSucceeded && pendingPluginStreamFlush && pendingPluginDelta
    pendingPluginStreamFlush = false
    if (shouldFlushAgain) {
      await flushPluginStreamUpdate()
    }
  }

  const flushStreamingState = (): Promise<void> => {
    if (streamFlushTimer) {
      clearTimeout(streamFlushTimer)
      streamFlushTimer = null
    }
    if (pendingText) {
      appendPluginRuntimeTextDelta(sessionId, assistantMsgId, pendingText)
      pendingText = ''
    }
    if (pendingToolInputs.size > 0) {
      for (const [toolCallId, partialInput] of pendingToolInputs) {
        updatePluginRuntimeToolUseInput(sessionId, assistantMsgId, toolCallId, partialInput)
      }
      pendingToolInputs.clear()
    }
    return flushPluginStreamUpdate()
  }

  const scheduleStreamingFlush = (): void => {
    if (streamFlushTimer) return
    streamFlushTimer = setTimeout(() => {
      streamFlushTimer = null
      void flushStreamingState()
    }, PLUGIN_STREAM_DELTA_FLUSH_MS)
  }

  const flushToolInput = (toolCallId: string): void => {
    const entry = toolInputThrottle.get(toolCallId)
    if (!entry?.pending) return
    entry.lastFlush = Date.now()
    const pending = entry.pending
    entry.pending = undefined
    useAgentStore.getState().updateToolCall(toolCallId, { input: pending }, sessionId)
  }

  const scheduleToolInputUpdate = (
    toolCallId: string,
    partialInput: Record<string, unknown>,
    toolName = ''
  ): void => {
    const now = Date.now()
    const entry = toolInputThrottle.get(toolCallId) ?? { lastFlush: 0 }
    entry.pending = partialInput
    toolInputThrottle.set(toolCallId, entry)

    if (unthrottledLiveToolInputs.has(toolName)) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
      flushToolInput(toolCallId)
      return
    }

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

  const flushChannelTextBeforeTool = async (reason: string): Promise<void> => {
    await flushStreamingState()

    const nextDeliveredLength = fullText.length
    const pendingChannelText = fullText.slice(deliveredChannelTextLength).trim()
    if (!pendingChannelText) {
      deliveredChannelTextLength = nextDeliveredLength
      return
    }

    if (streamingActive) {
      deliveredChannelTextLength = nextDeliveredLength
      console.log(
        `[PluginAutoReply] Flushed streaming card text before ${reason} for ${pluginId}:${chatId}`
      )
      return
    }

    const sent = await sendPluginMessage(pendingChannelText)
    if (sent) {
      deliveredChannelTextLength = nextDeliveredLength
      console.log(`[PluginAutoReply] Sent partial text before ${reason} for ${pluginId}:${chatId}`)
    }
  }

  try {
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

    for await (const event of loop) {
      if (ac.signal.aborted) break

      switch (event.type) {
        case 'thinking_delta':
          hasThinkingDelta = true
          thinkingDone = false
          appendPluginRuntimeThinkingDelta(sessionId, assistantMsgId, event.thinking)
          break

        case 'thinking_encrypted':
          if (event.thinkingEncryptedContent && event.thinkingEncryptedProvider) {
            setPluginRuntimeThinkingEncryptedContent(
              sessionId,
              assistantMsgId,
              event.thinkingEncryptedContent,
              event.thinkingEncryptedProvider
            )
          }
          break

        case 'text_delta': {
          let visibleText = event.text
          if (hasThinkingDelta && !thinkingDone) {
            const closeThinkTagMatch = visibleText.match(/<\s*\/\s*think\s*>/i)
            if (closeThinkTagMatch?.index !== undefined) {
              const beforeClose = visibleText.slice(0, closeThinkTagMatch.index)
              const afterClose = visibleText.slice(
                closeThinkTagMatch.index + closeThinkTagMatch[0].length
              )
              if (beforeClose) {
                appendPluginRuntimeThinkingDelta(sessionId, assistantMsgId, beforeClose)
              }
              thinkingDone = true
              completePluginRuntimeThinking(sessionId, assistantMsgId)
              visibleText = afterClose
            } else {
              thinkingDone = true
              completePluginRuntimeThinking(sessionId, assistantMsgId)
            }
          }
          if (!visibleText) break
          fullText += visibleText
          pendingText += visibleText
          pendingPluginDelta += visibleText
          scheduleStreamingFlush()
          break
        }

        case 'tool_use_streaming_start':
          liveToolNames.set(event.toolCallId, event.toolName)
          await flushStreamingState()
          if (hasThinkingDelta && !thinkingDone) {
            thinkingDone = true
            completePluginRuntimeThinking(sessionId, assistantMsgId)
          }
          visibleToolUseIds.add(event.toolCallId)
          appendPluginRuntimeToolUse(sessionId, assistantMsgId, {
            type: 'tool_use',
            id: event.toolCallId,
            name: event.toolName,
            input: {},
            ...(event.toolCallExtraContent ? { extraContent: event.toolCallExtraContent } : {})
          })
          useAgentStore.getState().addToolCall(
            {
              id: event.toolCallId,
              name: event.toolName,
              input: {},
              status: 'streaming',
              requiresApproval: false,
              ...(event.toolCallExtraContent ? { extraContent: event.toolCallExtraContent } : {})
            },
            sessionId
          )
          break

        case 'tool_use_args_delta': {
          const toolName = liveToolNames.get(event.toolCallId) ?? ''
          if (toolName === 'Edit') {
            break
          }
          const liveCardInput = summarizeToolInputForLiveCard(toolName, event.partialInput)
          pendingToolInputs.set(event.toolCallId, liveCardInput)
          if (unthrottledLiveToolInputs.has(toolName)) {
            void flushStreamingState()
          } else {
            scheduleStreamingFlush()
          }
          scheduleToolInputUpdate(event.toolCallId, liveCardInput, toolName)
          break
        }

        case 'tool_use_generated': {
          await flushChannelTextBeforeTool(event.toolUseBlock.name)
          liveToolNames.set(event.toolUseBlock.id, event.toolUseBlock.name)
          console.log(`[PluginAutoReply] Tool call: ${event.toolUseBlock.name}`)
          const liveCardInput = summarizeToolInputForLiveCard(
            event.toolUseBlock.name,
            event.toolUseBlock.input
          )
          if (!visibleToolUseIds.has(event.toolUseBlock.id)) {
            if (hasThinkingDelta && !thinkingDone) {
              thinkingDone = true
              completePluginRuntimeThinking(sessionId, assistantMsgId)
            }
            visibleToolUseIds.add(event.toolUseBlock.id)
            appendPluginRuntimeToolUse(sessionId, assistantMsgId, {
              type: 'tool_use',
              id: event.toolUseBlock.id,
              name: event.toolUseBlock.name,
              input: liveCardInput,
              ...(event.toolUseBlock.extraContent
                ? { extraContent: event.toolUseBlock.extraContent }
                : {})
            })
            useAgentStore.getState().addToolCall(
              {
                id: event.toolUseBlock.id,
                name: event.toolUseBlock.name,
                input: liveCardInput,
                status: 'running',
                requiresApproval: false,
                ...(event.toolUseBlock.extraContent
                  ? { extraContent: event.toolUseBlock.extraContent }
                  : {}),
                startedAt: Date.now()
              },
              sessionId
            )
          } else {
            updatePluginRuntimeToolUseInput(
              sessionId,
              assistantMsgId,
              event.toolUseBlock.id,
              liveCardInput
            )
          }
          flushToolInput(event.toolUseBlock.id)
          useAgentStore.getState().updateToolCall(
            event.toolUseBlock.id,
            {
              input: liveCardInput,
              ...(event.toolUseBlock.extraContent
                ? { extraContent: event.toolUseBlock.extraContent }
                : {})
            },
            sessionId
          )
          break
        }

        case 'tool_call_start':
          await flushChannelTextBeforeTool(event.toolCall.name)
          useAgentStore.getState().addToolCall(
            {
              ...event.toolCall,
              input: summarizeToolInputForLiveCard(event.toolCall.name, event.toolCall.input)
            },
            sessionId
          )
          break

        case 'tool_call_result': {
          const settledInput =
            event.toolCall.status === 'completed' || event.toolCall.status === 'error'
              ? summarizeToolInputForHistory(event.toolCall.name, event.toolCall.input)
              : undefined
          if (settledInput) {
            updatePluginRuntimeToolUseInput(
              sessionId,
              assistantMsgId,
              event.toolCall.id,
              settledInput
            )
          }
          useAgentStore.getState().updateToolCall(
            event.toolCall.id,
            {
              ...(settledInput ? { input: settledInput } : {}),
              status: event.toolCall.status,
              output: event.toolCall.output,
              error: event.toolCall.error,
              completedAt: event.toolCall.completedAt
            },
            sessionId
          )
          if (event.toolCall.status === 'completed' || event.toolCall.status === 'error') {
            liveToolNames.delete(event.toolCall.id)
          }
          break
        }

        case 'message_end':
          await flushStreamingState()
          if (hasThinkingDelta && !thinkingDone) {
            thinkingDone = true
            completePluginRuntimeThinking(sessionId, assistantMsgId)
          }
          if (event.usage || event.providerResponseId) {
            const usage = event.usage
              ? {
                  ...event.usage,
                  contextTokens: event.usage.contextTokens ?? event.usage.inputTokens
                }
              : undefined
            updatePluginRuntimeMessage(sessionId, assistantMsgId, {
              ...(usage ? { usage } : {}),
              ...(event.providerResponseId ? { providerResponseId: event.providerResponseId } : {})
            })
            if (!usage) break
            void recordUsageEvent({
              sessionId,
              messageId: assistantMsgId,
              sourceKind: 'plugin',
              providerId: agentProviderConfig.providerId,
              modelId: agentProviderConfig.model,
              usage,
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
          await flushStreamingState()
          hasThinkingDelta = false
          thinkingDone = true
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
            addPluginRuntimeMessage(sessionId, toolResultMsg)
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
          appendPluginRuntimeTextDelta(sessionId, assistantMsgId, `\n\n> **Error:** ${lastError}`)
          break

        default:
          break
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    console.error('[PluginAutoReply] Agent loop exception:', err)
    appendPluginRuntimeTextDelta(sessionId, assistantMsgId, `\n\n> **Error:** ${lastError}`)
  }

  // ── Finalize ──
  await flushStreamingState()
  for (const [toolCallId, entry] of toolInputThrottle) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    flushToolInput(toolCallId)
  }
  toolInputThrottle.clear()
  if (hasThinkingDelta && !thinkingDone) {
    thinkingDone = true
    completePluginRuntimeThinking(sessionId, assistantMsgId)
  }

  const fallbackMessage = lastError
    ? `Model run failed: ${lastError}`
    : 'Model did not return a text reply, please check your current model configuration'
  if (!fullText.trim()) {
    appendPluginRuntimeTextDelta(sessionId, assistantMsgId, fallbackMessage)
  }
  setPluginRuntimeStreamingMessage(sessionId, null)
  useAgentStore.getState().setSessionStatus(sessionId, 'completed')
  const hasOtherRunning = Object.values(useAgentStore.getState().runningSessions).some(
    (status) => status === 'running' || status === 'retrying'
  )
  useAgentStore.getState().setRunning(hasOtherRunning)

  // Persist the final message state to DB.
  // Do NOT overwrite content with fullText — the message content already contains
  // structured blocks (text + tool_use) built up during streaming via appendTextDelta
  // and appendToolUse. Overwriting with plain text would destroy tool_use blocks.
  // Trigger a DB flush by calling updateMessage with the current content.
  const finalSession = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  const finalMsg = finalSession?.messages.find((m) => m.id === assistantMsgId)
  if (finalMsg) {
    updatePluginRuntimeMessage(sessionId, assistantMsgId, { content: finalMsg.content })
  }

  const finalText = fullText.trim() ? fullText : fallbackMessage
  const remainingFinalChannelText = fullText.trim()
    ? fullText.slice(deliveredChannelTextLength).trim()
    : fallbackMessage
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

  if (!streamingActive && remainingFinalChannelText) {
    const sent = await sendPluginMessage(remainingFinalChannelText)
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
export function usePluginAutoReply(enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    initPluginAutoReplyListener()
  }, [enabled])
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
  config: ProviderConfig
  base64: string
  mediaType: string
  fileName: string
}): Promise<string> {
  const initialized = await agentBridge.initialize()
  if (!initialized) {
    throw new Error('Native worker unavailable for audio transcription.')
  }

  const result = (await agentBridge.request(
    'openai-audio/transcribe',
    {
      provider: params.config,
      file: {
        base64: params.base64,
        mediaType: params.mediaType,
        fileName: params.fileName
      }
    },
    OPENAI_AUDIO_NATIVE_TIMEOUT_MS
  )) as { text?: string }

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
