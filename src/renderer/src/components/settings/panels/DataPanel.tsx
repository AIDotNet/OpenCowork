import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { HardDriveDownload, HardDriveUpload, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { useChatStore } from '@renderer/stores/chat-store'
import {
  DEFAULT_API_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  DEFAULT_SHELL_EXECUTION_ENDPOINT,
  DEFAULT_THEME_MODE,
  useSettingsStore
} from '@renderer/stores/settings-store'
import {
  DEFAULT_APP_THEME_PRESET,
  DEFAULT_SSH_TERMINAL_THEME_PRESET
} from '@renderer/lib/theme-presets'
import { exportSessionSnapshotFromDb } from '@renderer/lib/utils/export-chat'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import packageJson from '../../../../../../package.json'
import {
  OPEN_COWORK_RELEASES_LATEST_URL,
  type AppDistribution
} from '../../../../../shared/app-distribution'
import { MigrationPanel } from '../MigrationPanel'
import { SettingHint, SettingRow, SettingsPanel, SettingsSection } from '../settings-primitives'

function normalizeDistribution(value: unknown): AppDistribution {
  return value === 'green' ? 'green' : 'installer'
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

export function DataPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const { setTheme } = useTheme()
  const sessions = useChatStore((s) => s.sessions)
  const clearAllSessions = useChatStore((s) => s.clearAllSessions)

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

  const handleBackupSessions = useCallback(async () => {
    if (sessions.length === 0) {
      toast.info(t('general.data.noSessions'))
      return
    }
    const latestSessions = await Promise.all(sessions.map(exportSessionSnapshotFromDb))
    const json = JSON.stringify(latestSessions, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `opencowork-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(t('general.data.backupSuccess', { count: latestSessions.length }))
  }, [sessions, t])

  const handleImportSessions = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        const list = Array.isArray(data) ? data : [data]
        const store = useChatStore.getState()
        let imported = 0
        for (const session of list) {
          if (session && session.id && Array.isArray(session.messages)) {
            const exists = store.sessions.some((s) => s.id === session.id)
            if (exists) continue
            store.restoreSession(session)
            imported++
          }
        }
        if (imported > 0) {
          toast.success(t('general.data.importSuccess', { count: imported }))
        } else {
          toast.info(t('general.data.importNone'))
        }
      } catch (err) {
        toast.error(
          t('general.data.importFailed', {
            error: err instanceof Error ? err.message : String(err)
          })
        )
      }
    }
    input.click()
  }, [t])

  const handleClearAllSessions = useCallback(async () => {
    const total = useChatStore.getState().sessions.length
    if (total === 0) {
      toast.info(t('general.data.noSessions'))
      return
    }
    const ok = await confirm({
      title: t('general.data.clearConfirm', { count: total }),
      variant: 'destructive'
    })
    if (!ok) return
    clearAllSessions()
    toast.success(t('general.data.cleared', { count: total }))
  }, [clearAllSessions, t])

  const handleResetDefaults = useCallback(async () => {
    const ok = await confirm({ title: t('general.resetConfirm'), variant: 'destructive' })
    if (!ok) return
    const currentKey = settings.apiKey
    settings.updateSettings({
      provider: 'anthropic',
      baseUrl: '',
      model: 'claude-sonnet-4-20250514',
      fastModel: 'claude-3-5-haiku-20241022',
      maxTokens: 32000,
      temperature: 0.7,
      theme: DEFAULT_THEME_MODE,
      themePreset: DEFAULT_APP_THEME_PRESET,
      sshTerminalThemePreset: DEFAULT_SSH_TERMINAL_THEME_PRESET,
      shellExecutionEndpoint: DEFAULT_SHELL_EXECUTION_ENDPOINT,
      customShellExecutable: '',
      shellEnvironmentVariablesText: '',
      backgroundColor: '',
      fontFamily: '',
      fontSize: 16,
      animationsEnabled: true,
      liveOutputAnimationStyle: 'agile',
      toolbarCollapsedByDefault: false,
      maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
      maxConcurrentSubAgents: DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
      apiRequestTimeoutSeconds: DEFAULT_API_REQUEST_TIMEOUT_SECONDS,
      autoUpdateEnabled: true,
      apiKey: currentKey
    })
    setTheme(DEFAULT_THEME_MODE)
    toast.success(t('general.resetDone'))
  }, [setTheme, settings, t])

  return (
    <SettingsPanel title={t('data.title')} description={t('data.subtitle')}>
      <SettingsSection
        id="updates"
        title={t('general.update.status')}
        description={`${t('general.update.currentVersion', { version: currentVersion })}${
          latestVersion ? ` · ${t('general.update.latestVersion', { version: latestVersion })}` : ''
        }${distribution === 'green' ? ` · ${t('general.update.greenBuild')}` : ''}`}
      >
        <SettingRow
          label={t('general.autoUpdate')}
          description={
            supportsAutoInstall ? t('general.autoUpdateDesc') : t('general.autoUpdateGreenDesc')
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
                    settings.animationsEnabled
                      ? { ease: 'easeOut', duration: 0.3 }
                      : { duration: 0 }
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

      <SettingsSection
        id="sessions"
        title={t('general.data.title')}
        description={t('general.data.subtitle')}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-background/70 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <HardDriveDownload className="size-4 text-primary" />
              {t('general.data.backupTitle')}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('general.data.backupDesc')}</p>
            <Button
              className="mt-3 h-8 text-xs"
              size="sm"
              variant="outline"
              disabled={sessions.length === 0}
              onClick={handleBackupSessions}
            >
              {t('general.data.backupAction')}
            </Button>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/70 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <HardDriveUpload className="size-4 text-primary" />
              {t('general.data.importTitle')}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('general.data.importDesc')}</p>
            <Button className="mt-3 h-8 text-xs" size="sm" onClick={handleImportSessions}>
              {t('general.data.importAction')}
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="migration" title={t('migration.title')} description={t('migration.subtitle')}>
        <MigrationPanel embedded />
      </SettingsSection>

      <SettingsSection
        id="reset"
        tone="danger"
        title={t('data.dangerZone')}
        description={t('data.dangerZoneDesc')}
      >
        <SettingRow
          label={t('general.data.clearTitle')}
          description={t('general.data.clearDesc')}
          control={
            <Button
              className="h-8 text-xs"
              size="sm"
              variant="destructive"
              onClick={() => void handleClearAllSessions()}
              disabled={sessions.length === 0}
            >
              <Trash2 className="mr-1 size-3.5" />
              {t('general.data.clearAction')}
            </Button>
          }
        />
        <SettingRow
          label={t('general.resetDefault')}
          description={t('general.resetConfirm')}
          control={
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handleResetDefaults()}
            >
              {t('general.resetDefault')}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPanel>
  )
}
