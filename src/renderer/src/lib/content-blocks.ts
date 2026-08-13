import type { ContentBlock, WebSearchBlock } from '@renderer/lib/api/types'

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
    last.thinking += thinking
    return
  }

  sealIncompleteThinkingBlocks(blocks, startedAt)
  blocks.push({ type: 'thinking', thinking, startedAt })
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
