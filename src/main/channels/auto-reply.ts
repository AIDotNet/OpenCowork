import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { getNativeWorker } from '../lib/native-worker'
import { readChannelPlugins } from './channel-config-store'
import { sendMessagePackToAllWindowsCounted } from '../window-ipc'
import type { ChannelEvent, ChannelInstance, ChannelIncomingMessageData } from './channel-types'
import type { ChannelManager } from './channel-manager'
import { tryHandleCommand } from './plugin-commands'
import { runHeadlessChannelAutoReply } from './headless-auto-reply'

interface NativePluginRouteSessionResult {
  success: boolean
  sessionId?: string | null
  sessionTitle?: string | null
  projectId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  error?: string | null
}

const TASK_ACK_CHANNEL = 'plugin:session-task-ack'
const TASK_ACK_TIMEOUT_MS = 2500

let _pluginManager: ChannelManager | null = null
let _ackHandlerRegistered = false
const pendingTaskAcks = new Map<string, (acked: boolean) => void>()

/** Must be called once at startup to wire the plugin manager */
export function setPluginManager(pm: ChannelManager): void {
  _pluginManager = pm
  if (!_ackHandlerRegistered) {
    _ackHandlerRegistered = true
    ipcMain.handle(TASK_ACK_CHANNEL, (_event, taskId: unknown) => {
      const resolve = typeof taskId === 'string' ? pendingTaskAcks.get(taskId) : undefined
      if (resolve) resolve(true)
      return { ok: Boolean(resolve) }
    })
  }
}

function waitForTaskAck(taskId: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingTaskAcks.delete(taskId)
      resolve(false)
    }, timeoutMs)
    pendingTaskAcks.set(taskId, (acked) => {
      clearTimeout(timer)
      pendingTaskAcks.delete(taskId)
      resolve(acked)
    })
  })
}

/**
 * Auto-reply pipeline: routes incoming plugin messages to per-user/per-group sessions
 * and triggers the agent reply. When a renderer window is alive it keeps owning the
 * run (rich streaming UX); with no window — or an unresponsive renderer — the reply
 * executes headless in the main process through the Worker hosted-session path.
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

    // NOTE: We do NOT insert the user message here — the owning executor persists it
    // (renderer sendMessage, or the headless runner) to avoid duplicates and ensure
    // proper multi-modal content handling.

    // Check if the plugin service supports streaming
    const service = _pluginManager?.getService(pluginId)
    const supportsStreaming = !!(service?.supportsStreaming && service?.sendStreamingMessage)

    const taskId = nanoid()
    const taskPayload = {
      taskId,
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

    // Prefer the renderer path when a window is alive: it owns streaming cards,
    // live chat UI, and usage recording. Fall back to the headless main-process
    // runner when no renderer acknowledges the task — closed windows must not
    // break channel auto-reply.
    const deliveredWindows = sendMessagePackToAllWindowsCounted('plugin:session-task', taskPayload)
    const acked = deliveredWindows > 0 && (await waitForTaskAck(taskId, TASK_ACK_TIMEOUT_MS))

    if (acked) {
      console.log(
        `[AutoReply] Routed message from ${data.senderName || data.senderId} ` +
          `in chat ${data.chatId} to session ${sessionId} (renderer)`
      )
      return
    }

    console.log(
      `[AutoReply] No renderer ack (windows=${deliveredWindows}), running headless ` +
        `for chat ${data.chatId} session ${sessionId}`
    )
    await runHeadlessChannelAutoReply({
      sessionId,
      pluginId,
      pluginType: event.pluginType,
      chatId: data.chatId,
      chatType: data.chatType,
      senderId: data.senderId,
      senderName: data.senderName,
      chatName: data.chatName,
      content: taskPayload.content,
      messageId: data.messageId,
      images: data.images,
      audio: data.audio,
      workingFolder: pluginWorkDir || undefined,
      sshConnectionId: pluginSshConnectionId
    })
  } catch (err) {
    console.error('[AutoReply] Failed to route incoming message:', err)
  }
}
