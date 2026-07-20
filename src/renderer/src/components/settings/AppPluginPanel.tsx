import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DownloadCloud,
  Globe,
  Image,
  MonitorSmartphone,
  Puzzle,
  Trash2,
  Waypoints
} from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { ProviderIcon, ModelIcon } from './provider-icons'
import {
  isProviderAvailableForModelSelection,
  useProviderStore
} from '@renderer/stores/provider-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { resolvePluginsForProject, useAppPluginStore } from '@renderer/stores/app-plugin-store'
import {
  trackCodeGraphIndex,
  untrackCodeGraphIndex,
  useCodeGraphStore,
  type CgAssetStatus
} from '@renderer/stores/codegraph-store'
import { CodeGraphIndexProgressBar } from '@renderer/components/codegraph/CodeGraphIndexProgressBar'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { parseBrowserDomainList } from '@renderer/lib/app-plugin/browser-access'
import {
  APP_PLUGIN_DESCRIPTORS,
  CODEGRAPH_EXPLORE_TOOL_NAME,
  CODEGRAPH_PLUGIN_ID,
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_GET_CONTENT_TOOL_NAME,
  BROWSER_NAVIGATE_TOOL_NAME,
  BROWSER_PLUGIN_ID,
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_SNAPSHOT_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_CONTROL_PLUGIN_ID,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  DESKTOP_SCROLL_TOOL_NAME,
  DESKTOP_TYPE_TOOL_NAME,
  DESKTOP_WAIT_TOOL_NAME,
  IMAGE_GENERATE_TOOL_NAME,
  IMAGE_PLUGIN_ID,
  isAppPluginEnabledByDefault,
  type AppPluginDescriptor,
  type AppPluginId,
  type AppPluginInstance,
  type AppPluginToolName
} from '@renderer/lib/app-plugin/types'
import {
  BROWSER_USER_DATA_SOURCES,
  type BrowserUserDataSource
} from '../../../../shared/browser-plugin'

interface BrowserEmulationStatus {
  reuseEnabled: boolean
  browserUserDataSource: BrowserUserDataSource
  browserName: string | null
  browserProfilePath: string | null
  browserProfileDisplayName: string | null
  usingDetectedBrowserProfile: boolean
  userAgent: string
  acceptLanguages: string
  browserSessionStoragePath: string | null
}

interface CodeGraphProjectInfo {
  root: string
  hash: string
  state: string
  files: number
  nodes: number
  edges: number
  dbSizeBytes: number
  lastIndexedAt?: number | null
}

function formatDbSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

const TOOL_ARG_LABELS: Record<AppPluginToolName, string[]> = {
  [CODEGRAPH_EXPLORE_TOOL_NAME]: ['query', 'projectPath'],
  [IMAGE_GENERATE_TOOL_NAME]: ['prompt', 'count', 'reference_images', 'size', 'quality'],
  [BROWSER_NAVIGATE_TOOL_NAME]: ['url', 'action'],
  [BROWSER_GET_CONTENT_TOOL_NAME]: ['selector', 'type'],
  [BROWSER_SCREENSHOT_TOOL_NAME]: ['no args'],
  [BROWSER_SNAPSHOT_TOOL_NAME]: ['no args'],
  [BROWSER_CLICK_TOOL_NAME]: ['selector'],
  [BROWSER_TYPE_TOOL_NAME]: ['selector', 'text', 'clear', 'submit'],
  [BROWSER_SCROLL_TOOL_NAME]: ['direction', 'amount'],
  [DESKTOP_SCREENSHOT_TOOL_NAME]: ['no args'],
  [DESKTOP_CLICK_TOOL_NAME]: ['x', 'y', 'button', 'action'],
  [DESKTOP_TYPE_TOOL_NAME]: ['text', 'key', 'hotkey'],
  [DESKTOP_SCROLL_TOOL_NAME]: ['x', 'y', 'scrollX', 'scrollY'],
  [DESKTOP_WAIT_TOOL_NAME]: ['delayMs']
}

function resolveDefaultImageModelId(providerId: string): string | null {
  const provider = useProviderStore.getState().providers.find((item) => item.id === providerId)
  if (!provider) return null
  const enabledModel = provider.models.find((item) => item.enabled && item.category === 'image')
  if (enabledModel) return enabledModel.id
  return provider.models.find((item) => item.category === 'image')?.id ?? null
}

function ImagePluginIcon(): React.JSX.Element {
  return <Image className="size-4" />
}

function DesktopControlPluginIcon(): React.JSX.Element {
  return <MonitorSmartphone className="size-4" />
}

function BrowserPluginIcon(): React.JSX.Element {
  return <Globe className="size-4" />
}

function getPluginIcon(id: AppPluginId): React.JSX.Element {
  if (id === IMAGE_PLUGIN_ID) {
    return <ImagePluginIcon />
  }
  if (id === BROWSER_PLUGIN_ID) {
    return <BrowserPluginIcon />
  }
  if (id === DESKTOP_CONTROL_PLUGIN_ID) {
    return <DesktopControlPluginIcon />
  }
  if (id === CODEGRAPH_PLUGIN_ID) {
    return <Waypoints className="size-4" />
  }
  return <Puzzle className="size-4" />
}

function createFallbackPlugin(id: AppPluginId): AppPluginInstance {
  return {
    id,
    enabled: isAppPluginEnabledByDefault(id),
    useGlobalModel: true,
    providerId: null,
    modelId: null
  }
}

function getPluginState(options: {
  descriptor: AppPluginDescriptor
  pluginEnabled: boolean
  isResolvedImageModelReady: boolean
  isCodeGraphReady: boolean
}): 'disabled' | 'not_ready' | 'ready' {
  const { descriptor, pluginEnabled, isResolvedImageModelReady, isCodeGraphReady } = options
  if (!pluginEnabled) return 'disabled'
  if (descriptor.requiresModelConfig && !isResolvedImageModelReady) return 'not_ready'
  if (descriptor.requiresDownload && !isCodeGraphReady) return 'not_ready'
  return 'ready'
}

function getToolStatusDescriptionKey(descriptor: AppPluginDescriptor): string {
  if (descriptor.requiresModelConfig) return 'plugin.toolStatusDesc'
  if (descriptor.id === BROWSER_PLUGIN_ID) return 'plugin.toolStatusDescBrowser'
  if (descriptor.id === CODEGRAPH_PLUGIN_ID) return 'plugin.toolStatusDescCodeGraph'
  return 'plugin.toolStatusDescDesktop'
}

export function AppPluginPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [selectedPluginId, setSelectedPluginId] = useState<AppPluginId>(IMAGE_PLUGIN_ID)
  const [clearingCookies, setClearingCookies] = useState(false)
  const [importingCookies, setImportingCookies] = useState(false)
  const [codegraphAsset, setCodegraphAsset] = useState<CgAssetStatus | null>(null)
  const [codegraphDownloading, setCodegraphDownloading] = useState(false)
  const [codegraphProgress, setCodegraphProgress] = useState<number | null>(null)
  const [cgProjects, setCgProjects] = useState<CodeGraphProjectInfo[]>([])
  const [cgProjectsLoading, setCgProjectsLoading] = useState(false)
  const [cgBusyKey, setCgBusyKey] = useState<string | null>(null)
  const indexProgress = useCodeGraphStore((s) => s.indexProgress)
  const activeWorkingFolder = useChatStore(
    (state) => state.projects.find((p) => p.id === state.activeProjectId)?.workingFolder
  )
  const [browserEmulationStatus, setBrowserEmulationStatus] =
    useState<BrowserEmulationStatus | null>(null)
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const pluginsByProject = useAppPluginStore((state) => state.pluginsByProject)
  const updatePlugin = useAppPluginStore((state) => state.updatePlugin)
  const togglePluginEnabled = useAppPluginStore((state) => state.togglePluginEnabled)
  const browserUserDataReuseEnabled = useSettingsStore((state) => state.browserUserDataReuseEnabled)
  const browserUserDataSource = useSettingsStore((state) => state.browserUserDataSource)
  const updateSettings = useSettingsStore((state) => state.updateSettings)
  const providers = useProviderStore((state) => state.providers)
  const activeImageProviderId = useProviderStore((state) => state.activeImageProviderId)
  const activeImageModelId = useProviderStore((state) => state.activeImageModelId)

  const imageProviderGroups = useMemo(
    () =>
      providers
        .filter((provider) => isProviderAvailableForModelSelection(provider))
        .map((provider) => ({
          provider,
          models: provider.models.filter((model) => model.enabled && model.category === 'image')
        }))
        .filter((entry) => entry.models.length > 0),
    [providers]
  )

  const projectPlugins = useMemo(
    () => resolvePluginsForProject(pluginsByProject, activeProjectId),
    [activeProjectId, pluginsByProject]
  )
  const visibleDescriptors = useMemo(() => APP_PLUGIN_DESCRIPTORS.filter((d) => !d.hidden), [])
  const selectedPlugin = useMemo(
    () =>
      projectPlugins.find((plugin) => plugin.id === selectedPluginId) ??
      createFallbackPlugin(selectedPluginId),
    [projectPlugins, selectedPluginId]
  )
  const selectedDescriptor =
    visibleDescriptors.find((descriptor) => descriptor.id === selectedPluginId) ??
    visibleDescriptors[0] ??
    null
  const overrideProvider = imageProviderGroups.find(
    (entry) => entry.provider.id === selectedPlugin?.providerId
  )
  const globalImageProvider = imageProviderGroups.find(
    (entry) => entry.provider.id === activeImageProviderId
  )
  const resolvedProviderId = selectedPlugin?.useGlobalModel
    ? activeImageProviderId
    : (selectedPlugin?.providerId ?? null)
  const resolvedModelId = selectedPlugin?.useGlobalModel
    ? activeImageModelId
    : (selectedPlugin?.modelId ?? null)
  const resolvedProviderEntry = imageProviderGroups.find(
    (entry) => entry.provider.id === resolvedProviderId
  )
  const isResolvedImageModelReady = Boolean(
    resolvedProviderEntry?.models.some((model) => model.id === resolvedModelId)
  )
  const activeState = getPluginState({
    descriptor:
      selectedDescriptor ??
      visibleDescriptors.find((descriptor) => descriptor.id === IMAGE_PLUGIN_ID) ??
      visibleDescriptors[0],
    pluginEnabled: Boolean(selectedPlugin?.enabled),
    isResolvedImageModelReady,
    isCodeGraphReady: Boolean(codegraphAsset?.runtimeReady ?? codegraphAsset?.ready)
  })
  const browserAllowedDomainText = (selectedPlugin.browserAllowedDomains ?? []).join('\n')
  const browserBlockedDomainText = (selectedPlugin.browserBlockedDomains ?? []).join('\n')

  useEffect(() => {
    let cancelled = false

    async function loadBrowserEmulationStatus(): Promise<void> {
      try {
        const result = (await ipcClient.invoke(IPC.BROWSER_EMULATION_STATUS)) as
          | { success: true; status: BrowserEmulationStatus }
          | { success: false; error?: string }
        if (!cancelled && result.success) {
          setBrowserEmulationStatus(result.status)
        }
      } catch {
        if (!cancelled) setBrowserEmulationStatus(null)
      }
    }

    void loadBrowserEmulationStatus()
    return () => {
      cancelled = true
    }
  }, [browserUserDataReuseEnabled, browserUserDataSource])

  const handleClearBrowserCookies = async (): Promise<void> => {
    setClearingCookies(true)
    try {
      const result = (await ipcClient.invoke(IPC.BROWSER_CLEAR_COOKIES)) as
        | { success: true }
        | { success: false; error?: string }
      if (result.success) {
        toast.success(t('plugin.browser.cookiesCleared'))
      } else {
        toast.error(t('plugin.browser.cookiesClearFailed'), { description: result.error })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('plugin.browser.cookiesClearFailed'), { description: message })
    } finally {
      setClearingCookies(false)
    }
  }

  const handleImportBrowserCookies = async (): Promise<void> => {
    setImportingCookies(true)
    try {
      const result = (await ipcClient.invoke(IPC.BROWSER_IMPORT_COOKIES, {
        source: browserUserDataSource
      })) as
        | {
            success: true
            result: { browserName: string; imported: number; skipped: number; failed: number }
          }
        | { success: false; error?: string }
      if (result.success) {
        toast.success(
          t('plugin.browser.cookiesImported', {
            browserName: result.result.browserName,
            imported: result.result.imported,
            skipped: result.result.skipped
          })
        )
      } else {
        toast.error(t('plugin.browser.cookiesImportFailed'), { description: result.error })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('plugin.browser.cookiesImportFailed'), { description: message })
    } finally {
      setImportingCookies(false)
    }
  }

  const refreshCodegraphAsset = async (): Promise<void> => {
    try {
      const status = (await ipcClient.invoke(IPC.CODEGRAPH_ASSET_STATUS)) as CgAssetStatus
      setCodegraphAsset(status)
    } catch {
      setCodegraphAsset(null)
    }
  }

  useEffect(() => {
    if (selectedPluginId !== CODEGRAPH_PLUGIN_ID) return
    void refreshCodegraphAsset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPluginId])

  const handleDownloadCodegraph = async (): Promise<void> => {
    setCodegraphDownloading(true)
    setCodegraphProgress(0)
    const onProgress = (_event: unknown, payload: { received?: number; total?: number }): void => {
      if (payload.total && payload.total > 0 && typeof payload.received === 'number') {
        setCodegraphProgress(Math.round((payload.received / payload.total) * 100))
      }
    }
    const off = window.electron?.ipcRenderer?.on?.(IPC.CODEGRAPH_DOWNLOAD_PROGRESS, onProgress)
    try {
      const result = (await ipcClient.invoke(IPC.CODEGRAPH_DOWNLOAD_ASSETS)) as {
        success: boolean
        error?: string
      }
      if (result.success) {
        toast.success(t('plugin.codegraph.downloaded'))
        await refreshCodegraphAsset()
      } else {
        toast.error(t('plugin.codegraph.downloadFailed'), { description: result.error })
      }
    } catch (error) {
      toast.error(t('plugin.codegraph.downloadFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setCodegraphDownloading(false)
      setCodegraphProgress(null)
      if (typeof off === 'function') off()
    }
  }

  const handleRemoveCodegraph = async (): Promise<void> => {
    try {
      await ipcClient.invoke(IPC.CODEGRAPH_REMOVE_ASSETS)
      await refreshCodegraphAsset()
      toast.success(t('plugin.codegraph.removed'))
    } catch {
      /* ignore */
    }
  }

  const codegraphPluginEnabled = Boolean(
    projectPlugins.find((p) => p.id === CODEGRAPH_PLUGIN_ID)?.enabled
  )

  const refreshCgProjects = async (): Promise<void> => {
    setCgProjectsLoading(true)
    try {
      const { agentBridge } = await import('@renderer/lib/ipc/agent-bridge')
      const result = (await agentBridge.request('codegraph/list-projects', {}, 30_000)) as {
        success?: boolean
        projects?: CodeGraphProjectInfo[]
      }
      setCgProjects(result?.success && Array.isArray(result.projects) ? result.projects : [])
    } catch {
      setCgProjects([])
    } finally {
      setCgProjectsLoading(false)
    }
  }

  useEffect(() => {
    if (selectedPluginId !== CODEGRAPH_PLUGIN_ID || !codegraphPluginEnabled) return
    void refreshCgProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPluginId, codegraphPluginEnabled])

  const runCgAction = async (
    busyKey: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    opts?: { indexId?: string; phase?: string }
  ): Promise<void> => {
    setCgBusyKey(busyKey)
    // Seed + track live progress for index/sync so the row shows a real bar.
    if (opts?.indexId) {
      trackCodeGraphIndex(opts.indexId)
      useCodeGraphStore.setState({
        indexProgress: {
          indexId: opts.indexId,
          phase: opts.phase ?? 'scan',
          filesDone: 0,
          filesTotal: 0,
          nodeCount: 0,
          edgeCount: 0
        }
      })
    }
    try {
      const { agentBridge } = await import('@renderer/lib/ipc/agent-bridge')
      const result = (await agentBridge.request(
        method,
        opts?.indexId ? { ...params, indexId: opts.indexId } : params,
        timeoutMs
      )) as {
        success?: boolean
        error?: string
        message?: string
      }
      if (result?.success === false) {
        toast.error(t('plugin.codegraph.actionFailed'), {
          description: result.error ?? result.message
        })
      } else {
        toast.success(t('plugin.codegraph.actionDone'))
      }
    } catch (error) {
      toast.error(t('plugin.codegraph.actionFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (opts?.indexId) {
        untrackCodeGraphIndex(opts.indexId)
        useCodeGraphStore.setState({ indexProgress: null })
      }
      setCgBusyKey(null)
      await refreshCgProjects()
      void refreshCodegraphAsset()
    }
  }

  const handleCgIndex = (root: string): void => {
    // Re-index is long-running on big repos; the row shows a live progress bar.
    void runCgAction(`index:${root}`, 'codegraph/index', { workingFolder: root }, 600_000, {
      indexId: crypto.randomUUID(),
      phase: 'scan'
    })
  }

  const handleCgSync = (root: string): void => {
    void runCgAction(`sync:${root}`, 'codegraph/sync', { workingFolder: root }, 300_000, {
      indexId: crypto.randomUUID(),
      phase: 'sync'
    })
  }

  const handleCgRemoveProject = (row: CodeGraphProjectInfo): void => {
    void runCgAction(
      `remove:${row.hash}`,
      'codegraph/remove-project',
      row.root ? { workingFolder: row.root } : { hash: row.hash },
      30_000
    )
  }

  const handlePluginEnabledChange = (checked: boolean): void => {
    if (!selectedPlugin || checked === selectedPlugin.enabled) return
    togglePluginEnabled(selectedPlugin.id)
  }

  return (
    <div className="flex h-full min-h-0 gap-6">
      <div className="flex w-72 shrink-0 flex-col rounded-xl border bg-muted/20 p-3">
        <div className="px-2 pb-3">
          <h2 className="text-lg font-semibold">{t('plugin.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('plugin.subtitle')}</p>
        </div>
        <div className="space-y-2">
          {visibleDescriptors.map((descriptor) => {
            const plugin =
              projectPlugins.find((item) => item.id === descriptor.id) ??
              createFallbackPlugin(descriptor.id)
            const selected = descriptor.id === selectedPluginId
            return (
              <button
                key={descriptor.id}
                onClick={() => setSelectedPluginId(descriptor.id)}
                className={`flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${
                  selected
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-transparent bg-background hover:border-border'
                }`}
              >
                <span className="mt-0.5 rounded-md border bg-background p-2 text-muted-foreground">
                  {getPluginIcon(descriptor.id)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {t(`plugin.items.${descriptor.id}.title`)}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${
                        plugin?.enabled
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {plugin?.enabled ? t('plugin.enabled') : t('plugin.disabled')}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t(`plugin.items.${descriptor.id}.description`)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl border bg-background p-6">
        {selectedPlugin && selectedDescriptor ? (
          <div className="space-y-6">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="rounded-lg border bg-muted/40 p-2 text-muted-foreground">
                  {getPluginIcon(selectedPlugin.id)}
                </span>
                <div>
                  <h3 className="text-lg font-semibold">
                    {t(`plugin.items.${selectedPlugin.id}.title`)}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t(`plugin.items.${selectedPlugin.id}.description`)}
                  </p>
                </div>
              </div>
            </div>

            <section className="rounded-xl border bg-muted/10 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{t('plugin.enable')}</p>
                  <p className="text-xs text-muted-foreground">{t('plugin.enableDesc')}</p>
                </div>
                <Switch
                  checked={selectedPlugin.enabled}
                  onCheckedChange={handlePluginEnabledChange}
                />
              </div>
            </section>

            {selectedDescriptor.requiresModelConfig ? (
              <section className="space-y-3 rounded-xl border p-4">
                <div>
                  <p className="text-sm font-medium">{t('plugin.modelSource')}</p>
                  <p className="text-xs text-muted-foreground">{t('plugin.modelSourceDesc')}</p>
                </div>
                <Select
                  value={selectedPlugin.useGlobalModel ? 'global' : 'override'}
                  onValueChange={(value) => {
                    if (value === 'global') {
                      updatePlugin(selectedPlugin.id, { useGlobalModel: true })
                      return
                    }

                    const fallbackProviderId =
                      selectedPlugin.providerId ??
                      activeImageProviderId ??
                      imageProviderGroups[0]?.provider.id ??
                      null
                    const fallbackModelId = fallbackProviderId
                      ? (selectedPlugin.modelId ??
                        (fallbackProviderId === activeImageProviderId
                          ? activeImageModelId
                          : null) ??
                        resolveDefaultImageModelId(fallbackProviderId))
                      : null

                    updatePlugin(selectedPlugin.id, {
                      useGlobalModel: false,
                      providerId: fallbackProviderId,
                      modelId: fallbackModelId
                    })
                  }}
                >
                  <SelectTrigger className="w-80 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global" className="text-xs">
                      {t('plugin.useGlobalModel')}
                    </SelectItem>
                    <SelectItem value="override" className="text-xs">
                      {t('plugin.overrideModel')}
                    </SelectItem>
                  </SelectContent>
                </Select>

                {selectedPlugin.useGlobalModel ? (
                  <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                    {globalImageProvider && activeImageModelId ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-foreground">
                          <ProviderIcon
                            builtinId={globalImageProvider.provider.builtinId}
                            size={14}
                          />
                          <span>{globalImageProvider.provider.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <ModelIcon
                            icon={
                              globalImageProvider.models.find(
                                (model) => model.id === activeImageModelId
                              )?.icon
                            }
                            modelId={activeImageModelId}
                            providerBuiltinId={globalImageProvider.provider.builtinId}
                            size={14}
                          />
                          <span>
                            {globalImageProvider.models.find(
                              (model) => model.id === activeImageModelId
                            )?.name ?? activeImageModelId}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <span>{t('plugin.globalModelMissing')}</span>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium">{t('plugin.provider')}</label>
                      <Select
                        value={selectedPlugin.providerId ?? ''}
                        onValueChange={(value) => {
                          updatePlugin(selectedPlugin.id, {
                            providerId: value,
                            modelId: resolveDefaultImageModelId(value)
                          })
                        }}
                      >
                        <SelectTrigger className="mt-1 w-80 text-xs">
                          <SelectValue placeholder={t('plugin.selectProvider')} />
                        </SelectTrigger>
                        <SelectContent>
                          {imageProviderGroups.map(({ provider }) => (
                            <SelectItem key={provider.id} value={provider.id} className="text-xs">
                              <span className="flex items-center gap-2">
                                <ProviderIcon builtinId={provider.builtinId} size={14} />
                                {provider.name}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <label className="text-xs font-medium">{t('plugin.model')}</label>
                      <Select
                        value={selectedPlugin.modelId ?? ''}
                        onValueChange={(value) =>
                          updatePlugin(selectedPlugin.id, { modelId: value })
                        }
                      >
                        <SelectTrigger className="mt-1 w-80 text-xs">
                          <SelectValue placeholder={t('plugin.selectModel')} />
                        </SelectTrigger>
                        <SelectContent>
                          {(overrideProvider?.models ?? []).map((model) => (
                            <SelectItem key={model.id} value={model.id} className="text-xs">
                              <span className="flex items-center gap-2">
                                <ModelIcon
                                  icon={model.icon}
                                  modelId={model.id}
                                  providerBuiltinId={overrideProvider?.provider.builtinId}
                                  size={14}
                                />
                                {model.name}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </section>
            ) : null}

            {selectedDescriptor.id === CODEGRAPH_PLUGIN_ID ? (
              <section className="space-y-3 rounded-xl border p-4">
                <div>
                  <p className="text-sm font-medium">{t('plugin.codegraph.assetsTitle')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('plugin.codegraph.assetsDesc')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span
                    className={`rounded-full px-2 py-0.5 ${
                      codegraphAsset?.workerRunning
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {codegraphAsset?.workerRunning
                      ? t('plugin.codegraph.workerRunning')
                      : t('plugin.codegraph.workerStopped')}
                  </span>
                  {codegraphAsset?.grammarsDir ? (
                    <span className="max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                      {codegraphAsset.grammarsDir}
                    </span>
                  ) : null}
                </div>
                {codegraphAsset?.isDev && codegraphAsset.grammarsReady ? (
                  <div className="space-y-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-600">
                    <p>{t('plugin.codegraph.devMode', { count: codegraphAsset.grammarCount })}</p>
                    {codegraphAsset.availableLanguages?.length > 0 ? (
                      <p className="break-words text-muted-foreground">
                        {t('plugin.codegraph.availableLanguages', {
                          defaultValue: 'Available languages: {{languages}}',
                          languages: codegraphAsset.availableLanguages.join(', ')
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : (codegraphAsset?.runtimeReady ?? codegraphAsset?.ready) ? (
                  <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/20 p-3 text-xs">
                    <div className="min-w-0 space-y-1">
                      <p className="text-foreground">
                        {t('plugin.codegraph.ready', { count: codegraphAsset.grammarCount })}
                      </p>
                      {codegraphAsset.availableLanguages?.length > 0 ? (
                        <p className="break-words text-muted-foreground">
                          {t('plugin.codegraph.availableLanguages', {
                            defaultValue: 'Available languages: {{languages}}',
                            languages: codegraphAsset.availableLanguages.join(', ')
                          })}
                        </p>
                      ) : null}
                      {codegraphAsset.invalidGrammarFiles?.length > 0 ? (
                        <p className="break-words text-destructive">
                          {t('plugin.codegraph.invalidFiles', {
                            defaultValue: 'Invalid grammar files: {{files}}',
                            files: codegraphAsset.invalidGrammarFiles.join(', ')
                          })}
                        </p>
                      ) : null}
                      {codegraphAsset.unrecognizedGrammars?.length > 0 ? (
                        <p className="break-words text-destructive">
                          {t('plugin.codegraph.unrecognizedGrammars', {
                            defaultValue: 'Unrecognized grammar libraries: {{grammars}}',
                            grammars: codegraphAsset.unrecognizedGrammars.join(', ')
                          })}
                        </p>
                      ) : null}
                      {codegraphAsset.missingLanguages?.length > 0 ? (
                        <p className="break-words text-amber-600">
                          {t('plugin.codegraph.missingLanguages', {
                            defaultValue: 'Unavailable languages: {{languages}}',
                            languages: codegraphAsset.missingLanguages.join(', ')
                          })}
                        </p>
                      ) : null}
                    </div>
                    {codegraphAsset.grammarSource === 'downloaded' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        onClick={() => void handleRemoveCodegraph()}
                      >
                        <Trash2 className="size-3.5" />
                        {t('plugin.codegraph.remove')}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">
                      {codegraphAsset && !codegraphAsset.workerReady
                        ? t('plugin.codegraph.workerMissing')
                        : codegraphAsset?.diagnostic === 'core-library-missing'
                          ? t('plugin.codegraph.coreLibraryMissing', {
                              defaultValue:
                                'The tree-sitter runtime library is missing or invalid. Reinstall or update OpenCowork.'
                            })
                          : codegraphAsset?.diagnostic === 'language-grammars-missing'
                            ? t('plugin.codegraph.languageGrammarsMissing', {
                                defaultValue:
                                  'No valid language grammar libraries were found. Reinstall or update OpenCowork.'
                              })
                            : codegraphAsset?.diagnostic === 'invalid-grammar-files'
                              ? t('plugin.codegraph.invalidGrammarPackage', {
                                  defaultValue:
                                    'Some CodeGraph grammar files are invalid. Reinstall or update OpenCowork.'
                                })
                              : t('plugin.codegraph.needsDownload')}
                    </p>
                    {codegraphDownloading && codegraphProgress !== null ? (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${codegraphProgress}%` }}
                        />
                      </div>
                    ) : null}
                    <Button
                      size="sm"
                      className="gap-2"
                      disabled={codegraphDownloading}
                      onClick={() => void handleDownloadCodegraph()}
                    >
                      <DownloadCloud className="size-3.5" />
                      {codegraphDownloading
                        ? t('plugin.codegraph.downloading')
                        : t('plugin.codegraph.download')}
                    </Button>
                  </div>
                )}
              </section>
            ) : null}

            {selectedPluginId === CODEGRAPH_PLUGIN_ID ? (
              <section className="space-y-3 rounded-xl border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{t('plugin.codegraph.projectsTitle')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('plugin.codegraph.projectsDesc')}
                    </p>
                  </div>
                  {codegraphPluginEnabled ? (
                    <div className="flex shrink-0 items-center gap-2">
                      {activeWorkingFolder ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={cgBusyKey !== null}
                          onClick={() => handleCgIndex(activeWorkingFolder)}
                        >
                          {t('plugin.codegraph.indexCurrent')}
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cgProjectsLoading}
                        onClick={() => void refreshCgProjects()}
                      >
                        {t('plugin.codegraph.refresh')}
                      </Button>
                    </div>
                  ) : null}
                </div>

                {/* Section-level bar for indexing a folder that isn't a listed row yet
                    (e.g. the first index of the current project). */}
                {indexProgress &&
                cgBusyKey &&
                !cgProjects.some(
                  (p) => cgBusyKey === `index:${p.root}` || cgBusyKey === `sync:${p.root}`
                ) ? (
                  <CodeGraphIndexProgressBar progress={indexProgress} />
                ) : null}

                {!codegraphPluginEnabled ? (
                  <p className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                    {t('plugin.codegraph.enableFirst')}
                  </p>
                ) : cgProjectsLoading && cgProjects.length === 0 ? (
                  <p className="p-2 text-xs text-muted-foreground">
                    {t('plugin.codegraph.projectsLoading')}
                  </p>
                ) : cgProjects.length === 0 ? (
                  <p className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                    {t('plugin.codegraph.projectsEmpty')}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {cgProjects.map((row) => {
                      const busyIndex = cgBusyKey === `index:${row.root}`
                      const busySync = cgBusyKey === `sync:${row.root}`
                      const busyRemove = cgBusyKey === `remove:${row.hash}`
                      const anyBusy = cgBusyKey !== null
                      return (
                        <div key={row.hash} className="rounded-lg border bg-muted/10 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <p
                              className="min-w-0 flex-1 truncate font-mono text-xs"
                              title={row.root || row.hash}
                            >
                              {row.root || t('plugin.codegraph.unknownRoot', { hash: row.hash })}
                            </p>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                                row.state === 'complete'
                                  ? 'bg-emerald-500/10 text-emerald-600'
                                  : row.state === 'indexing'
                                    ? 'bg-amber-500/10 text-amber-600'
                                    : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              {row.state}
                            </span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span>
                              {t('plugin.codegraph.projectStats', {
                                files: row.files,
                                nodes: row.nodes,
                                edges: row.edges
                              })}
                            </span>
                            <span>{formatDbSize(row.dbSizeBytes)}</span>
                            {row.lastIndexedAt ? (
                              <span>{new Date(row.lastIndexedAt).toLocaleString()}</span>
                            ) : null}
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            {row.root ? (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={anyBusy}
                                  onClick={() => handleCgIndex(row.root)}
                                >
                                  {busyIndex
                                    ? t('plugin.codegraph.reindexing')
                                    : t('plugin.codegraph.reindex')}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={anyBusy}
                                  onClick={() => handleCgSync(row.root)}
                                >
                                  {busySync
                                    ? t('plugin.codegraph.syncing')
                                    : t('plugin.codegraph.sync')}
                                </Button>
                              </>
                            ) : null}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 gap-1 text-xs text-destructive"
                              disabled={anyBusy}
                              onClick={() => handleCgRemoveProject(row)}
                            >
                              <Trash2 className="size-3" />
                              {busyRemove
                                ? t('plugin.codegraph.removing')
                                : t('plugin.codegraph.deleteIndex')}
                            </Button>
                          </div>
                          {(busyIndex || busySync) && indexProgress ? (
                            <CodeGraphIndexProgressBar
                              progress={indexProgress}
                              className="mt-2.5"
                            />
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            ) : null}

            {selectedPlugin.id === BROWSER_PLUGIN_ID ? (
              <section className="space-y-4 rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t('plugin.browser.title')}</p>
                    <p className="text-xs text-muted-foreground">{t('plugin.browser.desc')}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => void handleImportBrowserCookies()}
                      disabled={importingCookies || !browserUserDataReuseEnabled}
                    >
                      <DownloadCloud className="size-3.5" />
                      {importingCookies
                        ? t('plugin.browser.importingCookies')
                        : t('plugin.browser.importCookies')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => void handleClearBrowserCookies()}
                      disabled={clearingCookies}
                    >
                      <Trash2 className="size-3.5" />
                      {clearingCookies
                        ? t('plugin.browser.clearingCookies')
                        : t('plugin.browser.clearCookies')}
                    </Button>
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/10 p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium">{t('plugin.browser.userDataReuse')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('plugin.browser.userDataReuseDesc')}
                      </p>
                    </div>
                    <Switch
                      checked={browserUserDataReuseEnabled}
                      onCheckedChange={(checked) => {
                        updateSettings({ browserUserDataReuseEnabled: checked })
                        toast.info(t('plugin.browser.restartRequired'))
                      }}
                    />
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center">
                    <div>
                      <p className="text-xs font-medium">{t('plugin.browser.userDataSource')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('plugin.browser.userDataSourceDesc')}
                      </p>
                    </div>
                    <Select
                      value={browserUserDataSource}
                      onValueChange={(value) => {
                        updateSettings({ browserUserDataSource: value as BrowserUserDataSource })
                        toast.info(t('plugin.browser.restartRequired'))
                      }}
                      disabled={!browserUserDataReuseEnabled}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BROWSER_USER_DATA_SOURCES.map((source) => (
                          <SelectItem key={source} value={source} className="text-xs">
                            {t(`plugin.browser.sources.${source}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                    {browserEmulationStatus?.usingDetectedBrowserProfile ? (
                      <p>
                        {t('plugin.browser.activeProfile', {
                          browserName: browserEmulationStatus.browserName,
                          profileName: browserEmulationStatus.browserProfileDisplayName,
                          path: browserEmulationStatus.browserProfilePath
                        })}
                      </p>
                    ) : (
                      <p>{t('plugin.browser.profileFallback')}</p>
                    )}
                    {browserEmulationStatus?.browserSessionStoragePath ? (
                      <p>
                        {t('plugin.browser.isolatedStorage', {
                          path: browserEmulationStatus.browserSessionStoragePath
                        })}
                      </p>
                    ) : null}
                    <p>{t('plugin.browser.restartRequired')}</p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="text-xs font-medium">
                      {t('plugin.browser.blockedDomains')}
                    </label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('plugin.browser.blockedDomainsDesc')}
                    </p>
                    <Textarea
                      className="mt-2 min-h-28 font-mono text-xs"
                      placeholder={t('plugin.browser.domainPlaceholder')}
                      value={browserBlockedDomainText}
                      onChange={(event) =>
                        updatePlugin(selectedPlugin.id, {
                          browserBlockedDomains: parseBrowserDomainList(event.target.value)
                        })
                      }
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium">
                      {t('plugin.browser.allowedDomains')}
                    </label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('plugin.browser.allowedDomainsDesc')}
                    </p>
                    <Textarea
                      className="mt-2 min-h-28 font-mono text-xs"
                      placeholder={t('plugin.browser.domainPlaceholder')}
                      value={browserAllowedDomainText}
                      onChange={(event) =>
                        updatePlugin(selectedPlugin.id, {
                          browserAllowedDomains: parseBrowserDomainList(event.target.value)
                        })
                      }
                    />
                  </div>
                </div>

                <p className="text-xs text-muted-foreground/80">
                  {t('plugin.browser.domainRuleHint')}
                </p>
              </section>
            ) : null}

            <section className="space-y-3 rounded-xl border p-4">
              <div>
                <p className="text-sm font-medium">{t('plugin.toolStatus')}</p>
                <p className="text-xs text-muted-foreground">
                  {t(getToolStatusDescriptionKey(selectedDescriptor))}
                </p>
              </div>
              <div className="space-y-3">
                {selectedDescriptor.toolNames.map((toolName) => (
                  <div key={toolName} className="rounded-lg border bg-muted/10 p-3">
                    <p className="text-sm font-medium">{toolName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(`plugin.status.${activeState}`)}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t(`plugin.toolArgsMap.${toolName}`)}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                      {TOOL_ARG_LABELS[toolName].map((label) => (
                        <span key={label} className="rounded-full bg-muted px-2 py-0.5">
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <Separator />

            <section className="space-y-2">
              <p className="text-sm font-medium">
                {t(`plugin.items.${selectedPlugin.id}.promptTitle`)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(`plugin.items.${selectedPlugin.id}.promptDesc`)}
              </p>
            </section>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('plugin.selectPlugin')}
          </div>
        )}
      </div>
    </div>
  )
}
