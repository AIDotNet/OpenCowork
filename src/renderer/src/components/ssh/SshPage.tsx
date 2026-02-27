import { useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Monitor,
  X,
  Plus,
  ArrowLeft,
  PanelLeftOpen,
  PanelLeftClose,
  Search,
  Eraser,
  RotateCcw,
  Terminal,
  FileText,
  Loader2,
} from 'lucide-react'
import { useSshStore, type SshTab } from '@renderer/stores/ssh-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { toast } from 'sonner'
import { SshConnectionList } from './SshConnectionList'
import { SshFileExplorer } from './SshFileExplorer'
import { SshTerminal } from './SshTerminal'
import { SshFileEditor } from './SshFileEditor'

export function SshPage(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const closeSshPage = useUIStore((s) => s.closeSshPage)

  const openTabs = useSshStore((s) => s.openTabs)
  const activeTabId = useSshStore((s) => s.activeTabId)
  const sessions = useSshStore((s) => s.sessions)
  const fileExplorerOpen = useSshStore((s) => s.fileExplorerOpen)
  const loadAll = useSshStore((s) => s.loadAll)
  const _loaded = useSshStore((s) => s._loaded)

  // Track which tabs have been mounted (for keep-alive)
  const mountedTabsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!_loaded) void loadAll()
  }, [_loaded, loadAll])

  // Listen for SSH status events
  useEffect(() => {
    const cleanup = window.electron.ipcRenderer.on(
      'ssh:status',
      (_event: unknown, data: { sessionId: string; connectionId: string; status: string; error?: string }) => {
        const store = useSshStore.getState()
        if (data.status === 'disconnected') {
          store.removeSession(data.sessionId)
        } else {
          store.updateSessionStatus(
            data.sessionId,
            data.status as 'connecting' | 'connected' | 'disconnected' | 'error',
            data.error
          )
        }
      }
    )
    return () => { cleanup() }
  }, [])

  const handleConnect = useCallback(async (connectionId: string) => {
    const store = useSshStore.getState()
    const conn = store.connections.find((c) => c.id === connectionId)
    if (!conn) return

    // If a terminal tab is already open, just focus it
    const existingTab = store.openTabs.find(
      (tab) => tab.connectionId === connectionId && tab.type === 'terminal'
    )
    if (existingTab) {
      store.setActiveTab(existingTab.id)
      return
    }

    // If already connected elsewhere, reuse the existing session
    const existingSession = Object.values(store.sessions).find(
      (session) => session.connectionId === connectionId && session.status === 'connected'
    )
    if (existingSession) {
      const tabId = `tab-${existingSession.id}`
      store.openTab({
        id: tabId,
        type: 'terminal',
        sessionId: existingSession.id,
        connectionId,
        connectionName: conn.name,
        title: conn.name,
      })
      return
    }

    const pendingTabId = `pending-${connectionId}-${Date.now()}`
    store.openTab({
      id: pendingTabId,
      type: 'terminal',
      sessionId: null,
      connectionId,
      connectionName: conn.name,
      title: conn.name,
      status: 'connecting',
    })

    const sessionId = await store.connect(connectionId)
    if (!sessionId) {
      store.closeTab(pendingTabId)
      toast.error(t('connectionFailed'))
      return
    }

    const stillOpen = useSshStore.getState().openTabs.find((tab) => tab.id === pendingTabId)
    if (!stillOpen) {
      await store.disconnect(sessionId)
      return
    }

    const resolvedTabId = `tab-${sessionId}`
    const tab: SshTab = {
      id: resolvedTabId,
      type: 'terminal',
      sessionId,
      connectionId,
      connectionName: conn.name,
      title: conn.name,
    }
    store.replaceTab(pendingTabId, tab)
  }, [t])

  const handleCloseTab = useCallback((tabId: string) => {
    mountedTabsRef.current.delete(tabId)
    useSshStore.getState().closeTab(tabId)
  }, [])

  const handleNewTerminal = useCallback(async () => {
    // Open a new terminal for the same connection as active tab
    const store = useSshStore.getState()
    const activeTab = store.openTabs.find((t) => t.id === store.activeTabId)
    if (!activeTab) return

    const tabCount =
      store.openTabs.filter((t) => t.connectionId === activeTab.connectionId && t.type === 'terminal')
        .length + 1
    const pendingTabId = `pending-${activeTab.connectionId}-${Date.now()}`
    store.openTab({
      id: pendingTabId,
      type: 'terminal',
      sessionId: null,
      connectionId: activeTab.connectionId,
      connectionName: activeTab.connectionName,
      title: `${activeTab.connectionName} (${tabCount})`,
      status: 'connecting',
    })

    const sessionId = await store.connect(activeTab.connectionId)
    if (!sessionId) {
      store.closeTab(pendingTabId)
      toast.error(t('connectionFailed'))
      return
    }

    const stillOpen = useSshStore.getState().openTabs.find((tab) => tab.id === pendingTabId)
    if (!stillOpen) {
      await store.disconnect(sessionId)
      return
    }

    const tabId = `tab-${sessionId}`
    const tab: SshTab = {
      id: tabId,
      type: 'terminal',
      sessionId,
      connectionId: activeTab.connectionId,
      connectionName: activeTab.connectionName,
      title: `${activeTab.connectionName} (${tabCount})`,
    }
    store.replaceTab(pendingTabId, tab)
  }, [t])

  const handleBackToList = useCallback(() => {
    // Don't close tabs, just show the list
    useSshStore.getState().setActiveTab(null as unknown as string)
    useSshStore.setState({ activeTabId: null })
  }, [])

  const activeTab = openTabs.find((t) => t.id === activeTabId)
  const activeSession =
    activeTab?.type === 'terminal' && activeTab.sessionId ? sessions[activeTab.sessionId] : null
  const explorerSessionId = activeTab
    ? (activeTab.sessionId ??
        Object.values(sessions).find(
          (session) => session.connectionId === activeTab.connectionId && session.status === 'connected'
        )?.id ??
        null)
    : null
  const showTerminalView = openTabs.length > 0 && activeTabId

  // Track mounted tabs
  for (const tab of openTabs) {
    mountedTabsRef.current.add(tab.id)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <button
          onClick={closeSshPage}
          className="rounded-md p-1 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <ArrowLeft className="size-4" />
        </button>
        <Monitor className="size-4 text-primary" />
        <span className="text-sm font-medium">{t('title')}</span>

        {showTerminalView && (
          <>
            <div className="mx-2 h-4 w-px bg-border" />
            <button
              onClick={handleBackToList}
              className="text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors"
            >
              {t('list.backToList')}
            </button>
          </>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <div
          className="flex flex-1 overflow-hidden"
          style={{ display: showTerminalView ? 'flex' : 'none' }}
        >
          {/* File explorer (collapsible left panel) */}
          {fileExplorerOpen && activeTab && explorerSessionId && (
            <div className="w-56 shrink-0 border-r flex flex-col overflow-hidden">
              <SshFileExplorer
                sessionId={explorerSessionId}
                connectionId={activeTab.connectionId}
              />
            </div>
          )}

          {/* Terminal area */}
          <div className="flex flex-1 flex-col overflow-hidden min-w-0">
            {/* Tab bar */}
            <div className="flex items-center border-b bg-background shrink-0">
              {/* File explorer toggle */}
              <button
                className="px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                onClick={() => useSshStore.getState().toggleFileExplorer()}
                title={t('fileExplorer.title')}
              >
                {fileExplorerOpen ? (
                  <PanelLeftClose className="size-3.5" />
                ) : (
                  <PanelLeftOpen className="size-3.5" />
                )}
              </button>

              <div className="h-4 w-px bg-border mx-0.5" />

              {/* Tabs */}
              <div className="flex flex-1 items-center overflow-x-auto min-w-0">
                {openTabs.map((tab) => {
                  const isActive = tab.id === activeTabId
                  const session = tab.sessionId ? sessions[tab.sessionId] : null
                  const isTerminal = tab.type === 'terminal'
                  const isConnected = isTerminal && !!session && session.status === 'connected'
                  const isConnecting = isTerminal && (
                    tab.sessionId ? session?.status === 'connecting' : tab.status === 'connecting'
                  )
                  const isError = isTerminal && (
                    tab.sessionId ? session?.status === 'error' : tab.status === 'error'
                  )
                  return (
                    <div
                      key={tab.id}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border cursor-pointer shrink-0 transition-colors',
                        isActive
                          ? 'bg-background text-foreground'
                          : 'bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/60'
                      )}
                      onClick={() => useSshStore.getState().setActiveTab(tab.id)}
                    >
                      {isTerminal ? (
                        <Terminal className="size-3" />
                      ) : (
                        <FileText className="size-3" />
                      )}
                      <span className="max-w-[120px] truncate">{tab.title}</span>
                      {isTerminal && isConnecting && (
                        <Loader2 className="size-3 animate-spin text-amber-500" />
                      )}
                      {isTerminal && isConnected && (
                        <div className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                      )}
                      {isTerminal && isError && (
                        <div className="size-1.5 rounded-full bg-red-500 shrink-0" />
                      )}
                      <button
                        className="ml-1 p-0.5 rounded hover:bg-muted/60 transition-colors shrink-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleCloseTab(tab.id)
                        }}
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  )
                })}
              </div>

              {/* New tab button */}
              <button
                className="px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                onClick={() => void handleNewTerminal()}
                title={t('terminal.newTab')}
              >
                <Plus className="size-3.5" />
              </button>

              <div className="flex-1" />

              {/* Terminal toolbar actions */}
              {activeTab?.type === 'terminal' && (
                <div className="flex items-center gap-0.5 px-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                    title={t('terminal.search')}
                  >
                    <Search className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                    title={t('terminal.clear')}
                  >
                    <Eraser className="size-3" />
                  </Button>
                  {activeSession && activeSession.status !== 'connected' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
                    >
                      <RotateCcw className="size-3" />
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Terminal panels (keep-alive: hidden instead of unmounted) */}
            <div className="flex-1 overflow-hidden relative">
              {openTabs.map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{ display: tab.id === activeTabId ? undefined : 'none' }}
                >
                  {tab.type === 'file' ? (
                    tab.filePath ? (
                      <SshFileEditor connectionId={tab.connectionId} filePath={tab.filePath} />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground text-xs">
                        {t('fileExplorer.error')}
                      </div>
                    )
                  ) : tab.sessionId ? (
                    <SshTerminal sessionId={tab.sessionId} connectionName={tab.connectionName} />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground text-sm">
                      <div className="flex items-center gap-2">
                        <Loader2 className="size-4 animate-spin text-amber-500" />
                        {t('connecting')}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          className="flex flex-1 overflow-hidden"
          style={{ display: showTerminalView ? 'none' : 'flex' }}
        >
          <SshConnectionList onConnect={(connId) => void handleConnect(connId)} />
        </div>
      </div>
    </div>
  )
}
