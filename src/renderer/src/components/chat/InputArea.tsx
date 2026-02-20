import * as React from 'react'
import { useState as useLocalState } from 'react'
import { Send, FolderOpen, AlertTriangle, FileUp, Sparkles, X, Trash2, ImagePlus, Brain, ChevronDown, ClipboardList } from 'lucide-react'
import { nanoid } from 'nanoid'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Textarea } from '@renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { AIModelConfig, ReasoningEffortLevel } from '@renderer/lib/api/types'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { formatTokens } from '@renderer/lib/format-tokens'
import { useDebouncedTokens } from '@renderer/hooks/use-estimated-tokens'
import { useChatStore } from '@renderer/stores/chat-store'
import { useTranslation } from 'react-i18next'
import { SkillsMenu } from './SkillsMenu'
import { ModelSwitcher } from './ModelSwitcher'
import { usePluginStore } from '@renderer/stores/plugin-store'
import { useMcpStore } from '@renderer/stores/mcp-store'
import {
  getPendingSessionMessages,
  removePendingSessionMessage,
  subscribePendingSessionMessages,
  updatePendingSessionMessageText,
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
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'

function ContextRing(): React.JSX.Element | null {
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

  if (!ctxLimit || ctxUsed <= 0) return null

  const pct = Math.min((ctxUsed / ctxLimit) * 100, 100)
  const remaining = Math.max(ctxLimit - ctxUsed, 0)
  const strokeColor = pct > 80 ? 'stroke-red-500' : pct > 50 ? 'stroke-amber-500' : 'stroke-emerald-500'

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
          <p className="text-muted-foreground">
            {formatTokens(remaining)} remaining
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function ActivePluginsBadge(): React.JSX.Element | null {
  const activePluginIds = usePluginStore((s) => s.activePluginIds)
  const plugins = usePluginStore((s) => s.plugins)
  if (activePluginIds.length === 0) return null
  const activeNames = plugins
    .filter((p) => activePluginIds.includes(p.id))
    .map((p) => p.name)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary cursor-default">
          <span className="size-1.5 rounded-full bg-primary animate-pulse" />
          <span>{activePluginIds.length} plugin{activePluginIds.length > 1 ? 's' : ''}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs font-medium">Active plugins:</p>
        {activeNames.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">{n}</p>
        ))}
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
  code: 'input.placeholderCode',
}

export interface ImageAttachment {
  id: string
  dataUrl: string
  mediaType: string
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
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20 MB
const INPUT_HISTORY_LIMIT = 30
const PENDING_HISTORY_KEY = '__pending_session__'

function cloneImages(images: ImageAttachment[]): ImageAttachment[] {
  return images.map((img) => ({ ...img }))
}

function fileToImageAttachment(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) { resolve(null); return }
    if (file.size > MAX_IMAGE_SIZE) { resolve(null); return }
    const reader = new FileReader()
    reader.onload = () => {
      resolve({ id: nanoid(), dataUrl: reader.result as string, mediaType: file.type })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

interface InputAreaProps {
  onSend: (text: string, images?: ImageAttachment[]) => void
  onStop?: () => void
  onSelectFolder?: () => void
  isStreaming?: boolean
  workingFolder?: string
  disabled?: boolean
}

export function InputArea({
  onSend,
  onStop,
  onSelectFolder,
  isStreaming = false,
  workingFolder,
  disabled = false,
}: InputAreaProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [text, setText] = React.useState('')
  const debouncedTokens = useDebouncedTokens(text)
  const [selectedSkill, setSelectedSkill] = React.useState<string | null>(null)
  const [attachedImages, setAttachedImages] = React.useState<ImageAttachment[]>([])
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [sentHistory, setSentHistory] = React.useState<InputHistoryEntry[]>([])
  const [historyCursor, setHistoryCursor] = React.useState<number | null>(null)
  const historyDraftRef = React.useRef<InputHistoryDraft | null>(null)
  const historyBySessionRef = React.useRef<Record<string, InputHistoryEntry[]>>({})
  const prevSessionIdRef = React.useRef<string | null>(null)
  /** Per-session input draft (text + images + skill) */
  const draftBySessionRef = React.useRef<Record<string, { text: string; images: ImageAttachment[]; skill: string | null }>>({})
  const activeProvider = useProviderStore((s) => {
    const { providers, activeProviderId } = s
    if (!activeProviderId) return null
    return providers.find((p) => p.id === activeProviderId) ?? null
  })
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const supportsVision = React.useMemo(() => {
    if (!activeProvider) return false
    const model = activeProvider.models.find((m) => m.id === activeModelId)
    return model?.supportsVision ?? false
  }, [activeProvider, activeModelId])
  const activeModelConfig = React.useMemo(() => {
    if (!activeProvider) return null
    return activeProvider.models.find((m) => m.id === activeModelId) ?? null
  }, [activeProvider, activeModelId])
  const supportsThinking = activeModelConfig?.supportsThinking ?? false
  const reasoningEffortLevels = activeModelConfig?.thinkingConfig?.reasoningEffortLevels
  const defaultReasoningEffort = activeModelConfig?.thinkingConfig?.defaultReasoningEffort ?? 'medium'
  const thinkingEnabled = useSettingsStore((s) => s.thinkingEnabled)
  const reasoningEffort = useSettingsStore((s) => s.reasoningEffort)
  const toggleThinking = React.useCallback(() => {
    const store = useSettingsStore.getState()
    if (!store.thinkingEnabled && reasoningEffortLevels) {
      // When enabling thinking on a model with levels, set to default level
      useSettingsStore.getState().updateSettings({ thinkingEnabled: true, reasoningEffort: defaultReasoningEffort })
    } else {
      useSettingsStore.getState().updateSettings({ thinkingEnabled: !store.thinkingEnabled })
    }
  }, [reasoningEffortLevels, defaultReasoningEffort])
  const setReasoningEffort = React.useCallback((level: ReasoningEffortLevel) => {
    useSettingsStore.getState().updateSettings({ reasoningEffort: level, thinkingEnabled: true })
  }, [])
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const mode = useUIStore((s) => s.mode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const queuedMessages = React.useSyncExternalStore(
    subscribePendingSessionMessages,
    () => (activeSessionId ? getPendingSessionMessages(activeSessionId) : EMPTY_QUEUED_MESSAGES),
    () => EMPTY_QUEUED_MESSAGES
  )
  const [editingQueueItemId, setEditingQueueItemId] = React.useState<string | null>(null)
  const [editingQueueText, setEditingQueueText] = React.useState('')

  const startEditQueuedMessage = React.useCallback((msg: PendingSessionMessageItem) => {
    setEditingQueueItemId(msg.id)
    setEditingQueueText(msg.text)
  }, [])

  const cancelEditQueuedMessage = React.useCallback(() => {
    setEditingQueueItemId(null)
    setEditingQueueText('')
  }, [])

  const removeQueuedMessage = React.useCallback((id: string) => {
    if (!activeSessionId) return
    removePendingSessionMessage(activeSessionId, id)
    if (editingQueueItemId === id) {
      setEditingQueueItemId(null)
      setEditingQueueText('')
    }
  }, [activeSessionId, editingQueueItemId])

  const saveQueuedMessage = React.useCallback((id: string) => {
    if (!activeSessionId) return
    const current = queuedMessages.find((msg) => msg.id === id)
    if (!current) return

    const nextText = editingQueueText.trim()
    if (!nextText && current.images.length === 0) {
      removePendingSessionMessage(activeSessionId, id)
      setEditingQueueItemId(null)
      setEditingQueueText('')
      return
    }

    updatePendingSessionMessageText(activeSessionId, id, nextText)
    setEditingQueueItemId(null)
    setEditingQueueText('')
  }, [activeSessionId, queuedMessages, editingQueueText])

  const getHistoryKey = React.useCallback(() => activeSessionId ?? PENDING_HISTORY_KEY, [activeSessionId])
  const updateSessionHistory = React.useCallback((updater: (prev: InputHistoryEntry[]) => InputHistoryEntry[]) => {
    const historyKey = getHistoryKey()
    const prevHistory = historyBySessionRef.current[historyKey] ?? []
    const nextHistory = updater(prevHistory)
    historyBySessionRef.current[historyKey] = nextHistory
    setSentHistory(nextHistory)
  }, [getHistoryKey])
  const clearHistoryNavigation = React.useCallback(() => {
    if (historyCursor !== null) {
      setHistoryCursor(null)
      historyDraftRef.current = null
    }
  }, [historyCursor])
  const resizeTextarea = React.useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])
  const focusInputAtEnd = React.useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const cursor = el.value.length
    el.setSelectionRange(cursor, cursor)
  }, [])
  const applyHistoryEntry = React.useCallback((entry: InputHistoryEntry) => {
    setText(entry.text)
    setAttachedImages(cloneImages(entry.images))
    setSelectedSkill(null)
    requestAnimationFrame(() => {
      resizeTextarea()
      focusInputAtEnd()
    })
  }, [focusInputAtEnd, resizeTextarea])
  const restoreDraftFromHistory = React.useCallback(() => {
    const draft = historyDraftRef.current
    setText(draft?.text ?? '')
    setAttachedImages(cloneImages(draft?.images ?? []))
    setSelectedSkill(draft?.selectedSkill ?? null)
    historyDraftRef.current = null
    requestAnimationFrame(() => {
      resizeTextarea()
      focusInputAtEnd()
    })
  }, [focusInputAtEnd, resizeTextarea])
  const navigateHistory = React.useCallback((direction: 'up' | 'down') => {
    if (sentHistory.length === 0) return
    if (direction === 'up') {
      if (historyCursor === null) {
        historyDraftRef.current = {
          text,
          images: cloneImages(attachedImages),
          selectedSkill,
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
  }, [historyCursor, sentHistory, text, attachedImages, selectedSkill, applyHistoryEntry, restoreDraftFromHistory])
  const hasMessages = useChatStore((s) => {
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId)
    return (session?.messageCount ?? 0) > 0
  })
  const clearSessionMessages = useChatStore((s) => s.clearSessionMessages)
  const hasApiKey = !!(activeProvider?.apiKey) || activeProvider?.requiresApiKey === false
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
  }, [activeSessionId])

  React.useEffect(() => {
    if (!editingQueueItemId) return
    if (queuedMessages.some((msg) => msg.id === editingQueueItemId)) return
    setEditingQueueItemId(null)
    setEditingQueueText('')
  }, [queuedMessages, editingQueueItemId])

  React.useEffect(() => {
    const prevSessionId = prevSessionIdRef.current

    // Save current draft to the previous session before switching
    if (prevSessionId) {
      draftBySessionRef.current[prevSessionId] = {
        text,
        images: cloneImages(attachedImages),
        skill: selectedSkill,
      }
    }

    // Restore draft from the new session (or clear)
    const draft = activeSessionId ? draftBySessionRef.current[activeSessionId] : undefined
    setText(draft?.text ?? '')
    setAttachedImages(draft?.images ? cloneImages(draft.images) : [])
    setSelectedSkill(draft?.skill ?? null)
    requestAnimationFrame(() => resizeTextarea())

    if (!prevSessionId && activeSessionId) {
      const pendingHistory = historyBySessionRef.current[PENDING_HISTORY_KEY]
      if (pendingHistory && pendingHistory.length > 0 && !historyBySessionRef.current[activeSessionId]) {
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
  const addImages = React.useCallback(async (files: File[]) => {
    const results = await Promise.all(files.map(fileToImageAttachment))
    const valid = results.filter(Boolean) as ImageAttachment[]
    if (valid.length > 0) {
      clearHistoryNavigation()
      setAttachedImages((prev) => [...prev, ...valid])
    }
  }, [clearHistoryNavigation])

  const removeImage = React.useCallback((id: string) => {
    clearHistoryNavigation()
    setAttachedImages((prev) => prev.filter((img) => img.id !== id))
  }, [clearHistoryNavigation])

  const handleSend = (): void => {
    const trimmed = text.trim()
    if (!trimmed && attachedImages.length === 0) return
    if (disabled || needsWorkingFolder) return
    const message = selectedSkill
      ? `[Skill: ${selectedSkill}]\n${trimmed}`
      : trimmed
    onSend(message, attachedImages.length > 0 ? attachedImages : undefined)
    updateSessionHistory((prevHistory) => {
      const nextHistory = [
        ...prevHistory,
        {
          text: message,
          images: cloneImages(attachedImages),
        },
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
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
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
    clearHistoryNavigation()
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  // Paste handler for images
  const handlePaste = React.useCallback((e: React.ClipboardEvent): void => {
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
  }, [supportsVision, addImages])

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
          setText((prev) => prev ? `${prev}\n${insertion}` : insertion)
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

  return (
    <div className="px-4 py-3 pb-4">
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
            <span>{t('input.planModeActive', { defaultValue: 'Plan Mode — exploring codebase, no file changes' })}</span>
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
      {workingFolder && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderOpen className="size-3" />
          <span className="truncate">{workingFolder}</span>
        </div>
      )}

      <div className="mx-auto max-w-3xl">
        <div className={`relative rounded-2xl border bg-background shadow-lg transition-shadow focus-within:shadow-xl focus-within:ring-1 focus-within:ring-ring/20 ${dragging ? 'ring-2 ring-primary/50' : ''}`}>
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
                    <div key={msg.id} className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
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
                        <Textarea
                          value={editingQueueText}
                          onChange={(e) => setEditingQueueText(e.target.value)}
                          className="min-h-[56px] max-h-36 resize-none border-border/70 bg-background text-xs"
                          rows={2}
                        />
                      ) : (
                        <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words pr-1 text-xs leading-relaxed">
                          {msg.text || t('input.queueImageOnly', { defaultValue: '[仅图片]' })}
                        </div>
                      )}
                      {msg.images.length > 0 && (
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
                    className="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity shadow"
                    onClick={() => removeImage(img.id)}
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Text input area */}
          <div
            className={`relative px-3 ${selectedSkill || attachedImages.length > 0 ? 'pt-1.5' : 'pt-3'}`}
            onDrop={handleDropWrapped}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            {dragging && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/5 pointer-events-none">
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
              className="min-h-[60px] max-h-[300px] w-full resize-none border-0 bg-background dark:bg-background p-1 shadow-none focus-visible:ring-0 text-base md:text-sm"
              rows={1}
              disabled={disabled}
            />
          </div>

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
          <div className="flex items-center justify-between px-2 pb-2 mt-1">
            {/* Left tools */}
            <div className="flex items-center gap-1">
              <ModelSwitcher />

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
                  <ActivePluginsBadge />
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
                    {planMode ? t('input.exitPlanMode', { defaultValue: 'Exit Plan Mode' }) : t('input.enterPlanMode', { defaultValue: 'Enter Plan Mode' })}
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

              {/* Think toggle button — with reasoning effort level selector */}
              {supportsThinking && (
                reasoningEffortLevels && reasoningEffortLevels.length > 0 ? (
                  <Popover>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            className={`h-8 rounded-lg px-2 gap-1 transition-colors ${
                              thinkingEnabled
                                ? 'text-violet-600 dark:text-violet-400 bg-violet-500/10 hover:bg-violet-500/20'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                            disabled={disabled || isStreaming}
                          >
                            <Brain className="size-4" />
                            {thinkingEnabled && (
                              <span className="text-[10px] font-medium uppercase">{reasoningEffort}</span>
                            )}
                            <ChevronDown className="size-3 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent>{thinkingEnabled ? t('input.thinkingLevel', { level: reasoningEffort }) : t('input.enableThinking')}</TooltipContent>
                    </Tooltip>
                    <PopoverContent className="w-auto p-1.5" align="start" side="top">
                      <div className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors text-left ${
                            !thinkingEnabled
                              ? 'bg-accent text-accent-foreground'
                              : 'hover:bg-muted/60 text-foreground/80'
                          }`}
                          onClick={() => useSettingsStore.getState().updateSettings({ thinkingEnabled: false })}
                        >
                          <span className="font-medium">{t('input.thinkingOff')}</span>
                        </button>
                        {reasoningEffortLevels.map((level) => (
                          <button
                            key={level}
                            type="button"
                            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors text-left ${
                              thinkingEnabled && reasoningEffort === level
                                ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
                                : 'hover:bg-muted/60 text-foreground/80'
                            }`}
                            onClick={() => setReasoningEffort(level)}
                          >
                            <span className="font-medium uppercase">{level}</span>
                            <span className="text-[10px] text-muted-foreground">{t(`input.effortDesc.${level}`)}</span>
                          </button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`size-8 rounded-lg transition-colors ${
                          thinkingEnabled
                            ? 'text-violet-600 dark:text-violet-400 bg-violet-500/10 hover:bg-violet-500/20'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        onClick={toggleThinking}
                        disabled={disabled || isStreaming}
                      >
                        <Brain className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{thinkingEnabled ? t('input.disableThinking') : t('input.enableThinking')}</TooltipContent>
                  </Tooltip>
                )
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
            <div className="flex items-center gap-2">
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
                        {t('input.clearConfirmDesc')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel size="sm">{t('action.cancel', { ns: 'common' })}</AlertDialogCancel>
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
                      variant="destructive"
                      size="icon"
                      className="size-8 rounded-lg"
                      onClick={onStop}
                    >
                      <Spinner className="size-4 text-white" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('input.stopTooltip')}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    className="h-8 rounded-lg px-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-sm"
                    onClick={handleSend}
                    disabled={(!text.trim() && attachedImages.length === 0) || disabled || needsWorkingFolder}
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
