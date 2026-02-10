import { useState, useRef, useEffect } from 'react'
import { MessageSquare, Briefcase, Code2, Settings, PanelRightOpen, PanelRightClose, Sun, Moon, Keyboard, Loader2, Brain, ChevronDown, Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Separator } from '@renderer/components/ui/separator'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { cn } from '@renderer/lib/utils'
import { useTheme } from 'next-themes'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { WindowControls } from './WindowControls'
import type { ProviderType } from '@renderer/lib/api/types'

const MODEL_PRESETS: Record<ProviderType, string[]> = {
  anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
  'openai-chat': ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o4-mini'],
  'openai-responses': ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o4-mini'],
}

function ModelSwitcher({ model, provider, hasCustomPrompt }: { model: string; provider: ProviderType; hasCustomPrompt: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const presets = MODEL_PRESETS[provider] ?? []
  const shortName = model.split('/').pop()?.replace(/-\d{8}$/, '') ?? model

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="titlebar-no-drag hidden sm:inline-flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors truncate max-w-[160px] rounded px-1 py-0.5 hover:bg-muted/40"
          title={`${model} (click to switch)`}
        >
          {shortName}
          {hasCustomPrompt && <span className="size-1.5 rounded-full bg-violet-400/60 shrink-0" title="Custom system prompt active" />}
          <ChevronDown className="size-2.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="end">
        <div className="text-[10px] text-muted-foreground/50 px-2 py-1 uppercase tracking-wider">{provider}</div>
        {presets.map((m) => (
          <button
            key={m}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors',
              m === model && 'bg-muted/40 font-medium'
            )}
            onClick={() => {
              useSettingsStore.getState().updateSettings({ model: m })
              setOpen(false)
            }}
          >
            {m === model ? <Check className="size-3 text-primary" /> : <span className="size-3" />}
            <span className="truncate">{m.replace(/-\d{8}$/, '')}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

const modes: { value: AppMode; label: string; icon: React.ReactNode }[] = [
  { value: 'chat', label: 'Chat', icon: <MessageSquare className="size-4" /> },
  { value: 'cowork', label: 'Cowork', icon: <Briefcase className="size-4" /> },
  { value: 'code', label: 'Code', icon: <Code2 className="size-4" /> },
]

export function TopBar(): React.JSX.Element {
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen)
  const { theme, setTheme } = useTheme()

  const sessions = useChatStore((s) => s.sessions)
  const model = useSettingsStore((s) => s.model)
  const autoApprove = useSettingsStore((s) => s.autoApprove)
  const hasCustomPrompt = useSettingsStore((s) => !!s.systemPrompt)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const isAgentRunning = useAgentStore((s) => s.isRunning)
  const pendingApprovals = useAgentStore((s) => s.pendingToolCalls).length
  const errorCount = useAgentStore((s) => s.executedToolCalls.filter((t) => t.status === 'error').length)
  const activeSubAgent = useAgentStore((s) => s.activeSubAgent)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const isWorking = !!streamingMessageId || isAgentRunning

  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (isWorking) {
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((v) => v + 1), 1000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isWorking])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const handleStartRename = (): void => {
    if (!activeSession) return
    setEditTitle(activeSession.title)
    setEditing(true)
  }

  const handleSaveTitle = (): void => {
    const trimmed = editTitle.trim()
    if (trimmed && activeSessionId && trimmed !== activeSession?.title) {
      useChatStore.getState().updateSessionTitle(activeSessionId, trimmed)
    }
    setEditing(false)
  }

  const toggleTheme = (): void => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  return (
    <header className="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b bg-background/80 backdrop-blur-md pl-4">
      <SidebarTrigger className="titlebar-no-drag -ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />

      {/* Mode Selector */}
      <div className="titlebar-no-drag flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {modes.map((m, i) => (
          <Tooltip key={m.value}>
            <TooltipTrigger asChild>
              <Button
                variant={mode === m.value ? 'secondary' : 'ghost'}
                size="sm"
                className={cn(
                  'titlebar-no-drag h-6 gap-1.5 rounded-md px-2.5 text-xs font-medium transition-all duration-200',
                  mode === m.value
                    ? 'bg-background shadow-sm ring-1 ring-border/50'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setMode(m.value)}
              >
                {m.icon}
                {m.label}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{m.label} (Ctrl+{i + 1})</TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* Session Title */}
      <div className="flex-1 flex items-center justify-center min-w-0 px-4">
        {activeSession && (
          editing ? (
            <input
              ref={inputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleSaveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveTitle()
                if (e.key === 'Escape') setEditing(false)
              }}
              className="titlebar-no-drag h-6 max-w-[300px] w-full rounded-md border bg-background px-2 text-xs text-center focus:outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <button
              onClick={handleStartRename}
              className="titlebar-no-drag flex items-center gap-2 truncate rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 max-w-[400px]"
              title="Click to rename"
            >
              {isWorking && (
                <>
                  <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />
                  <span className="shrink-0 text-[9px] tabular-nums text-blue-500/70">
                    {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s`}
                  </span>
                </>
              )}
              <span className="truncate font-medium">{activeSession.title}</span>
              {activeSession.mode !== mode && (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground/60 capitalize">
                  {activeSession.mode}
                </span>
              )}
              {activeSession.messages.length > 0 && !isWorking && (
                <span className="shrink-0 text-[10px] text-muted-foreground/40">
                  {activeSession.messages.length}
                </span>
              )}
              {activeSession.workingFolder && (
                <span className="shrink-0 truncate max-w-[100px] text-[9px] text-muted-foreground/30" title={activeSession.workingFolder}>
                  {activeSession.workingFolder.split(/[\\/]/).pop()}
                </span>
              )}
            </button>
          )
        )}
      </div>

      {/* Right Panel Toggle (cowork & code modes) */}
      {mode !== 'chat' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="titlebar-no-drag size-7" onClick={toggleRightPanel}>
              {rightPanelOpen ? (
                <PanelRightClose className="size-4" />
              ) : (
                <PanelRightOpen className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Panel</TooltipContent>
        </Tooltip>
      )}

      {/* Auto-approve warning */}
      {autoApprove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="titlebar-no-drag rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-medium text-destructive cursor-default">
              AUTO
            </span>
          </TooltipTrigger>
          <TooltipContent>Auto-approve is ON — all tools run without confirmation</TooltipContent>
        </Tooltip>
      )}

      {/* Pending approval indicator */}
      {pendingApprovals > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="titlebar-no-drag animate-pulse rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400 cursor-default">
              {pendingApprovals} pending
            </span>
          </TooltipTrigger>
          <TooltipContent>Tool call awaiting approval — press Y to allow, N to deny</TooltipContent>
        </Tooltip>
      )}

      {/* SubAgent indicator */}
      {activeSubAgent?.isRunning && (
        <span className="titlebar-no-drag flex items-center gap-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-500">
          <Brain className="size-3 animate-pulse" />
          {activeSubAgent.name}
        </span>
      )}

      {/* Error count indicator */}
      {errorCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="titlebar-no-drag rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-medium text-destructive cursor-default">
              {errorCount} error{errorCount > 1 ? 's' : ''}
            </span>
          </TooltipTrigger>
          <TooltipContent>{errorCount} tool call{errorCount > 1 ? 's' : ''} failed</TooltipContent>
        </Tooltip>
      )}

      {/* Model quick-switcher */}
      <ModelSwitcher
        model={model}
        provider={useSettingsStore.getState().provider}
        hasCustomPrompt={hasCustomPrompt}
      />

      {/* Theme Toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="titlebar-no-drag size-7" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Toggle Theme</TooltipContent>
      </Tooltip>

      {/* Keyboard Shortcuts */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="titlebar-no-drag size-7" onClick={() => setShortcutsOpen(true)}>
            <Keyboard className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Shortcuts (Ctrl+/)</TooltipContent>
      </Tooltip>

      {/* Settings */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="titlebar-no-drag size-7"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Settings (Ctrl+,)</TooltipContent>
      </Tooltip>

      {/* Window Controls */}
      <WindowControls />
    </header>
  )
}
