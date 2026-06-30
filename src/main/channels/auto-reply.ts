import { getNativeWorker } from '../lib/native-worker'
import { readChannelPlugins } from './channel-config-store'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import type { ChannelEvent, ChannelInstance, ChannelIncomingMessageData } from './channel-types'
import type { ChannelManager } from './channel-manager'
import { tryHandleCommand } from './plugin-commands'

interface NativePluginRouteSessionResult {
  success: boolean
  sessionId?: string | null
  sessionTitle?: string | null
  projectId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  error?: string | null
}

let _pluginManager: ChannelManager | null = null

/** Must be called once at startup to wire the plugin manager */
export function setPluginManager(pm: ChannelManager): void {
  _pluginManager = pm
}

/**
 * Auto-reply pipeline: routes incoming plugin messages to per-user/per-group sessions
 * and notifies the renderer to trigger the Agent Loop for auto-reply.
 */
export function handleChannelAutoReply(event: ChannelEvent): void {
  void handleChannelAutoReplyAsync(event)
}

async function handleChannelAutoReplyAsync(event: ChannelEvent): Promise<void> {
  if (event.type !== 'incoming_message') return

  const data = event.data as ChannelIncomingMessageData
  if (!data || !data.chatId || (!data.content && !data.images?.length && !data.audio)) return

  const pluginId = event.pluginId

  try {
    let pluginInstance: ChannelInstance | undefined
    try {
      const plugins = await readChannelPlugins()
      pluginInstance = plugins.find((p) => p.id === pluginId)
    } catch {
      /* ignore read errors */
    }

    const routedSession = await getNativeWorker().request<NativePluginRouteSessionResult>(
      'db/plugin-route-session',
      {
        pluginId,
        chatId: data.chatId,
        chatName: data.chatName ?? null,
        senderName: data.senderName ?? null,
        projectId: pluginInstance?.projectId ?? null,
        providerId: pluginInstance?.providerId ?? null,
        modelId: pluginInstance?.model ?? null
      },
      120_000
    )

    if (!routedSession.success || !routedSession.sessionId) {
      throw new Error(routedSession.error || 'Native plugin session routing failed')
    }

    const sessionId = routedSession.sessionId
    const sessionTitle =
      routedSession.sessionTitle || data.chatName || data.senderName || data.chatId
    const pluginWorkDir = routedSession.workingFolder ?? ''
    const pluginSshConnectionId = routedSession.sshConnectionId ?? null

    // ── Command interception: handle /help, /new, /init, /status etc. before agent loop ──
    // Always attempt command parsing — tryHandleCommand handles @mention stripping internally
    if (_pluginManager && data.content?.trim()) {
      const commandResult = await tryHandleCommand({
        pluginId,
        pluginType: event.pluginType,
        chatId: data.chatId,
        data,
        sessionId,
        pluginWorkDir,
        pluginManager: _pluginManager
      })
      // true = fully handled, skip agent loop
      if (commandResult === true) return
      // string = command rewrote the message, pass to agent loop with new content
      if (typeof commandResult === 'string') {
        data.content = commandResult
      }
      // false = not a command, proceed with original content
    }

    // NOTE: We do NOT insert the user message here — the renderer's sendMessage
    // will handle it (via triggerSendMessage) to avoid duplicate messages and
    // ensure proper multi-modal content handling.

    // Check if the plugin service supports streaming
    const service = _pluginManager?.getService(pluginId)
    const supportsStreaming = !!(service?.supportsStreaming && service?.sendStreamingMessage)

    // Notify renderer to trigger Agent Loop auto-reply
    const taskPayload = {
      sessionId,
      pluginId,
      pluginType: event.pluginType,
      chatId: data.chatId,
      senderId: data.senderId,
      senderName: data.senderName,
      chatName: data.chatName,
      sessionTitle,
      content:
        data.content ||
        (data.images?.length ? '[User sent an image]' : '') ||
        (data.audio ? '[User sent an audio message]' : ''),
      messageId: data.messageId,
      supportsStreaming,
      images: data.images,
      audio: data.audio,
      chatType: data.chatType,
      projectId: routedSession.projectId ?? undefined,
      workingFolder: pluginWorkDir || undefined,
      sshConnectionId: pluginSshConnectionId
    }
    safeSendMessagePackToAllWindows('plugin:session-task', taskPayload)

    console.log(
      `[AutoReply] Routed message from ${data.senderName || data.senderId} ` +
        `in chat ${data.chatId} to session ${sessionId}`
    )
  } catch (err) {
    console.error('[AutoReply] Failed to route incoming message:', err)
  }
}
