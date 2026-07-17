import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Check, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { buildOutpaintCompositeAndMask, type OutpaintExtend } from '@renderer/lib/image-mask'
import { EditModelSelect, defaultEditModel, type EditModelValue } from './EditModelSelect'
import { nodeScreenRect } from './graph-geometry'
import { useGraphStore } from './graph-store'
import { useGraphActions } from './graph-actions'
import { useNodeImage } from './use-node-image'
import type { ImageNode } from './graph-types'

type Edge = 'left' | 'right' | 'top' | 'bottom'
const ZERO: OutpaintExtend = { left: 0, right: 0, top: 0, bottom: 0 }

interface Props {
  node: ImageNode
}

export function NodeOutpaint({ node }: Props): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const camera = useGraphStore((s) => s.camera)
  const setEditing = useGraphStore((s) => s.setEditing)
  const actions = useGraphActions()
  const image = useNodeImage(node.data.src)

  const [extend, setExtend] = useState<OutpaintExtend>(ZERO)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<EditModelValue | null>(() => defaultEditModel(node))
  const dragRef = useRef<{ edge: Edge; x: number; y: number; base: OutpaintExtend } | null>(null)

  const screen = nodeScreenRect(node, camera)
  const srcW = image?.naturalWidth ?? node.w
  const pxPerSrc = screen.width / Math.max(1, srcW)

  const bounds = {
    left: screen.left - extend.left * pxPerSrc,
    top: screen.top - extend.top * pxPerSrc,
    width: screen.width + (extend.left + extend.right) * pxPerSrc,
    height: screen.height + (extend.top + extend.bottom) * pxPerSrc
  }

  const down = useCallback(
    (edge: Edge) => (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { edge, x: event.clientX, y: event.clientY, base: extend }
    },
    [extend]
  )
  const move = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current
      if (!d) return
      const dx = (event.clientX - d.x) / pxPerSrc
      const dy = (event.clientY - d.y) / pxPerSrc
      const next = { ...d.base }
      if (d.edge === 'left') next.left = Math.max(0, d.base.left - dx)
      if (d.edge === 'right') next.right = Math.max(0, d.base.right + dx)
      if (d.edge === 'top') next.top = Math.max(0, d.base.top - dy)
      if (d.edge === 'bottom') next.bottom = Math.max(0, d.base.bottom + dy)
      setExtend(next)
    },
    [pxPerSrc]
  )
  const up = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
  }, [])

  const cancel = useCallback(() => setEditing(null), [setEditing])
  const apply = useCallback(() => {
    if (!image) return
    const result = buildOutpaintCompositeAndMask(image, extend)
    if (!result) return
    actions.applyEdit(node.id, {
      maskDataUrl: result.maskDataUrl,
      baseImageDataUrl: result.baseDataUrl,
      prompt: prompt.trim() || node.data.prompt || '',
      sourceSize: result.size,
      providerId: model?.providerId,
      modelId: model?.modelId
    })
    setEditing(null)
  }, [actions, extend, image, model, node.data.prompt, node.id, prompt, setEditing])

  const hasExtend = extend.left + extend.right + extend.top + extend.bottom > 1
  const handleCls =
    'pointer-events-auto absolute rounded-full bg-primary shadow ring-2 ring-background'
  if (!node.data.src) return null

  const handles: { edge: Edge; left: number; top: number; cursor: string }[] = [
    {
      edge: 'left',
      left: bounds.left - 7,
      top: bounds.top + bounds.height / 2 - 7,
      cursor: 'ew-resize'
    },
    {
      edge: 'right',
      left: bounds.left + bounds.width - 7,
      top: bounds.top + bounds.height / 2 - 7,
      cursor: 'ew-resize'
    },
    {
      edge: 'top',
      left: bounds.left + bounds.width / 2 - 7,
      top: bounds.top - 7,
      cursor: 'ns-resize'
    },
    {
      edge: 'bottom',
      left: bounds.left + bounds.width / 2 - 7,
      top: bounds.top + bounds.height - 7,
      cursor: 'ns-resize'
    }
  ]

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      <div className="pointer-events-auto absolute inset-0 bg-background/50" onClick={cancel} />
      <div
        className="pointer-events-none absolute rounded-xl border-2 border-dashed border-primary bg-primary/5"
        style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
      />
      <div
        className="pointer-events-none absolute overflow-hidden rounded-xl ring-1 ring-primary/60"
        style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
      >
        <img src={node.data.src} alt="" className="size-full object-fill" />
      </div>
      {handles.map((h) => (
        <div
          key={h.edge}
          className={handleCls}
          style={{ left: h.left, top: h.top, width: 14, height: 14, cursor: h.cursor }}
          onPointerDown={down(h.edge)}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      ))}
      <motion.div
        className="pointer-events-auto absolute inset-x-0 bottom-4 z-40 flex justify-center px-4"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}
      >
        <div className="flex w-full max-w-[560px] flex-col gap-2 rounded-2xl border bg-background/90 p-3 shadow-lg backdrop-blur-md">
          <EditModelSelect
            value={model}
            onChange={setModel}
            className="h-7 w-fit max-w-full text-[11px]"
          />
          <div className="flex items-end gap-2">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('drawPage.outpaintPrompt', {
                defaultValue: 'Describe what fills the new area (optional)'
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
              disabled={!hasExtend || !image}
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
