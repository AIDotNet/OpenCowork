/**
 * Durable compaction watermark — the single authority for what the model sees
 * after context compression.
 *
 * A compacted session keeps its full transcript on disk. The model must only
 * ever receive the summary plus everything written after the compaction point.
 * The watermark records that point once, when compression commits, instead of
 * letting every request re-derive it.
 *
 * The previous design rebuilt the cut on each request from where two
 * specially-typed marker messages happened to sit in the transcript. Any
 * disagreement about those positions — a stale insert index, a sort-order
 * renumber, a missing half of the pair — silently resurrected summarized turns
 * and refilled the context window. Here the summary is an ordinary user message
 * identified by id, and the cut is a recorded position.
 */

import { isUiOnlyRequestMessage, resolveActiveCompactArtifacts } from './compact-request-view'
import type { CompactRequestMessage } from './compact-request-view'

export type CompactWatermarkTrigger = 'auto' | 'manual'

export type CompactWatermark = {
  /** Bumped on every successful compaction; only ever moves forward. */
  generation: number
  /** Plain `user` message holding the summary text. */
  summaryMessageId: string
  /**
   * Last message folded into the summary. The position is resolved from this id
   * at read time so a sort-order renumber cannot move the cut; the recorded
   * `throughSortOrder` is the fallback when the row is gone.
   */
  throughMessageId: string | null
  throughSortOrder: number
  /**
   * Rows that survive the cut even though they sit inside it. Compression runs
   * mid-turn, so the assistant message that triggered it keeps streaming
   * afterwards: its pre-compression prefix is in the summary, but dropping the
   * row would also drop everything it produced after the compaction point.
   */
  keepMessageIds: string[]
  /** Messages the summarizer consumed, for UI reporting only. */
  compactedMessageCount: number
  trigger: CompactWatermarkTrigger
  /** Context tokens measured when compression was triggered, for UI reporting. */
  preTokens: number
  createdAt: number
}

export type WatermarkMessage = CompactRequestMessage & {
  /** Logical position in the session, mirrored from SQLite `sort_order`. */
  sortOrder?: number
}

/**
 * Rows without a position are always the newest ones (renderer-local messages
 * awaiting their database flush), so an unknown position sorts after the cut.
 */
function resolveSortOrder(message: WatermarkMessage): number {
  const sortOrder = message.sortOrder
  return typeof sortOrder === 'number' && Number.isFinite(sortOrder)
    ? sortOrder
    : Number.POSITIVE_INFINITY
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** Parses a watermark carried over IPC or read back from SQLite. */
export function normalizeCompactWatermark(value: unknown): CompactWatermark | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const summaryMessageId =
    typeof record.summaryMessageId === 'string' ? record.summaryMessageId.trim() : ''
  const throughSortOrder = Number(record.throughSortOrder)
  if (!summaryMessageId || !Number.isFinite(throughSortOrder)) return null

  return {
    generation: readPositiveInt(record.generation, 1),
    summaryMessageId,
    throughMessageId:
      typeof record.throughMessageId === 'string' && record.throughMessageId.length > 0
        ? record.throughMessageId
        : null,
    throughSortOrder: Math.floor(throughSortOrder),
    keepMessageIds: readStringArray(record.keepMessageIds),
    compactedMessageCount: readPositiveInt(record.compactedMessageCount, 0),
    trigger: record.trigger === 'manual' ? 'manual' : 'auto',
    preTokens: readPositiveInt(record.preTokens, 0),
    createdAt: readPositiveInt(record.createdAt, 0)
  }
}

/**
 * Reduce a full transcript to the model-visible conversation.
 *
 * The cut is only applied when the summary row is in this list. A watermark
 * without its summary — a windowed load that missed the row, or a commit that
 * has not landed yet — must not drop the compacted range: the model would
 * then see only the latest turn and lose the working memory the summary was
 * supposed to carry. Sending the uncut window is wasteful; sending the tail
 * alone is wrong.
 */
export function applyCompactWatermark<T extends WatermarkMessage>(
  messages: readonly T[],
  watermark: CompactWatermark | null
): T[] {
  const visible = messages.filter((message) => !isUiOnlyRequestMessage(message))
  if (!watermark) return visible

  const summary = visible.find((message) => message.id === watermark.summaryMessageId)
  if (!summary) {
    console.warn('[CompactWatermark] Summary message missing; leaving transcript uncut', {
      summaryMessageId: watermark.summaryMessageId
    })
    return visible
  }

  const throughSortOrder = resolveWatermarkCut(messages, watermark)
  const kept = new Set(watermark.keepMessageIds)
  const tail = visible.filter(
    (message) =>
      message.id !== watermark.summaryMessageId &&
      (resolveSortOrder(message) > throughSortOrder || kept.has(message.id))
  )
  return [summary, ...tail]
}

/**
 * Prefer the recorded boundary row's current position so the cut follows the
 * transcript through any renumbering, and never let the fallback move the cut
 * backwards past what was already compacted.
 */
function resolveWatermarkCut(
  messages: readonly WatermarkMessage[],
  watermark: CompactWatermark
): number {
  if (!watermark.throughMessageId) return watermark.throughSortOrder
  const anchor = messages.find((message) => message.id === watermark.throughMessageId)
  if (!anchor) return watermark.throughSortOrder
  const anchorSortOrder = resolveSortOrder(anchor)
  return Number.isFinite(anchorSortOrder) ? anchorSortOrder : watermark.throughSortOrder
}

/**
 * Hosted-session prefix component. Changing it forces the Worker session to
 * reopen so it picks up the new cut; because the generation only moves forward,
 * the fence changes exactly once per compaction and never flaps back.
 */
export function compactWatermarkFence(watermark: CompactWatermark | null): string {
  if (!watermark) return 'none'
  return `${watermark.generation}:${watermark.throughSortOrder}:${watermark.summaryMessageId}`
}

/**
 * Translate a pre-watermark transcript into a watermark, so sessions compacted
 * by an older build keep their cut instead of replaying the whole history once.
 *
 * The legacy request view sent `[boundary, summary, ...rows after the pair]`,
 * which is exactly a watermark anchored at the last row of that pair. A legacy
 * summary that recorded a summarizer failure never reduced anything, so it
 * yields no watermark.
 */
export function deriveCompactWatermarkFromTranscript(
  messages: readonly WatermarkMessage[]
): CompactWatermark | null {
  const active = resolveActiveCompactArtifacts(messages)
  if (!active?.summaryId) return null

  const summary = messages.find((message) => message.id === active.summaryId)
  if (!summary || summary.meta?.compactSummary?.summarizerFailed === true) return null

  const pairTail = messages[Math.max(active.summaryIndex, active.boundaryIndex)]
  if (!pairTail) return null
  const throughSortOrder = resolveSortOrder(pairTail)
  if (!Number.isFinite(throughSortOrder)) return null

  return {
    generation: 1,
    summaryMessageId: summary.id,
    throughMessageId: pairTail.id,
    throughSortOrder,
    keepMessageIds: [],
    compactedMessageCount: summary.meta?.compactSummary?.messagesSummarized ?? 0,
    trigger: 'auto',
    preTokens: 0,
    createdAt: summary.createdAt
  }
}
