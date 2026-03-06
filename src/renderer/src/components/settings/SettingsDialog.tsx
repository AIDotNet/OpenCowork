import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Separator } from '@renderer/components/ui/separator'
import { Slider } from '@renderer/components/ui/slider'
import { useTheme } from 'next-themes'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Input } from '@renderer/components/ui/input'
import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ProviderIcon, ModelIcon } from './provider-icons'

export function SettingsDialog(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const open = useUIStore((s) => s.settingsOpen)
  const setOpen = useUIStore((s) => s.setSettingsOpen)
  const openSettingsPage = useUIStore((s) => s.openSettingsPage)
  const settings = useSettingsStore()
  const { setTheme } = useTheme()

  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const activeFastModelId = useProviderStore((s) => s.activeFastModelId)
  const setActiveProvider = useProviderStore((s) => s.setActiveProvider)
  const setActiveModel = useProviderStore((s) => s.setActiveModel)
  const setActiveFastModel = useProviderStore((s) => s.setActiveFastModel)

  const enabledProviders = providers.filter(
    (p) => p.enabled && p.models.some((m) => m.enabled && (!m.category || m.category === 'chat'))
  )
  const activeProvider = enabledProviders.find((p) => p.id === activeProviderId) ?? null
  const enabledModels =
    activeProvider?.models.filter((m) => m.enabled && (!m.category || m.category === 'chat')) ?? []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>{t('dialog.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* Provider & Model Selection */}
          {enabledProviders.length > 0 ? (
            <>
              <section className="space-y-2">
                <label className="text-sm font-medium">{t('dialog.provider')}</label>
                <Select
                  value={activeProvider?.id ?? ''}
                  onValueChange={(v) => setActiveProvider(v)}
                >
                  <SelectTrigger className="w-full text-xs">
                    <SelectValue placeholder={t('dialog.selectProvider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledProviders.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-xs">
                        <span className="flex items-center gap-2">
                          <ProviderIcon builtinId={p.builtinId} size={14} />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </section>

              <section className="space-y-2">
                <label className="text-sm font-medium">{t('dialog.model')}</label>
                {enabledModels.length > 0 ? (
                  <Select value={activeModelId} onValueChange={(v) => setActiveModel(v)}>
                    <SelectTrigger className="w-full text-xs">
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledModels.map((m) => (
                        <SelectItem key={m.id} value={m.id} className="text-xs">
                          <span className="flex items-center gap-2">
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={activeProvider?.builtinId}
                              size={14}
                            />
                            {m.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('dialog.noModels')}</p>
                )}
              </section>

              <section className="space-y-2">
                <label className="text-sm font-medium">{t('dialog.fastModel')}</label>
                <p className="text-[10px] text-muted-foreground/60">{t('dialog.fastModelDesc')}</p>
                {enabledModels.length > 0 ? (
                  <Select
                    value={activeFastModelId || enabledModels[0]?.id || ''}
                    onValueChange={(v) => setActiveFastModel(v)}
                  >
                    <SelectTrigger className="w-full text-xs">
                      <SelectValue placeholder="Select fast model" />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledModels.map((m) => (
                        <SelectItem key={m.id} value={m.id} className="text-xs">
                          <span className="flex items-center gap-2">
                            <ModelIcon
                              icon={m.icon}
                              modelId={m.id}
                              providerBuiltinId={activeProvider?.builtinId}
                              size={14}
                            />
                            {m.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('dialog.noModels')}</p>
                )}
              </section>
            </>
          ) : (
            <section className="space-y-3 rounded-lg border border-dashed p-4 text-center">
              <p className="text-sm text-muted-foreground">{t('dialog.noProvidersEnabled')}</p>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => {
                  setOpen(false)
                  openSettingsPage('provider')
                }}
              >
                <Settings className="size-3.5" />
                {t('dialog.configureProviders')}
              </Button>
            </section>
          )}

          <Separator />

          {/* Temperature */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('dialog.temperature')}</label>
              <span className="text-xs text-muted-foreground">{settings.temperature}</span>
            </div>
            <Slider
              value={[settings.temperature]}
              onValueChange={([v]) => settings.updateSettings({ temperature: v })}
              min={0}
              max={1}
              step={0.1}
            />
          </section>

          {/* Max Tokens */}
          <section className="space-y-2">
            <label className="text-sm font-medium">{t('dialog.maxTokens')}</label>
            <Input
              type="number"
              value={settings.maxTokens}
              onChange={(e) =>
                settings.updateSettings({ maxTokens: parseInt(e.target.value) || 32000 })
              }
            />
            <div className="flex items-center gap-1">
              {[8192, 16384, 32000, 64000, 128000].map((v) => (
                <button
                  key={v}
                  onClick={() => settings.updateSettings({ maxTokens: v })}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${settings.maxTokens === v ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                >
                  {v >= 1000 ? `${Math.round(v / 1024)}K` : v}
                </button>
              ))}
            </div>
          </section>

          <Separator />

          {/* Theme */}
          <section className="space-y-2">
            <label className="text-sm font-medium">{t('dialog.theme')}</label>
            <Select
              value={settings.theme}
              onValueChange={(v: 'light' | 'dark' | 'system') => {
                settings.updateSettings({ theme: v })
                setTheme(v)
              }}
            >
              <SelectTrigger className="w-full text-xs capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['light', 'dark', 'system'] as const).map((themeVal) => (
                  <SelectItem key={themeVal} value={themeVal} className="text-xs capitalize">
                    {themeVal}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          <Separator />

          {/* Full Settings Link */}
          <section className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-muted-foreground"
              onClick={() => {
                setOpen(false)
                openSettingsPage('general')
              }}
            >
              <Settings className="size-3.5" />
              {t('dialog.openFullSettings')}
            </Button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
