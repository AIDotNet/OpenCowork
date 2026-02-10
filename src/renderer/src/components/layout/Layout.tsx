import { useEffect } from 'react'

import { useTheme } from 'next-themes'

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

import { KeyboardShortcutsDialog } from '@renderer/components/settings/KeyboardShortcutsDialog'

import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'

import { CommandPalette } from './CommandPalette'

import { ErrorBoundary } from '@renderer/components/error-boundary'

import { useUIStore } from '@renderer/stores/ui-store'

import { useChatStore } from '@renderer/stores/chat-store'

import { useAgentStore } from '@renderer/stores/agent-store'

import { useSettingsStore } from '@renderer/stores/settings-store'

import { useChatActions } from '@renderer/hooks/use-chat-actions'

import { toast } from 'sonner'

import { ipcClient } from '@renderer/lib/ipc/ipc-client'

import { sessionToMarkdown } from '@renderer/lib/utils/export-chat'



export function Layout(): React.JSX.Element {

  const mode = useUIStore((s) => s.mode)

  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)

  const setLeftSidebarOpen = useUIStore((s) => s.setLeftSidebarOpen)

  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)

  const detailPanelOpen = useUIStore((s) => s.detailPanelOpen)
  const previewPanelOpen = useUIStore((s) => s.previewPanelOpen)

  const sessions = useChatStore((s) => s.sessions)

  const activeSessionId = useChatStore((s) => s.activeSessionId)

  const streamingMessageId = useChatStore((s) => s.streamingMessageId)

  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls)

  const resolveApproval = useAgentStore((s) => s.resolveApproval)



  const { resolvedTheme, setTheme: ntSetTheme } = useTheme()

  const activeSession = sessions.find((s) => s.id === activeSessionId)

  const { sendMessage, stopStreaming, retryLastMessage, editAndResend } = useChatActions()



  const activeSubAgents = useAgentStore((s) => s.activeSubAgents)

  const runningSubAgents = Object.values(activeSubAgents).filter((sa) => sa.isRunning)



  // Update window title (show pending approvals + streaming state + SubAgent)

  useEffect(() => {

    const base = activeSession?.title

      ? `${activeSession.title} — OpenCowork`

      : 'OpenCowork'

    const prefix = pendingToolCalls.length > 0

      ? `(${pendingToolCalls.length} pending) `

      : runningSubAgents.length > 0

        ? `🧠 ${runningSubAgents.map((sa) => sa.name).join(', ')} | `

        : streamingMessageId

          ? '⏳ '

          : ''

    document.title = `${prefix}${base}`

  }, [activeSession?.title, pendingToolCalls.length, streamingMessageId, runningSubAgents])



  // Sync UI mode when switching to a session with a different mode

  useEffect(() => {

    if (activeSession && activeSession.mode !== mode) {

      useUIStore.getState().setMode(activeSession.mode)

    }

  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps



  const pendingApproval = pendingToolCalls[0] ?? null

  const createSession = useChatStore((s) => s.createSession)

  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)

  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar)



  // Keyboard shortcuts

  useEffect(() => {

    const handleKeyDown = (e: KeyboardEvent): void => {

      // Ctrl+Shift+N: New session in next mode

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {

        e.preventDefault()

        const modes = ['chat', 'cowork', 'code'] as const

        const nextMode = modes[(modes.indexOf(mode) + 1) % modes.length]

        useUIStore.getState().setMode(nextMode)

        createSession(nextMode)

        toast.success(`New ${nextMode} session`)

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

        setSettingsOpen(true)

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

          if (session && session.messages.length > 0 && !window.confirm(`Clear ${session.messages.length} messages?`)) return

          useChatStore.getState().clearSessionMessages(activeSessionId)

          if (session && session.messages.length > 0) toast.success('Conversation cleared')

        }

      }

      // Ctrl+D: Duplicate current session

      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {

        e.preventDefault()

        if (activeSessionId) {

          useChatStore.getState().duplicateSession(activeSessionId)

          toast.success('Session duplicated')

        }

      }

      // Ctrl+P: Pin/unpin current session

      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {

        e.preventDefault()

        if (activeSessionId) {

          const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)

          useChatStore.getState().togglePinSession(activeSessionId)

          toast.success(session?.pinned ? 'Unpinned' : 'Pinned')

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

        const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)

        if (session && session.messages.length > 0) {

          navigator.clipboard.writeText(sessionToMarkdown(session))

          toast.success('Conversation copied to clipboard')

        }

        return

      }

      // Ctrl+Shift+A: Toggle auto-approve tools

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {

        e.preventDefault()

        const current = useSettingsStore.getState().autoApprove

        if (!current && !window.confirm('Enable auto-approve? All tool calls will execute without confirmation.')) return

        useSettingsStore.getState().updateSettings({ autoApprove: !current })

        toast.success(current ? 'Auto-approve OFF' : 'Auto-approve ON (Dangerous)')

        return

      }

      // Ctrl+Shift+Delete: Clear all sessions

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Delete') {

        e.preventDefault()

        const store = useChatStore.getState()

        const count = store.sessions.length

        if (count > 0 && window.confirm(`Delete all ${count} sessions? This cannot be undone.`)) {

          store.clearAllSessions()

          toast.success(`Deleted ${count} sessions`)

        }

      }

      // Ctrl+Shift+T: Cycle right panel tab forward

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {

        e.preventDefault()

        const ui = useUIStore.getState()

        if (!ui.rightPanelOpen) { ui.setRightPanelOpen(true); return }

        const tabs: Array<'steps' | 'team' | 'files' | 'artifacts' | 'context' | 'skills'> = ['steps', 'team', 'files', 'artifacts', 'context', 'skills']

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

        toast.success(`Theme: ${next}`)

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

              toast.success(`Imported ${imported} session${imported > 1 ? 's' : ''}`)

            } else {

              toast.info('No new sessions to import (all already exist)')

            }

          } catch (err) {

            toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`)

          }

        }

        input.click()

        return

      }

      // Ctrl+Shift+S: Backup all sessions as JSON

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {

        e.preventDefault()

        const allSessions = useChatStore.getState().sessions

        if (allSessions.length === 0) { toast.error('No sessions to backup'); return }

        const json = JSON.stringify(allSessions, null, 2)

        const blob = new Blob([json], { type: 'application/json' })

        const url = URL.createObjectURL(blob)

        const a = document.createElement('a')

        a.href = url

        a.download = `opencowork-backup-${new Date().toISOString().slice(0, 10)}.json`

        a.click()

        URL.revokeObjectURL(url)

        toast.success(`Backed up ${allSessions.length} sessions`)

        return

      }

      // Ctrl+Shift+E: Export current conversation

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {

        e.preventDefault()

        const session = useChatStore.getState().sessions.find((s) => s.id === activeSessionId)

        if (session && session.messages.length > 0) {

          const md = sessionToMarkdown(session)

          const filename = session.title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50).trim() || 'conversation'

          const blob = new Blob([md], { type: 'text/markdown' })

          const url = URL.createObjectURL(blob)

          const a = document.createElement('a')

          a.href = url

          a.download = `${filename}.md`

          a.click()

          URL.revokeObjectURL(url)

          toast.success('Exported conversation')

        }

      }

    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)

  }, [mode, createSession, setSettingsOpen, toggleLeftSidebar, activeSessionId])



  const handleSelectFolder = async (): Promise<void> => {

    const result = (await ipcClient.invoke('fs:select-folder')) as { canceled?: boolean; path?: string }

    if (!result.canceled && result.path && activeSessionId) {

      useChatStore.getState().setWorkingFolder(activeSessionId, result.path)

    }

  }



  return (

    <TooltipProvider delayDuration={0}>

      <SidebarProvider open={leftSidebarOpen} onOpenChange={setLeftSidebarOpen}>

        <AppSidebar />

        <SidebarInset>

          <div className="flex h-screen min-w-0 flex-col overflow-hidden">

            <TopBar />

            <ErrorBoundary renderFallback={(error, reset) => (

              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center overflow-hidden">

                <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">

                  <svg className="size-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>

                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />

                  </svg>

                </div>

                <div className="space-y-1">

                  <h3 className="text-sm font-semibold text-foreground">Something went wrong</h3>

                  <p className="max-w-md text-xs text-muted-foreground">{error?.message || 'An unexpected error occurred.'}</p>

                </div>

                <div className="flex items-center gap-2">

                  <button

                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"

                    onClick={reset}

                  >

                    Try Again

                  </button>

                  <button

                    className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"

                    onClick={() => window.location.reload()}

                  >

                    Reload App

                  </button>

                  <button

                    className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"

                    onClick={() => {

                      const text = `Error: ${error?.message}\nStack: ${error?.stack}`

                      navigator.clipboard.writeText(text)

                    }}

                  >

                    Copy Error

                  </button>

                </div>

                {error?.stack && (

                  <details className="w-full max-w-lg text-left">

                    <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground transition-colors">Error details</summary>

                    <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-relaxed text-muted-foreground">{error.stack}</pre>

                  </details>

                )}

              </div>

            )}>

              <div className="flex flex-1 overflow-hidden">

                {/* Center: Chat Area */}

                <div className="flex min-w-0 flex-1 flex-col bg-gradient-to-b from-background to-muted/20">

                  <MessageList onRetry={retryLastMessage} onEditUserMessage={editAndResend} />

                  <InputArea

                    onSend={sendMessage}

                    onStop={stopStreaming}

                    onSelectFolder={mode !== 'chat' ? handleSelectFolder : undefined}

                    workingFolder={activeSession?.workingFolder}

                    isStreaming={!!streamingMessageId}

                  />

                </div>



                {/* Preview Panel */}
                {previewPanelOpen && <PreviewPanel />}

                {/* Middle: Detail Panel */}
                {detailPanelOpen && <DetailPanel />}

                {/* Right: Cowork/Code Panel */}
                {mode !== 'chat' && rightPanelOpen && <RightPanel compact={previewPanelOpen} />}

              </div>

            </ErrorBoundary>

          </div>

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

