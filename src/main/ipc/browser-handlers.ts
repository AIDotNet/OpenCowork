import {
  getBrowserEmulationStatus,
  getBuiltInBrowserStorageSessions
} from '../browser/browser-emulation'
import { registerMessagePackHandler } from './messagepack-handler'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerBrowserHandlers(): void {
  registerMessagePackHandler<undefined>('browser:clear-cookies', async () => {
    try {
      await Promise.all(
        getBuiltInBrowserStorageSessions().map((browserSession) =>
          browserSession.clearStorageData({ storages: ['cookies'] })
        )
      )
      return { success: true }
    } catch (error) {
      console.error('[Browser] Failed to clear cookies:', error)
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerMessagePackHandler<undefined>('browser:emulation-status', async () => {
    try {
      return { success: true, status: getBrowserEmulationStatus() }
    } catch (error) {
      console.error('[Browser] Failed to read browser emulation status:', error)
      return { success: false, error: getErrorMessage(error) }
    }
  })
}
