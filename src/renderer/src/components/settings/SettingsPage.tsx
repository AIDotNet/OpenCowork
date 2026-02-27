import { useEffect, useMemo, useState, useCallback } from 'react'
import { Settings, BrainCircuit, Info, Server, Puzzle, Cable, Loader2, Download, Github, Sparkles, ShieldCheck, Layers, HardDriveDownload, HardDriveUpload, Trash2, Globe, Wand2, BookOpen, Save, RefreshCw } from 'lucide-react'
import { useTheme } from 'next-themes'
import { AnimatePresence } from 'motion/react'
import { useUIStore, type SettingsTab } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { formatTokens } from '@renderer/lib/format-tokens'
import { useDebouncedTokens } from '@renderer/hooks/use-estimated-tokens'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
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
import { PluginPanel } from './PluginPanel'
import { McpPanel } from './McpPanel'
import { WebSearchPanel } from './WebSearchPanel'
import { SkillsMarketPanel } from './SkillsMarketPanel'
import { ModelIcon } from './provider-icons'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { readTextFile, resolveGlobalMemoryPath } from '@renderer/lib/agent/memory-files'
import packageJson from '../../../../../package.json'

const GITHUB_RELEASE_API_URL = 'https://api.github.com/repos/AIDotNet/OpenCowork/releases/latest'

interface GithubAsset {
  id: number
  name: string
  browser_download_url: string
  size: number
}

interface GithubReleaseResponse {
  tag_name?: string
  name?: string
  html_url?: string
  assets?: GithubAsset[]
}

interface DownloadAsset {
  id: string
  label: string
  url: string
  sizeLabel: string
}

const releaseAssetMatchers: {
  id: string
  label: string
  test: (name: string) => boolean
}[] = [
  {
    id: 'win-exe',
    label: 'Windows Installer (.exe)',
    test: (name) => name.endsWith('-setup.exe') && !name.endsWith('.blockmap'),
  },
  {
    id: 'win-blockmap',
    label: 'Windows Blockmap',
    test: (name) => name.endsWith('-setup.exe.blockmap'),
  },
  {
    id: 'linux-appimage',
    label: 'Linux AppImage',
    test: (name) => name.toLowerCase().endsWith('.appimage'),
  },
  {
    id: 'linux-deb',
    label: 'Linux .deb (amd64)',
    test: (name) => name.toLowerCase().endsWith('_amd64.deb'),
  },
]

const DEFAULT_GLOBAL_MEMORY_TEMPLATE = `# MEMORY.md

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
`

function isMissingFileError(error: string): boolean {
  return error.includes('ENOENT')
}

function getIpcError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const error = (result as { error?: unknown }).error
  return typeof error === 'string' && error.trim() ? error : null
}

function formatBytes(bytes?: number): string {
  if (!bytes || Number.isNaN(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

function compareVersions(a?: string, b?: string): number {
  if (!a || !b) return 0
  const aParts = a.split('.').map((part) => parseInt(part, 10) || 0)
  const bParts = b.split('.').map((part) => parseInt(part, 10) || 0)
  const len = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

const menuItemDefs: { id: SettingsTab; icon: React.ReactNode; labelKey: string; descKey: string }[] = [
  { id: 'general', icon: <Settings className="size-4" />, labelKey: 'general.title', descKey: 'general.subtitle' },
  { id: 'memory', icon: <BookOpen className="size-4" />, labelKey: 'memory.title', descKey: 'memory.subtitle' },
  { id: 'provider', icon: <Server className="size-4" />, labelKey: 'provider.title', descKey: 'provider.subtitle' },
  { id: 'plugin', icon: <Puzzle className="size-4" />, labelKey: 'plugin.title', descKey: 'plugin.subtitle' },
  { id: 'mcp', icon: <Cable className="size-4" />, labelKey: 'mcp.title', descKey: 'mcp.subtitle' },
  { id: 'model', icon: <BrainCircuit className="size-4" />, labelKey: 'model.title', descKey: 'model.subtitle' },
  { id: 'websearch', icon: <Globe className="size-4" />, labelKey: 'websearch.title', descKey: 'websearch.subtitle' },
  { id: 'skillsmarket', icon: <Wand2 className="size-4" />, labelKey: 'skillsmarket.title', descKey: 'skillsmarket.subtitle' },
  { id: 'about', icon: <Info className="size-4" />, labelKey: 'about.title', descKey: 'about.subtitle' },
]

// ─── General Settings Panel ───

function GeneralPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const { setTheme } = useTheme()
  const promptTokens = useDebouncedTokens(settings.systemPrompt)
  const currentVersion = packageJson.version ?? '0.0.0'
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [latestAssets, setLatestAssets] = useState<DownloadAsset[]>([])
  const [releaseUrl, setReleaseUrl] = useState<string | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const sessions = useChatStore((s) => s.sessions)
  const clearAllSessions = useChatStore((s) => s.clearAllSessions)

  const fetchLatestVersion = useCallback(async () => {
    setCheckingUpdate(true)
    setUpdateError(null)
    try {
      const res = await fetch(GITHUB_RELEASE_API_URL, {
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
        },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as GithubReleaseResponse
      const tag = data.tag_name ?? data.name ?? null
      const normalized = tag?.startsWith('v') ? tag.slice(1) : tag
      setLatestVersion(normalized ?? null)
      setReleaseUrl(data.html_url ?? (tag ? `https://github.com/AIDotNet/OpenCowork/releases/tag/${tag}` : null))

      const assets = (data.assets ?? [])
        .map((asset) => {
          const matcher = releaseAssetMatchers.find((m) => m.test(asset.name))
          if (!matcher) return null
          return {
            id: matcher.id,
            label: matcher.label,
            url: asset.browser_download_url,
            sizeLabel: formatBytes(asset.size),
          } satisfies DownloadAsset
        })
        .filter((asset): asset is DownloadAsset => Boolean(asset))
      setLatestAssets(assets)
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err))
      setLatestAssets([])
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  useEffect(() => {
    void fetchLatestVersion()
  }, [fetchLatestVersion])

  const updateAvailable = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false
  const recommendedPackageId = useMemo(() => {
    if (typeof navigator === 'undefined') return 'win-exe'
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('linux')) {
      if (ua.includes('ubuntu') || ua.includes('debian')) return 'linux-deb'
      return 'linux-appimage'
    }
    return 'win-exe'
  }, [])

  const downloadOptions = latestAssets

  const handleDownload = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener')
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
        toast.error(t('general.data.importFailed', { error: err instanceof Error ? err.message : String(err) }))
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
    const ok = await confirm({ title: t('general.data.clearConfirm', { count: total }), variant: 'destructive' })
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
            {latestVersion && (
              <>
                {' '}
                · Latest v{latestVersion}
              </>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void fetchLatestVersion()} disabled={checkingUpdate}>
            {checkingUpdate && <Loader2 className="mr-1 size-3 animate-spin" />}
            {checkingUpdate ? 'Checking…' : 'Check for updates'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={!releaseUrl}
            onClick={() => releaseUrl && window.open(releaseUrl, '_blank', 'noopener')}
          >
            View release
          </Button>
        </div>
        {updateError && <p className="text-xs text-destructive">Failed to check GitHub: {updateError}</p>}
        {!updateError && !updateAvailable && latestVersion && !checkingUpdate && (
          <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">You are up to date.</p>
        )}
        {updateAvailable && (
          <div className="space-y-3">
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
              A newer version (v{latestVersion}) is available. Choose a package to download.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {downloadOptions.map((pkg) => (
                <div
                  key={pkg.id}
                  className={`rounded-lg border p-3 text-xs ${pkg.id === recommendedPackageId ? 'border-primary bg-primary/5' : 'border-border/60 bg-background/30'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{pkg.label}</p>
                      <p className="text-[11px] text-muted-foreground">{pkg.sizeLabel}</p>
                    </div>
                    {pkg.id === recommendedPackageId && (
                      <span className="text-[10px] font-semibold uppercase text-primary">Recommended</span>
                    )}
                  </div>
                  <Button size="sm" className="mt-3 h-7 w-full text-xs" onClick={() => handleDownload(pkg.url)}>
                    <Download className="mr-1.5 size-3.5" /> Download v{latestVersion}
                  </Button>
                </div>
              ))}
            </div>
          </div>
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

      {/* System Prompt */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium">{t('general.systemPrompt')}</label>
            <p className="text-xs text-muted-foreground">{t('general.systemPromptDesc')}</p>
          </div>
          {settings.systemPrompt && (
            <span className="text-[10px] text-muted-foreground/50 tabular-nums">
              {promptTokens > 0 ? `~${formatTokens(promptTokens)} tokens` : ''}
            </span>
          )}
        </div>
        <Textarea
          placeholder={t('general.systemPromptPlaceholder')}
          value={settings.systemPrompt}
          onChange={(e) => settings.updateSettings({ systemPrompt: e.target.value })}
          rows={4}
          className="max-w-lg"
        />
      </section>

      <Separator />

      {/* Team Tools */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.teamTools')}</label>
            <p className="text-xs text-muted-foreground">
              {t('general.teamToolsDesc')}
            </p>
          </div>
          <Switch
            checked={settings.teamToolsEnabled}
            onCheckedChange={(checked) => settings.updateSettings({ teamToolsEnabled: checked })}
          />
        </div>
        {settings.teamToolsEnabled && (
          <p className="text-xs text-muted-foreground/70">
            {t('general.teamToolsEnabled')}
          </p>
        )}
      </section>

      <Separator />

      {/* Context Compression */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('general.contextCompression')}</label>
            <p className="text-xs text-muted-foreground">
              {t('general.contextCompressionDesc')}
            </p>
          </div>
          <Switch
            checked={settings.contextCompressionEnabled}
            onCheckedChange={(checked) => settings.updateSettings({ contextCompressionEnabled: checked })}
          />
        </div>
        {settings.contextCompressionEnabled && (
          <p className="text-xs text-muted-foreground/70">
            {t('general.contextCompressionEnabled')}
          </p>
        )}
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
              systemPrompt: '',
              theme: 'system',
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
  const [memoryPath, setMemoryPath] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [missingFile, setMissingFile] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  const hasUnsavedChanges = draftContent !== savedContent

  const loadGlobalMemory = useCallback(async () => {
    setLoading(true)
    try {
      const path = await resolveGlobalMemoryPath(ipcClient)
      if (!path) {
        toast.error(t('memory.resolvePathFailed'))
        setMemoryPath('')
        setSavedContent('')
        setDraftContent('')
        setMissingFile(true)
        return
      }

      setMemoryPath(path)
      const { content, error } = await readTextFile(ipcClient, path)
      if (error) {
        if (isMissingFileError(error)) {
          setSavedContent(DEFAULT_GLOBAL_MEMORY_TEMPLATE)
          setDraftContent(DEFAULT_GLOBAL_MEMORY_TEMPLATE)
          setMissingFile(true)
          return
        }

        toast.error(t('memory.loadFailed', { error }))
        return
      }

      const normalized = content ?? ''
      setSavedContent(normalized)
      setDraftContent(normalized)
      setMissingFile(false)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadGlobalMemory()
  }, [loadGlobalMemory])

  const handleSave = useCallback(async () => {
    if (!memoryPath) {
      toast.error(t('memory.resolvePathFailed'))
      return
    }

    setSaving(true)
    try {
      const result = await ipcClient.invoke(IPC.FS_WRITE_FILE, {
        path: memoryPath,
        content: draftContent,
      })
      const error = getIpcError(result)
      if (error) {
        toast.error(t('memory.saveFailed', { error }))
        return
      }

      setSavedContent(draftContent)
      setMissingFile(false)
      setLastSavedAt(Date.now())
      toast.success(t('memory.saved'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('memory.saveFailed', { error: message }))
    } finally {
      setSaving(false)
    }
  }, [draftContent, memoryPath, t])

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">{t('memory.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('memory.subtitle')}</p>
      </div>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('memory.pathLabel')}</p>
            <p className="break-all text-xs text-muted-foreground">{memoryPath || t('memory.pathUnavailable')}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void loadGlobalMemory()}
            disabled={loading || saving}
          >
            <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('memory.reloadAction')}
          </Button>
        </div>
        {missingFile && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {t('memory.missingFileHint')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('memory.effectiveHint')}</p>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className="text-sm font-medium">{t('memory.editorLabel')}</label>
          <span className="text-[11px] text-muted-foreground">
            {hasUnsavedChanges
              ? t('memory.unsavedChanges')
              : lastSavedAt
                ? t('memory.lastSavedAt', { time: new Date(lastSavedAt).toLocaleString() })
                : t('memory.upToDate')}
          </span>
        </div>
        <Textarea
          value={draftContent}
          onChange={(e) => setDraftContent(e.target.value)}
          placeholder={t('memory.editorPlaceholder')}
          rows={20}
          className="min-h-[420px] font-mono text-xs leading-5"
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => void handleSave()}
            disabled={saving || loading || !hasUnsavedChanges}
          >
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Save className="mr-1.5 size-3.5" />}
            {saving ? t('memory.savingAction') : t('memory.saveAction')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setDraftContent(savedContent)}
            disabled={saving || loading || !hasUnsavedChanges}
          >
            {t('memory.resetAction')}
          </Button>
        </div>
      </section>
    </div>
  )
}

// ─── Model Configuration Panel ───

function ModelPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const activeFastModelId = useProviderStore((s) => s.activeFastModelId)
  const activeTranslationProviderId = useProviderStore((s) => s.activeTranslationProviderId)
  const activeTranslationModelId = useProviderStore((s) => s.activeTranslationModelId)
  const activeSpeechProviderId = useProviderStore((s) => s.activeSpeechProviderId)
  const activeSpeechModelId = useProviderStore((s) => s.activeSpeechModelId)
  const setActiveProvider = useProviderStore((s) => s.setActiveProvider)
  const setActiveModel = useProviderStore((s) => s.setActiveModel)
  const setActiveFastModel = useProviderStore((s) => s.setActiveFastModel)
  const setActiveTranslationProvider = useProviderStore((s) => s.setActiveTranslationProvider)
  const setActiveTranslationModel = useProviderStore((s) => s.setActiveTranslationModel)
  const setActiveSpeechProvider = useProviderStore((s) => s.setActiveSpeechProvider)
  const setActiveSpeechModel = useProviderStore((s) => s.setActiveSpeechModel)

  const enabledProviders = providers.filter((p) => p.enabled)
  const activeProvider = providers.find((p) => p.id === activeProviderId) ?? null
  const activeProviderEnabledModels = activeProvider?.models.filter((m) => m.enabled) ?? []

  const providerModelGroups = enabledProviders
    .map((provider) => ({
      provider,
      models: provider.models.filter((m) => m.enabled),
    }))
    .filter((group) => group.models.length > 0)

  const hasAnyEnabledModel = providerModelGroups.length > 0
  const buildModelValue = (providerId: string, modelId: string): string => `${providerId}::${modelId}`
  const parseModelValue = (value: string): { providerId: string; modelId: string } | null => {
    const [providerId, modelId] = value.split('::')
    if (!providerId || !modelId) return null
    return { providerId, modelId }
  }

  const activeModelValue = activeProvider && activeModelId
    ? buildModelValue(activeProvider.id, activeModelId)
    : ''
  const translationProvider = providers.find((p) => p.id === activeTranslationProviderId)
  const activeTranslationModelValue = translationProvider && activeTranslationModelId
    ? buildModelValue(translationProvider.id, activeTranslationModelId)
    : activeModelValue
  const speechProvider = providers.find((p) => p.id === activeSpeechProviderId)
  const activeSpeechModelValue = speechProvider && activeSpeechModelId
    ? buildModelValue(speechProvider.id, activeSpeechModelId)
    : ''

  const speechProviderGroups = providerModelGroups
    .filter(({ provider }) => provider.type === 'openai-chat' || provider.type === 'openai-responses')
    .map(({ provider, models }) => ({
      provider,
      models: models.filter((m) => m.category === 'speech'),
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
          <p className="text-xs text-muted-foreground/60">
            {t('model.noProvidersHint')}
          </p>
        </div>
      ) : (
        <>
          {/* Main Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.mainModel')}</label>
              <p className="text-xs text-muted-foreground">{t('model.mainModelDesc')}</p>
            </div>
            {hasAnyEnabledModel ? (
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
                  {providerModelGroups.map(({ provider, models }) => (
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
            ) : (
              <p className="text-xs text-muted-foreground/60">
                {t('model.noModelsHint')}
              </p>
            )}
          </section>

          {/* Fast Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.fastModel')}</label>
              <p className="text-xs text-muted-foreground">
                {t('model.fastModelDesc')}
              </p>
            </div>
            {activeProviderEnabledModels.length > 0 ? (
              <Select
                value={activeFastModelId || activeProviderEnabledModels[0]?.id || ''}
                onValueChange={(v) => setActiveFastModel(v)}
              >
                <SelectTrigger className="w-80 text-xs">
                  <SelectValue placeholder={t('model.selectFastModel')} />
                </SelectTrigger>
                <SelectContent>
                  {activeProviderEnabledModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      <div className="flex items-center gap-2">
                        <ModelIcon
                          icon={m.icon}
                          modelId={m.id}
                          providerBuiltinId={activeProvider?.builtinId}
                          size={16}
                          className="text-muted-foreground/70"
                        />
                        <span>{m.name}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground/60">{m.id}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground/60">{t('model.noModelsAvailable')}</p>
            )}
          </section>

          {/* Translation Model */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('model.translationModel')}</label>
              <p className="text-xs text-muted-foreground">{t('model.translationModelDesc')}</p>
            </div>
            {hasAnyEnabledModel ? (
              <Select
                value={activeTranslationModelValue}
                onValueChange={(value) => {
                  const parsed = parseModelValue(value)
                  if (!parsed) return
                  setActiveTranslationProvider(parsed.providerId)
                  setActiveTranslationModel(parsed.modelId)
                }}
              >
                <SelectTrigger className="w-80 text-xs">
                  <SelectValue placeholder={t('model.selectTranslationModel')} />
                </SelectTrigger>
                <SelectContent>
                  {providerModelGroups.map(({ provider, models }) => (
                    <SelectGroup key={`${provider.id}-translation`}>
                      <SelectLabel className="text-[10px] uppercase tracking-wide">
                        {provider.name}
                      </SelectLabel>
                      {models.map((m) => (
                        <SelectItem
                          key={`${provider.id}-translation-${m.id}`}
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
              <p className="text-xs text-muted-foreground/60">{t('model.speechModelNoProviders')}</p>
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
    { label: t('about.license'), value: 'Apache 2.0' },
  ]
  const featureCards = [
    {
      icon: Sparkles,
      title: t('about.featureCards.orchestration.title'),
      desc: t('about.featureCards.orchestration.desc'),
    },
    {
      icon: ShieldCheck,
      title: t('about.featureCards.sandbox.title'),
      desc: t('about.featureCards.sandbox.desc'),
    },
    {
      icon: Layers,
      title: t('about.featureCards.plugins.title'),
      desc: t('about.featureCards.plugins.desc'),
    },
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
          onClick={() => window.open('https://github.com/AIDotNet/OpenCowork', '_blank', 'noopener')}
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
              <div className="absolute -inset-1 rounded-3xl bg-primary/10 blur-2xl" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t('about.heroTagline')}</p>
              <h3 className="text-2xl font-semibold text-foreground">OpenCowork</h3>
              <p className="text-sm text-muted-foreground">{t('about.heroDescription')}</p>
            </div>
          </div>
          <Separator className="my-6 border-border/40" />
          <div className="grid gap-4 sm:grid-cols-2">
            {meta.map((item) => (
              <div key={item.label} className="rounded-2xl border border-border/50 bg-card px-4 py-3 text-sm">
                <p className="text-xs uppercase text-muted-foreground/70">{item.label}</p>
                <p className="mt-1 font-medium text-foreground">{item.value}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-border/70 bg-card/60 p-5 shadow-lg shadow-slate-900/5">
          <p className="text-xs uppercase tracking-[0.3em] text-primary">{t('about.workflowLabel')}</p>
          <h4 className="mt-2 text-lg font-semibold">{t('about.workflowTitle')}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t('about.workflowDescription')}</p>
          <div className="mt-4 space-y-3">
            {featureCards.map((card) => (
              <div key={card.title} className="flex gap-3 rounded-2xl border border-border/80 bg-background/70 px-3 py-2">
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
            onClick={() => window.open('https://github.com/AIDotNet/OpenCowork/releases', '_blank', 'noopener')}
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
  provider: ProviderPanel,
  plugin: PluginPanel,
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

  const ActivePanel = panelMap[settingsTab]

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
        <nav className="flex-1 space-y-1 px-3 overflow-y-auto">
          {menuItemDefs.map((item) => (
            <button
              key={item.id}
              onClick={() => setSettingsTab(item.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-all duration-150 ${
                settingsTab === item.id
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`}
            >
              <span
                className={`flex items-center justify-center size-5 ${
                  settingsTab === item.id ? 'text-accent-foreground' : 'text-muted-foreground'
                }`}
              >
                {item.icon}
              </span>
              <span>{t(item.labelKey)}</span>
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 text-[11px] text-muted-foreground/50">
          {t('page.poweredBy')}
        </div>
      </div>

      {/* Right Content */}
      <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden px-6 py-4">
        {/* Content */}
        <AnimatePresence mode="wait">
          {settingsTab === 'provider' || settingsTab === 'plugin' || settingsTab === 'mcp' ? (
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden pb-4" key="full-panel">
              <SlideIn key={settingsTab} direction="right" duration={0.25} className="h-full">
                <ActivePanel />
              </SlideIn>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto" key="scroll-panel">
              <div className="mx-auto max-w-2xl px-8 pb-16">
                <FadeIn key={settingsTab} duration={0.25}>
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
