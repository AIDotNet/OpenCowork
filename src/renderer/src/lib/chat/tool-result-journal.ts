import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { DB_TOOL_RESULTS_LOOKUP_MSGPACK_CHANNEL } from '../../../../shared/messagepack/binary-ipc'

export interface ToolResultJournalRow {
  toolUseId: string
  toolName: string
  contentJson: string
  isError: boolean
}

export async function lookupToolResultJournal(
  sessionId: string,
  toolUseIds: string[]
): Promise<ToolResultJournalRow[]> {
  if (!sessionId || toolUseIds.length === 0) return []
  try {
    const rows = await invokeMessagePackBinary<ToolResultJournalRow[]>(
      DB_TOOL_RESULTS_LOOKUP_MSGPACK_CHANNEL,
      { sessionId, toolUseIds }
    )
    return (rows ?? []).filter((row) => row?.toolUseId && row.toolName)
  } catch (error) {
    console.warn('[ToolResultJournal] lookup failed', error)
    return []
  }
}
