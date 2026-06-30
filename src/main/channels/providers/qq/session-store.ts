import { getNativeWorker } from '../../../lib/native-worker'

export interface SessionState {
  sessionId: string | null
  lastSeq: number | null
  lastConnectedAt: number
  intentLevelIndex: number
  accountId: string
  savedAt: number
}

const SAVE_THROTTLE_MS = 1000
const QQ_SESSION_TIMEOUT_MS = 30_000

const throttleState = new Map<
  string,
  {
    pendingState: SessionState | null
    lastSaveTime: number
    throttleTimer: ReturnType<typeof setTimeout> | null
  }
>()

type MutationResult = {
  success: boolean
  error?: string | null
}

async function nativeQqSessionRequest<T>(method: string, params: unknown): Promise<T> {
  return await getNativeWorker().request<T>(method, params, QQ_SESSION_TIMEOUT_MS)
}

export async function loadSession(accountId: string): Promise<SessionState | null> {
  try {
    return await nativeQqSessionRequest<SessionState | null>('channel/qq-session-load', {
      accountId
    })
  } catch (error) {
    console.error(`[qq-bot:session] Failed to load session for ${accountId}:`, error)
    return null
  }
}

export function saveSession(state: SessionState): void {
  const { accountId } = state
  let throttle = throttleState.get(accountId)

  if (!throttle) {
    throttle = {
      pendingState: null,
      lastSaveTime: 0,
      throttleTimer: null
    }
    throttleState.set(accountId, throttle)
  }

  const now = Date.now()
  const timeSinceLastSave = now - throttle.lastSaveTime

  if (timeSinceLastSave >= SAVE_THROTTLE_MS) {
    void doSaveSession(state)
    throttle.lastSaveTime = now
    throttle.pendingState = null

    if (throttle.throttleTimer) {
      clearTimeout(throttle.throttleTimer)
      throttle.throttleTimer = null
    }

    return
  }

  throttle.pendingState = state

  if (!throttle.throttleTimer) {
    const delay = SAVE_THROTTLE_MS - timeSinceLastSave
    throttle.throttleTimer = setTimeout(() => {
      const current = throttleState.get(accountId)
      if (current?.pendingState) {
        void doSaveSession(current.pendingState)
        current.lastSaveTime = Date.now()
        current.pendingState = null
      }
      if (current) {
        current.throttleTimer = null
      }
    }, delay)
  }
}

async function doSaveSession(state: SessionState): Promise<void> {
  try {
    const result = await nativeQqSessionRequest<MutationResult>('channel/qq-session-save', state)
    if (!result.success) {
      throw new Error(result.error || 'Native QQ session save failed')
    }
  } catch (error) {
    console.error(`[qq-bot:session] Failed to save session for ${state.accountId}:`, error)
  }
}

export function clearSession(accountId: string): void {
  const throttle = throttleState.get(accountId)

  if (throttle?.throttleTimer) {
    clearTimeout(throttle.throttleTimer)
  }
  throttleState.delete(accountId)

  void nativeQqSessionRequest<MutationResult>('channel/qq-session-clear', { accountId }).catch(
    (error) => {
      console.error(`[qq-bot:session] Failed to clear session for ${accountId}:`, error)
    }
  )
}
