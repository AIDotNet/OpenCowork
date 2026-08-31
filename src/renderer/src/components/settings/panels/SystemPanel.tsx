import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  resolveShellExecutable,
  useSettingsStore,
  type ShellExecutionEndpoint
} from '@renderer/stores/settings-store'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { AppUpdateSection } from '../AppUpdateSection'
import { SettingHint, SettingRow, SettingsPanel, SettingsSection } from '../settings-primitives'

interface ShellEndpointOption {
  value: ShellExecutionEndpoint
  labelKey: string
  descKey: string
}

const SHELL_ENVIRONMENT_VARIABLE_LINE_RE = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=.*$/

function getInvalidShellEnvironmentVariablesLine(text: string): number | null {
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (!line || line.startsWith('#')) continue
    if (!SHELL_ENVIRONMENT_VARIABLE_LINE_RE.test(line)) {
      return index + 1
    }
  }

  return null
}

function getShellEndpointOptions(platform: string): ShellEndpointOption[] {
  const normalizedPlatform = platform.toLowerCase()
  const base: ShellEndpointOption[] = [
    {
      value: 'auto',
      labelKey: 'system.shell.endpoint.options.auto.label',
      descKey: 'system.shell.endpoint.options.auto.desc'
    }
  ]

  if (normalizedPlatform === 'win32') {
    return [
      ...base,
      {
        value: 'powershell',
        labelKey: 'system.shell.endpoint.options.powershell.label',
        descKey: 'system.shell.endpoint.options.powershell.desc'
      },
      {
        value: 'pwsh',
        labelKey: 'system.shell.endpoint.options.pwsh.label',
        descKey: 'system.shell.endpoint.options.pwsh.desc'
      },
      {
        value: 'cmd',
        labelKey: 'system.shell.endpoint.options.cmd.label',
        descKey: 'system.shell.endpoint.options.cmd.desc'
      },
      {
        value: 'custom',
        labelKey: 'system.shell.endpoint.options.custom.label',
        descKey: 'system.shell.endpoint.options.custom.desc'
      }
    ]
  }

  return [
    ...base,
    {
      value: 'zsh',
      labelKey: 'system.shell.endpoint.options.zsh.label',
      descKey: 'system.shell.endpoint.options.zsh.desc'
    },
    {
      value: 'bash',
      labelKey: 'system.shell.endpoint.options.bash.label',
      descKey: 'system.shell.endpoint.options.bash.desc'
    },
    {
      value: 'sh',
      labelKey: 'system.shell.endpoint.options.sh.label',
      descKey: 'system.shell.endpoint.options.sh.desc'
    },
    {
      value: 'custom',
      labelKey: 'system.shell.endpoint.options.custom.label',
      descKey: 'system.shell.endpoint.options.custom.desc'
    }
  ]
}

export function SystemPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const platform = window.electron.process.platform
  const [shellEnvironmentVariablesDraft, setShellEnvironmentVariablesDraft] = useState(
    settings.shellEnvironmentVariablesText
  )
  const invalidShellEnvironmentVariablesLine = useMemo(
    () => getInvalidShellEnvironmentVariablesLine(shellEnvironmentVariablesDraft),
    [shellEnvironmentVariablesDraft]
  )
  const handleShellEnvironmentVariablesChange = useCallback(
    (value: string) => {
      setShellEnvironmentVariablesDraft(value)
      if (getInvalidShellEnvironmentVariablesLine(value) === null) {
        settings.updateSettings({ shellEnvironmentVariablesText: value })
      }
    },
    [settings]
  )

  useEffect(() => {
    if (useSettingsStore.persist.hasHydrated()) return

    return useSettingsStore.persist.onFinishHydration(() => {
      setShellEnvironmentVariablesDraft(useSettingsStore.getState().shellEnvironmentVariablesText)
    })
  }, [])

  const shellOptions = getShellEndpointOptions(platform)
  const activeShellOption =
    shellOptions.find((option) => option.value === settings.shellExecutionEndpoint) ??
    shellOptions[0]
  const selectedShellEndpoint = activeShellOption.value
  const resolvedShell = resolveShellExecutable({
    endpoint: selectedShellEndpoint,
    customShellExecutable: settings.customShellExecutable,
    platform
  })

  const effectiveProjectDirectory =
    settings.projectDefaultDirectoryMode === 'custom' && settings.projectDefaultDirectory.trim()
      ? settings.projectDefaultDirectory.trim()
      : settings.lastProjectDirectory.trim()

  const handlePickProjectDefaultDirectory = useCallback(async () => {
    const result = (await ipcClient.invoke(IPC.FS_SELECT_FOLDER, {
      defaultPath: effectiveProjectDirectory || undefined
    })) as { canceled?: boolean; path?: string }
    if (result.canceled || !result.path) return
    settings.updateSettings({
      projectDefaultDirectoryMode: 'custom',
      projectDefaultDirectory: result.path,
      lastProjectDirectory: result.path
    })
  }, [effectiveProjectDirectory, settings])

  return (
    <SettingsPanel title={t('system.title')} description={t('system.subtitle')}>
      <AppUpdateSection />

      <SettingsSection
        id="shell"
        title={t('system.shell.endpoint.title')}
        description={t('system.shell.endpoint.desc')}
        actions={
          <Badge variant="secondary" className="text-[10px]">
            {t('system.platform', { platform })}
          </Badge>
        }
      >
        <div className="space-y-2">
          <Select
            value={selectedShellEndpoint}
            onValueChange={(value: ShellExecutionEndpoint) =>
              settings.updateSettings({ shellExecutionEndpoint: value })
            }
          >
            <SelectTrigger className="w-full max-w-lg text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{t('system.shell.endpoint.selectLabel')}</SelectLabel>
                {shellOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {activeShellOption ? (
            <p className="text-xs text-muted-foreground">{t(activeShellOption.descKey)}</p>
          ) : null}
        </div>

        {selectedShellEndpoint === 'custom' ? (
          <SettingRow layout="stack" label={t('system.shell.customPath')}>
            <Input
              value={settings.customShellExecutable}
              onChange={(event) =>
                settings.updateSettings({ customShellExecutable: event.target.value })
              }
              placeholder={
                platform === 'win32'
                  ? t('system.shell.customPlaceholderWindows')
                  : t('system.shell.customPlaceholderPosix')
              }
              className="max-w-lg font-mono text-xs"
            />
          </SettingRow>
        ) : null}

        <p className="rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
          {resolvedShell
            ? t('system.shell.resolvedShell', { shell: resolvedShell })
            : t('system.shell.resolvedAuto')}
        </p>

        <SettingRow
          layout="stack"
          label={t('system.shell.environment.title')}
          description={t('system.shell.environment.desc')}
        >
          <Textarea
            value={shellEnvironmentVariablesDraft}
            onChange={(event) => handleShellEnvironmentVariablesChange(event.target.value)}
            placeholder={t('system.shell.environment.placeholder')}
            rows={8}
            className={`max-w-lg font-mono text-xs leading-5 ${
              invalidShellEnvironmentVariablesLine !== null
                ? 'border-destructive focus-visible:ring-destructive'
                : ''
            }`}
          />
          <div className="mt-2 space-y-1">
            <SettingHint>{t('system.shell.environment.formatHint')}</SettingHint>
            <SettingHint>{t('system.shell.environment.precedenceHint')}</SettingHint>
            <SettingHint>{t('system.shell.environment.newSessionHint')}</SettingHint>
            {invalidShellEnvironmentVariablesLine !== null ? (
              <SettingHint tone="danger">
                {t('system.shell.environment.validationError', {
                  line: invalidShellEnvironmentVariablesLine
                })}
              </SettingHint>
            ) : null}
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        id="proxy"
        title={t('general.systemProxy')}
        description={t('general.systemProxyDesc')}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="text"
            value={settings.systemProxyUrl}
            onChange={(e) => settings.updateSettings({ systemProxyUrl: e.target.value })}
            placeholder="http://127.0.0.1:7890"
            className="max-w-lg text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => settings.updateSettings({ systemProxyUrl: '' })}
          >
            {t('general.appearance.reset')}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="workspace"
        title={t('general.projectDefaultDirectory.title')}
        description={t('general.projectDefaultDirectory.desc')}
      >
        <SettingRow
          label={t('general.projectDefaultDirectory.useCustom')}
          description={t('general.projectDefaultDirectory.useCustomDesc')}
          control={
            <Switch
              checked={settings.projectDefaultDirectoryMode === 'custom'}
              onCheckedChange={(checked) =>
                settings.updateSettings({
                  projectDefaultDirectoryMode: checked ? 'custom' : 'last-used'
                })
              }
            />
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="text"
            value={settings.projectDefaultDirectory}
            onChange={(e) => settings.updateSettings({ projectDefaultDirectory: e.target.value })}
            onBlur={() => {
              const next = settings.projectDefaultDirectory.trim()
              settings.updateSettings({
                projectDefaultDirectory: next,
                projectDefaultDirectoryMode: next ? 'custom' : 'last-used'
              })
            }}
            placeholder="D:\\code"
            className="max-w-lg text-xs"
            disabled={settings.projectDefaultDirectoryMode !== 'custom'}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void handlePickProjectDefaultDirectory()}
            disabled={settings.projectDefaultDirectoryMode !== 'custom'}
          >
            {t('general.projectDefaultDirectory.pickDirectory')}
          </Button>
        </div>
        <SettingHint>
          {t('general.projectDefaultDirectory.effective', {
            path:
              effectiveProjectDirectory || t('general.projectDefaultDirectory.effectiveFallback')
          })}
        </SettingHint>
      </SettingsSection>

      <SettingsSection id="editor" title={t('general.sections.editor')}>
        <SettingRow
          label={t('general.editorWorkspace')}
          description={t('general.editorWorkspaceDesc')}
          control={
            <Switch
              checked={settings.editorWorkspaceEnabled}
              onCheckedChange={(checked) =>
                settings.updateSettings({
                  editorWorkspaceEnabled: checked,
                  editorRemoteLanguageServiceEnabled: checked
                    ? settings.editorRemoteLanguageServiceEnabled
                    : false
                })
              }
            />
          }
        >
          {settings.editorWorkspaceEnabled ? (
            <SettingHint>{t('general.editorWorkspaceEnabled')}</SettingHint>
          ) : null}
        </SettingRow>

        <SettingRow
          label={t('general.editorRemoteLanguageService')}
          description={t('general.editorRemoteLanguageServiceDesc')}
          disabled={!settings.editorWorkspaceEnabled}
          control={
            <Switch
              checked={settings.editorRemoteLanguageServiceEnabled}
              disabled={!settings.editorWorkspaceEnabled}
              onCheckedChange={(checked) =>
                settings.updateSettings({ editorRemoteLanguageServiceEnabled: checked })
              }
            />
          }
        >
          {settings.editorRemoteLanguageServiceEnabled && settings.editorWorkspaceEnabled ? (
            <SettingHint>{t('general.editorRemoteLanguageServiceEnabled')}</SettingHint>
          ) : null}
        </SettingRow>
      </SettingsSection>
    </SettingsPanel>
  )
}
