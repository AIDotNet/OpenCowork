import { useCallback, useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import {
  CornerDownLeft,
  Eye,
  FilePlus2,
  FileText,
  Film,
  Image as ImageIcon,
  Link2,
  Loader2,
  Minus,
  Plus,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { useShallow } from 'zustand/react/shallow'
import type { ContentBlock, UnifiedMessage } from '@renderer/lib/api/types'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import { useGraphStore } from '../graph-store'
import { useGraphActions } from '../graph-actions'
import { createCanvasNode } from '../node-factory'
import { useProjectsStore } from '../draw-projects-store'
import {
  ASSISTANT_DEFAULT_SIZE,
  ASSISTANT_MIN_SIZE,
  useAssistantStore,
  type AssistantAction,
  type AssistantActionKind,
  type AssistantTurn
} from './assistant-store'
import { runCanvasAssistantTurn } from './canvas-agent'
import { CanvasAssistantModelPicker } from './CanvasAssistantModelPicker'
import type { CanvasNode, ImageNode } from '../graph-types'

const EMPTY_TURNS: AssistantTurn[] = []

const ACTION_ICONS: Record<AssistantActionKind, typeof Eye> = {
  read_canvas: Eye,
  create_text_node: FilePlus2,
  connect_nodes: Link2,
  generate_image: Wand2
}

const ACTION_LABEL_KEYS: Record<AssistantActionKind, string> = {
  read_canvas: 'drawPage.assistantActRead',
  create_text_node: 'drawPage.assistantActCreateText',
  connect_nodes: 'drawPage.assistantActConnect',
  generate_image: 'drawPage.assistantActGenerate'
}

// Rehydrated image nodes carry an oc-media:// display URL instead of inline
// base64, so read the original bytes back from disk in that case (same rule as
// resolveImageDataUrl in use-graph-generation.ts).
async function imageContentBlock(node: ImageNode): Promise<ContentBlock | null> {
  const src = node.data.src ?? ''
  const mediaType = node.data.mediaType || 'image/png'
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',')
    return { type: 'image', source: { type: 'base64', mediaType, data: src.slice(comma + 1) } }
  }
  if (node.data.filePath) {
    try {
      const read = (await ipcClient.invoke(IPC.FS_READ_FILE_BINARY, {
        path: node.data.filePath
      })) as { data?: string }
      if (read?.data) {
        return { type: 'image', source: { type: 'base64', mediaType, data: read.data } }
      }
    } catch {
      /* unreadable file: skip this image */
    }
  }
  return null
}

function focusNode(id: string): void {
  const { nodes, camera, stageSize, setCamera, setSelection } = useGraphStore.getState()
  const node = nodes.find((n) => n.id === id)
  if (!node) return
  setCamera({
    scale: camera.scale,
    x: stageSize.width / 2 - (node.x + node.w / 2) * camera.scale,
    y: stageSize.height / 2 - (node.y + node.h / 2) * camera.scale
  })
  setSelection([id])
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  baseX: number
  baseY: number
  moved: boolean
}

interface StreamState {
  text: string
  actions: AssistantAction[]
}

function ActionNote({ action }: { action: AssistantAction }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const Icon = ACTION_ICONS[action.kind] ?? Wand2
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md bg-background/60 px-1.5 py-0.5 text-[10px]',
        action.ok ? 'text-muted-foreground' : 'text-destructive'
      )}
    >
      <Icon className="size-3" />
      {t(ACTION_LABEL_KEYS[action.kind])}
      {!action.ok && ` · ${t('drawPage.assistantActFailed', { defaultValue: 'failed' })}`}
    </span>
  )
}

function ContextChip({
  node,
  onRemove
}: {
  node: CanvasNode
  onRemove: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  let body: React.ReactNode
  if (node.kind === 'image' && node.data.src) {
    body = <img src={node.data.src} className="size-6 rounded object-cover" alt="" />
  } else if (node.kind === 'image') {
    body = <ImageIcon className="size-3.5 text-muted-foreground" />
  } else if (node.kind === 'text') {
    const text = node.data.text.trim()
    body = (
      <span className="inline-flex items-center gap-1">
        <FileText className="size-3 shrink-0 text-muted-foreground" />
        <span className="max-w-24 truncate">
          {text || t('drawPage.nodeText', { defaultValue: 'Text node' })}
        </span>
      </span>
    )
  } else if (node.kind === 'video') {
    body = <Film className="size-3.5 text-muted-foreground" />
  } else {
    body = (
      <span className="inline-flex items-center gap-1">
        <Settings2 className="size-3 text-muted-foreground" />
        {t('drawPage.nodeConfig', { defaultValue: 'Generate' })}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pl-1 pr-0.5 text-[11px]">
      <button type="button" className="inline-flex items-center" onClick={() => focusNode(node.id)}>
        {body}
      </button>
      <button
        type="button"
        className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => onRemove(node.id)}
      >
        <X className="size-2.5" />
      </button>
    </span>
  )
}

export function CanvasAssistant(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const open = useAssistantStore((s) => s.open)
  const collapsed = useAssistantStore((s) => s.collapsed)
  const storePosition = useAssistantStore((s) => s.position)
  const storeSize = useAssistantStore((s) => s.size)
  const providerId = useAssistantStore((s) => s.providerId)
  const modelId = useAssistantStore((s) => s.modelId)
  const contextIds = useAssistantStore((s) => s.contextIds)
  const setOpen = useAssistantStore((s) => s.setOpen)
  const setCollapsed = useAssistantStore((s) => s.setCollapsed)
  const setPosition = useAssistantStore((s) => s.setPosition)
  const setSize = useAssistantStore((s) => s.setSize)
  const setModel = useAssistantStore((s) => s.setModel)
  const addContext = useAssistantStore((s) => s.addContext)
  const removeContext = useAssistantStore((s) => s.removeContext)
  const pruneContext = useAssistantStore((s) => s.pruneContext)
  const appendTurn = useAssistantStore((s) => s.appendTurn)
  const clearSession = useAssistantStore((s) => s.clearSession)

  const projectId = useProjectsStore((s) => s.activeProjectId) ?? 'default'
  const turns = useAssistantStore((s) => s.sessions[projectId]) ?? EMPTY_TURNS

  // Shallow-compared selectors: untouched nodes keep their identity across
  // graph mutations, so canvas node drags don't re-render this whole panel.
  const contextNodes = useGraphStore(
    useShallow((s) =>
      contextIds.map((id) => s.nodes.find((n) => n.id === id)).filter((n): n is CanvasNode => !!n)
    )
  )
  const addableSelection = useGraphStore(
    useShallow((s) =>
      s.selection.filter((id) => !contextIds.includes(id) && s.nodes.some((n) => n.id === id))
    )
  )
  const graphActions = useGraphActions()
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)

  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [stream, setStream] = useState<StreamState | null>(null)
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null)
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(null)

  const shellRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const streamRef = useRef<StreamState>({ text: '', actions: [] })
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    baseW: number
    baseH: number
  } | null>(null)

  const selectedModel =
    providerId && modelId
      ? { providerId, modelId }
      : activeProviderId && activeModelId
        ? { providerId: activeProviderId, modelId: activeModelId }
        : undefined

  // Drop context chips whose nodes were deleted from the canvas.
  useEffect(() => {
    if (contextNodes.length !== contextIds.length) {
      pruneContext(useGraphStore.getState().nodes.map((n) => n.id))
    }
  }, [contextIds, contextNodes, pruneContext])

  // Seed context from the current canvas selection when the panel opens empty.
  useEffect(() => {
    if (!open) return
    if (useAssistantStore.getState().contextIds.length > 0) return
    const sel = useGraphStore.getState().selection
    if (sel.length > 0) addContext(sel)
  }, [open, addContext])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, stream?.text.length, stream?.actions.length])

  useEffect(() => () => abortRef.current?.abort(), [])

  const clampToParent = useCallback((x: number, y: number, w: number, h: number) => {
    const parent = shellRef.current?.parentElement
    if (!parent) return { x, y }
    return {
      x: Math.min(Math.max(0, x), Math.max(0, parent.clientWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, parent.clientHeight - h))
    }
  }, [])

  const onDragPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button,input,textarea,[role="combobox"]')) return
    const el = shellRef.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const rect = el.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: rect.left - parentRect.left,
      baseY: rect.top - parentRect.top,
      moved: false
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onDragPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      const el = shellRef.current
      if (!drag || !el || e.pointerId !== drag.pointerId) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
      if (!drag.moved) return
      const rect = el.getBoundingClientRect()
      setLivePos(clampToParent(drag.baseX + dx, drag.baseY + dy, rect.width, rect.height))
    },
    [clampToParent]
  )

  const onDragPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.pointerId) return
      dragRef.current = null
      setLivePos((pos) => {
        if (drag.moved && pos) setPosition(pos)
        return null
      })
      if (!drag.moved && collapsed) setCollapsed(false)
    },
    [collapsed, setCollapsed, setPosition]
  )

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const el = shellRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    resizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseW: rect.width,
      baseH: rect.height
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.stopPropagation()
  }, [])

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const resize = resizeRef.current
    const el = shellRef.current
    const parent = el?.parentElement
    if (!resize || !el || !parent || e.pointerId !== resize.pointerId) return
    const parentRect = parent.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    const left = rect.left - parentRect.left
    const top = rect.top - parentRect.top
    setLiveSize({
      w: Math.min(
        Math.max(ASSISTANT_MIN_SIZE.w, resize.baseW + (e.clientX - resize.startX)),
        Math.max(ASSISTANT_MIN_SIZE.w, parent.clientWidth - left - 8)
      ),
      h: Math.min(
        Math.max(ASSISTANT_MIN_SIZE.h, resize.baseH + (e.clientY - resize.startY)),
        Math.max(ASSISTANT_MIN_SIZE.h, parent.clientHeight - top - 8)
      )
    })
  }, [])

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const resize = resizeRef.current
      if (!resize || e.pointerId !== resize.pointerId) return
      resizeRef.current = null
      setLiveSize((size) => {
        if (size) setSize(size)
        return null
      })
    },
    [setSize]
  )

  const send = useCallback(
    async (raw?: string) => {
      const request = (raw ?? input).trim()
      if (!request || busy) return
      const providerStore = useProviderStore.getState()
      const chosen = useAssistantStore.getState()
      const config =
        (chosen.providerId && chosen.modelId
          ? providerStore.getProviderConfigById(chosen.providerId, chosen.modelId)
          : null) ?? providerStore.getActiveProviderConfig()
      if (!config) {
        toast.error(t('drawPage.assistantNoModel', { defaultValue: 'Select a chat model first' }))
        return
      }
      const authProviderId = chosen.providerId ?? providerStore.activeProviderId
      if (authProviderId && !(await ensureProviderAuthReady(authProviderId))) {
        toast.error(t('drawPage.authRequired', { defaultValue: 'Provider login required' }))
        return
      }

      const graph = useGraphStore.getState()
      const ctx = chosen.contextIds
        .map((id) => graph.nodes.find((n) => n.id === id))
        .filter((n): n is CanvasNode => !!n)
      const labels: string[] = []
      const imageBlocks: ContentBlock[] = []
      for (const node of ctx) {
        if (node.kind === 'text' && node.data.text.trim()) {
          labels.push(`[text node ${node.id}]\n${node.data.text.trim()}`)
        } else if (node.kind === 'image') {
          const block = await imageContentBlock(node)
          if (block) {
            imageBlocks.push(block)
            labels.push(`[image node ${node.id}] (image attached)`)
          }
        }
      }
      const userText = labels.length
        ? `Context from canvas:\n${labels.join('\n\n')}\n\n---\n${request}`
        : request
      const content: string | ContentBlock[] =
        imageBlocks.length > 0 ? [...imageBlocks, { type: 'text', text: userText }] : userText

      const prior: UnifiedMessage[] = turns.map((turn) => ({
        id: nanoid(),
        role: turn.role,
        content: turn.text,
        createdAt: Date.now()
      }))
      const messages: UnifiedMessage[] = [
        ...prior,
        { id: nanoid(), role: 'user', content, createdAt: Date.now() }
      ]

      appendTurn(projectId, { role: 'user', text: request })
      if (!raw) setInput('')
      setBusy(true)
      streamRef.current = { text: '', actions: [] }
      setStream({ text: '', actions: [] })
      const controller = new AbortController()
      abortRef.current = controller
      try {
        for await (const event of runCanvasAssistantTurn({
          provider: config,
          messages,
          actions: graphActions,
          signal: controller.signal
        })) {
          if (event.type === 'text') {
            streamRef.current.text += event.text
          } else {
            streamRef.current.actions.push(event.action)
          }
          setStream({ text: streamRef.current.text, actions: [...streamRef.current.actions] })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          toast.error(t('drawPage.assistantFailed', { defaultValue: 'Assistant request failed' }), {
            description: error instanceof Error ? error.message : String(error)
          })
        }
      } finally {
        const result = streamRef.current
        if (result.text.trim() || result.actions.length > 0) {
          appendTurn(projectId, {
            role: 'assistant',
            text: result.text.trim() || '…',
            ...(result.actions.length > 0 ? { actions: result.actions } : {})
          })
        }
        setStream(null)
        setBusy(false)
        abortRef.current = null
      }
    },
    [appendTurn, busy, graphActions, input, projectId, t, turns]
  )

  const insertAsNode = useCallback(
    (text: string) => {
      const { nodes: all, addNode, addEdge } = useGraphStore.getState()
      const ctxIds = useAssistantStore.getState().contextIds
      const anchor = all.find((n) => ctxIds.includes(n.id))
      const world = anchor ? { x: anchor.x + anchor.w + 320, y: anchor.y } : { x: 200, y: 200 }
      const base = createCanvasNode('text', world)
      const node: CanvasNode = { ...base, kind: 'text', data: { text } }
      addNode(node, { select: true })
      ctxIds.forEach((id) => addEdge(id, node.id, { history: false }))
      toast.success(t('drawPage.assistantInserted', { defaultValue: 'Inserted as text node' }))
    },
    [t]
  )

  if (!open) return null

  const pos = livePos ?? storePosition
  const posStyle = pos ? { left: pos.x, top: pos.y } : { right: 16, top: 64 }
  const size = liveSize ?? storeSize ?? ASSISTANT_DEFAULT_SIZE

  if (collapsed) {
    return (
      <div
        ref={shellRef}
        className="pointer-events-auto absolute z-40 flex h-9 cursor-grab touch-none select-none items-center gap-1.5 rounded-full border bg-background/95 px-3 shadow-lg backdrop-blur-md active:cursor-grabbing"
        style={posStyle}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : (
          <Sparkles className="size-4 text-primary" />
        )}
        <span className="text-xs font-medium">
          {t('drawPage.assistant', { defaultValue: 'Canvas assistant' })}
        </span>
        {contextNodes.length > 0 && (
          <span className="rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
            {contextNodes.length}
          </span>
        )}
      </div>
    )
  }

  return (
    <motion.div
      ref={shellRef}
      className="pointer-events-auto absolute z-40 flex flex-col overflow-hidden rounded-2xl border bg-background/95 shadow-xl backdrop-blur-md"
      style={{ ...posStyle, width: size.w, height: size.h, maxWidth: 'calc(100% - 16px)' }}
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28 }}
      // The panel lives inside the canvas container, whose onMouseDown clears the
      // node selection and whose onWheel zooms the canvas. Stop both bubbles so
      // interacting with the assistant keeps the canvas state intact.
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="flex cursor-grab touch-none select-none items-center gap-2 border-b px-3 py-2 active:cursor-grabbing"
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
      >
        <Sparkles className="size-4 shrink-0 text-primary" />
        <span className="truncate text-sm font-semibold">
          {t('drawPage.assistant', { defaultValue: 'Canvas assistant' })}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {turns.length > 0 && !busy && (
            <button
              type="button"
              title={t('drawPage.assistantClear', { defaultValue: 'Clear conversation' })}
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted"
              onClick={() => clearSession(projectId)}
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            title={t('drawPage.assistantCollapse', { defaultValue: 'Collapse' })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted"
            onClick={() => setCollapsed(true)}
          >
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted"
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5">
        <CanvasAssistantModelPicker
          value={selectedModel}
          onChange={({ providerId: nextProviderId, modelId: nextModelId }) =>
            setModel(nextProviderId, nextModelId)
          }
          placeholder={t('drawPage.selectModel', { defaultValue: 'Select model' })}
        />
      </div>

      <div className="border-b px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            {t('drawPage.assistantContext', {
              count: contextNodes.length,
              defaultValue: '{{count}} in context'
            })}
          </span>
          {addableSelection.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10"
              onClick={() => addContext(addableSelection)}
            >
              <Plus className="size-3" />
              {t('drawPage.assistantAddSelection', {
                count: addableSelection.length,
                defaultValue: 'Add selected ({{count}})'
              })}
            </button>
          )}
        </div>
        {contextNodes.length > 0 && (
          <div className="mt-1.5 flex max-h-16 flex-wrap gap-1 overflow-y-auto">
            {contextNodes.map((node) => (
              <ContextChip key={node.id} node={node} onRemove={removeContext} />
            ))}
          </div>
        )}
      </div>

      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {turns.length === 0 && !stream && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t('drawPage.assistantHint', {
              defaultValue: 'Select nodes as context, then ask for ideas or a prompt.'
            })}
          </p>
        )}
        {turns.map((turn, i) => (
          <div
            key={i}
            className={cn(
              'rounded-lg px-2.5 py-1.5 text-xs',
              turn.role === 'user' ? 'bg-primary/10 text-foreground' : 'bg-muted'
            )}
          >
            {turn.actions && turn.actions.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1">
                {turn.actions.map((action, j) => (
                  <ActionNote key={j} action={action} />
                ))}
              </div>
            )}
            <p className="whitespace-pre-wrap break-words">{turn.text}</p>
            {turn.role === 'assistant' && turn.text.trim() && (
              <button
                type="button"
                className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                onClick={() => insertAsNode(turn.text)}
              >
                <Plus className="size-3" />
                {t('drawPage.assistantInsert', { defaultValue: 'Insert as node' })}
              </button>
            )}
          </div>
        ))}
        {stream && (
          <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs">
            {stream.actions.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1">
                {stream.actions.map((action, j) => (
                  <ActionNote key={j} action={action} />
                ))}
              </div>
            )}
            {stream.text ? (
              <p className="whitespace-pre-wrap break-words">{stream.text}</p>
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t('drawPage.assistantThinking', { defaultValue: 'Thinking…' })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
        {(
          [
            ['drawPage.assistantQuickRefine', 'drawPage.assistantQuickRefinePrompt'],
            ['drawPage.assistantQuickTranslate', 'drawPage.assistantQuickTranslatePrompt'],
            ['drawPage.assistantQuickDescribe', 'drawPage.assistantQuickDescribePrompt']
          ] as const
        ).map(([labelKey, promptKey]) => (
          <button
            key={labelKey}
            type="button"
            disabled={busy}
            className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            onClick={() => void send(t(promptKey))}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="border-t p-2">
        <div className="relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={t('drawPage.assistantPlaceholder', { defaultValue: 'Ask the assistant…' })}
            className="max-h-28 min-h-9 resize-none pr-10 text-sm"
            rows={1}
          />
          {busy ? (
            <Button
              size="icon"
              variant="secondary"
              className="absolute bottom-1.5 right-1.5 size-7"
              title={t('drawPage.assistantStop', { defaultValue: 'Stop' })}
              onClick={() => abortRef.current?.abort()}
            >
              <Square className="size-3" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="absolute bottom-1.5 right-1.5 size-7"
              onClick={() => void send()}
              disabled={!input.trim()}
            >
              <CornerDownLeft className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div
        className="absolute bottom-0 right-0 size-4 cursor-nwse-resize touch-none"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
      >
        <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground/50">
          <path d="M14 8 L8 14 M14 12 L12 14" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </div>
    </motion.div>
  )
}
