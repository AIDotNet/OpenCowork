import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FolderOpen, Loader2, Monitor, PawPrint, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { CapybaraSprite } from '@renderer/components/pet/CapybaraSprite'
import { loadPetImageDataUrl } from '@renderer/components/pet/use-pet-skin-images'
import { usePetSkinStore, type PetSkin } from '@renderer/stores/pet-skin-store'
import { usePetWindowOpen } from './use-pet-window-open'

function SkinThumb({ skin }: { skin: PetSkin }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    const idlePath = skin.poses.idle ?? Object.values(skin.poses)[0]
    if (!idlePath) return
    let disposed = false
    void loadPetImageDataUrl(idlePath).then((url) => {
      if (!disposed) setSrc(url)
    })
    return () => {
      disposed = true
    }
  }, [skin])

  return src ? (
    <img src={src} alt={skin.name} className="size-12 rounded-lg object-contain" />
  ) : (
    <div className="flex size-12 items-center justify-center rounded-lg bg-muted">
      <PawPrint className="size-4 text-muted-foreground" />
    </div>
  )
}

export function PetSkinsTab(): React.JSX.Element {
  const { t } = useTranslation('pet')
  const skins = usePetSkinStore((s) => s.skins)
  const activeSkinId = usePetSkinStore((s) => s.activeSkinId)
  const scanning = usePetSkinStore((s) => s.scanning)
  const petsDir = usePetSkinStore((s) => s.petsDir)
  const { open, busy, toggle } = usePetWindowOpen()

  useEffect(() => {
    void usePetSkinStore.getState().scan()
  }, [])

  // The broadcast carries the target id: the pet window applies it directly
  // instead of re-reading storage, which races with the async persist write
  // and would show the previous skin.
  const bindSkin = (id: string | null): void => {
    usePetSkinStore.getState().setActiveSkin(id)
    void ipcClient.invoke('pet:sync', { kind: 'skin', payload: { activeSkinId: id } })
  }

  const deleteSkin = async (skin: PetSkin): Promise<void> => {
    await ipcClient.invoke('shell:trashPath', skin.path)
    if (usePetSkinStore.getState().activeSkinId === skin.id) {
      usePetSkinStore.getState().setActiveSkin(null)
    }
    await usePetSkinStore.getState().scan()
    void ipcClient.invoke('pet:sync', {
      kind: 'skin',
      payload: { activeSkinId: usePetSkinStore.getState().activeSkinId }
    })
  }

  return (
    <div className="space-y-3">
      <section className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/30 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('panel.enable')}</p>
            <p className="text-[11px] text-muted-foreground">
              {t(open ? 'panel.displayOn' : 'panel.displayOff')}
            </p>
          </div>
        </div>
        <Switch checked={open} disabled={busy} onCheckedChange={(v) => void toggle(v)} />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="break-all text-[11px] text-muted-foreground">{petsDir ?? ''}</p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              if (petsDir) void ipcClient.invoke('shell:openPath', petsDir)
            }}
          >
            <FolderOpen className="mr-1 size-3" />
            {t('studio.openFolder')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={scanning}
            onClick={() => void usePetSkinStore.getState().scan()}
          >
            {scanning ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 size-3" />
            )}
            {t('studio.refresh')}
          </Button>
        </div>
      </div>

      <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {t('studio.dropHint')}
      </p>

      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-2">
        <div className="flex size-12 items-center justify-center overflow-hidden rounded-lg">
          <CapybaraSprite
            activity="idle"
            facing="right"
            mood={90}
            cleanliness={90}
            width={46}
            disableSkin
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{t('studio.defaultSkin')}</p>
        </div>
        {activeSkinId === null ? (
          <span className="flex items-center gap-1 text-xs text-emerald-500">
            <Check className="size-3.5" />
            {t('studio.inUse')}
          </span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => bindSkin(null)}
          >
            {t('studio.use')}
          </Button>
        )}
      </div>

      {skins.map((skin) => (
        <div
          key={skin.id}
          className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-2"
        >
          <SkinThumb skin={skin} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{skin.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {skin.id}
              {skin.modelId ? ` · ${skin.modelId}` : ''} ·{' '}
              {t('studio.poseCount', { count: Object.keys(skin.poses).length })}
            </p>
          </div>
          {activeSkinId === skin.id ? (
            <span className="flex items-center gap-1 text-xs text-emerald-500">
              <Check className="size-3.5" />
              {t('studio.inUse')}
            </span>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs"
              onClick={() => bindSkin(skin.id)}
            >
              {t('studio.use')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-muted-foreground hover:text-red-400"
            onClick={() => void deleteSkin(skin)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  )
}
