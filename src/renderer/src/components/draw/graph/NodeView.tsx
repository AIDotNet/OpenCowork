import { memo, useCallback, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Braces, Copy, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import { cn } from '@renderer/lib/utils'
import { NODE_MIN_SIZE, type CanvasNode } from './graph-types'
import { useGraphStore } from './graph-store'
import { useConnection } from './connection-context'
import { TextNodeView } from './nodes/TextNodeView'
import { ImageNodeView } from './nodes/ImageNodeView'
import { ConfigNodeView } from './nodes/ConfigNodeView'
import { VideoNodeView } from './nodes/VideoNodeView'

interface NodeViewProps {
  node: CanvasNode
}

type Corner = 'nw' | 'ne' | 'sw' | 'se'

export const NodeView = memo(function NodeView({ node }: NodeViewProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  // Subscribe to primitives only — the whole-array/object slices (nodes,
  // selection, camera) get new identities on every graph mutation and would
  // re-render every node each pointermove frame.
  const selected = useGraphStore((s) => s.selection.includes(node.id))
  const setSelection = useGraphStore((s) => s.setSelection)
  const toggleSelection = useGraphStore((s) => s.toggleSelection)
  const moveNodes = useGraphStore((s) => s.moveNodes)
  const resizeNode = useGraphStore((s) => s.resizeNode)
  const addEdge = useGraphStore((s) => s.addEdge)
  const removeNodes = useGraphStore((s) => s.removeNodes)
  const duplicateSelection = useGraphStore((s) => s.duplicateSelection)
  const pushHistory = useGraphStore((s) => s.pushHistory)
  const { pending, setPending } = useConnection()

  const dragRef = useRef<{ startX: number; startY: number; ids: string[]; moved: boolean } | null>(
    null
  )
  const resizeRef = useRef<{
    corner: Corner
    startX: number
    startY: number
    box: typeof node
    moved: boolean
  } | null>(null)

  const beginDrag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest('[data-nodrag]')) return
      event.stopPropagation()

      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      const sel = useGraphStore.getState().selection
      let ids = sel
      if (additive) {
        toggleSelection(node.id)
        ids = sel.includes(node.id) ? sel : [...sel, node.id]
      } else if (!sel.includes(node.id)) {
        setSelection([node.id])
        ids = [node.id]
      }

      dragRef.current = { startX: event.clientX, startY: event.clientY, ids, moved: false }

      const onMove = (e: MouseEvent): void => {
        const drag = dragRef.current
        if (!drag) return
        // History is pushed on the first actual movement (not on mousedown) so
        // plain clicks don't pollute the undo stack.
        if (!drag.moved) {
          drag.moved = true
          pushHistory()
        }
        const scale = useGraphStore.getState().camera.scale
        const dx = (e.clientX - drag.startX) / scale
        const dy = (e.clientY - drag.startY) / scale
        drag.startX = e.clientX
        drag.startY = e.clientY
        const deltas: Record<string, { x: number; y: number }> = {}
        for (const id of drag.ids) deltas[id] = { x: dx, y: dy }
        moveNodes(deltas)
      }
      const onUp = (): void => {
        dragRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [moveNodes, node.id, pushHistory, setSelection, toggleSelection]
  )

  const beginResize = useCallback(
    (corner: Corner) => (event: ReactMouseEvent<HTMLDivElement>) => {
      event.stopPropagation()
      event.preventDefault()
      resizeRef.current = {
        corner,
        startX: event.clientX,
        startY: event.clientY,
        box: node,
        moved: false
      }
      const start = resizeRef.current

      const aspect = start.box.h > 0 ? start.box.w / start.box.h : 1
      const onMove = (e: MouseEvent): void => {
        if (!start.moved) {
          start.moved = true
          pushHistory()
        }
        const scale = useGraphStore.getState().camera.scale
        const dx = (e.clientX - start.startX) / scale
        const dy = (e.clientY - start.startY) / scale
        let { x, y, w, h } = start.box
        if (corner === 'se') {
          w = Math.max(NODE_MIN_SIZE.w, start.box.w + dx)
          h = Math.max(NODE_MIN_SIZE.h, start.box.h + dy)
        } else if (corner === 'ne') {
          w = Math.max(NODE_MIN_SIZE.w, start.box.w + dx)
          h = Math.max(NODE_MIN_SIZE.h, start.box.h - dy)
        } else if (corner === 'sw') {
          w = Math.max(NODE_MIN_SIZE.w, start.box.w - dx)
          h = Math.max(NODE_MIN_SIZE.h, start.box.h + dy)
        } else {
          w = Math.max(NODE_MIN_SIZE.w, start.box.w - dx)
          h = Math.max(NODE_MIN_SIZE.h, start.box.h - dy)
        }
        // Hold Shift to keep the original aspect ratio.
        if (e.shiftKey && aspect > 0) {
          h = Math.max(NODE_MIN_SIZE.h, w / aspect)
          w = h * aspect
        }
        // Re-anchor corners that move the top-left origin.
        if (corner === 'ne' || corner === 'nw') y = start.box.y + (start.box.h - h)
        if (corner === 'sw' || corner === 'nw') x = start.box.x + (start.box.w - w)
        resizeNode(node.id, { id: node.id, x, y, w, h })
      }
      const onUp = (): void => {
        resizeRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [node, pushHistory, resizeNode]
  )

  const startConnect = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.stopPropagation()
      event.preventDefault()
      setPending({
        sourceId: node.id,
        cursor: { x: node.x + node.w, y: node.y + node.h / 2 }
      })
    },
    [node.h, node.id, node.w, node.x, node.y, setPending]
  )

  const completeConnect = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!pending || pending.sourceId === node.id) return
      event.stopPropagation()
      addEdge(pending.sourceId, node.id)
      setPending(null)
    },
    [addEdge, node.id, pending, setPending]
  )

  const cornerCursor: Record<Corner, string> = {
    nw: 'nwse-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    se: 'nwse-resize'
  }

  const handleContextOpen = (open: boolean): void => {
    if (open && !selected) setSelection([node.id])
  }

  const copyJson = useCallback(() => {
    const clean =
      node.kind === 'image'
        ? {
            ...node,
            data: { ...node.data, src: node.data.src ? '[image]' : undefined, groupSrcs: undefined }
          }
        : node
    void navigator.clipboard.writeText(JSON.stringify(clean, null, 2)).then(
      () => toast.success(t('drawPage.copiedJson', { defaultValue: 'Node JSON copied' })),
      () => toast.error(t('drawPage.copyFailed', { defaultValue: 'Copy failed' }))
    )
  }, [node, t])

  // While a connection is being dragged, every other node is a drop target.
  const isDropTarget = !!pending && pending.sourceId !== node.id

  return (
    <ContextMenu onOpenChange={handleContextOpen}>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group/node absolute rounded-xl border bg-card shadow-md transition-shadow',
            selected
              ? 'border-primary ring-2 ring-primary/40'
              : isDropTarget
                ? 'border-primary ring-2 ring-primary/60'
                : 'border-border hover:shadow-lg'
          )}
          style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
          onMouseDown={beginDrag}
          onMouseUp={completeConnect}
        >
          <div className="flex h-full flex-col overflow-hidden rounded-xl">
            {node.kind === 'text' && <TextNodeView node={node} />}
            {node.kind === 'image' && <ImageNodeView node={node} />}
            {node.kind === 'config' && <ConfigNodeView node={node} />}
            {node.kind === 'video' && <VideoNodeView node={node} />}
          </div>

          {/* input port (left) — larger hit area for dropping a connection */}
          <div
            data-nodrag
            className="absolute -left-4 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center"
            onMouseUp={completeConnect}
          >
            <span
              className={cn(
                'size-3.5 rounded-full border-2 border-primary bg-background transition-transform',
                isDropTarget && 'scale-125 bg-primary'
              )}
            />
          </div>
          {/* output port (right) — drag from here to another node to connect */}
          <div
            data-nodrag
            className="group/port absolute -right-4 top-1/2 flex size-8 -translate-y-1/2 cursor-crosshair items-center justify-center"
            onMouseDown={startConnect}
          >
            <span className="size-3.5 rounded-full border-2 border-primary bg-background transition-transform group-hover/port:scale-125 group-hover/port:bg-primary" />
          </div>

          {/* resize handles */}
          {selected &&
            (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
              <div
                key={corner}
                data-nodrag
                onMouseDown={beginResize(corner)}
                className="absolute size-3 rounded-sm border border-primary bg-background"
                style={{
                  cursor: cornerCursor[corner],
                  left: corner === 'nw' || corner === 'sw' ? -6 : undefined,
                  right: corner === 'ne' || corner === 'se' ? -6 : undefined,
                  top: corner === 'nw' || corner === 'ne' ? -6 : undefined,
                  bottom: corner === 'sw' || corner === 'se' ? -6 : undefined
                }}
              />
            ))}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-44">
        <ContextMenuItem
          onSelect={() => {
            setSelection([node.id])
            duplicateSelection()
          }}
        >
          <Copy className="size-4" />
          {t('drawPage.duplicate', { defaultValue: 'Duplicate' })}
          <ContextMenuShortcut>⌘D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={copyJson}>
          <Braces className="size-4" />
          {t('drawPage.copyJson', { defaultValue: 'Copy JSON' })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => removeNodes([node.id])}>
          <Trash2 className="size-4" />
          {t('drawPage.deleteRecord', { defaultValue: 'Delete' })}
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
