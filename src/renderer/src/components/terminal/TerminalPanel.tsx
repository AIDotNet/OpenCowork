import { useEffect } from 'react'
import { Loader2, Plus, SquareTerminal, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { useTerminalStore } from '@renderer/stores/terminal-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { LocalTerminal } from './LocalTerminal'

function StatusDot({ status }: { status: 'running' | 'exited' | 'error' }): React.JSX.Element {
  return (
    <div
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'running'
          ? 'bg-emerald-500'
          : status === 'error'
            ? 'bg-red-500'
            : 'bg-muted-foreground/50'
      )}
    />
  )
}

export function TerminalPanel(): React.JSX.Element {
  const tabs = useTerminalStore((s) => s.tabs)
  const activeTabId = useTerminalStore((s) => s.activeTabId)
  const init = useTerminalStore((s) => s.init)
  const createTab = useTerminalStore((s) => s.createTab)
  const closeTab = useTerminalStore((s) => s.closeTab)
  const setActiveTab = useTerminalStore((s) => s.setActiveTab)
  const activeSession = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)
  )

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    if (tabs.length > 0) return
    void createTab(activeSession?.workingFolder)
  }, [tabs.length, createTab, activeSession?.workingFolder])

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/50 bg-background/40">
      <div className="flex shrink-0 items-center justify-between border-b bg-background px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal className="size-4 text-muted-foreground" />
          <span className="truncate text-xs font-medium">本地终端</span>
          <span className="text-[11px] text-muted-foreground">{tabs.length}</span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={() => void createTab(activeSession?.workingFolder)}
          title="新建终端"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex h-40 shrink-0 flex-col border-b bg-background/70 lg:h-auto lg:w-64 lg:border-b-0 lg:border-r">
          <div className="border-b px-3 py-2 text-[11px] text-muted-foreground">终端会话</div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tabs.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-xs text-muted-foreground">
                <SquareTerminal className="size-10 text-muted-foreground/40" />
                <div>还没有本地终端</div>
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => void createTab(activeSession?.workingFolder)}
                >
                  <Plus className="size-3.5" />
                  新建终端
                </Button>
              </div>
            ) : (
              <div className="p-2">
                {tabs.map((tab) => {
                  const isActive = tab.id === activeTabId
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={cn(
                        'mb-1 flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                        isActive
                          ? 'border-primary/30 bg-primary/10 text-foreground'
                          : 'border-transparent bg-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      <SquareTerminal className="mt-0.5 size-3.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{tab.title}</span>
                          <StatusDot status={tab.status} />
                        </div>
                        <div className="mt-1 truncate text-[11px] text-muted-foreground">{tab.cwd || '-'}</div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {tab.shell || '-'}
                          {typeof tab.exitCode === 'number' ? ` · ${tab.exitCode}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation()
                          void closeTab(tab.id)
                        }}
                        title="关闭终端"
                      >
                        <X className="size-3" />
                      </button>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {activeTab ? (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{ display: tab.id === activeTabId ? undefined : 'none' }}
              >
                {tab.status === 'running' ? (
                  <LocalTerminal terminalId={tab.id} />
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
                )}
              </div>
            ))
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              <SquareTerminal className="size-10 text-muted-foreground/40" />
              <div>选择一个终端开始使用</div>
            </div>
          )}
        </div>
      </div>

      {activeTab && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span className="truncate">{activeTab.cwd || '-'}</span>
          <span className="shrink-0">{activeTab.shell || '-'}</span>
        </div>
      )}
    </div>
  )
}
