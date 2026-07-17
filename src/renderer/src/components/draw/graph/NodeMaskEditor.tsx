import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Check, Eraser, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Slider } from '@renderer/components/ui/slider'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  buildMaskDataUrl,
  drawMaskStroke,
  getRelativePoint,
  type ImageSize,
  type MaskStroke
} from '@renderer/lib/image-mask'
import { EditModelSelect, defaultEditModel, type EditModelValue } from './EditModelSelect'
import { nodeScreenRect } from './graph-geometry'
import { useGraphStore } from './graph-store'
import { useGraphActions } from './graph-actions'
import { useNodeImage } from './use-node-image'
import type { ImageNode } from './graph-types'

const DEFAULT_BRUSH = 72
const PREVIEW = 'rgba(239, 68, 68, 0.5)'

interface Props {
  node: ImageNode
}

export function NodeMaskEditor({ node }: Props): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const camera = useGraphStore((s) => s.camera)
  const setEditing = useGraphStore((s) => s.setEditing)
  const actions = useGraphActions()

  const image = useNodeImage(node.data.src)
  const imageSize: ImageSize | null = useMemo(
    () =>
      image && image.naturalWidth > 0
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : null,
    [image]
  )
  const screen = nodeScreenRect(node, camera)

  const [brush, setBrush] = useState(DEFAULT_BRUSH)
  const [strokes, setStrokes] = useState<MaskStroke[]>([])
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<EditModelValue | null>(() => defaultEditModel(node))
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const currentRef = useRef<MaskStroke | null>(null)
  const pointerRef = useRef<number | null>(null)

  const repaint = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const s of strokes) drawMaskStroke(ctx, s, PREVIEW)
    if (currentRef.current) drawMaskStroke(ctx, currentRef.current, PREVIEW)
  }, [strokes])

  useEffect(() => {
    repaint()
  }, [repaint])

  const down = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!imageSize) return
      const p = getRelativePoint(event, imageSize)
      if (!p) return
      event.preventDefault()
      currentRef.current = {
        size: (brush * imageSize.width) / Math.max(1, screen.width),
        points: [p]
      }
      pointerRef.current = event.pointerId
      event.currentTarget.setPointerCapture(event.pointerId)
      repaint()
    },
    [brush, imageSize, repaint, screen.width]
  )

  const move = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (pointerRef.current !== event.pointerId || !imageSize) return
      const p = getRelativePoint(event, imageSize)
      if (!p || !currentRef.current) return
      currentRef.current.points.push(p)
      repaint()
    },
    [imageSize, repaint]
  )

  const up = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const s = currentRef.current
    currentRef.current = null
    pointerRef.current = null
    if (s?.points.length) setStrokes((cur) => [...cur, s])
  }, [])

  const cancel = useCallback(() => setEditing(null), [setEditing])
  const apply = useCallback(() => {
    if (!imageSize || strokes.length === 0 || !prompt.trim()) return
    actions.applyEdit(node.id, {
      maskDataUrl: buildMaskDataUrl(imageSize, strokes),
      prompt: prompt.trim(),
      sourceSize: imageSize,
      providerId: model?.providerId,
      modelId: model?.modelId
    })
    setEditing(null)
  }, [actions, imageSize, model, node.id, prompt, setEditing, strokes])

  if (!node.data.src) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      <div className="pointer-events-auto absolute inset-0 bg-background/50" onClick={cancel} />
      {imageSize && (
        <canvas
          ref={canvasRef}
          width={imageSize.width}
          height={imageSize.height}
          className="pointer-events-auto absolute cursor-crosshair rounded-xl ring-2 ring-primary"
          style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      )}
      <motion.div
        className="pointer-events-auto absolute inset-x-0 bottom-4 z-40 flex justify-center px-4"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}
      >
        <div className="flex w-full max-w-[560px] flex-col gap-2 rounded-2xl border bg-background/90 p-3 shadow-lg backdrop-blur-md">
          <div className="flex items-center gap-3">
            <Eraser className="size-4 shrink-0 text-muted-foreground" />
            <Slider
              className="max-w-40 flex-1"
              min={16}
              max={240}
              step={1}
              value={[brush]}
              onValueChange={([v]) => typeof v === 'number' && setBrush(v)}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0"
              onClick={() => setStrokes([])}
              disabled={strokes.length === 0}
            >
              {t('action.clear', { ns: 'common', defaultValue: 'Clear' })}
            </Button>
            <EditModelSelect
              value={model}
              onChange={setModel}
              className="ml-auto h-7 w-fit max-w-48 text-[11px]"
            />
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('drawPage.inpaintPrompt', {
                defaultValue: 'Describe the change for the painted area'
              })}
              className="min-h-9 max-h-28 flex-1 resize-none py-2 text-sm"
              rows={1}
            />
            <Button variant="outline" size="icon" className="size-9 shrink-0" onClick={cancel}>
              <X className="size-4" />
            </Button>
            <Button
              className="h-9 shrink-0 gap-1.5"
              onClick={apply}
              disabled={strokes.length === 0 || !prompt.trim()}
            >
              <Check className="size-4" />
              {t('drawPage.generate')}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
