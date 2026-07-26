import * as React from 'react'
import { Eraser, Loader2, Pencil, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Slider } from '@renderer/components/ui/slider'
import { Textarea } from '@renderer/components/ui/textarea'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { useImageEditStore, type ImageEditMode } from '@renderer/stores/image-edit-store'
import {
  buildMaskDataUrl,
  drawMaskStroke,
  getRelativePoint,
  type ImageSize,
  type MaskStroke
} from '@renderer/lib/image-mask'

const DEFAULT_BRUSH_SIZE = 72
const MIN_BRUSH_SIZE = 16
const MAX_BRUSH_SIZE = 192
const MASK_PREVIEW_COLOR = 'rgba(239, 68, 68, 0.45)'

interface ImageEditDialogProps {
  sessionId?: string | null
}

function buildDialogTitle(t: ReturnType<typeof useTranslation>['t'], mode: ImageEditMode): string {
  return mode === 'mask'
    ? t('assistantMessage.maskEditImage', { defaultValue: 'Mask edit' })
    : t('assistantMessage.editImage', { defaultValue: 'Edit image' })
}

export function ImageEditDialog({ sessionId }: ImageEditDialogProps): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const { sendMessage } = useChatActions()
  const open = useImageEditStore((state) => state.open && state.sessionId === sessionId)
  const image = useImageEditStore((state) => state.image)
  const initialMode = useImageEditStore((state) => state.mode)
  const closeEditor = useImageEditStore((state) => state.closeEditor)
  const [prompt, setPrompt] = React.useState('')
  const [editorMode, setEditorMode] = React.useState<ImageEditMode>('edit')
  const [brushSize, setBrushSize] = React.useState(DEFAULT_BRUSH_SIZE)
  const [imageSize, setImageSize] = React.useState<ImageSize | null>(null)
  const [strokes, setStrokes] = React.useState<MaskStroke[]>([])
  const [currentStroke, setCurrentStroke] = React.useState<MaskStroke | null>(null)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const currentStrokeRef = React.useRef<MaskStroke | null>(null)
  const activePointerIdRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (!open || !image) return

    currentStrokeRef.current = null
    activePointerIdRef.current = null
    setPrompt('')
    setEditorMode(initialMode)
    setBrushSize(DEFAULT_BRUSH_SIZE)
    setStrokes([])
    setCurrentStroke(null)
    setImageSize(null)
  }, [image, initialMode, open])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageSize) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const stroke of strokes) {
      drawMaskStroke(ctx, stroke, MASK_PREVIEW_COLOR)
    }
    if (currentStroke) {
      drawMaskStroke(ctx, currentStroke, MASK_PREVIEW_COLOR)
    }
  }, [currentStroke, imageSize, strokes])

  const clearMask = React.useCallback(() => {
    currentStrokeRef.current = null
    activePointerIdRef.current = null
    setCurrentStroke(null)
    setStrokes([])
  }, [])

  const finishStroke = React.useCallback(
    (target?: HTMLCanvasElement | null, pointerId?: number): void => {
      if (target && pointerId !== undefined && target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId)
      }

      const stroke = currentStrokeRef.current
      if (stroke?.points.length) {
        setStrokes((current) => [...current, stroke])
      }

      currentStrokeRef.current = null
      activePointerIdRef.current = null
      setCurrentStroke(null)
    },
    []
  )

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      if (editorMode !== 'mask' || !imageSize) return

      const point = getRelativePoint(event, imageSize)
      if (!point) return

      event.preventDefault()
      const nextStroke = {
        size: brushSize,
        points: [point]
      }

      activePointerIdRef.current = event.pointerId
      currentStrokeRef.current = nextStroke
      setCurrentStroke(nextStroke)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [brushSize, editorMode, imageSize]
  )

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      if (editorMode !== 'mask' || activePointerIdRef.current !== event.pointerId || !imageSize) {
        return
      }

      const point = getRelativePoint(event, imageSize)
      const activeStroke = currentStrokeRef.current
      if (!point || !activeStroke) return

      event.preventDefault()
      const nextStroke = {
        ...activeStroke,
        points: [...activeStroke.points, point]
      }
      currentStrokeRef.current = nextStroke
      setCurrentStroke(nextStroke)
    },
    [editorMode, imageSize]
  )

  const handleSubmit = React.useCallback(async (): Promise<void> => {
    if (!open || !sessionId || !image || !prompt.trim()) return

    const pendingStrokes =
      currentStrokeRef.current && currentStrokeRef.current.points.length > 0
        ? [...strokes, currentStrokeRef.current]
        : strokes
    const maskDataUrl =
      editorMode === 'mask' && imageSize ? buildMaskDataUrl(imageSize, pendingStrokes) : undefined

    setIsSubmitting(true)
    try {
      await sendMessage(prompt.trim(), [image], undefined, sessionId, undefined, undefined, {
        clearCompletedTasksOnTurnStart: true,
        imageEdit: editorMode === 'mask' ? { maskDataUrl } : {}
      })
      closeEditor()
    } catch (error) {
      console.error('Image edit failed:', error)
    } finally {
      setIsSubmitting(false)
    }
  }, [closeEditor, editorMode, image, imageSize, open, prompt, sendMessage, sessionId, strokes])

  const handleImageLoad = React.useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>): void => {
      const { naturalWidth, naturalHeight } = event.currentTarget
      if (!naturalWidth || !naturalHeight) return

      setImageSize((current) => {
        if (current?.width === naturalWidth && current.height === naturalHeight) {
          return current
        }
        return {
          width: naturalWidth,
          height: naturalHeight
        }
      })
    },
    []
  )

  const hasMask = strokes.length > 0 || Boolean(currentStroke)
  const canSubmit =
    open &&
    !!image &&
    !!sessionId &&
    prompt.trim().length > 0 &&
    !isSubmitting &&
    (editorMode !== 'mask' || (Boolean(imageSize) && hasMask))

  if (!image) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeEditor()
        }
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-6xl overflow-y-auto overflow-x-hidden border-white/10 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-6xl">
        <div className="grid min-h-0 gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="border-b bg-gradient-to-br from-muted/40 via-muted/10 to-background p-5 lg:border-r lg:border-b-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={editorMode === 'edit' ? 'default' : 'outline'}
                  onClick={() => setEditorMode('edit')}
                >
                  <Pencil className="size-4" />
                  <span className="flex flex-col items-start gap-0.5">
                    <span>{t('assistantMessage.editImage', { defaultValue: 'Edit image' })}</span>
                    <span className="text-[10px] font-normal opacity-70">Describe a change</span>
                  </span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={editorMode === 'mask' ? 'default' : 'outline'}
                  onClick={() => setEditorMode('mask')}
                >
                  <Eraser className="size-4" />
                  <span className="flex flex-col items-start gap-0.5">
                    <span>{t('assistantMessage.maskEditImage', { defaultValue: 'Mask edit' })}</span>
                    <span className="text-[10px] font-normal opacity-70">Paint the area</span>
                  </span>
                </Button>
              </div>
              {editorMode === 'mask' ? (
                <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
                  <span className="text-xs text-muted-foreground">
                    {t('assistantMessage.maskBrush', { defaultValue: 'Brush' })}
                  </span>
                  <Slider
                    className="w-full max-w-36"
                    min={MIN_BRUSH_SIZE}
                    max={MAX_BRUSH_SIZE}
                    step={1}
                    value={[brushSize]}
                    onValueChange={([nextValue]) => {
                      if (typeof nextValue === 'number') {
                        setBrushSize(nextValue)
                      }
                    }}
                  />
                  <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                    {brushSize}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={clearMask}
                    disabled={!hasMask}
                  >
                    <RotateCcw className="size-4" />
                    {t('action.clear', { ns: 'common', defaultValue: 'Clear' })}
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="flex min-h-[280px] items-center justify-center rounded-xl border border-white/10 bg-black/20 p-4 shadow-inner sm:min-h-[360px]">
              <div className="relative inline-block max-w-full">
                <img
                  src={image.dataUrl}
                  alt={buildDialogTitle(t, editorMode)}
                  className="block max-h-[58vh] max-w-full rounded-md object-contain shadow-sm sm:max-h-[62vh]"
                  onLoad={handleImageLoad}
                />
                {editorMode === 'mask' && imageSize ? (
                  <canvas
                    ref={canvasRef}
                    width={imageSize.width}
                    height={imageSize.height}
                    className="absolute inset-0 h-full w-full touch-none cursor-crosshair rounded-md"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={(event) => finishStroke(event.currentTarget, event.pointerId)}
                    onPointerCancel={(event) => finishStroke(event.currentTarget, event.pointerId)}
                  />
                ) : null}
                {editorMode === 'mask' ? (
                  <div className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-inset ring-black/10" />
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex min-h-[420px] flex-col bg-background/80 p-6">
            <DialogHeader className="space-y-2 text-left">
              <DialogTitle>{buildDialogTitle(t, editorMode)}</DialogTitle>
            </DialogHeader>
            <div className="mt-6 flex-1">
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Instruction</div>
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t('assistantMessage.imageEditPrompt', {
                  defaultValue: 'Describe the change'
                })}
                className="min-h-40 resize-none"
              />
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={closeEditor} disabled={isSubmitting}>
                {t('action.cancel', { ns: 'common' })}
              </Button>
              <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
                {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('action.generate', { ns: 'common', defaultValue: 'Generate' })}
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
