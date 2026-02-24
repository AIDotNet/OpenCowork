import { useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { ProviderIcon, ModelIcon } from '@renderer/components/settings/provider-icons'
import { cn } from '@renderer/lib/utils'

export function ModelSwitcher(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [open, setOpen] = useState(false)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const providers = useProviderStore((s) => s.providers)
  const setActiveProvider = useProviderStore((s) => s.setActiveProvider)
  const setActiveModel = useProviderStore((s) => s.setActiveModel)
  const hasCustomPrompt = useSettingsStore((s) => !!s.systemPrompt)

  const enabledProviders = providers.filter((p) => p.enabled)
  const activeProvider = providers.find((p) => p.id === activeProviderId)
  const shortName = (activeModelId.split('/').pop()?.replace(/-\d{8}$/, '') ?? activeModelId) || t('topbar.noModel')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors truncate max-w-[200px] rounded px-1.5 py-0.5 hover:bg-muted/40"
          title={`${activeModelId || t('topbar.noModel')} (${t('topbar.clickToSwitch')})`}
        >
          <ModelIcon icon={activeProvider?.models.find((m) => m.id === activeModelId)?.icon} modelId={activeModelId} providerBuiltinId={activeProvider?.builtinId} size={14} />
          {shortName}
          {hasCustomPrompt && <span className="size-1.5 rounded-full bg-violet-400/60 shrink-0" title={t('topbar.customPromptActive')} />}
          <ChevronDown className="size-2.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1 max-h-80 overflow-y-auto" align="start">
        {enabledProviders.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('topbar.noProviders')}</div>
        ) : (
          enabledProviders.map((provider) => {
            const models = provider.models.filter((m) => m.enabled)
            return (
              <div key={provider.id}>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50 px-2 py-1 uppercase tracking-wider">
                  <ProviderIcon builtinId={provider.builtinId} size={12} />
                  {provider.name}
                </div>
                {models.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground/40">{t('topbar.noModels')}</div>
                ) : (
                  models.map((m) => {
                    const isActive = provider.id === activeProviderId && m.id === activeModelId
                    return (
                      <button
                        key={`${provider.id}-${m.id}`}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors',
                          isActive && 'bg-muted/40 font-medium'
                        )}
                        onClick={() => {
                          const newProviderId = provider.id
                          if (newProviderId !== activeProviderId) {
                            setActiveProvider(newProviderId)
                          }
                          setActiveModel(m.id)
                          // Bind model selection to the current session
                          const sessionId = useChatStore.getState().activeSessionId
                          if (sessionId) {
                            useChatStore.getState().updateSessionModel(sessionId, newProviderId, m.id)
                          }
                          setOpen(false)
                        }}
                      >
                        {isActive ? <Check className="size-3 text-primary" /> : <ModelIcon icon={m.icon} modelId={m.id} providerBuiltinId={provider.builtinId} size={12} className="opacity-60" />}
                        <span className="truncate">{m.name || m.id.replace(/-\d{8}$/, '')}</span>
                      </button>
                    )
                  })
                )}
              </div>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}
