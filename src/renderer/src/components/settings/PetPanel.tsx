import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { PetOverviewTab } from './pet/PetOverviewTab'
import { PetStatsTab } from './pet/PetStatsTab'
import { PetStudioTab } from './pet/PetStudioTab'
import { PetSkinsTab } from './pet/PetSkinsTab'
import { PetMemoryTab } from './pet/PetMemoryTab'
import { PetAgentTab } from './pet/PetAgentTab'

const PET_TABS = ['overview', 'stats', 'studio', 'skins', 'memory', 'agent'] as const
type PetTab = (typeof PET_TABS)[number]

export function PetPanel(): React.JSX.Element {
  const { t } = useTranslation('pet')
  const [tab, setTab] = useState<PetTab>('overview')

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PET_TABS.map((id) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={tab === id ? 'default' : 'outline'}
            className="h-8 text-xs"
            onClick={() => setTab(id)}
          >
            {t(`tabs.${id}`)}
          </Button>
        ))}
      </div>

      {/* Tabs stay mounted so an in-flight generation survives tab switches.
          Only the studio uses the full panel width; the rest keep the
          standard narrow settings column. */}
      <div className={tab === 'overview' ? 'max-w-2xl' : 'hidden'}>
        <PetOverviewTab />
      </div>
      <div className={tab === 'stats' ? 'max-w-2xl' : 'hidden'}>
        <PetStatsTab />
      </div>
      <div className={tab === 'studio' ? '' : 'hidden'}>
        <PetStudioTab />
      </div>
      <div className={tab === 'skins' ? 'max-w-2xl' : 'hidden'}>
        <PetSkinsTab />
      </div>
      <div className={tab === 'memory' ? 'max-w-2xl' : 'hidden'}>
        <PetMemoryTab />
      </div>
      <div className={tab === 'agent' ? 'max-w-2xl' : 'hidden'}>
        <PetAgentTab />
      </div>
    </div>
  )
}
