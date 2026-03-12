import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image, MonitorSmartphone, Puzzle } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { ProviderIcon, ModelIcon } from './provider-icons'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import {
  APP_PLUGIN_DESCRIPTORS,
  DESKTOP_CLICK_TOOL_NAME,
  DESKTOP_CONTROL_PLUGIN_ID,
  DESKTOP_SCREENSHOT_TOOL_NAME,
  IMAGE_GENERATE_TOOL_NAME,
  IMAGE_PLUGIN_ID,
  type AppPluginDescriptor,
  type AppPluginId
} from '@renderer/lib/app-plugin/types'

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

function getPluginIcon(id: AppPluginId): React.JSX.Element {
  if (id === IMAGE_PLUGIN_ID) {
    return <ImagePluginIcon />
  }
  if (id === DESKTOP_CONTROL_PLUGIN_ID) {
    return <DesktopControlPluginIcon />
  }
  return <Puzzle className="size-4" />
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

export function AppPluginPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [selectedPluginId, setSelectedPluginId] = useState<AppPluginId>(IMAGE_PLUGIN_ID)
  const plugins = useAppPluginStore((state) => state.plugins)
  const updatePlugin = useAppPluginStore((state) => state.updatePlugin)
  const togglePluginEnabled = useAppPluginStore((state) => state.togglePluginEnabled)
  const providers = useProviderStore((state) => state.providers)
  const activeImageProviderId = useProviderStore((state) => state.activeImageProviderId)
  const activeImageModelId = useProviderStore((state) => state.activeImageModelId)

  const imageProviderGroups = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          models: provider.models.filter((model) => model.enabled && model.category === 'image')
        }))
        .filter((entry) => entry.models.length > 0),
    [providers]
  )

  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? null
  const selectedDescriptor =
    APP_PLUGIN_DESCRIPTORS.find((descriptor) => descriptor.id === selectedPluginId) ?? null
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
      APP_PLUGIN_DESCRIPTORS.find((descriptor) => descriptor.id === IMAGE_PLUGIN_ID) ??
      APP_PLUGIN_DESCRIPTORS[0],
    pluginEnabled: Boolean(selectedPlugin?.enabled),
    isResolvedImageModelReady
  })

  return (
    <div className="flex h-full min-h-0 gap-6">
      <div className="flex w-72 shrink-0 flex-col rounded-xl border bg-muted/20 p-3">
        <div className="px-2 pb-3">
          <h2 className="text-lg font-semibold">{t('plugin.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('plugin.subtitle')}</p>
        </div>
        <div className="space-y-2">
          {APP_PLUGIN_DESCRIPTORS.map((descriptor) => {
            const plugin = plugins.find((item) => item.id === descriptor.id)
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
                        (fallbackProviderId === activeImageProviderId ? activeImageModelId : null) ??
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
                            {globalImageProvider.models.find((model) => model.id === activeImageModelId)
                              ?.name ?? activeImageModelId}
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
                        onValueChange={(value) => updatePlugin(selectedPlugin.id, { modelId: value })}
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

            <section className="space-y-3 rounded-xl border p-4">
              <div>
                <p className="text-sm font-medium">{t('plugin.toolStatus')}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedDescriptor.requiresModelConfig
                    ? t('plugin.toolStatusDesc')
                    : t('plugin.toolStatusDescDesktop')}
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
                      {toolName === IMAGE_GENERATE_TOOL_NAME ? (
                        <>
                          <span className="rounded-full bg-muted px-2 py-0.5">prompt</span>
                          <span className="rounded-full bg-muted px-2 py-0.5">count</span>
                        </>
                      ) : toolName === DESKTOP_SCREENSHOT_TOOL_NAME ? (
                        <span className="rounded-full bg-muted px-2 py-0.5">no args</span>
                      ) : toolName === DESKTOP_CLICK_TOOL_NAME ? (
                        <>
                          <span className="rounded-full bg-muted px-2 py-0.5">x</span>
                          <span className="rounded-full bg-muted px-2 py-0.5">y</span>
                          <span className="rounded-full bg-muted px-2 py-0.5">button</span>
                          <span className="rounded-full bg-muted px-2 py-0.5">action</span>
                        </>
                      ) : (
                        <>
                          <span className="rounded-full bg-muted px-2 py-0.5">text</span>
                          <span className="rounded-full bg-muted px-2 py-0.5">key</span>
                          <span className="rounded-full bg-muted px-2 py-0.5">hotkey</span>
                        </>
                      )}
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
