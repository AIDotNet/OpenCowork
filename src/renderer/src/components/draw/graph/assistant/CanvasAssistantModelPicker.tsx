import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { ModelIcon, ProviderIcon } from '@renderer/components/settings/provider-icons'
import {
  getEnabledModelsByCategory,
  isProviderAvailableForModelSelection,
  useProviderStore
} from '@renderer/stores/provider-store'
import type { AIModelConfig, AIProvider } from '@renderer/lib/api/types'
import { cn } from '@renderer/lib/utils'

interface ModelSelection {
  providerId: string
  modelId: string
}

interface ProviderGroup {
  provider: AIProvider
  models: AIModelConfig[]
}

interface Props {
  value?: ModelSelection
  onChange: (selection: ModelSelection) => void
  placeholder: string
}

/**
 * Compact provider-first model picker used by the canvas assistant.
 * The interaction mirrors the chat composer: search providers/models, then
 * open a provider's model list as a secondary menu.
 */
export function CanvasAssistantModelPicker({
  value,
  onChange,
  placeholder
}: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const providers = useProviderStore((s) => s.providers)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selectedProvider = providers.find((provider) => provider.id === value?.providerId)
  const selectedModel = selectedProvider?.models.find((model) => model.id === value?.modelId)

  const groups = useMemo<ProviderGroup[]>(() => {
    const query = search.trim().toLowerCase()
    return providers
      .filter((provider) => isProviderAvailableForModelSelection(provider))
      .map((provider) => {
        const models = getEnabledModelsByCategory(provider, 'chat').filter((model) => {
          if (!query) return true
          const modelName = (model.name || model.id).toLowerCase()
          return modelName.includes(query) || provider.name.toLowerCase().includes(query)
        })
        return { provider, models }
      })
      .filter((group) => group.models.length > 0)
  }, [providers, search])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    setSelectedProviderId(null)
  }, [])

  useEffect(() => {
    if (!open) {
      setSearch('')
      return
    }
    const timer = window.setTimeout(() => searchRef.current?.focus(), 50)
    return () => window.clearTimeout(timer)
  }, [open])

  const chooseModel = useCallback(
    (provider: AIProvider, model: AIModelConfig) => {
      onChange({ providerId: provider.id, modelId: model.id })
      setOpen(false)
      setSelectedProviderId(null)
    },
    [onChange]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 min-w-0 w-full items-center gap-1.5 rounded-md border bg-background px-2 text-left text-[11px] transition-colors hover:bg-muted/60"
          aria-label={selectedModel?.name || selectedModel?.id || placeholder}
        >
          <ModelIcon
            icon={selectedModel?.icon}
            modelId={selectedModel?.id}
            providerBuiltinId={selectedProvider?.builtinId}
            size={14}
            className="shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">
            {selectedModel?.name || selectedModel?.id || placeholder}
          </span>
          <ChevronRight className="size-3 shrink-0 rotate-90 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 max-w-[calc(100vw-2rem)] overflow-visible p-0"
        align="start"
        sideOffset={6}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground/60" />
          <input
            ref={searchRef}
            type="text"
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/40"
            placeholder={t('topbar.searchModel', { defaultValue: 'Search models...' })}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="border-b px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          {t('topbar.providers', { defaultValue: 'Providers' })}
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1">
          {groups.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground/60">
              {providers.some((provider) => isProviderAvailableForModelSelection(provider))
                ? t('topbar.noModels', { defaultValue: 'No models' })
                : t('topbar.noProviders', { defaultValue: 'No providers available' })}
            </div>
          ) : (
            groups.map(({ provider, models }) => {
              const isSelected = provider.id === selectedProviderId
              const isCurrentProvider = provider.id === value?.providerId
              return (
                <Popover
                  key={provider.id}
                  open={isSelected}
                  onOpenChange={(nextOpen) => {
                    if (nextOpen) setSelectedProviderId(provider.id)
                  }}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/70',
                        isSelected && 'bg-background shadow-sm',
                        isCurrentProvider && !isSelected && 'text-primary'
                      )}
                      onFocus={() => setSelectedProviderId(provider.id)}
                      onMouseEnter={() => setSelectedProviderId(provider.id)}
                      onClick={() => setSelectedProviderId(provider.id)}
                    >
                      <ProviderIcon builtinId={provider.builtinId} size={16} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {provider.name}
                      </span>
                      <span
                        className={cn(
                          'rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground',
                          isCurrentProvider && 'bg-primary/10 text-primary'
                        )}
                      >
                        {models.length}
                      </span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-1"
                    align="start"
                    side="right"
                    sideOffset={6}
                  >
                    <div className="sticky top-0 z-10 mb-1 flex items-center gap-2 border-b bg-popover/95 px-2 py-1.5 backdrop-blur">
                      <ProviderIcon builtinId={provider.builtinId} size={14} />
                      <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                        {provider.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/50">
                        {t('topbar.modelsCount', {
                          count: models.length,
                          defaultValue: '{{count}} models'
                        })}
                      </span>
                    </div>
                    <div className="max-h-[344px] overflow-y-auto">
                      {models.map((model) => {
                        const isActive =
                          provider.id === value?.providerId && model.id === value?.modelId
                        return (
                          <button
                            key={`${provider.id}-${model.id}`}
                            type="button"
                            className={cn(
                              'group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/60',
                              isActive && 'bg-primary/5'
                            )}
                            onClick={() => chooseModel(provider, model)}
                          >
                            <span className="shrink-0">
                              {isActive ? (
                                <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                                  <Check className="size-3 text-primary" />
                                </span>
                              ) : (
                                <ModelIcon
                                  icon={model.icon}
                                  modelId={model.id}
                                  providerBuiltinId={provider.builtinId}
                                  size={20}
                                />
                              )}
                            </span>
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate text-xs',
                                isActive
                                  ? 'font-semibold text-primary'
                                  : 'text-foreground/80 group-hover:text-foreground'
                              )}
                            >
                              {model.name || model.id}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
