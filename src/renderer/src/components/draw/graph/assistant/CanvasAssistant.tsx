import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import {
  CornerDownLeft,
  Eye,
  FilePlus2,
  FileText,
  Film,
  Image as ImageIcon,
  ImagePlus,
  Link2,
  Loader2,
  Minus,
  MessageSquareText,
  Paperclip,
  Pencil,
  Pin,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { useShallow } from 'zustand/react/shallow'
import type { ContentBlock, UnifiedMessage } from '@renderer/lib/api/types'
import { modelSupportsVision, useProviderStore } from '@renderer/stores/provider-store'
import { fileToImageAttachment, type ImageAttachment } from '@renderer/lib/image-attachments'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import { screenToWorld } from '../graph-geometry'
import { useGraphStore } from '../graph-store'
import { useGraphActions } from '../graph-actions'
import { createCanvasNode } from '../node-factory'
import { addImageNodeFromDataUrl } from '../add-image-node'
import { useProjectsStore } from '../draw-projects-store'
import {
  ASSISTANT_DEFAULT_SIZE,
  ASSISTANT_MIN_SIZE,
  useAssistantStore,
  type AssistantAction,
  type AssistantActionKind,
  type AssistantTimelineBlock,
  type AssistantTurn
} from './assistant-store'
import { runCanvasAssistantTurn, type CanvasConfirmationRequest } from './canvas-agent'
import { CanvasAssistantModelPicker } from './CanvasAssistantModelPicker'
import type { CanvasNode, ImageNode } from '../graph-types'

const EMPTY_TURNS: AssistantTurn[] = []

const ACTION_ICONS: Partial<Record<AssistantActionKind, typeof Eye>> = {
  read_canvas: Eye,
  create_node: FilePlus2,
  connect_nodes: Link2,
  generate_media: Wand2,
  generate_video: Film,
  edit_image: Wand2,
  run_node: Sparkles,
  retry_node: Sparkles,
  delete_nodes: Trash2,
  Read: Eye,
  Write: FilePlus2,
  Edit: Pencil,
  NotebookEdit: Pencil,
  LS: FileText,
  Glob: Eye,
  Grep: Eye,
  Bash: Terminal,
  Skill: Sparkles
}

const ACTION_LABEL_KEYS: Partial<Record<AssistantActionKind, string>> = {
  read_canvas: 'drawPage.assistantActRead',
  get_node_status: 'drawPage.assistantActStatus',
  subscribe_node: 'drawPage.assistantActSubscribe',
  wait_for_node_event: 'drawPage.assistantActWait',
  create_node: 'drawPage.assistantActCreateNode',
  update_node: 'drawPage.assistantActUpdateNode',
  delete_nodes: 'drawPage.assistantActDeleteNodes',
  duplicate_nodes: 'drawPage.assistantActDuplicateNodes',
  connect_nodes: 'drawPage.assistantActConnect',
  disconnect_nodes: 'drawPage.assistantActDisconnect',
  move_nodes: 'drawPage.assistantActMove',
  resize_node: 'drawPage.assistantActResize',
  select_nodes: 'drawPage.assistantActSelect',
  generate_media: 'drawPage.assistantActGenerate',
  generate_video: 'drawPage.assistantActGenerateVideo',
  edit_image: 'drawPage.assistantActEdit',
  run_node: 'drawPage.assistantActRun',
  retry_node: 'drawPage.assistantActRetry',
  cancel_node: 'drawPage.assistantActCancel',
  media_action: 'drawPage.assistantActMedia',
  create_trigger: 'drawPage.assistantActCreateTrigger',
  delete_trigger: 'drawPage.assistantActDeleteTrigger',
  manage_canvas: 'drawPage.assistantActCanvas'
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

function historyTurnText(turn: AssistantTurn): string {
  const metadata = {
    ...(turn.contextNodeIds?.length ? { contextNodeIds: turn.contextNodeIds } : {}),
    ...(turn.attachmentRefs?.length ? { attachmentRefs: turn.attachmentRefs } : {}),
    ...(turn.actions?.length
      ? {
          canvasActions: turn.actions.map((action) => ({
            kind: action.kind,
            ok: action.ok,
            ...(action.result !== undefined ? { result: action.result } : {})
          }))
        }
      : {})
  }
  return Object.keys(metadata).length > 0
    ? `${turn.text}\n\n[canvas turn metadata]\n${JSON.stringify(metadata)}`
    : turn.text
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
  timeline: AssistantTimelineBlock[]
}

function ActiveToolStatus({
  active
}: {
  active: Extract<AssistantTimelineBlock, { type: 'tool' }>
}) {
  const { t } = useTranslation('layout')
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [active.startedAt])
  const waiting = active.kind === 'wait_for_node_event'
  const target = active.nodeId ?? active.subscriptionId
  const labelKey = ACTION_LABEL_KEYS[active.kind]
  const toolLabel = labelKey
    ? t(labelKey)
    : active.kind.startsWith('mcp__')
      ? `MCP · ${active.kind.split('__').at(-1)}`
      : active.kind
  return (
    <div className="rounded-md border border-primary/20 bg-primary/5 p-2">
      <div className="flex items-center gap-2">
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <span className="absolute size-5 animate-ping rounded-full bg-primary/15" />
          <Loader2 className="relative size-3.5 animate-spin text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {waiting
              ? t('drawPage.assistantListening', { defaultValue: 'Listening for node events' })
              : t('drawPage.assistantExecutingTool', {
                  tool: toolLabel,
                  defaultValue: 'Executing {{tool}}'
                })}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {target ? `${target.slice(0, 12)} · ` : ''}
            {t('drawPage.assistantElapsed', {
              seconds: elapsed,
              defaultValue: 'Waiting {{seconds}}s'
            })}
          </p>
        </div>
      </div>
      {waiting && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {t('drawPage.assistantListeningHint', {
            defaultValue: 'The assistant will continue automatically when the node finishes.'
          })}
        </p>
      )}
    </div>
  )
}

function Timeline({ blocks, live = false }: { blocks: AssistantTimelineBlock[]; live?: boolean }) {
  const { t } = useTranslation('layout')
  return (
    <div className="space-y-1.5">
      {blocks.map((block, index) => {
        if (block.type === 'text') {
          return (
            <p key={index} className="whitespace-pre-wrap break-words">
              {block.text}
            </p>
          )
        }
        if (block.type === 'thinking') {
          const active = live && index === blocks.length - 1
          return (
            <details key={index} className="rounded-md bg-background/40 px-2 py-1" open={active}>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground">
                {active ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
                {active
                  ? t('drawPage.assistantThinking', { defaultValue: 'Thinking…' })
                  : t('drawPage.assistantThought', { defaultValue: 'Thought' })}
              </summary>
              {!!block.text.trim() && (
                <p className="mt-1 whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                  {block.text}
                </p>
              )}
            </details>
          )
        }
        if (!block.action) return <ActiveToolStatus key={index} active={block} />
        return (
          <div key={index} className="flex items-center gap-1.5">
            <ActionNote action={block.action} />
            {block.finishedAt && (
              <span className="text-[10px] text-muted-foreground">
                {Math.max(0, Math.round((block.finishedAt - block.startedAt) / 1000))}s
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ActionNote({ action }: { action: AssistantAction }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const Icon = ACTION_ICONS[action.kind] ?? (action.kind.startsWith('mcp__') ? Plug : Wand2)
  const labelKey = ACTION_LABEL_KEYS[action.kind]
  const label = labelKey
    ? t(labelKey)
    : action.kind.startsWith('mcp__')
      ? `MCP · ${action.kind.split('__').at(-1)}`
      : action.kind.replaceAll('_', ' ')
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md bg-background/60 px-1.5 py-0.5 text-[10px]',
        action.ok ? 'text-muted-foreground' : 'text-destructive'
      )}
    >
      <Icon className="size-3" />
      {label}
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
    body = (
      <span className="inline-flex min-w-0 items-center gap-1">
        <img src={node.data.src} className="size-6 shrink-0 rounded object-cover" alt="" />
        <span className="max-w-20 truncate">
          {node.data.prompt || t('drawPage.nodeImage', { defaultValue: 'Image' })}
        </span>
      </span>
    )
  } else if (node.kind === 'image') {
    body = (
      <span className="inline-flex min-w-0 items-center gap-1">
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-20 truncate">
          {node.data.prompt || t('drawPage.nodeImage', { defaultValue: 'Image' })}
        </span>
      </span>
    )
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
    body = (
      <span className="inline-flex min-w-0 items-center gap-1">
        <Film className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-20 truncate">
          {node.data.prompt || t('drawPage.modeVideo', { defaultValue: 'Video' })}
        </span>
      </span>
    )
  } else {
    const configLabel =
      node.data.mode === 'video'
        ? t('drawPage.nodeVideoGeneration', { defaultValue: 'Video generation' })
        : node.data.mode === 'text'
          ? t('drawPage.nodeTextGeneration', { defaultValue: 'Text generation' })
          : t('drawPage.nodeImageGeneration', { defaultValue: 'Image generation' })
    const ConfigIcon =
      node.data.mode === 'video' ? Film : node.data.mode === 'text' ? MessageSquareText : ImagePlus
    body = (
      <span className="inline-flex items-center gap-1">
        <ConfigIcon className="size-3 text-muted-foreground" />
        {configLabel}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pl-1 pr-0.5 text-[11px]">
      <button type="button" className="inline-flex items-center" onClick={() => focusNode(node.id)}>
        {body}
        <span className="ml-1 text-[9px] text-muted-foreground/70">{node.id.slice(0, 5)}</span>
        {node.execution && (
          <span className="ml-1 rounded bg-background/70 px-1 text-[9px] text-muted-foreground">
            {t(`drawPage.triggerStatuses.${node.execution.status}`, {
              defaultValue: node.execution.status
            })}
          </span>
        )}
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
  const truncateFromTurn = useAssistantStore((s) => s.truncateFromTurn)
  const deleteTurn = useAssistantStore((s) => s.deleteTurn)
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
  const selectedNodes = useGraphStore(
    useShallow((s) =>
      s.selection
        .map((id) => s.nodes.find((node) => node.id === id))
        .filter((node): node is CanvasNode => !!node)
    )
  )
  const requestContextNodes = useMemo(() => {
    const byId = new Map<string, CanvasNode>()
    contextNodes.forEach((node) => byId.set(node.id, node))
    selectedNodes.forEach((node) => byId.set(node.id, node))
    return [...byId.values()]
  }, [contextNodes, selectedNodes])
  const unpinnedSelectedIds = useMemo(
    () => selectedNodes.map((node) => node.id).filter((id) => !contextIds.includes(id)),
    [contextIds, selectedNodes]
  )
  const graphActions = useGraphActions()
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const providers = useProviderStore((s) => s.providers)

  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [stream, setStream] = useState<StreamState | null>(null)
  const [confirmation, setConfirmation] = useState<CanvasConfirmationRequest | null>(null)
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null)
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(null)

  const shellRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const confirmationResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const streamRef = useRef<StreamState>({ text: '', actions: [], timeline: [] })
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
  const selectedProviderMeta = providers.find(
    (provider) => provider.id === selectedModel?.providerId
  )
  const selectedModelMeta = selectedProviderMeta?.models.find(
    (model) => model.id === selectedModel?.modelId
  )
  const supportsVision = modelSupportsVision(selectedModelMeta, selectedProviderMeta?.type)

  // Drop context chips whose nodes were deleted from the canvas.
  useEffect(() => {
    if (contextNodes.length !== contextIds.length) {
      pruneContext(useGraphStore.getState().nodes.map((n) => n.id))
    }
  }, [contextIds, contextNodes, pruneContext])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, stream])

  useEffect(
    () => () => {
      abortRef.current?.abort()
      confirmationResolveRef.current?.(false)
    },
    []
  )

  useEffect(() => {
    setEditingTurnId(null)
    setEditingText('')
    if (!abortRef.current) return
    abortRef.current.abort()
    confirmationResolveRef.current?.(false)
  }, [projectId])

  useEffect(() => {
    if (open || !abortRef.current) return
    abortRef.current.abort()
    confirmationResolveRef.current?.(false)
  }, [open])

  const addImages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      if (!supportsVision) {
        toast.error(
          t('drawPage.assistantVisionRequired', {
            defaultValue: 'Select a vision-capable model to send images'
          })
        )
        return
      }
      const converted = await Promise.all(files.map(fileToImageAttachment))
      const valid = converted.filter((image): image is ImageAttachment => !!image)
      if (valid.length !== files.length) {
        toast.error(
          t('drawPage.assistantImageInvalid', {
            defaultValue: 'Some images were unsupported or larger than 20 MB'
          })
        )
      }
      setAttachments((current) => [...current, ...valid])
    },
    [supportsVision, t]
  )

  const requestConfirmation = useCallback(
    (request: CanvasConfirmationRequest): Promise<boolean> =>
      new Promise((resolve) => {
        confirmationResolveRef.current?.(false)
        confirmationResolveRef.current = resolve
        setConfirmation(request)
      }),
    []
  )

  const resolveConfirmation = useCallback((approved: boolean) => {
    const resolve = confirmationResolveRef.current
    confirmationResolveRef.current = null
    setConfirmation(null)
    resolve?.(approved)
  }, [])

  const clampToParent = useCallback((x: number, y: number, w: number, h: number) => {
    const parent = shellRef.current?.parentElement
    if (!parent) return { x, y }
    return {
      x: Math.min(Math.max(0, x), Math.max(0, parent.clientWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, parent.clientHeight - h))
    }
  }, [])

  // The dragged position is persisted across window and sidebar sizes. Re-clamp
  // it from the rendered dimensions whenever the panel opens or its container
  // changes, otherwise a previously valid position can leave the assistant fully
  // off-canvas and make the toolbar button appear unresponsive.
  useLayoutEffect(() => {
    if (!open || !storePosition) return
    const shell = shellRef.current
    const parent = shell?.parentElement
    if (!shell || !parent) return

    const keepVisible = (): void => {
      const position = useAssistantStore.getState().position
      if (!position) return
      const next = {
        x: Math.min(
          Math.max(8, position.x),
          Math.max(8, parent.clientWidth - shell.offsetWidth - 8)
        ),
        y: Math.min(
          Math.max(8, position.y),
          Math.max(8, parent.clientHeight - shell.offsetHeight - 8)
        )
      }
      if (next.x !== position.x || next.y !== position.y) setPosition(next)
    }

    keepVisible()
    const observer = new ResizeObserver(keepVisible)
    observer.observe(parent)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [collapsed, open, setPosition, storePosition])

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
    async (
      raw?: string,
      replay?: {
        turn: AssistantTurn
        reuseUserTurn?: boolean
        truncateFromTurnId?: string
        onStarted?: () => void
      }
    ): Promise<void> => {
      const request = (raw ?? input).trim()
      const pendingAttachments = replay ? [] : [...attachments]
      const requestProjectId = projectId
      if ((!request && pendingAttachments.length === 0) || busy) return
      if (pendingAttachments.length > 0 && !supportsVision) {
        toast.error(
          t('drawPage.assistantVisionRequired', {
            defaultValue: 'Select a vision-capable model to send images'
          })
        )
        return
      }
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
      if ((useProjectsStore.getState().activeProjectId ?? 'default') !== requestProjectId) return

      const graphBeforeAttachments = useGraphStore.getState()
      const selectedIds = replay ? [] : [...graphBeforeAttachments.selection]
      const attachmentNodeIds: string[] = []
      if (pendingAttachments.length > 0) {
        const center = screenToWorld(
          {
            x: graphBeforeAttachments.stageSize.width / 2,
            y: graphBeforeAttachments.stageSize.height / 2
          },
          graphBeforeAttachments.camera
        )
        for (let index = 0; index < pendingAttachments.length; index += 1) {
          const attachment = pendingAttachments[index]
          const nodeId = await addImageNodeFromDataUrl(
            attachment.dataUrl,
            {
              x: center.x + index * 36,
              y: center.y + index * 36
            },
            requestProjectId
          )
          attachmentNodeIds.push(nodeId)
        }
        addContext(attachmentNodeIds)
      }
      if ((useProjectsStore.getState().activeProjectId ?? 'default') !== requestProjectId) return
      const graph = useGraphStore.getState()
      const requestedReplayIds = replay
        ? [
            ...(replay.turn.contextNodeIds ?? []),
            ...(replay.turn.attachmentRefs ?? []).map((reference) => reference.nodeId)
          ]
        : []
      const contextNodeIds = [
        ...new Set(
          replay
            ? requestedReplayIds.filter((id) => graph.nodes.some((node) => node.id === id))
            : [...chosen.contextIds, ...selectedIds, ...attachmentNodeIds]
        )
      ]
      if (replay && contextNodeIds.length < new Set(requestedReplayIds).size) {
        toast.warning(
          t('drawPage.assistantReplayMissingContext', {
            defaultValue: 'Some original canvas context is no longer available and was skipped.'
          })
        )
      }
      const ctx = contextNodeIds
        .map((id) => graph.nodes.find((n) => n.id === id))
        .filter((n): n is CanvasNode => !!n)
      const labels: string[] = []
      const imageBlocks: ContentBlock[] = []
      pendingAttachments.forEach((attachment, index) => {
        const nodeId = attachmentNodeIds[index]
        if (nodeId) {
          labels.push(`[uploaded attachment ${attachment.id}] materialized as image node ${nodeId}`)
        }
      })
      for (const node of ctx) {
        if (node.kind === 'text' && node.data.text.trim()) {
          labels.push(`[text node ${node.id}]\n${node.data.text.trim()}`)
        } else if (node.kind === 'image') {
          const block = supportsVision ? await imageContentBlock(node) : null
          if (block) {
            imageBlocks.push(block)
            labels.push(`[image node ${node.id}] (image attached)`)
          } else {
            labels.push(
              `[image node ${node.id}] prompt=${node.data.prompt ?? ''} status=${node.execution?.status ?? 'idle'}`
            )
          }
        } else if (node.kind === 'video') {
          labels.push(
            `[video node ${node.id}] prompt=${node.data.prompt ?? ''} status=${node.execution?.status ?? 'idle'}`
          )
          if (supportsVision && node.data.poster?.startsWith('data:')) {
            const comma = node.data.poster.indexOf(',')
            imageBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                mediaType: 'image/jpeg',
                data: node.data.poster.slice(comma + 1)
              }
            })
          }
        } else if (node.kind === 'config') {
          labels.push(`[config node ${node.id}] ${JSON.stringify(node.data)}`)
        }
      }
      const requestText = request || '[User attached images without additional text.]'
      const userText = labels.length
        ? `Context from canvas:\n${labels.join('\n\n')}\n\n---\n${requestText}`
        : requestText
      const content: string | ContentBlock[] =
        imageBlocks.length > 0 ? [...imageBlocks, { type: 'text', text: userText }] : userText
      if ((useProjectsStore.getState().activeProjectId ?? 'default') !== requestProjectId) return

      if (replay?.truncateFromTurnId) {
        truncateFromTurn(requestProjectId, replay.truncateFromTurnId)
      }
      const storedTurns = useAssistantStore.getState().sessions[requestProjectId] ?? []
      const replayIndex = replay?.reuseUserTurn
        ? storedTurns.findIndex((turn) => turn.id === replay.turn.id)
        : -1
      const priorTurns = replayIndex >= 0 ? storedTurns.slice(0, replayIndex) : storedTurns
      const prior: UnifiedMessage[] = priorTurns.slice(-30).map((turn) => ({
        id: turn.id,
        role: turn.role,
        content: historyTurnText(turn),
        createdAt: turn.createdAt
      }))
      const messages: UnifiedMessage[] = [
        ...prior,
        { id: nanoid(), role: 'user', content, createdAt: Date.now() }
      ]

      if (!replay?.reuseUserTurn) {
        appendTurn(requestProjectId, {
          role: 'user',
          text: requestText,
          contextNodeIds,
          attachmentCount: replay?.turn.attachmentCount ?? pendingAttachments.length,
          attachmentRefs:
            replay?.turn.attachmentRefs ??
            pendingAttachments
              .map((attachment, index) => {
                const nodeId = attachmentNodeIds[index]
                return nodeId ? { attachmentId: attachment.id, nodeId } : null
              })
              .filter(
                (reference): reference is { attachmentId: string; nodeId: string } => !!reference
              )
        })
      }
      if (!raw && !replay) setInput('')
      if (!replay) setAttachments([])
      replay?.onStarted?.()
      setBusy(true)
      streamRef.current = { text: '', actions: [], timeline: [] }
      setStream({ text: '', actions: [], timeline: [] })
      const controller = new AbortController()
      abortRef.current = controller
      try {
        for await (const event of runCanvasAssistantTurn({
          provider: config,
          messages,
          actions: graphActions,
          attachments: pendingAttachments,
          attachmentNodeIds: Object.fromEntries(
            pendingAttachments
              .map((attachment, index) => [attachment.id, attachmentNodeIds[index]] as const)
              .filter((entry): entry is readonly [string, string] => !!entry[1])
          ),
          projectBaseName: t('drawPage.canvasBaseName', { defaultValue: 'Canvas' }),
          projectId: requestProjectId,
          confirm: requestConfirmation,
          signal: controller.signal
        })) {
          if (event.type === 'text') {
            streamRef.current.text += event.text
            const last = streamRef.current.timeline.at(-1)
            if (last?.type === 'text') last.text += event.text
            else streamRef.current.timeline.push({ type: 'text', text: event.text })
          } else if (event.type === 'thinking') {
            const last = streamRef.current.timeline.at(-1)
            if (last?.type === 'thinking') last.text += event.text
            else streamRef.current.timeline.push({ type: 'thinking', text: event.text })
          } else if (event.type === 'action') {
            streamRef.current.actions.push(event.action)
            const pendingTool = [...streamRef.current.timeline]
              .reverse()
              .find((block) => block.type === 'tool' && !block.action)
            if (pendingTool?.type === 'tool') {
              pendingTool.action = event.action
              pendingTool.finishedAt = Date.now()
            } else {
              streamRef.current.timeline.push({
                type: 'tool',
                kind: event.action.kind,
                startedAt: Date.now(),
                finishedAt: Date.now(),
                action: event.action
              })
            }
          } else if (event.type === 'tool_start') {
            streamRef.current.timeline.push({
              type: 'tool',
              kind: event.kind,
              nodeId: event.nodeId,
              subscriptionId: event.subscriptionId,
              startedAt: Date.now()
            })
          }
          setStream({
            text: streamRef.current.text,
            actions: [...streamRef.current.actions],
            timeline: streamRef.current.timeline.map((block) => ({ ...block }))
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          toast.error(t('drawPage.assistantFailed', { defaultValue: 'Assistant request failed' }), {
            description: error instanceof Error ? error.message : String(error)
          })
        }
      } finally {
        resolveConfirmation(false)
        const result = streamRef.current
        if (result.text.trim() || result.actions.length > 0) {
          appendTurn(requestProjectId, {
            role: 'assistant',
            text: result.text.trim() || '…',
            ...(result.actions.length > 0 ? { actions: result.actions } : {}),
            ...(result.timeline.length > 0 ? { timeline: result.timeline } : {})
          })
        }
        setStream(null)
        setBusy(false)
        abortRef.current = null
      }
    },
    [
      addContext,
      appendTurn,
      attachments,
      busy,
      graphActions,
      input,
      projectId,
      requestConfirmation,
      resolveConfirmation,
      supportsVision,
      t,
      truncateFromTurn
    ]
  )

  const confirmRetainedSideEffects = useCallback(
    async (affectedTurns: AssistantTurn[]): Promise<boolean> => {
      if (!affectedTurns.some((turn) => turn.actions && turn.actions.length > 0)) return true
      return await confirm({
        title: t('drawPage.assistantSideEffectsTitle', {
          defaultValue: 'Tool side effects will remain'
        }),
        description: t('drawPage.assistantSideEffectsWarning', {
          defaultValue:
            'This conversation contains tool actions. Editing or deleting messages will not undo canvas, file, Shell, or MCP side effects. Continue?'
        }),
        variant: 'destructive'
      })
    },
    [t]
  )

  const submitUserRewrite = useCallback(
    async (turn: AssistantTurn): Promise<void> => {
      const nextText = editingText.trim()
      if (!nextText || busy) return
      const currentTurns = useAssistantStore.getState().sessions[projectId] ?? []
      const index = currentTurns.findIndex((candidate) => candidate.id === turn.id)
      if (index < 0 || !(await confirmRetainedSideEffects(currentTurns.slice(index)))) return
      await send(nextText, {
        turn: { ...turn, text: nextText },
        truncateFromTurnId: turn.id,
        onStarted: () => {
          setEditingTurnId(null)
          setEditingText('')
        }
      })
    },
    [busy, confirmRetainedSideEffects, editingText, projectId, send]
  )

  const regenerateAssistantTurn = useCallback(
    async (turn: AssistantTurn): Promise<void> => {
      if (busy) return
      const currentTurns = useAssistantStore.getState().sessions[projectId] ?? []
      const index = currentTurns.findIndex((candidate) => candidate.id === turn.id)
      if (index < 0 || !(await confirmRetainedSideEffects(currentTurns.slice(index)))) return
      const precedingUser = currentTurns
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.role === 'user')
      if (!precedingUser) return
      await send(precedingUser.text, {
        turn: precedingUser,
        reuseUserTurn: true,
        truncateFromTurnId: turn.id
      })
    },
    [busy, confirmRetainedSideEffects, projectId, send]
  )

  const removeMessageTurn = useCallback(
    async (turn: AssistantTurn): Promise<void> => {
      if (busy) return
      const currentTurns = useAssistantStore.getState().sessions[projectId] ?? []
      const index = currentTurns.findIndex((candidate) => candidate.id === turn.id)
      if (index < 0) return
      let affected = [turn]
      if (turn.role === 'user') {
        const nextUserOffset = currentTurns
          .slice(index + 1)
          .findIndex((candidate) => candidate.role === 'user')
        const end = nextUserOffset < 0 ? currentTurns.length : index + 1 + nextUserOffset
        affected = currentTurns.slice(index, end)
      }
      if (!(await confirmRetainedSideEffects(affected))) return
      deleteTurn(projectId, turn.id)
      if (editingTurnId === turn.id) {
        setEditingTurnId(null)
        setEditingText('')
      }
    },
    [busy, confirmRetainedSideEffects, deleteTurn, editingTurnId, projectId]
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
  const confirmationTitle = confirmation
    ? confirmation.kind === 'tool'
      ? t('drawPage.assistantConfirm.tool.title', {
          toolName: confirmation.toolName,
          defaultValue: 'Allow {{toolName}}?'
        })
      : t(`drawPage.assistantConfirm.${confirmation.kind}.title`, {
          defaultValue:
            confirmation.kind === 'cancel_node' ? 'Cancel generation?' : 'Confirm canvas change'
        })
    : ''
  const confirmationDescription = confirmation
    ? confirmation.kind === 'tool'
      ? t('drawPage.assistantConfirm.tool.description', {
          input: confirmation.inputPreview ?? '',
          defaultValue: 'Review this tool operation before allowing it.\n{{input}}'
        })
      : t(`drawPage.assistantConfirm.${confirmation.kind}.description`, {
          count: confirmation.count,
          nodeId: confirmation.nodeId,
          defaultValue: 'This operation may replace or permanently remove canvas data.'
        })
    : ''

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
              count: requestContextNodes.length,
              defaultValue: '{{count}} in context'
            })}
          </span>
          {unpinnedSelectedIds.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10"
              onClick={() => addContext(unpinnedSelectedIds)}
            >
              <Pin className="size-3" />
              {t('drawPage.assistantPinSelection', {
                count: unpinnedSelectedIds.length,
                defaultValue: 'Pin selected ({{count}})'
              })}
            </button>
          )}
        </div>
        {requestContextNodes.length > 0 && (
          <div className="mt-1.5 flex max-h-16 flex-wrap gap-1 overflow-y-auto">
            {requestContextNodes.map((node) => (
              <ContextChip
                key={node.id}
                node={node}
                onRemove={(id) => {
                  removeContext(id)
                  const state = useGraphStore.getState()
                  if (state.selection.includes(id)) {
                    state.setSelection(state.selection.filter((selectedId) => selectedId !== id))
                  }
                }}
              />
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
        {turns.map((turn) => (
          <div
            key={turn.id}
            className={cn(
              'group/turn relative rounded-lg px-2.5 py-1.5 text-xs',
              turn.role === 'user' ? 'bg-primary/10 text-foreground' : 'bg-muted'
            )}
          >
            {!busy && editingTurnId !== turn.id && (
              <div className="absolute right-1 top-1 flex items-center rounded-md bg-background/90 opacity-0 shadow-sm transition-opacity group-hover/turn:opacity-100 group-focus-within/turn:opacity-100">
                {turn.role === 'user' ? (
                  <button
                    type="button"
                    title={t('drawPage.assistantRewrite', {
                      defaultValue: 'Edit and regenerate'
                    })}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      setEditingTurnId(turn.id)
                      setEditingText(turn.text)
                    }}
                  >
                    <Pencil className="size-3" />
                  </button>
                ) : (
                  <button
                    type="button"
                    title={t('drawPage.assistantRegenerate', { defaultValue: 'Regenerate' })}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => void regenerateAssistantTurn(turn)}
                  >
                    <RefreshCw className="size-3" />
                  </button>
                )}
                <button
                  type="button"
                  title={t('drawPage.assistantDeleteMessage', { defaultValue: 'Delete message' })}
                  className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void removeMessageTurn(turn)}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            )}
            {!turn.timeline && turn.actions && turn.actions.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1">
                {turn.actions.map((action, j) => (
                  <ActionNote key={j} action={action} />
                ))}
              </div>
            )}
            {!!turn.attachmentCount && (
              <span className="mb-1 inline-flex items-center gap-1 rounded bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                <ImageIcon className="size-3" />
                {t('drawPage.assistantImagesAttached', {
                  count: turn.attachmentCount,
                  defaultValue: '{{count}} image(s)'
                })}
              </span>
            )}
            {turn.role === 'user' && editingTurnId === turn.id ? (
              <div className="space-y-1.5 pt-1">
                <Textarea
                  autoFocus
                  value={editingText}
                  className="min-h-20 resize-y bg-background text-xs"
                  onChange={(event) => setEditingText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void submitUserRewrite(turn)
                    }
                    if (event.key === 'Escape') {
                      setEditingTurnId(null)
                      setEditingText('')
                    }
                  }}
                />
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingTurnId(null)
                      setEditingText('')
                    }}
                  >
                    {t('action.cancel', { ns: 'common', defaultValue: 'Cancel' })}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!editingText.trim()}
                    onClick={() => void submitUserRewrite(turn)}
                  >
                    <RefreshCw className="mr-1 size-3" />
                    {t('drawPage.assistantRegenerate', { defaultValue: 'Regenerate' })}
                  </Button>
                </div>
              </div>
            ) : turn.role === 'assistant' && turn.timeline ? (
              <Timeline blocks={turn.timeline} />
            ) : (
              <p className="whitespace-pre-wrap break-words">{turn.text}</p>
            )}
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
            {stream.timeline.length > 0 ? (
              <Timeline blocks={stream.timeline} live />
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
        {confirmation && (
          <div className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <p className="font-medium">{confirmationTitle}</p>
            <p className="mt-0.5 whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
              {confirmationDescription}
            </p>
            <div className="mt-2 flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => resolveConfirmation(false)}>
                {t('drawPage.assistantReject', { defaultValue: 'Reject' })}
              </Button>
              <Button size="sm" onClick={() => resolveConfirmation(true)}>
                {t('drawPage.assistantApprove', { defaultValue: 'Approve' })}
              </Button>
            </div>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="mb-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="group/attachment relative">
                <img
                  src={attachment.dataUrl}
                  alt=""
                  className="size-12 rounded-md border object-cover"
                />
                <button
                  type="button"
                  className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-background text-muted-foreground shadow opacity-0 group-hover/attachment:opacity-100"
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((candidate) => candidate.id !== attachment.id)
                    )
                  }
                >
                  <X className="size-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && !supportsVision && (
          <p className="mb-2 text-[11px] text-destructive">
            {t('drawPage.assistantVisionRequired', {
              defaultValue: 'Select a vision-capable model to send images'
            })}
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={(event) => {
            void addImages(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        <div
          className="relative"
          onDragOver={(event) => {
            if (
              supportsVision &&
              Array.from(event.dataTransfer.items).some((i) => i.type.startsWith('image/'))
            ) {
              event.preventDefault()
              event.stopPropagation()
            }
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer.files).filter((file) =>
              file.type.startsWith('image/')
            )
            if (files.length === 0) return
            event.preventDefault()
            event.stopPropagation()
            void addImages(files)
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((file): file is File => !!file)
              if (files.length === 0) return
              event.preventDefault()
              void addImages(files)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={t('drawPage.assistantPlaceholder', { defaultValue: 'Ask the assistant…' })}
            className={cn(
              'max-h-28 min-h-9 resize-none text-sm',
              supportsVision ? 'pl-9 pr-10' : 'pr-10'
            )}
            rows={1}
          />
          {supportsVision && (
            <Button
              size="icon"
              variant="ghost"
              className="absolute bottom-1.5 left-1.5 size-7"
              title={t('drawPage.assistantAttachImage', { defaultValue: 'Attach image' })}
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <Paperclip className="size-3.5" />
            </Button>
          )}
          {busy ? (
            <Button
              size="icon"
              variant="secondary"
              className="absolute bottom-1.5 right-1.5 size-7"
              title={t('drawPage.assistantStop', { defaultValue: 'Stop' })}
              onClick={() => {
                resolveConfirmation(false)
                abortRef.current?.abort()
              }}
            >
              <Square className="size-3" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="absolute bottom-1.5 right-1.5 size-7"
              onClick={() => void send()}
              disabled={
                (!input.trim() && attachments.length === 0) ||
                (attachments.length > 0 && !supportsVision)
              }
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
