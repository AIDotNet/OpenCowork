import * as React from 'react'
import { useState as useLocalState } from 'react'
import { toast } from 'sonner'
import {
  Send,
  FolderOpen,
  AlertTriangle,
  FileUp,
  Sparkles,
  X,
  Trash2,
  ImagePlus,
  ClipboardList,
  Globe,
  Wand2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Command
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import type { AIModelConfig, UnifiedMessage } from '@renderer/lib/api/types'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { updateWebSearchToolRegistration } from '@renderer/lib/tools'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { formatTokens } from '@renderer/lib/format-tokens'
import { useDebouncedTokens } from '@renderer/hooks/use-estimated-tokens'
import { usePromptRecommendation } from '@renderer/hooks/use-prompt-recommendation'
import { useChatStore } from '@renderer/stores/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import {
  ACCEPTED_IMAGE_TYPES,
  cloneImageAttachments,
  fileToImageAttachment,
  hasEditableDraftContent,
  type EditableUserMessageDraft,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import {
  getSelectFileMentionQuery,
  selectFileTextToPlainText
} from '@renderer/lib/select-file-tags'
import {
  createFileReferenceNode,
  createTextReplacementNode,
  deserializeEditorState,
  documentHasFileReferences,
  editorDocumentToPlainText,
  ensureSelectedFile,
  mergeSelectedFiles,
  normalizeSelectionToFileBoundaries,
  removeReferenceNode,
  removeSelectedFile,
  replaceEditorRange,
  serializeEditorDocument,
  type EditorDocumentNode,
  type SelectedFileItem
} from '@renderer/lib/select-file-editor'
import { SkillsMenu } from './SkillsMenu'
import { ModelSwitcher } from './ModelSwitcher'
import { FileAwareEditor, type FileAwareEditorHandle } from './FileAwareEditor'
import { SelectedFileBar } from './SelectedFileBar'
import { listCommands, type CommandCatalogItem } from '@renderer/lib/commands/command-loader'
import { useMcpStore } from '@renderer/stores/mcp-store'
import {
  clearPendingSessionMessages,
  dispatchNextQueuedMessageForSession,
  getPendingSessionMessages,
  isPendingSessionDispatchPaused,
  removePendingSessionMessage,
  subscribePendingSessionMessages,
  updatePendingSessionMessageDraft,
  type PendingSessionMessageItem
} from '@renderer/hooks/use-chat-actions'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@renderer/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

function ContextRing(): React.JSX.Element | null {
  const chatView = useUIStore((s) => s.chatView)

  const activeModelCfg = useProviderStore((s) => {
    const { providers, activeProviderId, activeModelId } = s
    if (!activeProviderId) return null
    const provider = providers.find((p) => p.id === activeProviderId)
    return provider?.models.find((m) => m.id === activeModelId) ?? null
  }) as AIModelConfig | null

  const ctxLimit = activeModelCfg?.contextLength ?? null

  const lastUsage = useChatStore((s) => {
    const activeSession = s.sessions.find((sess) => sess.id === s.activeSessionId)
    if (!activeSession) return null
    const messages = activeSession.messages
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const usage = messages[index]?.usage
      if (usage) return usage
    }
    return null
  })

  const ctxUsed = lastUsage?.contextTokens ?? lastUsage?.inputTokens ?? 0

  if (chatView !== 'session' || !ctxLimit || ctxUsed <= 0) return null

  const pct = Math.min((ctxUsed / ctxLimit) * 100, 100)
  const remaining = Math.max(ctxLimit - ctxUsed, 0)
  const strokeColor =
    pct > 80 ? 'stroke-red-500' : pct > 50 ? 'stroke-amber-500' : 'stroke-emerald-500'

  // SVG circular progress
  const size = 26
  const strokeWidth = 2.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - pct / 100)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center justify-center cursor-default">
          <svg width={size} height={size} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              className="stroke-muted/30"
              strokeWidth={strokeWidth}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              className={`${strokeColor} transition-all duration-500`}
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
            />
          </svg>
          <span className="absolute text-[7px] font-medium text-muted-foreground tabular-nums select-none">
            {pct < 10 ? `${pct.toFixed(0)}` : `${pct.toFixed(0)}`}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-xs space-y-0.5">
          <p className="font-medium">Context Window</p>
          <p className="text-muted-foreground">
            {formatTokens(ctxUsed)} / {formatTokens(ctxLimit)} ({pct.toFixed(1)}%)
          </p>
          <p className="text-muted-foreground">{formatTokens(remaining)} remaining</p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function ActiveMcpsBadge(): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const activeMcpIds = useMcpStore((s) => s.activeMcpIds)
  const servers = useMcpStore((s) => s.servers)
  const serverTools = useMcpStore((s) => s.serverTools)
  if (activeMcpIds.length === 0) return null
  const activeServers = servers.filter((s) => activeMcpIds.includes(s.id))
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-600 dark:text-blue-400 cursor-default">
          <span className="size-1.5 rounded-full bg-blue-500 animate-pulse" />
          <span>{t('skills.mcpCount', { count: activeMcpIds.length })}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs font-medium">{t('skills.activeMcpServers')}</p>
        {activeServers.map((s) => (
          <p key={s.id} className="text-xs text-muted-foreground">
            {s.name} ({t('skills.mcpToolCount', { count: serverTools[s.id]?.length ?? 0 })})
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

const placeholderKeys: Record<AppMode, string> = {
  chat: 'input.placeholder',
  clarify: 'input.placeholderClarify',
  cowork: 'input.placeholderCowork',
  code: 'input.placeholderCode'
}

const defaultRecommendationKeys: Record<AppMode, string> = {
  chat: 'input.recommendationDefaultChat',
  clarify: 'input.recommendationDefaultClarify',
  cowork: 'input.recommendationDefaultCowork',
  code: 'input.recommendationDefaultCode'
}

interface InputHistoryEntry {
  text: string
  images: ImageAttachment[]
  selectedFiles: SelectedFileItem[]
}

interface InputHistoryDraft {
  text: string
  images: ImageAttachment[]
  selectedSkill: string | null
  selectedFiles: SelectedFileItem[]
}

interface FileSearchItem {
  name: string
  path: string
}

const EMPTY_QUEUED_MESSAGES: PendingSessionMessageItem[] = []
const EMPTY_SESSION_MESSAGES: UnifiedMessage[] = []
const INPUT_HISTORY_LIMIT = 30
const PENDING_HISTORY_KEY = '__pending_session__'
const MIN_INPUT_HEIGHT = 120
const MAX_INPUT_HEIGHT = 500
const MIN_MESSAGE_LIST_HEIGHT = 120
const FALLBACK_MAX_VIEWPORT_RATIO = 0.6
const MAX_SLASH_COMMAND_RESULTS = 8

function getSlashCommandQuery(text: string): string | null {
  const normalized = text.trimStart()
  const match = normalized.match(/^\/([^\s]*)$/)
  return match ? (match[1] ?? '') : null
}

function scoreSlashCommand(name: string, query: string): number {
  const normalizedName = name.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()

  if (!normalizedQuery) return 0
  if (normalizedName === normalizedQuery) return 0
  if (normalizedName.startsWith(normalizedQuery)) return 1

  const containsIndex = normalizedName.indexOf(normalizedQuery)
  if (containsIndex >= 0) return 10 + containsIndex

  let cursor = 0
  let gapScore = 0
  for (const char of normalizedQuery) {
    const nextIndex = normalizedName.indexOf(char, cursor)
    if (nextIndex < 0) return Number.POSITIVE_INFINITY
    gapScore += nextIndex - cursor
    cursor = nextIndex + 1
  }

  return 100 + gapScore
}

function areQueuedMessagesEqual(
  left: PendingSessionMessageItem[],
  right: PendingSessionMessageItem[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    const leftMsg = left[i]
    const rightMsg = right[i]
    if (leftMsg.id !== rightMsg.id) return false
    if (leftMsg.text !== rightMsg.text) return false
    if (leftMsg.createdAt !== rightMsg.createdAt) return false
    if (leftMsg.command?.name !== rightMsg.command?.name) return false
    if (leftMsg.command?.content !== rightMsg.command?.content) return false
    if (leftMsg.images.length !== rightMsg.images.length) return false
    for (let j = 0; j < leftMsg.images.length; j += 1) {
      if (leftMsg.images[j].id !== rightMsg.images[j].id) return false
    }
  }
  return true
}

function summarizeQueuedMessage(text: string): string {
  const normalized = selectFileTextToPlainText(text).replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized
}

interface InputAreaProps {
  onSend: (text: string, images?: ImageAttachment[]) => void
  onStop?: () => void
  onSelectFolder?: () => void
  isStreaming?: boolean
  workingFolder?: string
  hideWorkingFolderIndicator?: boolean
  disabled?: boolean
}

export function InputArea({
  onSend,
  onStop,
  onSelectFolder,
  isStreaming = false,
  workingFolder,
  hideWorkingFolderIndicator = false,
  disabled = false
}: InputAreaProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [editorDocument, setEditorDocument] = React.useState<EditorDocumentNode[]>([])
  const [selectedFiles, setSelectedFiles] = React.useState<SelectedFileItem[]>([])
  const [highlightedFileId, setHighlightedFileId] = React.useState<string | null>(null)
  const [editorSelection, setEditorSelection] = React.useState({ start: 0, end: 0 })
  const text = React.useMemo(
    () => serializeEditorDocument(editorDocument, selectedFiles),
    [editorDocument, selectedFiles]
  )
  const finalSerializedText = React.useMemo(
    () => serializeEditorDocument(editorDocument, selectedFiles, { appendUnreferencedFiles: true }),
    [editorDocument, selectedFiles]
  )
  const plainText = React.useMemo(
    () => editorDocumentToPlainText(editorDocument, selectedFiles),
    [editorDocument, selectedFiles]
  )
  const debouncedTokens = useDebouncedTokens(text)
  const [selectedSkill, setSelectedSkill] = React.useState<string | null>(null)
  const [slashCommands, setSlashCommands] = React.useState<CommandCatalogItem[]>([])
  const [slashCommandsLoading, setSlashCommandsLoading] = React.useState(false)
  const [selectedSlashIndex, setSelectedSlashIndex] = React.useState(0)
  const [fileSearchResults, setFileSearchResults] = React.useState<FileSearchItem[]>([])
  const [fileSearchLoading, setFileSearchLoading] = React.useState(false)
  const [selectedFileSearchIndex, setSelectedFileSearchIndex] = React.useState(0)
  const [attachedImages, setAttachedImages] = React.useState<ImageAttachment[]>([])
  const [isOptimizing, setIsOptimizing] = React.useState(false)
  const [, setOptimizingText] = React.useState('')
  const [optimizationOptions, setOptimizationOptions] = React.useState<
    Array<{ title: string; focus: string; content: string }>
  >([])
  const [showOptimizationDialog, setShowOptimizationDialog] = React.useState(false)
  const [selectedOptionIndex, setSelectedOptionIndex] = React.useState(0)
  const currentLanguage = useSettingsStore((state) => state.language)
  const clarifyAutoAcceptRecommended = useSettingsStore(
    (state) => state.clarifyAutoAcceptRecommended
  )
  const contentScrollRef = React.useRef<HTMLDivElement>(null)
  const editorRef = React.useRef<FileAwareEditorHandle>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const queueFileInputRef = React.useRef<HTMLInputElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [inputHeight, setInputHeight] = React.useState<number | null>(null)
  const dragRef = React.useRef<{ startY: number; startH: number; maxH: number } | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const setInputSelection = setEditorSelection
  const serializedTextRef = React.useRef(text)
  const selectedFilesRef = React.useRef(selectedFiles)

  const getMaxInputHeight = React.useCallback(() => {
    const container = containerRef.current
    if (!container) {
      return Math.max(
        MIN_INPUT_HEIGHT,
        Math.min(MAX_INPUT_HEIGHT, Math.floor(window.innerHeight * FALLBACK_MAX_VIEWPORT_RATIO))
      )
    }
    const root = rootRef.current
    const messageListEl = root?.parentElement?.querySelector(
      '[data-message-list]'
    ) as HTMLElement | null
    if (messageListEl) {
      const messageListHeight = messageListEl.getBoundingClientRect().height
      const available = Math.max(0, messageListHeight - MIN_MESSAGE_LIST_HEIGHT)
      const dynamicMax = container.offsetHeight + available
      return Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, Math.floor(dynamicMax)))
    }
    return Math.max(
      MIN_INPUT_HEIGHT,
      Math.min(MAX_INPUT_HEIGHT, Math.floor(window.innerHeight * FALLBACK_MAX_VIEWPORT_RATIO))
    )
  }, [])

  React.useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY
      const newH = Math.min(
        dragRef.current.maxH,
        Math.max(MIN_INPUT_HEIGHT, dragRef.current.startH + delta)
      )
      setInputHeight(newH)
    }
    const onMouseUp = (): void => {
      if (dragRef.current) {
        dragRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  React.useEffect(() => {
    if (inputHeight === null) return
    const handleResize = (): void => {
      const maxH = getMaxInputHeight()
      setInputHeight((prev) => {
        if (prev === null) return prev
        return Math.min(prev, maxH)
      })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [inputHeight, getMaxInputHeight])

  const handleDragStart = React.useCallback(
    (e: React.MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      dragRef.current = { startY: e.clientY, startH: el.offsetHeight, maxH: getMaxInputHeight() }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [getMaxInputHeight]
  )
  const [sentHistory, setSentHistory] = React.useState<InputHistoryEntry[]>([])
  const [historyCursor, setHistoryCursor] = React.useState<number | null>(null)
  const historyDraftRef = React.useRef<InputHistoryDraft | null>(null)
  const historyBySessionRef = React.useRef<Record<string, InputHistoryEntry[]>>({})
  const prevSessionIdRef = React.useRef<string | null>(null)
  /** Per-session input draft (text + images + skill + files) */
  const draftBySessionRef = React.useRef<
    Record<
      string,
      {
        text: string
        images: ImageAttachment[]
        skill: string | null
        selectedFiles: SelectedFileItem[]
      }
    >
  >({})

  const activeProvider = useProviderStore((s) => {
    const { providers, activeProviderId } = s
    if (!activeProviderId) return null
    return providers.find((p) => p.id === activeProviderId) ?? null
  })
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const supportsVision = React.useMemo(() => {
    if (!activeProvider) return false
    const model = activeProvider.models.find((m) => m.id === activeModelId)
    return modelSupportsVision(model, activeProvider.type)
  }, [activeProvider, activeModelId])
  const webSearchEnabled = useSettingsStore((s) => s.webSearchEnabled)
  const toggleWebSearch = React.useCallback(() => {
    const store = useSettingsStore.getState()
    const newEnabled = !store.webSearchEnabled
    useSettingsStore.getState().updateSettings({ webSearchEnabled: newEnabled })
    updateWebSearchToolRegistration(newEnabled)
  }, [])
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const openFilePreview = useUIStore((s) => s.openFilePreview)
  const mode = useUIStore((s) => s.mode)
  const { activeSessionId, hasMessages, clearSessionMessages, sessionMessages } = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((sess) => sess.id === s.activeSessionId)
      return {
        activeSessionId: s.activeSessionId,
        hasMessages: (activeSession?.messageCount ?? 0) > 0,
        clearSessionMessages: s.clearSessionMessages,
        sessionMessages: activeSession?.messages ?? EMPTY_SESSION_MESSAGES
      }
    })
  )
  const queuedMessagesSnapshotRef = React.useRef<PendingSessionMessageItem[]>(EMPTY_QUEUED_MESSAGES)
  const getQueuedMessagesSnapshot = React.useCallback(() => {
    const next = activeSessionId
      ? getPendingSessionMessages(activeSessionId)
      : EMPTY_QUEUED_MESSAGES
    const prev = queuedMessagesSnapshotRef.current
    if (prev !== next && areQueuedMessagesEqual(prev, next)) {
      return prev
    }
    queuedMessagesSnapshotRef.current = next
    return next
  }, [activeSessionId])
  const queuedMessages = React.useSyncExternalStore(
    subscribePendingSessionMessages,
    getQueuedMessagesSnapshot,
    () => EMPTY_QUEUED_MESSAGES
  )
  const isQueueDispatchPaused = React.useSyncExternalStore(
    subscribePendingSessionMessages,
    () => (activeSessionId ? isPendingSessionDispatchPaused(activeSessionId) : false),
    () => false
  )
  const [editingQueueItemId, setEditingQueueItemId] = React.useState<string | null>(null)
  const [editingQueueText, setEditingQueueText] = React.useState('')
  const [editingQueueImages, setEditingQueueImages] = React.useState<ImageAttachment[]>([])
  const queueExpandedBySessionRef = React.useRef<Record<string, boolean>>({})
  const previousQueueSizeBySessionRef = React.useRef<Record<string, number>>({})
  const [isQueueExpanded, setIsQueueExpanded] = React.useState(false)
  const [queueClearConfirmOpen, setQueueClearConfirmOpen] = React.useState(false)
  const [autoAcceptCountdown, setAutoAcceptCountdown] = React.useState<number | null>(null)

  const startEditQueuedMessage = React.useCallback((msg: PendingSessionMessageItem) => {
    setEditingQueueItemId(msg.id)
    setEditingQueueText(msg.text)
    setEditingQueueImages(cloneImageAttachments(msg.images))
  }, [])

  const cancelEditQueuedMessage = React.useCallback(() => {
    setEditingQueueItemId(null)
    setEditingQueueText('')
    setEditingQueueImages([])
  }, [])

  const removeQueuedMessage = React.useCallback(
    (id: string) => {
      if (!activeSessionId) return
      removePendingSessionMessage(activeSessionId, id)
      if (editingQueueItemId === id) {
        setEditingQueueItemId(null)
        setEditingQueueText('')
        setEditingQueueImages([])
      }
    },
    [activeSessionId, editingQueueItemId]
  )

  const addQueuedImages = React.useCallback(async (files: File[]) => {
    const results = await Promise.all(files.map(fileToImageAttachment))
    const valid = results.filter(Boolean) as ImageAttachment[]
    if (valid.length > 0) {
      setEditingQueueImages((prev) => [...prev, ...valid])
    }
  }, [])

  const removeQueuedImage = React.useCallback((id: string) => {
    setEditingQueueImages((prev) => prev.filter((img) => img.id !== id))
  }, [])

  const saveQueuedMessage = React.useCallback(
    (id: string) => {
      if (!activeSessionId) return
      const targetMessage = queuedMessages.find((msg) => msg.id === id)
      if (!targetMessage) return

      const nextDraft: EditableUserMessageDraft = {
        text: editingQueueText.trim(),
        images: cloneImageAttachments(editingQueueImages),
        command: targetMessage.command
      }

      if (!hasEditableDraftContent(nextDraft)) {
        removePendingSessionMessage(activeSessionId, id)
        setEditingQueueItemId(null)
        setEditingQueueText('')
        setEditingQueueImages([])
        return
      }

      updatePendingSessionMessageDraft(activeSessionId, id, nextDraft)
      setEditingQueueItemId(null)
      setEditingQueueText('')
      setEditingQueueImages([])
    },
    [activeSessionId, queuedMessages, editingQueueText, editingQueueImages]
  )

  const toggleQueueExpanded = React.useCallback(() => {
    setIsQueueExpanded((prev) => {
      const next = !prev
      if (activeSessionId) {
        queueExpandedBySessionRef.current[activeSessionId] = next
      }
      return next
    })
  }, [activeSessionId])

  const clearQueuedMessagesForActiveSession = React.useCallback(() => {
    if (!activeSessionId) return
    const cleared = clearPendingSessionMessages(activeSessionId)
    if (cleared === 0) return
    setQueueClearConfirmOpen(false)
    cancelEditQueuedMessage()
    toast.success(t('input.queueCleared', { defaultValue: '已清空排队消息' }))
  }, [activeSessionId, cancelEditQueuedMessage, t])

  const handleClearQueuedMessages = React.useCallback(() => {
    if (queuedMessages.length <= 1) {
      clearQueuedMessagesForActiveSession()
      return
    }
    setQueueClearConfirmOpen(true)
  }, [clearQueuedMessagesForActiveSession, queuedMessages.length])

  const resumeQueuedMessages = React.useCallback(() => {
    if (!activeSessionId) return
    dispatchNextQueuedMessageForSession(activeSessionId)
  }, [activeSessionId])

  const getHistoryKey = React.useCallback(
    () => activeSessionId ?? PENDING_HISTORY_KEY,
    [activeSessionId]
  )
  const updateSessionHistory = React.useCallback(
    (updater: (prev: InputHistoryEntry[]) => InputHistoryEntry[]) => {
      const historyKey = getHistoryKey()
      const prevHistory = historyBySessionRef.current[historyKey] ?? []
      const nextHistory = updater(prevHistory)
      historyBySessionRef.current[historyKey] = nextHistory
      setSentHistory(nextHistory)
    },
    [getHistoryKey]
  )
  const clearHistoryNavigation = React.useCallback(() => {
    if (historyCursor !== null) {
      setHistoryCursor(null)
      historyDraftRef.current = null
    }
  }, [historyCursor])
  React.useEffect(() => {
    serializedTextRef.current = text
  }, [text])
  React.useEffect(() => {
    selectedFilesRef.current = selectedFiles
  }, [selectedFiles])
  const applyEditorStateFromSerializedText = React.useCallback(
    (nextText: string, nextSelectedFiles?: SelectedFileItem[]) => {
      const parsed = deserializeEditorState(
        nextText,
        workingFolder,
        nextSelectedFiles ?? selectedFiles
      )
      setEditorDocument(parsed.document)
      setSelectedFiles(parsed.selectedFiles)
    },
    [selectedFiles, workingFolder]
  )
  const setText = React.useCallback(
    (value: string | ((prev: string) => string)) => {
      const previousText = serializedTextRef.current
      const previousFiles = selectedFilesRef.current
      const nextText = typeof value === 'function' ? value(previousText) : value
      const parsed = deserializeEditorState(nextText, workingFolder, previousFiles)
      setEditorDocument(parsed.document)
      setSelectedFiles(parsed.selectedFiles)
    },
    [workingFolder]
  )

  const focusInputAtEnd = React.useCallback(() => {
    editorRef.current?.focusAtEnd()
  }, [])

  const getNormalizedSelection = React.useCallback(
    (start: number, end: number) =>
      normalizeSelectionToFileBoundaries(editorDocument, selectedFiles, start, end),
    [editorDocument, selectedFiles]
  )
  const hasFileReferences = React.useMemo(
    () => documentHasFileReferences(editorDocument),
    [editorDocument]
  )

  const replaceSelectionWithNodes = React.useCallback(
    (
      replacement: EditorDocumentNode[],
      selection: { start: number; end: number } = editorSelection,
      cursorOffset = 0
    ) => {
      const normalized = getNormalizedSelection(selection.start, selection.end)
      const nextDocument = replaceEditorRange(
        editorDocument,
        selectedFiles,
        normalized.start,
        normalized.end,
        replacement
      )
      const replacementLength = replacement.reduce(
        (sum, node) => sum + editorDocumentToPlainText([node], selectedFiles).length,
        0
      )
      const nextCursor = normalized.start + replacementLength + cursorOffset
      setEditorDocument(nextDocument)
      requestAnimationFrame(() => {
        editorRef.current?.focus()
        editorRef.current?.setSelectionOffsets(nextCursor, nextCursor)
      })
    },
    [editorDocument, editorSelection, getNormalizedSelection, selectedFiles]
  )

  const recommendationFallback = t(defaultRecommendationKeys[mode])
  const shouldAutoAcceptRecommendation =
    mode === 'clarify' && clarifyAutoAcceptRecommended && !disabled && !isOptimizing && !isStreaming
  const getCaretAtEnd = React.useCallback(() => {
    return editorSelection.start === editorSelection.end && editorSelection.end === plainText.length
  }, [editorSelection.end, editorSelection.start, plainText.length])
  const {
    suggestionText,
    effectivePlaceholder,
    acceptSuggestion,
    handleFocus: handleRecommendationFocus,
    handleBlur: handleRecommendationBlur,
    handleSelectionChange: handleRecommendationSelectionChange,
    handleCompositionStart: handleRecommendationCompositionStart,
    handleCompositionEnd: handleRecommendationCompositionEnd
  } = usePromptRecommendation({
    mode,
    sessionId: activeSessionId,
    text,
    recentMessages: sessionMessages,
    selectedSkill,
    images: attachedImages,
    disabled: disabled || isOptimizing,
    isStreaming,
    fallbackSuggestion: recommendationFallback,
    getCaretAtEnd
  })
  const activeFileMention = React.useMemo(() => {
    if (editorSelection.start !== editorSelection.end) return null
    return getSelectFileMentionQuery(plainText, editorSelection.end)
  }, [editorSelection.end, editorSelection.start, plainText])
  const fileQuery = activeFileMention?.query.trim() ?? ''
  const fileMenuOpen = Boolean(activeFileMention && fileQuery && workingFolder)
  const slashQuery = React.useMemo(() => getSlashCommandQuery(plainText), [plainText])
  const filteredSlashCommands = React.useMemo(() => {
    const query = slashQuery ?? ''
    return slashCommands
      .map((command) => ({ command, score: scoreSlashCommand(command.name, query) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((left, right) => {
        if (left.score !== right.score) return left.score - right.score
        return left.command.name.localeCompare(right.command.name, undefined, {
          sensitivity: 'base'
        })
      })
      .slice(0, MAX_SLASH_COMMAND_RESULTS)
      .map((item) => item.command)
  }, [slashCommands, slashQuery])
  const slashMenuOpen = slashQuery !== null

  React.useEffect(() => {
    if (!slashMenuOpen) {
      setSelectedSlashIndex(0)
      setSlashCommandsLoading(false)
      return
    }

    let cancelled = false
    setSlashCommandsLoading(true)

    void listCommands()
      .then((commands) => {
        if (cancelled) return
        setSlashCommands(commands)
      })
      .finally(() => {
        if (cancelled) return
        setSlashCommandsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [slashMenuOpen, slashQuery])

  React.useEffect(() => {
    setSelectedSlashIndex(0)
  }, [slashQuery])

  React.useEffect(() => {
    setSelectedFileSearchIndex(0)
  }, [fileQuery])

  React.useEffect(() => {
    if (!fileMenuOpen || !workingFolder) {
      setFileSearchResults([])
      setFileSearchLoading(false)
      return
    }

    let cancelled = false
    setFileSearchLoading(true)

    const timer = window.setTimeout(() => {
      void ipcClient
        .invoke('fs:search-files', {
          path: workingFolder,
          query: fileQuery,
          limit: 20
        })
        .then((result) => {
          if (cancelled) return
          if (Array.isArray(result)) {
            setFileSearchResults(result as FileSearchItem[])
            return
          }
          setFileSearchResults([])
        })
        .finally(() => {
          if (cancelled) return
          setFileSearchLoading(false)
        })
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [fileMenuOpen, fileQuery, workingFolder])

  const insertSelectedFile = React.useCallback(
    (filePath: string) => {
      clearHistoryNavigation()
      setSelectedSkill(null)

      const { files: nextFiles, file } = ensureSelectedFile(selectedFiles, filePath, workingFolder)
      if (!file) return

      const mention = activeFileMention ?? {
        start: editorSelection.start,
        end: editorSelection.end
      }
      const suffix =
        plainText.slice(mention.end).startsWith(' ') ||
        plainText.slice(mention.end).startsWith('\n') ||
        mention.end >= plainText.length
          ? ''
          : ' '

      setSelectedFiles(nextFiles)
      replaceSelectionWithNodes(
        [
          createFileReferenceNode(file.id, file.sendPath),
          ...(suffix ? [createTextReplacementNode(suffix)] : [])
        ],
        mention
      )
    },
    [
      activeFileMention,
      clearHistoryNavigation,
      editorSelection.end,
      editorSelection.start,
      plainText,
      replaceSelectionWithNodes,
      selectedFiles,
      workingFolder
    ]
  )

  const insertSlashCommand = React.useCallback(
    (commandName: string) => {
      clearHistoryNavigation()
      setSelectedSkill(null)
      applyEditorStateFromSerializedText(`/${commandName} `, selectedFiles)
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [applyEditorStateFromSerializedText, clearHistoryNavigation, focusInputAtEnd, selectedFiles]
  )

  const applyHistoryEntry = React.useCallback(
    (entry: InputHistoryEntry) => {
      applyEditorStateFromSerializedText(entry.text, entry.selectedFiles)
      setAttachedImages(cloneImageAttachments(entry.images))
      setSelectedSkill(null)
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [applyEditorStateFromSerializedText, focusInputAtEnd]
  )
  const restoreDraftFromHistory = React.useCallback(() => {
    const draft = historyDraftRef.current
    applyEditorStateFromSerializedText(draft?.text ?? '', draft?.selectedFiles ?? [])
    setAttachedImages(cloneImageAttachments(draft?.images ?? []))
    setSelectedSkill(draft?.selectedSkill ?? null)
    historyDraftRef.current = null
    requestAnimationFrame(() => {
      focusInputAtEnd()
    })
  }, [applyEditorStateFromSerializedText, focusInputAtEnd])
  const navigateHistory = React.useCallback(
    (direction: 'up' | 'down') => {
      if (sentHistory.length === 0) return
      if (direction === 'up') {
        if (historyCursor === null) {
          historyDraftRef.current = {
            text,
            images: cloneImageAttachments(attachedImages),
            selectedSkill,
            selectedFiles: selectedFiles.map((file) => ({ ...file }))
          }
          const latest = sentHistory.length - 1
          setHistoryCursor(latest)
          applyHistoryEntry(sentHistory[latest])
          return
        }
        const next = Math.max(historyCursor - 1, 0)
        if (next !== historyCursor) {
          setHistoryCursor(next)
          applyHistoryEntry(sentHistory[next])
        }
        return
      }
      if (historyCursor === null) return
      const next = historyCursor + 1
      if (next >= sentHistory.length) {
        setHistoryCursor(null)
        restoreDraftFromHistory()
        return
      }
      setHistoryCursor(next)
      applyHistoryEntry(sentHistory[next])
    },
    [
      historyCursor,
      sentHistory,
      text,
      attachedImages,
      selectedSkill,
      selectedFiles,
      applyHistoryEntry,
      restoreDraftFromHistory
    ]
  )
  const hasApiKey = !!activeProvider?.apiKey || activeProvider?.requiresApiKey === false
  const needsWorkingFolder = mode !== 'chat' && !workingFolder
  const planMode = useUIStore((s) => s.planMode)
  const togglePlanMode = React.useCallback(() => {
    const store = useUIStore.getState()
    if (store.planMode) {
      store.exitPlanMode()
    } else {
      store.enterPlanMode()
    }
  }, [])

  React.useEffect(() => {
    if (!isStreaming && !disabled) {
      editorRef.current?.focus()
    }
  }, [isStreaming, disabled])

  React.useEffect(() => {
    if (!shouldAutoAcceptRecommendation || !suggestionText || !text.trim()) {
      setAutoAcceptCountdown(null)
      return
    }

    setAutoAcceptCountdown(8)

    const intervalId = window.setInterval(() => {
      setAutoAcceptCountdown((prev) => {
        if (prev === null) return null
        return prev > 1 ? prev - 1 : 0
      })
    }, 1000)

    const timeoutId = window.setTimeout(() => {
      const acceptedSuggestion = acceptSuggestion()
      if (!acceptedSuggestion) return
      clearHistoryNavigation()
      applyEditorStateFromSerializedText(acceptedSuggestion, selectedFiles)
      setAutoAcceptCountdown(null)
      requestAnimationFrame(() => {
        focusInputAtEnd()
        handleRecommendationSelectionChange()
      })
    }, 8000)

    return () => {
      window.clearInterval(intervalId)
      window.clearTimeout(timeoutId)
    }
  }, [
    acceptSuggestion,
    applyEditorStateFromSerializedText,
    clearHistoryNavigation,
    focusInputAtEnd,
    handleRecommendationSelectionChange,
    selectedFiles,
    shouldAutoAcceptRecommendation,
    suggestionText,
    text
  ])

  React.useEffect(() => {
    setEditingQueueItemId(null)
    setEditingQueueText('')
    setEditingQueueImages([])
    setQueueClearConfirmOpen(false)
    if (!activeSessionId) {
      setIsQueueExpanded(false)
      return
    }
    setIsQueueExpanded(
      queueExpandedBySessionRef.current[activeSessionId] ?? queuedMessages.length > 0
    )
    previousQueueSizeBySessionRef.current[activeSessionId] = queuedMessages.length
  }, [activeSessionId, queuedMessages.length])

  React.useEffect(() => {
    if (!editingQueueItemId) return
    if (queuedMessages.some((msg) => msg.id === editingQueueItemId)) return
    setEditingQueueItemId(null)
    setEditingQueueText('')
    setEditingQueueImages([])
  }, [queuedMessages, editingQueueItemId])

  React.useEffect(() => {
    if (!isStreaming) {
      cancelEditQueuedMessage()
    }
  }, [isStreaming, cancelEditQueuedMessage])

  React.useEffect(() => {
    if (!activeSessionId) return
    const previousSize = previousQueueSizeBySessionRef.current[activeSessionId] ?? 0
    if (queuedMessages.length > previousSize) {
      queueExpandedBySessionRef.current[activeSessionId] = true
      setIsQueueExpanded(true)
    } else if (queuedMessages.length === 0) {
      queueExpandedBySessionRef.current[activeSessionId] = false
      setIsQueueExpanded(false)
      setQueueClearConfirmOpen(false)
    }
    previousQueueSizeBySessionRef.current[activeSessionId] = queuedMessages.length
  }, [activeSessionId, queuedMessages.length])

  React.useEffect(() => {
    const prevSessionId = prevSessionIdRef.current

    // Save current draft to the previous session before switching
    if (prevSessionId) {
      draftBySessionRef.current[prevSessionId] = {
        text,
        images: cloneImageAttachments(attachedImages),
        skill: selectedSkill,
        selectedFiles: selectedFiles.map((file) => ({ ...file }))
      }
    }

    // Restore draft from the new session (or clear)
    const draft = activeSessionId ? draftBySessionRef.current[activeSessionId] : undefined
    applyEditorStateFromSerializedText(draft?.text ?? '', draft?.selectedFiles ?? [])
    setAttachedImages(draft?.images ? cloneImageAttachments(draft.images) : [])
    setSelectedSkill(draft?.skill ?? null)

    if (!prevSessionId && activeSessionId) {
      const pendingHistory = historyBySessionRef.current[PENDING_HISTORY_KEY]
      if (
        pendingHistory &&
        pendingHistory.length > 0 &&
        !historyBySessionRef.current[activeSessionId]
      ) {
        historyBySessionRef.current[activeSessionId] = pendingHistory
        delete historyBySessionRef.current[PENDING_HISTORY_KEY]
      }
    }
    const historyKey = activeSessionId ?? PENDING_HISTORY_KEY
    setSentHistory(historyBySessionRef.current[historyKey] ?? [])
    setHistoryCursor(null)
    historyDraftRef.current = null
    prevSessionIdRef.current = activeSessionId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // Consume pendingInsertText from FileTree clicks
  const pendingInsert = useUIStore((s) => s.pendingInsertText)
  React.useEffect(() => {
    if (!pendingInsert) return

    clearHistoryNavigation()
    const parsed = deserializeEditorState(pendingInsert, workingFolder)
    const pendingPlainText = editorDocumentToPlainText(parsed.document, parsed.selectedFiles)
    const selection = editorRef.current?.getSelectionOffsets() ?? {
      start: plainText.length,
      end: plainText.length
    }
    const needsPrefix =
      selection.start === selection.end &&
      selection.start > 0 &&
      !/\s$/.test(plainText.slice(0, selection.start)) &&
      pendingPlainText.length > 0 &&
      !/^\s/.test(pendingPlainText)

    const mergedFiles = mergeSelectedFiles(selectedFilesRef.current, parsed.selectedFiles)
    const fileIdBySendPath = new Map(
      mergedFiles.map((file) => [file.sendPath.toLowerCase(), file.id])
    )
    const nextDocument = parsed.document.map((node) => {
      if (node.type !== 'file') return node
      const sourceFile = parsed.selectedFiles.find((file) => file.id === node.fileId)
      if (!sourceFile) return node
      return {
        ...node,
        fileId: fileIdBySendPath.get(sourceFile.sendPath.toLowerCase()) ?? node.fileId
      }
    })

    setSelectedFiles(mergedFiles)
    replaceSelectionWithNodes(
      [...(needsPrefix ? [createTextReplacementNode(' ')] : []), ...nextDocument],
      selection
    )
    useUIStore.getState().setPendingInsertText(null)
  }, [clearHistoryNavigation, pendingInsert, plainText, replaceSelectionWithNodes, workingFolder])

  // --- Image helpers ---
  const addImages = React.useCallback(
    async (files: File[]) => {
      const results = await Promise.all(files.map(fileToImageAttachment))
      const valid = results.filter(Boolean) as ImageAttachment[]
      if (valid.length > 0) {
        clearHistoryNavigation()
        setAttachedImages((prev) => [...prev, ...valid])
      }
    },
    [clearHistoryNavigation]
  )

  const removeImage = React.useCallback(
    (id: string) => {
      clearHistoryNavigation()
      setAttachedImages((prev) => prev.filter((img) => img.id !== id))
    },
    [clearHistoryNavigation]
  )

  const addFilesToEditor = React.useCallback(
    (filePaths: string[], selection?: { start: number; end: number }) => {
      const nextSelection = selection ?? editorRef.current?.getSelectionOffsets() ?? editorSelection
      const filesToInsert: SelectedFileItem[] = []
      let mergedFiles = selectedFiles

      for (const filePath of filePaths) {
        const ensured = ensureSelectedFile(mergedFiles, filePath, workingFolder)
        mergedFiles = ensured.files
        if (ensured.file) {
          filesToInsert.push(ensured.file)
        }
      }

      if (filesToInsert.length === 0) return

      const replacement: EditorDocumentNode[] = []
      filesToInsert.forEach((file, index) => {
        if (index > 0) replacement.push(createTextReplacementNode('\n'))
        replacement.push(createFileReferenceNode(file.id, file.sendPath))
      })

      setSelectedFiles(mergedFiles)
      replaceSelectionWithNodes(replacement, nextSelection)
    },
    [editorSelection, replaceSelectionWithNodes, selectedFiles, workingFolder]
  )

  const handlePreviewFile = React.useCallback(
    (file: SelectedFileItem) => {
      openFilePreview(file.previewPath)
    },
    [openFilePreview]
  )

  const scrollFileBarItemIntoView = React.useCallback((fileId: string) => {
    const target = document.getElementById(`selected-file-bar-item-${fileId}`)
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [])

  const handleLocateFile = React.useCallback(
    (fileId: string) => {
      setHighlightedFileId(fileId)
      const found = editorRef.current?.scrollToReference(fileId) ?? false
      if (!found) {
        scrollFileBarItemIntoView(fileId)
      }
    },
    [scrollFileBarItemIntoView]
  )

  const handleLocateReferenceToBar = React.useCallback(
    (fileId: string) => {
      setHighlightedFileId(fileId)
      scrollFileBarItemIntoView(fileId)
    },
    [scrollFileBarItemIntoView]
  )

  const handleRemoveSelectedFile = React.useCallback(
    (fileId: string) => {
      clearHistoryNavigation()
      const nextState = removeSelectedFile(selectedFiles, editorDocument, fileId)
      setSelectedFiles(nextState.files)
      setEditorDocument(nextState.document)
      if (highlightedFileId === fileId) {
        setHighlightedFileId(null)
      }
    },
    [clearHistoryNavigation, editorDocument, highlightedFileId, selectedFiles]
  )

  const handleClearSelectedFiles = React.useCallback(() => {
    clearHistoryNavigation()
    let nextFiles = selectedFiles
    let nextDocument = editorDocument
    for (const file of selectedFiles) {
      const nextState = removeSelectedFile(nextFiles, nextDocument, file.id)
      nextFiles = nextState.files
      nextDocument = nextState.document
    }
    setSelectedFiles(nextFiles)
    setEditorDocument(nextDocument)
    setHighlightedFileId(null)
  }, [clearHistoryNavigation, editorDocument, selectedFiles])

  const handleRemoveReference = React.useCallback(
    (nodeId: string) => {
      clearHistoryNavigation()
      setEditorDocument((current) => removeReferenceNode(current, nodeId, selectedFilesRef.current))
    },
    [clearHistoryNavigation]
  )

  const handleSelectFilesFromSystem = React.useCallback(async () => {
    const result = (await ipcClient.invoke('fs:select-file', {
      multiSelections: true
    })) as { canceled?: boolean; paths?: string[]; path?: string }

    if (result?.canceled) return
    const paths = Array.isArray(result?.paths) ? result.paths : result?.path ? [result.path] : []
    if (paths.length === 0) return

    clearHistoryNavigation()
    addFilesToEditor(paths)
  }, [addFilesToEditor, clearHistoryNavigation])

  const findAdjacentReferenceNode = React.useCallback(
    (cursor: number, direction: 'before' | 'after') => {
      let offset = 0
      for (const node of editorDocument) {
        const length = editorDocumentToPlainText([node], selectedFiles).length
        const start = offset
        const end = offset + length
        offset = end

        if (node.type !== 'file') continue
        if (direction === 'before' && end === cursor) return node
        if (direction === 'after' && start === cursor) return node
      }
      return null
    },
    [editorDocument, selectedFiles]
  )

  const handleSend = (): void => {
    const serialized = finalSerializedText.trim()
    if (!serialized && attachedImages.length === 0) return
    if (disabled || needsWorkingFolder) return

    const hasLeadingSlashCommand = plainText.trimStart().startsWith('/')
    const message =
      selectedSkill && !hasLeadingSlashCommand
        ? `[Skill: ${selectedSkill}]\n${serialized}`
        : serialized

    onSend(message, attachedImages.length > 0 ? attachedImages : undefined)
    updateSessionHistory((prevHistory) => {
      const nextHistory = [
        ...prevHistory,
        {
          text: message,
          images: cloneImageAttachments(attachedImages),
          selectedFiles: selectedFiles.map((file) => ({ ...file }))
        }
      ]
      return nextHistory.length > INPUT_HISTORY_LIMIT
        ? nextHistory.slice(nextHistory.length - INPUT_HISTORY_LIMIT)
        : nextHistory
    })

    setHistoryCursor(null)
    historyDraftRef.current = null
    setEditorDocument([])
    setSelectedFiles([])
    setHighlightedFileId(null)
    setAttachedImages([])
    setSelectedSkill(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing || isOptimizing) return

    const selectionStart = editorSelection.start
    const selectionEnd = editorSelection.end
    const collapsed = selectionStart === selectionEnd

    if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Backspace' || e.key === 'Delete')) {
      if (!collapsed) {
        const expanded = getNormalizedSelection(selectionStart, selectionEnd)
        if (expanded.start !== expanded.end) {
          e.preventDefault()
          replaceSelectionWithNodes([], expanded)
          return
        }
      }

      if (collapsed) {
        const adjacentNode = findAdjacentReferenceNode(
          selectionStart,
          e.key === 'Backspace' ? 'before' : 'after'
        )
        if (adjacentNode) {
          e.preventDefault()
          setEditorDocument((current) =>
            removeReferenceNode(current, adjacentNode.id, selectedFiles)
          )
          requestAnimationFrame(() => {
            editorRef.current?.setSelectionOffsets(selectionStart, selectionStart)
          })
          return
        }
      }
    }

    if (fileMenuOpen) {
      if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedFileSearchIndex((prev) =>
          fileSearchResults.length === 0 ? 0 : (prev + 1) % fileSearchResults.length
        )
        return
      }
      if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedFileSearchIndex((prev) =>
          fileSearchResults.length === 0
            ? 0
            : (prev - 1 + fileSearchResults.length) % fileSearchResults.length
        )
        return
      }
      if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Tab' || e.key === 'Enter')) {
        const selectedFile = fileSearchResults[selectedFileSearchIndex]
        if (selectedFile) {
          e.preventDefault()
          insertSelectedFile(selectedFile.path)
          return
        }
      }
      if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'Escape') {
        e.preventDefault()
        const nextCursor = activeFileMention?.start ?? 0
        editorRef.current?.setSelectionOffsets(nextCursor, nextCursor)
        return
      }
    }

    if (slashMenuOpen) {
      if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedSlashIndex((prev) =>
          filteredSlashCommands.length === 0 ? 0 : (prev + 1) % filteredSlashCommands.length
        )
        return
      }
      if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedSlashIndex((prev) =>
          filteredSlashCommands.length === 0
            ? 0
            : (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length
        )
        return
      }
      if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Tab' || e.key === 'Enter')) {
        const selectedCommand = filteredSlashCommands[selectedSlashIndex]
        if (selectedCommand) {
          e.preventDefault()
          insertSlashCommand(selectedCommand.name)
          return
        }
      }
    }

    if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'Tab') {
      const acceptedSuggestion = acceptSuggestion()
      if (acceptedSuggestion) {
        e.preventDefault()
        clearHistoryNavigation()
        applyEditorStateFromSerializedText(acceptedSuggestion, selectedFiles)
        requestAnimationFrame(() => {
          focusInputAtEnd()
          handleRecommendationSelectionChange()
        })
        return
      }
    }

    if (
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
    ) {
      if (collapsed && e.key === 'ArrowUp' && selectionStart === 0) {
        e.preventDefault()
        navigateHistory('up')
        return
      }
      if (collapsed && e.key === 'ArrowDown' && selectionStart === plainText.length) {
        e.preventDefault()
        navigateHistory('down')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>): void => {
      if (!supportsVision) return
      const items = Array.from(e.clipboardData.items)
      const imageFiles = items
        .filter((item) => item.kind === 'file' && ACCEPTED_IMAGE_TYPES.includes(item.type))
        .map((item) => item.getAsFile())
        .filter(Boolean) as File[]
      if (imageFiles.length > 0) {
        e.preventDefault()
        void addImages(imageFiles)
      }
    },
    [addImages, supportsVision]
  )

  const handleDropFiles = React.useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      const fileArr = Array.from(fileList)
      const imageFiles = supportsVision
        ? fileArr.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type))
        : []
      const otherFiles = supportsVision
        ? fileArr.filter((f) => !ACCEPTED_IMAGE_TYPES.includes(f.type))
        : fileArr

      if (imageFiles.length > 0) {
        void addImages(imageFiles)
      }

      const paths = otherFiles
        .map((f) => (f as File & { path?: string }).path)
        .filter((filePath): filePath is string => Boolean(filePath))

      if (paths.length > 0) {
        addFilesToEditor(paths)
      }
    },
    [addFilesToEditor, addImages, supportsVision]
  )

  const [dragging, setDragging] = useLocalState(false)

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = (): void => {
    setDragging(false)
  }

  const handleDropWrapped = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(false)
    handleDropFiles(e.dataTransfer?.files ?? null)
  }

  // Optimize prompt handler
  const handleOptimizePrompt = React.useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || isOptimizing) return

    console.log('[Optimizer] Starting optimization...')
    setIsOptimizing(true)
    setOptimizingText('')
    setOptimizationOptions([])

    try {
      const { optimizePrompt } = await import('@renderer/lib/prompt-optimizer/optimizer')

      console.log('[Optimizer] Current language:', currentLanguage)

      // Find a fast model (haiku) from available providers
      const providerStore = useProviderStore.getState()
      const { providers } = providerStore

      let fastProvider = providers.find(
        (p) =>
          p.enabled &&
          p.models.some(
            (m) =>
              m.enabled &&
              (m.id.includes('haiku') || m.id.includes('4o-mini') || m.id.includes('gpt-4o-mini'))
          )
      )

      if (!fastProvider) {
        fastProvider = providers.find((p) => p.enabled && p.models.some((m) => m.enabled))
      }

      if (!fastProvider) {
        console.error('[Optimizer] No enabled provider found')
        toast.error('No AI provider available', {
          description: 'Please configure an AI provider in Settings'
        })
        setIsOptimizing(false)
        return
      }

      const fastModel =
        fastProvider.models.find(
          (m) =>
            m.enabled &&
            (m.id.includes('haiku') || m.id.includes('4o-mini') || m.id.includes('gpt-4o-mini'))
        ) || fastProvider.models.find((m) => m.enabled)

      if (!fastModel) {
        console.error('[Optimizer] No enabled model found')
        toast.error('No AI model available', { description: 'Please enable a model in Settings' })
        setIsOptimizing(false)
        return
      }

      console.log('[Optimizer] Using provider:', fastProvider.type, 'model:', fastModel.id)

      const providerConfig = {
        type: fastProvider.type,
        apiKey: fastProvider.apiKey,
        baseUrl: fastProvider.baseUrl,
        model: fastModel.id,
        providerId: fastProvider.id,
        maxTokens: 4096,
        temperature: 0.7,
        systemPrompt: ''
      }

      console.log('[Optimizer] Starting optimization stream...')
      for await (const event of optimizePrompt(trimmed, providerConfig, currentLanguage)) {
        console.log('[Optimizer] Event:', event.type)
        if (event.type === 'text') {
          setOptimizingText((prev) => prev + event.content)
        } else if (event.type === 'result' && event.options && event.options.length > 0) {
          console.log('[Optimizer] Got results:', event.options.length, 'options')
          setOptimizationOptions(event.options)
          setSelectedOptionIndex(0)
          setShowOptimizationDialog(true)
        }
      }
      console.log('[Optimizer] Stream completed')
    } catch (error) {
      console.error('[Optimizer] Error:', error)
      toast.error('Optimization failed', {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      console.log('[Optimizer] Cleanup')
      setIsOptimizing(false)
    }
  }, [text, isOptimizing, currentLanguage])

  const handleSelectOption = React.useCallback(
    (content: string) => {
      setText(content)
      setOptimizationOptions([])
      setOptimizingText('')
      setSelectedOptionIndex(0)
      setShowOptimizationDialog(false)
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [focusInputAtEnd, setText]
  )

  const handleCancelOptimization = React.useCallback(() => {
    setOptimizationOptions([])
    setOptimizingText('')
    setSelectedOptionIndex(0)
    setShowOptimizationDialog(false)
  }, [])

  return (
    <div ref={rootRef} className="px-4 py-3 pb-4">
      {/* API key warning */}
      {!hasApiKey && (
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-600 dark:text-amber-400 transition-colors hover:bg-amber-500/10"
          onClick={() => setSettingsOpen(true)}
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>{t('input.noApiKey')}</span>
        </button>
      )}

      {/* Working folder required warning */}
      {needsWorkingFolder && onSelectFolder && (
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-600 dark:text-amber-400 transition-colors hover:bg-amber-500/10"
          onClick={onSelectFolder}
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span>{t('input.noWorkingFolder', { mode })}</span>
        </button>
      )}

      {/* Plan mode banner */}
      {planMode && mode !== 'chat' && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-xs text-violet-600 dark:text-violet-400">
            <ClipboardList className="size-3.5 shrink-0" />
            <span>
              {t('input.planModeActive', {
                defaultValue: 'Plan Mode — exploring codebase, no file changes'
              })}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-violet-600 dark:text-violet-400 hover:bg-violet-500/10"
            onClick={() => useUIStore.getState().exitPlanMode()}
          >
            {t('input.exitPlanMode', { defaultValue: 'Exit Plan Mode' })}
          </Button>
        </div>
      )}

      {/* Working folder indicator */}
      {workingFolder && !hideWorkingFolderIndicator && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderOpen className="size-3" />
          <span className="truncate">{workingFolder}</span>
        </div>
      )}

      <div className="mx-auto max-w-3xl">
        <div
          ref={containerRef}
          className={`relative rounded-lg border bg-background shadow-lg transition-shadow focus-within:shadow-xl focus-within:ring-1 focus-within:ring-ring/20 flex flex-col ${dragging ? 'ring-2 ring-primary/50' : ''}`}
          style={inputHeight ? { height: inputHeight } : undefined}
        >
          {/* Top drag handle */}
          <div className="h-1.5 cursor-row-resize rounded-t-lg" onMouseDown={handleDragStart} />
          {/* Queued message list */}
          {queuedMessages.length > 0 && (
            <div className="px-3 pt-3 pb-1">
              <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/20 shadow-sm">
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={toggleQueueExpanded}
                  >
                    {isQueueExpanded ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <ClipboardList className="size-3.5 shrink-0 text-primary/80" />
                    <span className="truncate text-xs font-medium text-foreground">
                      {t('input.queueTitle', { defaultValue: '排队消息' })}
                    </span>
                    <span className="rounded-full border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {queuedMessages.length}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground/80">
                      {isQueueDispatchPaused
                        ? t('input.queuePausedHint', {
                            defaultValue: '已暂停，点击继续发送'
                          })
                        : t('input.queueRunningHint', {
                            defaultValue: '当前任务结束后按顺序发送'
                          })}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {isQueueDispatchPaused && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 rounded-lg px-2 text-[10px]"
                        onClick={resumeQueuedMessages}
                      >
                        <Send className="size-3" />
                        {t('input.queueResume', { defaultValue: '继续发送' })}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 rounded-lg px-2 text-[10px] text-muted-foreground hover:text-destructive"
                      onClick={handleClearQueuedMessages}
                    >
                      <Trash2 className="size-3" />
                      {t('action.clear', { ns: 'common' })}
                    </Button>
                  </div>
                </div>

                {isQueueExpanded && (
                  <div className="border-t border-border/50 px-3 py-2">
                    <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                      {queuedMessages.map((msg) => {
                        const isEditing = editingQueueItemId === msg.id
                        const summaryText = summarizeQueuedMessage(msg.text)
                        const commandLabel = msg.command ? `/${msg.command.name}` : ''
                        return (
                          <div
                            key={msg.id}
                            className="rounded-lg border border-border/60 bg-background/80 px-3 py-2 shadow-sm"
                          >
                            {isEditing ? (
                              <div className="space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[10px] font-medium text-muted-foreground">
                                    {t('input.queueEditing', { defaultValue: '编辑排队消息' })}
                                  </span>
                                  <div className="flex items-center gap-1">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-2 text-[10px]"
                                      onClick={() => saveQueuedMessage(msg.id)}
                                    >
                                      {t('action.save', { ns: 'common' })}
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-2 text-[10px]"
                                      onClick={cancelEditQueuedMessage}
                                    >
                                      {t('action.cancel', { ns: 'common' })}
                                    </Button>
                                  </div>
                                </div>
                                {msg.command && (
                                  <div className="rounded-md border border-violet-500/20 bg-violet-500/5 px-2.5 py-1.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                                    /{msg.command.name}
                                  </div>
                                )}
                                <Textarea
                                  value={editingQueueText}
                                  onChange={(e) => setEditingQueueText(e.target.value)}
                                  className="min-h-[56px] max-h-36 resize-none border-border/70 bg-background text-xs"
                                  rows={2}
                                />
                                {editingQueueImages.length > 0 && (
                                  <div className="flex gap-2 overflow-x-auto pb-1">
                                    {editingQueueImages.map((img) => (
                                      <div key={img.id} className="relative group/img shrink-0">
                                        <img
                                          src={img.dataUrl}
                                          alt=""
                                          className="size-12 rounded-md border border-border/60 object-cover shadow-sm"
                                        />
                                        <button
                                          type="button"
                                          className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm opacity-0 transition-opacity group-hover/img:opacity-100"
                                          onClick={() => removeQueuedImage(img.id)}
                                        >
                                          <X className="size-2.5" />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div className="flex items-center justify-between gap-2">
                                  {editingQueueImages.length > 0 ? (
                                    <p className="text-[10px] text-muted-foreground">
                                      {t('input.queueImageCount', {
                                        defaultValue: '{{count}} 张图片',
                                        count: editingQueueImages.length
                                      })}
                                    </p>
                                  ) : (
                                    <span />
                                  )}
                                  {supportsVision && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-6 gap-1 px-2 text-[10px]"
                                      onClick={() => queueFileInputRef.current?.click()}
                                    >
                                      <ImagePlus className="size-3" />
                                      {t('input.attachImages')}
                                    </Button>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs leading-5 text-foreground/90">
                                    {summaryText ||
                                      commandLabel ||
                                      t('input.queueImageOnly', { defaultValue: '[仅图片]' })}
                                  </div>
                                  {commandLabel && summaryText && (
                                    <div className="mt-1 text-[10px] text-violet-700 dark:text-violet-300">
                                      {commandLabel}
                                    </div>
                                  )}
                                  {msg.images.length > 0 && (
                                    <div className="mt-1 flex items-center gap-1.5">
                                      <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                        {t('input.queueImageCount', {
                                          defaultValue: '{{count}} 张图片',
                                          count: msg.images.length
                                        })}
                                      </span>
                                    </div>
                                  )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 rounded-md p-0 text-muted-foreground hover:text-foreground"
                                    onClick={() => startEditQueuedMessage(msg)}
                                    title={t('action.edit', { ns: 'common', defaultValue: '编辑' })}
                                  >
                                    <Pencil className="size-3.5" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 rounded-md p-0 text-muted-foreground hover:text-destructive"
                                    onClick={() => removeQueuedMessage(msg.id)}
                                    title={t('action.delete', { ns: 'common' })}
                                  >
                                    <Trash2 className="size-3.5" />
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              <AlertDialog open={queueClearConfirmOpen} onOpenChange={setQueueClearConfirmOpen}>
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('input.queueClearConfirmTitle', { defaultValue: '清空排队消息？' })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('input.queueClearConfirmDesc', {
                        defaultValue: '这将删除当前会话中 {{count}} 条待发送消息。',
                        count: queuedMessages.length
                      })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel size="sm">
                      {t('action.cancel', { ns: 'common' })}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      size="sm"
                      onClick={clearQueuedMessagesForActiveSession}
                    >
                      {t('action.clear', { ns: 'common' })}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}

          {/* Skill tag */}
          {selectedSkill && (
            <div className="px-3 pt-3 pb-0">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-violet-500/10 border border-violet-500/20 px-2.5 py-1 text-xs font-medium text-violet-600 dark:text-violet-400">
                <Sparkles className="size-3" />
                {selectedSkill}
                <button
                  type="button"
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-violet-500/20 transition-colors"
                  onClick={() => setSelectedSkill(null)}
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          )}

          {/* Image preview strip */}
          {attachedImages.length > 0 && (
            <div className="flex gap-2 px-3 pt-3 pb-1 overflow-x-auto">
              {attachedImages.map((img) => (
                <div key={img.id} className="relative group/img shrink-0">
                  <img
                    src={img.dataUrl}
                    alt=""
                    className="size-16 rounded-lg object-cover border border-border/60 shadow-sm"
                  />
                  <button
                    type="button"
                    className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-destructive text-destructive-foreground shadow-md opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center"
                    onClick={() => removeImage(img.id)}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Optimizing indicator - only show spinner, hide text */}
          {isOptimizing && (
            <div className="px-3 pt-3 pb-1">
              <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Spinner className="size-3.5 text-blue-600 dark:text-blue-400" />
                  <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                    {t('input.optimizing', { defaultValue: 'Optimizing your prompt...' })}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Optimization Dialog */}
          <Dialog open={showOptimizationDialog} onOpenChange={setShowOptimizationDialog}>
            <DialogContent className="max-w-7xl max-h-[90vh] overflow-hidden flex flex-col gap-4">
              <DialogHeader className="space-y-2">
                <DialogTitle className="text-xl flex items-center gap-2">
                  <Wand2 className="size-5 text-primary" />
                  {t('input.optimizationResults', { defaultValue: 'Optimized Prompt Options' })}
                </DialogTitle>
                <DialogDescription className="text-sm">
                  {t('input.optimizationResultsDesc', {
                    defaultValue:
                      'Select one of the optimized versions below to use in your prompt.'
                  })}
                </DialogDescription>
              </DialogHeader>

              {/* Tab-style Layout */}
              <div className="flex-1 flex flex-col overflow-hidden gap-4">
                {/* Tabs - Options as tabs at top */}
                <div className="flex gap-2 border-b border-border pb-2">
                  {optimizationOptions.map((option, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={`flex-1 px-4 py-3 rounded-t-lg border-2 border-b-0 transition-all ${
                        selectedOptionIndex === idx
                          ? 'border-primary bg-primary/5 -mb-[2px] border-b-2 border-b-background'
                          : 'border-transparent hover:bg-muted/30'
                      }`}
                      onClick={() => {
                        setSelectedOptionIndex(idx)
                        // Scroll content to top when switching tabs
                        if (contentScrollRef.current) {
                          contentScrollRef.current.scrollTop = 0
                        }
                      }}
                    >
                      <div className="flex items-center justify-center gap-2">
                        <span
                          className={`inline-flex items-center justify-center size-6 rounded-full text-xs font-bold ${
                            selectedOptionIndex === idx
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <div className="text-left">
                          <p className="text-sm font-semibold text-foreground">{option.title}</p>
                          <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {option.focus}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Content Area - Show selected option's detailed content */}
                <div className="flex-1 overflow-hidden rounded-lg border border-border bg-background">
                  <div ref={contentScrollRef} className="h-full overflow-y-auto px-6 py-4">
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <div className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed font-sans">
                        {optimizationOptions[selectedOptionIndex]?.content}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <DialogFooter className="flex items-center justify-between">
                <Button variant="outline" onClick={handleCancelOptimization}>
                  {t('action.cancel', { ns: 'common' })}
                </Button>
                <Button
                  onClick={() =>
                    handleSelectOption(optimizationOptions[selectedOptionIndex]?.content)
                  }
                >
                  {t('input.useThisOption', { defaultValue: 'Use This' })}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Text input area */}
          <div
            className={`relative px-3 flex-1 min-h-0 flex flex-col ${selectedSkill || attachedImages.length > 0 ? 'pt-1.5' : 'pt-3'}`}
            onDrop={handleDropWrapped}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            {dragging && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/5 pointer-events-none">
                <span className="flex items-center gap-1.5 text-xs text-primary/70 font-medium">
                  <FileUp className="size-3.5" />
                  {supportsVision ? t('input.dropImages') : t('input.dropFiles')}
                </span>
              </div>
            )}
            <SelectedFileBar
              files={selectedFiles}
              highlightedFileId={highlightedFileId}
              onPreview={handlePreviewFile}
              onLocate={handleLocateFile}
              onRemove={handleRemoveSelectedFile}
              onClear={handleClearSelectedFiles}
            />
            <div className="relative flex-1 min-h-[60px]">
              {shouldAutoAcceptRecommendation &&
                autoAcceptCountdown !== null &&
                suggestionText &&
                !hasFileReferences && (
                  <div className="pointer-events-none absolute right-2 top-2 z-20 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    {autoAcceptCountdown}s
                  </div>
                )}
              <FileAwareEditor
                ref={editorRef}
                document={editorDocument}
                files={selectedFiles}
                disabled={disabled || isOptimizing}
                placeholder={
                  effectivePlaceholder ?? t(placeholderKeys[mode] ?? 'input.placeholder')
                }
                suggestionText={suggestionText}
                showSuggestion={!hasFileReferences}
                highlightedFileId={highlightedFileId}
                onDocumentChange={(nextDocument) => {
                  clearHistoryNavigation()
                  setEditorDocument(nextDocument)
                  setHighlightedFileId(null)
                }}
                onSelectionChange={(selection) => {
                  setInputSelection(selection)
                  handleRecommendationSelectionChange()
                }}
                onFocus={handleRecommendationFocus}
                onBlur={handleRecommendationBlur}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onCompositionStart={handleRecommendationCompositionStart}
                onCompositionEnd={handleRecommendationCompositionEnd}
                onReferencePreview={(fileId) => {
                  const file = selectedFiles.find((item) => item.id === fileId)
                  if (file) handlePreviewFile(file)
                }}
                onReferenceLocate={handleLocateReferenceToBar}
                onReferenceDelete={handleRemoveReference}
              />
              {fileMenuOpen && (
                <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-xl">
                  <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
                    <Command className="size-3.5" />
                    <span>{t('input.fileSuggestions', { defaultValue: '文件建议' })}</span>
                    <span className="ml-auto rounded-full border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px]">
                      @{fileQuery}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1.5">
                    {fileSearchLoading ? (
                      <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                        <Spinner className="size-3.5" />
                        <span>{t('input.loadingFiles', { defaultValue: '搜索文件中...' })}</span>
                      </div>
                    ) : fileSearchResults.length === 0 ? (
                      <div className="px-2 py-3 text-xs text-muted-foreground">
                        {t('input.noFilesFound', { defaultValue: '没有匹配的文件' })}
                      </div>
                    ) : (
                      fileSearchResults.map((file, index) => {
                        const isSelected = index === selectedFileSearchIndex
                        return (
                          <button
                            key={file.path}
                            type="button"
                            className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                              isSelected
                                ? 'bg-accent text-accent-foreground'
                                : 'hover:bg-muted/50 text-foreground'
                            }`}
                            onMouseDown={(event) => {
                              event.preventDefault()
                              insertSelectedFile(file.path)
                            }}
                          >
                            <FolderOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{file.name}</div>
                              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                {file.path}
                              </div>
                            </div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
              {slashMenuOpen && (
                <div className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-border/70 bg-popover shadow-xl">
                  <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
                    <Command className="size-3.5" />
                    <span>{t('input.commandSuggestions', { defaultValue: '命令建议' })}</span>
                    <span className="ml-auto rounded-full border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px]">
                      /{slashQuery ?? ''}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1.5">
                    {slashCommandsLoading ? (
                      <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                        <Spinner className="size-3.5" />
                        <span>{t('input.loadingCommands', { defaultValue: '加载命令中...' })}</span>
                      </div>
                    ) : filteredSlashCommands.length === 0 ? (
                      <div className="px-2 py-3 text-xs text-muted-foreground">
                        {t('input.noCommandsFound', { defaultValue: '没有匹配的命令' })}
                      </div>
                    ) : (
                      filteredSlashCommands.map((command, index) => {
                        const isSelected = index === selectedSlashIndex
                        return (
                          <button
                            key={command.name}
                            type="button"
                            className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                              isSelected
                                ? 'bg-accent text-accent-foreground'
                                : 'hover:bg-muted/50 text-foreground'
                            }`}
                            onMouseDown={(event) => {
                              event.preventDefault()
                              insertSlashCommand(command.name)
                            }}
                          >
                            <Command className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">/{command.name}</div>
                              {command.summary && (
                                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                                  {command.summary}
                                </div>
                              )}
                            </div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Hidden file input for queue image upload */}
          <input
            ref={queueFileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                void addQueuedImages(Array.from(e.target.files))
              }
              e.target.value = ''
            }}
          />

          {/* Hidden file input for image upload */}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addImages(Array.from(e.target.files))
              e.target.value = ''
            }}
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between gap-2 px-2 pb-2 mt-1">
            {/* Left tools */}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1">
              <ModelSwitcher />

              {/* Web search toggle */}
              {mode !== 'chat' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      className={`h-8 rounded-lg px-2 gap-1 transition-colors ${
                        webSearchEnabled
                          ? 'text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={toggleWebSearch}
                      disabled={disabled || isStreaming}
                    >
                      <Globe className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {webSearchEnabled
                      ? t('input.disableWebSearch', { defaultValue: 'Disable web search' })
                      : t('input.enableWebSearch', { defaultValue: 'Enable web search' })}
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Skills menu (+ button) */}
              {mode !== 'chat' && (
                <>
                  <SkillsMenu
                    onSelectSkill={(name) => {
                      setSelectedSkill(name)
                      editorRef.current?.focus()
                    }}
                    onSelectCommand={(name) => {
                      insertSlashCommand(name)
                    }}
                    disabled={disabled || isStreaming}
                  />
                  <ActiveMcpsBadge />
                </>
              )}

              {/* Plan mode toggle */}
              {mode !== 'chat' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      className={`h-8 rounded-lg px-2 gap-1 transition-colors ${
                        planMode
                          ? 'text-violet-600 dark:text-violet-400 bg-violet-500/10 hover:bg-violet-500/20'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={togglePlanMode}
                      disabled={disabled || isStreaming}
                    >
                      <ClipboardList className="size-4" />
                      {planMode && <span className="text-[10px] font-medium">Plan</span>}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {planMode
                      ? t('input.exitPlanMode', { defaultValue: 'Exit Plan Mode' })
                      : t('input.enterPlanMode', { defaultValue: 'Enter Plan Mode' })}
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Image upload button */}
              {supportsVision && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={disabled}
                    >
                      <ImagePlus className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('input.attachImages')}</TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
                    onClick={() => void handleSelectFilesFromSystem()}
                    disabled={disabled || isOptimizing}
                  >
                    <FileUp className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('input.selectFiles', { defaultValue: '选择文件' })}
                </TooltipContent>
              </Tooltip>

              {/* Attachment / Folder button */}
              {onSelectFolder && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
                      onClick={onSelectFolder}
                    >
                      <FolderOpen className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('input.selectFolder')}</TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Right actions */}
            <div className="flex shrink-0 items-center gap-2">
              <ContextRing />

              {debouncedTokens > 0 && (
                <span className="text-[10px] text-muted-foreground/60 select-none tabular-nums">
                  {formatTokens(debouncedTokens)} tokens
                </span>
              )}

              {/* Clear messages */}
              {hasMessages && !isStreaming && (
                <AlertDialog>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 rounded-lg text-muted-foreground/40 hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{t('input.clearConversation')}</TooltipContent>
                  </Tooltip>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('input.clearConfirmTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {queuedMessages.length > 0
                          ? t('input.clearConfirmDescWithQueue', {
                              defaultValue:
                                '这将删除此对话中的所有消息，并清空当前会话的 {{count}} 条待发送消息。此操作不可撤销。',
                              count: queuedMessages.length
                            })
                          : t('input.clearConfirmDesc')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel size="sm">
                        {t('action.cancel', { ns: 'common' })}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          if (!activeSessionId) return
                          clearSessionMessages(activeSessionId)
                          clearPendingSessionMessages(activeSessionId)
                        }}
                      >
                        {t('action.clear', { ns: 'common' })}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}

              {/* Send / Stop button */}
              {isStreaming && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8 rounded-lg bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                      onClick={onStop}
                    >
                      <Spinner className="size-4 text-amber-600 dark:text-amber-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('input.stopTooltip')}</TooltipContent>
                </Tooltip>
              )}

              {/* Optimize prompt button */}
              {!isStreaming && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-50"
                      onClick={handleOptimizePrompt}
                      disabled={!plainText.trim() || disabled || isOptimizing}
                    >
                      {isOptimizing ? <Spinner className="size-4" /> : <Wand2 className="size-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isOptimizing ? t('input.optimizing') : t('input.optimizePrompt')}
                  </TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    className="h-8 rounded-lg px-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-sm"
                    onClick={handleSend}
                    disabled={
                      (!finalSerializedText.trim() && attachedImages.length === 0) ||
                      disabled ||
                      needsWorkingFolder ||
                      isOptimizing
                    }
                  >
                    <span>{t('action.start', { ns: 'common' })}</span>
                    <Send className="size-3.5 ml-1.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isStreaming
                    ? t('input.sendTooltipWhileRunning', { defaultValue: 'Send after current run' })
                    : t('input.sendTooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
