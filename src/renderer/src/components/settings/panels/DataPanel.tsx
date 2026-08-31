import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { HardDriveDownload, HardDriveUpload, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import { Button } from '@renderer/components/ui/button'
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
import { MigrationPanel } from '../MigrationPanel'
import { SettingRow, SettingsPanel, SettingsSection } from '../settings-primitives'

export function DataPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const { setTheme } = useTheme()
  const sessions = useChatStore((s) => s.sessions)
  const clearAllSessions = useChatStore((s) => s.clearAllSessions)

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

      <SettingsSection
        id="migration"
        title={t('migration.title')}
        description={t('migration.subtitle')}
      >
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
