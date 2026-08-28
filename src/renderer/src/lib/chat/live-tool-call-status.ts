import type { ToolCallState, ToolCallStatus } from '../agent/types'
import type { RunStatus } from '../../../../shared/runtime-contracts/generated/contracts'

const TOOL_STATUS_RANK: Record<ToolCallStatus | 'completed', number> = {
  streaming: 0,
  pending_approval: 1,
  running: 2,
  completed: 3,
  error: 3,
  canceled: 3
}

export function mergeLiveToolCallMaps(
  overlay: Map<string, ToolCallState> | null | undefined,
  store: Map<string, ToolCallState> | null | undefined
): Map<string, ToolCallState> | null {
  if (!overlay && (!store || store.size === 0)) return null
  if (!overlay) return store ?? null
  if (!store || store.size === 0) return overlay

  const merged = new Map(overlay)
  for (const [id, storeCall] of store) {
    const overlayCall = merged.get(id)
    if (!overlayCall) {
      merged.set(id, storeCall)
      continue
    }
    merged.set(id, preferAdvancedToolCall(overlayCall, storeCall))
  }
  return merged
}

function preferAdvancedToolCall(left: ToolCallState, right: ToolCallState): ToolCallState {
  const leftRank = TOOL_STATUS_RANK[left.status] ?? 0
  const rightRank = TOOL_STATUS_RANK[right.status] ?? 0
  const rightSettledResultOverridesCanceled =
    left.status === 'canceled' && (right.status === 'completed' || right.status === 'error')
  const advanced = rightSettledResultOverridesCanceled || rightRank > leftRank ? right : left
  const other = advanced === left ? right : left
  return {
    ...other,
    ...advanced,
    input: Object.keys(advanced.input ?? {}).length > 0 ? advanced.input : other.input,
    output: advanced.output ?? other.output,
    error: advanced.error ?? other.error,
    startedAt: advanced.startedAt ?? other.startedAt,
    completedAt: advanced.completedAt ?? other.completedAt
  }
}

export function resolveLiveToolCallStatus(
  isStreaming: boolean | undefined,
  liveToolCall: ToolCallState | undefined,
  result: { isError?: boolean } | undefined,
  runStatus?: RunStatus | null,
  fallbackStatus?: ToolCallStatus | 'completed'
): ToolCallStatus | 'completed' {
  // A persisted tool_result means the call already settled. Overlay/live state can
  // stay stuck on `streaming` after args finish (the projection never left that
  // status), so results must win or every card in a live run shows "receiving args".
  if (result) return result.isError ? 'error' : 'completed'

  const liveStatus = liveToolCall?.status
  if (liveStatus === 'completed') return 'completed'
  if (liveStatus === 'error') return 'error'

  // A terminal run is stronger than an active live status. A contradictory canceled
  // overlay is treated as stale once the run completed or failed; an explicit abort
  // status still wins when the run ended as canceled/interrupted.
  if (runStatus === 'cancelled' || runStatus === 'interrupted') return 'canceled'
  if (runStatus === 'error') return 'error'
  if (runStatus === 'completed') return 'completed'

  if (liveStatus === 'canceled') return 'canceled'
  if (liveStatus) return liveStatus
  return fallbackStatus ?? (isStreaming ? 'streaming' : 'completed')
}
