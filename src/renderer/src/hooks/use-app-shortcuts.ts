import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { stopSessionStreaming } from '@renderer/hooks/use-chat-actions'
import { openSessionOrFocusDetached } from '@renderer/lib/session-window'
import {
  exportSessionMarkdownFromDb,
  exportSessionSnapshotFromDb
} from '@renderer/lib/utils/export-chat'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'

interface UseAppShortcutsOptions {
  /**
   * Set in a detached session window, which owns exactly one session. Those
   * windows keep the session-scoped shortcuts and drop the workspace-level ones
   * (new session, sidebar, settings, session navigation, bulk import/backup)
   * because they have no surface to act on.
   */
  detachedSessionId?: string | null
}

const MODE_BY_DIGIT: Record<string, AppMode> = {
  '1': 'clarify',
  '2': 'cowork',
  '3': 'code',
  '4': 'acp'
}

export function useAppShortcuts({ detachedSessionId = null }: UseAppShortcutsOptions = {}): void {
  const { t } = useTranslation('layout')
  const { resolvedTheme, setTheme: ntSetTheme } = useTheme()

  useEffect(() => {
    const workspaceScope = !detachedSessionId

    const getSessionId = (): string | null =>
      detachedSessionId ?? useChatStore.getState().activeSessionId

    const getSession = ():
      | ReturnType<typeof useChatStore.getState>['sessions'][number]
      | undefined => {
      const sessionId = getSessionId()
      if (!sessionId) return undefined
      return useChatStore.getState().sessions.find((session) => session.id === sessionId)
    }

    const createChatSession = (): void => {
      const chatStore = useChatStore.getState()
      const uiStore = useUIStore.getState()
      chatStore.setActiveProject(null)
      uiStore.setMode('chat')
      uiStore.navigateToHome()
    }

    const applyModeChange = (nextMode: AppMode): void => {
      const chatStore = useChatStore.getState()
      const uiStore = useUIStore.getState()
      const sessionId =
        detachedSessionId ?? (uiStore.chatView === 'session' ? chatStore.activeSessionId : null)

      if (sessionId) {
        const projectScoped = Boolean(
          chatStore.sessions.find((session) => session.id === sessionId)?.projectId
        )
        // A project session never falls back to plain chat, and a standalone chat
        // session has nowhere else to go — same rule the mode dropdown applies.
        if (projectScoped ? nextMode === 'chat' : nextMode !== 'chat') return
      }

      uiStore.setMode(nextMode)
      if (sessionId) chatStore.updateSessionMode(sessionId, nextMode)
    }

    const handleKeyDown = async (e: KeyboardEvent): Promise<void> => {
      const modifier = e.metaKey || e.ctrlKey

      // Ctrl+Shift+N: New independent chat session
      if (workspaceScope && modifier && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault()
        createChatSession()
        return
      }
      // Ctrl+1/2/3/4: Switch mode
      if (modifier && !e.shiftKey && MODE_BY_DIGIT[e.key]) {
        e.preventDefault()
        applyModeChange(MODE_BY_DIGIT[e.key])
      }
      // Ctrl+N: New independent chat session
      if (workspaceScope && modifier && e.key === 'n') {
        e.preventDefault()
        createChatSession()
      }
      // Ctrl+,: Open settings
      if (workspaceScope && modifier && e.key === ',') {
        e.preventDefault()
        useUIStore.getState().openSettingsPage()
      }
      // Ctrl+B: Toggle left sidebar
      if (workspaceScope && modifier && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        useUIStore.getState().toggleLeftSidebar()
      }
      // Ctrl+Shift+B: Toggle right panel
      if (modifier && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        useUIStore.getState().toggleRightPanel()
      }
      // Ctrl+L: Clear current conversation
      if (modifier && e.key === 'l') {
        e.preventDefault()
        const sessionId = getSessionId()
        if (sessionId) {
          const session = getSession()
          if (session && session.messageCount > 0) {
            const ok = await confirm({
              title: t('layout.clearConfirm', { count: session.messageCount }),
              variant: 'destructive'
            })
            if (!ok) return
          }
          useChatStore.getState().clearSessionMessages(sessionId)
          if (session && session.messageCount > 0) toast.success(t('layout.conversationCleared'))
        }
      }
      // Ctrl+D: Duplicate current session
      if (workspaceScope && modifier && e.key === 'd') {
        e.preventDefault()
        const sessionId = getSessionId()
        if (sessionId) {
          useChatStore.getState().duplicateSession(sessionId)
          toast.success(t('layout.sessionDuplicated'))
        }
      }
      // Ctrl+P: Pin/unpin current session
      if (modifier && e.key === 'p') {
        e.preventDefault()
        const sessionId = getSessionId()
        if (sessionId) {
          const session = getSession()
          useChatStore.getState().togglePinSession(sessionId)
          toast.success(session?.pinned ? t('layout.unpinned') : t('layout.pinned'))
        }
      }
      // Ctrl+Up/Down: Navigate between sessions
      if (workspaceScope && modifier && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        const store = useChatStore.getState()
        const sorted = store.sessions.slice().sort((a, b) => {
          if (a.pinned && !b.pinned) return -1
          if (!a.pinned && b.pinned) return 1
          return b.updatedAt - a.updatedAt
        })
        if (sorted.length < 2) return
        const idx = sorted.findIndex((s) => s.id === store.activeSessionId)
        const next =
          e.key === 'ArrowDown'
            ? (idx + 1) % sorted.length
            : (idx - 1 + sorted.length) % sorted.length
        void openSessionOrFocusDetached(sorted[next].id)
      }
      // Ctrl+Home/End: Scroll to top/bottom of messages
      if (modifier && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault()
        const container = document.querySelector('.overflow-y-auto')
        if (container) {
          container.scrollTo({
            top: e.key === 'Home' ? 0 : container.scrollHeight,
            behavior: 'smooth'
          })
        }
      }
      // Escape: Stop streaming
      if (e.key === 'Escape') {
        const sessionId = getSessionId()
        if (sessionId && useChatStore.getState().streamingMessages[sessionId]) {
          e.preventDefault()
          stopSessionStreaming(sessionId)
        }
      }
      // Ctrl+/: Keyboard shortcuts
      if (modifier && e.key === '/') {
        e.preventDefault()
        useUIStore.getState().setShortcutsOpen(true)
      }
      // Ctrl+Shift+C: Copy conversation as markdown
      if (modifier && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault()
        const session = getSession()
        if (session && session.messageCount > 0) {
          await navigator.clipboard.writeText(await exportSessionMarkdownFromDb(session))
          toast.success(t('layout.conversationCopied'))
        }
        return
      }
      // Ctrl+Shift+A: Toggle auto-approve tools
      if (modifier && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
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
      if (workspaceScope && modifier && e.shiftKey && e.key === 'Delete') {
        e.preventDefault()
        const store = useChatStore.getState()
        const count = store.sessions.length
        if (count > 0) {
          const ok = await confirm({
            title: t('layout.deleteAllConfirm', { count }),
            variant: 'destructive'
          })
          if (!ok) return
          store.clearAllSessions()
          toast.success(t('layout.deletedSessions', { count }))
        }
      }
      // Ctrl+Shift+T: Cycle right panel tab forward
      if (modifier && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault()
        const ui = useUIStore.getState()
        if (!ui.rightPanelOpen) {
          ui.setRightPanelOpen(true)
          return
        }
        const tabs = ui.rightPanelTabs
        if (tabs.length === 0) {
          ui.setRightPanelOpen(true)
          return
        }
        const idx = tabs.findIndex((tab) => tab.id === ui.rightPanelActiveTabId)
        const next = tabs[((idx >= 0 ? idx : 0) + 1) % tabs.length]
        if (next) ui.setRightPanelActiveTab(next.id)
        return
      }
      // Ctrl+Shift+D: Toggle dark/light theme
      if (modifier && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        const next = resolvedTheme === 'dark' ? 'light' : 'dark'
        useSettingsStore.getState().updateSettings({ theme: next })
        ntSetTheme(next)
        toast.success(`${t('layout.theme')}: ${next}`)
        return
      }
      // Ctrl+Shift+O: Import sessions from JSON backup
      if (workspaceScope && modifier && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
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
            toast.error(
              t('layout.importFailed', { error: err instanceof Error ? err.message : String(err) })
            )
          }
        }
        input.click()
        return
      }
      // Ctrl+Shift+S: Backup all sessions as JSON
      if (workspaceScope && modifier && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault()
        const allSessions = useChatStore.getState().sessions
        if (allSessions.length === 0) {
          toast.error(t('layout.noSessionsToBackup'))
          return
        }
        const latestSessions = await Promise.all(allSessions.map(exportSessionSnapshotFromDb))
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
      if (modifier && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        const session = getSession()
        if (session && session.messageCount > 0) {
          const md = await exportSessionMarkdownFromDb(session)
          const filename =
            session.title
              .replace(/[^a-zA-Z0-9-_ ]/g, '')
              .slice(0, 50)
              .trim() || 'conversation'
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
  }, [detachedSessionId, ntSetTheme, resolvedTheme, t])
}
