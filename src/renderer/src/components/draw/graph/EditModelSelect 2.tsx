import { useMemo } from 'react'
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
import { ModelIcon } from '@renderer/components/settings/provider-icons'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { ImageNode } from './graph-types'

export interface EditModelValue {
  providerId: string
  modelId: string
}

function optionValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

/**
 * Default model for editing an image node: the model that generated it,
 * falling back to the globally active image model. Returns null when neither
 * resolves to an existing image-category model.
 */
export function defaultEditModel(node: ImageNode): EditModelValue | null {
  const ps = useProviderStore.getState()
  const pick = (providerId?: string, modelId?: string): EditModelValue | null => {
    if (!providerId || !modelId) return null
    const provider = ps.providers.find((p) => p.id === providerId)
    const model = provider?.models.find((m) => m.id === modelId)
    return model && (model.category ?? 'chat') === 'image' ? { providerId, modelId } : null
  }
  return (
    pick(node.data.providerId, node.data.modelId) ??
    pick(ps.activeImageProviderId ?? undefined, ps.activeImageModelId ?? undefined)
  )
}

interface Props {
  value: EditModelValue | null
  onChange: (value: EditModelValue) => void
  className?: string
}

/** Compact image-model picker for the inpaint/outpaint toolbars. */
export function EditModelSelect({ value, onChange, className }: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const providers = useProviderStore((s) => s.providers)

  const groups = useMemo(
    () =>
      providers
        .map((provider) => ({
          provider,
          models: provider.models.filter((m) => (m.category ?? 'chat') === 'image')
        }))
        .filter((g) => g.models.length > 0),
    [providers]
  )

  return (
    <Select
      value={value ? optionValue(value.providerId, value.modelId) : undefined}
      onValueChange={(next) => {
        const [providerId, modelId] = next.split('::')
        if (providerId && modelId) onChange({ providerId, modelId })
      }}
    >
      <SelectTrigger className={className ?? 'h-7 w-44 text-[11px]'}>
        <SelectValue placeholder={t('drawPage.selectModel', { defaultValue: 'Select model' })} />
      </SelectTrigger>
      <SelectContent>
        {groups.map((group) => (
          <SelectGroup key={group.provider.id}>
            <SelectLabel className="text-[10px]">{group.provider.name}</SelectLabel>
            {group.models.map((model) => (
              <SelectItem
                key={model.id}
                value={optionValue(group.provider.id, model.id)}
                className="text-xs"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <ModelIcon icon={model.icon} size={12} />
                  <span className="truncate">{model.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
