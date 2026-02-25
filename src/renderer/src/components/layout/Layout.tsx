import { useEffect, useRef, useState } from 'react'
import { MessageSquare, Briefcase, Code2, ClipboardCopy, Check, ImageDown, Loader2, PanelLeftOpen, PanelRightOpen, PanelRightClose } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { TitleBar } from './TitleBar'
import { NavRail } from './NavRail'
import { SessionListPanel } from './SessionListPanel'
import { RightPanel } from './RightPanel'
import { DetailPanel } from './DetailPanel'
import { PreviewPanel } from './PreviewPanel'
import { MessageList } from '@renderer/components/chat/MessageList'
import { InputArea } from '@renderer/components/chat/InputArea'
import { SettingsDialog } from '@renderer/components/settings/SettingsDialog'
import { SettingsPage } from '@renderer/components/settings/SettingsPage'
import { SkillsPage } from '@renderer/components/skills/SkillsPage'
import { KeyboardShortcutsDialog } from '@renderer/components/settings/KeyboardShortcutsDialog'
import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from '@renderer/components/error-boundary'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useChatActions } from '@renderer/hooks/use-chat-actions'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'
import { AnimatePresence } from 'motion/react'
import { PageTransition, PanelTransition } from '@renderer/components/animate-ui'
import { useShallow } from 'zustand/react/shallow'

const modes: { value: AppMode; labelKey: string; icon: React.ReactNode }[] = [
  { value: 'chat', labelKey: 'mode.chat', icon: <MessageSquare className="size-3.5" /> },
  { value: 'cowork', labelKey: 'mode.cowork', icon: <Briefcase className="size-3.5" /> },
  { value: 'code', labelKey: 'mode.code', icon: <Code2 className="size-3.5" /> },
]

export function Layout(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const mode = useUIStore((s) => s.mode)
  const setMode = useUIStore((s) => s.setMode)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const detailPanelOpen = useUIStore((s) => s.detailPanelOpen)
  const previewPanelOpen = useUIStore((s) => s.previewPanelOpen)
  const activeSessionView = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      return {
        activeSessionTitle: activeSession?.title,
        activeSessionMode: activeSession?.mode as SessionMode | undefined,
        activeWorkingFolder: activeSession?.workingFolder,
      }
    })
  )
  const { activeSessionTitle, activeSessionMode, activeWorkingFolder } = activeSessionView
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const isStreaming = !!streamingMessageId
  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls)
  const resolveApproval = useAgentStore((s) => s.resolveApproval)
  const initBackgroundProcessTracking = useAgentStore((s) => s.initBackgroundProcessTracking)

  const { resolvedTheme, setTheme: ntSetTheme } = useTheme()
  const { sendMessage, stopStreaming, retryLastMessage, editAndResend } = useChatActions()

  const [copiedAll, setCopiedAll] = useState(false)
  const [exporting, setExporting] = useState(false)

  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)
  const runningSubAgents = Object.values(activeSubAgents).filter((sa) => sa.isRunning)

  useEffect(() => {
    void initBackgroundProcessTracking()
  }, [initBackgroundProcessTracking])

  // Update window title (show pending approvals + streaming state + SubAgent)
  useEffect(() => {
    const base = activeSessionTitle
      ? `${activeSessionTitle} — OpenCowork`
      : 'OpenCowork'
    const prefix = pendingToolCalls.length > 0
      ? `(${pendingToolCalls.length} pending) `
      : runningSubAgents.length > 0
        ? `🧠 ${runningSubAgents.map((sa) => sa.name).join(', ')} | `
        : streamingMessageId
          ? '⏳ '
          : ''
    document.title = `${prefix}${base}`
  }, [activeSessionTitle, pendingToolCalls.length, streamingMessageId, runningSubAgents])

  // Sync UI mode only when session info changes, so manual top-bar toggles are respected
  useEffect(() => {
    if (!activeSessionMode) return
    const currentMode = useUIStore.getState().mode
    if (currentMode !== activeSessionMode) {
      useUIStore.getState().setMode(activeSessionMode)
    }
  }, [activeSessionId, activeSessionMode])

  // Close detail/preview panels when switching sessions (they are session-specific)
  const prevActiveSessionRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActiveSessionRef.current
    prevActiveSessionRef.current = activeSessionId
    if (prev !== null && prev !== activeSessionId) {
      useUIStore.getState().closeDetailPanel()
      useUIStore.getState().closePreviewPanel()
    }
  }, [activeSessionId])

  const pendingApproval = pendingToolCalls[0] ?? null
  const createSession = useChatStore((s) => s.createSession)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const settingsPageOpen = useUIStore((s) => s.settingsPageOpen)
  const skillsPageOpen = useUIStore((s) => s.skillsPageOpen)
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent): Promise<void> => {
      // Ctrl+Shift+N: New session in next mode
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault()
        const modes = ['chat', 'cowork', 'code'] as const
        const nextMode = modes[(modes.indexOf(mode) + 1) % modes.length]
        useUIStore.getState().setMode(nextMode)
        createSession(nextMode)
        toast.success(t('layout.newModeSession', { mode: nextMode }))
        return
      }
      // Ctrl+N: New chat
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        createSession(mode)
      }
      // Ctrl+,: Open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        useUIStore.getState().openSettingsPage()
      }
      // Ctrl+1/2/3: Switch mode
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault()
        const modeMap = { '1': 'chat', '2': 'cowork', '3': 'code' } as const
        useUIStore.getState().setMode(modeMap[e.key as '1' | '2' | '3'])
      }
      // Ctrl+B: Toggle left sidebar
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        toggleLeftSidebar()
      }
      // Ctrl+Shift+B: Toggle right panel
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        useUIStore.getState().toggleRightPanel()
      }
      // Ctrl+L: Clear current conversation
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        if (activeSessionId) {
          const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
          if (session && session.messageCount > 0) {
            const ok = await confirm({ title: t('layout.clearConfirm', { count: session.messageCount }), variant: 'destructive' })
            if (!ok) return
          }
          useChatStore.getState().clearSessionMessages(activeSessionId)
          if (session && session.messageCount > 0) toast.success(t('layout.conversationCleared'))
        }
      }
      // Ctrl+D: Duplicate current session
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault()
        if (activeSessionId) {
          useChatStore.getState().duplicateSession(activeSessionId)
          toast.success(t('layout.sessionDuplicated'))
        }
      }
      // Ctrl+P: Pin/unpin current session
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        if (activeSessionId) {
          const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
          useChatStore.getState().togglePinSession(activeSessionId)
          toast.success(session?.pinned ? t('layout.unpinned') : t('layout.pinned'))
        }
      }
      // Ctrl+Up/Down: Navigate between sessions
      if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const store = useChatStore.getState()
        const sorted = store.sessions.slice().sort((a, b) => {
          if (a.pinned && !b.pinned) return -1
          if (!a.pinned && b.pinned) return 1
          return b.updatedAt - a.updatedAt
        })
        if (sorted.length < 2) return
        const idx = sorted.findIndex((s) => s.id === store.activeSessionId)
        const next = e.key === 'ArrowDown' ? (idx + 1) % sorted.length : (idx - 1 + sorted.length) % sorted.length
        store.setActiveSession(sorted[next].id)
      }
      // Ctrl+Home/End: Scroll to top/bottom of messages
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault()
        const container = document.querySelector('.overflow-y-auto')
        if (container) {
          container.scrollTo({ top: e.key === 'Home' ? 0 : container.scrollHeight, behavior: 'smooth' })
        }
      }
      // Escape: Stop streaming
      if (e.key === 'Escape' && streamingMessageId) {
        e.preventDefault()
        stopStreaming()
      }
      // Ctrl+/: Keyboard shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        useUIStore.getState().setShortcutsOpen(true)
      }
      // Ctrl+Shift+C: Copy conversation as markdown
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault()
        if (activeSessionId) {
          await useChatStore.getState().loadSessionMessages(activeSessionId)
        }
        const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
        if (session && session.messageCount > 0) {
          navigator.clipboard.writeText(sessionToMarkdown(session))
          toast.success(t('layout.conversationCopied'))
        }
        return
      }
      // Ctrl+Shift+A: Toggle auto-approve tools
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        const current = useSettingsStore.getState().autoApprove
        if (!current) {
          const ok = await confirm({ title: t('layout.autoApproveConfirm') })
          if (!ok) return
        }
        useSettingsStore.getState().updateSettings({ autoApprove: !current })
        toast.success(current ? t('layout.autoApproveOff') : t('layout.autoApproveOn'))
        return
      }
      // Ctrl+Shift+Delete: Clear all sessions
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Delete') {
        e.preventDefault()
        const store = useChatStore.getState()
        const count = store.sessions.length
        if (count > 0) {
          const ok = await confirm({ title: t('layout.deleteAllConfirm', { count }), variant: 'destructive' })
          if (!ok) return
          store.clearAllSessions()
          toast.success(t('layout.deletedSessions', { count }))
        }
      }
      // Ctrl+Shift+T: Cycle right panel tab forward
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault()
        const ui = useUIStore.getState()
        if (!ui.rightPanelOpen) { ui.setRightPanelOpen(true); return }
        const tabs: Array<'steps' | 'plan' | 'team' | 'files' | 'artifacts' | 'context' | 'skills' | 'cron'> = ['steps', 'plan', 'team', 'files', 'artifacts', 'context', 'skills', 'cron']
        const idx = tabs.indexOf(ui.rightPanelTab)
        ui.setRightPanelTab(tabs[(idx + 1) % tabs.length])
        return
      }
      // Ctrl+Shift+D: Toggle dark/light theme
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        const current = resolvedTheme
        const next = current === 'dark' ? 'light' : 'dark'
        useSettingsStore.getState().updateSettings({ theme: next })
        ntSetTheme(next)
        toast.success(`${t('layout.theme')}: ${next}`)
        return
      }
      // Ctrl+Shift+O: Import sessions from JSON backup
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault()
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) return
          try {
            const text = await file.text()
            const data = JSON.parse(text)
            const sessions = Array.isArray(data) ? data : [data]
            const store = useChatStore.getState()
            let imported = 0
            for (const s of sessions) {
              if (s && s.id && Array.isArray(s.messages)) {
                const exists = store.sessions.some((e) => e.id === s.id)
                if (!exists) {
                  store.restoreSession(s)
                  imported++
                }
              }
            }
            if (imported > 0) {
              toast.success(t('layout.importedSessions', { count: imported }))
            } else {
              toast.info(t('layout.noNewSessions'))
            }
          } catch (err) {
            toast.error(t('layout.importFailed', { error: err instanceof Error ? err.message : String(err) }))
          }
        }
        input.click()
        return
      }
      // Ctrl+Shift+S: Backup all sessions as JSON
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault()
        const allSessions = useChatStore.getState().sessions
        if (allSessions.length === 0) { toast.error(t('layout.noSessionsToBackup')); return }
        await Promise.all(allSessions.map((s) => useChatStore.getState().loadSessionMessages(s.id)))
        const latestSessions = useChatStore.getState().sessions
        const json = JSON.stringify(latestSessions, null, 2)
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `opencowork-backup-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(url)
        toast.success(t('layout.backedUpSessions', { count: latestSessions.length }))
        return
      }
      // Ctrl+Shift+E: Export current conversation
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        if (activeSessionId) {
          await useChatStore.getState().loadSessionMessages(activeSessionId)
        }
        const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
        if (session && session.messageCount > 0) {
          const md = sessionToMarkdown(session)
          const filename = session.title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50).trim() || 'conversation'
          const blob = new Blob([md], { type: 'text/markdown' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `${filename}.md`
          a.click()
          URL.revokeObjectURL(url)
          toast.success(t('layout.exportedConversation'))
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mode, createSession, setSettingsOpen, toggleLeftSidebar, activeSessionId])

  const handleSelectFolder = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as { canceled?: boolean; path?: string }
    if (result.canceled || !result.path) {
      return
    }
    const chatStore = useChatStore.getState()
    const sessionId = chatStore.activeSessionId ?? chatStore.createSession(mode)
    if (sessionId) {
      chatStore.setWorkingFolder(sessionId, result.path)
    }
  }

  const handleCopyAll = (): void => {
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!session) return
    const md = sessionToMarkdown(session)
    navigator.clipboard.writeText(md)
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 2000)
  }

  const handleExportImage = async (): Promise<void> => {
    const node = document.querySelector('[data-message-content]') as HTMLElement | null
    const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)
    if (!node || !session) return
    setExporting(true)

    // Inject temporary styles to force all content to fit within container width.
    // html-to-image clones the DOM and may lose layout constraints, causing overflow.
    const styleEl = document.createElement('style')
    styleEl.setAttribute('data-export-image', '')
    styleEl.textContent = `
      [data-message-content] * {
        max-width: 100% !important;
        overflow-wrap: break-word !important;
        word-break: break-word !important;
      }
      [data-message-content] pre,
      [data-message-content] code {
        white-space: pre-wrap !important;
        word-break: break-all !important;
      }
      [data-message-content] table {
        table-layout: fixed !important;
        width: 100% !important;
      }
      [data-message-content] img,
      [data-message-content] svg {
        max-width: 100% !important;
        height: auto !important;
      }
    `
    document.head.appendChild(styleEl)

    try {
      // Wait for reflow so the browser applies the injected styles
      await new Promise<void>((r) => requestAnimationFrame(() => r()))

      const bgRaw = getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
      const bgColor = bgRaw ? `hsl(${bgRaw})` : '#ffffff'
      const { toPng } = await import('html-to-image')
      const captureWidth = node.clientWidth
      const dataUrl = await toPng(node, {
        backgroundColor: bgColor,
        pixelRatio: 2,
        width: captureWidth,
        style: {
          overflow: 'hidden',
          maxWidth: `${captureWidth}px`,
          width: `${captureWidth}px`,
        },
      })

      const base64 = dataUrl.split(',')[1]
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'image/png' })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      toast.success(t('layout.imageCopied', { defaultValue: 'Image copied to clipboard' }))
    } catch (err) {
      console.error('Export image failed:', err)
      toast.error(t('layout.exportImageFailed', { defaultValue: 'Export image failed' }), { description: String(err) })
    } finally {
      document.head.removeChild(styleEl)
      setExporting(false)
    }
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen flex-col overflow-hidden">
        {/* Full-width title bar */}
        <TitleBar />

        <div className="flex flex-1 overflow-hidden">
          {/* Narrow icon nav rail */}
          <NavRail />

          {/* Session list panel */}
          <AnimatePresence>
            {leftSidebarOpen && (
              <PanelTransition side="left" disabled={false} className="h-full z-10">
                <SessionListPanel />
              </PanelTransition>
            )}
          </AnimatePresence>

          {/* Main content area */}
          <AnimatePresence mode="wait">
            {skillsPageOpen ? (
              <PageTransition key="skills-page" className="flex-1 min-w-0 bg-background overflow-hidden">
                <SkillsPage />
              </PageTransition>
            ) : settingsPageOpen ? (
              <PageTransition key="settings-page" className="flex-1 min-w-0 bg-background overflow-hidden">
                <SettingsPage />
              </PageTransition>
            ) : (
              <PageTransition key="main-layout" className="flex flex-1 min-w-0 flex-col overflow-hidden">
                <ErrorBoundary renderFallback={(error, reset) => (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center overflow-hidden">
                    <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                      <svg className="size-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                      </svg>
                    </div>
                    <div className="space-y-1">
                      <h3 className="text-sm font-semibold text-foreground">{t('layout.somethingWentWrong')}</h3>
                      <p className="max-w-md text-xs text-muted-foreground">{error?.message || t('layout.unexpectedError')}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                        onClick={reset}
                      >
                        {t('layout.tryAgain')}
                      </button>
                      <button
                        className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        onClick={() => window.location.reload()}
                      >
                        {t('layout.reloadApp')}
                      </button>
                      <button
                        className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        onClick={() => {
                          const text = `Error: ${error?.message}\nStack: ${error?.stack}`
                          navigator.clipboard.writeText(text)
                        }}
                      >
                        {t('layout.copyError')}
                      </button>
                    </div>
                    {error?.stack && (
                      <details className="w-full max-w-lg text-left">
                        <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground transition-colors">{t('layout.errorDetails')}</summary>
                        <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-relaxed text-muted-foreground">{error.stack}</pre>
                      </details>
                    )}
                  </div>
                )}>
                  <div className="flex flex-1 overflow-hidden">
                    {/* Center: Chat Area */}
                    <div
                      className="flex min-w-0 flex-1 flex-col bg-gradient-to-b from-background to-muted/20"
                    >
                      {/* Mode selector toolbar */}
                      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
                        {!leftSidebarOpen && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 shrink-0"
                                onClick={toggleLeftSidebar}
                              >
                                <PanelLeftOpen className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('layout.expandSidebar', { defaultValue: 'Expand sidebar' })}</TooltipContent>
                          </Tooltip>
                        )}
                        <div className="flex items-center gap-0.5 rounded-lg bg-background/95 backdrop-blur-sm p-0.5 shadow-md border border-border/50">
                          {modes.map((m, i) => (
                            <Tooltip key={m.value}>
                              <TooltipTrigger asChild>
                                <Button
                                  variant={mode === m.value ? 'secondary' : 'ghost'}
                                  size="sm"
                                  className={cn(
                                    'h-6 gap-1.5 rounded-md px-2.5 text-xs font-medium transition-all duration-200',
                                    mode === m.value
                                      ? 'bg-background shadow-sm ring-1 ring-border/50'
                                      : 'text-muted-foreground hover:text-foreground'
                                  )}
                                  onClick={() => setMode(m.value)}
                                >
                                  {m.icon}
                                  {tCommon(m.labelKey)}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{tCommon(m.labelKey)} (Ctrl+{i + 1})</TooltipContent>
                            </Tooltip>
                          ))}
                        </div>
                        <div className="flex-1" />
                        <div className="flex items-center gap-0.5 rounded-lg border bg-background/80 backdrop-blur-sm shadow-sm px-0.5 py-0.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                className="group/btn flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200 disabled:opacity-50"
                                onClick={() => void handleExportImage()}
                                disabled={exporting || isStreaming}
                              >
                                {exporting ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <ImageDown className="size-3.5 shrink-0" />}
                                <span
                                  className="max-w-0 overflow-hidden pl-0 text-[10px] opacity-0 whitespace-nowrap group-hover/btn:max-w-[140px] group-hover/btn:pl-1 group-hover/btn:opacity-100"
                                  style={{ transition: 'max-width 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease, padding 180ms ease' }}
                                >
                                  {exporting ? t('layout.exporting', { defaultValue: 'Exporting...' }) : t('layout.exportImage', { defaultValue: 'Copy as image' })}
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{t('layout.exportImage', { defaultValue: 'Copy as image' })}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                className="group/btn flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200 disabled:opacity-50"
                                onClick={handleCopyAll}
                                disabled={isStreaming}
                              >
                                {copiedAll ? <Check className="size-3.5 shrink-0" /> : <ClipboardCopy className="size-3.5 shrink-0" />}
                                <span
                                  className="max-w-0 overflow-hidden pl-0 text-[10px] opacity-0 whitespace-nowrap group-hover/btn:max-w-[140px] group-hover/btn:pl-1 group-hover/btn:opacity-100"
                                  style={{ transition: 'max-width 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease, padding 180ms ease' }}
                                >
                                  {copiedAll ? t('layout.copied', { defaultValue: 'Copied' }) : t('layout.copyAll', { defaultValue: 'Copy conversation' })}
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{t('layout.copyAll', { defaultValue: 'Copy conversation' })}</TooltipContent>
                          </Tooltip>
                          {mode !== 'chat' && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  className="group/btn flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all duration-200"
                                  onClick={() => useUIStore.getState().toggleRightPanel()}
                                >
                                  {useUIStore.getState().rightPanelOpen ? <PanelRightClose className="size-3.5 shrink-0" /> : <PanelRightOpen className="size-3.5 shrink-0" />}
                                  <span
                                    className="max-w-0 overflow-hidden pl-0 text-[10px] opacity-0 whitespace-nowrap group-hover/btn:max-w-[140px] group-hover/btn:pl-1 group-hover/btn:opacity-100"
                                    style={{ transition: 'max-width 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease, padding 180ms ease' }}
                                  >
                                    {t('topbar.togglePanel')}
                                  </span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>{t('topbar.togglePanel')}</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                      <MessageList onRetry={retryLastMessage} onEditUserMessage={editAndResend} />
                      <InputArea
                        onSend={sendMessage}
                        onStop={stopStreaming}
                        onSelectFolder={mode !== 'chat' ? handleSelectFolder : undefined}
                        workingFolder={activeWorkingFolder}
                        isStreaming={isStreaming}
                      />
                    </div>

                    {/* Preview Panel */}
                    <AnimatePresence>
                      {previewPanelOpen && (
                        <PanelTransition
                          side="right"
                          disabled={isStreaming}
                          className="h-full border-l border-border/50 shadow-sm z-10"
                        >
                          <PreviewPanel />
                        </PanelTransition>
                      )}
                    </AnimatePresence>

                    {/* Middle: Detail Panel */}
                    <AnimatePresence>
                      {detailPanelOpen && (
                        <PanelTransition
                          side="right"
                          disabled={isStreaming}
                          className="h-full border-l border-border/50 shadow-sm z-10"
                        >
                          <DetailPanel />
                        </PanelTransition>
                      )}
                    </AnimatePresence>

                    {/* Right: Cowork/Code Panel */}
                    <AnimatePresence>
                      {mode !== 'chat' && rightPanelOpen && (
                        <PanelTransition side="right" disabled={false} className="h-full z-0">
                          <RightPanel compact={previewPanelOpen} />
                        </PanelTransition>
                      )}
                    </AnimatePresence>
                  </div>
                </ErrorBoundary>
              </PageTransition>
            )}
          </AnimatePresence>
        </div>
      </div>

      <CommandPalette />
      <SettingsDialog />
      <KeyboardShortcutsDialog />
      <PermissionDialog
        toolCall={pendingApproval}
        onAllow={() => pendingApproval && resolveApproval(pendingApproval.id, true)}
        onDeny={() => pendingApproval && resolveApproval(pendingApproval.id, false)}
      />
    </TooltipProvider>
  )
}
