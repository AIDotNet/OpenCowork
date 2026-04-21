import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  Ellipsis,
  FolderOpen,
  Loader2,
  MonitorSmartphone,
  Plus,
  SquareTerminal,
  X
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Badge } from '@renderer/components/ui/badge'
import {
  buildUnifiedTerminalTabs,
  getUnifiedActiveTerminalTabId,
  type UnifiedTerminalTab
} from '@renderer/lib/terminal/unified-terminal-tabs'
import { cn } from '@renderer/lib/utils'
import { useTerminalStore } from '@renderer/stores/terminal-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useChatStore } from '@renderer/stores/chat-store'
import { LocalTerminal } from './LocalTerminal'
import { SshConnectionPicker } from './SshConnectionPicker'
import { SshTerminal } from '../ssh/SshTerminal'

function StatusDot({
  status
}: {
  status: 'running' | 'exited' | 'error' | 'connecting' | 'connected' | 'disconnected'
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'running' || status === 'connected'
          ? 'bg-emerald-500'
          : status === 'connecting'
            ? 'bg-amber-500'
            : status === 'error'
              ? 'bg-red-500'
              : 'bg-muted-foreground/50'
      )}
    />
  )
}

export function TerminalPanel(): React.JSX.Element {
  const [sshPickerOpen, setSshPickerOpen] = useState(false)

  const localTabs = useTerminalStore((s) => s.tabs)
  const localActiveTabId = useTerminalStore((s) => s.activeTabId)
  const initTerminal = useTerminalStore((s) => s.init)
  const createLocalTab = useTerminalStore((s) => s.createTab)
  const closeLocalTab = useTerminalStore((s) => s.closeTab)
  const setLocalActiveTab = useTerminalStore((s) => s.setActiveTab)

  const sshConnections = useSshStore((s) => s.connections)
  const sshSessions = useSshStore((s) => s.sessions)
  const sshOpenTabs = useSshStore((s) => s.openTabs)
  const sshActiveTabId = useSshStore((s) => s.activeTabId)
  const sshLoaded = useSshStore((s) => s._loaded)
  const loadSsh = useSshStore((s) => s.loadAll)
  const openSshTerminal = useSshStore((s) => s.openTerminalTab)
  const closeSshSession = useSshStore((s) => s.disconnect)
  const closeSshTab = useSshStore((s) => s.closeTab)
  const setSshActiveTab = useSshStore((s) => s.setActiveTab)

  const openSshWindow = useCallback(() => {
    void ipcClient.invoke(IPC.SSH_WINDOW_OPEN)
  }, [])
  const activeSession = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)
  )

  useEffect(() => {
    initTerminal()
  }, [initTerminal])

  useEffect(() => {
    if (!sshLoaded) {
      void loadSsh()
    }
  }, [sshLoaded, loadSsh])

  useEffect(() => {
    if (localTabs.length > 0 || sshOpenTabs.length > 0) return
    void createLocalTab(activeSession?.workingFolder)
  }, [localTabs.length, sshOpenTabs.length, createLocalTab, activeSession?.workingFolder])

  const tabs = useMemo(
    () =>
      buildUnifiedTerminalTabs({
        localTabs,
        sshOpenTabs,
        sshConnections,
        sshSessions
      }),
    [localTabs, sshOpenTabs, sshConnections, sshSessions]
  )

  const activeUnifiedTabId = getUnifiedActiveTerminalTabId(tabs, localActiveTabId, sshActiveTabId)
  const activeTab = tabs.find((tab) => tab.id === activeUnifiedTabId) ?? tabs[0] ?? null

  const handleCreateLocal = (): void => {
    setSshActiveTab(null)
    void createLocalTab(activeSession?.workingFolder)
  }

  const handleCreateSsh = (): void => {
    setSshPickerOpen(true)
  }

  const handleSelectSsh = async (connectionId: string): Promise<void> => {
    setLocalActiveTab(null)
    const tabId = await openSshTerminal(connectionId)
    if (tabId) {
      setSshPickerOpen(false)
    }
  }

  const handleSetActive = (tab: UnifiedTerminalTab): void => {
    if (tab.type === 'local') {
      setSshActiveTab(null)
      setLocalActiveTab(tab.localTabId)
      return
    }

    setLocalActiveTab(null)
    setSshActiveTab(tab.sshTabId)
  }

  const handleClose = async (tab: UnifiedTerminalTab): Promise<void> => {
    if (tab.type === 'local') {
      await closeLocalTab(tab.localTabId)
      return
    }

    if (tab.sessionId) {
      await closeSshSession(tab.sessionId)
      return
    }

    closeSshTab(tab.sshTabId)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/50 bg-background/40">
      <div className="flex shrink-0 items-center justify-between border-b bg-background px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal className="size-4 text-muted-foreground" />
          <span className="truncate text-xs font-medium">终端</span>
          <span className="text-[11px] text-muted-foreground">{tabs.length}</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              title="新建终端"
            >
              <Plus className="size-3.5" />
              新建
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={handleCreateLocal}>
              <SquareTerminal className="size-4" />
              本地终端
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCreateSsh}>
              <MonitorSmartphone className="size-4" />
              SSH 终端
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b bg-background/70 px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden pb-0.5">
          {tabs.length === 0 ? (
            <span className="px-2 text-[11px] text-muted-foreground">还没有终端会话</span>
          ) : (
            tabs.map((tab) => {
              const isActive = tab.id === activeTab?.id
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'group flex h-8 shrink-0 items-center gap-2 rounded-md border px-2.5 text-left transition-colors',
                    isActive
                      ? 'border-primary/30 bg-primary/10 text-foreground'
                      : 'border-transparent bg-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  onClick={() => handleSetActive(tab)}
                  title={`${tab.title} · ${tab.meta}`}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <StatusDot status={tab.status} />
                  <span className="max-w-[120px] truncate text-xs font-medium">{tab.title}</span>
                  <Badge
                    variant="secondary"
                    className="h-4 shrink-0 rounded px-1.5 text-[9px] font-medium tracking-wide"
                  >
                    {tab.badge}
                  </Badge>
                  <span className="max-w-[96px] truncate text-[10px] text-muted-foreground/80">
                    {tab.meta}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted/70 hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleClose(tab)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      event.stopPropagation()
                      void handleClose(tab)
                    }}
                    title="关闭终端"
                  >
                    <X className="size-3" />
                  </span>
                </button>
              )
            })
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              title="更多操作"
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={handleCreateLocal}>
              <SquareTerminal className="size-4" />
              新建本地终端
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCreateSsh}>
              <MonitorSmartphone className="size-4" />
              新建 SSH 终端
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openSshWindow}>
              <FolderOpen className="size-4" />
              打开 SSH 管理页
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: tab.id === activeTab.id ? undefined : 'none' }}
            >
              {tab.type === 'local' ? (
                tab.status === 'running' ? (
                  <LocalTerminal terminalId={tab.localTabId} />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                    {tab.status === 'error' ? (
                      <>
                        <div>终端已退出</div>
                        <div>退出码：{tab.exitCode ?? '-'}</div>
                      </>
                    ) : (
                      <>
                        <Loader2 className="size-4" />
                        <div>终端已结束</div>
                      </>
                    )}
                  </div>
                )
              ) : tab.sessionId ? (
                <SshTerminal sessionId={tab.sessionId} connectionName={tab.connectionName} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <div>SSH 连接中...</div>
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
            <SquareTerminal className="size-10 text-muted-foreground/40" />
            <div>选择一个终端开始使用</div>
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-7 gap-1 text-xs" onClick={handleCreateLocal}>
                <Plus className="size-3.5" />
                本地终端
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={handleCreateSsh}
              >
                <MonitorSmartphone className="size-3.5" />
                SSH 终端
              </Button>
            </div>
          </div>
        )}
      </div>

      {activeTab && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{activeTab.meta}</span>
          <span className="shrink-0 truncate">{activeTab.shell || activeTab.cwd || '-'}</span>
        </div>
      )}

      <SshConnectionPicker
        open={sshPickerOpen}
        loading={!sshLoaded}
        connections={sshConnections}
        onOpenChange={setSshPickerOpen}
        onSelect={(connectionId) => void handleSelectSsh(connectionId)}
        onOpenManagePage={openSshWindow}
      />
    </div>
  )
}
