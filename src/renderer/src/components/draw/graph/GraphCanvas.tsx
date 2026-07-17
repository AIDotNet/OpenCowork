import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Image as ImageIcon, Maximize, MousePointerClick, Settings2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@renderer/components/ui/context-menu'
import { fitCamera, nodeScreenRect, screenToWorld, zoomAtPoint } from './graph-geometry'
import { useGraphStore } from './graph-store'
import { createCanvasNode } from './node-factory'
import { addImageNodeFromDataUrl, fileToDataUrl, imageFilesFromTransfer } from './add-image-node'
import type { CanvasNodeKind } from './graph-types'
import type { GraphActions } from './graph-actions'
import { GraphActionsProvider } from './graph-actions'
import { EdgeLayer } from './EdgeLayer'
import { NodeView } from './NodeView'
import { GraphControls } from './GraphControls'
import { GraphMinimap } from './GraphMinimap'
import { ConnectionState, type PendingConnection } from './connection-context'
import { useGraphKeyboard } from './graph-keyboard'
import { NodeMaskEditor } from './NodeMaskEditor'
import { NodeOutpaint } from './NodeOutpaint'
import { NodeCropDialog } from './NodeCropDialog'
import { NodeAngleDialog } from './NodeAngleDialog'
import { NodeUpscaleDialog } from './NodeUpscaleDialog'
import { NodeSplitDialog } from './NodeSplitDialog'
import { CanvasAssistant } from './assistant/CanvasAssistant'

interface GraphCanvasProps {
  actions: GraphActions
}

interface Marquee {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function GraphCanvas({ actions }: GraphCanvasProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nodes = useGraphStore((s) => s.nodes)
  const camera = useGraphStore((s) => s.camera)
  const stageSize = useGraphStore((s) => s.stageSize)
  const background = useGraphStore((s) => s.background)
  const setCamera = useGraphStore((s) => s.setCamera)
  const setStageSize = useGraphStore((s) => s.setStageSize)
  const setSelection = useGraphStore((s) => s.setSelection)
  const clearSelection = useGraphStore((s) => s.clearSelection)
  const addNode = useGraphStore((s) => s.addNode)
  const pendingFit = useGraphStore((s) => s.pendingFit)
  const editing = useGraphStore((s) => s.editing)
  const editingNode = editing ? nodes.find((n) => n.id === editing.nodeId) : undefined
  const menuWorldRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const [pending, setPending] = useState<PendingConnection | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  useGraphKeyboard()
  const panRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null)
  const marqueeRef = useRef<Marquee | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setStageSize({ width: Math.round(r.width), height: Math.round(r.height) })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [setStageSize])

  // Fit the view once after a graph load (page entry / project switch), as soon
  // as the stage has been measured — loadGraph resets the camera to the origin,
  // which may leave all persisted nodes off-screen.
  useEffect(() => {
    if (!pendingFit || stageSize.width === 0 || stageSize.height === 0) return
    const { nodes: current, clearPendingFit } = useGraphStore.getState()
    setCamera(fitCamera(current, stageSize))
    clearPendingFit()
  }, [pendingFit, setCamera, stageSize])

  const localPoint = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }
  }, [])

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      menuWorldRef.current = screenToWorld(localPoint(event.clientX, event.clientY), camera)
    },
    [camera, localPoint]
  )

  const addNodeAt = useCallback(
    (kind: CanvasNodeKind) => {
      addNode(createCanvasNode(kind, menuWorldRef.current), { select: true })
    },
    [addNode]
  )

  const selectAll = useCallback(() => {
    setSelection(nodes.map((n) => n.id))
  }, [nodes, setSelection])

  const fitView = useCallback(() => {
    setCamera(fitCamera(nodes, stageSize))
  }, [nodes, setCamera, stageSize])

  const dropAt = useCallback(
    (world: { x: number; y: number }) =>
      (dataUrl: string, index: number): Promise<void> =>
        addImageNodeFromDataUrl(dataUrl, { x: world.x + index * 32, y: world.y + index * 32 }),
    []
  )

  // Paste images (⌘/Ctrl+V) → image nodes at viewport center.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && target.closest('input, textarea, [contenteditable="true"]')) return
      const files = imageFilesFromTransfer(event.clipboardData)
      if (files.length === 0) return
      event.preventDefault()
      const { camera: cam, stageSize: size } = useGraphStore.getState()
      const world = screenToWorld({ x: size.width / 2, y: size.height / 2 }, cam)
      const place = dropAt(world)
      files.forEach((file, i) => {
        void fileToDataUrl(file).then((url) => place(url, i))
      })
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [dropAt])

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const files = imageFilesFromTransfer(event.dataTransfer)
      if (files.length === 0) return
      event.preventDefault()
      const world = screenToWorld(localPoint(event.clientX, event.clientY), camera)
      const place = dropAt(world)
      files.forEach((file, i) => {
        void fileToDataUrl(file).then((url) => place(url, i))
      })
    },
    [camera, dropAt, localPoint]
  )

  // Radix dialogs/menus portal to <body> but their synthetic events still bubble
  // up the React tree to these container handlers — ignore anything whose target
  // isn't actually inside the canvas DOM (e.g. scrolling an open dialog).
  const fromContainer = useCallback(
    (target: EventTarget | null) => !!containerRef.current?.contains(target as Node),
    []
  )

  // React's root-level wheel listener is passive, so preventDefault() here can't
  // stop a scrollable child (e.g. a text node's textarea) from also scrolling
  // natively — the canvas must yield instead of panning in tandem with it.
  const scrollsWithin = useCallback((target: EventTarget | null): boolean => {
    let el = target instanceof HTMLElement ? target : null
    while (el && el !== containerRef.current) {
      const { overflowX, overflowY } = getComputedStyle(el)
      if (
        (/(auto|scroll)/.test(overflowY) && el.scrollHeight > el.clientHeight) ||
        (/(auto|scroll)/.test(overflowX) && el.scrollWidth > el.clientWidth)
      ) {
        return true
      }
      el = el.parentElement
    }
    return false
  }, [])

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!fromContainer(event.target)) return
      // Ctrl/⌘ + wheel zooms at the cursor (trackpad pinch reports ctrlKey too);
      // a plain wheel pans, Shift+wheel pans horizontally — Figma-style controls.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const p = localPoint(event.clientX, event.clientY)
        const factor = Math.exp(-event.deltaY * 0.003)
        setCamera((cam) => zoomAtPoint(cam, p, cam.scale * factor))
      } else {
        if (scrollsWithin(event.target)) return
        event.preventDefault()
        const swapAxes = event.shiftKey && event.deltaX === 0
        const dx = swapAxes ? event.deltaY : event.deltaX
        const dy = swapAxes ? 0 : event.deltaY
        setCamera((cam) => ({ ...cam, x: cam.x - dx, y: cam.y - dy }))
      }
    },
    [fromContainer, localPoint, scrollsWithin, setCamera]
  )

  const handleBackgroundDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || editing || !fromContainer(event.target)) return
      const marqueeMode = event.ctrlKey || event.metaKey
      const p = localPoint(event.clientX, event.clientY)
      if (marqueeMode) {
        const m = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
        marqueeRef.current = m
        setMarquee(m)
      } else {
        clearSelection()
        panRef.current = { x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y }
      }
    },
    [camera.x, camera.y, clearSelection, editing, fromContainer, localPoint]
  )

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (panRef.current) {
        setCamera((cam) => ({
          ...cam,
          x: panRef.current!.camX + (event.clientX - panRef.current!.x),
          y: panRef.current!.camY + (event.clientY - panRef.current!.y)
        }))
      } else if (marqueeRef.current) {
        const p = localPoint(event.clientX, event.clientY)
        const m = { ...marqueeRef.current, x1: p.x, y1: p.y }
        marqueeRef.current = m
        setMarquee(m)
      } else if (pending) {
        const p = localPoint(event.clientX, event.clientY)
        setPending((prev) => (prev ? { ...prev, cursor: screenToWorld(p, camera) } : prev))
      }
    }
    const onUp = (): void => {
      if (marqueeRef.current) {
        const m = marqueeRef.current
        const rx0 = Math.min(m.x0, m.x1)
        const ry0 = Math.min(m.y0, m.y1)
        const rx1 = Math.max(m.x0, m.x1)
        const ry1 = Math.max(m.y0, m.y1)
        const hits = nodes
          .filter((n) => {
            const r = nodeScreenRect(n, camera)
            return r.left < rx1 && r.left + r.width > rx0 && r.top < ry1 && r.top + r.height > ry0
          })
          .map((n) => n.id)
        setSelection(hits)
      }
      panRef.current = null
      marqueeRef.current = null
      setMarquee(null)
      setPending(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [camera, localPoint, nodes, pending, setCamera, setSelection])

  // The pattern lives on an oversized child layer moved with a composited
  // `transform` — panning never re-rasterizes the whole container the way an
  // animated `background-position` on the container itself would.
  const bgPattern = useMemo(() => {
    if (background === 'blank') return null
    const size = 24 * camera.scale
    const offsetX = ((camera.x % size) + size) % size
    const offsetY = ((camera.y % size) + size) % size
    return {
      backgroundImage:
        background === 'grid'
          ? 'linear-gradient(var(--graph-line) 1px, transparent 1px), linear-gradient(90deg, var(--graph-line) 1px, transparent 1px)'
          : 'radial-gradient(var(--graph-dot) 1.2px, transparent 1.2px)',
      backgroundSize: `${size}px ${size}px`,
      inset: `${-size}px`,
      transform: `translate(${offsetX}px, ${offsetY}px)`
    }
  }, [background, camera.scale, camera.x, camera.y])

  // Context value is memoized so NodeView consumers don't re-render on every
  // GraphCanvas render — only when a connection drag actually starts/moves.
  const connectionValue = useMemo(() => ({ pending, setPending }), [pending])

  return (
    <GraphActionsProvider value={actions}>
      <ConnectionState.Provider value={connectionValue}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={containerRef}
              className="relative h-full w-full overflow-hidden bg-background [--graph-dot:theme(colors.border)] [--graph-line:theme(colors.border)]"
              onWheel={handleWheel}
              onMouseDown={handleBackgroundDown}
              onContextMenu={handleContextMenu}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              {bgPattern && (
                <div
                  className="pointer-events-none absolute will-change-transform"
                  style={bgPattern}
                />
              )}

              {/* world */}
              {/* edges: screen-space, beneath the nodes */}
              <EdgeLayer />

              {/* world: nodes are transformed by the camera */}
              <div
                className="absolute left-0 top-0 origin-top-left"
                style={{
                  transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`
                }}
              >
                {nodes.map((node) => (
                  <NodeView key={node.id} node={node} />
                ))}
              </div>

              {/* marquee */}
              {marquee && (
                <div
                  className="pointer-events-none absolute rounded-sm border border-primary/70 bg-primary/10"
                  style={{
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0)
                  }}
                />
              )}

              {editing?.mode === 'mask' && editingNode?.kind === 'image' && (
                <NodeMaskEditor node={editingNode} />
              )}
              {editing?.mode === 'outpaint' && editingNode?.kind === 'image' && (
                <NodeOutpaint node={editingNode} />
              )}
              {editing?.mode === 'crop' && editingNode?.kind === 'image' && (
                <NodeCropDialog node={editingNode} />
              )}
              {editing?.mode === 'angle' && editingNode?.kind === 'image' && (
                <NodeAngleDialog node={editingNode} />
              )}
              {editing?.mode === 'upscale' && editingNode?.kind === 'image' && (
                <NodeUpscaleDialog node={editingNode} />
              )}
              {editing?.mode === 'split' && editingNode?.kind === 'image' && (
                <NodeSplitDialog node={editingNode} />
              )}

              <GraphControls />
              <GraphMinimap />
              <CanvasAssistant />
            </div>
          </ContextMenuTrigger>

          <ContextMenuContent className="w-48">
            <ContextMenuItem onSelect={() => addNodeAt('text')}>
              <FileText className="size-4" />
              {t('drawPage.nodeText', { defaultValue: 'Text node' })}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => addNodeAt('image')}>
              <ImageIcon className="size-4" />
              {t('drawPage.nodeImage', { defaultValue: 'Image node' })}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => addNodeAt('config')}>
              <Settings2 className="size-4" />
              {t('drawPage.nodeConfig', { defaultValue: 'Generate node' })}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={selectAll} disabled={nodes.length === 0}>
              <MousePointerClick className="size-4" />
              {t('drawPage.selectAll', { defaultValue: 'Select all' })}
            </ContextMenuItem>
            <ContextMenuItem onSelect={fitView} disabled={nodes.length === 0}>
              <Maximize className="size-4" />
              {t('drawPage.fitView', { defaultValue: 'Fit view' })}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </ConnectionState.Provider>
    </GraphActionsProvider>
  )
}
