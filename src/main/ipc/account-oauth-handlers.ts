import { registerMessagePackHandler } from './messagepack-handler'
import {
  cancelAccountOAuth,
  getAccountSession,
  logoutAccountOAuth,
  refreshAccountOAuth,
  startAccountOAuth
} from '../account/oauth-service'
import type {
  AccountOAuthLogoutResult,
  AccountOAuthSession,
  AccountOAuthStartResult
} from '../../shared/account-oauth'

export function registerAccountOAuthHandlers(): void {
  registerMessagePackHandler<void, AccountOAuthSession | null>('account-oauth:get', async () => {
    return getAccountSession()
  })

  registerMessagePackHandler<void, AccountOAuthStartResult>('account-oauth:start', async () => {
    return await startAccountOAuth()
  })

  registerMessagePackHandler<void, { success: true }>('account-oauth:cancel', async () => {
    cancelAccountOAuth()
    return { success: true }
  })

  registerMessagePackHandler<{ force?: boolean } | undefined, AccountOAuthSession | null>(
    'account-oauth:refresh',
    async (args) => {
      return await refreshAccountOAuth(args?.force === true)
    }
  )

  registerMessagePackHandler<void, AccountOAuthLogoutResult>('account-oauth:logout', async () => {
    await logoutAccountOAuth()
    return { success: true }
  })
}
