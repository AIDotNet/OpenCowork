import { useEffect, useCallback } from 'react'
import { WindowControls } from '@renderer/components/layout/WindowControls'
import { useTranslation } from 'react-i18next'
import {
  X,
  Plus,
  PanelLeftOpen,
  PanelLeftClose,
  Search,
  Eraser,
  RotateCcw,
  Terminal,
  FileText,
  Upload,
  Loader2,
  Server
} from 'lucide-react'
import { useSshStore, type SshTab } from '@renderer/stores/ssh-store'
import { Button } from '@renderer/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger
} from '@renderer/components/ui/sheet'
import { cn } from '@renderer/lib/utils'
import { toast } from 'sonner'
import { SshConnectionList } from './SshConnectionList'
import { SshFileExplorer } from './SshFileExplorer'
import { SshTerminal } from './SshTerminal'
import { SshFileEditor } from './SshFileEditor'

export function SshPage(): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const isMac = /Mac/.test(navigator.userAgent)

  const openTabs = useSshStore((s) => s.openTabs)
  const activeTabId = useSshStore((s) => s.activeTabId)
  const sessions = useSshStore((s) => s.sessions)
  const fileExplorerOpen = useSshStore((s) => s.fileExplorerOpen)
  const loadAll = useSshStore((s) => s.loadAll)
  const _loaded = useSshStore((s) => s._loaded)
  const uploadTasks = useSshStore((s) => s.uploadTasks)

  const uploadTaskList = Object.values(uploadTasks).sort((a, b) => b.updatedAt - a.updatedAt)
  const activeUploadCount = uploadTaskList.filter(
    (task) => task.stage !== 'done' && task.stage !== 'error' && task.stage !== 'canceled'
  ).length

  useEffect(() => {
    if (!_loaded) void loadAll()
  }, [_loaded, loadAll])

  const handleConnect = useCallback(
    async (connectionId: string) => {
      const store = useSshStore.getState()
      const conn = store.connections.find((c) => c.id === connectionId)
      if (!conn) return

      const existingTab = store.openTabs.find(
        (tab) => tab.connectionId === connectionId && tab.type === 'terminal'
      )
      if (existingTab) {
        store.setActiveTab(existingTab.id)
        return
      }

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
          title: conn.name
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
        status: 'connecting'
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
        title: conn.name
      }
      store.replaceTab(pendingTabId, tab)
    },
    [t]
  )

  const handleCloseTab = useCallback((tabId: string) => {
    useSshStore.getState().closeTab(tabId)
  }, [])

  const handleNewTerminal = useCallback(async () => {
    const store = useSshStore.getState()
    const active = store.openTabs.find((tab) => tab.id === store.activeTabId)
    if (!active) return

    const tabCount =
      store.openTabs.filter(
        (tab) => tab.connectionId === active.connectionId && tab.type === 'terminal'
      ).length + 1
    const pendingTabId = `pending-${active.connectionId}-${Date.now()}`
    store.openTab({
      id: pendingTabId,
      type: 'terminal',
      sessionId: null,
      connectionId: active.connectionId,
      connectionName: active.connectionName,
      title: `${active.connectionName} (${tabCount})`,
      status: 'connecting'
    })

    const sessionId = await store.connect(active.connectionId)
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
      connectionId: active.connectionId,
      connectionName: active.connectionName,
      title: `${active.connectionName} (${tabCount})`
    }
    store.replaceTab(pendingTabId, tab)
  }, [t])

  const handleShowList = useCallback(() => {
    useSshStore.getState().setActiveTab(null as unknown as string)
    useSshStore.setState({ activeTabId: null })
  }, [])

  const activeTab = openTabs.find((tab) => tab.id === activeTabId)
  const activeSession =
    activeTab?.type === 'terminal' && activeTab.sessionId ? sessions[activeTab.sessionId] : null
  const explorerSessionId = activeTab
    ? (activeTab.sessionId ??
      Object.values(sessions).find(
        (session) =>
          session.connectionId === activeTab.connectionId && session.status === 'connected'
      )?.id ??
      null)
    : null
  const showTerminalView = !!activeTabId && openTabs.length > 0

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Title bar with terminal tabs */}
      <div
        className={cn(
          'titlebar-drag relative flex h-10 shrink-0 items-center border-b pr-[132px]',
          isMac && 'pl-[78px] pr-3'
        )}
      >
        {/* SSH title — acts as "server list" tab */}
        <button
          className={cn(
            'titlebar-no-drag flex h-full items-center gap-2 border-r border-border px-4 text-xs transition-colors shrink-0',
            !showTerminalView
              ? 'bg-background text-foreground font-medium'
              : 'bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
          onClick={handleShowList}
        >
          <Server className="size-3.5" />
          {t('list.addServer')}
        </button>

        {/* Terminal session tabs */}
        <div className="flex h-full flex-1 items-center overflow-x-auto min-w-0">
          {openTabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const session = tab.sessionId ? sessions[tab.sessionId] : null
            const isTerminal = tab.type === 'terminal'
            const isConnected = isTerminal && !!session && session.status === 'connected'
            const isConnecting =
              isTerminal &&
              (tab.sessionId ? session?.status === 'connecting' : tab.status === 'connecting')
            const isError =
              isTerminal && (tab.sessionId ? session?.status === 'error' : tab.status === 'error')
            return (
              <div
                key={tab.id}
                className={cn(
                  'titlebar-no-drag flex h-full items-center gap-1.5 border-r border-border px-3 text-xs cursor-pointer shrink-0 transition-colors',
                  isActive
                    ? 'bg-background text-foreground'
                    : 'bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
                onClick={() => useSshStore.getState().setActiveTab(tab.id)}
              >
                {isTerminal ? (
                  <Terminal className="size-3 shrink-0" />
                ) : (
                  <FileText className="size-3 shrink-0" />
                )}
                <span className="max-w-[120px] truncate">{tab.title}</span>
                {isTerminal && isConnecting && (
                  <Loader2 className="size-3 animate-spin text-amber-500 shrink-0" />
                )}
                {isTerminal && isConnected && (
                  <div className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                )}
                {isTerminal && isError && (
                  <div className="size-1.5 rounded-full bg-red-500 shrink-0" />
                )}
                <button
                  className="ml-0.5 rounded p-0.5 hover:bg-muted/80 transition-colors shrink-0"
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

        {/* Right side: Uploads + window controls */}
        <div className="titlebar-no-drag flex items-center gap-1 px-2 shrink-0">
          <Sheet>
            <SheetTrigger asChild>
              <button
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors',
                  activeUploadCount > 0 && 'text-primary'
                )}
                title="Uploads"
              >
                <Upload className="size-3.5" />
                {activeUploadCount > 0 && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    {activeUploadCount}
                  </span>
                )}
              </button>
            </SheetTrigger>
            <SheetContent className="sm:max-w-md">
              <SheetHeader>
                <SheetTitle>Uploads</SheetTitle>
                <SheetDescription>Compression / upload / unzip progress</SheetDescription>
              </SheetHeader>
              <UploadTaskList tasks={uploadTaskList} />
            </SheetContent>
          </Sheet>
        </div>

        {!isMac && (
          <div className="absolute right-0 top-0 z-10">
            <WindowControls />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Terminal view */}
        <div
          className="flex flex-1 overflow-hidden"
          style={{ display: showTerminalView ? 'flex' : 'none' }}
        >
          <div
            className={cn(
              'shrink-0 border-r flex flex-col overflow-hidden transition-[width] duration-200 ease-in-out',
              fileExplorerOpen ? 'w-56' : 'w-0 border-r-0'
            )}
          >
            {activeTab && explorerSessionId && (
              <SshFileExplorer
                sessionId={explorerSessionId}
                connectionId={activeTab.connectionId}
              />
            )}
          </div>

          <div className="flex flex-1 flex-col overflow-hidden min-w-0">
            {/* Terminal toolbar */}
            <div className="flex items-center border-b bg-background shrink-0 h-8">
              <button
                className="px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
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
              <button
                className="px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                onClick={() => void handleNewTerminal()}
                title={t('terminal.newTab')}
              >
                <Plus className="size-3.5" />
              </button>
              <div className="flex-1" />
              {activeTab?.type === 'terminal' && (
                <div className="flex items-center gap-0.5 px-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                    title={t('terminal.search')}
                  >
                    <Search className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                    title={t('terminal.clear')}
                  >
                    <Eraser className="size-3" />
                  </Button>
                  {activeSession && activeSession.status !== 'connected' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <RotateCcw className="size-3" />
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Terminal panels */}
            <div className="flex-1 overflow-hidden relative">
              {openTabs.map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{ display: tab.id === activeTabId ? undefined : 'none' }}
                >
                  {tab.type === 'file' ? (
                    tab.filePath ? (
                      <SshFileEditor
                        connectionId={tab.connectionId}
                        filePath={tab.filePath}
                        sessionId={tab.sessionId ?? undefined}
                      />
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

        {/* Connection list view */}
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

function UploadTaskList({
  tasks
}: {
  tasks: {
    taskId: string
    stage: string
    message?: string
    progress?: { current?: number; total?: number; percent?: number }
  }[]
}): React.JSX.Element {
  if (tasks.length === 0) {
    return <div className="px-4 pb-4 text-xs text-muted-foreground">No uploads</div>
  }
  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      {tasks.map((task) => {
        const percent = task.progress?.percent
        const showCancel =
          task.stage !== 'done' && task.stage !== 'error' && task.stage !== 'canceled'
        const showClear = !showCancel
        return (
          <div key={task.taskId} className="rounded border border-border p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{task.taskId}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {task.stage}
                  {task.message ? ` · ${task.message}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {showCancel && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void useSshStore.getState().cancelUpload(task.taskId)}
                  >
                    Cancel
                  </Button>
                )}
                {showClear && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => useSshStore.getState().clearUploadTask(task.taskId)}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-2">
              <div className="h-1.5 w-full rounded bg-muted">
                <div
                  className="h-1.5 rounded bg-primary transition-all"
                  style={{ width: typeof percent === 'number' ? `${percent}%` : '0%' }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{typeof percent === 'number' ? `${percent}%` : ''}</span>
                <span>
                  {typeof task.progress?.current === 'number' ? `${task.progress.current}` : ''}
                  {typeof task.progress?.total === 'number' ? ` / ${task.progress.total}` : ''}
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
