import type {
  ContentBlock,
  ThinkingBlock,
  ToolUseBlock,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { summarizeToolInputForHistory } from '@renderer/lib/tools/tool-input-sanitizer'
import { useUIStore } from '@renderer/stores/ui-store'
import { useBackgroundSessionStore } from '@renderer/stores/background-session-store'

/**
 * Strip any <think>...</think> markers streamed by providers that wrap thinking in pseudo-tags.
 * Mirrors the chat-store helper so buffered writes share the same sanitization.
 */
function stripThinkTagMarkers(text: string): string {
  return text.replace(/<\s*\/?\s*think\s*>/gi, '')
}

// --- Visible session cache (50 ms TTL) ---
// getVisibleSessionIds() is called per-event during streaming — caching avoids
// re-creating a Set and reading two stores on every invocation.
let _cachedVisibleIds: Set<string> | null = null
let _cachedVisibleIdsTs = 0
const VISIBLE_IDS_CACHE_TTL_MS = 50

/**
 * Invalidate the visible-session cache. Call this whenever `activeSessionId` or
 * the mini-session-window state changes so the next `isSessionForeground` call
 * picks up the new value immediately.
 */
export function invalidateVisibleSessionCache(): void {
  _cachedVisibleIds = null
}

// --- Debounced markSessionUpdate ---
// During streaming, mutateBufferedMessage fires every ~33 ms.  Updating
// unreadCountsBySession that often forces SessionListPanel to re-render at
// ~30 fps for a purely informational badge.  Debouncing at 500 ms reduces
// background-store set() calls to ~2/s while keeping the badge responsive
// enough for the user to notice activity.
const _pendingSessionUpdates = new Map<string, ReturnType<typeof setTimeout>>()
const MARK_SESSION_UPDATE_DEBOUNCE_MS = 500

function debouncedMarkSessionUpdate(sessionId: string): void {
  if (_pendingSessionUpdates.has(sessionId)) return
  _pendingSessionUpdates.set(
    sessionId,
    setTimeout(() => {
      _pendingSessionUpdates.delete(sessionId)
      useBackgroundSessionStore.getState().markSessionUpdate(sessionId)
    }, MARK_SESSION_UPDATE_DEBOUNCE_MS)
  )
}

function cancelDebouncedMarkSessionUpdate(sessionId: string): void {
  const timer = _pendingSessionUpdates.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    _pendingSessionUpdates.delete(sessionId)
  }
}

/**
 * Seed resolver used by background mutations. Looks up the current chat-store snapshot so
 * the background buffer can clone an authoritative source message the first time a delta
 * references an id it hasn't buffered yet.
 */
function resolveChatStoreSeed(sessionId: string, messageId: string): UnifiedMessage | undefined {
  return useChatStore
    .getState()
    .getSessionMessages(sessionId)
    .find((message) => message.id === messageId)
}

/**
 * Apply a mutator to a buffered background message. Guarantees the mutation is never
 * silently dropped: if the message isn't already in the buffer and can't be found in
 * chat-store either, an empty placeholder is created so the delta has somewhere to land.
 * The buffered snapshot will eventually be merged into chat-store by
 * flushBackgroundSessionToForeground — see applyBackgroundSnapshot for the merge semantics.
 */
function mutateBufferedMessage(
  sessionId: string,
  messageId: string,
  mutator: (message: UnifiedMessage) => void
): void {
  const bg = useBackgroundSessionStore.getState()
  bg.queueBufferedMutation(
    sessionId,
    messageId,
    () => resolveChatStoreSeed(sessionId, messageId),
    mutator
  )
  debouncedMarkSessionUpdate(sessionId)
}

export function getVisibleSessionIds(): Set<string> {
  const now = Date.now()
  if (_cachedVisibleIds && now - _cachedVisibleIdsTs < VISIBLE_IDS_CACHE_TTL_MS) {
    return _cachedVisibleIds
  }

  const visibleSessionIds = new Set<string>()
  const { activeSessionId } = useChatStore.getState()
  const uiState = useUIStore.getState()

  if (activeSessionId) visibleSessionIds.add(activeSessionId)
  if (uiState.miniSessionWindowOpen && uiState.miniSessionWindowSessionId) {
    visibleSessionIds.add(uiState.miniSessionWindowSessionId)
  }

  _cachedVisibleIds = visibleSessionIds
  _cachedVisibleIdsTs = now
  return visibleSessionIds
}

export function isSessionForeground(sessionId: string): boolean {
  return getVisibleSessionIds().has(sessionId)
}

export function updateRuntimeMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<UnifiedMessage>
): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().updateMessage(sessionId, messageId, patch)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    Object.assign(message, patch)
  })
}

export function appendRuntimeTextDelta(sessionId: string, messageId: string, text: string): void {
  if (!text) return
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().appendTextDelta(sessionId, messageId, text)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') {
      message.content += text
      return
    }

    const blocks = message.content as ContentBlock[]
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock?.type === 'text') {
      lastBlock.text += text
    } else {
      let targetTextBlock: ContentBlock | null = null
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === 'text') {
          targetTextBlock = blocks[i]
          break
        }
        if (blocks[i].type !== 'tool_use') break
      }
      if (targetTextBlock && targetTextBlock.type === 'text') {
        targetTextBlock.text += text
      } else {
        blocks.push({ type: 'text', text })
      }
    }
  })
}

export function appendRuntimeThinkingDelta(
  sessionId: string,
  messageId: string,
  thinking: string
): void {
  const cleanedThinking = stripThinkTagMarkers(thinking)
  if (!cleanedThinking) return
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().appendThinkingDelta(sessionId, messageId, cleanedThinking)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    const now = Date.now()
    if (typeof message.content === 'string') {
      message.content = [{ type: 'thinking', thinking: cleanedThinking, startedAt: now }]
      return
    }

    const blocks = message.content as ContentBlock[]
    let targetThinkingBlock: ThinkingBlock | null = null
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block.type === 'thinking' && !block.completedAt) {
        targetThinkingBlock = block
        break
      }
    }

    if (targetThinkingBlock) {
      targetThinkingBlock.thinking = stripThinkTagMarkers(
        `${targetThinkingBlock.thinking}${cleanedThinking}`
      )
    } else {
      blocks.push({ type: 'thinking', thinking: cleanedThinking, startedAt: now })
    }
  })
}

export function setRuntimeThinkingEncryptedContent(
  sessionId: string,
  messageId: string,
  encryptedContent: string,
  provider: 'anthropic' | 'openai-responses' | 'google'
): void {
  if (!encryptedContent) return
  if (isSessionForeground(sessionId)) {
    useChatStore
      .getState()
      .setThinkingEncryptedContent(sessionId, messageId, encryptedContent, provider)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    const now = Date.now()
    if (typeof message.content === 'string') {
      const existingText = message.content
      message.content = [
        {
          type: 'thinking',
          thinking: '',
          encryptedContent,
          encryptedContentProvider: provider,
          startedAt: now
        },
        ...(existingText ? [{ type: 'text' as const, text: existingText }] : [])
      ]
      return
    }

    const blocks = message.content as ContentBlock[]
    let targetThinkingBlock: ThinkingBlock | null = null
    let providerMatchedThinkingBlock: ThinkingBlock | null = null

    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block.type !== 'thinking') continue
      if (!block.encryptedContent) {
        targetThinkingBlock = block
        break
      }
      if (!providerMatchedThinkingBlock && block.encryptedContentProvider === provider) {
        providerMatchedThinkingBlock = block
      }
    }

    targetThinkingBlock = targetThinkingBlock ?? providerMatchedThinkingBlock
    if (targetThinkingBlock) {
      targetThinkingBlock.encryptedContent = encryptedContent
      targetThinkingBlock.encryptedContentProvider = provider
      return
    }

    blocks.push({
      type: 'thinking',
      thinking: '',
      encryptedContent,
      encryptedContentProvider: provider,
      startedAt: now
    })
  })
}

export function completeRuntimeThinking(sessionId: string, messageId: string): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().completeThinking(sessionId, messageId)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') return
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'thinking' && !block.completedAt) {
        block.completedAt = Date.now()
      }
    }
  })
}

export function appendRuntimeToolUse(
  sessionId: string,
  messageId: string,
  toolUse: ToolUseBlock
): void {
  const normalizedToolUse: ToolUseBlock = {
    ...toolUse,
    input: summarizeToolInputForHistory(toolUse.name, toolUse.input)
  }
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().appendToolUse(sessionId, messageId, normalizedToolUse)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') {
      message.content = [{ type: 'text', text: message.content }, { ...normalizedToolUse }]
      return
    }

    ;(message.content as ContentBlock[]).push({ ...normalizedToolUse })
  })
}

export function updateRuntimeToolUseInput(
  sessionId: string,
  messageId: string,
  toolUseId: string,
  input: Record<string, unknown>
): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().updateToolUseInput(sessionId, messageId, toolUseId, input)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') return
    const block = (message.content as ContentBlock[]).find(
      (item) => item.type === 'tool_use' && (item as ToolUseBlock).id === toolUseId
    ) as ToolUseBlock | undefined
    if (block) {
      block.input = summarizeToolInputForHistory(block.name, input)
    }
  })
}

export function appendRuntimeContentBlock(
  sessionId: string,
  messageId: string,
  block: ContentBlock
): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().appendContentBlock(sessionId, messageId, block)
    return
  }

  mutateBufferedMessage(sessionId, messageId, (message) => {
    if (typeof message.content === 'string') {
      message.content = [{ type: 'text', text: message.content }, { ...block } as ContentBlock]
      return
    }

    ;(message.content as ContentBlock[]).push({ ...block } as ContentBlock)
  })
}

export function addRuntimeMessage(sessionId: string, message: UnifiedMessage): void {
  if (isSessionForeground(sessionId)) {
    useChatStore.getState().addMessage(sessionId, message)
    return
  }

  const bg = useBackgroundSessionStore.getState()
  bg.seedBufferedMessage(sessionId, message, 'added')
  debouncedMarkSessionUpdate(sessionId)
}

/**
 * Atomically drain the buffered state for `sessionId` and merge it into chat-store.
 *
 * The earlier implementation awaited loadRecentSessionMessages and then called
 * updateMessage for each patched id — which silently failed whenever the id wasn't in
 * the loaded window, leaking messages. The new implementation:
 *
 *   1. Takes a snapshot + clears the buffer atomically (takeSessionSnapshot). Deltas
 *      arriving during the await go straight to chat-store because isSessionForeground
 *      is now true for this session.
 *   2. Loads recent messages (so existing patched ids can be found if they're resident).
 *   3. Hands the whole snapshot to chat-store.applyBackgroundSnapshot which merges
 *      everything in a single Immer produce — inserting missing patched ids as new
 *      messages instead of silently dropping them.
 */
export async function flushBackgroundSessionToForeground(sessionId: string): Promise<void> {
  if (!sessionId) return
  cancelDebouncedMarkSessionUpdate(sessionId)
  useBackgroundSessionStore.getState().flushPendingMutationsNow()
  const snapshot = useBackgroundSessionStore.getState().takeSessionSnapshot(sessionId)
  if (!snapshot) return

  try {
    await useChatStore.getState().loadRecentSessionMessages(sessionId, true)
    useChatStore.getState().applyBackgroundSnapshot(sessionId, {
      patchedMessagesById: snapshot.patchedMessagesById,
      addedMessagesById: snapshot.addedMessagesById,
      addedMessageIds: snapshot.addedMessageIds
    })
  } catch (err) {
    console.error('[SessionRuntimeRouter] Failed to flush background snapshot', err)
    // Restore the snapshot so the data isn't lost on subsequent attempts. seedBufferedMessage
    // is idempotent, so re-seeding is safe.
    const bg = useBackgroundSessionStore.getState()
    for (const [, message] of Object.entries(snapshot.patchedMessagesById)) {
      bg.seedBufferedMessage(sessionId, message, 'patched')
    }
    for (const id of snapshot.addedMessageIds) {
      const message = snapshot.addedMessagesById[id]
      if (message) bg.seedBufferedMessage(sessionId, message, 'added')
    }
  }
}
