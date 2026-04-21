import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, MonitorSmartphone, Plus, SquareTerminal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import {
  ensureProjectTerminalReady,
  getProjectTerminalBaseTitle
} from '@renderer/lib/terminal/project-terminal-context'
import {
  buildSshTerminalTitle,
  buildUnifiedTerminalTabs,
  getUnifiedActiveTerminalTabId,
  type UnifiedTerminalTab
} from '@renderer/lib/terminal/unified-terminal-tabs'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useTerminalStore } from '@renderer/stores/terminal-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { LocalTerminal } from './LocalTerminal'
import { SshTerminal } from '../ssh/SshTerminal'

const PROJECT_TERMINAL_DOCK_HEIGHT = 220

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
              : 'bg-muted-foreground/45'
      )}
    />
  )
}

interface ProjectTerminalDockProps {
  projectId: string
  projectName?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
}

export function ProjectTerminalDock({
  projectId,
  projectName,
  workingFolder,
  sshConnectionId
}: ProjectTerminalDockProps): React.JSX.Element {
  const { t } = useTranslation('layout')

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

  const setBottomTerminalDockOpen = useUIStore((s) => s.setBottomTerminalDockOpen)
  const [isEnsuringTerminal, setIsEnsuringTerminal] = useState(false)

  useEffect(() => {
    initTerminal()
  }, [initTerminal])

  useEffect(() => {
    if (!sshLoaded) {
      void loadSsh()
    }
  }, [sshLoaded, loadSsh])

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
  const activeTab = tabs.find((tab) => tab.id === activeUnifiedTabId) ?? null
  const currentConnection = sshConnectionId
    ? (sshConnections.find((connection) => connection.id === sshConnectionId) ?? null)
    : null
  const ensureContextKeyRef = useRef<string | null>(null)

  const activateLocalTab = useCallback(
    (tabId: string | null): void => {
      setSshActiveTab(null)
      setLocalActiveTab(tabId)
    },
    [setLocalActiveTab, setSshActiveTab]
  )

  const activateSshTab = useCallback(
    (tabId: string | null): void => {
      setLocalActiveTab(null)
      setSshActiveTab(tabId)
    },
    [setLocalActiveTab, setSshActiveTab]
  )

  const focusContextTerminal = useCallback(async (): Promise<void> => {
    if (!sshConnectionId && !workingFolder) return

    setIsEnsuringTerminal(true)
    try {
      await ensureProjectTerminalReady({
        projectName,
        workingFolder,
        sshConnectionId
      })
    } finally {
      setIsEnsuringTerminal(false)
    }
  }, [projectName, sshConnectionId, workingFolder])

  useEffect(() => {
    if (sshConnectionId && !sshLoaded) return
    if (!sshConnectionId && !workingFolder) return

    const contextKey = `${projectId}:${sshConnectionId ?? ''}:${workingFolder ?? ''}`
    if (ensureContextKeyRef.current === contextKey) return

    ensureContextKeyRef.current = contextKey
    void focusContextTerminal()
  }, [projectId, sshConnectionId, sshLoaded, workingFolder, focusContextTerminal])

  const contextLabel = sshConnectionId
    ? currentConnection?.name ||
      buildSshTerminalTitle(currentConnection, projectName || t('terminalDock.sshContext'))
    : getProjectTerminalBaseTitle(projectName, workingFolder)

  const handleCreateTerminal = useCallback((): void => {
    if (sshConnectionId) {
      activateLocalTab(null)
      void openSshTerminal(sshConnectionId)
      return
    }

    if (!workingFolder) return
    activateSshTab(null)
    void createLocalTab(workingFolder, getProjectTerminalBaseTitle(projectName, workingFolder))
  }, [
    sshConnectionId,
    activateLocalTab,
    openSshTerminal,
    workingFolder,
    activateSshTab,
    createLocalTab,
    projectName
  ])

  const handleSetActive = useCallback(
    (tab: UnifiedTerminalTab): void => {
      if (tab.type === 'local') {
        activateLocalTab(tab.localTabId)
        return
      }

      activateSshTab(tab.sshTabId)
    },
    [activateLocalTab, activateSshTab]
  )

  const handleCloseTab = useCallback(
    async (tab: UnifiedTerminalTab): Promise<void> => {
      if (tab.type === 'local') {
        await closeLocalTab(tab.localTabId)
        return
      }

      if (tab.sessionId) {
        await closeSshSession(tab.sessionId)
        return
      }

      closeSshTab(tab.sshTabId)
    },
    [closeLocalTab, closeSshSession, closeSshTab]
  )

  return (
    <div className="shrink-0 border-t border-border/55 bg-background/95 backdrop-blur-sm">
      <div className="flex flex-col" style={{ height: PROJECT_TERMINAL_DOCK_HEIGHT }}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/45 px-3">
          <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
            <div className="flex min-w-max items-center gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'group inline-flex h-7 items-center gap-2 rounded-[10px] px-2.5 text-xs transition-colors',
                    tab.id === activeTab?.id
                      ? 'bg-muted text-foreground shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  onClick={() => handleSetActive(tab)}
                  title={`${tab.title} · ${tab.meta}`}
                >
                  {tab.type === 'ssh' ? (
                    <MonitorSmartphone className="size-3.5 shrink-0" />
                  ) : (
                    <SquareTerminal className="size-3.5 shrink-0" />
                  )}
                  <StatusDot status={tab.status} />
                  <span className="max-w-[120px] truncate">{tab.title}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted/70 hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleCloseTab(tab)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      event.stopPropagation()
                      void handleCloseTab(tab)
                    }}
                    title={t('terminalDock.closeTerminal')}
                  >
                    <X className="size-3" />
                  </span>
                </button>
              ))}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-7 rounded-[10px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    onClick={handleCreateTerminal}
                    disabled={!sshConnectionId && !workingFolder}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('terminalDock.newTerminal')}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-[10px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  onClick={() => setBottomTerminalDockOpen(projectId, false)}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('terminalDock.collapse')}</TooltipContent>
            </Tooltip>
          </div>
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
                    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-xs text-muted-foreground">
                      <div>
                        {tab.status === 'error'
                          ? t('terminalDock.terminalExitedWithError')
                          : t('terminalDock.terminalExited')}
                      </div>
                      {typeof tab.exitCode === 'number' ? (
                        <div className="text-[11px] text-muted-foreground/75">
                          {t('terminalDock.exitCode', { code: tab.exitCode })}
                        </div>
                      ) : null}
                    </div>
                  )
                ) : tab.sessionId ? (
                  <SshTerminal sessionId={tab.sessionId} connectionName={tab.connectionName} />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {t('terminalDock.connecting')}
                  </div>
                )}
              </div>
            ))
          ) : isEnsuringTerminal ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
              {t('terminalDock.connecting')}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs text-muted-foreground">
              <div>{contextLabel}</div>
              <div>{t('terminalDock.empty')}</div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-[10px] px-3 text-xs"
                onClick={handleCreateTerminal}
                disabled={!sshConnectionId && !workingFolder}
              >
                <Plus className="size-3.5" />
                {t('terminalDock.newTerminal')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
