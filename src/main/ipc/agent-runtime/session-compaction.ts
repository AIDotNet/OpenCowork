import {
  deriveCompactWatermarkFromTranscript,
  normalizeCompactWatermark,
  type CompactWatermark,
  type WatermarkMessage
} from '../../../shared/compact-watermark'
import { commitSessionCompaction, getSessionCompactionRow } from '../../db/messages-dao'

/**
 * Main-side access to the compaction cut.
 *
 * Main is the only writer: every execution path (interactive, cron, channel
 * auto-reply) streams its Worker events through the durable event consumer, so
 * recording the cut here means no run can compress its context without the cut
 * being persisted. The record is read fresh on every request rather than cached
 * — it is a primary-key lookup, and a stale cut is precisely the failure this
 * whole mechanism exists to prevent.
 */

export type RecordSessionCompactionInput = {
  sessionId: string
  summaryMessage: {
    id: string
    role?: string
    content: unknown
    meta?: unknown
    createdAt?: number
  }
  compactedMessageIds: string[]
  /**
   * Rows that must survive the cut. The assistant message that was streaming
   * when compression ran keeps producing output afterwards, so dropping it would
   * lose the post-compaction half of that turn.
   */
  keepMessageIds: string[]
  compactedMessageCount: number
  trigger: 'auto' | 'manual'
  preTokens: number
}

function serializeSummaryContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '')
}

function serializeSummaryMeta(meta: unknown): string | null {
  if (meta == null) return null
  if (typeof meta === 'string') return meta
  try {
    const serialized = JSON.stringify(meta)
    return typeof serialized === 'string' ? serialized : null
  } catch {
    return null
  }
}

/**
 * Resolve the cut for a request. Sessions compacted before this mechanism
 * existed have no record; their transcript still carries the old marker rows, so
 * the equivalent cut is derived from those instead of replaying the whole
 * history once. The derivation is deterministic and the compacted prefix never
 * changes, so it does not need to be written back.
 */
export async function resolveSessionCompaction(
  sessionId: string,
  transcript: readonly WatermarkMessage[]
): Promise<CompactWatermark | null> {
  const recorded = await readSessionCompaction(sessionId)
  if (recorded) return recorded
  const derived = deriveCompactWatermarkFromTranscript(transcript)
  if (derived) {
    console.log('[SessionCompaction] Derived cut from legacy compaction artifacts', {
      sessionId,
      summaryMessageId: derived.summaryMessageId,
      throughSortOrder: derived.throughSortOrder
    })
  }
  return derived
}

export async function readSessionCompaction(sessionId: string): Promise<CompactWatermark | null> {
  try {
    const result = await getSessionCompactionRow(sessionId)
    if (!result.success) {
      console.warn('[SessionCompaction] Read failed', { sessionId, error: result.error })
      return null
    }
    return normalizeCompactWatermark(result.compaction)
  } catch (error) {
    console.warn(
      '[SessionCompaction] Read threw',
      sessionId,
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

/**
 * Persist the summary and its cut. A failure here must leave the session
 * uncompacted from the host's point of view: the next request then resends the
 * full history, which is wasteful but correct, whereas a cut without a stored
 * summary would silently erase the conversation's memory.
 */
export async function recordSessionCompaction(
  input: RecordSessionCompactionInput
): Promise<CompactWatermark | null> {
  const summaryId = input.summaryMessage.id?.trim()
  if (!summaryId) {
    console.warn('[SessionCompaction] Compression reported no summary message id', {
      sessionId: input.sessionId
    })
    return null
  }

  try {
    const result = await commitSessionCompaction({
      sessionId: input.sessionId,
      summaryMessage: {
        id: summaryId,
        role: input.summaryMessage.role || 'user',
        content: serializeSummaryContent(input.summaryMessage.content),
        meta: serializeSummaryMeta(input.summaryMessage.meta),
        createdAt: input.summaryMessage.createdAt || Date.now()
      },
      compactedMessageIds: input.compactedMessageIds,
      keepMessageIds: input.keepMessageIds,
      compactedMessageCount: input.compactedMessageCount,
      trigger: input.trigger,
      preTokens: input.preTokens,
      createdAt: Date.now()
    })
    const watermark = normalizeCompactWatermark(result.compaction)
    console.log('[SessionCompaction] Recorded cut', {
      sessionId: input.sessionId,
      generation: watermark?.generation ?? 0,
      summaryMessageId: summaryId,
      throughSortOrder: watermark?.throughSortOrder ?? -1,
      keepMessageIds: input.keepMessageIds.length,
      summarySortOrder: result.summarySortOrder,
      total: result.total
    })
    return watermark
  } catch (error) {
    console.error(
      '[SessionCompaction] Commit failed; session stays uncompacted',
      input.sessionId,
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}
