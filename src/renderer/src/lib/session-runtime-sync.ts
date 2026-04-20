import type { ContentBlock, ToolUseBlock, UnifiedMessage } from '@renderer/lib/api/types'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useChatStore } from '@renderer/stores/chat-store'

type ThinkingProvider = 'anthropic' | 'openai-responses' | 'google'

export type SessionRuntimeSyncEvent =
  | { kind: 'set_streaming_message'; sessionId: string; messageId: string | null }
  | { kind: 'set_generating_image'; messageId: string; generating: boolean }
  | { kind: 'add_message'; sessionId: string; message: UnifiedMessage }
  | { kind: 'update_message'; sessionId: string; messageId: string; patch: Partial<UnifiedMessage> }
  | { kind: 'append_text_delta'; sessionId: string; messageId: string; text: string }
  | { kind: 'append_thinking_delta'; sessionId: string; messageId: string; thinking: string }
  | {
      kind: 'set_thinking_encrypted'
      sessionId: string
      messageId: string
      encryptedContent: string
      provider: ThinkingProvider
    }
  | { kind: 'complete_thinking'; sessionId: string; messageId: string }
  | { kind: 'append_tool_use'; sessionId: string; messageId: string; toolUse: ToolUseBlock }
  | {
      kind: 'update_tool_use_input'
      sessionId: string
      messageId: string
      toolUseId: string
      input: Record<string, unknown>
    }
  | { kind: 'append_content_block'; sessionId: string; messageId: string; block: ContentBlock }

function sessionExists(sessionId: string): boolean {
  return useChatStore.getState().sessions.some((session) => session.id === sessionId)
}

function messageExists(sessionId: string, messageId: string): boolean {
  return useChatStore
    .getState()
    .getSessionMessages(sessionId)
    .some((message) => message.id === messageId)
}

function toolUseExists(sessionId: string, messageId: string, toolUseId: string): boolean {
  const message = useChatStore
    .getState()
    .getSessionMessages(sessionId)
    .find((item) => item.id === messageId)
  if (!message || typeof message.content === 'string') return false
  return message.content.some(
    (block) => block.type === 'tool_use' && (block as ToolUseBlock).id === toolUseId
  )
}

function applySessionRuntimeSyncEvent(event: SessionRuntimeSyncEvent): void {
  const chatStore = useChatStore.getState()

  switch (event.kind) {
    case 'set_streaming_message':
      chatStore.setStreamingMessageId(event.sessionId, event.messageId)
      return

    case 'set_generating_image':
      chatStore.setGeneratingImage(event.messageId, event.generating)
      return

    case 'add_message':
      if (!sessionExists(event.sessionId) || messageExists(event.sessionId, event.message.id)) {
        return
      }
      chatStore.addMessage(event.sessionId, event.message)
      return

    case 'update_message':
      if (!messageExists(event.sessionId, event.messageId)) return
      chatStore.updateMessage(event.sessionId, event.messageId, event.patch)
      return

    case 'append_text_delta':
      if (!messageExists(event.sessionId, event.messageId)) return
      chatStore.appendTextDelta(event.sessionId, event.messageId, event.text)
      return

    case 'append_thinking_delta':
      if (!messageExists(event.sessionId, event.messageId)) return
      chatStore.appendThinkingDelta(event.sessionId, event.messageId, event.thinking)
      return

    case 'set_thinking_encrypted':
      if (!messageExists(event.sessionId, event.messageId)) return
      chatStore.setThinkingEncryptedContent(
        event.sessionId,
        event.messageId,
        event.encryptedContent,
        event.provider
      )
      return

    case 'complete_thinking':
      if (!messageExists(event.sessionId, event.messageId)) return
      chatStore.completeThinking(event.sessionId, event.messageId)
      return

    case 'append_tool_use':
      if (!messageExists(event.sessionId, event.messageId)) return
      if (toolUseExists(event.sessionId, event.messageId, event.toolUse.id)) return
      chatStore.appendToolUse(event.sessionId, event.messageId, event.toolUse)
      return

    case 'update_tool_use_input':
      if (!toolUseExists(event.sessionId, event.messageId, event.toolUseId)) return
      chatStore.updateToolUseInput(event.sessionId, event.messageId, event.toolUseId, event.input)
      return

    case 'append_content_block':
      if (!messageExists(event.sessionId, event.messageId)) return
      chatStore.appendContentBlock(event.sessionId, event.messageId, event.block)
      return
  }
}

export function emitSessionRuntimeSync(event: SessionRuntimeSyncEvent): void {
  ipcClient.send(IPC.SESSION_RUNTIME_SYNC, event)
}

export function installSessionRuntimeSyncListener(): () => void {
  return ipcClient.on(IPC.SESSION_RUNTIME_SYNC, (data: unknown) => {
    applySessionRuntimeSyncEvent(data as SessionRuntimeSyncEvent)
  })
}
