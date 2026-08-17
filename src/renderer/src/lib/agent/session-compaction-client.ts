import {
  normalizeCompactWatermark,
  type CompactWatermark
} from '../../../../shared/compact-watermark'
import {
  DB_SESSION_COMPACTION_COMMIT_MSGPACK_CHANNEL,
  DB_SESSION_COMPACTION_GET_MSGPACK_CHANNEL
} from '../../../../shared/messagepack/binary-ipc'
import { invokeMessagePackBinary } from '../ipc/messagepack-ipc-client'

/**
 * Renderer view of the compaction cut.
 *
 * Main owns the record; the renderer only reads it when assembling a request and
 * reports the manual `/compact` result, which produces no run stream for the
 * durable consumer to observe.
 */

export type CommitSessionCompactionInput = {
  sessionId: string
  summaryMessage: {
    id: string
    role: string
    content: unknown
    createdAt: number
  }
  compactedMessageIds: string[]
  keepMessageIds: string[]
  compactedMessageCount: number
  trigger: 'auto' | 'manual'
  preTokens: number
}

/**
 * A failed read yields no cut, which resends the full history: expensive, but
 * never wrong in the direction that loses the conversation.
 */
export async function readSessionCompaction(sessionId: string): Promise<CompactWatermark | null> {
  try {
    return normalizeCompactWatermark(
      await invokeMessagePackBinary<unknown>(DB_SESSION_COMPACTION_GET_MSGPACK_CHANNEL, {
        sessionId
      })
    )
  } catch (err) {
    console.warn('[SessionCompaction] Failed to read the compaction cut:', err)
    return null
  }
}

export async function commitSessionCompaction(
  input: CommitSessionCompactionInput
): Promise<CompactWatermark | null> {
  try {
    return normalizeCompactWatermark(
      await invokeMessagePackBinary<unknown>(DB_SESSION_COMPACTION_COMMIT_MSGPACK_CHANNEL, input)
    )
  } catch (err) {
    console.error('[SessionCompaction] Failed to record the compaction cut:', err)
    return null
  }
}
