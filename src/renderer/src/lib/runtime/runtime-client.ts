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
let reattachTimer: ReturnType<typeof setTimeout> | null = null
let reattachDelayMs = 0

const REATTACH_MIN_DELAY_MS = 250
const REATTACH_MAX_DELAY_MS = 5_000

// Re-attach with capped exponential backoff. attachRuntime used to re-invoke
// itself directly whenever a revision gap survived an attach; a persistent gap
// (or an attach failure storm) then spun attach -> gap -> attach with no delay.
// The backoff resets after a clean attach.
function scheduleReattach(): void {
  if (!installed || reattachTimer !== null) return
  const delay = reattachDelayMs
  reattachDelayMs = Math.min(
    Math.max(reattachDelayMs * 2, REATTACH_MIN_DELAY_MS),
    REATTACH_MAX_DELAY_MS
  )
  reattachTimer = setTimeout(() => {
    reattachTimer = null
    void attachRuntime()
  }, delay)
}

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
    // Direct attachRuntime() here was a no-op (attaching is still true at this
    // point); scheduling also applies the retry backoff.
    scheduleReattach()
    return
  }
  if (pending.length > 0) store.applyEnvelopes(pending)
  reattachDelayMs = 0
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
    scheduleReattach()
  } finally {
    attaching = false
    if (liveBuffer.length > 0) {
      const extra = liveBuffer
      liveBuffer = []
      const knownRevision = useRuntimeProjectionStore.getState().snapshot.projectionRevision
      if (hasGap(extra, knownRevision)) {
        scheduleReattach()
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
    if (reattachTimer !== null) {
      clearTimeout(reattachTimer)
      reattachTimer = null
    }
    reattachDelayMs = 0
  }
}
