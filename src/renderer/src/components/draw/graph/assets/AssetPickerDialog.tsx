import { Film, ImageOff, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { filePathToMediaUrl } from '@renderer/lib/local-media-url'
import { useAssetStore, type AssetItem } from './asset-store'

export interface PickedAsset {
  src?: string
  filePath: string
  mediaType?: string
  prompt?: string
  kind?: 'image' | 'video'
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (item: PickedAsset) => void
}

export function AssetPickerDialog({ open, onOpenChange, onPick }: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const items = useAssetStore((s) => s.items)
  const removeAsset = useAssetStore((s) => s.removeAsset)

  const pick = (item: AssetItem): void => {
    if (item.kind === 'video') {
      onPick({
        filePath: item.filePath,
        mediaType: item.mediaType,
        prompt: item.prompt,
        kind: 'video'
      })
      onOpenChange(false)
      return
    }
    onPick({
      src: filePathToMediaUrl(item.filePath),
      filePath: item.filePath,
      mediaType: item.mediaType,
      prompt: item.prompt,
      kind: 'image'
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-w-3xl flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('drawPage.myAssets', { defaultValue: 'My materials' })}</DialogTitle>
        </DialogHeader>

        {items.length === 0 ? (
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
            {t('drawPage.assetsEmpty', { defaultValue: 'Save images here from the image toolbar' })}
          </div>
        ) : (
          <div className="grid flex-1 grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
            {items.map((item) => (
              <div
                key={item.id}
                className="group relative aspect-square overflow-hidden rounded-lg border bg-muted/20"
              >
                {item.kind === 'video' ? (
                  <button
                    type="button"
                    onClick={() => pick(item)}
                    className="grid size-full place-items-center gap-1 text-muted-foreground"
                    title={item.prompt}
                  >
                    <Film className="size-6" />
                    <span className="text-[10px]">
                      {t('drawPage.modeVideo', { defaultValue: 'Video' })}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => pick(item)}
                    className="relative size-full"
                    title={item.prompt}
                  >
                    <span className="absolute inset-0 grid place-items-center text-muted-foreground">
                      <ImageOff className="size-5" />
                    </span>
                    <img
                      src={filePathToMediaUrl(item.filePath)}
                      alt=""
                      className="relative size-full object-cover"
                    />
                  </button>
                )}
                <button
                  type="button"
                  title={t('drawPage.deleteRecord', { defaultValue: 'Delete' })}
                  className="absolute right-1 top-1 grid size-6 place-items-center rounded-md bg-black/55 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
                  onClick={() => removeAsset(item.id)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
