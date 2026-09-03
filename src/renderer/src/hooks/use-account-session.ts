import { useCallback, useEffect, useRef, useState } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  ACCOUNT_OAUTH_TIMEOUT_MS,
  type AccountOAuthChangedEvent,
  type AccountOAuthErrorCode,
  type AccountOAuthSession,
  type AccountOAuthStartResult
} from '../../../shared/account-oauth'

// Local guard slightly longer than main's own timeout: if the changed event is
// ever lost, the sign-in button must still recover instead of staying disabled.
const SIGN_IN_GUARD_MS = ACCOUNT_OAUTH_TIMEOUT_MS + 10_000

export interface AccountSessionState {
  session: AccountOAuthSession | null
  isLoading: boolean
  isSigningIn: boolean
  error: AccountOAuthErrorCode | null
}

/**
 * Read-only view of the desktop account owned by the main process. Tokens never
 * reach the renderer; login/logout are simple commands over IPC.
 */
export function useAccountSession(): AccountSessionState & {
  login: () => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  cancelLogin: () => Promise<void>
} {
  const [session, setSession] = useState<AccountOAuthSession | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [error, setError] = useState<AccountOAuthErrorCode | null>(null)
  const guardRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearGuard = useCallback(() => {
    if (guardRef.current === null) return
    clearTimeout(guardRef.current)
    guardRef.current = null
  }, [])

  useEffect(() => {
    let disposed = false

    void (async () => {
      try {
        const current = (await ipcClient.invoke(
          IPC.ACCOUNT_OAUTH_GET
        )) as AccountOAuthSession | null
        if (!disposed) setSession(current)
      } catch {
        if (!disposed) setSession(null)
      } finally {
        if (!disposed) setIsLoading(false)
      }
    })()

    const unsubscribe = ipcClient.on(IPC.ACCOUNT_OAUTH_CHANGED, (payload) => {
      const event = payload as AccountOAuthChangedEvent | undefined
      if (!event) return
      clearGuard()
      setSession(event.session)
      setError(event.error ?? null)
      setIsSigningIn(false)
    })

    return () => {
      disposed = true
      clearGuard()
      unsubscribe()
    }
  }, [clearGuard])

  const login = useCallback(async () => {
    setError(null)
    setIsSigningIn(true)
    clearGuard()
    guardRef.current = setTimeout(() => {
      guardRef.current = null
      setIsSigningIn(false)
      setError('timeout')
    }, SIGN_IN_GUARD_MS)

    try {
      const result = (await ipcClient.invoke(IPC.ACCOUNT_OAUTH_START)) as AccountOAuthStartResult
      if (!result?.started) {
        clearGuard()
        setError(result?.error ?? 'unknown')
        setIsSigningIn(false)
      }
    } catch {
      clearGuard()
      setError('unknown')
      setIsSigningIn(false)
    }
  }, [clearGuard])

  const cancelLogin = useCallback(async () => {
    clearGuard()
    setIsSigningIn(false)
    setError(null)
    try {
      await ipcClient.invoke(IPC.ACCOUNT_OAUTH_CANCEL)
    } catch {
      // Cancelling is best-effort; the pending flow also expires on its own.
    }
  }, [clearGuard])

  const logout = useCallback(async () => {
    try {
      await ipcClient.invoke(IPC.ACCOUNT_OAUTH_LOGOUT)
    } finally {
      // The main process broadcasts the cleared session, but keep the UI honest
      // even if the event is lost.
      clearGuard()
      setSession(null)
      setIsSigningIn(false)
    }
  }, [clearGuard])

  const refresh = useCallback(async () => {
    try {
      const next = (await ipcClient.invoke(IPC.ACCOUNT_OAUTH_REFRESH, {
        force: true
      })) as AccountOAuthSession | null
      setSession(next)
    } catch {
      setError('network_error')
    }
  }, [])

  return { session, isLoading, isSigningIn, error, login, logout, refresh, cancelLogin }
}
