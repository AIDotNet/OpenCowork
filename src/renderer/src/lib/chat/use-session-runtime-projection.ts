import type { AgentRuntimeProjection } from '../../../../shared/runtime-contracts/generated/contracts'
import {
  createEmptyProjection,
  filterProjectionBySession,
  sessionOverlayRefsEqual
} from '../../../../shared/runtime-projection/reducer'
import { useRuntimeProjectionStore } from '@renderer/stores/runtime-projection-store'

const EMPTY_PROJECTION = createEmptyProjection('', '')
const sessionProjectionCache = new Map<string, AgentRuntimeProjection>()

function selectCachedSessionProjection(
  snapshot: AgentRuntimeProjection,
  sessionId: string
): AgentRuntimeProjection {
  const next = filterProjectionBySession(snapshot, sessionId)
  const previous = sessionProjectionCache.get(sessionId)
  if (previous && sessionOverlayRefsEqual(previous, next)) return previous
  sessionProjectionCache.set(sessionId, next)
  return next
}

export function useSessionRuntimeProjection(
  sessionId: string | null,
  enabled: boolean
): AgentRuntimeProjection {
  return useRuntimeProjectionStore((state) =>
    enabled && sessionId
      ? selectCachedSessionProjection(state.snapshot, sessionId)
      : EMPTY_PROJECTION
  )
}
