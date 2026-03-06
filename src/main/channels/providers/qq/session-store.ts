import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface SessionState {
  sessionId: string | null
  lastSeq: number | null
  lastConnectedAt: number
  intentLevelIndex: number
  accountId: string
  savedAt: number
}

const SESSION_DIR = path.join(os.homedir(), '.open-cowork', 'qq-bot', 'sessions')
const SESSION_EXPIRE_TIME = 5 * 60 * 1000
const SAVE_THROTTLE_MS = 1000

const throttleState = new Map<
  string,
  {
    pendingState: SessionState | null
    lastSaveTime: number
    throttleTimer: ReturnType<typeof setTimeout> | null
  }
>()

function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }
}

function getSessionPath(accountId: string): string {
  const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(SESSION_DIR, `session-${safeId}.json`)
}

export function loadSession(accountId: string): SessionState | null {
  const filePath = getSessionPath(accountId)

  try {
    if (!fs.existsSync(filePath)) {
      return null
    }

    const data = fs.readFileSync(filePath, 'utf-8')
    const state = JSON.parse(data) as SessionState
    const now = Date.now()

    if (now - state.savedAt > SESSION_EXPIRE_TIME) {
      try {
        fs.unlinkSync(filePath)
      } catch {
        // ignore
      }
      return null
    }

    if (!state.sessionId || state.lastSeq == null) {
      return null
    }

    return state
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
    doSaveSession(state)
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
        doSaveSession(current.pendingState)
        current.lastSaveTime = Date.now()
        current.pendingState = null
      }
      if (current) {
        current.throttleTimer = null
      }
    }, delay)
  }
}

function doSaveSession(state: SessionState): void {
  const filePath = getSessionPath(state.accountId)

  try {
    ensureDir()
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          ...state,
          savedAt: Date.now()
        },
        null,
        2
      ),
      'utf-8'
    )
  } catch (error) {
    console.error(`[qq-bot:session] Failed to save session for ${state.accountId}:`, error)
  }
}

export function clearSession(accountId: string): void {
  const filePath = getSessionPath(accountId)
  const throttle = throttleState.get(accountId)

  if (throttle?.throttleTimer) {
    clearTimeout(throttle.throttleTimer)
  }
  throttleState.delete(accountId)

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (error) {
    console.error(`[qq-bot:session] Failed to clear session for ${accountId}:`, error)
  }
}
