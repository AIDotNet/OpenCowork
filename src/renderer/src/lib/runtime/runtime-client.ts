import type {
  AttachRuntimeResult,
  RuntimeEventEnvelope
} from '../../../../shared/runtime-contracts/generated/contracts'
import { useRuntimeProjectionStore } from '../../stores/runtime-projection-store'

const subscriberIdValue = crypto.randomUUID()

let installed = false
let unsubscribePatches: (() => void) | null = null
let attaching = false
let liveBuffer: RuntimeEventEnvelope[] = []
let pendingPatches: RuntimeEventEnvelope[] = []
let rafId: number | null = null
let visibilityListener: (() => void) | null = null

function runtimeApi(): typeof window.api.runtime {
  return window.api.runtime
}

function subscriberId(): string {
  return subscriberIdValue
}

function sortEnvelopes(envelopes: RuntimeEventEnvelope[]): RuntimeEventEnvelope[] {
  return [...envelopes].sort((left, right) => left.projectionRevision - right.projectionRevision)
}

function hasGap(envelopes: RuntimeEventEnvelope[], knownRevision: number): boolean {
  let expected = knownRevision + 1
  for (const envelope of sortEnvelopes(envelopes)) {
    if (envelope.projectionRevision < expected) continue
    if (envelope.projectionRevision > expected) return true
    expected = envelope.projectionRevision + 1
  }
  return false
}

function drainPending(): RuntimeEventEnvelope[] {
  if (rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  const drained = pendingPatches
  pendingPatches = []
  return drained
}

function applyAttachResult(result: AttachRuntimeResult, buffered: RuntimeEventEnvelope[]): void {
  const store = useRuntimeProjectionStore.getState()
  if (result.mode === 'expired') {
    store.markExpired(result.errorCode)
    return
  }
  if (result.mode === 'snapshot' && result.snapshot) {
    store.replaceSnapshot(result.snapshot)
  } else if (result.patches.length > 0) {
    store.applyEnvelopes(result.patches)
  }

  const knownRevision = useRuntimeProjectionStore.getState().snapshot.projectionRevision
  const pending = sortEnvelopes(buffered).filter(
    (envelope) =>
      envelope.gatewayEpoch === result.gatewayEpoch && envelope.projectionRevision > knownRevision
  )
  if (hasGap(pending, knownRevision)) {
    void attachRuntime()
    return
  }
  if (pending.length > 0) store.applyEnvelopes(pending)
}

async function attachRuntime(): Promise<void> {
  if (attaching) return
  attaching = true
  const buffered = [...liveBuffer, ...drainPending()]
  liveBuffer = []
  try {
    const snapshot = useRuntimeProjectionStore.getState().snapshot
    const result = await runtimeApi().attach({
      subscriberId: subscriberId(),
      knownGatewayEpoch: snapshot.gatewayEpoch || null,
      knownProjectionRevision: snapshot.projectionRevision || null,
      sessionId: null
    })
    applyAttachResult(result, buffered)
  } catch (error) {
    console.warn(
      '[runtime-client] attach failed',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    attaching = false
    if (liveBuffer.length > 0) {
      const extra = liveBuffer
      liveBuffer = []
      const knownRevision = useRuntimeProjectionStore.getState().snapshot.projectionRevision
      if (hasGap(extra, knownRevision)) {
        void attachRuntime()
      } else {
        useRuntimeProjectionStore.getState().applyEnvelopes(extra)
      }
    }
  }
}

function applyPendingPatches(): void {
  const envelopes = drainPending()
  if (envelopes.length === 0) return
  const knownRevision = useRuntimeProjectionStore.getState().snapshot.projectionRevision
  if (hasGap(envelopes, knownRevision)) {
    liveBuffer.push(...envelopes)
    void attachRuntime()
    return
  }
  useRuntimeProjectionStore.getState().applyEnvelopes(envelopes)
}

function schedulePatchFlush(): void {
  if (typeof document !== 'undefined' && document.hidden) return
  if (rafId !== null) return
  if (typeof requestAnimationFrame !== 'function') {
    applyPendingPatches()
    return
  }
  rafId = requestAnimationFrame(applyPendingPatches)
}

function onPatches(envelopes: RuntimeEventEnvelope[]): void {
  if (attaching || !installed) {
    liveBuffer.push(...envelopes)
    return
  }
  pendingPatches.push(...envelopes)
  const knownRevision = useRuntimeProjectionStore.getState().snapshot.projectionRevision
  if (hasGap(pendingPatches, knownRevision)) {
    liveBuffer.push(...drainPending())
    void attachRuntime()
    return
  }
  schedulePatchFlush()
}

export function flushRuntimeProjectionPatches(): void {
  if (!installed || attaching) return
  applyPendingPatches()
}

export async function installRuntimeClient(): Promise<() => void> {
  if (installed) {
    return () => undefined
  }
  installed = true
  unsubscribePatches = runtimeApi().subscribePatches(onPatches)
  if (typeof document !== 'undefined') {
    const onVisibility = (): void => {
      if (!document.hidden) flushRuntimeProjectionPatches()
    }
    document.addEventListener('visibilitychange', onVisibility)
    visibilityListener = () => document.removeEventListener('visibilitychange', onVisibility)
  }

  try {
    await runtimeApi().initialize({ subscriberId: subscriberId() })
    await attachRuntime()
  } catch (error) {
    console.warn(
      '[runtime-client] initialize failed',
      error instanceof Error ? error.message : String(error)
    )
  }

  return () => {
    installed = false
    unsubscribePatches?.()
    unsubscribePatches = null
    visibilityListener?.()
    visibilityListener = null
    liveBuffer = []
    drainPending()
  }
}
