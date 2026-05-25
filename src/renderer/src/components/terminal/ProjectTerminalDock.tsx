import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, MonitorSmartphone, Plus, SquareTerminal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  BOTTOM_TERMINAL_DOCK_MAX_HEIGHT,
  BOTTOM_TERMINAL_DOCK_MIN_HEIGHT,
  clampBottomTerminalDockHeight
} from '@renderer/components/layout/right-panel-defs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
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

function getViewportTerminalDockMaxHeight(): number {
  if (typeof window === 'undefined') return BOTTOM_TERMINAL_DOCK_MAX_HEIGHT
  return Math.max(
    BOTTOM_TERMINAL_DOCK_MIN_HEIGHT,
    Math.min(BOTTOM_TERMINAL_DOCK_MAX_HEIGHT, Math.floor(window.innerHeight * 0.72))
  )
}

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
  const bottomTerminalDockHeight = useUIStore((s) => s.bottomTerminalDockHeight)
  const setBottomTerminalDockHeight = useUIStore((s) => s.setBottomTerminalDockHeight)
  const [isEnsuringTerminal, setIsEnsuringTerminal] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const resizeActiveRef = useRef(false)
  const resizeStartYRef = useRef(0)
  const resizeStartHeightRef = useRef(bottomTerminalDockHeight)

  useEffect(() => {
    initTerminal()
  }, [initTerminal])

  useEffect(() => {
    if (!sshLoaded) {
      void loadSsh()
    }
  }, [sshLoaded, loadSsh])

  useEffect(() => {
    const handleWindowResize = (): void => {
      const nextHeight = clampBottomTerminalDockHeight(
        useUIStore.getState().bottomTerminalDockHeight,
        getViewportTerminalDockMaxHeight()
      )
      setBottomTerminalDockHeight(nextHeight)
    }

    window.addEventListener('resize', handleWindowResize)
    handleWindowResize()
    return () => {
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [setBottomTerminalDockHeight])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (event: MouseEvent): void => {
      if (!resizeActiveRef.current) return
      const delta = resizeStartYRef.current - event.clientY
      const nextHeight = resizeStartHeightRef.current + delta
      setBottomTerminalDockHeight(
        clampBottomTerminalDockHeight(nextHeight, getViewportTerminalDockMaxHeight())
      )
    }

    const handleMouseUp = (): void => {
      resizeActiveRef.current = false
      setIsResizing(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, setBottomTerminalDockHeight])

  const projectLocalTabs = useMemo(
    () => localTabs.filter((tab) => tab.projectId === projectId),
    [localTabs, projectId]
  )
  const projectSshTabs = useMemo(
    () => sshOpenTabs.filter((tab) => tab.type === 'terminal' && tab.projectId === projectId),
    [projectId, sshOpenTabs]
  )

  const tabs = useMemo(
    () =>
      buildUnifiedTerminalTabs({
        localTabs: projectLocalTabs,
        sshOpenTabs: projectSshTabs,
        sshConnections,
        sshSessions
      }),
    [projectLocalTabs, projectSshTabs, sshConnections, sshSessions]
  )

  const scopedLocalActiveTabId = projectLocalTabs.some((tab) => tab.id === localActiveTabId)
    ? localActiveTabId
    : null
  const scopedSshActiveTabId = projectSshTabs.some((tab) => tab.id === sshActiveTabId)
    ? sshActiveTabId
    : null
  const activeUnifiedTabId = getUnifiedActiveTerminalTabId(
    tabs,
    scopedLocalActiveTabId,
    scopedSshActiveTabId
  )
  const activeTab = tabs.find((tab) => tab.id === activeUnifiedTabId) ?? null
  const currentConnection = sshConnectionId
    ? (sshConnections.find((connection) => connection.id === sshConnectionId) ?? null)
    : null
  const ensureContextKeyRef = useRef<string | null>(null)
  const hasManuallyCreatedTerminalRef = useRef(false)

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

    const hasExistingContextTerminal = sshConnectionId
      ? projectSshTabs.some((tab) => tab.connectionId === sshConnectionId)
      : projectLocalTabs.some((tab) => tab.cwd === workingFolder)

    if (!hasExistingContextTerminal) {
      setIsEnsuringTerminal(true)
    }

    try {
      await ensureProjectTerminalReady({
        projectId,
        projectName,
        workingFolder,
        sshConnectionId
      })
    } finally {
      if (!hasExistingContextTerminal) {
        setIsEnsuringTerminal(false)
      }
    }
  }, [projectId, projectLocalTabs, projectName, projectSshTabs, sshConnectionId, workingFolder])

  useEffect(() => {
    if (sshConnectionId && !sshLoaded) return
    if (!sshConnectionId && !workingFolder) return

    const contextKey = `${projectId}:${sshConnectionId ?? ''}:${workingFolder ?? ''}`
    if (ensureContextKeyRef.current === contextKey || hasManuallyCreatedTerminalRef.current) return

    ensureContextKeyRef.current = contextKey
    void focusContextTerminal()
  }, [projectId, sshConnectionId, sshLoaded, workingFolder, focusContextTerminal])

  const contextLabel = sshConnectionId
    ? currentConnection?.name ||
      buildSshTerminalTitle(currentConnection, projectName || t('terminalDock.sshContext'))
    : getProjectTerminalBaseTitle(projectName, workingFolder)

  const handleCreateTerminal = useCallback(
    (initialCommand?: string): void => {
      hasManuallyCreatedTerminalRef.current = true

      if (sshConnectionId) {
        activateLocalTab(null)
        void (async () => {
          const tabId = await openSshTerminal(sshConnectionId, projectId)
          if (!tabId || !initialCommand) return
          const command = initialCommand.trim()
          if (!command) return
          const sessionId = tabId.startsWith('tab-') ? tabId.slice(4) : null
          if (!sessionId) return
          setTimeout(() => {
            ipcClient.send(IPC.SSH_DATA, { sessionId, data: `${command}\r` })
          }, 600)
        })()
        return
      }

      if (!workingFolder) return
      activateSshTab(null)
      void createLocalTab(
        workingFolder,
        getProjectTerminalBaseTitle(projectName, workingFolder),
        initialCommand,
        projectId
      )
    },
    [
      sshConnectionId,
      activateLocalTab,
      openSshTerminal,
      projectId,
      workingFolder,
      activateSshTab,
      createLocalTab,
      projectName
    ]
  )

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
      } else if (tab.sessionId) {
        await closeSshSession(tab.sessionId)
      } else {
        closeSshTab(tab.sshTabId)
      }

      if (tabs.length <= 1) {
        setBottomTerminalDockOpen(projectId, false)
      }
    },
    [closeLocalTab, closeSshSession, closeSshTab, projectId, setBottomTerminalDockOpen, tabs.length]
  )

  const startResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      event.preventDefault()
      resizeActiveRef.current = true
      resizeStartYRef.current = event.clientY
      resizeStartHeightRef.current = bottomTerminalDockHeight
      setIsResizing(true)
    },
    [bottomTerminalDockHeight]
  )

  return (
    <div
      className={cn(
        'workspace-terminal-dock relative shrink-0',
        isResizing && 'workspace-terminal-dock--resizing select-none'
      )}
    >
      <div className="workspace-terminal-resize-handle" onMouseDown={startResize} />
      <div className="flex flex-col" style={{ height: bottomTerminalDockHeight }}>
        <div className="workspace-terminal-header flex h-10 shrink-0 items-center gap-2 px-3">
          <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
            <div className="flex min-w-max items-center gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'workspace-terminal-tab group inline-flex h-7 items-center gap-2 rounded-[10px] px-2.5 text-xs transition-colors',
                    tab.id === activeTab?.id && 'workspace-terminal-tab--active'
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
                    className="workspace-terminal-action shrink-0 rounded p-0.5 transition-colors"
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
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="workspace-terminal-action size-7 rounded-[10px]"
                        disabled={!sshConnectionId && !workingFolder}
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t('terminalDock.newTerminal')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem onClick={() => handleCreateTerminal()}>
                    {t('terminalDock.newTerminal')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleCreateTerminal('claude')}>
                    {t('terminalDock.newClaude')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleCreateTerminal('codex')}>
                    {t('terminalDock.newCodex')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleCreateTerminal('gemini')}>
                    {t('terminalDock.newGemini')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="workspace-terminal-action size-7 rounded-[10px]"
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
                onClick={() => handleCreateTerminal()}
                disabled={!sshConnectionId && !workingFolder}
              >
                <Plus className="size-3.5" />
                {t('terminalDock.newTerminal')}
              </Button>
            </div>
          )}
        </div>
      </div>
      {isResizing && <div className="fixed inset-0 z-[100] cursor-row-resize" />}
    </div>
  )
}
