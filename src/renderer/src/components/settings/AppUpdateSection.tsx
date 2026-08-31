import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import packageJson from '../../../../../package.json'
import {
  OPEN_COWORK_RELEASES_LATEST_URL,
  type AppDistribution
} from '../../../../shared/app-distribution'
import { SettingHint, SettingRow, SettingsSection } from './settings-primitives'

function normalizeDistribution(value: unknown): AppDistribution {
  if (value === 'green' || value === 'compat') {
    return value
  }
  return 'installer'
}

function normalizeReleaseUrl(value: unknown): string {
  return typeof value === 'string' && value.startsWith('https://')
    ? value
    : OPEN_COWORK_RELEASES_LATEST_URL
}

function normalizeVersion(version: string | null | undefined): string {
  return (version ?? '').trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split('-')[0].split('.')
  const rightParts = normalizeVersion(right).split('-')[0].split('.')
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.parseInt(leftParts[index] ?? '0', 10)
    const rightValue = Number.parseInt(rightParts[index] ?? '0', 10)
    const safeLeftValue = Number.isFinite(leftValue) ? leftValue : 0
    const safeRightValue = Number.isFinite(rightValue) ? rightValue : 0

    if (safeLeftValue !== safeRightValue) {
      return safeLeftValue > safeRightValue ? 1 : -1
    }
  }

  return 0
}

function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined
): boolean {
  const normalizedCandidate = normalizeVersion(candidate)
  const normalizedCurrent = normalizeVersion(current)

  if (!normalizedCandidate || !normalizedCurrent) {
    return false
  }

  return compareVersions(normalizedCandidate, normalizedCurrent) > 0
}

export function AppUpdateSection(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()

  const currentVersion = normalizeVersion(packageJson.version ?? '0.0.0')
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [distribution, setDistribution] = useState<AppDistribution>('installer')
  const [supportsAutoInstall, setSupportsAutoInstall] = useState(true)
  const [releaseUrl, setReleaseUrl] = useState(OPEN_COWORK_RELEASES_LATEST_URL)

  const checkForUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    setUpdateError(null)
    setDownloadedVersion(null)
    try {
      const result = (await ipcClient.invoke(IPC.UPDATE_CHECK)) as
        | {
            success: true
            available: boolean
            currentVersion: string
            latestVersion: string | null
            distribution?: unknown
            supportsAutoInstall?: unknown
            releaseUrl?: unknown
          }
        | { success: false; error: string }

      if (!result.success) {
        setUpdateError(result.error)
        setLatestVersion(null)
        return
      }

      setLatestVersion(normalizeVersion(result.latestVersion))
      setDistribution(normalizeDistribution(result.distribution))
      setSupportsAutoInstall(result.supportsAutoInstall !== false)
      setReleaseUrl(normalizeReleaseUrl(result.releaseUrl))
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  useEffect(() => {
    if (!settings.autoUpdateEnabled) {
      return
    }

    void checkForUpdates()
  }, [checkForUpdates, settings.autoUpdateEnabled])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const result = (await ipcClient.invoke(IPC.UPDATE_STATUS)) as
        | {
            success: true
            downloadedVersion: string | null
            distribution?: unknown
            supportsAutoInstall?: unknown
            releaseUrl?: unknown
          }
        | { success: false; error: string }

      if (cancelled || !result.success) {
        return
      }

      const nextSupportsAutoInstall = result.supportsAutoInstall !== false
      setDistribution(normalizeDistribution(result.distribution))
      setSupportsAutoInstall(nextSupportsAutoInstall)
      setReleaseUrl(normalizeReleaseUrl(result.releaseUrl))

      if (!nextSupportsAutoInstall || !result.downloadedVersion) {
        return
      }

      const version = normalizeVersion(result.downloadedVersion) || result.downloadedVersion
      setDownloadedVersion(version)
      setLatestVersion(version)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const offAvailable = ipcClient.on(IPC.UPDATE_AVAILABLE, (data: unknown) => {
      const d = data as {
        currentVersion: string
        newVersion: string
        releaseNotes: string
        distribution?: unknown
        supportsAutoInstall?: unknown
        releaseUrl?: unknown
      }
      setLatestVersion(normalizeVersion(d.newVersion))
      setDistribution(normalizeDistribution(d.distribution))
      setSupportsAutoInstall(d.supportsAutoInstall !== false)
      setReleaseUrl(normalizeReleaseUrl(d.releaseUrl))
      setUpdateError(null)
    })

    const offProgress = ipcClient.on(IPC.UPDATE_DOWNLOAD_PROGRESS, (data: unknown) => {
      const d = data as { percent: number }
      setDownloadingUpdate(true)
      setDownloadProgress(typeof d.percent === 'number' ? d.percent : null)
    })

    const offDownloaded = ipcClient.on(IPC.UPDATE_DOWNLOADED, (data: unknown) => {
      const d = data as { version: string }
      setDownloadingUpdate(false)
      setDownloadProgress(null)
      setDownloadedVersion(d.version)
      setInstallingUpdate(false)
    })

    const offError = ipcClient.on(IPC.UPDATE_ERROR, (data: unknown) => {
      const d = data as { error: string }
      setDownloadingUpdate(false)
      setDownloadProgress(null)
      setInstallingUpdate(false)
      setUpdateError(d.error)
    })

    return () => {
      offAvailable()
      offProgress()
      offDownloaded()
      offError()
    }
  }, [])

  const updateAvailable = isNewerVersion(latestVersion, currentVersion)
  const manualUpdateAvailable = updateAvailable && !supportsAutoInstall

  const handleUpdateNow = useCallback(async () => {
    setUpdateError(null)

    if (!supportsAutoInstall) {
      await ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, releaseUrl)
      return
    }

    setDownloadingUpdate(true)
    setDownloadProgress(null)
    setDownloadedVersion(null)

    const result = (await ipcClient.invoke(IPC.UPDATE_DOWNLOAD)) as
      | { success: true }
      | { success: false; error: string }

    if (!result.success) {
      setDownloadingUpdate(false)
      setUpdateError(result.error)
    }
  }, [releaseUrl, supportsAutoInstall])

  const handleInstallDownloadedUpdate = useCallback(async () => {
    if (!downloadedVersion || installingUpdate) {
      return
    }

    setUpdateError(null)
    setInstallingUpdate(true)
    const result = (await ipcClient.invoke(IPC.UPDATE_INSTALL)) as
      | { success: true }
      | { success: false; error: string }

    if (!result.success) {
      setInstallingUpdate(false)
      setUpdateError(result.error)
    }
  }, [downloadedVersion, installingUpdate])

  return (
    <SettingsSection
      id="updates"
      title={t('general.update.status')}
      description={`${t('general.update.currentVersion', { version: currentVersion })}${
        latestVersion ? ` · ${t('general.update.latestVersion', { version: latestVersion })}` : ''
      }${
        distribution === 'green'
          ? ` · ${t('general.update.greenBuild')}`
          : distribution === 'compat'
            ? ` · ${t('general.update.compatBuild', { defaultValue: 'Compatibility build' })}`
            : ''
      }`}
    >
      <SettingRow
        label={t('general.autoUpdate')}
        description={
          supportsAutoInstall
            ? t('general.autoUpdateDesc')
            : distribution === 'compat'
              ? t('general.autoUpdateCompatDesc', {
                  defaultValue:
                    'The compatibility build (older CPUs without SSE4.2) does not use the official auto-update channel. Download the matching *-win-x64-compat installer from the GitHub Release.'
                })
              : t('general.autoUpdateGreenDesc')
        }
        control={
          <Switch
            checked={settings.autoUpdateEnabled}
            onCheckedChange={(checked) => settings.updateSettings({ autoUpdateEnabled: checked })}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => void checkForUpdates()}
          disabled={checkingUpdate}
        >
          {checkingUpdate && <Loader2 className="mr-1 size-3 animate-spin" />}
          {checkingUpdate ? t('general.update.checking') : t('general.update.checkForUpdates')}
        </Button>
        {downloadedVersion ? (
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => void handleInstallDownloadedUpdate()}
            disabled={installingUpdate}
          >
            {installingUpdate && <Loader2 className="mr-1 size-3 animate-spin" />}
            {installingUpdate ? t('general.update.installing') : t('general.update.updateNow')}
          </Button>
        ) : updateAvailable ? (
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => void handleUpdateNow()}
            disabled={supportsAutoInstall && downloadingUpdate}
          >
            {supportsAutoInstall && downloadingUpdate && (
              <Loader2 className="mr-1 size-3 animate-spin" />
            )}
            {supportsAutoInstall
              ? downloadingUpdate
                ? t('general.update.updating')
                : t('general.update.updateNow')
              : t('general.update.openDownloadPage')}
          </Button>
        ) : null}
      </div>

      {updateError && (
        <SettingHint tone="danger">
          {t('general.update.failedToCheck', { error: updateError })}
        </SettingHint>
      )}
      {!updateError && !updateAvailable && latestVersion && !checkingUpdate && (
        <SettingHint tone="success">{t('general.update.upToDate')}</SettingHint>
      )}
      {updateAvailable && !downloadingUpdate && !downloadedVersion && (
        <SettingHint tone="warning">
          {manualUpdateAvailable
            ? t('general.update.manualDownloadHint', { version: latestVersion })
            : t('general.update.newVersionAvailable', { version: latestVersion })}
        </SettingHint>
      )}
      {downloadingUpdate && (
        <div className="space-y-1.5 rounded-md bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-500">
            {typeof downloadProgress === 'number'
              ? t('general.update.downloadingWithProgress', {
                  progress: Math.round(downloadProgress)
                })
              : t('general.update.downloading')}
          </p>
          {typeof downloadProgress === 'number' && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-primary/15">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={false}
                animate={{ width: `${Math.min(100, Math.max(0, downloadProgress))}%` }}
                transition={
                  settings.animationsEnabled ? { ease: 'easeOut', duration: 0.3 } : { duration: 0 }
                }
              />
            </div>
          )}
        </div>
      )}
      {downloadedVersion && (
        <SettingHint tone="success">
          {t('general.update.downloadedReady', { version: downloadedVersion })}
        </SettingHint>
      )}
    </SettingsSection>
  )
}
