import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { SidebarProvider, SidebarInset } from '@renderer/components/ui/sidebar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { AppSidebar } from './AppSidebar'
import { TopBar } from './TopBar'
import { RightPanel } from './RightPanel'
import { DetailPanel } from './DetailPanel'
import { PreviewPanel } from './PreviewPanel'
import { MessageList } from '@renderer/components/chat/MessageList'
import { InputArea } from '@renderer/components/chat/InputArea'
import { SettingsDialog } from '@renderer/components/settings/SettingsDialog'
import { SettingsPage } from '@renderer/components/settings/SettingsPage'
import { KeyboardShortcutsDialog } from '@renderer/components/settings/KeyboardShortcutsDialog'
import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from '@renderer/components/error-boundary'
import { useUIStore } from '@renderer/stores/ui-store'
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

export function Layout(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const mode = useUIStore((s) => s.mode)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const setLeftSidebarOpen = useUIStore((s) => s.setLeftSidebarOpen)
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

  // Sync UI mode when switching to a session with a different mode
  useEffect(() => {
    if (activeSessionMode && activeSessionMode !== mode) {
      useUIStore.getState().setMode(activeSessionMode)
    }
  }, [activeSessionId, activeSessionMode, mode])

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

  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider open={leftSidebarOpen} onOpenChange={setLeftSidebarOpen}>
        <AppSidebar />
        <SidebarInset>
          <AnimatePresence mode="wait">
            {settingsPageOpen ? (
              <PageTransition key="settings-page" className="absolute inset-0 z-50 bg-background overflow-hidden">
                <SettingsPage />
              </PageTransition>
            ) : (
              <PageTransition key="main-layout" className="flex h-screen min-w-0 flex-col overflow-hidden">
                <TopBar />
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
                        <PanelTransition side="right" disabled={isStreaming} className="h-full z-0">
                          <RightPanel compact={previewPanelOpen} />
                        </PanelTransition>
                      )}
                    </AnimatePresence>
                  </div>
                </ErrorBoundary>
              </PageTransition>
            )}
          </AnimatePresence>
        </SidebarInset>

        <CommandPalette />
        <SettingsDialog />
        <KeyboardShortcutsDialog />
        <PermissionDialog
          toolCall={pendingApproval}
          onAllow={() => pendingApproval && resolveApproval(pendingApproval.id, true)}
          onDeny={() => pendingApproval && resolveApproval(pendingApproval.id, false)}
        />
      </SidebarProvider>
    </TooltipProvider>
  )
}
