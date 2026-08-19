import { useTranslation } from 'react-i18next'
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
  isProviderAvailableForModelSelection,
  useProviderStore
} from '@renderer/stores/provider-store'
import { ModelIcon } from './provider-icons'

export interface ChatModelRef {
  providerId: string
  modelId: string
}

const INHERIT_VALUE = '__inherit__'

interface ChatModelSelectProps {
  value: ChatModelRef | null
  onChange: (next: ChatModelRef | null) => void
  /** Label for the "fall back to the session model" option. */
  inheritLabel: string
  placeholder?: string
  emptyHint?: string
  className?: string
  id?: string
}

/**
 * Grouped provider → chat model picker. Shared so panels outside the Models page
 * can bind a model without duplicating provider filtering.
 */
export function ChatModelSelect({
  value,
  onChange,
  inheritLabel,
  placeholder,
  emptyHint,
  className,
  id
}: ChatModelSelectProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const providers = useProviderStore((s) => s.providers)

  const groups = providers
    .filter((provider) => isProviderAvailableForModelSelection(provider))
    .map((provider) => ({
      provider,
      models: provider.models.filter(
        (model) => model.enabled && (!model.category || model.category === 'chat')
      )
    }))
    .filter((group) => group.models.length > 0)

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/60">
        {emptyHint ?? t('model.noModelsHint', { defaultValue: 'No models available yet.' })}
      </p>
    )
  }

  const isKnownModel =
    value !== null &&
    groups.some(
      ({ provider, models }) =>
        provider.id === value.providerId && models.some((model) => model.id === value.modelId)
    )
  const selectedValue = isKnownModel && value ? `${value.providerId}::${value.modelId}` : INHERIT_VALUE

  return (
    <Select
      value={selectedValue}
      onValueChange={(next) => {
        if (next === INHERIT_VALUE) {
          onChange(null)
          return
        }
        const [providerId, modelId] = next.split('::')
        onChange(providerId && modelId ? { providerId, modelId } : null)
      }}
    >
      <SelectTrigger id={id} className={className ?? 'w-80 max-w-full text-xs'}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT_VALUE} className="text-xs">
          {inheritLabel}
        </SelectItem>
        {groups.map(({ provider, models }) => (
          <SelectGroup key={provider.id}>
            <SelectLabel className="text-[10px] uppercase tracking-wide">
              {provider.name}
            </SelectLabel>
            {models.map((model) => (
              <SelectItem
                key={`${provider.id}-${model.id}`}
                value={`${provider.id}::${model.id}`}
                className="text-xs"
              >
                <div className="flex items-center gap-2">
                  <ModelIcon
                    icon={model.icon}
                    modelId={model.id}
                    providerBuiltinId={provider.builtinId}
                    size={16}
                    className="text-muted-foreground/70"
                  />
                  <div className="flex flex-col text-left">
                    <span>{model.name}</span>
                    <span className="text-[10px] text-muted-foreground/60">{model.id}</span>
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
