import type { ContentBlock, ThinkingBlock, WebSearchBlock } from '@renderer/lib/api/types'
import { coalesceStreamAppend } from '../../../shared/stream-delta-coalesce'

type ThinkingEncryptedProvider = NonNullable<ThinkingBlock['encryptedContentProvider']>

/**
 * Attach a provider thinking signature to the block it belongs to.
 *
 * A new signature must not overwrite an earlier signed thinking block: interleaved
 * Anthropic turns emit one signature per thinking block, and stealing the previous
 * signature (or appending a phantom empty think after text) is what the Messages
 * API rejects on the next user turn.
 */
export function attachThinkingEncryptedToBlocks(
  blocks: ContentBlock[],
  encryptedContent: string,
  provider: ThinkingEncryptedProvider,
  startedAt = Date.now()
): void {
  if (!encryptedContent) return

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.type !== 'thinking') continue
    if (!block.encryptedContent) {
      block.encryptedContent = encryptedContent
      block.encryptedContentProvider = provider
      return
    }
    break
  }

  const last = blocks[blocks.length - 1]
  if (last?.type === 'thinking') {
    last.encryptedContent = encryptedContent
    last.encryptedContentProvider = provider
    if (!last.thinking) {
      last.redacted = true
    }
    return
  }

  const next: ThinkingBlock = {
    type: 'thinking',
    thinking: '',
    encryptedContent,
    encryptedContentProvider: provider,
    redacted: true,
    startedAt
  }
  if (!blocks.some((block) => block.type === 'thinking')) {
    blocks.unshift(next)
    return
  }
  blocks.push(next)
}

/**
 * Attach an OpenAI-Responses reasoning item id to the block it belongs to.
 *
 * Same ownership rule as {@link attachThinkingEncryptedToBlocks}: a newer id must not
 * overwrite a block that already has one, because a turn can hold several reasoning
 * items and each replays under its own id. Unlike a signature this is not secret — it is
 * how endpoints that never return `reasoning.encrypted_content` identify reasoning on a
 * later request, so it has to survive into the persisted block.
 */
export function attachThinkingReasoningIdToBlocks(
  blocks: ContentBlock[],
  reasoningItemId: string
): void {
  if (!reasoningItemId) return

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.type !== 'thinking') continue
    if (!block.reasoningItemId) block.reasoningItemId = reasoningItemId
    return
  }

  // Reasoning with no summary at all still needs its handle kept, the same way a
  // signature-only block does.
  blocks.unshift({ type: 'thinking', thinking: '', reasoningItemId, redacted: true })
}

export function sealIncompleteThinkingBlocks(blocks: ContentBlock[], completedAt: number): void {
  for (const block of blocks) {
    if (block.type === 'thinking' && block.completedAt == null) {
      block.completedAt = completedAt
    }
  }
}

/**
 * Continue the current thinking block only when it is still the last content
 * block. After tools/text, start a new thinking block so later reasoning does
 * not keep rewriting the first think card.
 */
export function appendThinkingDeltaToBlocks(
  blocks: ContentBlock[],
  thinking: string,
  startedAt: number
): void {
  if (!thinking) return

  const last = blocks[blocks.length - 1]
  if (last?.type === 'thinking' && last.completedAt == null) {
    last.thinking = coalesceStreamAppend(last.thinking, thinking)
    if (last.redacted && last.thinking) {
      last.redacted = undefined
    }
    return
  }

  sealIncompleteThinkingBlocks(blocks, startedAt)
  blocks.push({ type: 'thinking', thinking, startedAt })
}

/**
 * Place reasoning the provider only revealed after it had already streamed its answer.
 *
 * OpenAI-Responses gateways that never send `reasoning_summary_text.delta` hand the
 * whole summary over in the final `response.completed` payload, so it arrives once the
 * answer text is already on screen. The reasoning still belongs to the answer it
 * produced, so it goes in front of the trailing text run — plain appending would draw
 * the "Thought" card underneath the reply it explains, and would also leave a thinking
 * block last, which suppresses the completed-turn process collapse.
 */
export function insertBackfilledThinkingIntoBlocks(
  blocks: ContentBlock[],
  thinking: string,
  startedAt = Date.now()
): void {
  if (!thinking) return

  let insertAt = blocks.length
  while (insertAt > 0 && blocks[insertAt - 1].type === 'text') insertAt -= 1

  // No trailing text to step over: this is ordinary stream placement after all.
  if (insertAt === blocks.length) {
    appendThinkingDeltaToBlocks(blocks, thinking, startedAt)
    return
  }

  const previous = blocks[insertAt - 1]
  if (previous?.type === 'thinking') {
    const separator = previous.thinking.endsWith('\n') || thinking.startsWith('\n') ? '' : '\n'
    previous.thinking = previous.thinking ? `${previous.thinking}${separator}${thinking}` : thinking
    previous.completedAt ??= startedAt
    if (previous.redacted) previous.redacted = undefined
    return
  }

  blocks.splice(insertAt, 0, {
    type: 'thinking',
    thinking,
    startedAt,
    completedAt: startedAt
  })
}

/**
 * Append `block`, or — for a provider-native web_search block carrying an id — replace
 * the existing block with the same id in place.
 *
 * A server-side web search streams a live "searching" block when it starts and a
 * resolved "completed" block (query + sources) when it finishes; both share the same
 * id. Upserting keeps a single component that updates in place rather than stacking a
 * duplicate. Any other block type is always appended.
 */
export function appendOrUpsertContentBlock(blocks: ContentBlock[], block: ContentBlock): void {
  if (block.type === 'web_search' && block.id) {
    const idx = blocks.findIndex(
      (b) => b.type === 'web_search' && (b as WebSearchBlock).id === block.id
    )
    if (idx !== -1) {
      blocks[idx] = block
      return
    }
  }
  blocks.push(block)
}
