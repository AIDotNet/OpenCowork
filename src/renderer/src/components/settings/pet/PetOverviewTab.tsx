import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { CapybaraSprite } from '@renderer/components/pet/CapybaraSprite'
import { getPetLevel, usePetStore } from '@renderer/stores/pet-store'
import { usePetExpStore } from '@renderer/stores/pet-exp-store'
import { usePetWindowOpen } from './use-pet-window-open'

export function PetOverviewTab(): React.JSX.Element {
  const { t } = useTranslation('pet')
  const { open, busy, toggle } = usePetWindowOpen()

  const petName = usePetStore((s) => s.name)
  const growth = usePetStore((s) => s.growth)
  const coins = usePetStore((s) => s.coins)
  const adoptedAt = usePetStore((s) => s.adoptedAt)
  const totalExp = usePetExpStore((s) => s.totalExp)
  const [nameDraft, setNameDraft] = useState(petName)

  useEffect(() => setNameDraft(petName), [petName])

  const saveName = async (): Promise<void> => {
    const name = nameDraft.trim()
    if (!name) return
    // Pull the freshest persisted stats before writing, so a stale settings
    // window doesn't roll back progress made by the pet window.
    await usePetStore.persist.rehydrate()
    usePetStore.setState({ name })
    void ipcClient.invoke('pet:sync', { kind: 'profile', payload: { name } })
    toast.success(t('basic.saved'))
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-center rounded-2xl border border-border/60 bg-muted/30 py-6">
        <CapybaraSprite activity="idle" facing="right" mood={90} cleanliness={90} width={150} />
      </div>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('panel.enable')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('panel.enableDesc')}</p>
          </div>
          <Switch checked={open} disabled={busy} onCheckedChange={(v) => void toggle(v)} />
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <p className="text-sm font-medium">{t('basic.title')}</p>
        <div className="flex items-center gap-2">
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={t('basic.namePlaceholder')}
            maxLength={20}
            className="h-8 max-w-52 text-sm"
          />
          <Button
            size="sm"
            variant="secondary"
            className="h-8"
            disabled={!nameDraft.trim() || nameDraft.trim() === petName}
            onClick={() => void saveName()}
          >
            {t('basic.save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('basic.summary', {
            level: getPetLevel(growth + totalExp),
            coins: Math.floor(coins),
            date: new Date(adoptedAt).toLocaleDateString()
          })}
        </p>
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">{t('panel.hint')}</p>
    </div>
  )
}
