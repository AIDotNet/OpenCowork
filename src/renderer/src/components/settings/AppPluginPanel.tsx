import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Image, MonitorSmartphone, Puzzle, Trash2 } from 'lucide-react'
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
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { parseBrowserDomainList } from '@renderer/lib/app-plugin/browser-access'
import { AnimatedIcon } from '@renderer/components/icons/AnimatedIcon'
import {
  APP_PLUGIN_DESCRIPTORS,
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

const TOOL_ARG_LABELS: Record<AppPluginToolName, string[]> = {
  [IMAGE_GENERATE_TOOL_NAME]: ['prompt', 'count'],
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
}): 'disabled' | 'not_ready' | 'ready' {
  const { descriptor, pluginEnabled, isResolvedImageModelReady } = options
  if (!pluginEnabled) return 'disabled'
  if (descriptor.requiresModelConfig && !isResolvedImageModelReady) return 'not_ready'
  return 'ready'
}

function getToolStatusDescriptionKey(descriptor: AppPluginDescriptor): string {
  if (descriptor.requiresModelConfig) return 'plugin.toolStatusDesc'
  if (descriptor.id === BROWSER_PLUGIN_ID) return 'plugin.toolStatusDescBrowser'
  return 'plugin.toolStatusDescDesktop'
}

export function AppPluginPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [selectedPluginId, setSelectedPluginId] = useState<AppPluginId>(IMAGE_PLUGIN_ID)
  const [clearingCookies, setClearingCookies] = useState(false)
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const pluginsByProject = useAppPluginStore((state) => state.pluginsByProject)
  const updatePlugin = useAppPluginStore((state) => state.updatePlugin)
  const togglePluginEnabled = useAppPluginStore((state) => state.togglePluginEnabled)
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
    () => pluginsByProject[activeProjectId ?? '__global__'] ?? [],
    [pluginsByProject, activeProjectId]
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
    isResolvedImageModelReady
  })
  const browserAllowedDomainText = (selectedPlugin.browserAllowedDomains ?? []).join('\n')
  const browserBlockedDomainText = (selectedPlugin.browserBlockedDomains ?? []).join('\n')

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
                  <AnimatedIcon animation="pop">{getPluginIcon(descriptor.id)}</AnimatedIcon>
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
                  <AnimatedIcon animation="bounce">{getPluginIcon(selectedPlugin.id)}</AnimatedIcon>
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
                  onCheckedChange={() => togglePluginEnabled(selectedPlugin.id)}
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

            {selectedPlugin.id === BROWSER_PLUGIN_ID ? (
              <section className="space-y-4 rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{t('plugin.browser.title')}</p>
                    <p className="text-xs text-muted-foreground">{t('plugin.browser.desc')}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-2"
                    onClick={() => void handleClearBrowserCookies()}
                    disabled={clearingCookies}
                  >
                    <Trash2 className="size-3.5" />
                    {clearingCookies
                      ? t('plugin.browser.clearingCookies')
                      : t('plugin.browser.clearCookies')}
                  </Button>
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
