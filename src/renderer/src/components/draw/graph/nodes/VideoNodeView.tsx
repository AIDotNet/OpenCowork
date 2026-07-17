import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, BookmarkPlus, Download, Loader2, Play, Sparkles, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { filePathToMediaUrl } from '@renderer/lib/local-media-url'
import type { VideoNode } from '../graph-types'
import { useGraphStore } from '../graph-store'
import { useGraphActions } from '../graph-actions'
import { useAssetStore } from '../assets/asset-store'

interface Props {
  node: VideoNode
}

export function VideoNodeView({ node }: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const actions = useGraphActions()
  const updateNode = useGraphStore((s) => s.updateNode)
  const addAsset = useAssetStore((s) => s.addAsset)
  const { src, filePath, poster, mediaType, generating, status, error, interrupted, jobId } =
    node.data

  const saveToAssets = (): void => {
    if (!filePath) return
    addAsset({
      filePath,
      mediaType: mediaType || 'video/mp4',
      prompt: node.data.prompt,
      createdAt: Date.now(),
      kind: 'video'
    })
    toast.success(t('drawPage.assetSaved', { defaultValue: 'Saved to materials' }))
  }
  const [wantSrc, setWantSrc] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Attach the video when the user asks to play, or when there is no poster
  // yet (so we can capture a first-frame thumbnail once). The oc-media URL
  // streams straight from disk — no size limit, no base64 over IPC.
  const shouldLoad = (wantSrc || !poster) && !!filePath && !src && !generating
  useEffect(() => {
    if (!shouldLoad || !filePath) return
    const url = filePathToMediaUrl(filePath)
    updateNode(node.id, (n) => (n.kind === 'video' ? { ...n, data: { ...n.data, src: url } } : n))
  }, [shouldLoad, filePath, node.id, updateNode])

  // Capture a first-frame poster once the video has a decodable frame.
  const capturePoster = useCallback(() => {
    if (poster) return
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const scale = Math.min(1, 480 / video.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
    updateNode(node.id, (n) =>
      n.kind === 'video' ? { ...n, data: { ...n.data, poster: dataUrl } } : n
    )
  }, [node.id, poster, updateNode])

  const stop = useCallback(async () => {
    if (jobId) await ipcClient.invoke(IPC.SEEDANCE_VIDEO_CANCEL, { jobId })
    updateNode(node.id, (n) =>
      n.kind === 'video'
        ? { ...n, data: { ...n.data, generating: false, status: undefined, interrupted: true } }
        : n
    )
  }, [jobId, node.id, updateNode])

  const download = async (): Promise<void> => {
    if (!filePath) return
    try {
      const result = (await ipcClient.invoke(IPC.FS_DOWNLOAD_FILE_COPY, {
        sourcePath: filePath,
        defaultName: 'video.mp4',
        filters: [{ name: 'Video', extensions: ['mp4', 'webm'] }]
      })) as { success?: boolean; canceled?: boolean; error?: string }
      if (result.canceled) return
      if (!result.success) throw new Error(result.error || 'copy failed')
      toast.success(t('drawPage.downloadSuccess'))
    } catch (err) {
      toast.error(t('drawPage.downloadFailed'), {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return (
    <div className="group/video relative h-full w-full bg-black/40">
      {src ? (
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          controls
          crossOrigin="anonymous"
          onLoadedData={capturePoster}
          className="h-full w-full rounded-xl object-contain"
        />
      ) : generating ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-white/80">
          <Loader2 className="size-6 animate-spin" />
          <span className="text-xs">
            {status
              ? t(`drawPage.videoStatus.${status}`, { defaultValue: status })
              : t('drawPage.generating')}
          </span>
          <button
            type="button"
            data-nodrag
            onClick={() => void stop()}
            className="mt-1 flex items-center gap-1.5 rounded-md bg-white/15 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/25"
          >
            <Square className="size-3" />
            {t('drawPage.stop', { defaultValue: 'Stop' })}
          </button>
        </div>
      ) : poster ? (
        <button
          type="button"
          data-nodrag
          onClick={() => setWantSrc(true)}
          className="relative h-full w-full"
        >
          <img src={poster} alt="" className="h-full w-full rounded-xl object-contain" />
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid size-11 place-items-center rounded-full bg-black/55 text-white">
              <Play className="size-5" />
            </span>
          </span>
        </button>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
          <button
            type="button"
            data-nodrag
            onClick={() => actions.generateVideoNode(node.id)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Sparkles className="size-3.5" />
            {t('drawPage.generate')}
          </button>
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
            onClick={() => actions.generateVideoNode(node.id)}
          >
            {t('drawPage.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      )}

      {(src || poster) && !generating && (
        <div
          data-nodrag
          className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover/video:opacity-100"
        >
          <button
            type="button"
            title={t('drawPage.variation', { defaultValue: 'Regenerate' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => actions.generateVideoNode(node.id)}
          >
            <Sparkles className="size-3.5" />
          </button>
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
            title={t('drawPage.downloadGif', { defaultValue: 'Download' })}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
            onClick={() => void download()}
          >
            <Download className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
