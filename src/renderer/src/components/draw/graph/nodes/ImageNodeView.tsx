import {
  AlertCircle,
  BookmarkPlus,
  Brush,
  Clipboard,
  Crop,
  Download,
  Expand,
  Layers,
  Loader2,
  Maximize2,
  RotateCw,
  Sparkles
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import type { ImageNode } from '../graph-types'
import { useGraphStore } from '../graph-store'
import { useGraphActions } from '../graph-actions'
import { useAssetStore } from '../assets/asset-store'

interface Props {
  node: ImageNode
}

export function ImageNodeView({ node }: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const actions = useGraphActions()
  const setEditing = useGraphStore((s) => s.setEditing)
  const addAsset = useAssetStore((s) => s.addAsset)
  const { src, generating, error, interrupted, groupSrcs, filePath } = node.data
  const hasGroup = !!groupSrcs && groupSrcs.length > 1

  const saveToAssets = (): void => {
    if (!filePath) {
      toast.error(t('drawPage.assetNeedsFile', { defaultValue: 'Only saved images can be added' }))
      return
    }
    addAsset({
      filePath,
      mediaType: node.data.mediaType,
      prompt: node.data.prompt,
      createdAt: Date.now()
    })
    toast.success(t('drawPage.assetSaved', { defaultValue: 'Saved to materials' }))
  }

  const copyToClipboard = async (): Promise<void> => {
    try {
      let base64: string | undefined
      if (src?.startsWith('data:')) {
        base64 = src.slice(src.indexOf(',') + 1)
      } else if (filePath) {
        const res = (await ipcClient.invoke(IPC.FS_READ_FILE_BINARY, { path: filePath })) as {
          data?: string
        }
        base64 = res?.data
      }
      if (!base64) return
      const res = (await ipcClient.invoke(IPC.CLIPBOARD_WRITE_IMAGE, { data: base64 })) as {
        error?: string
      }
      if (res?.error) throw new Error(res.error)
      toast.success(t('drawPage.copiedImage', { defaultValue: 'Image copied' }))
    } catch (err) {
      toast.error(t('drawPage.copyFailed', { defaultValue: 'Copy failed' }), {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return (
    <div className="group/image relative h-full w-full">
      {src ? (
        <img
          src={src}
          alt={node.data.prompt ?? ''}
          className="h-full w-full rounded-xl object-cover"
          draggable={false}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
          {!generating && (
            <button
              type="button"
              data-nodrag
              onClick={() => actions.generateImageNode(node.id)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Sparkles className="size-3.5" />
              {t('drawPage.generate')}
            </button>
          )}
        </div>
      )}

      {/* stacked-group indicator */}
      {hasGroup && (
        <>
          <div className="pointer-events-none absolute -bottom-1.5 -right-1.5 -z-10 h-full w-full rounded-xl border bg-card" />
          <div className="absolute right-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {groupSrcs!.length}
          </div>
        </>
      )}

      {generating && (
        <div className="absolute inset-0 grid place-items-center rounded-xl bg-background/60 backdrop-blur-sm">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      )}

      {error && !generating && (
        <div className="absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded-md bg-destructive/90 px-2 py-1 text-[11px] text-white">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {interrupted && !error && !generating && (
        <div
          data-nodrag
          className="absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded-md bg-amber-600/90 px-2 py-1 text-[11px] text-white"
        >
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="truncate">
            {t('drawPage.interrupted', {
              defaultValue: 'The previous generation was interrupted.'
            })}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded bg-white/20 px-1.5 py-0.5 font-medium hover:bg-white/30"
            onClick={() => actions.generateImageNode(node.id)}
          >
            {t('drawPage.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      )}

      {/* hover toolbar */}
      {src && !generating && (
        <div
          data-nodrag
          className={cn(
            'absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity',
            'group-hover/image:opacity-100'
          )}
        >
          <button
            type="button"
            title={t('drawPage.variation', { defaultValue: 'Variation' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => actions.generateImageNode(node.id)}
          >
            <Sparkles className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.inpaint', { defaultValue: 'Edit area' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => setEditing({ nodeId: node.id, mode: 'mask' })}
          >
            <Brush className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.outpaint', { defaultValue: 'Expand' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => setEditing({ nodeId: node.id, mode: 'outpaint' })}
          >
            <Expand className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.crop', { defaultValue: 'Crop' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => setEditing({ nodeId: node.id, mode: 'crop' })}
          >
            <Crop className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.angleTransform', { defaultValue: 'Transform' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => setEditing({ nodeId: node.id, mode: 'angle' })}
          >
            <RotateCw className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.upscale', { defaultValue: 'Upscale' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => setEditing({ nodeId: node.id, mode: 'upscale' })}
          >
            <Maximize2 className="size-3.5" />
          </button>
          {hasGroup && (
            <button
              type="button"
              title={t('drawPage.splitGroup', { defaultValue: 'Image group' })}
              className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
              onClick={() => setEditing({ nodeId: node.id, mode: 'split' })}
            >
              <Layers className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            title={t('drawPage.saveToAssets', { defaultValue: 'Save to materials' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={saveToAssets}
          >
            <BookmarkPlus className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.copyImage', { defaultValue: 'Copy to clipboard' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => void copyToClipboard()}
          >
            <Clipboard className="size-3.5" />
          </button>
          <button
            type="button"
            title={t('drawPage.downloadGif', { defaultValue: 'Download' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => actions.downloadImage(node.id)}
          >
            <Download className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
