import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, Server } from 'lucide-react'
import { ModelManagementPanel, ProviderPanel } from '../ProviderPanel'
import { SettingsSegmented } from '../settings-primitives'

type ProviderView = 'providers' | 'catalog'

/**
 * Providers and the global model catalog are two views of the same job ("what
 * models can I use"), so they share one sidebar entry.
 */
export function ProviderWorkbenchPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [view, setView] = useState<ProviderView>('providers')

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-background/60 px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{t('provider.title')}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {view === 'providers' ? t('provider.subtitle') : t('provider.modelManagementDesc')}
          </p>
        </div>
        <SettingsSegmented<ProviderView>
          value={view}
          onChange={setView}
          options={[
            {
              value: 'providers',
              label: t('provider.title'),
              icon: <Server className="size-3.5" />
            },
            {
              value: 'catalog',
              label: t('provider.modelManagement'),
              icon: <Layers className="size-3.5" />
            }
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'providers' ? <ProviderPanel /> : <ModelManagementPanel />}
      </div>
    </div>
  )
}
