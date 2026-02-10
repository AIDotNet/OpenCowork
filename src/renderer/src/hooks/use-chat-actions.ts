import { useCallback, useRef } from 'react'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { runAgentLoop } from '@renderer/lib/agent/agent-loop'
import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { buildSystemPrompt } from '@renderer/lib/agent/system-prompt'
import { subAgentEvents } from '@renderer/lib/agent/sub-agents/events'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { createProvider } from '@renderer/lib/api/provider'
import type { UnifiedMessage, ProviderConfig } from '@renderer/lib/api/types'
import type { AgentLoopConfig } from '@renderer/lib/agent/types'

export function useChatActions() {
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(async (text: string) => {
    const chatStore = useChatStore.getState()
    const settings = useSettingsStore.getState()
    const agentStore = useAgentStore.getState()
    const uiStore = useUIStore.getState()

    // Check API key before proceeding
    if (!settings.apiKey) {
      toast.error('API key required', {
        description: 'Please set your API key in Settings (Ctrl+,)',
        action: { label: 'Open Settings', onClick: () => uiStore.setSettingsOpen(true) },
      })
      return
    }

    // Ensure we have an active session
    let sessionId = chatStore.activeSessionId
    if (!sessionId) {
      sessionId = chatStore.createSession(uiStore.mode)
    }

    // Add user message
    const userMsg: UnifiedMessage = {
      id: nanoid(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    }
    chatStore.addMessage(sessionId, userMsg)

    // Auto-title: use first user message as session title
    const session = chatStore.sessions.find((s) => s.id === sessionId)
    if (session && session.title === 'New Conversation') {
      const title = text.length > 40 ? text.slice(0, 40) + '...' : text
      chatStore.updateSessionTitle(sessionId, title)
    }

    // Create assistant placeholder message
    const assistantMsgId = nanoid()
    const assistantMsg: UnifiedMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
    }
    chatStore.addMessage(sessionId, assistantMsg)
    chatStore.setStreamingMessageId(assistantMsgId)

    // Setup abort controller
    const abortController = new AbortController()
    abortRef.current = abortController

    const providerConfig: ProviderConfig = {
      type: settings.provider,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl || undefined,
      model: settings.model,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      systemPrompt: settings.systemPrompt || undefined,
    }

    const mode = uiStore.mode

    if (mode === 'chat') {
      // Simple chat mode: single API call, no tools
      const chatSystemPrompt = [
        'You are OpenCowork, a helpful AI assistant. Be concise, accurate, and friendly.',
        'Use markdown formatting in your responses. Use code blocks with language identifiers for code.',
        settings.systemPrompt ? `\n## Additional Instructions\n${settings.systemPrompt}` : '',
      ].filter(Boolean).join('\n')
      const chatConfig: ProviderConfig = { ...providerConfig, systemPrompt: chatSystemPrompt }
      await runSimpleChat(sessionId, assistantMsgId, chatConfig, abortController.signal)
    } else {
      // Cowork / Code mode: agent loop with tools
      const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
      const agentSystemPrompt = buildSystemPrompt({
        mode: mode as 'cowork' | 'code',
        workingFolder: session?.workingFolder,
        userSystemPrompt: settings.systemPrompt || undefined,
      })
      const agentProviderConfig: ProviderConfig = {
        ...providerConfig,
        systemPrompt: agentSystemPrompt,
      }
      const loopConfig: AgentLoopConfig = {
        maxIterations: 20,
        provider: agentProviderConfig,
        tools: toolRegistry.getDefinitions(),
        systemPrompt: agentSystemPrompt,
        workingFolder: session?.workingFolder,
        signal: abortController.signal,
      }

      agentStore.setRunning(true)
      agentStore.clearToolCalls()

      // Subscribe to SubAgent events during agent loop
      const unsubSubAgent = subAgentEvents.on((event) => {
        useAgentStore.getState().handleSubAgentEvent(event)
      })

      // Request notification permission on first agent run
      if (Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {})
      }

      try {
        const messages = useChatStore.getState().getSessionMessages(sessionId)
        const loop = runAgentLoop(
          messages.slice(0, -1), // Exclude the empty assistant placeholder
          loopConfig,
          { workingFolder: session?.workingFolder, signal: abortController.signal, ipc: ipcClient },
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

        for await (const event of loop) {
          if (abortController.signal.aborted) break

          switch (event.type) {
            case 'text_delta':
              useChatStore.getState().appendTextDelta(sessionId!, assistantMsgId, event.text)
              break

            case 'tool_call_start':
              useAgentStore.getState().addToolCall(event.toolCall)
              break

            case 'tool_call_approval_needed':
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

            case 'message_end':
              if (event.usage) {
                useChatStore.getState().updateMessage(sessionId!, assistantMsgId, { usage: event.usage })
              }
              break

            case 'error':
              console.error('[Agent Loop Error]', event.error)
              toast.error('Agent Error', { description: event.error.message })
              break
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error('[Agent Loop Exception]', err)
          toast.error('Agent failed', { description: errMsg })
          useChatStore.getState().appendTextDelta(sessionId!, assistantMsgId, `\n\n> **Error:** ${errMsg}`)
        }
      } finally {
        unsubSubAgent()
        agentStore.setRunning(false)
        chatStore.setStreamingMessageId(null)
        abortRef.current = null
        // Notify when agent finishes and window is not focused
        if (!document.hasFocus() && Notification.permission === 'granted') {
          new Notification('OpenCowork', { body: 'Agent finished working', silent: true })
        }
      }
    }
  }, [])

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    useChatStore.getState().setStreamingMessageId(null)
    useAgentStore.getState().abort()
  }, [])

  const retryLastMessage = useCallback(async () => {
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.activeSessionId
    if (!sessionId) return
    const lastUserText = chatStore.removeLastAssistantMessage(sessionId)
    if (lastUserText) {
      // Also remove the last user message — sendMessage will re-add it
      chatStore.removeLastUserMessage(sessionId)
      await sendMessage(lastUserText)
    }
  }, [sendMessage])

  const editAndResend = useCallback(async (newContent: string) => {
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.activeSessionId
    if (!sessionId) return
    // Remove the last assistant message (response to the user message being edited)
    chatStore.removeLastAssistantMessage(sessionId)
    // Remove the last user message (the one being edited)
    chatStore.removeLastUserMessage(sessionId)
    // Re-send with edited content
    await sendMessage(newContent)
  }, [sendMessage])

  return { sendMessage, stopStreaming, retryLastMessage, editAndResend }
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

  try {
    const stream = provider.sendMessage(
      messages.slice(0, -1), // Exclude empty assistant placeholder
      [], // No tools in chat mode
      config,
      signal
    )

    for await (const event of stream) {
      if (signal.aborted) break

      switch (event.type) {
        case 'text_delta':
          useChatStore.getState().appendTextDelta(sessionId, assistantMsgId, event.text!)
          break
        case 'message_end':
          if (event.usage) {
            useChatStore.getState().updateMessage(sessionId, assistantMsgId, { usage: event.usage })
          }
          break
        case 'error':
          console.error('[Chat Error]', event.error)
          toast.error('Chat Error', { description: event.error?.message ?? 'Unknown error' })
          break
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error('[Chat Exception]', err)
      toast.error('Chat failed', { description: errMsg })
      useChatStore.getState().appendTextDelta(sessionId, assistantMsgId, `\n\n> **Error:** ${errMsg}`)
    }
  } finally {
    useChatStore.getState().setStreamingMessageId(null)
  }
}
