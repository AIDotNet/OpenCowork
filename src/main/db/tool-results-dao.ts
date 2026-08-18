import { getNativeWorker } from '../lib/native-worker'

/**
 * Read access to the Worker's per-tool durable journal (`runtime_tool_results`). The
 * Worker writes a row the instant a tool finishes, so this is the recovery source for a
 * tool_use whose tool_result never reached the `messages` table (renderer crash, app
 * kill, worker recycle mid-turn). `contentJson` is the raw provider-facing tool_result
 * content, stored unreshaped.
 */
export interface ToolResultJournalRow {
  sessionId: string
  toolUseId: string
  runId: string
  toolName: string
  status: string
  contentJson: string
  isError: boolean
  startedAt?: number | null
  completedAt: number
}

export function lookupToolResults(args: {
  sessionId: string
  toolUseIds: string[]
}): Promise<ToolResultJournalRow[]> {
  if (args.toolUseIds.length === 0) return Promise.resolve([])
  return getNativeWorker().request<ToolResultJournalRow[]>(
    'agent/tool-results-lookup',
    args,
    30_000
  )
}
