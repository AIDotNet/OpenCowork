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
  Wand2
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import type { AIModelConfig } from '@renderer/lib/api/types'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { updateWebSearchToolRegistration } from '@renderer/lib/tools'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { formatTokens } from '@renderer/lib/format-tokens'
import { useDebouncedTokens } from '@renderer/hooks/use-estimated-tokens'
import { useChatStore } from '@renderer/stores/chat-store'
import { useTranslation } from 'react-i18next'
import {
  ACCEPTED_IMAGE_TYPES,
  cloneImageAttachments,
  fileToImageAttachment,
  hasEditableDraftContent,
  type EditableUserMessageDraft,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import { SkillsMenu } from './SkillsMenu'
import { ModelSwitcher } from './ModelSwitcher'
import { useMcpStore } from '@renderer/stores/mcp-store'
import {
  getPendingSessionMessages,
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
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId)
    if (!session) return null
    const msgs = [...session.messages].reverse()
    return msgs.find((m) => m.usage)?.usage ?? null
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
  cowork: 'input.placeholderCowork',
  code: 'input.placeholderCode'
}

interface InputHistoryEntry {
  text: string
  images: ImageAttachment[]
}

interface InputHistoryDraft {
  text: string
  images: ImageAttachment[]
  selectedSkill: string | null
}

const EMPTY_QUEUED_MESSAGES: PendingSessionMessageItem[] = []
const INPUT_HISTORY_LIMIT = 30
const PENDING_HISTORY_KEY = '__pending_session__'
const MIN_INPUT_HEIGHT = 120
const MAX_INPUT_HEIGHT = 500
const MIN_MESSAGE_LIST_HEIGHT = 120
const FALLBACK_MAX_VIEWPORT_RATIO = 0.6

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
    if (leftMsg.images.length !== rightMsg.images.length) return false
    for (let j = 0; j < leftMsg.images.length; j += 1) {
      if (leftMsg.images[j].id !== rightMsg.images[j].id) return false
    }
  }
  return true
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
  const [text, setText] = React.useState('')
  const debouncedTokens = useDebouncedTokens(text)
  const [selectedSkill, setSelectedSkill] = React.useState<string | null>(null)
  const [attachedImages, setAttachedImages] = React.useState<ImageAttachment[]>([])
  const [isOptimizing, setIsOptimizing] = React.useState(false)
  const [, setOptimizingText] = React.useState('')
  const [optimizationOptions, setOptimizationOptions] = React.useState<
    Array<{ title: string; focus: string; content: string }>
  >([])
  const [showOptimizationDialog, setShowOptimizationDialog] = React.useState(false)
  const [selectedOptionIndex, setSelectedOptionIndex] = React.useState(0)
  const currentLanguage = useSettingsStore((state) => state.language)
  const contentScrollRef = React.useRef<HTMLDivElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const queueFileInputRef = React.useRef<HTMLInputElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [inputHeight, setInputHeight] = React.useState<number | null>(null)
  const dragRef = React.useRef<{ startY: number; startH: number; maxH: number } | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

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
  /** Per-session input draft (text + images + skill) */
  const draftBySessionRef = React.useRef<
    Record<string, { text: string; images: ImageAttachment[]; skill: string | null }>
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
  const mode = useUIStore((s) => s.mode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
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
  const [editingQueueItemId, setEditingQueueItemId] = React.useState<string | null>(null)
  const [editingQueueText, setEditingQueueText] = React.useState('')
  const [editingQueueImages, setEditingQueueImages] = React.useState<ImageAttachment[]>([])

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
      if (!queuedMessages.some((msg) => msg.id === id)) return

      const nextDraft: EditableUserMessageDraft = {
        text: editingQueueText.trim(),
        images: cloneImageAttachments(editingQueueImages)
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
  const resizeTextarea = React.useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // Ensure we disable field-sizing: content to control height manually
    el.style.setProperty('field-sizing', 'fixed')
    if (inputHeight) {
      el.style.height = '100%'
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [inputHeight])

  React.useEffect(() => {
    resizeTextarea()
  }, [inputHeight, resizeTextarea])
  const focusInputAtEnd = React.useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const cursor = el.value.length
    el.setSelectionRange(cursor, cursor)
  }, [])
  const applyHistoryEntry = React.useCallback(
    (entry: InputHistoryEntry) => {
      setText(entry.text)
      setAttachedImages(cloneImageAttachments(entry.images))
      setSelectedSkill(null)
      requestAnimationFrame(() => {
        resizeTextarea()
        focusInputAtEnd()
      })
    },
    [focusInputAtEnd, resizeTextarea]
  )
  const restoreDraftFromHistory = React.useCallback(() => {
    const draft = historyDraftRef.current
    setText(draft?.text ?? '')
    setAttachedImages(cloneImageAttachments(draft?.images ?? []))
    setSelectedSkill(draft?.selectedSkill ?? null)
    historyDraftRef.current = null
    requestAnimationFrame(() => {
      resizeTextarea()
      focusInputAtEnd()
    })
  }, [focusInputAtEnd, resizeTextarea])
  const navigateHistory = React.useCallback(
    (direction: 'up' | 'down') => {
      if (sentHistory.length === 0) return
      if (direction === 'up') {
        if (historyCursor === null) {
          historyDraftRef.current = {
            text,
            images: cloneImageAttachments(attachedImages),
            selectedSkill
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
      applyHistoryEntry,
      restoreDraftFromHistory
    ]
  )
  const hasMessages = useChatStore((s) => {
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId)
    return (session?.messageCount ?? 0) > 0
  })
  const clearSessionMessages = useChatStore((s) => s.clearSessionMessages)
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

  // Auto-focus textarea when not streaming or when switching sessions
  React.useEffect(() => {
    if (!isStreaming && !disabled) {
      textareaRef.current?.focus()
    }
  }, [isStreaming, disabled, activeSessionId])

  React.useEffect(() => {
    if (!activeSessionId) return
    void useChatStore.getState().loadSessionMessages(activeSessionId)
  }, [activeSessionId])

  React.useEffect(() => {
    setEditingQueueItemId(null)
    setEditingQueueText('')
    setEditingQueueImages([])
  }, [activeSessionId])

  React.useEffect(() => {
    if (!editingQueueItemId) return
    if (queuedMessages.some((msg) => msg.id === editingQueueItemId)) return
    setEditingQueueItemId(null)
    setEditingQueueText('')
    setEditingQueueImages([])
  }, [queuedMessages, editingQueueItemId])

  React.useEffect(() => {
    const prevSessionId = prevSessionIdRef.current

    // Save current draft to the previous session before switching
    if (prevSessionId) {
      draftBySessionRef.current[prevSessionId] = {
        text,
        images: cloneImageAttachments(attachedImages),
        skill: selectedSkill
      }
    }

    // Restore draft from the new session (or clear)
    const draft = activeSessionId ? draftBySessionRef.current[activeSessionId] : undefined
    setText(draft?.text ?? '')
    setAttachedImages(draft?.images ? cloneImageAttachments(draft.images) : [])
    setSelectedSkill(draft?.skill ?? null)
    requestAnimationFrame(() => resizeTextarea())

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
    if (pendingInsert) {
      clearHistoryNavigation()
      setText((prev) => {
        const prefix = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : ''
        return `${prev}${prefix}${pendingInsert}`
      })
      useUIStore.getState().setPendingInsertText(null)
      requestAnimationFrame(() => {
        resizeTextarea()
        focusInputAtEnd()
      })
    }
  }, [pendingInsert, clearHistoryNavigation, focusInputAtEnd, resizeTextarea])

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

  const handleSend = (): void => {
    const trimmed = text.trim()
    if (!trimmed && attachedImages.length === 0) return
    if (disabled || needsWorkingFolder) return
    const message = selectedSkill ? `[Skill: ${selectedSkill}]\n${trimmed}` : trimmed

    onSend(message, attachedImages.length > 0 ? attachedImages : undefined)
    updateSessionHistory((prevHistory) => {
      const nextHistory = [
        ...prevHistory,
        {
          text: message,
          images: cloneImageAttachments(attachedImages)
        }
      ]
      return nextHistory.length > INPUT_HISTORY_LIMIT
        ? nextHistory.slice(nextHistory.length - INPUT_HISTORY_LIMIT)
        : nextHistory
    })
    setHistoryCursor(null)
    historyDraftRef.current = null
    setText('')
    setAttachedImages([])
    setSelectedSkill(null)
    // Reset textarea height
    if (textareaRef.current) {
      if (inputHeight) {
        textareaRef.current.style.height = '100%'
      } else {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (isOptimizing) return // Disable input during optimization
    if (
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
    ) {
      const target = e.currentTarget
      const selectionStart = target.selectionStart ?? 0
      const selectionEnd = target.selectionEnd ?? 0
      const isCollapsed = selectionStart === selectionEnd
      if (isCollapsed && e.key === 'ArrowUp' && selectionStart === 0) {
        e.preventDefault()
        navigateHistory('up')
        return
      }
      if (isCollapsed && e.key === 'ArrowDown' && selectionStart === target.value.length) {
        e.preventDefault()
        navigateHistory('down')
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
      return
    }
  }

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    if (isOptimizing) return // Disable input during optimization
    clearHistoryNavigation()
    setText(e.target.value)
    if (inputHeight) return
    const el = e.target
    // Ensure we disable field-sizing: content to control height manually
    el.style.setProperty('field-sizing', 'fixed')
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  // Paste handler for images
  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent): void => {
      if (!supportsVision) return
      const items = Array.from(e.clipboardData.items)
      const imageFiles = items
        .filter((item) => item.kind === 'file' && ACCEPTED_IMAGE_TYPES.includes(item.type))
        .map((item) => item.getAsFile())
        .filter(Boolean) as File[]
      if (imageFiles.length > 0) {
        e.preventDefault()
        addImages(imageFiles)
      }
    },
    [supportsVision, addImages]
  )

  // Drag-and-drop: images go to attachments, other files insert paths
  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>): void => {
    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      e.preventDefault()
      const fileArr = Array.from(files)
      const imageFiles = supportsVision
        ? fileArr.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type))
        : []
      const otherFiles = supportsVision
        ? fileArr.filter((f) => !ACCEPTED_IMAGE_TYPES.includes(f.type))
        : fileArr
      if (imageFiles.length > 0) addImages(imageFiles)
      if (otherFiles.length > 0) {
        const paths = otherFiles.map((f) => (f as File & { path: string }).path).filter(Boolean)
        if (paths.length > 0) {
          const insertion = paths.join('\n')
          setText((prev) => (prev ? `${prev}\n${insertion}` : insertion))
        }
      }
    }
  }

  const [dragging, setDragging] = useLocalState(false)

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = (): void => {
    setDragging(false)
  }

  const handleDropWrapped = (e: React.DragEvent<HTMLDivElement>): void => {
    setDragging(false)
    handleDrop(e as unknown as React.DragEvent<HTMLTextAreaElement>)
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
  }, [text, isOptimizing])

  const handleSelectOption = React.useCallback((content: string) => {
    setText(content)
    setOptimizationOptions([])
    setOptimizingText('')
    setSelectedOptionIndex(0)
    setShowOptimizationDialog(false)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [])

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
          {/* Queued message list (while current run is processing) */}
          {queuedMessages.length > 0 && (
            <div className="px-3 pt-3 pb-1">
              <div className="mb-2 flex items-center justify-between rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5">
                <span className="text-xs font-medium text-primary">
                  {t('input.queueTitle', { defaultValue: '排队消息' })} · {queuedMessages.length}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {t('input.queueHint', { defaultValue: '当前任务结束后按顺序发送' })}
                </span>
              </div>
              <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {queuedMessages.map((msg) => {
                  const isEditing = editingQueueItemId === msg.id
                  return (
                    <div
                      key={msg.id}
                      className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2"
                    >
                      <div className="mb-1 flex items-center justify-end">
                        <div className="flex items-center gap-1">
                          {isEditing ? (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => saveQueuedMessage(msg.id)}
                              >
                                {t('action.save', { ns: 'common', defaultValue: '保存' })}
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
                            </>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => startEditQueuedMessage(msg)}
                            >
                              {t('action.edit', { ns: 'common', defaultValue: '编辑' })}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px] text-destructive hover:text-destructive"
                            onClick={() => removeQueuedMessage(msg.id)}
                          >
                            {t('action.delete', { ns: 'common', defaultValue: '删除' })}
                          </Button>
                        </div>
                      </div>
                      {isEditing ? (
                        <div className="space-y-2">
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
                        <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words pr-1 text-xs leading-relaxed">
                          {msg.text || t('input.queueImageOnly', { defaultValue: '[仅图片]' })}
                        </div>
                      )}
                      {!isEditing && msg.images.length > 0 && (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {t('input.queueImageCount', {
                            defaultValue: '{{count}} 张图片',
                            count: msg.images.length
                          })}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
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
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t(placeholderKeys[mode] ?? 'input.placeholder')}
              className="min-h-[60px] w-full resize-none border-0 bg-background dark:bg-background p-1 shadow-none focus-visible:ring-0 text-base md:text-sm flex-1"
              rows={1}
              disabled={disabled || isOptimizing}
            />
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
                      textareaRef.current?.focus()
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
                      <AlertDialogDescription>{t('input.clearConfirmDesc')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel size="sm">
                        {t('action.cancel', { ns: 'common' })}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        size="sm"
                        onClick={() => activeSessionId && clearSessionMessages(activeSessionId)}
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
                      disabled={!text.trim() || disabled || isOptimizing}
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
                      (!text.trim() && attachedImages.length === 0) ||
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
