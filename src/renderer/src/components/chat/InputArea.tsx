import * as React from 'react'
import { useState as useLocalState } from 'react'
import { toast } from 'sonner'
import {
  Send,
  FolderOpen,
  AlertTriangle,
  CircleHelp,
  Briefcase,
  Code2,
  ShieldCheck,
  FileUp,
  FileCode2,
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
import type { AIModelConfig } from '@renderer/lib/api/types'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { updateWebSearchToolRegistration } from '@renderer/lib/tools'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { formatTokens } from '@renderer/lib/format-tokens'
import {
  getEffectiveContextWindow,
  resolveCompressionContextLength,
  resolveCompressionReservedOutputBudget,
  resolveCompressionThreshold
} from '@renderer/lib/agent/context-compression'
import { useDebouncedTokens } from '@renderer/hooks/use-estimated-tokens'
import { usePromptRecommendation } from '@renderer/hooks/use-prompt-recommendation'
import { useChatStore } from '@renderer/stores/chat-store'
import {
  getSessionInputDraftKey,
  hasInputDraftContent,
  useInputDraftStore
} from '@renderer/stores/input-draft-store'
import { useShallow } from 'zustand/react/shallow'
import { useStoreWithEqualityFn } from 'zustand/traditional'
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
  createSelectFileToken,
  getSelectFileMentionQuery,
  selectFileTextToPlainText
} from '@renderer/lib/select-file-tags'
import {
  deserializeEditorState,
  documentHasFileReferences,
  editorDocumentToPlainText,
  ensureSelectedFile,
  mergeSelectedFiles,
  removeReferenceNode,
  replaceEditorRange,
  serializeEditorDocument,
  type EditorDocumentNode,
  type SelectedFileItem
} from '@renderer/lib/select-file-editor'
import { SkillsMenu } from './SkillsMenu'
import { ModelSwitcher } from './ModelSwitcher'
import { FileAwareEditor, type FileAwareEditorHandle } from './FileAwareEditor'
import { listCommands, type CommandCatalogItem } from '@renderer/lib/commands/command-loader'
import { useMcpStore } from '@renderer/stores/mcp-store'
import { usePlanStore } from '@renderer/stores/plan-store'
import {
  clearPendingSessionMessages,
  dispatchNextQueuedMessageForSession,
  getPendingSessionMessages,
  isPendingSessionDispatchPaused,
  removePendingSessionMessage,
  subscribePendingSessionMessages,
  updatePendingSessionMessageDraft,
  type SendMessageOptions,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import { resolveProjectMemoryTextFile } from '@renderer/lib/agent/memory-files'
import { isProjectSession, workspaceContextAvailable } from '@renderer/lib/session-scope'
import { InlineStepsPanel } from '@renderer/components/cowork/StepsPanel'

function ContextRing(): React.JSX.Element | null {
  const activeSessionProviderId = useChatStore((s) => {
    const idx = s.activeSessionId ? s.sessionsById[s.activeSessionId] : undefined
    const activeSession = idx !== undefined ? s.sessions[idx] : undefined
    return activeSession?.providerId ?? null
  })
  const activeSessionModelId = useChatStore((s) => {
    const idx = s.activeSessionId ? s.sessionsById[s.activeSessionId] : undefined
    const activeSession = idx !== undefined ? s.sessions[idx] : undefined
    return activeSession?.modelId ?? null
  })

  const activeModelCfg = useProviderStore((s) => {
    const providerId = activeSessionProviderId ?? s.activeProviderId
    const modelId = activeSessionModelId ?? s.activeModelId
    if (!providerId || !modelId) return null
    const provider = s.providers.find((p) => p.id === providerId)
    return provider?.models.find((m) => m.id === modelId) ?? null
  }) as AIModelConfig | null
  const compressionConfig = activeModelCfg
    ? {
        enabled: true,
        contextLength: resolveCompressionContextLength(activeModelCfg),
        threshold: resolveCompressionThreshold(activeModelCfg),
        preCompressThreshold: 0.65,
        reservedOutputBudget: resolveCompressionReservedOutputBudget(activeModelCfg)
      }
    : null

  const [ctxUsedRaw, ctxLimitRaw] = useStoreWithEqualityFn(
    useChatStore,
    React.useCallback((s): [number, number | null] => {
      const idx = s.activeSessionId ? s.sessionsById[s.activeSessionId] : undefined
      const activeSession = idx !== undefined ? s.sessions[idx] : undefined
      if (!activeSession) return [0, null]
      const messages = activeSession.messages
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        const usage = message?.usage
        if (!usage) continue
        if (s.streamingMessageId && message?.id === s.streamingMessageId) {
          const streamingCtxUsed = usage.contextTokens ?? 0
          if (streamingCtxUsed <= 0) continue
        }
        return [usage.contextTokens ?? 0, usage.contextLength ?? null]
      }
      return [0, null]
    }, []),
    (a, b) => a[0] === b[0] && a[1] === b[1]
  )

  const ctxUsed = ctxUsedRaw
  const ctxLimit = ctxLimitRaw ?? compressionConfig?.contextLength ?? null
  const ctxGaugeLimit = compressionConfig ? getEffectiveContextWindow(compressionConfig) : ctxLimit

  if (!ctxGaugeLimit) return null

  const pct = Math.min((ctxUsed / ctxGaugeLimit) * 100, 100)
  const remaining = Math.max(ctxGaugeLimit - ctxUsed, 0)
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
          <div className="relative flex size-[26px] shrink-0 items-center justify-center">
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
              {pct.toFixed(0)}%
            </span>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-xs space-y-0.5">
          <p className="font-medium">Compression Budget</p>
          <p className="text-muted-foreground">
            {formatTokens(ctxUsed)} / {formatTokens(ctxGaugeLimit)} ({pct.toFixed(1)}%)
          </p>
          <p className="text-muted-foreground">{formatTokens(remaining)} remaining</p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function ActiveMcpsBadge({ projectId }: { projectId?: string | null }): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const activeMcpIdsByProject = useMcpStore((s) => s.activeMcpIdsByProject)
  const activeMcpIds = activeMcpIdsByProject[projectId ?? '__global__'] ?? []
  const servers = useMcpStore((s) => s.servers)
  const serverTools = useMcpStore((s) => s.serverTools)
  if (activeMcpIds.length === 0) return null
  const activeServers = servers.filter((s) => activeMcpIds.includes(s.id))
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="composer-status-pill flex cursor-default items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px]">
          <span className="size-1.5 rounded-full bg-current animate-pulse opacity-80" />
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
  code: 'input.placeholderCode',
  acp: 'input.placeholderAcp'
}

const defaultRecommendationKeys: Record<AppMode, string> = {
  chat: 'input.recommendationDefaultChat',
  clarify: 'input.recommendationDefaultClarify',
  cowork: 'input.recommendationDefaultCowork',
  code: 'input.recommendationDefaultCode',
  acp: 'input.recommendationDefaultAcp'
}

const composerModeOptions: Array<{
  value: AppMode
  label: string
  icon: React.JSX.Element
}> = [
  { value: 'chat', label: '聊天', icon: <Send className="size-3.5" /> },
  { value: 'clarify', label: '澄清', icon: <CircleHelp className="size-3.5" /> },
  { value: 'cowork', label: '协作', icon: <Briefcase className="size-3.5" /> },
  { value: 'code', label: '代码', icon: <Code2 className="size-3.5" /> },
  { value: 'acp', label: 'ACP', icon: <ShieldCheck className="size-3.5" /> }
]

interface FileSearchItem {
  name: string
  path: string
}

const EMPTY_QUEUED_MESSAGES: PendingSessionMessageItem[] = []
const INTERNAL_FILE_DRAG_MIME = 'application/x-opencowork-file-paths'
const MIN_INPUT_HEIGHT = 120
const DEFAULT_SESSION_INPUT_HEIGHT = 160
const MAX_INPUT_HEIGHT = 500
const MIN_MESSAGE_LIST_HEIGHT = 120
const EDITOR_MIN_HEIGHT = 60
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

function isReferenceOnlyDocument(document: EditorDocumentNode[]): boolean {
  if (document.length === 0) return false

  return document.every((node) => node.type === 'file' || node.text.trim().length === 0)
}

interface InputAreaProps {
  sessionId?: string | null
  onSend: (text: string, images?: ImageAttachment[], options?: SendMessageOptions) => void
  onStop?: () => void
  onSelectFolder?: () => void
  isStreaming?: boolean
  workingFolder?: string
  hideWorkingFolderIndicator?: boolean
  hideWorkingFolderPicker?: boolean
  disabled?: boolean
}

export function InputArea({
  sessionId,
  onSend,
  onStop,
  onSelectFolder,
  isStreaming = false,
  workingFolder,
  hideWorkingFolderIndicator = false,
  hideWorkingFolderPicker = false,
  disabled = false
}: InputAreaProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const chatView = useUIStore((s) => s.chatView)
  const setMode = useUIStore((s) => s.setMode)
  const isSessionComposer = chatView === 'session' || Boolean(sessionId)
  const isHomeComposer = chatView === 'home' || chatView === 'project'
  const minComposerHeight = MIN_INPUT_HEIGHT
  const defaultSessionInputHeight = Math.max(DEFAULT_SESSION_INPUT_HEIGHT, minComposerHeight)
  const [documentNodes, setDocumentNodes] = React.useState<EditorDocumentNode[]>([])
  const [selectedFiles, setSelectedFiles] = React.useState<SelectedFileItem[]>([])
  const [highlightedFileId, setHighlightedFileId] = React.useState<string | null>(null)
  const [editorSelection, setEditorSelection] = React.useState({ start: 0, end: 0 })
  const text = React.useMemo(
    () => editorDocumentToPlainText(documentNodes, selectedFiles),
    [documentNodes, selectedFiles]
  )
  const finalSerializedText = React.useMemo(
    () => serializeEditorDocument(documentNodes, selectedFiles),
    [documentNodes, selectedFiles]
  )
  const debouncedTokens = useDebouncedTokens(finalSerializedText)
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
  const editorRef = React.useRef<FileAwareEditorHandle | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const queueFileInputRef = React.useRef<HTMLInputElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const [inputHeight, setInputHeight] = React.useState<number | null>(() =>
    isSessionComposer ? defaultSessionInputHeight : null
  )
  const [autoInputHeight, setAutoInputHeight] = React.useState<number>(() => minComposerHeight)
  const dragRef = React.useRef<{
    startY: number
    startH: number
    minH: number
    maxH: number
  } | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const imagePreviewRef = React.useRef<HTMLDivElement>(null)
  const bottomToolbarRef = React.useRef<HTMLDivElement>(null)
  const textRef = React.useRef(text)
  const documentRef = React.useRef(documentNodes)
  const selectedFilesRef = React.useRef(selectedFiles)

  const getMaxInputHeight = React.useCallback(() => {
    const container = containerRef.current
    if (!container) {
      return Math.max(
        minComposerHeight,
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
      return Math.max(minComposerHeight, Math.min(MAX_INPUT_HEIGHT, Math.floor(dynamicMax)))
    }
    return Math.max(
      minComposerHeight,
      Math.min(MAX_INPUT_HEIGHT, Math.floor(window.innerHeight * FALLBACK_MAX_VIEWPORT_RATIO))
    )
  }, [minComposerHeight])
  const [autoMaxInputHeight, setAutoMaxInputHeight] = React.useState(() =>
    Math.max(
      MIN_INPUT_HEIGHT,
      Math.min(MAX_INPUT_HEIGHT, Math.floor(window.innerHeight * FALLBACK_MAX_VIEWPORT_RATIO))
    )
  )

  React.useEffect(() => {
    setInputHeight((current) => {
      if (!isSessionComposer) {
        return current === null ? current : null
      }

      return current ?? defaultSessionInputHeight
    })
  }, [defaultSessionInputHeight, isSessionComposer])

  const getMinInputHeight = React.useCallback(() => {
    const container = containerRef.current
    const editorMetrics = editorRef.current?.getScrollMetrics()
    const imagePreviewHeight = imagePreviewRef.current?.offsetHeight ?? 0
    const bottomToolbarHeight = bottomToolbarRef.current?.offsetHeight ?? 0
    const explicitChromeHeight = imagePreviewHeight + bottomToolbarHeight + 28

    if (!container || !editorMetrics) {
      return Math.max(minComposerHeight, explicitChromeHeight + EDITOR_MIN_HEIGHT)
    }

    const chromeHeight = Math.max(0, container.offsetHeight - editorMetrics.clientHeight)
    return Math.max(
      minComposerHeight,
      Math.ceil(Math.max(chromeHeight, explicitChromeHeight) + EDITOR_MIN_HEIGHT)
    )
  }, [minComposerHeight])

  React.useEffect(() => {
    const updateAutoMaxInputHeight = (): void => {
      setAutoMaxInputHeight(getMaxInputHeight())
    }

    updateAutoMaxInputHeight()

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            updateAutoMaxInputHeight()
          })
    const container = containerRef.current
    const root = rootRef.current
    const messageListEl = root?.parentElement?.querySelector(
      '[data-message-list]'
    ) as HTMLElement | null

    if (observer && container) {
      observer.observe(container)
    }
    if (observer && messageListEl) {
      observer.observe(messageListEl)
    }

    window.addEventListener('resize', updateAutoMaxInputHeight)
    return () => {
      window.removeEventListener('resize', updateAutoMaxInputHeight)
      observer?.disconnect()
    }
  }, [getMaxInputHeight])

  React.useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY
      const newH = Math.min(
        dragRef.current.maxH,
        Math.max(dragRef.current.minH, dragRef.current.startH + delta)
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
    const clampInputHeight = (): void => {
      const minH = getMinInputHeight()
      const maxH = Math.max(minH, getMaxInputHeight())
      setInputHeight((prev) => {
        if (prev === null) return prev
        return Math.min(Math.max(prev, minH), maxH)
      })
    }
    clampInputHeight()
    window.addEventListener('resize', clampInputHeight)
    return () => window.removeEventListener('resize', clampInputHeight)
  }, [getMaxInputHeight, getMinInputHeight, inputHeight])

  const handleDragStart = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const el = containerRef.current
      if (!el) return
      const minH = getMinInputHeight()
      dragRef.current = {
        startY: e.clientY,
        startH: el.offsetHeight,
        minH,
        maxH: Math.max(minH, getMaxInputHeight())
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [getMaxInputHeight, getMinInputHeight]
  )
  const activeProvider = useProviderStore(
    useShallow((s) => {
      const { providers, activeProviderId } = s
      if (!activeProviderId) return null
      const p = providers.find((p) => p.id === activeProviderId)
      if (!p) return null
      return { apiKey: p.apiKey, requiresApiKey: p.requiresApiKey, type: p.type, models: p.models }
    })
  )
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const supportsVision = React.useMemo(() => {
    if (!activeProvider) return false
    const model = activeProvider.models.find((m) => m.id === activeModelId)
    return modelSupportsVision(model, activeProvider.type)
  }, [activeProvider, activeModelId])
  const webSearchEnabled = useSettingsStore((s) => s.webSearchEnabled)
  const webSearchProvider = useSettingsStore((s) => s.webSearchProvider)
  const webSearchApiKey = useSettingsStore((s) => s.webSearchApiKey)
  const webSearchRequiresApiKey = [
    'tavily',
    'searxng',
    'exa',
    'exa-mcp',
    'bocha',
    'zhipu'
  ].includes(webSearchProvider)
  const canToggleWebSearch = !webSearchRequiresApiKey || Boolean(webSearchApiKey)
  const toggleWebSearch = React.useCallback(() => {
    const store = useSettingsStore.getState()
    const newEnabled = !store.webSearchEnabled
    useSettingsStore.getState().updateSettings({ webSearchEnabled: newEnabled })
    updateWebSearchToolRegistration(newEnabled)
  }, [])
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const openFilePreview = useUIStore((s) => s.openFilePreview)
  const mode = useUIStore((s) => s.mode)
  // Only select fields actually used — avoids re-renders on every streaming message delta
  const targetSession = useChatStore(
    useShallow((s) => {
      const targetSessionId = sessionId ?? s.activeSessionId
      const idx = targetSessionId ? s.sessionsById[targetSessionId] : undefined
      const session = idx !== undefined ? s.sessions[idx] : undefined
      if (!session) return undefined
      return { projectId: session.projectId } as Pick<
        import('@renderer/stores/chat-store').Session,
        'projectId'
      >
    })
  )
  const activeProjectId = useChatStore((s) => {
    const targetSessionId = sessionId ?? s.activeSessionId
    const idx = targetSessionId ? s.sessionsById[targetSessionId] : undefined
    const targetSession = idx !== undefined ? s.sessions[idx] : undefined
    return targetSession?.projectId ?? s.activeProjectId
  })
  const activeSshConnectionId = useChatStore((s) => {
    const targetSessionId = sessionId ?? s.activeSessionId
    const idx = targetSessionId ? s.sessionsById[targetSessionId] : undefined
    const targetSession = idx !== undefined ? s.sessions[idx] : undefined
    const projectId = targetSession?.projectId ?? s.activeProjectId
    const activeProject = projectId
      ? s.projects.find((project) => project.id === projectId)
      : undefined
    return targetSession?.sshConnectionId ?? activeProject?.sshConnectionId ?? null
  })
  const [homeLongRunningMode, setHomeLongRunningMode] = useLocalState(false)
  const showInlineClearConversation = false
  const {
    activeSessionId,
    hasMessages,
    clearSessionMessages,
    longRunningMode,
    setSessionLongRunningMode,
    updateSessionMode
  } = useChatStore(
    useShallow((s) => {
      const targetSessionId = sessionId ?? s.activeSessionId
      const idx = targetSessionId ? s.sessionsById[targetSessionId] : undefined
      const targetSession = idx !== undefined ? s.sessions[idx] : undefined
      return {
        activeSessionId: targetSessionId,
        hasMessages: (targetSession?.messageCount ?? 0) > 0,
        clearSessionMessages: s.clearSessionMessages,
        longRunningMode: targetSession?.longRunningMode ?? false,
        setSessionLongRunningMode: s.setSessionLongRunningMode,
        updateSessionMode: s.updateSessionMode
      }
    })
  )
  // Stable getter — reads messages lazily so streaming deltas don't re-render InputArea
  const getSessionMessages = React.useCallback(
    () => useChatStore.getState().getSessionMessages(activeSessionId ?? ''),
    [activeSessionId]
  )
  const draftSessionId = sessionId ?? (chatView === 'session' ? activeSessionId : null)
  const projectScoped = isProjectSession({
    chatView,
    session: targetSession,
    activeProjectId,
    workingFolder
  })
  const workspaceReady = workspaceContextAvailable({
    chatView,
    session: targetSession,
    activeProjectId,
    workingFolder
  })
  const activeDraftKey = React.useMemo(
    () => (draftSessionId ? getSessionInputDraftKey(draftSessionId) : null),
    [draftSessionId]
  )
  const inputDraftHydrated = useInputDraftStore((s) => s.hydrated)
  const persistedDraft = useInputDraftStore(
    React.useCallback(
      (state) => (activeDraftKey ? (state.draftsByKey[activeDraftKey] ?? null) : null),
      [activeDraftKey]
    )
  )
  const setPersistedDraft = useInputDraftStore((s) => s.setDraft)
  const removePersistedDraft = useInputDraftStore((s) => s.removeDraft)
  const draftReadyKeyRef = React.useRef<string | null>(null)
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
  const [isWorkspaceAgentsMissing, setIsWorkspaceAgentsMissing] = React.useState(false)

  React.useLayoutEffect(() => {
    if (inputHeight === null) return
    const minH = getMinInputHeight()
    const maxH = Math.max(minH, getMaxInputHeight())
    setInputHeight((prev) => {
      if (prev === null) return prev
      if (prev >= minH && prev <= maxH) return prev
      return Math.min(Math.max(prev, minH), maxH)
    })
  }, [
    attachedImages.length,
    selectedSkill,
    queuedMessages.length,
    isQueueExpanded,
    getMaxInputHeight,
    getMinInputHeight,
    inputHeight
  ])

  const syncAutoInputHeight = React.useCallback(() => {
    if (inputHeight !== null) return
    const container = containerRef.current
    const editorMetrics = editorRef.current?.getScrollMetrics()
    if (!container || !editorMetrics) return

    const chromeHeight = Math.max(0, container.offsetHeight - editorMetrics.clientHeight)
    const minHeight = Math.max(minComposerHeight, Math.ceil(chromeHeight + EDITOR_MIN_HEIGHT))
    const nextHeight = Math.max(
      minHeight,
      Math.min(
        autoMaxInputHeight,
        Math.ceil(chromeHeight + Math.max(EDITOR_MIN_HEIGHT, editorMetrics.scrollHeight))
      )
    )

    setAutoInputHeight((prev) => (prev === nextHeight ? prev : nextHeight))
  }, [autoMaxInputHeight, inputHeight, minComposerHeight])

  React.useLayoutEffect(() => {
    syncAutoInputHeight()
  }, [
    syncAutoInputHeight,
    documentNodes,
    selectedFiles,
    attachedImages.length,
    selectedSkill,
    queuedMessages.length,
    isQueueExpanded
  ])

  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      if (inputHeight === null) {
        syncAutoInputHeight()
        return
      }

      const minH = getMinInputHeight()
      const maxH = Math.max(minH, getMaxInputHeight())
      setInputHeight((prev) => {
        if (prev === null) return prev
        return Math.min(Math.max(prev, minH), maxH)
      })
    })

    const container = containerRef.current
    const imagePreview = imagePreviewRef.current
    const bottomToolbar = bottomToolbarRef.current

    if (container) observer.observe(container)
    if (imagePreview) observer.observe(imagePreview)
    if (bottomToolbar) observer.observe(bottomToolbar)

    return () => {
      observer.disconnect()
    }
  }, [getMaxInputHeight, getMinInputHeight, inputHeight, syncAutoInputHeight])

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

  const getPastedImageFiles = React.useCallback(
    (clipboardData: DataTransfer | null | undefined): File[] => {
      if (!supportsVision || !clipboardData) return []
      return Array.from(clipboardData.items)
        .filter((item) => item.kind === 'file' && ACCEPTED_IMAGE_TYPES.includes(item.type))
        .map((item) => item.getAsFile())
        .filter(Boolean) as File[]
    },
    [supportsVision]
  )

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

  React.useEffect(() => {
    textRef.current = text
  }, [text])
  React.useEffect(() => {
    documentRef.current = documentNodes
  }, [documentNodes])
  React.useEffect(() => {
    selectedFilesRef.current = selectedFiles
  }, [selectedFiles])

  React.useEffect(() => {
    if (!highlightedFileId) return
    const timer = window.setTimeout(() => {
      setHighlightedFileId((current) => (current === highlightedFileId ? null : current))
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [highlightedFileId])

  const applyEditorStateFromSerializedText = React.useCallback(
    (nextText: string, baseFiles: SelectedFileItem[] = selectedFilesRef.current) => {
      const nextState = deserializeEditorState(nextText, workingFolder, baseFiles)
      setDocumentNodes(nextState.document)
      setSelectedFiles(nextState.selectedFiles)
    },
    [workingFolder]
  )

  const setText = React.useCallback(
    (value: string | ((prev: string) => string)) => {
      const previousText = textRef.current
      const nextText = typeof value === 'function' ? value(previousText) : value
      applyEditorStateFromSerializedText(nextText, selectedFilesRef.current)
    },
    [applyEditorStateFromSerializedText]
  )

  const focusInputAtEnd = React.useCallback(() => {
    editorRef.current?.focusAtEnd()
  }, [])

  const hasFileReferences = React.useMemo(() => selectedFiles.length > 0, [selectedFiles])

  const replaceSelectionWithText = React.useCallback(
    (
      replacement: string,
      selection: { start: number; end: number } = editorSelection,
      cursorOffset = 0,
      nextSelectedFiles?: SelectedFileItem[]
    ) => {
      const replacementState = deserializeEditorState(
        replacement,
        workingFolder,
        nextSelectedFiles ?? selectedFilesRef.current
      )
      const candidateFiles = mergeSelectedFiles(
        nextSelectedFiles ?? selectedFilesRef.current,
        replacementState.selectedFiles
      )
      const nextDocument = replaceEditorRange(
        documentRef.current,
        selectedFilesRef.current,
        selection.start,
        selection.end,
        replacementState.document
      )
      const referencedFileIds = new Set(
        nextDocument
          .filter(
            (node): node is Extract<EditorDocumentNode, { type: 'file' }> => node.type === 'file'
          )
          .map((node) => node.fileId)
      )
      const nextFiles = candidateFiles.filter((file) => referencedFileIds.has(file.id))
      const nextCursor =
        selection.start +
        editorDocumentToPlainText(replacementState.document, candidateFiles).length +
        cursorOffset

      setDocumentNodes(nextDocument)
      setSelectedFiles(nextFiles)
      requestAnimationFrame(() => {
        editorRef.current?.focus()
        editorRef.current?.setSelectionOffsets(nextCursor, nextCursor)
        setEditorSelection({ start: nextCursor, end: nextCursor })
      })
    },
    [editorSelection, workingFolder]
  )

  const shouldRecommendInit = workspaceReady && !activeSshConnectionId && isWorkspaceAgentsMissing
  const recommendationFallback = shouldRecommendInit
    ? t('input.recommendationInitWorkspace')
    : t(defaultRecommendationKeys[mode])
  const shouldAutoAcceptRecommendation =
    mode === 'clarify' && clarifyAutoAcceptRecommended && !disabled && !isOptimizing && !isStreaming
  const getCaretAtEnd = React.useCallback(() => {
    return editorSelection.start === editorSelection.end && editorSelection.end === text.length
  }, [editorSelection.end, editorSelection.start, text.length])
  const {
    suggestionText,
    effectivePlaceholder,
    acceptSuggestion,
    cancelPendingRequest: cancelPromptRecommendation,
    handleFocus: handleRecommendationFocus,
    handleBlur: handleRecommendationBlur,
    handleSelectionChange: handleRecommendationSelectionChange,
    handleCompositionStart: handleRecommendationCompositionStart,
    handleCompositionEnd: handleRecommendationCompositionEnd
  } = usePromptRecommendation({
    mode,
    sessionId: activeSessionId,
    text,
    getRecentMessages: getSessionMessages,
    selectedSkill,
    images: attachedImages,
    disabled: disabled || isOptimizing,
    isStreaming,
    fallbackSuggestion: recommendationFallback,
    getCaretAtEnd
  })
  const activeFileMention = React.useMemo(() => {
    if (editorSelection.start === editorSelection.end) {
      const selectionMention = getSelectFileMentionQuery(text, editorSelection.end)
      if (selectionMention) return selectionMention
    }

    return getSelectFileMentionQuery(text, text.length)
  }, [editorSelection.end, editorSelection.start, text])
  const fileQuery = activeFileMention?.query.trim() ?? ''
  const fileMenuOpen = projectScoped && Boolean(activeFileMention)
  const slashQuery = React.useMemo(() => getSlashCommandQuery(text), [text])
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
    if (!fileMenuOpen) {
      setFileSearchResults([])
      setFileSearchLoading(false)
      return
    }

    if (!workingFolder) {
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
      setSelectedSkill(null)

      const { files: nextFiles, file } = ensureSelectedFile(
        selectedFilesRef.current,
        filePath,
        workingFolder
      )
      if (!file) return

      const mention = activeFileMention ?? {
        start: editorSelection.start,
        end: editorSelection.end
      }
      const suffix =
        text.slice(mention.end).startsWith(' ') ||
        text.slice(mention.end).startsWith('\n') ||
        mention.end >= text.length
          ? ''
          : ' '

      replaceSelectionWithText(
        `${createSelectFileToken(file.sendPath)}${suffix}`,
        mention,
        0,
        nextFiles
      )
    },
    [
      activeFileMention,
      editorSelection.end,
      editorSelection.start,
      replaceSelectionWithText,
      text,
      workingFolder
    ]
  )

  const insertSlashCommand = React.useCallback(
    (commandName: string) => {
      setSelectedSkill(null)
      applyEditorStateFromSerializedText(`/${commandName} `, selectedFiles)
      requestAnimationFrame(() => {
        focusInputAtEnd()
      })
    },
    [applyEditorStateFromSerializedText, focusInputAtEnd, selectedFiles]
  )
  const hasApiKey = !!activeProvider?.apiKey || activeProvider?.requiresApiKey === false
  const needsWorkingFolder = projectScoped && !workingFolder
  const planMode = useUIStore((s) =>
    draftSessionId ? Boolean(s.planModesBySession[draftSessionId]) : false
  )
  const pendingReviewPlanId = usePlanStore((s) =>
    draftSessionId ? (s.getPendingReviewPlan(draftSessionId)?.id ?? null) : null
  )

  React.useEffect(() => {
    let cancelled = false

    if (!workspaceReady || activeSshConnectionId) {
      setIsWorkspaceAgentsMissing(false)
      return
    }

    setIsWorkspaceAgentsMissing(false)

    void resolveProjectMemoryTextFile(ipcClient, workingFolder ?? '', 'AGENTS.md').then(
      ({ missingFile }) => {
        if (cancelled) return
        setIsWorkspaceAgentsMissing(missingFile)
      }
    )

    return () => {
      cancelled = true
    }
  }, [activeSshConnectionId, workspaceReady, workingFolder])

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
    if (!inputDraftHydrated) return

    const persistedText = persistedDraft?.text ?? ''
    const persistedSelectedFiles = persistedDraft?.selectedFiles ?? []
    const shouldResetHomeReferenceDraft =
      isHomeComposer &&
      !persistedDraft?.skill &&
      (persistedDraft?.images?.length ?? 0) === 0 &&
      isReferenceOnlyDocument(
        deserializeEditorState(persistedText, workingFolder, persistedSelectedFiles).document
      )

    draftReadyKeyRef.current = null
    applyEditorStateFromSerializedText(
      shouldResetHomeReferenceDraft ? '' : persistedText,
      shouldResetHomeReferenceDraft ? [] : persistedSelectedFiles
    )
    setAttachedImages(persistedDraft?.images ? cloneImageAttachments(persistedDraft.images) : [])
    setSelectedSkill(persistedDraft?.skill ?? null)
    setHighlightedFileId(null)
    setEditorSelection({ start: 0, end: 0 })

    const rafId = window.requestAnimationFrame(() => {
      draftReadyKeyRef.current = activeDraftKey
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [
    activeDraftKey,
    applyEditorStateFromSerializedText,
    inputDraftHydrated,
    isHomeComposer,
    persistedDraft,
    workingFolder
  ])

  React.useEffect(() => {
    if (!activeDraftKey || !inputDraftHydrated) return
    if (draftReadyKeyRef.current !== activeDraftKey) return

    clearTimeout(draftSaveTimerRef.current)
    draftSaveTimerRef.current = setTimeout(() => {
      const nextDraft = {
        text: finalSerializedText,
        images: cloneImageAttachments(attachedImages),
        skill: selectedSkill,
        selectedFiles: selectedFiles.map((file) => ({ ...file }))
      }

      if (hasInputDraftContent(nextDraft)) {
        setPersistedDraft(activeDraftKey, nextDraft)
        return
      }

      removePersistedDraft(activeDraftKey)
    }, 400)

    return () => clearTimeout(draftSaveTimerRef.current)
  }, [
    activeDraftKey,
    attachedImages,
    finalSerializedText,
    inputDraftHydrated,
    removePersistedDraft,
    selectedFiles,
    selectedSkill,
    setPersistedDraft
  ])

  // Consume pendingInsertText from FileTree clicks
  const pendingInsert = useUIStore((s) => s.pendingInsertText)
  React.useEffect(() => {
    if (!pendingInsert) return

    const selection = editorRef.current?.getSelectionOffsets() ?? {
      start: text.length,
      end: text.length
    }
    const pendingPlainText = selectFileTextToPlainText(pendingInsert)
    const needsPrefix =
      selection.start === selection.end &&
      selection.start > 0 &&
      !/\s$/.test(text.slice(0, selection.start)) &&
      pendingPlainText.length > 0 &&
      !/^\s/.test(pendingPlainText)

    replaceSelectionWithText(`${needsPrefix ? ' ' : ''}${pendingInsert}`, selection)
    useUIStore.getState().setPendingInsertText(null)
  }, [pendingInsert, replaceSelectionWithText, text])

  // --- Image helpers ---
  const addImages = React.useCallback(async (files: File[]) => {
    const results = await Promise.all(files.map(fileToImageAttachment))
    const valid = results.filter(Boolean) as ImageAttachment[]
    if (valid.length > 0) {
      setAttachedImages((prev) => [...prev, ...valid])
    }
  }, [])

  const removeImage = React.useCallback((id: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id))
  }, [])

  const addFilesToEditor = React.useCallback(
    (filePaths: string[], selection?: { start: number; end: number }) => {
      const nextSelection = selection ??
        editorRef.current?.getSelectionOffsets() ?? {
          start: editorSelection.start,
          end: editorSelection.end
        }
      const filesToInsert: SelectedFileItem[] = []
      let mergedFiles = selectedFilesRef.current

      for (const filePath of filePaths) {
        const ensured = ensureSelectedFile(mergedFiles, filePath, workingFolder)
        mergedFiles = ensured.files
        if (ensured.file) {
          filesToInsert.push(ensured.file)
        }
      }

      if (filesToInsert.length === 0) return

      const replacement = filesToInsert
        .map((file) => createSelectFileToken(file.sendPath))
        .filter(Boolean)
        .join('\n')

      replaceSelectionWithText(replacement, nextSelection, 0, mergedFiles)
    },
    [editorSelection.end, editorSelection.start, replaceSelectionWithText, workingFolder]
  )

  const handlePreviewFile = React.useCallback(
    (fileId: string) => {
      const file = selectedFilesRef.current.find((item) => item.id === fileId)
      if (file) {
        openFilePreview(file.previewPath)
      }
    },
    [openFilePreview]
  )

  const handleLocateFileReference = React.useCallback((fileId: string) => {
    setHighlightedFileId(fileId)
    editorRef.current?.scrollToReference(fileId)
    editorRef.current?.focus()
  }, [])

  const handleEditorSelectionChange = React.useCallback(
    (selection: { start: number; end: number }) => {
      setEditorSelection((current) =>
        current.start === selection.start && current.end === selection.end ? current : selection
      )
      handleRecommendationSelectionChange()
    },
    [handleRecommendationSelectionChange]
  )

  const handleRemoveFileReference = React.useCallback((nodeId: string) => {
    const currentDocument = documentRef.current
    const targetNode = currentDocument.find(
      (node): node is Extract<EditorDocumentNode, { type: 'file' }> =>
        node.type === 'file' && node.id === nodeId
    )
    if (!targetNode) return

    const nextDocument = removeReferenceNode(currentDocument, nodeId, selectedFilesRef.current)
    const hasRemainingReferences = documentHasFileReferences(nextDocument, targetNode.fileId)
    const nextFiles = hasRemainingReferences
      ? selectedFilesRef.current
      : selectedFilesRef.current.filter((file) => file.id !== targetNode.fileId)

    setDocumentNodes(nextDocument)
    setSelectedFiles(nextFiles)
  }, [])

  const handleEditorDocumentChange = React.useCallback((nextDocument: EditorDocumentNode[]) => {
    const referencedFileIds = new Set(
      nextDocument
        .filter(
          (node): node is Extract<EditorDocumentNode, { type: 'file' }> => node.type === 'file'
        )
        .map((node) => node.fileId)
    )
    setDocumentNodes(nextDocument)
    setSelectedFiles((currentFiles) =>
      currentFiles.filter((file) => referencedFileIds.has(file.id))
    )
  }, [])

  const effectiveLongRunningMode = activeSessionId ? longRunningMode : homeLongRunningMode
  const showAllComposerModesForNewSession = !draftSessionId && Boolean(activeProjectId)
  const availableComposerModes = React.useMemo(() => {
    if (showAllComposerModesForNewSession) {
      return composerModeOptions
    }
    return projectScoped
      ? composerModeOptions.filter((option) => option.value !== 'chat')
      : composerModeOptions.filter((option) => option.value === 'chat')
  }, [projectScoped, showAllComposerModesForNewSession])
  const showModeSwitchControl = availableComposerModes.length > 1
  const activeComposerMode =
    availableComposerModes.find((option) => option.value === mode) ??
    availableComposerModes[0] ??
    composerModeOptions[0]!
  const handleModeSwitch = React.useCallback(
    (nextMode: AppMode) => {
      setMode(nextMode)
      if (draftSessionId) {
        updateSessionMode(draftSessionId, nextMode)
      }
    },
    [draftSessionId, setMode, updateSessionMode]
  )

  const handleToggleLongRunningMode = React.useCallback(() => {
    if (activeSessionId) {
      setSessionLongRunningMode(activeSessionId, !longRunningMode)
      return
    }
    setHomeLongRunningMode((current) => !current)
  }, [activeSessionId, longRunningMode, setHomeLongRunningMode, setSessionLongRunningMode])

  const getLiveEditorState = React.useCallback(() => {
    const liveDocument = editorRef.current?.getDocumentSnapshot() ?? documentRef.current
    const referencedFileIds = new Set(
      liveDocument
        .filter(
          (node): node is Extract<EditorDocumentNode, { type: 'file' }> => node.type === 'file'
        )
        .map((node) => node.fileId)
    )
    const liveSelectedFiles = selectedFilesRef.current.filter((file) =>
      referencedFileIds.has(file.id)
    )

    return {
      plainText: editorDocumentToPlainText(liveDocument, liveSelectedFiles),
      serializedText: serializeEditorDocument(liveDocument, liveSelectedFiles)
    }
  }, [])

  const handleSend = React.useCallback((): void => {
    const liveEditorState = getLiveEditorState()
    const serialized = liveEditorState.serializedText.trim()
    if (!serialized && attachedImages.length === 0) return
    if (disabled || needsWorkingFolder) return

    cancelPromptRecommendation()

    const hasLeadingSlashCommand = liveEditorState.plainText.trimStart().startsWith('/')
    const message =
      selectedSkill && !hasLeadingSlashCommand
        ? `[Skill: ${selectedSkill}]\n${serialized}`
        : serialized

    onSend(message, attachedImages.length > 0 ? attachedImages : undefined, {
      longRunningMode: effectiveLongRunningMode,
      clearCompletedTasksOnTurnStart: true
    })

    if (activeDraftKey) {
      removePersistedDraft(activeDraftKey)
    }

    setDocumentNodes([])
    setSelectedFiles([])
    setHighlightedFileId(null)
    setEditorSelection({ start: 0, end: 0 })
    setAttachedImages([])
    setSelectedSkill(null)
    requestAnimationFrame(() => {
      editorRef.current?.setSelectionOffsets(0, 0)
    })
  }, [
    getLiveEditorState,
    attachedImages,
    disabled,
    needsWorkingFolder,
    cancelPromptRecommendation,
    selectedSkill,
    onSend,
    effectiveLongRunningMode,
    activeDraftKey,
    removePersistedDraft
  ])

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.nativeEvent.isComposing || isOptimizing) return

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
          editorRef.current?.focus()
          editorRef.current?.setSelectionOffsets(nextCursor, nextCursor)
          setEditorSelection({ start: nextCursor, end: nextCursor })
          handleRecommendationSelectionChange()
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
          applyEditorStateFromSerializedText(acceptedSuggestion, selectedFiles)
          requestAnimationFrame(() => {
            focusInputAtEnd()
            handleRecommendationSelectionChange()
          })
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [
      isOptimizing,
      fileMenuOpen,
      slashMenuOpen,
      fileSearchResults,
      selectedFileSearchIndex,
      filteredSlashCommands,
      selectedSlashIndex,
      activeFileMention,
      insertSelectedFile,
      insertSlashCommand,
      acceptSuggestion,
      applyEditorStateFromSerializedText,
      selectedFiles,
      focusInputAtEnd,
      handleRecommendationSelectionChange,
      handleSend
    ]
  )

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>): void => {
      const imageFiles = getPastedImageFiles(e.clipboardData)

      if (imageFiles.length > 0) {
        e.preventDefault()
        void addImages(imageFiles)
        return
      }

      const plainText = e.clipboardData.getData('text/plain')
      if (!plainText) return

      e.preventDefault()
      const selection = editorRef.current?.getSelectionOffsets() ?? editorSelection
      replaceSelectionWithText(plainText, selection)
    },
    [addImages, editorSelection, getPastedImageFiles, replaceSelectionWithText]
  )

  const handleQueueEditPaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
      const imageFiles = getPastedImageFiles(e.clipboardData)
      if (imageFiles.length === 0) return
      e.preventDefault()
      void addQueuedImages(imageFiles)
    },
    [addQueuedImages, getPastedImageFiles]
  )

  const getDraggedFilePaths = React.useCallback((dataTransfer: DataTransfer | null): string[] => {
    if (!dataTransfer) return []
    const payload = dataTransfer.getData(INTERNAL_FILE_DRAG_MIME)
    if (!payload) return []

    try {
      const parsed = JSON.parse(payload)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    } catch {
      return []
    }
  }, [])

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

  const handleDragOver = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      const transfer = e.dataTransfer
      const types = Array.from(transfer?.types ?? [])
      const canHandle = types.includes('Files') || types.includes(INTERNAL_FILE_DRAG_MIME)
      if (!canHandle) return
      e.preventDefault()
      if (transfer) {
        transfer.dropEffect = 'copy'
      }
      setDragging(true)
    },
    [setDragging]
  )

  const handleDragLeave = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      const nextTarget = e.relatedTarget as Node | null
      if (nextTarget && e.currentTarget.contains(nextTarget)) return
      setDragging(false)
    },
    [setDragging]
  )

  const handleDropWrapped = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      const draggedPaths = getDraggedFilePaths(e.dataTransfer)
      const hasNativeFiles = (e.dataTransfer?.files?.length ?? 0) > 0
      if (draggedPaths.length === 0 && !hasNativeFiles) return
      e.preventDefault()
      setDragging(false)
      if (draggedPaths.length > 0) {
        addFilesToEditor(draggedPaths)
        return
      }
      handleDropFiles(e.dataTransfer?.files ?? null)
    },
    [addFilesToEditor, getDraggedFilePaths, handleDropFiles, setDragging]
  )

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

  const composerVariant = 'session'
  const composerIconControlClass = 'composer-control rounded-xl'
  const composerTextControlClass = 'composer-control rounded-xl text-[11px] shadow-none'

  const modeSwitchControl = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-tour="mode-switch"
          className={cn('gap-1.5 px-2.5', composerTextControlClass)}
          disabled={disabled || isStreaming}
        >
          {activeComposerMode.icon}
          <span>{activeComposerMode.label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="composer-flyout w-40">
        {availableComposerModes.map((option) => {
          const active = mode === option.value
          return (
            <DropdownMenuItem
              key={option.value}
              className={cn(
                'gap-2',
                active &&
                  'bg-accent text-accent-foreground focus:bg-accent focus:text-accent-foreground'
              )}
              onSelect={() => handleModeSwitch(option.value)}
            >
              {option.icon}
              <span>{option.label}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const webSearchToggleControl = canToggleWebSearch && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
          data-active={webSearchEnabled ? 'true' : 'false'}
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
  )

  const skillsMenuControl = (
    <SkillsMenu
      onSelectSkill={(name) => {
        setSelectedSkill(name)
        editorRef.current?.focus()
      }}
      onSelectCommand={(name) => {
        insertSlashCommand(name)
      }}
      onAttachMedia={() => {
        fileInputRef.current?.click()
      }}
      disabled={disabled || isStreaming}
      projectId={activeProjectId}
      showChannels={mode !== 'chat'}
      triggerClassName={composerIconControlClass}
      menuClassName="composer-flyout"
    />
  )

  const activeMcpBadge = <ActiveMcpsBadge projectId={activeProjectId} />

  const longRunningControl = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
          data-active={effectiveLongRunningMode ? 'true' : 'false'}
          onClick={handleToggleLongRunningMode}
          disabled={disabled || isStreaming}
        >
          <Sparkles className="size-4" fill={effectiveLongRunningMode ? 'currentColor' : 'none'} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {effectiveLongRunningMode
          ? t('input.longRunningModeOn', { defaultValue: '长时间运行模式：开启' })
          : t('input.longRunningModeOff', { defaultValue: '长时间运行模式：关闭' })}
      </TooltipContent>
    </Tooltip>
  )

  const folderControl = onSelectFolder && !hideWorkingFolderPicker && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
          onClick={onSelectFolder}
        >
          <FolderOpen className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('input.selectFolder')}</TooltipContent>
    </Tooltip>
  )

  const stopControl = isStreaming && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
          data-tone="warning"
          onClick={onStop}
        >
          <Spinner className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('input.stopTooltip')}</TooltipContent>
    </Tooltip>
  )

  const optimizeControl = !isStreaming && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={composerIconControlClass}
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
  )

  const sendControl = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="default"
          className="composer-send rounded-xl px-3.5 transition-[filter,box-shadow] duration-200"
          data-composer-variant={composerVariant}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={handleSend}
          disabled={
            (!finalSerializedText.trim() && attachedImages.length === 0) ||
            disabled ||
            needsWorkingFolder ||
            isOptimizing
          }
        >
          <>
            <span>{t('action.start', { ns: 'common' })}</span>
            <Send className="ml-1.5 size-3.5" />
          </>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isStreaming
          ? t('input.sendTooltipWhileRunning', { defaultValue: 'Send after current run' })
          : t('input.sendTooltip')}
      </TooltipContent>
    </Tooltip>
  )

  return (
    <div ref={rootRef} data-tour="composer" className="px-4 py-3 pb-4">
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
      {planMode && projectScoped && (
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
            onClick={() => useUIStore.getState().exitPlanMode(draftSessionId)}
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

      <div className="mx-auto w-full max-w-[820px]">
        {projectScoped && draftSessionId && <InlineStepsPanel sessionId={draftSessionId} />}
        <div
          ref={containerRef}
          className={cn(
            'composer-shell relative flex flex-col transition-[box-shadow,border-color] duration-200',
            fileMenuOpen || slashMenuOpen ? 'overflow-visible' : 'overflow-hidden',
            dragging && 'ring-2 ring-primary/50'
          )}
          data-composer-variant={composerVariant}
          style={
            inputHeight !== null
              ? { height: inputHeight }
              : { height: autoInputHeight, maxHeight: autoMaxInputHeight }
          }
        >
          {/* Top drag handle */}
          {isSessionComposer && (
            <div
              className="composer-drag-handle flex h-3 cursor-row-resize items-center justify-center"
              onMouseDown={handleDragStart}
            >
              <div className="composer-drag-grip h-1 w-11 rounded-full" />
            </div>
          )}
          {/* Queued message list */}
          {queuedMessages.length > 0 && (
            <div className="shrink-0 px-3 pt-3 pb-1">
              <div className="composer-panel overflow-hidden rounded-[18px]">
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
                    <span className="composer-status-pill rounded-full px-1.5 py-0.5 text-[10px]">
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
                        className="composer-control rounded-lg px-2 text-[10px]"
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
                      className="composer-control rounded-lg px-2 text-[10px]"
                      data-tone="danger"
                      onClick={handleClearQueuedMessages}
                    >
                      <Trash2 className="size-3" />
                      {t('action.clear', { ns: 'common' })}
                    </Button>
                  </div>
                </div>

                {isQueueExpanded && (
                  <div className="border-t border-[var(--composer-toolbar-border)] px-3 py-2">
                    <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                      {queuedMessages.map((msg) => {
                        const isEditing = editingQueueItemId === msg.id
                        const summaryText = summarizeQueuedMessage(msg.text)
                        const commandLabel = msg.command ? `/${msg.command.name}` : ''
                        return (
                          <div key={msg.id} className="composer-cardlet rounded-[14px] px-3 py-2">
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
                                      className="composer-control rounded-md px-2 text-[10px]"
                                      onClick={() => saveQueuedMessage(msg.id)}
                                    >
                                      {t('action.save', { ns: 'common' })}
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="composer-control rounded-md px-2 text-[10px]"
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
                                  onPaste={handleQueueEditPaste}
                                  className="composer-aux-textarea min-h-[56px] max-h-36 resize-none text-xs"
                                  rows={2}
                                />
                                {editingQueueImages.length > 0 && (
                                  <div className="flex gap-2 overflow-x-auto pb-1">
                                    {editingQueueImages.map((img) => (
                                      <div key={img.id} className="relative group/img shrink-0">
                                        <img
                                          src={img.dataUrl}
                                          alt=""
                                          className="composer-image-thumb size-12 rounded-lg object-cover"
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
                                      variant="ghost"
                                      size="sm"
                                      className="composer-control rounded-md px-2 text-[10px]"
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
                                      <span className="composer-status-pill rounded-full px-1.5 py-0.5 text-[10px]">
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
                                    className="composer-control size-7 rounded-md p-0"
                                    onClick={() => startEditQueuedMessage(msg)}
                                    title={t('action.edit', { ns: 'common', defaultValue: '编辑' })}
                                  >
                                    <Pencil className="size-3.5" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="composer-control size-7 rounded-md p-0"
                                    data-tone="danger"
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
            <div className="shrink-0 px-3 pt-3 pb-0">
              <span className="composer-skill-tag inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium">
                <Sparkles className="size-3" />
                {selectedSkill}
                <button
                  type="button"
                  className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => setSelectedSkill(null)}
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          )}

          {/* Image preview strip */}
          {attachedImages.length > 0 && (
            <div
              ref={imagePreviewRef}
              className="shrink-0 flex gap-2 overflow-x-auto px-3 pt-3 pb-1"
            >
              {attachedImages.map((img) => (
                <div key={img.id} className="relative group/img shrink-0">
                  <img
                    src={img.dataUrl}
                    alt=""
                    className="composer-image-thumb size-16 rounded-xl object-cover"
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
            <div className="shrink-0 px-3 pt-3 pb-1">
              <div className="composer-panel rounded-[14px] px-3 py-2">
                <div className="flex items-center gap-2 text-[var(--composer-chip-text)]">
                  <Spinner className="size-3.5" />
                  <span className="text-xs font-semibold">
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
            className={cn(
              'composer-editor-region relative flex min-h-0 flex-1 flex-col px-3',
              selectedSkill || attachedImages.length > 0 ? 'pt-1.5' : 'pt-3'
            )}
            onDrop={handleDropWrapped}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            {dragging && (
              <div className="composer-drop-overlay absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                <span className="flex items-center gap-1.5 text-xs text-primary/70 font-medium">
                  <FileUp className="size-3.5" />
                  {supportsVision ? t('input.dropImages') : t('input.dropFiles')}
                </span>
              </div>
            )}
            <div className="relative flex-1 min-h-0 overflow-visible">
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
                document={documentNodes}
                files={selectedFiles}
                disabled={disabled || isOptimizing}
                placeholder={
                  pendingReviewPlanId
                    ? t('input.placeholderPlanReview', {
                        defaultValue: '输入这份计划的修改建议，或点击上方卡片直接实施计划...'
                      })
                    : (effectivePlaceholder ??
                      (shouldRecommendInit
                        ? t('input.placeholderInitWorkspace')
                        : t(placeholderKeys[mode] ?? 'input.placeholder')))
                }
                suggestionText={suggestionText}
                showSuggestion={Boolean(
                  suggestionText &&
                  text.length > 0 &&
                  !hasFileReferences &&
                  !activeFileMention &&
                  !slashMenuOpen
                )}
                highlightedFileId={highlightedFileId}
                onDocumentChange={handleEditorDocumentChange}
                onSelectionChange={handleEditorSelectionChange}
                onFocus={handleRecommendationFocus}
                onBlur={handleRecommendationBlur}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onCompositionStart={handleRecommendationCompositionStart}
                onCompositionEnd={() => {
                  handleRecommendationCompositionEnd()
                }}
                onReferencePreview={handlePreviewFile}
                onReferenceLocate={handleLocateFileReference}
                onReferenceDelete={handleRemoveFileReference}
                className="h-full w-full"
              />
              {fileMenuOpen && (
                <div className="composer-flyout absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[18px]">
                  <div className="composer-flyout-header flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                    <Command className="size-3.5" />
                    <span>{t('input.fileSuggestions', { defaultValue: '文件建议' })}</span>
                    <span className="composer-status-pill ml-auto rounded-full px-1.5 py-0.5 text-[10px]">
                      @{fileQuery || ''}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1.5">
                    {!workingFolder ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-3 text-left text-xs text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
                        onMouseDown={(event) => {
                          event.preventDefault()
                          onSelectFolder?.()
                        }}
                      >
                        <FolderOpen className="size-3.5 shrink-0" />
                        <span>
                          {t('input.noWorkingFolderSelected', { defaultValue: '请先选择工作目录' })}
                        </span>
                      </button>
                    ) : fileSearchLoading ? (
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
                            onClick={(event) => {
                              event.preventDefault()
                            }}
                          >
                            <FileCode2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
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
                <div className="composer-flyout absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[18px]">
                  <div className="composer-flyout-header flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                    <Command className="size-3.5" />
                    <span>{t('input.commandSuggestions', { defaultValue: '命令建议' })}</span>
                    <span className="composer-status-pill ml-auto rounded-full px-1.5 py-0.5 text-[10px]">
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
            multiple
            className="hidden"
            onChange={(e) => {
              handleDropFiles(e.target.files)
              e.target.value = ''
            }}
          />

          {/* Bottom toolbar */}
          <div
            ref={bottomToolbarRef}
            className="composer-toolbar relative z-20 mt-1 shrink-0 flex items-center justify-between gap-2 px-2 pb-2"
          >
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-1 [scrollbar-width:none]">
                {showModeSwitchControl ? modeSwitchControl : null}
                {showModeSwitchControl ? <div className="h-4 w-px shrink-0 bg-border/50" /> : null}
                <div className="shrink-0">
                  <ModelSwitcher />
                </div>
                {webSearchToggleControl}
                {skillsMenuControl}
                {activeMcpBadge}
                {mode !== 'chat' && longRunningControl}
                {folderControl}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <ContextRing />

                {debouncedTokens > 0 && (
                  <span className="select-none tabular-nums text-[10px] text-muted-foreground/60">
                    {formatTokens(debouncedTokens)} tokens
                  </span>
                )}

                {showInlineClearConversation && hasMessages && !isStreaming && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="composer-control rounded-lg"
                        data-tone="danger"
                        aria-label={t('input.clearConversation')}
                        title={t('input.clearConversation')}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </AlertDialogTrigger>
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

                {stopControl}
                {optimizeControl}
                {sendControl}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
