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
import { runAgentLoop } from '@renderer/lib/agent/agent-loop'
import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { buildSystemPrompt } from '@renderer/lib/agent/system-prompt'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { usePluginStore } from '@renderer/stores/plugin-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { registerPluginTools, isPluginToolsRegistered } from '@renderer/lib/plugins/plugin-tools'
import { DEFAULT_PLUGIN_PERMISSIONS } from '@renderer/lib/plugins/types'
import {
  joinFsPath,
  loadOptionalMemoryFile,
  loadGlobalMemorySnapshot
} from '@renderer/lib/agent/memory-files'
import type { UnifiedMessage, ProviderConfig } from '@renderer/lib/api/types'
import type { AgentLoopConfig } from '@renderer/lib/agent/types'
import type { ToolContext } from '@renderer/lib/tools/tool-types'
import {
  hasActiveSessionRunForSession,
  hasPendingSessionMessagesForSession,
  dispatchNextQueuedMessageForSession
} from '@renderer/hooks/use-chat-actions'

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
  images?: Array<{ base64: string; mediaType: string }>
  audio?: { fileKey: string; fileName?: string; mediaType?: string; durationMs?: number }
}


async function _runPluginAgent(task: PluginAutoReplyTask): Promise<void> {
  const { sessionId, pluginId, pluginType, chatId, supportsStreaming } = task

  // ── Check feature toggles ──
  const pluginMeta = usePluginStore.getState().plugins.find((p) => p.id === pluginId)
  const features = pluginMeta?.features ?? { autoReply: true, streamingReply: true, autoStart: true }
  const pluginTypeFromStore = (pluginMeta?.type ?? '').toLowerCase()
  const pluginTypeFromTask = (pluginType ?? '').toLowerCase()
  const isFeishuPlugin = pluginTypeFromStore === 'feishu-bot'
    || pluginTypeFromTask === 'feishu-bot'
    || pluginTypeFromStore === 'feishu'
    || pluginTypeFromTask === 'feishu'
  if (!features.autoReply) {
    console.log(`[PluginAutoReply] Auto-reply disabled for plugin ${pluginId}, skipping`)
    return
  }

  const sendPluginNotice = async (message: string): Promise<void> => {
    try {
      await ipcClient.invoke(IPC.PLUGIN_EXEC, {
        pluginId,
        action: 'sendMessage',
        params: { chatId, content: message },
      })
    } catch (err) {
      console.error('[PluginAutoReply] Failed to send notice:', err)
    }
  }

  // ── Provider config (with per-plugin model override) ──
  const providerStore = useProviderStore.getState()
  const targetProviderId = pluginMeta?.providerId ?? providerStore.activeProviderId
  if (targetProviderId) {
    const ready = await ensureProviderAuthReady(targetProviderId)
    if (!ready) {
      console.error('[PluginAutoReply] Provider auth missing')
      await sendPluginNotice('未配置或未完成认证的模型服务商，请在设置中完成配置后再试。')
      return
    }
  }

  const providerConfig = getProviderConfig(pluginMeta?.providerId, pluginMeta?.model)
  if (!providerConfig) {
    console.error('[PluginAutoReply] No provider config — API key not configured')
    await sendPluginNotice('未配置模型服务商或 API Key，请在设置中完成配置后再试。')
    return
  }

  const supportsVision = resolveModelSupportsVision(
    pluginMeta?.providerId ?? providerStore.activeProviderId,
    pluginMeta?.model ?? providerConfig.model
  )

  let effectiveContent = task.content

  if (task.audio && isFeishuPlugin) {
    const speechProviderId = providerStore.activeSpeechProviderId
    const speechModelId = providerStore.activeSpeechModelId
    if (!speechProviderId || !speechModelId) {
      await sendPluginNotice('已收到语音消息，但未配置语音识别模型。请在 设置 → 模型 → 语音识别模型 中选择后再试。')
      return
    }

    const ready = await ensureProviderAuthReady(speechProviderId)
    if (!ready) {
      await sendPluginNotice('语音识别服务商认证未完成，请在 设置 → 模型 中完成认证后再试。')
      return
    }

    const openAiConfig = resolveOpenAiProviderConfig(speechProviderId, speechModelId)
    if (!openAiConfig) {
      await sendPluginNotice('语音识别需要 OpenAI 兼容服务商。请在 设置 → 模型 → 语音识别模型 中选择 OpenAI 兼容模型后再试。')
      return
    }

    try {
      const download = await ipcClient.invoke(IPC.PLUGIN_FEISHU_DOWNLOAD_RESOURCE, {
        pluginId,
        messageId: task.messageId,
        fileKey: task.audio.fileKey,
        type: 'file',
      }) as { ok?: boolean; base64?: string; mediaType?: string; error?: string }

      if (!download?.base64 || download.error) {
        await sendPluginNotice(`语音下载失败：${download?.error ?? 'unknown error'}`)
        return
      }

      const reportedMediaType = (download.mediaType ?? '').trim().toLowerCase()
      const effectiveMediaType = (reportedMediaType && reportedMediaType !== 'application/octet-stream'
        ? reportedMediaType
        : task.audio.mediaType) ?? 'application/octet-stream'

      const transcript = await transcribeFeishuAudio({
        base64: download.base64,
        mediaType: effectiveMediaType,
        fileName: task.audio.fileName ?? 'audio',
        model: openAiConfig.config.model,
        apiKey: openAiConfig.config.apiKey,
        baseUrl: openAiConfig.config.baseUrl,
      })

      effectiveContent = transcript.trim()
        ? transcript
        : '[语音已转写，但内容为空]'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await sendPluginNotice(`语音转写失败：${msg}`)
      return
    }
  } else if (task.audio) {
    console.warn('[PluginAutoReply] Skip audio transcription because plugin type is not Feishu', {
      pluginId,
      messageId: task.messageId,
      pluginTypeFromTask: pluginType,
      pluginTypeFromStore: pluginMeta?.type,
    })
  }

  // ── Start CardKit streaming card (only if streamingReply feature enabled) ──
  let streamingActive = false
  if (supportsStreaming && features.streamingReply) {
    try {
      const res = (await ipcClient.invoke('plugin:stream:start', {
        pluginId, chatId, initialContent: ' Thinking...', messageId: task.messageId,
      })) as { ok: boolean }
      streamingActive = !!res?.ok
    } catch (err) {
      console.warn('[PluginAutoReply] Failed to start streaming card:', err)
    }
  }

  // ── Resolve permissions & homedir for security enforcement ──
  const permissions = pluginMeta?.permissions ?? DEFAULT_PLUGIN_PERMISSIONS
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
  const pluginWorkDir: string = (task as { workingFolder?: string }).workingFolder ?? ''

  const resolvedTitle = task.sessionTitle || task.chatName || task.senderName || task.chatId

  let session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session) {
    try {
      const row = await ipcClient.invoke('db:sessions:get', sessionId)
      if (row) {
        const r = row as { title?: string; working_folder?: string; provider_id?: string; model_id?: string }
        const newSession = {
          id: sessionId,
          title: r.title || resolvedTitle,
          mode: 'cowork' as const,
          messages: [],
          messageCount: 0,
          messagesLoaded: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workingFolder: r.working_folder || pluginWorkDir,
          pluginId,
          externalChatId: `plugin:${pluginId}:chat:${task.chatId}`,
          providerId: r.provider_id || pluginMeta?.providerId || undefined,
          modelId: r.model_id || pluginMeta?.model || undefined,
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
    const newSession = {
      id: sessionId,
      title: resolvedTitle,
      mode: 'cowork' as const,
      messages: [],
      messageCount: 0,
      messagesLoaded: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workingFolder: pluginWorkDir,
      pluginId,
      externalChatId: `plugin:${pluginId}:chat:${task.chatId}`,
      providerId: pluginMeta?.providerId || undefined,
      modelId: pluginMeta?.model || undefined,
    }
    useChatStore.setState((state) => {
      state.sessions.push(newSession)
    })
    session = newSession
  }

  if (session) {
    useChatStore.setState((state) => {
      const s = state.sessions.find((sess) => sess.id === sessionId)
      if (s) {
        s.pluginChatType = task.chatType
        s.pluginSenderId = task.senderId
        s.pluginSenderName = task.senderName
      }
    })
    session = { ...session, pluginChatType: task.chatType, pluginSenderId: task.senderId, pluginSenderName: task.senderName }
  }

  // Update session title in store if we have a better name now
  if (session && /^oc_/.test(session.title) && resolvedTitle && !(/^oc_/.test(resolvedTitle))) {
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

  // ── Build system prompt with plugin context ──
  const settings = useSettingsStore.getState()
  let userPrompt = settings.systemPrompt || ''

  // Inject active plugin metadata
  const activePlugins = usePluginStore.getState().getActivePlugins()
  if (activePlugins.length > 0) {
    const pluginLines: string[] = ['\n## Active Plugins']
    for (const p of activePlugins) {
      pluginLines.push(`- **${p.name}** (plugin_id: \`${p.id}\`, type: ${p.type})`)
      if (p.userSystemPrompt?.trim()) {
        pluginLines.push(`  Plugin instructions: ${p.userSystemPrompt.trim()}`)
      }
      const desc = usePluginStore.getState().getDescriptor(p.type)
      const toolNames = desc?.tools ?? []
      if (toolNames.length > 0) {
        const enabled = toolNames.filter((name) => p.tools?.[name] !== false)
        const disabled = toolNames.filter((name) => p.tools?.[name] === false)
        pluginLines.push(`  Enabled tools: ${enabled.length > 0 ? enabled.join(', ') : 'none'}`)
        if (disabled.length > 0) {
          pluginLines.push(`  Disabled tools: ${disabled.join(', ')}`)
        }
      }
    }
    pluginLines.push('', 'Use the plugin_id parameter when calling Plugin* tools.')
    userPrompt = userPrompt ? `${userPrompt}\n${pluginLines.join('\n')}` : pluginLines.join('\n')
  }

  // Inject plugin session auto-reply context
  // (pluginMeta already resolved above from usePluginStore)
  const isFeishu = isFeishuPlugin

  const pluginDescriptor = pluginMeta ? usePluginStore.getState().getDescriptor(pluginMeta.type) : undefined
  const pluginToolNames = pluginDescriptor?.tools ?? []
  const enabledTools = pluginToolNames.filter((name) => pluginMeta?.tools?.[name] !== false)
  const disabledTools = pluginToolNames.filter((name) => pluginMeta?.tools?.[name] === false)

  const pluginCtx = [
    `\n## Plugin Auto-Reply Context`,
    `This session is handling messages from plugin **${pluginMeta?.name ?? pluginType}** (plugin_id: \`${pluginId}\`).`,
    `Chat ID: \`${chatId}\``,
    `Chat Type: ${task.chatType ?? 'unknown'}`,
    `Sender: ${task.senderName || task.senderId} (id: ${task.senderId})`,
    `Enabled tools: ${enabledTools.length > 0 ? enabledTools.join(', ') : 'none'}`,
    disabledTools.length > 0 ? `Disabled tools: ${disabledTools.join(', ')}` : '',
    `Your response will be streamed directly to the user in real-time via the plugin.`,
    `Just respond naturally — the streaming pipeline handles delivery automatically.`,
    `If you need to send an additional message, use PluginSendMessage with plugin_id="${pluginId}" and chat_id="${chatId}".`,

    // ── File Generation & Delivery Guidelines ──
    `\n### Generating & Delivering Files`,
    `When the user asks you to generate reports, documents, spreadsheets, code files, or any deliverable content:`,
    `1. **Use the Write tool** to create the file in the working folder (e.g. \`report.md\`, \`analysis.csv\`, \`summary.html\`, \`data.json\`). Choose the most appropriate format for the content.`,
    `2. **Send the file directly to the user** via the plugin so they receive it without extra steps:`,
    isFeishu
      ? `   - Use **FeishuSendFile** (plugin_id="${pluginId}", chat_id="${chatId}") to deliver the generated file.`
      : `   - Use **PluginSendMessage** to share the file content or a download-ready summary with the user.`,
    isFeishu
      ? `   - Use **FeishuSendImage** if the deliverable is an image (chart, screenshot, diagram).`
      : '',
    `3. **Also provide a brief summary** in your text response so the user knows what the file contains without opening it.`,
    `4. **Format guidelines**: Prefer Markdown (.md) for reports and documentation, CSV for tabular data, HTML for rich formatted reports, JSON for structured data. Use the format that best serves the user's needs.`,
    `5. **Do NOT paste entire file contents as chat messages** when the content is long (>30 lines). Write it to a file and send the file instead — this provides a much better user experience.`,

    isFeishu ? [
      `\n### Feishu Media Tools`,
      `You can send images and files to this chat:`,
      `- **FeishuSendImage**: Send an image (local path or URL). plugin_id="${pluginId}", chat_id="${chatId}"`,
      `- **FeishuSendFile**: Send a file (pdf, doc, xls, ppt, mp4, etc.). plugin_id="${pluginId}", chat_id="${chatId}"`,
      `For @mentions, fetch member open_id via **FeishuListChatMembers** and call **FeishuAtMember** (plain '@' text will not mention).`,
      `Always prefer sending files over pasting long content in messages.`,
    ].join('\n') : '',
    pluginMeta?.userSystemPrompt?.trim() ? `\nPlugin-specific instructions: ${pluginMeta.userSystemPrompt.trim()}` : '',
  ].filter(Boolean).join('\n')
  userPrompt = userPrompt ? `${userPrompt}\n${pluginCtx}` : pluginCtx

  // Load AGENTS.md memory file from working directory
  let agentsMemory: string | undefined
  if (session.workingFolder) {
    const projectMemoryPath = joinFsPath(session.workingFolder, 'AGENTS.md')
    agentsMemory = await loadOptionalMemoryFile(ipcClient, projectMemoryPath)
  }

  const globalMemorySnapshot = await loadGlobalMemorySnapshot(ipcClient)
  const globalMemory = globalMemorySnapshot.content
  const globalMemoryPath = globalMemorySnapshot.path

  const systemPrompt = buildSystemPrompt({
    mode: 'cowork',
    workingFolder: session.workingFolder,
    userSystemPrompt: userPrompt,
    toolDefs: allToolDefs,
    language: settings.language,
    agentsMemory,
    globalMemory,
    globalMemoryPath
  })

  // ── Build user message ──
  let userContent: string | Array<Record<string, unknown>> = effectiveContent
  if (task.images?.length) {
    if (supportsVision) {
      const blocks: Array<Record<string, unknown>> = []
      for (const img of task.images) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
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
    content: userContent as string,
    createdAt: Date.now(),
  }

  // Add user message to store + DB
  useChatStore.getState().addMessage(sessionId, userMsg)

  // Create assistant placeholder
  const assistantMsgId = nanoid()
  const assistantMsg: UnifiedMessage = {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
  }
  useChatStore.getState().addMessage(sessionId, assistantMsg)
  useChatStore.getState().setStreamingMessageId(sessionId, assistantMsgId)

  // ── Build agent loop config ──
  const ac = new AbortController()

  const agentProviderConfig: ProviderConfig = {
    ...providerConfig,
    systemPrompt,
    sessionId,
  }

  const loopConfig: AgentLoopConfig = {
    maxIterations: 15,
    provider: agentProviderConfig,
    tools: allToolDefs,
    systemPrompt,
    workingFolder: session.workingFolder,
    signal: ac.signal,
  }

  const toolCtx: ToolContext = {
    sessionId,
    workingFolder: session.workingFolder,
    sshConnectionId: session.sshConnectionId,
    signal: ac.signal,
    ipc: ipcClient,
    currentToolUseId: undefined,
    pluginId,
    pluginChatId: chatId,
    pluginChatType: task.chatType,
    pluginSenderId: task.senderId,
    pluginSenderName: task.senderName,
    pluginPermissions: permissions,
    pluginHomedir: homedir,
  }

  // ── Run Agent Loop ──
  const messages = useChatStore.getState().getSessionMessages(sessionId)

  // Filter out empty assistant messages (can occur if a previous run was interrupted
  // or duplicate triggers left orphaned placeholders) — API rejects empty assistant turns
  const historyMessages = messages
    .slice(0, -1) // Exclude current assistant placeholder
    .filter((m) => {
      if (m.role !== 'assistant') return true
      if (typeof m.content === 'string') return m.content.trim().length > 0
      if (Array.isArray(m.content)) return m.content.length > 0
      return false
    })

  const loop = runAgentLoop(
    historyMessages, // Clean history without empty assistant turns
    loopConfig,
    toolCtx,
  )

  let fullText = ''
  let lastError: string | null = null
  const toolInputThrottle = new Map<
    string,
    { lastFlush: number; pending?: Record<string, unknown>; timer?: ReturnType<typeof setTimeout> }
  >()

  const flushToolInput = (toolCallId: string): void => {
    const entry = toolInputThrottle.get(toolCallId)
    if (!entry?.pending) return
    entry.lastFlush = Date.now()
    const pending = entry.pending
    entry.pending = undefined
    useAgentStore.getState().updateToolCall(toolCallId, { input: pending })
  }

  const scheduleToolInputUpdate = (toolCallId: string, partialInput: Record<string, unknown>): void => {
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
          useChatStore.getState().setThinkingEncryptedContent(
            sessionId,
            assistantMsgId,
            event.thinkingEncryptedContent,
            event.thinkingEncryptedProvider
          )
        }
        break

      case 'text_delta':
        fullText += event.text
        useChatStore.getState().appendTextDelta(sessionId, assistantMsgId, event.text)

        // Forward to CardKit card
        if (streamingActive) {
          ipcClient.invoke('plugin:stream:update', {
            pluginId, chatId, content: fullText,
          }).catch(() => {})
        }
        break

      case 'tool_use_streaming_start':
        // Show tool card immediately while args are still streaming
        useChatStore.getState().appendToolUse(sessionId, assistantMsgId, {
          type: 'tool_use',
          id: event.toolCallId,
          name: event.toolName,
          input: {},
        })
        useAgentStore.getState().addToolCall({
          id: event.toolCallId,
          name: event.toolName,
          input: {},
          status: 'streaming',
          requiresApproval: false,
        })
        break

      case 'tool_use_args_delta':
        useChatStore.getState().updateToolUseInput(sessionId, assistantMsgId, event.toolCallId, event.partialInput)
        scheduleToolInputUpdate(event.toolCallId, event.partialInput)
        break

      case 'tool_use_generated':
        console.log(`[PluginAutoReply] Tool call: ${event.toolUseBlock.name}`)
        useChatStore.getState().updateToolUseInput(sessionId, assistantMsgId, event.toolUseBlock.id, event.toolUseBlock.input)
        flushToolInput(event.toolUseBlock.id)
        useAgentStore.getState().updateToolCall(event.toolUseBlock.id, {
          input: event.toolUseBlock.input,
        })
        break

      case 'tool_call_start':
        useAgentStore.getState().addToolCall(event.toolCall)
        break

      case 'tool_call_result':
        useAgentStore.getState().updateToolCall(event.toolCall.id, {
          status: event.toolCall.status,
          output: event.toolCall.output,
          error: event.toolCall.error,
          completedAt: event.toolCall.completedAt,
        })
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
              isError: tr.isError,
            })),
            createdAt: Date.now(),
          }
          useChatStore.getState().addMessage(sessionId, toolResultMsg)
        }
        // If new messages are waiting for this session, stop before issuing the
        // next API request so queued messages can be handled first.
        if (hasQueuedPluginTasks(sessionId) || hasPendingSessionMessagesForSession(sessionId)) {
          console.log(`[PluginAutoReply] Queued message detected at iteration_end, aborting run for session ${sessionId}`)
          ac.abort()
        }
        break

      case 'error':
        lastError = event.error instanceof Error ? event.error.message : String(event.error)
        console.error('[PluginAutoReply] Agent error:', event.error)
        break
    }
  }

  // ── Finalize ──
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

  // Finish CardKit card
  if (streamingActive) {
    try {
      await ipcClient.invoke('plugin:stream:finish', {
        pluginId,
        chatId,
        content: fullText.trim() ? fullText : fallbackMessage,
      })
      console.log(`[PluginAutoReply] CardKit finished for ${pluginId}:${chatId}`)
    } catch (err) {
      console.warn('[PluginAutoReply] Failed to finish streaming card:', err)
    }
  }

  if (!streamingActive && !fullText.trim()) {
    await sendPluginNotice(fallbackMessage)
  }

  // Non-streaming fallback: send the final text via plugin sendMessage
  if (!streamingActive && fullText.trim()) {
    try {
      await ipcClient.invoke('plugin:exec', {
        pluginId,
        action: 'sendMessage',
        params: { chatId, content: fullText },
      })
      console.log(`[PluginAutoReply] Sent non-streaming reply for ${pluginId}:${chatId}`)
    } catch (err) {
      console.error('[PluginAutoReply] Failed to send non-streaming reply:', err)
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

function getProviderConfig(providerId?: string | null, modelOverride?: string | null): ProviderConfig | null {
  const s = useSettingsStore.getState()
  const store = useProviderStore.getState()

  // If a specific provider+model is bound, use that provider directly
  if (providerId && modelOverride) {
    const overrideConfig = store.getProviderConfigById(providerId, modelOverride)
    if (overrideConfig?.apiKey) {
      return {
        ...overrideConfig,
        maxTokens: store.getEffectiveMaxTokens(s.maxTokens, modelOverride),
        temperature: s.temperature,
      }
    }
  }

  const activeConfig = store.getActiveProviderConfig()
  if (activeConfig?.apiKey) {
    return {
      ...activeConfig,
      model: modelOverride || activeConfig.model,
      maxTokens: store.getEffectiveMaxTokens(s.maxTokens, modelOverride || activeConfig.model),
      temperature: s.temperature,
    }
  }

  return null
}

function resolveModelSupportsVision(providerId: string | null, modelId: string): boolean {
  const store = useProviderStore.getState()
  const provider = store.providers.find((p) => p.id === providerId)
  if (!provider) return false
  const model = provider.models.find((m) => m.id === modelId)
  return model?.supportsVision ?? false
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
    type: provider.type as 'openai-chat' | 'openai-responses',
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
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    throw new Error(`Transcription API error: ${response.status} ${errorText}`)
  }

  const result = await response.json() as { text?: string }
  return result.text ?? ''
}

function hasQueuedPluginTasks(_sessionId: string): boolean {
  // Check if there are any queued plugin auto-reply tasks for this session
  // This is a simplified check - in a real implementation, you'd track queued tasks
  return false
}

async function handlePluginAutoReply(task: PluginAutoReplyTask): Promise<void> {
  try {
    await _runPluginAgent(task)
  } catch (err) {
    console.error('[PluginAutoReply] Error handling plugin auto-reply:', err)
  }
}
