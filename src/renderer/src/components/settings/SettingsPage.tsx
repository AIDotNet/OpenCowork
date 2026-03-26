import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Settings,
  BrainCircuit,
  BarChart3,
  Info,
  Server,
  Cable,
  Loader2,
  Github,
  Sparkles,
  ShieldCheck,
  Layers,
  HardDriveDownload,
  HardDriveUpload,
  Trash2,
  Globe,
  Wand2,
  BookOpen,
  Save,
  RefreshCw,
  Puzzle,
  PanelLeftOpen
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { AnimatePresence } from 'motion/react'
import { useUIStore, type SettingsTab } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Separator } from '@renderer/components/ui/separator'
import { Slider } from '@renderer/components/ui/slider'
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
import { FadeIn, SlideIn } from '@renderer/components/animate-ui'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ProviderPanel } from './ProviderPanel'
import { ChannelPanel } from './PluginPanel'
import { AppPluginPanel } from './AppPluginPanel'
import { McpPanel } from './McpPanel'
import { WebSearchPanel } from './WebSearchPanel'
import { SkillsMarketPanel } from './SkillsMarketPanel'
import { ModelIcon, ProviderIcon } from './provider-icons'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  joinFsPath,
  readTextFile,
  resolveGlobalMemoryHomePath
} from '@renderer/lib/agent/memory-files'
import packageJson from '../../../../../package.json'
import {
  getUsageByModel,
  getUsageByProvider,
  getUsageDaily,
  getUsageOverview,
  listUsageEvents
} from '@renderer/lib/usage-analytics'

const DEFAULT_GLOBAL_MEMORY_TEMPLATES = {
  soul: `# SOUL.md

This file defines your long-term identity, style, and behavior boundaries across OpenCowork sessions.

## Core Truths
- Be genuinely helpful, not performatively helpful
- Be direct, grounded, and competent
- Be resourceful before asking

## Boundaries
- Keep private things private
- Ask before external or destructive actions
- System and product safety rules outrank this file
`,
  user: `# USER.md

This file captures durable user preferences and collaboration style.

## Profile
- Name:
- What to call them:
- Timezone:

## Preferences
- Preferred language:
- Preferred answer style:
- Things to avoid:
`,
  memory: `# MEMORY.md

This file stores global durable memory shared across OpenCowork sessions.

## Stable Preferences
- Add user preferences that should persist across projects.

## Durable Decisions
- Record decisions and workflow habits that should be reused.

## Long-lived Context
- Save long-term facts and defaults (non-sensitive only).

## Do Not Store
- Secrets, API keys, credentials
- Temporary debugging notes or one-off task context
`,
  daily: `# Daily Memory

Use this file for short-term notes for today.

- Decisions made today
- Temporary context worth carrying into the next session
- Follow-ups to review later and distill into MEMORY.md
`
} as const

type GlobalMemoryTabId = keyof typeof DEFAULT_GLOBAL_MEMORY_TEMPLATES

type GlobalMemoryFileState = {
  id: GlobalMemoryTabId
  titleKey: string
  descriptionKey: string
  filename: string
  path: string
  savedContent: string
  draftContent: string
  missingFile: boolean
  lastSavedAt: number | null
}

const GLOBAL_MEMORY_FILE_META: Record<
  GlobalMemoryTabId,
  Pick<GlobalMemoryFileState, 'id' | 'titleKey' | 'descriptionKey'>
> = {
  soul: {
    id: 'soul',
    titleKey: 'memory.tabs.soul',
    descriptionKey: 'memory.tabDescriptions.soul'
  },
  user: {
    id: 'user',
    titleKey: 'memory.tabs.user',
    descriptionKey: 'memory.tabDescriptions.user'
  },
  memory: {
    id: 'memory',
    titleKey: 'memory.tabs.memory',
    descriptionKey: 'memory.tabDescriptions.memory'
  },
  daily: {
    id: 'daily',
    titleKey: 'memory.tabs.daily',
    descriptionKey: 'memory.tabDescriptions.daily'
  }
}

function createInitialGlobalMemoryFiles(): Record<GlobalMemoryTabId, GlobalMemoryFileState> {
  return {
    soul: {
      ...GLOBAL_MEMORY_FILE_META.soul,
      filename: 'SOUL.md',
      path: '',
      savedContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.soul,
      draftContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.soul,
      missingFile: true,
      lastSavedAt: null
    },
    user: {
      ...GLOBAL_MEMORY_FILE_META.user,
      filename: 'USER.md',
      path: '',
      savedContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.user,
      draftContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.user,
      missingFile: true,
      lastSavedAt: null
    },
    memory: {
      ...GLOBAL_MEMORY_FILE_META.memory,
      filename: 'MEMORY.md',
      path: '',
      savedContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.memory,
      draftContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.memory,
      missingFile: true,
      lastSavedAt: null
    },
    daily: {
      ...GLOBAL_MEMORY_FILE_META.daily,
      filename: '',
      path: '',
      savedContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.daily,
      draftContent: DEFAULT_GLOBAL_MEMORY_TEMPLATES.daily,
      missingFile: true,
      lastSavedAt: null
    }
  }
}

function isMissingFileError(error: string): boolean {
  return error.includes('ENOENT')
}

function getIpcError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const error = (result as { error?: unknown }).error
  return typeof error === 'string' && error.trim() ? error : null
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

const menuGroupDefs: Array<{
  labelKey: string
  items: { id: SettingsTab; icon: React.ReactNode; labelKey: string; descKey: string }[]
}> = [
  {
    labelKey: 'page.groups.foundation',
    items: [
      {
        id: 'general',
        icon: <Settings className="size-4" />,
        labelKey: 'general.title',
        descKey: 'general.subtitle'
      },
      {
        id: 'memory',
        icon: <BookOpen className="size-4" />,
        labelKey: 'memory.title',
        descKey: 'memory.subtitle'
      },
      {
        id: 'analytics',
        icon: <BarChart3 className="size-4" />,
        labelKey: 'analytics.title',
        descKey: 'analytics.subtitle'
      }
    ]
  },
  {
    labelKey: 'page.groups.ai',
    items: [
      {
        id: 'provider',
        icon: <Server className="size-4" />,
        labelKey: 'provider.title',
        descKey: 'provider.subtitle'
      },
      {
        id: 'model',
        icon: <BrainCircuit className="size-4" />,
        labelKey: 'model.title',
        descKey: 'model.subtitle'
      }
    ]
  },
  {
    labelKey: 'page.groups.extensions',
    items: [
      {
        id: 'plugin',
        icon: <Puzzle className="size-4" />,
        labelKey: 'plugin.title',
        descKey: 'plugin.subtitle'
      },
      {
        id: 'mcp',
        icon: <Cable className="size-4" />,
        labelKey: 'mcp.title',
        descKey: 'mcp.subtitle'
      },
      {
        id: 'websearch',
        icon: <Globe className="size-4" />,
        labelKey: 'websearch.title',
        descKey: 'websearch.subtitle'
      },
      {
        id: 'skillsmarket',
        icon: <Wand2 className="size-4" />,
        labelKey: 'skillsmarket.title',
        descKey: 'skillsmarket.subtitle'
      }
    ]
  },
  {
    labelKey: 'page.groups.about',
    items: [
      {
        id: 'about',
        icon: <Info className="size-4" />,
        labelKey: 'about.title',
        descKey: 'about.subtitle'
      }
    ]
  }
]

// ─── General Settings Panel ───

function GeneralPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const { setTheme } = useTheme()
  const currentVersion = normalizeVersion(packageJson.version ?? '0.0.0')
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null)
  const sessions = useChatStore((s) => s.sessions)
  const clearAllSessions = useChatStore((s) => s.clearAllSessions)

  const fontOptions = [
    { label: t('general.appearance.fontSystem'), value: '__default__' },
    {
      label: 'Inter',
      value:
        "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif"
    },
    {
      label: 'Segoe UI',
      value:
        "'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif"
    },
    {
      label: 'Noto Sans',
      value: "'Noto Sans', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    },
    {
      label: 'Source Sans 3',
      value: "'Source Sans 3', system-ui, -apple-system, 'Segoe UI', sans-serif"
    },
    {
      label: 'Monospace',
      value: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace"
    }
  ]

  const clampFontSize = (value: number): number => Math.min(20, Math.max(12, value))

  const checkForUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    setUpdateError(null)
    setDownloadedVersion(null)
    try {
      const result = (await window.electron.ipcRenderer.invoke(IPC.UPDATE_CHECK)) as
        | {
            success: true
            available: boolean
            currentVersion: string
            latestVersion: string | null
          }
        | { success: false; error: string }

      if (!result.success) {
        setUpdateError(result.error)
        setLatestVersion(null)
        return
      }

      setLatestVersion(normalizeVersion(result.latestVersion))
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

  const updateAvailable = isNewerVersion(latestVersion, currentVersion)

  useEffect(() => {
    const offAvailable = ipcClient.on(IPC.UPDATE_AVAILABLE, (data: unknown) => {
      const d = data as { currentVersion: string; newVersion: string; releaseNotes: string }
      setLatestVersion(normalizeVersion(d.newVersion))
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
    })

    const offError = ipcClient.on(IPC.UPDATE_ERROR, (data: unknown) => {
      const d = data as { error: string }
      setDownloadingUpdate(false)
      setDownloadProgress(null)
      setUpdateError(d.error)
    })

    return () => {
      offAvailable()
      offProgress()
      offDownloaded()
      offError()
    }
  }, [])

  const handleUpdateNow = useCallback(async () => {
    setUpdateError(null)
    setDownloadingUpdate(true)
    setDownloadProgress(null)
    setDownloadedVersion(null)

    const result = (await window.electron.ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD)) as
      | { success: true }
      | { success: false; error: string }

    if (!result.success) {
      setDownloadingUpdate(false)
      setUpdateError(result.error)
    }
  }, [])

  const handleBackupSessions = useCallback(async () => {
    if (sessions.length === 0) {
      toast.info(t('general.data.noSessions'))
      return
    }
    await Promise.all(sessions.map((s) => useChatStore.getState().loadSessionMessages(s.id)))
    const latestSessions = useChatStore.getState().sessions
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

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">{t('general.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('general.subtitle')}</p>
      </div>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Update status</span>
          <span className="text-xs text-muted-foreground">
            Current v{currentVersion}
            {latestVersion && <> · Latest v{latestVersion}</>}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-2">
          <div>
            <label className="text-sm font-medium">{t('general.autoUpdate')}</label>
            <p className="text-xs text-muted-foreground">{t('general.autoUpdateDesc')}</p>
          </div>
          <Switch
            checked={settings.autoUpdateEnabled}
            onCheckedChange={(checked) => settings.updateSettings({ autoUpdateEnabled: checked })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void checkForUpdates()}
            disabled={checkingUpdate}
          >
            {checkingUpdate && <Loader2 className="mr-1 size-3 animate-spin" />}
            {checkingUpdate ? 'Checking…' : 'Check for updates'}
          </Button>
          {updateAvailable && (
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void handleUpdateNow()}
              disabled={downloadingUpdate}
            >
              {downloadingUpdate && <Loader2 className="mr-1 size-3 animate-spin" />}
              {downloadingUpdate ? 'Updating…' : 'Update now'}
            </Button>
          )}
        </div>
        {updateError && (
          <p className="text-xs text-destructive">Failed to check updates: {updateError}</p>
        )}
        {!updateError && !updateAvailable && latestVersion && !checkingUpdate && (
          <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
            You are up to date.
          </p>
        )}
        {updateAvailable && !downloadingUpdate && (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            A newer version (v{latestVersion}) is available.
          </p>
        )}
        {downloadingUpdate && (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            Downloading update
            {typeof downloadProgress === 'number' ? `… ${Math.round(downloadProgress)}%` : '…'}
          </p>
        )}
        {downloadedVersion && (
          <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
            Update v{downloadedVersion} downloaded. Restarting to install…
          </p>
        )}
      </section>

      {/* Theme */}
      <section className="space-y-3">
        <div>
          <label className="text-sm font-medium">{t('general.theme')}</label>
          <p className="text-xs text-muted-foreground">{t('general.themeDesc')}</p>
        </div>
        <Select
          value={settings.theme}
          onValueChange={(v: 'light' | 'dark' | 'system') => {
            settings.updateSettings({ theme: v })
            setTheme(v)
          }}
        >
          <SelectTrigger className="w-60 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light" className="text-xs">
              {t('general.light')}
            </SelectItem>
            <SelectItem value="dark" className="text-xs">
              {t('general.dark')}
            </SelectItem>
            <SelectItem value="system" className="text-xs">
              {t('general.system')}
            </SelectItem>
          </SelectContent>
        </Select>
      </section>

      {/* Appearance */}
      <section className="space-y-4">
        <div>
          <label className="text-sm font-medium">{t('general.appearance.title')}</label>
          <p className="text-xs text-muted-foreground">{t('general.appearance.subtitle')}</p>
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-xs font-medium">{t('general.appearance.background')}</label>
            <p className="text-xs text-muted-foreground">
              {t('general.appearance.backgroundDesc')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="color"
              value={settings.backgroundColor || '#111111'}
              onChange={(e) => settings.updateSettings({ backgroundColor: e.target.value })}
              className="h-8 w-12 cursor-pointer p-1"
            />
            <Input
              type="text"
              value={settings.backgroundColor}
              onChange={(e) => settings.updateSettings({ backgroundColor: e.target.value.trim() })}
              placeholder={t('general.appearance.backgroundPlaceholder')}
              className="max-w-40 text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => settings.updateSettings({ backgroundColor: '' })}
            >
              {t('general.appearance.reset')}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-xs font-medium">{t('general.appearance.font')}</label>
            <p className="text-xs text-muted-foreground">{t('general.appearance.fontDesc')}</p>
          </div>
          <Select
            value={settings.fontFamily || '__default__'}
            onValueChange={(value) =>
              settings.updateSettings({ fontFamily: value === '__default__' ? '' : value })
            }
          >
            <SelectTrigger className="w-80 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fontOptions.map((option) => (
                <SelectItem key={option.label} value={option.value} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between max-w-lg">
            <div>
              <label className="text-xs font-medium">{t('general.appearance.fontSize')}</label>
              <p className="text-xs text-muted-foreground">
                {t('general.appearance.fontSizeDesc')}
              </p>
            </div>
            <span className="text-xs text-muted-foreground">{settings.fontSize}px</span>
          </div>
          <Slider
            value={[settings.fontSize]}
            onValueChange={([value]) => settings.updateSettings({ fontSize: clampFontSize(value) })}
            min={12}
            max={20}
            step={1}
            className="max-w-lg"
          />
          <Input
            type="number"
            min={12}
            max={20}
            value={settings.fontSize}
            onChange={(e) => {
              const next = clampFontSize(parseInt(e.target.value, 10) || 16)
              settings.updateSettings({ fontSize: next })
            }}
            className="max-w-32 text-xs"
          />
        </div>
      </section>

      <Separator />

      {/* Animation */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.animations')}</label>
            <p className="text-xs text-muted-foreground">{t('general.animationsDesc')}</p>
          </div>
          <Switch
            checked={settings.animationsEnabled}
            onCheckedChange={(checked) => settings.updateSettings({ animationsEnabled: checked })}
          />
        </div>
      </section>

      <Separator />

      {/* Toolbar Default Collapse */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.toolbarCollapsedByDefault')}</label>
            <p className="text-xs text-muted-foreground">
              {t('general.toolbarCollapsedByDefaultDesc')}
            </p>
          </div>
          <Switch
            checked={settings.toolbarCollapsedByDefault}
            onCheckedChange={(checked) =>
              settings.updateSettings({ toolbarCollapsedByDefault: checked })
            }
          />
        </div>
      </section>

      <Separator />

      {/* Language */}
      <section className="space-y-3">
        <div>
          <label className="text-sm font-medium">{t('general.language')}</label>
          <p className="text-xs text-muted-foreground">{t('general.languageDesc')}</p>
        </div>
        <Select
          value={settings.language}
          onValueChange={(v: 'en' | 'zh') => settings.updateSettings({ language: v })}
        >
          <SelectTrigger className="w-60 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh" className="text-xs">
              {t('general.chinese')}
            </SelectItem>
            <SelectItem value="en" className="text-xs">
              {t('general.english')}
            </SelectItem>
          </SelectContent>
        </Select>
      </section>

      <Separator />

      {/* Tool Result Format */}
      <section className="space-y-3">
        <div>
          <label className="text-sm font-medium">{t('general.toolResultFormat')}</label>
          <p className="text-xs text-muted-foreground">{t('general.toolResultFormatDesc')}</p>
        </div>
        <Select
          value={settings.toolResultFormat}
          onValueChange={(v: 'toon' | 'json') => settings.updateSettings({ toolResultFormat: v })}
        >
          <SelectTrigger className="w-60 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="toon" className="text-xs">
              {t('general.toolResultFormatToon')}
            </SelectItem>
            <SelectItem value="json" className="text-xs">
              {t('general.toolResultFormatJson')}
            </SelectItem>
          </SelectContent>
        </Select>
      </section>

      <Separator />

      {/* Team Tools */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.teamTools')}</label>
            <p className="text-xs text-muted-foreground">{t('general.teamToolsDesc')}</p>
          </div>
          <Switch
            checked={settings.teamToolsEnabled}
            onCheckedChange={(checked) => settings.updateSettings({ teamToolsEnabled: checked })}
          />
        </div>
        {settings.teamToolsEnabled && (
          <p className="text-xs text-muted-foreground/70">{t('general.teamToolsEnabled')}</p>
        )}
      </section>

      <Separator />

      {/* Context Compression */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.contextCompression')}</label>
            <p className="text-xs text-muted-foreground">{t('general.contextCompressionDesc')}</p>
          </div>
          <Switch
            checked={settings.contextCompressionEnabled}
            onCheckedChange={(checked) =>
              settings.updateSettings({ contextCompressionEnabled: checked })
            }
          />
        </div>
        {settings.contextCompressionEnabled && (
          <p className="text-xs text-muted-foreground/70">
            {t('general.contextCompressionEnabled')}
          </p>
        )}
      </section>

      <Separator />

      {/* Editor Workspace */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.editorWorkspace')}</label>
            <p className="text-xs text-muted-foreground">{t('general.editorWorkspaceDesc')}</p>
          </div>
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
        </div>
        {settings.editorWorkspaceEnabled && (
          <p className="text-xs text-muted-foreground/70">{t('general.editorWorkspaceEnabled')}</p>
        )}
      </section>

      <Separator />

      {/* Remote Language Service */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">
              {t('general.editorRemoteLanguageService')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('general.editorRemoteLanguageServiceDesc')}
            </p>
          </div>
          <Switch
            checked={settings.editorRemoteLanguageServiceEnabled}
            disabled={!settings.editorWorkspaceEnabled}
            onCheckedChange={(checked) =>
              settings.updateSettings({ editorRemoteLanguageServiceEnabled: checked })
            }
          />
        </div>
        {settings.editorRemoteLanguageServiceEnabled && settings.editorWorkspaceEnabled && (
          <p className="text-xs text-muted-foreground/70">
            {t('general.editorRemoteLanguageServiceEnabled')}
          </p>
        )}
      </section>

      <Separator />

      {/* Clarify Auto Accept Recommended */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">
              {t('general.clarifyAutoAcceptRecommended')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('general.clarifyAutoAcceptRecommendedDesc')}
            </p>
          </div>
          <Switch
            checked={settings.clarifyAutoAcceptRecommended}
            onCheckedChange={(checked) =>
              settings.updateSettings({ clarifyAutoAcceptRecommended: checked })
            }
          />
        </div>
      </section>

      <Separator />

      {/* Auto Approve */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.autoApprove')}</label>
            <p className="text-xs text-muted-foreground">{t('general.autoApproveDesc')}</p>
          </div>
          <Switch
            checked={settings.autoApprove}
            onCheckedChange={async (checked) => {
              if (checked) {
                const ok = await confirm({ title: t('general.autoApproveWarning') })
                if (!ok) return
              }
              settings.updateSettings({ autoApprove: checked })
            }}
          />
        </div>
        {settings.autoApprove && (
          <p className="text-xs text-destructive">{t('general.autoApproveWarning')}</p>
        )}
      </section>

      <Separator />

      {/* Developer Mode */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.devMode')}</label>
            <p className="text-xs text-muted-foreground">{t('general.devModeDesc')}</p>
          </div>
          <Switch
            checked={settings.devMode}
            onCheckedChange={(checked) => settings.updateSettings({ devMode: checked })}
          />
        </div>
      </section>

      <Separator />

      {/* Data Management */}
      <section className="space-y-4 rounded-xl border border-border/60 bg-muted/15 p-4">
        <div>
          <h3 className="text-sm font-semibold">{t('general.data.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('general.data.subtitle')}</p>
        </div>
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
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 sm:col-span-2">
            <div className="flex items-center gap-2 text-sm font-medium text-destructive">
              <Trash2 className="size-4" />
              {t('general.data.clearTitle')}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('general.data.clearDesc')}</p>
            <Button
              className="mt-3 h-8 text-xs"
              size="sm"
              variant="destructive"
              onClick={() => void handleClearAllSessions()}
              disabled={sessions.length === 0}
            >
              {t('general.data.clearAction')}
            </Button>
          </div>
        </div>
      </section>

      <Separator />

      {/* Reset */}
      <section>
        <Button
          variant="outline"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={async () => {
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
              theme: 'system',
              backgroundColor: '',
              fontFamily: '',
              fontSize: 16,
              animationsEnabled: true,
              toolbarCollapsedByDefault: false,
              autoUpdateEnabled: true,
              apiKey: currentKey
            })
            setTheme('system')
            toast.success(t('general.resetDone'))
          }}
        >
          {t('general.resetDefault')}
        </Button>
      </section>
    </div>
  )
}

function MemoryPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [memoryRootPath, setMemoryRootPath] = useState('')
  const [activeTab, setActiveTab] = useState<GlobalMemoryTabId>('soul')
  const [files, setFiles] = useState<Record<GlobalMemoryTabId, GlobalMemoryFileState>>(
    createInitialGlobalMemoryFiles
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const activeFile = files[activeTab]
  const hasUnsavedChanges = activeFile.draftContent !== activeFile.savedContent
  const canSave = activeFile.missingFile || hasUnsavedChanges

  const loadGlobalMemoryFiles = async (): Promise<void> => {
    setLoading(true)
    try {
      const rootPath = await resolveGlobalMemoryHomePath(ipcClient)
      if (!rootPath) {
        toast.error(t('memory.resolvePathFailed'))
        setMemoryRootPath('')
        return
      }

      const today = new Date().toISOString().slice(0, 10)
      const descriptors = {
        soul: { filename: 'SOUL.md', path: joinFsPath(rootPath, 'SOUL.md') },
        user: { filename: 'USER.md', path: joinFsPath(rootPath, 'USER.md') },
        memory: { filename: 'MEMORY.md', path: joinFsPath(rootPath, 'MEMORY.md') },
        daily: {
          filename: `memory/${today}.md`,
          path: joinFsPath(rootPath, 'memory', `${today}.md`)
        }
      } as const

      setMemoryRootPath(rootPath)

      const nextEntries = await Promise.all(
        (Object.keys(descriptors) as GlobalMemoryTabId[]).map(async (id) => {
          const descriptor = descriptors[id]
          const { content, error } = await readTextFile(ipcClient, descriptor.path)

          if (error && !isMissingFileError(error)) {
            throw new Error(`${descriptor.filename}: ${error}`)
          }

          const normalized =
            error && isMissingFileError(error)
              ? DEFAULT_GLOBAL_MEMORY_TEMPLATES[id]
              : (content ?? '')

          return [
            id,
            {
              ...GLOBAL_MEMORY_FILE_META[id],
              filename: descriptor.filename,
              path: descriptor.path,
              savedContent: normalized,
              draftContent: normalized,
              missingFile: Boolean(error && isMissingFileError(error)),
              lastSavedAt: null
            }
          ] as const
        })
      )

      setFiles((prev) => {
        const updated = { ...prev }
        for (const [id, entry] of nextEntries) {
          updated[id] = {
            ...entry,
            lastSavedAt: prev[id].lastSavedAt
          }
        }
        return updated
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('memory.loadFailed', { error: message }))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadGlobalMemoryFiles()
    // Only auto-load once when the panel mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateDraft = useCallback(
    (value: string) => {
      setFiles((prev) => ({
        ...prev,
        [activeTab]: {
          ...prev[activeTab],
          draftContent: value
        }
      }))
    },
    [activeTab]
  )

  const handleReset = useCallback(() => {
    setFiles((prev) => ({
      ...prev,
      [activeTab]: {
        ...prev[activeTab],
        draftContent: prev[activeTab].savedContent
      }
    }))
  }, [activeTab])

  const handleSave = useCallback(async () => {
    if (!activeFile.path) {
      toast.error(t('memory.resolvePathFailed'))
      return
    }

    setSaving(true)
    try {
      const result = await ipcClient.invoke(IPC.FS_WRITE_FILE, {
        path: activeFile.path,
        content: activeFile.draftContent
      })
      const error = getIpcError(result)
      if (error) {
        toast.error(t('memory.saveFailed', { file: activeFile.filename, error }))
        return
      }

      setFiles((prev) => ({
        ...prev,
        [activeTab]: {
          ...prev[activeTab],
          savedContent: prev[activeTab].draftContent,
          missingFile: false,
          lastSavedAt: Date.now()
        }
      }))
      toast.success(t('memory.saved', { file: activeFile.filename }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('memory.saveFailed', { file: activeFile.filename, error: message }))
    } finally {
      setSaving(false)
    }
  }, [activeFile.draftContent, activeFile.filename, activeFile.path, activeTab, t])

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">{t('memory.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('memory.subtitle')}</p>
      </div>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('memory.rootPathLabel')}</p>
            <p className="break-all text-xs text-muted-foreground">
              {memoryRootPath || t('memory.pathUnavailable')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void loadGlobalMemoryFiles()}
            disabled={loading || saving}
          >
            <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('memory.reloadAction')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('memory.effectiveHint')}</p>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(files) as GlobalMemoryTabId[]).map((id) => {
            const entry = files[id]
            const isActive = activeTab === id
            return (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={isActive ? 'default' : 'outline'}
                className="h-8 text-xs"
                onClick={() => setActiveTab(id)}
              >
                {t(entry.titleKey)}
              </Button>
            )
          })}
        </div>

        <div className="rounded-lg border border-border/60 bg-background/60 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t(activeFile.titleKey)}</label>
              <p className="text-xs text-muted-foreground">{t(activeFile.descriptionKey)}</p>
              <p className="break-all text-[11px] text-muted-foreground">
                {activeFile.path || t('memory.pathUnavailable')}
              </p>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {hasUnsavedChanges
                ? t('memory.unsavedChanges')
                : activeFile.lastSavedAt
                  ? t('memory.lastSavedAt', {
                      time: new Date(activeFile.lastSavedAt).toLocaleString()
                    })
                  : t('memory.upToDate')}
            </span>
          </div>

          {activeFile.missingFile && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              {t('memory.missingFileHint', { file: activeFile.filename })}
            </p>
          )}

          <Textarea
            value={activeFile.draftContent}
            onChange={(e) => updateDraft(e.target.value)}
            placeholder={t('memory.editorPlaceholder', {
              file: activeFile.filename || t(activeFile.titleKey)
            })}
            rows={20}
            className="min-h-[420px] font-mono text-xs leading-5"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handleSave()}
              disabled={saving || loading || !canSave}
            >
              {saving ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 size-3.5" />
              )}
              {saving ? t('memory.savingAction') : t('memory.saveAction')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={handleReset}
              disabled={saving || loading || !hasUnsavedChanges}
            >
              {t('memory.resetAction')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

// ─── Model Configuration Panel ───

function AnalyticsPanel(): React.JSX.Element {
  const { t, i18n } = useTranslation('settings')
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30)
  const [loading, setLoading] = useState(true)
  const [selectedProviderId, setSelectedProviderId] = useState<string>('__all__')
  const [selectedModelId, setSelectedModelId] = useState<string>('__all__')
  const [selectedSourceKind, setSelectedSourceKind] = useState<string>('__all__')
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof getUsageOverview>> | null>(
    null
  )
  const [daily, setDaily] = useState<Record<string, unknown>[]>([])
  const [models, setModels] = useState<Record<string, unknown>[]>([])
  const [providers, setProviders] = useState<Record<string, unknown>[]>([])
  const [details, setDetails] = useState<Record<string, unknown>[]>([])

  const providerOptions = useMemo(
    () =>
      useProviderStore
        .getState()
        .providers.filter((provider) => provider.enabled)
        .map((provider) => ({ id: provider.id, name: provider.name })),
    []
  )
  const modelOptions = useMemo(
    () =>
      useProviderStore.getState().providers.flatMap((provider) =>
        provider.models.map((model) => ({
          id: model.id,
          name: model.name,
          providerId: provider.id
        }))
      ),
    []
  )
  const sourceOptions = ['chat', 'agent', 'cron', 'plugin', 'draw', 'translate', 'team']

  const query = useMemo(() => {
    const to = Date.now()
    const from = to - rangeDays * 24 * 60 * 60 * 1000
    return {
      from,
      to,
      limit: 50,
      offset: 0,
      providerId: selectedProviderId === '__all__' ? null : selectedProviderId,
      modelId: selectedModelId === '__all__' ? null : selectedModelId,
      sourceKind: selectedSourceKind === '__all__' ? null : selectedSourceKind
    }
  }, [rangeDays, selectedModelId, selectedProviderId, selectedSourceKind])

  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      setLoading(true)
      try {
        const [nextOverview, nextDaily, nextModels, nextProviders, nextDetails] = await Promise.all(
          [
            getUsageOverview(query),
            getUsageDaily(query),
            getUsageByModel(query),
            getUsageByProvider(query),
            listUsageEvents(query)
          ]
        )
        if (cancelled) return
        setOverview(nextOverview)
        setDaily(nextDaily)
        setModels(nextModels)
        setProviders(nextProviders)
        setDetails(nextDetails)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [query])

  const tokenLocale = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US'
  const inputTokenLabel = t('analytics.billableInputTokens', {
    defaultValue: tokenLocale === 'zh-CN' ? '计费输入 Token' : 'Billable Input Tokens'
  })
  const fmtInt = (value: unknown): string =>
    new Intl.NumberFormat(tokenLocale).format(
      typeof value === 'number' ? value : Number(value ?? 0)
    )
  const fmtTokenCompact = (value: unknown): string => {
    const number = typeof value === 'number' ? value : Number(value ?? 0)
    if (!Number.isFinite(number)) return '0'
    return new Intl.NumberFormat(tokenLocale, {
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: number >= 100000 ? 1 : 2
    }).format(Math.max(0, number))
  }
  const getEffectiveInputTokens = (row: Record<string, unknown>): number => {
    const billable = Number(row.billable_input_tokens ?? Number.NaN)
    if (Number.isFinite(billable)) return Math.max(0, billable)
    const input = Number(row.input_tokens ?? 0)
    const cacheRead = Number(row.cache_read_tokens ?? 0)
    return row.request_type === 'openai-responses' ? Math.max(0, input - cacheRead) : input
  }
  const renderTokenValue = (value: unknown, showRaw = false): React.JSX.Element => {
    const compact = fmtTokenCompact(value)
    const raw = fmtInt(value)
    const shouldShowRaw = showRaw && compact !== raw
    return (
      <span title={`${raw} Token`} className="inline-flex flex-col tabular-nums leading-tight">
        <span>{compact}</span>
        {shouldShowRaw ? <span className="text-[11px] text-muted-foreground">{raw}</span> : null}
      </span>
    )
  }
  const fmtMoney = (value: unknown): string =>
    typeof value === 'number' || typeof value === 'string'
      ? Number(value || 0).toFixed(6)
      : '0.000000'
  const fmtMs = (value: unknown): string => {
    const number = typeof value === 'number' ? value : Number(value ?? 0)
    return Number.isFinite(number) && number > 0 ? `${Math.round(number)} ms` : '-'
  }

  const buildLinePoints = (rows: Record<string, unknown>[], key: string): string => {
    if (rows.length === 0) return ''
    const values = rows.map((row) => Number(row[key] ?? 0))
    const max = Math.max(...values, 1)
    return rows
      .map((row, index) => {
        const x = rows.length === 1 ? 0 : (index / (rows.length - 1)) * 100
        const y = 100 - (Number(row[key] ?? 0) / max) * 100
        return `${x},${y}`
      })
      .join(' ')
  }

  const renderLineChart = (
    title: string,
    rows: Record<string, unknown>[],
    dataKey: string
  ): React.JSX.Element => {
    if (rows.length === 0) {
      return (
        <section className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-4">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{t('analytics.empty')}</p>
        </section>
      )
    }

    const latestRow = rows[0]
    const latestValue =
      dataKey === 'total_cost_usd'
        ? `$${fmtMoney(latestRow[dataKey])}`
        : renderTokenValue(latestRow[dataKey], true)

    if (rows.length === 1) {
      return (
        <section className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-4">
          <h3 className="text-sm font-semibold">{title}</h3>
          <div className="flex h-40 flex-col items-center justify-center rounded-lg border border-dashed border-border/40 bg-muted/20 text-center">
            <div className="text-xs text-muted-foreground">{String(latestRow.day ?? '-')}</div>
            <div className="mt-3 text-2xl font-semibold">{latestValue}</div>
            <div className="mt-2 text-xs text-muted-foreground">{t('analytics.requests')} 1</div>
          </div>
        </section>
      )
    }

    return (
      <section className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <div className="text-right text-xs text-muted-foreground">
            <div>{String(latestRow.day ?? '-')}</div>
            <div className="mt-1 font-medium text-foreground">{latestValue}</div>
          </div>
        </div>
        <svg viewBox="0 0 100 100" className="h-40 w-full overflow-visible rounded-lg bg-muted/20">
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-primary"
            points={buildLinePoints([...rows].reverse(), dataKey)}
          />
        </svg>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[...rows].slice(0, 4).map((row, index) => (
            <div
              key={`${title}-${index}`}
              className="rounded-lg border border-border/40 px-3 py-2 text-xs"
            >
              <div className="text-muted-foreground">{String(row.day ?? '-')}</div>
              <div className="mt-1 font-medium">
                {dataKey === 'total_cost_usd'
                  ? `$${fmtMoney(row[dataKey])}`
                  : renderTokenValue(row[dataKey], true)}
              </div>
            </div>
          ))}
        </div>
      </section>
    )
  }

  const cards = [
    { label: t('analytics.requests'), value: fmtInt(overview?.request_count) },
    { label: inputTokenLabel, value: renderTokenValue(overview?.input_tokens, true) },
    { label: t('analytics.outputTokens'), value: renderTokenValue(overview?.output_tokens, true) },
    {
      label: t('analytics.cacheCreationTokens'),
      value: renderTokenValue(overview?.cache_creation_tokens, true)
    },
    {
      label: t('analytics.cacheReadTokens'),
      value: renderTokenValue(overview?.cache_read_tokens, true)
    },
    { label: t('analytics.costUsd'), value: `$${fmtMoney(overview?.total_cost_usd)}` },
    { label: t('analytics.avgTtft'), value: fmtMs(overview?.avg_ttft_ms) },
    { label: t('analytics.avgTotal'), value: fmtMs(overview?.avg_total_ms) }
  ]

  const renderSimpleTable = (
    title: string,
    rows: Record<string, unknown>[],
    columns: Array<{
      key: string
      label: string
      render?: (row: Record<string, unknown>) => React.JSX.Element | string
    }>
  ): React.JSX.Element => (
    <section className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('analytics.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                {columns.map((column) => (
                  <th key={column.key} className="px-2 py-2 font-medium">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${title}-${index}`} className="border-b border-border/30 last:border-0">
                  {columns.map((column) => (
                    <td key={column.key} className="px-2 py-2 align-top">
                      {column.render ? column.render(row) : String(row[column.key] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('analytics.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('analytics.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          {([7, 30, 90] as const).map((days) => (
            <Button
              key={days}
              size="sm"
              variant={rangeDays === days ? 'default' : 'outline'}
              className="h-8 text-xs"
              onClick={() => setRangeDays(days)}
            >
              {days === 7
                ? t('analytics.range7d')
                : days === 30
                  ? t('analytics.range30d')
                  : t('analytics.range90d')}
            </Button>
          ))}
        </div>
      </div>

      <section className="grid gap-3 rounded-xl border border-border/60 bg-background/60 p-4 md:grid-cols-3 xl:grid-cols-4">
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t('analytics.provider')}</div>
          <Select value={selectedProviderId} onValueChange={setSelectedProviderId}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('analytics.allProviders')}</SelectItem>
              {providerOptions.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t('analytics.model')}</div>
          <Select value={selectedModelId} onValueChange={setSelectedModelId}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('analytics.allModels')}</SelectItem>
              {modelOptions.map((model) => (
                <SelectItem key={`${model.providerId}-${model.id}`} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t('analytics.source')}</div>
          <Select value={selectedSourceKind} onValueChange={setSelectedSourceKind}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('analytics.allSources')}</SelectItem>
              {sourceOptions.map((source) => (
                <SelectItem key={source} value={source}>
                  {source}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading...
        </div>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <div
                key={card.label}
                className="rounded-xl border border-border/60 bg-background/60 p-4"
              >
                <div className="text-xs text-muted-foreground">{card.label}</div>
                <div className="mt-2 text-lg font-semibold">{card.value}</div>
              </div>
            ))}
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            {renderLineChart(t('analytics.chartCost'), daily, 'total_cost_usd')}
            {renderLineChart(t('analytics.chartTokens'), daily, 'output_tokens')}
          </section>

          {renderSimpleTable(t('analytics.daily'), daily, [
            { key: 'day', label: t('analytics.time') },
            { key: 'request_count', label: t('analytics.requests') },
            {
              key: 'input_tokens',
              label: inputTokenLabel,
              render: (row) => renderTokenValue(getEffectiveInputTokens(row))
            },
            {
              key: 'output_tokens',
              label: t('analytics.outputTokens'),
              render: (row) => renderTokenValue(row.output_tokens)
            },
            {
              key: 'cache_creation_tokens',
              label: t('analytics.cacheCreationTokens'),
              render: (row) => renderTokenValue(row.cache_creation_tokens)
            },
            {
              key: 'cache_read_tokens',
              label: t('analytics.cacheReadTokens'),
              render: (row) => renderTokenValue(row.cache_read_tokens)
            },
            {
              key: 'total_cost_usd',
              label: t('analytics.costUsd'),
              render: (row) => `$${fmtMoney(row.total_cost_usd)}`
            },
            {
              key: 'avg_ttft_ms',
              label: t('analytics.avgTtft'),
              render: (row) => fmtMs(row.avg_ttft_ms)
            },
            {
              key: 'avg_total_ms',
              label: t('analytics.avgTotal'),
              render: (row) => fmtMs(row.avg_total_ms)
            }
          ])}

          {renderSimpleTable(t('analytics.models'), models, [
            { key: 'model_name', label: t('analytics.model') },
            { key: 'provider_name', label: t('analytics.provider') },
            { key: 'request_count', label: t('analytics.requests') },
            {
              key: 'input_tokens',
              label: inputTokenLabel,
              render: (row) => renderTokenValue(getEffectiveInputTokens(row))
            },
            {
              key: 'output_tokens',
              label: t('analytics.outputTokens'),
              render: (row) => renderTokenValue(row.output_tokens)
            },
            {
              key: 'cache_creation_tokens',
              label: t('analytics.cacheCreationTokens'),
              render: (row) => renderTokenValue(row.cache_creation_tokens)
            },
            {
              key: 'cache_read_tokens',
              label: t('analytics.cacheReadTokens'),
              render: (row) => renderTokenValue(row.cache_read_tokens)
            },
            {
              key: 'total_cost_usd',
              label: t('analytics.costUsd'),
              render: (row) => `$${fmtMoney(row.total_cost_usd)}`
            }
          ])}

          {renderSimpleTable(t('analytics.providers'), providers, [
            { key: 'provider_name', label: t('analytics.provider') },
            { key: 'request_count', label: t('analytics.requests') },
            {
              key: 'input_tokens',
              label: inputTokenLabel,
              render: (row) => renderTokenValue(getEffectiveInputTokens(row))
            },
            {
              key: 'output_tokens',
              label: t('analytics.outputTokens'),
              render: (row) => renderTokenValue(row.output_tokens)
            },
            {
              key: 'cache_creation_tokens',
              label: t('analytics.cacheCreationTokens'),
              render: (row) => renderTokenValue(row.cache_creation_tokens)
            },
            {
              key: 'cache_read_tokens',
              label: t('analytics.cacheReadTokens'),
              render: (row) => renderTokenValue(row.cache_read_tokens)
            },
            {
              key: 'total_cost_usd',
              label: t('analytics.costUsd'),
              render: (row) => `$${fmtMoney(row.total_cost_usd)}`
            }
          ])}

          {renderSimpleTable(t('analytics.details'), details, [
            {
              key: 'created_at',
              label: t('analytics.time'),
              render: (row) => new Date(Number(row.created_at ?? 0)).toLocaleString()
            },
            { key: 'provider_name', label: t('analytics.provider') },
            { key: 'model_name', label: t('analytics.model') },
            {
              key: 'source_kind',
              label: t('analytics.source'),
              render: (row) => <Badge variant="secondary">{String(row.source_kind ?? '-')}</Badge>
            },
            {
              key: 'input_tokens',
              label: inputTokenLabel,
              render: (row) => renderTokenValue(getEffectiveInputTokens(row))
            },
            {
              key: 'output_tokens',
              label: t('analytics.outputTokens'),
              render: (row) => renderTokenValue(row.output_tokens)
            },
            {
              key: 'cache_creation_tokens',
              label: t('analytics.cacheCreationTokens'),
              render: (row) => renderTokenValue(row.cache_creation_tokens)
            },
            {
              key: 'cache_read_tokens',
              label: t('analytics.cacheReadTokens'),
              render: (row) => renderTokenValue(row.cache_read_tokens)
            },
            { key: 'ttft_ms', label: t('analytics.ttft'), render: (row) => fmtMs(row.ttft_ms) },
            {
              key: 'total_ms',
              label: t('analytics.totalMs'),
              render: (row) => fmtMs(row.total_ms)
            },
            {
              key: 'total_cost_usd',
              label: t('analytics.costUsd'),
              render: (row) => `$${fmtMoney(row.total_cost_usd)}`
            }
          ])}
        </>
      )}
    </div>
  )
}

function ModelPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const providers = useProviderStore((s) => s.providers)
  const mainModelSelectionMode = settings.mainModelSelectionMode
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const activeFastModelId = useProviderStore((s) => s.activeFastModelId)
  const activeFastProviderId = useProviderStore((s) => s.activeFastProviderId)
  const activeTranslationProviderId = useProviderStore((s) => s.activeTranslationProviderId)
  const activeTranslationModelId = useProviderStore((s) => s.activeTranslationModelId)
  const activeSpeechProviderId = useProviderStore((s) => s.activeSpeechProviderId)
  const activeSpeechModelId = useProviderStore((s) => s.activeSpeechModelId)
  const activeImageProviderId = useProviderStore((s) => s.activeImageProviderId)
  const activeImageModelId = useProviderStore((s) => s.activeImageModelId)
  const setActiveProvider = useProviderStore((s) => s.setActiveProvider)
  const setActiveModel = useProviderStore((s) => s.setActiveModel)
  const setActiveFastModel = useProviderStore((s) => s.setActiveFastModel)
  const setActiveFastProvider = useProviderStore((s) => s.setActiveFastProvider)
  const setActiveTranslationProvider = useProviderStore((s) => s.setActiveTranslationProvider)
  const setActiveTranslationModel = useProviderStore((s) => s.setActiveTranslationModel)
  const setActiveSpeechProvider = useProviderStore((s) => s.setActiveSpeechProvider)
  const setActiveSpeechModel = useProviderStore((s) => s.setActiveSpeechModel)
  const setActiveImageProvider = useProviderStore((s) => s.setActiveImageProvider)
  const setActiveImageModel = useProviderStore((s) => s.setActiveImageModel)

  const enabledProviders = providers.filter((p) => p.enabled)
  const chatProviderGroups = enabledProviders
    .map((provider) => ({
      provider,
      models: provider.models.filter(
        (model) => model.enabled && (!model.category || model.category === 'chat')
      )
    }))
    .filter((group) => group.models.length > 0)
  const imageProviderGroups = enabledProviders
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => model.enabled && model.category === 'image')
    }))
    .filter((group) => group.models.length > 0)

  const activeProvider =
    chatProviderGroups.find(({ provider }) => provider.id === activeProviderId)?.provider ?? null
  const fastProvider =
    chatProviderGroups.find(
      ({ provider }) => provider.id === (activeFastProviderId ?? activeProviderId)
    )?.provider ?? activeProvider
  const fastProviderEnabledModels =
    fastProvider?.models.filter((m) => m.enabled && (!m.category || m.category === 'chat')) ?? []

  const hasAnyEnabledModel = chatProviderGroups.length > 0
  const hasImageModels = imageProviderGroups.length > 0
  const buildModelValue = (providerId: string, modelId: string): string =>
    `${providerId}::${modelId}`
  const parseModelValue = (value: string): { providerId: string; modelId: string } | null => {
    const [providerId, modelId] = value.split('::')
    if (!providerId || !modelId) return null
    return { providerId, modelId }
  }
  const recommendationModeDefs: Array<{
    mode: keyof typeof settings.promptRecommendationModels
    labelKey: string
    descKey: string
  }> = [
    {
      mode: 'clarify',
      labelKey: 'model.promptRecommendationModes.clarify',
      descKey: 'model.promptRecommendationModesDesc.clarify'
    },
    {
      mode: 'cowork',
      labelKey: 'model.promptRecommendationModes.cowork',
      descKey: 'model.promptRecommendationModesDesc.cowork'
    },
    {
      mode: 'code',
      labelKey: 'model.promptRecommendationModes.code',
      descKey: 'model.promptRecommendationModesDesc.code'
    }
  ]
  const updatePromptRecommendationModel = (
    mode: keyof typeof settings.promptRecommendationModels,
    value: string
  ): void => {
    settings.updateSettings({
      promptRecommendationModels: {
        ...settings.promptRecommendationModels,
        [mode]:
          value === '__fast__'
            ? null
            : value === '__disabled__'
              ? 'disabled'
              : parseModelValue(value)
      }
    })
  }

  const activeModelValue =
    activeProvider && activeModelId ? buildModelValue(activeProvider.id, activeModelId) : ''
  const newSessionDefaultModelValue = settings.newSessionDefaultModel
    ? settings.newSessionDefaultModel.useGlobalActiveModel
      ? '__global__'
      : buildModelValue(
          settings.newSessionDefaultModel.providerId,
          settings.newSessionDefaultModel.modelId
        )
    : '__global__'
  const translationProvider =
    chatProviderGroups.find(
      ({ provider }) => provider.id === (activeTranslationProviderId ?? activeProviderId)
    )?.provider ?? activeProvider
  const translationProviderEnabledModels =
    translationProvider?.models.filter(
      (m) => m.enabled && (!m.category || m.category === 'chat')
    ) ?? []
  const speechProvider = providers.find((p) => p.id === activeSpeechProviderId)
  const activeSpeechModelValue =
    speechProvider && activeSpeechModelId
      ? buildModelValue(speechProvider.id, activeSpeechModelId)
      : ''
  const imageProvider = providers.find((p) => p.id === activeImageProviderId)
  const activeImageModelValue =
    imageProvider && activeImageModelId ? buildModelValue(imageProvider.id, activeImageModelId) : ''

  const speechProviderGroups = chatProviderGroups
    .filter(
      ({ provider }) => provider.type === 'openai-chat' || provider.type === 'openai-responses'
    )
    .map(({ provider, models }) => ({
      provider,
      models: models.filter((m) => m.category === 'speech')
    }))
    .filter(({ models }) => models.length > 0)
  const hasSpeechModels = speechProviderGroups.length > 0

  const noProviders = enabledProviders.length === 0

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">{t('model.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('model.subtitle')}</p>
      </div>

      {noProviders ? (
        <div className="rounded-lg border border-dashed p-6 text-center space-y-2">
          <p className="text-sm text-muted-foreground">{t('model.noProviders')}</p>
          <p className="text-xs text-muted-foreground/60">{t('model.noProvidersHint')}</p>
        </div>
      ) : (
        <>
          {/* New Session Default Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">新建会话默认模型</label>
              <p className="text-xs text-muted-foreground">
                控制新建会话默认绑定的模型；选择跟随当前活动模型时，会沿用顶部当前选择。
              </p>
            </div>
            {hasAnyEnabledModel ? (
              <Select
                value={newSessionDefaultModelValue}
                onValueChange={(value) => {
                  if (value === '__global__') {
                    settings.updateSettings({
                      newSessionDefaultModel: {
                        providerId: activeProviderId ?? '',
                        modelId: activeModelId ?? '',
                        useGlobalActiveModel: true
                      }
                    })
                    return
                  }
                  const parsed = parseModelValue(value)
                  if (!parsed) return
                  settings.updateSettings({
                    newSessionDefaultModel: {
                      providerId: parsed.providerId,
                      modelId: parsed.modelId,
                      useGlobalActiveModel: false
                    }
                  })
                }}
              >
                <SelectTrigger className="w-80 text-xs">
                  <SelectValue placeholder="选择默认模型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__global__" className="text-xs">
                    跟随当前活动模型
                  </SelectItem>
                  {chatProviderGroups.map(({ provider, models }) => (
                    <SelectGroup key={`${provider.id}-new-session-default`}>
                      <SelectLabel className="text-[10px] uppercase tracking-wide">
                        {provider.name}
                      </SelectLabel>
                      {models.map((m) => (
                        <SelectItem
                          key={`${provider.id}-new-session-${m.id}`}
                          value={buildModelValue(provider.id, m.id)}
                          className="text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={provider.builtinId}
                              size={16}
                              className="text-muted-foreground/70"
                            />
                            <div className="flex flex-col text-left">
                              <span>{m.name}</span>
                              <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
            )}
          </section>

          {/* Main Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.mainModel')}</label>
              <p className="text-xs text-muted-foreground">{t('model.mainModelDesc')}</p>
            </div>
            {hasAnyEnabledModel ? (
              <div className="space-y-2">
                <Select
                  value={mainModelSelectionMode}
                  onValueChange={(value) =>
                    settings.updateSettings({
                      mainModelSelectionMode: value === 'manual' ? 'manual' : 'auto'
                    })
                  }
                >
                  <SelectTrigger className="w-80 text-xs">
                    <SelectValue placeholder={t('model.selectMainModelMode')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-xs">
                      {t('model.autoMode')}
                    </SelectItem>
                    <SelectItem value="manual" className="text-xs">
                      {t('model.manualMode')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground/80">
                  {mainModelSelectionMode === 'auto'
                    ? t('model.autoModeDesc')
                    : t('model.manualModeDesc')}
                </p>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {mainModelSelectionMode === 'auto'
                      ? t('model.autoMainCandidate')
                      : t('model.manualMainCandidate')}
                  </label>
                  <p className="mt-1 text-xs text-muted-foreground/70">
                    {t('model.manualMainCandidateDesc')}
                  </p>
                </div>
                <Select
                  value={activeModelValue}
                  onValueChange={(value) => {
                    const parsed = parseModelValue(value)
                    if (!parsed) return
                    if (parsed.providerId !== activeProviderId) {
                      setActiveProvider(parsed.providerId)
                    }
                    setActiveModel(parsed.modelId)
                  }}
                >
                  <SelectTrigger className="w-80 text-xs">
                    <SelectValue placeholder={t('model.selectModel')} />
                  </SelectTrigger>
                  <SelectContent>
                    {chatProviderGroups.map(({ provider, models }) => (
                      <SelectGroup key={provider.id}>
                        <SelectLabel className="text-[10px] uppercase tracking-wide">
                          {provider.name}
                        </SelectLabel>
                        {models.map((m) => (
                          <SelectItem
                            key={`${provider.id}-${m.id}`}
                            value={buildModelValue(provider.id, m.id)}
                            className="text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <ModelIcon
                                icon={m.icon}
                                modelId={m.id}
                                providerBuiltinId={provider.builtinId}
                                size={16}
                                className="text-muted-foreground/70"
                              />
                              <div className="flex flex-col text-left">
                                <span>{m.name}</span>
                                <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
            )}
          </section>

          {/* Fast Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.fastModel')}</label>
              <p className="text-xs text-muted-foreground">{t('model.fastModelDesc')}</p>
            </div>
            {chatProviderGroups.length > 0 ? (
              <div className="space-y-2">
                <Select
                  value={fastProvider?.id ?? ''}
                  onValueChange={(value) => setActiveFastProvider(value)}
                >
                  <SelectTrigger className="w-80 text-xs">
                    <SelectValue placeholder={t('model.selectProvider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {chatProviderGroups.map(({ provider }) => (
                      <SelectItem key={provider.id} value={provider.id} className="text-xs">
                        <span className="flex items-center gap-2">
                          <ProviderIcon builtinId={provider.builtinId} size={14} />
                          {provider.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {fastProviderEnabledModels.length > 0 ? (
                  <Select
                    value={activeFastModelId || fastProviderEnabledModels[0]?.id || ''}
                    onValueChange={(v) => setActiveFastModel(v)}
                  >
                    <SelectTrigger className="w-80 text-xs">
                      <SelectValue placeholder={t('model.selectFastModel')} />
                    </SelectTrigger>
                    <SelectContent>
                      {fastProviderEnabledModels.map((m) => (
                        <SelectItem key={m.id} value={m.id} className="text-xs">
                          <div className="flex items-center gap-2">
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={fastProvider?.builtinId}
                              size={16}
                              className="text-muted-foreground/70"
                            />
                            <div className="flex flex-col">
                              <span>{m.name}</span>
                              <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
            )}
          </section>

          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.promptRecommendationTitle')}</label>
              <p className="text-xs text-muted-foreground">{t('model.promptRecommendationDesc')}</p>
            </div>
            {chatProviderGroups.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2">
                {recommendationModeDefs.map(({ mode, labelKey, descKey }) => {
                  const binding = settings.promptRecommendationModels[mode]
                  const value =
                    binding === 'disabled'
                      ? '__disabled__'
                      : binding
                        ? buildModelValue(binding.providerId, binding.modelId)
                        : '__fast__'
                  return (
                    <div key={mode} className="rounded-lg border p-3 space-y-2">
                      <div>
                        <p className="text-sm font-medium">{t(labelKey)}</p>
                        <p className="text-xs text-muted-foreground">{t(descKey)}</p>
                      </div>
                      <Select
                        value={value}
                        onValueChange={(nextValue) =>
                          updatePromptRecommendationModel(mode, nextValue)
                        }
                      >
                        <SelectTrigger className="w-full text-xs">
                          <SelectValue placeholder={t('model.selectRecommendationModel')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__fast__" className="text-xs">
                            {t('model.useFastModelRecommendation')}
                          </SelectItem>
                          <SelectItem value="__disabled__" className="text-xs">
                            {t('model.disableRecommendation')}
                          </SelectItem>
                          {chatProviderGroups.map(({ provider, models }) => (
                            <SelectGroup key={`${provider.id}-recommendation-${mode}`}>
                              <SelectLabel className="text-[10px] uppercase tracking-wide">
                                {provider.name}
                              </SelectLabel>
                              {models.map((m) => (
                                <SelectItem
                                  key={`${provider.id}-${mode}-${m.id}`}
                                  value={buildModelValue(provider.id, m.id)}
                                  className="text-xs"
                                >
                                  <div className="flex items-center gap-2">
                                    <ModelIcon
                                      icon={m.icon}
                                      modelId={m.id}
                                      providerBuiltinId={provider.builtinId}
                                      size={16}
                                      className="text-muted-foreground/70"
                                    />
                                    <div className="flex flex-col text-left">
                                      <span>{m.name}</span>
                                      <span className="text-[10px] text-muted-foreground/60">
                                        {m.id}
                                      </span>
                                    </div>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
            )}
          </section>

          {/* Translation Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.translationModel')}</label>
              <p className="text-xs text-muted-foreground">{t('model.translationModelDesc')}</p>
            </div>
            {chatProviderGroups.length > 0 ? (
              <div className="space-y-2">
                <Select
                  value={translationProvider?.id ?? ''}
                  onValueChange={(value) => setActiveTranslationProvider(value)}
                >
                  <SelectTrigger className="w-80 text-xs">
                    <SelectValue placeholder={t('model.selectProvider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {chatProviderGroups.map(({ provider }) => (
                      <SelectItem
                        key={`${provider.id}-translation-provider`}
                        value={provider.id}
                        className="text-xs"
                      >
                        <span className="flex items-center gap-2">
                          <ProviderIcon builtinId={provider.builtinId} size={14} />
                          {provider.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {translationProviderEnabledModels.length > 0 ? (
                  <Select
                    value={
                      activeTranslationModelId || translationProviderEnabledModels[0]?.id || ''
                    }
                    onValueChange={(value) => setActiveTranslationModel(value)}
                  >
                    <SelectTrigger className="w-80 text-xs">
                      <SelectValue placeholder={t('model.selectTranslationModel')} />
                    </SelectTrigger>
                    <SelectContent>
                      {translationProviderEnabledModels.map((m) => (
                        <SelectItem
                          key={`translation-model-${m.id}`}
                          value={m.id}
                          className="text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={translationProvider?.builtinId}
                              size={16}
                              className="text-muted-foreground/70"
                            />
                            <div className="flex flex-col text-left">
                              <span>{m.name}</span>
                              <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">{t('model.noModelsHint')}</p>
            )}
          </section>

          {/* Image Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.imageModel')}</label>
              <p className="text-xs text-muted-foreground">{t('model.imageModelDesc')}</p>
            </div>
            {hasImageModels ? (
              <Select
                value={activeImageModelValue}
                onValueChange={(value) => {
                  const parsed = parseModelValue(value)
                  if (!parsed) return
                  setActiveImageProvider(parsed.providerId)
                  setActiveImageModel(parsed.modelId)
                }}
              >
                <SelectTrigger className="w-80 text-xs">
                  <SelectValue placeholder={t('model.selectImageModel')} />
                </SelectTrigger>
                <SelectContent>
                  {imageProviderGroups.map(({ provider, models }) => (
                    <SelectGroup key={`${provider.id}-image`}>
                      <SelectLabel className="text-[10px] uppercase tracking-wide">
                        {provider.name}
                      </SelectLabel>
                      {models.map((m) => (
                        <SelectItem
                          key={`${provider.id}-image-${m.id}`}
                          value={buildModelValue(provider.id, m.id)}
                          className="text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={provider.builtinId}
                              size={16}
                              className="text-muted-foreground/70"
                            />
                            <div className="flex flex-col text-left">
                              <span>{m.name}</span>
                              <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground/60">{t('model.noImageModels')}</p>
            )}
          </section>

          {/* Speech Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.speechModel')}</label>
              <p className="text-xs text-muted-foreground">{t('model.speechModelDesc')}</p>
            </div>
            {hasSpeechModels ? (
              <Select
                value={activeSpeechModelValue}
                onValueChange={(value) => {
                  const parsed = parseModelValue(value)
                  if (!parsed) return
                  setActiveSpeechProvider(parsed.providerId)
                  setActiveSpeechModel(parsed.modelId)
                }}
              >
                <SelectTrigger className="w-80 text-xs">
                  <SelectValue placeholder={t('model.selectSpeechModel')} />
                </SelectTrigger>
                <SelectContent>
                  {speechProviderGroups.map(({ provider, models }) => (
                    <SelectGroup key={`${provider.id}-speech`}>
                      <SelectLabel className="text-[10px] uppercase tracking-wide">
                        {provider.name}
                      </SelectLabel>
                      {models.map((m) => (
                        <SelectItem
                          key={`${provider.id}-speech-${m.id}`}
                          value={buildModelValue(provider.id, m.id)}
                          className="text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={provider.builtinId}
                              size={16}
                              className="text-muted-foreground/70"
                            />
                            <div className="flex flex-col text-left">
                              <span>{m.name}</span>
                              <span className="text-[10px] text-muted-foreground/60">{m.id}</span>
                            </div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground/60">
                {t('model.speechModelNoProviders')}
              </p>
            )}
          </section>
        </>
      )}

      <Separator />

      {/* Temperature */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('model.temperature')}</label>
            <p className="text-xs text-muted-foreground">{t('model.temperatureDesc')}</p>
          </div>
          <span className="text-sm font-mono text-muted-foreground">{settings.temperature}</span>
        </div>
        <Slider
          value={[settings.temperature]}
          onValueChange={([v]) => settings.updateSettings({ temperature: v })}
          min={0}
          max={1}
          step={0.1}
          className="max-w-lg"
        />
        <div className="flex items-center justify-between max-w-lg">
          {[
            { v: 0, label: t('model.precise') },
            { v: 0.3, label: t('model.balanced') },
            { v: 0.7, label: t('model.creative') },
            { v: 1, label: t('model.random') }
          ].map(({ v, label }) => (
            <button
              key={v}
              onClick={() => settings.updateSettings({ temperature: v })}
              className={`text-[10px] transition-colors ${settings.temperature === v ? 'text-foreground font-medium' : 'text-muted-foreground/50 hover:text-muted-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* Max Tokens */}
      <section className="space-y-3">
        <div>
          <label className="text-sm font-medium">{t('model.maxTokens')}</label>
          <p className="text-xs text-muted-foreground">{t('model.maxTokensDesc')}</p>
        </div>
        <Input
          type="number"
          value={settings.maxTokens}
          onChange={(e) =>
            settings.updateSettings({ maxTokens: parseInt(e.target.value) || 32000 })
          }
          className="max-w-60"
        />
        <div className="flex items-center gap-1">
          {[8192, 16384, 32000, 64000, 128000].map((v) => (
            <button
              key={v}
              onClick={() => settings.updateSettings({ maxTokens: v })}
              className={`rounded px-2 py-0.5 text-[10px] transition-colors ${settings.maxTokens === v ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
            >
              {v >= 1000 ? `${Math.round(v / 1024)}K` : v}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function AboutPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const appVersion = packageJson.version ?? '0.0.0'
  const meta = [
    { label: t('about.version'), value: appVersion },
    { label: t('about.framework'), value: 'Electron · React · TypeScript' },
    { label: t('about.ui'), value: 'shadcn/ui · TailwindCSS' },
    { label: t('about.license'), value: 'Apache 2.0' }
  ]
  const featureCards = [
    {
      icon: Sparkles,
      title: t('about.featureCards.orchestration.title'),
      desc: t('about.featureCards.orchestration.desc')
    },
    {
      icon: ShieldCheck,
      title: t('about.featureCards.sandbox.title'),
      desc: t('about.featureCards.sandbox.desc')
    },
    {
      icon: Layers,
      title: t('about.featureCards.channels.title'),
      desc: t('about.featureCards.channels.desc')
    }
  ]
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">{t('about.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('about.subtitle')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() =>
            window.open('https://github.com/AIDotNet/OpenCowork', '_blank', 'noopener')
          }
        >
          <Github className="size-3.5" /> GitHub
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-br from-muted/60 via-background to-muted/40 p-6 shadow-inner">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="relative">
              <div className="size-16 rounded-2xl bg-gradient-to-br from-primary/40 via-primary/60 to-primary p-[2px] shadow-lg shadow-primary/30">
                <div className="flex h-full w-full items-center justify-center rounded-2xl bg-background text-lg font-semibold tracking-wide text-foreground">
                  OC
                </div>
              </div>
              <div
                className="absolute -inset-1 rounded-3xl bg-primary/10 blur-2xl"
                aria-hidden="true"
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                {t('about.heroTagline')}
              </p>
              <h3 className="text-2xl font-semibold text-foreground">OpenCowork</h3>
              <p className="text-sm text-muted-foreground">{t('about.heroDescription')}</p>
            </div>
          </div>
          <Separator className="my-6 border-border/40" />
          <div className="grid gap-4 sm:grid-cols-2">
            {meta.map((item) => (
              <div
                key={item.label}
                className="rounded-2xl border border-border/50 bg-card px-4 py-3 text-sm"
              >
                <p className="text-xs uppercase text-muted-foreground/70">{item.label}</p>
                <p className="mt-1 font-medium text-foreground">{item.value}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-border/70 bg-card/60 p-5 shadow-lg shadow-slate-900/5">
          <p className="text-xs uppercase tracking-[0.3em] text-primary">
            {t('about.workflowLabel')}
          </p>
          <h4 className="mt-2 text-lg font-semibold">{t('about.workflowTitle')}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t('about.workflowDescription')}</p>
          <div className="mt-4 space-y-3">
            {featureCards.map((card) => (
              <div
                key={card.title}
                className="flex gap-3 rounded-2xl border border-border/80 bg-background/70 px-3 py-2"
              >
                <card.icon className="mt-0.5 size-4 text-primary" />
                <div>
                  <p className="text-sm font-medium">{card.title}</p>
                  <p className="text-xs text-muted-foreground">{card.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <Button
            className="mt-4 h-9 w-full text-xs"
            variant="secondary"
            onClick={() =>
              window.open('https://github.com/AIDotNet/OpenCowork/releases', '_blank', 'noopener')
            }
          >
            {t('about.workflowCta')}
          </Button>
        </section>

        <section className="rounded-3xl border border-dashed border-border/60 bg-muted/20 p-5 lg:col-span-2">
          <p className="text-sm text-muted-foreground">{t('about.summary')}</p>
        </section>
      </div>
    </div>
  )
}

const panelMap: Record<SettingsTab, () => React.JSX.Element> = {
  general: GeneralPanel,
  memory: MemoryPanel,
  analytics: AnalyticsPanel,
  provider: ProviderPanel,
  plugin: AppPluginPanel,
  channel: ChannelPanel,
  mcp: McpPanel,
  model: ModelPanel,
  websearch: WebSearchPanel,
  skillsmarket: SkillsMarketPanel,
  about: AboutPanel
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settingsTab = useUIStore((s) => s.settingsTab)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)

  const effectiveSettingsTab = settingsTab === 'channel' ? 'general' : settingsTab
  const ActivePanel = panelMap[effectiveSettingsTab]

  return (
    <div className="flex h-screen w-full bg-background">
      {/* Left Sidebar - LobeHub Style */}
      <div className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
        {/* Titlebar drag area */}
        <div className="titlebar-drag h-10 w-full shrink-0" />

        {/* Header */}
        <div className="px-5 pb-5">
          <h1 className="text-xl font-bold">{t('page.title')}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{t('page.subtitle')}</p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-4 px-3 overflow-y-auto">
          {menuGroupDefs.map((group) => (
            <div key={group.labelKey} className="space-y-1">
              <p className="px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                {t(group.labelKey)}
              </p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSettingsTab(item.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-all duration-150 ${
                    effectiveSettingsTab === item.id
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`}
                >
                  <span
                    className={`flex items-center justify-center size-5 ${
                      effectiveSettingsTab === item.id
                        ? 'text-accent-foreground'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {item.icon}
                  </span>
                  <span>{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 text-[11px] text-muted-foreground/50">{t('page.poweredBy')}</div>
      </div>

      {/* Right Content */}
      <div className="relative flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden px-6 py-4">
        {!leftSidebarOpen && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-6 top-4 z-20 size-8 rounded-lg border border-border/60 bg-background/80 backdrop-blur-sm"
            onClick={toggleLeftSidebar}
            title={t('page.title')}
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        )}

        {/* Content */}
        <AnimatePresence mode="wait">
          {effectiveSettingsTab === 'provider' ||
          effectiveSettingsTab === 'plugin' ||
          effectiveSettingsTab === 'mcp' ? (
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden pb-4" key="full-panel">
              <SlideIn
                key={effectiveSettingsTab}
                direction="right"
                duration={0.25}
                className="h-full min-h-0"
              >
                <ActivePanel />
              </SlideIn>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto" key="scroll-panel">
              <div className="mx-auto max-w-2xl px-8 pb-16 pt-10">
                <FadeIn key={effectiveSettingsTab} duration={0.25}>
                  <ActivePanel />
                </FadeIn>
              </div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
