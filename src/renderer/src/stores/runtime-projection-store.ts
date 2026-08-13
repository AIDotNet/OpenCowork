import { create } from 'zustand'
import type {
  AgentRuntimeProjection,
  RuntimeErrorCode,
  RuntimeEventEnvelope
} from '../../../shared/runtime-contracts/generated/contracts'
import {
  applyRuntimeEnvelope,
  createEmptyProjection,
  filterProjectionBySession
} from '../../../shared/runtime-projection/reducer'

type RuntimeProjectionStore = {
  snapshot: AgentRuntimeProjection
  expired: boolean
  errorCode: RuntimeErrorCode | null
  replaceSnapshot: (snapshot: AgentRuntimeProjection) => void
  applyEnvelopes: (envelopes: RuntimeEventEnvelope[]) => void
  markExpired: (errorCode: RuntimeErrorCode | null) => void
}

export const useRuntimeProjectionStore = create<RuntimeProjectionStore>((set, get) => ({
  snapshot: createEmptyProjection('', ''),
  expired: false,
  errorCode: null,
  replaceSnapshot: (snapshot) => set({ snapshot, expired: false, errorCode: null }),
  applyEnvelopes: (envelopes) => {
    const ordered = [...envelopes].sort(
      (left, right) => left.projectionRevision - right.projectionRevision
    )
    let snapshot = get().snapshot
    for (const envelope of ordered) {
      if (envelope.projectionRevision <= snapshot.projectionRevision) continue
      snapshot = applyRuntimeEnvelope(snapshot, envelope)
    }
    set({ snapshot, expired: false, errorCode: null })
  },
  markExpired: (errorCode) =>
    set({
      expired: true,
      errorCode,
      snapshot: createEmptyProjection('', '')
    })
}))

export function selectSessionRuntimeOverlay(
  snapshot: AgentRuntimeProjection,
  sessionId: string
): AgentRuntimeProjection {
  return filterProjectionBySession(snapshot, sessionId)
}
