import type { OauthClientPlatformInfo } from '../../../../shared/oauth-client-identity'
import { ipcClient } from '../ipc/ipc-client'

let cached: OauthClientPlatformInfo | undefined

function readNavigatorPlatform(): OauthClientPlatformInfo {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const platformName = typeof navigator === 'undefined' ? '' : navigator.platform
  const platform = /mac/i.test(ua) || /mac/i.test(platformName)
    ? 'darwin'
    : /win/i.test(ua) || /win/i.test(platformName)
      ? 'win32'
      : 'linux'
  const arch = /arm|aarch64/i.test(ua) ? 'arm64' : 'x64'
  return { platform, arch }
}

export function getOauthClientPlatform(): OauthClientPlatformInfo {
  return cached ?? readNavigatorPlatform()
}

export function prefetchOauthClientPlatform(): void {
  void ipcClient
    .invoke('app:system-info')
    .then((result) => {
      if (!result || typeof result !== 'object') return
      const info = result as OauthClientPlatformInfo
      cached = {
        platform: typeof info.platform === 'string' ? info.platform : undefined,
        arch: typeof info.arch === 'string' ? info.arch : undefined,
        release: typeof info.release === 'string' ? info.release : undefined
      }
    })
    .catch(() => {
      // Keep the navigator fallback.
    })
}

prefetchOauthClientPlatform()
