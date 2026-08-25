import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Loader2, MonitorSmartphone, PanelRight, Plus, Terminal } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { useUIStore, type RightPanelTabInstance } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useTerminalStore } from '@renderer/stores/terminal-store'
import { BROWSER_PLUGIN_ID } from '@renderer/lib/app-plugin/types'
import { cn } from '@renderer/lib/utils'
import { AuxiliaryDrawerHost } from '@renderer/components/workbench/AuxiliaryDrawerHost'
import { RightPanelHeader } from './RightPanelHeader'
import { BrowserPanel } from './BrowserPanel'
import { PreviewPanel } from './PreviewPanel'
import { SubAgentsPanel } from './SubAgentsPanel'
import { AgentFilesPanel } from './AgentFilesPanel'
import { SessionChangeReviewPanel } from '@renderer/components/layout/SessionChangeReviewPanel'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  clampRightPanelWidth,
  getPlanReviewRightPanelWidth
} from './right-panel-defs'

const LocalTerminal = React.lazy(() =>
  import('@renderer/components/terminal/LocalTerminal').then((m) => ({ default: m.LocalTerminal }))
)
const SshTerminal = React.lazy(() =>
  import('@renderer/components/ssh/SshTerminal').then((m) => ({ default: m.SshTerminal }))
)

function TerminalTabContent({ processId }: { processId: string }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const process = useAgentStore((state) => state.backgroundProcesses[processId])
  const sendBackgroundProcessInput = useAgentStore((state) => state.sendBackgroundProcessInput)
  const stopBackgroundProcess = useAgentStore((state) => state.stopBackgroundProcess)

  if (!process) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <Terminal className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t('detailPanel.terminalNotFound')}</p>
      </div>
    )
  }

  const isRunning = process.status === 'running'
  const statusText =
    process.status === 'running'
      ? t('detailPanel.running')
      : process.status === 'stopped'
        ? t('detailPanel.stopped')
        : process.status === 'error'
          ? t('detailPanel.error')
          : t('detailPanel.exited')

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant={isRunning ? 'default' : 'secondary'}
            className={cn('h-5 text-[10px]', isRunning && 'bg-emerald-500')}
          >
            {statusText}
          </Badge>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {process.command}
          </span>
        </div>
        {process.cwd ? (
          <div className="mt-1 truncate text-[11px] text-muted-foreground/75">{process.cwd}</div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-zinc-950">
        {process.terminalId ? (
          <React.Suspense fallback={null}>
            <LocalTerminal terminalId={process.terminalId} readOnly={!isRunning} />
          </React.Suspense>
        ) : (
          <div className="size-full overflow-auto px-3 py-2 font-mono text-[11px] leading-5 text-zinc-200 whitespace-pre-wrap break-words">
            {process.output || '[no output yet]'}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={!isRunning}
          onClick={() => void sendBackgroundProcessInput(processId, '\u0003', false)}
        >
          {t('detailPanel.sendCtrlC')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 text-xs"
          disabled={!isRunning}
          onClick={() => void stopBackgroundProcess(processId)}
        >
          {t('detailPanel.stopProcess')}
        </Button>
      </div>
    </div>
  )
}

function ProjectTerminalTabContent({
  tab,
  onMoveToBottom
}: {
  tab: RightPanelTabInstance
  onMoveToBottom: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const localTabs = useTerminalStore((state) => state.tabs)
  const sshOpenTabs = useSshStore((state) => state.openTabs)
  const ensureProjectTerminal = useUIStore((state) => state.ensureProjectTerminalRightPanelTab)

  const localTab = useTerminalStore((state) =>
    tab.terminalSource === 'local' && tab.localTabId
      ? (state.tabs.find((item) => item.id === tab.localTabId) ?? null)
      : null
  )
  const sshTab = useSshStore((state) =>
    tab.terminalSource === 'ssh' && tab.sshTabId
      ? (state.openTabs.find((item) => item.id === tab.sshTabId) ?? null)
      : null
  )
  const sshSession = useSshStore((state) =>
    sshTab?.sessionId ? (state.sessions[sshTab.sessionId] ?? null) : null
  )

  const handleCreateNewTerminal = async (): Promise<void> => {
    const newTabId = await useTerminalStore
      .getState()
      .createTab(undefined, undefined, undefined, tab.projectId ?? undefined)
    if (newTabId) {
      ensureProjectTerminal({
        terminalSource: 'local',
        localTabId: newTabId,
        title: 'Terminal',
        projectId: tab.projectId
      })
    }
  }

  const handleSelectLocalTerminal = (targetLocalTabId: string, title: string): void => {
    ensureProjectTerminal({
      terminalSource: 'local',
      localTabId: targetLocalTabId,
      title,
      projectId: tab.projectId
    })
  }

  const handleSelectSshTerminal = (targetSshTabId: string, title: string): void => {
    ensureProjectTerminal({
      terminalSource: 'ssh',
      sshTabId: targetSshTabId,
      title,
      projectId: tab.projectId
    })
  }

  const activeTitle =
    tab.terminalSource === 'local'
      ? localTab?.title || 'Terminal'
      : sshTab?.title || sshTab?.connectionName || 'SSH Terminal'
  const activeSubtitle =
    tab.terminalSource === 'local'
      ? localTab?.cwd || localTab?.shell || '-'
      : sshTab?.connectionName || '-'

  const totalTerminals = localTabs.length + sshOpenTabs.length

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Tier 2 Context Sub-Header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/50 bg-background/80 px-3 text-xs backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-3.5 text-emerald-400" />
          <span className="truncate font-medium text-foreground">{activeTitle}</span>
          <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
            {activeSubtitle}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onMoveToBottom}
          >
            {t('terminalDock.moveToBottomDock')}
          </Button>

          <Button
            variant={drawerOpen ? 'secondary' : 'ghost'}
            size="icon"
            className="size-6 rounded text-muted-foreground hover:text-foreground"
            onClick={() => setDrawerOpen((prev) => !prev)}
            title="Toggle Terminals List"
          >
            <PanelRight className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Main Terminal View & Auxiliary Drawer */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab.terminalSource === 'local' ? (
            !localTab ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <Terminal className="mb-3 size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{t('detailPanel.terminalNotFound')}</p>
              </div>
            ) : localTab.status === 'running' ? (
              <React.Suspense fallback={null}>
                <LocalTerminal terminalId={localTab.id} />
              </React.Suspense>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <Terminal className="size-8 text-muted-foreground/40" />
                <div>
                  {localTab.status === 'error'
                    ? t('terminalDock.terminalExitedWithError')
                    : t('terminalDock.terminalExited')}
                </div>
                {localTab.exitCode !== undefined ? (
                  <div>{t('terminalDock.exitCode', { code: localTab.exitCode })}</div>
                ) : null}
              </div>
            )
          ) : !sshTab ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <MonitorSmartphone className="mb-3 size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('detailPanel.terminalNotFound')}</p>
            </div>
          ) : sshTab.sessionId && sshSession?.status === 'connected' ? (
            <React.Suspense fallback={null}>
              <SshTerminal sessionId={sshTab.sessionId} connectionName={sshTab.connectionName} />
            </React.Suspense>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className={cn('size-4', sshTab.sessionId ? '' : 'animate-spin')} />
              <div>
                {sshTab.sessionId ? t('terminalDock.terminalExited') : t('terminalDock.connecting')}
              </div>
            </div>
          )}
        </div>

        <AuxiliaryDrawerHost
          open={drawerOpen}
          title={`${totalTerminals} Terminal${totalTerminals > 1 ? 's' : ''}`}
          width={200}
          onClose={() => setDrawerOpen(false)}
          actions={
            <Button
              variant="ghost"
              size="icon"
              className="size-5 rounded p-0 text-muted-foreground hover:text-foreground"
              onClick={handleCreateNewTerminal}
              title="New Terminal"
            >
              <Plus className="size-3" />
            </Button>
          }
        >
          <div className="space-y-0.5 p-1.5">
            {localTabs.map((lTab) => {
              const isSelected = tab.terminalSource === 'local' && tab.localTabId === lTab.id
              const isRunning = lTab.status === 'running'
              return (
                <div
                  key={lTab.id}
                  onClick={() => handleSelectLocalTerminal(lTab.id, lTab.title)}
                  className={cn(
                    'group flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-xs transition-colors',
                    isSelected
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        isRunning ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                      )}
                    />
                    <span className="truncate">{lTab.title}</span>
                  </div>
                </div>
              )
            })}

            {sshOpenTabs.map((sTab) => {
              const isSelected = tab.terminalSource === 'ssh' && tab.sshTabId === sTab.id
              return (
                <div
                  key={sTab.id}
                  onClick={() =>
                    handleSelectSshTerminal(sTab.id, sTab.title || sTab.connectionName)
                  }
                  className={cn(
                    'group flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-xs transition-colors',
                    isSelected
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <MonitorSmartphone className="size-3 text-sky-400" />
                    <span className="truncate">{sTab.title || sTab.connectionName}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </AuxiliaryDrawerHost>
      </div>
    </div>
  )
}

interface RightPanelProps {
  compact?: boolean
  sessionId?: string | null
}

export function RightPanel({ compact = false, sessionId }: RightPanelProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const rightPanelOpen = useUIStore((state) => state.rightPanelOpen)
  const rightPanelWidth = useUIStore((state) => state.rightPanelWidth)
  const rightPanelExpandedForReading = useUIStore((state) => state.rightPanelExpandedForReading)
  const rightPanelTabs = useUIStore((state) => state.rightPanelTabs)
  const activeTabId = useUIStore((state) => state.rightPanelActiveTabId)
  const setRightPanelOpen = useUIStore((state) => state.setRightPanelOpen)
  const setRightPanelWidth = useUIStore((state) => state.setRightPanelWidth)
  const setRightPanelActiveTab = useUIStore((state) => state.setRightPanelActiveTab)
  const closeRightPanelTab = useUIStore((state) => state.closeRightPanelTab)
  const ensureBrowserTab = useUIStore((state) => state.ensureBrowserTab)
  const openFilePreview = useUIStore((state) => state.openFilePreview)
  const activeScopedSessionId = useUIStore((state) => state.activeScopedSessionId)

  const activeProjectId = useChatStore((state) => {
    const targetSessionId = sessionId ?? activeScopedSessionId ?? state.activeSessionId
    const targetSession = targetSessionId
      ? state.sessions.find((item) => item.id === targetSessionId)
      : null
    return targetSession?.projectId ?? state.activeProjectId
  })
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const panelSessionId = sessionId ?? activeScopedSessionId ?? activeSessionId ?? null
  const browserPluginEnabled = useAppPluginStore((state) =>
    Boolean(state.getPlugin(BROWSER_PLUGIN_ID, activeProjectId)?.enabled)
  )
  const tabs = useMemo(() => {
    const visibleTabs = rightPanelTabs
    if (!rightPanelOpen) return visibleTabs
    return visibleTabs.map((tab) => {
      if (tab.kind === 'review') {
        return { ...tab, title: t('rightPanel.review', { defaultValue: 'Review' }) }
      }
      if (tab.kind === 'files') {
        return { ...tab, title: t('rightPanel.files', { defaultValue: 'Files' }) }
      }
      if (tab.kind === 'browser') {
        return { ...tab, title: t('rightPanel.browser', { defaultValue: 'Browser' }) }
      }
      if (tab.kind !== 'subagent') return tab
      const title = t('subAgentsPanel.title', { defaultValue: 'SubAgents' })
      return title === tab.title ? tab : { ...tab, title }
    })
  }, [rightPanelOpen, rightPanelTabs, t])
  const selectedTab =
    tabs.find((tab) => tab.id === activeTabId) ??
    tabs.find((tab) => tab.kind === 'review') ??
    tabs[0]
  // The browser webview stays mounted whenever a browser tab exists and the plugin
  // is enabled — independent of whether the panel is open. This lets agent-driven
  // browser tools keep working in the background even while the panel is collapsed
  // (the webview's guest page keeps running; we only toggle its visibility).
  const browserTabAlive = tabs.some((tab) => tab.kind === 'browser') && browserPluginEnabled
  const browserSessionId = panelSessionId
  const browserPanelKey = browserSessionId
    ? `session:${browserSessionId}`
    : activeProjectId
      ? `project:${activeProjectId}`
      : 'global'
  const activeTab = rightPanelOpen
    ? selectedTab?.kind === 'browser' && !browserPluginEnabled
      ? (tabs.find((tab) => tab.kind === 'review') ?? selectedTab)
      : selectedTab
    : undefined
  const browserVisible = rightPanelOpen && activeTab?.kind === 'browser'

  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(rightPanelWidth)
  const [isDragging, setIsDragging] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  )

  useEffect(() => {
    if (!rightPanelExpandedForReading) return
    const handleResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    handleResize()
    return () => window.removeEventListener('resize', handleResize)
  }, [rightPanelExpandedForReading])

  const readingWidth = rightPanelExpandedForReading
    ? getPlanReviewRightPanelWidth(viewportWidth)
    : 0
  const targetPanelWidth = clampRightPanelWidth(
    compact
      ? Math.min(rightPanelWidth, RIGHT_PANEL_DEFAULT_WIDTH)
      : Math.max(rightPanelWidth, readingWidth)
  )

  useEffect(() => {
    if (rightPanelWidth === 0) setRightPanelWidth(RIGHT_PANEL_DEFAULT_WIDTH)
  }, [rightPanelWidth, setRightPanelWidth])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = startXRef.current - event.clientX
      setRightPanelWidth(clampRightPanelWidth(startWidthRef.current + delta))
    }

    const handleMouseUp = (): void => {
      draggingRef.current = false
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, setRightPanelWidth])

  const startResize = (event: React.MouseEvent): void => {
    if (!rightPanelOpen) return
    event.preventDefault()
    draggingRef.current = true
    startXRef.current = event.clientX
    startWidthRef.current = targetPanelWidth
    setIsDragging(true)
  }

  const handleOpenLocalFiles = async (): Promise<void> => {
    const result = (await ipcClient.invoke(IPC.FS_SELECT_FILE, {
      multiSelections: true
    })) as { canceled?: boolean; path?: string; paths?: string[] }
    if (result.canceled) return

    const selectedPaths = result.paths?.length ? result.paths : result.path ? [result.path] : []
    for (const selectedPath of selectedPaths) {
      openFilePreview(selectedPath)
    }
  }

  const restoreProjectTerminalToBottom = (tab: RightPanelTabInstance | undefined): void => {
    if (tab?.kind !== 'terminal' || !tab.terminalSource) return
    if (tab.terminalSource === 'local' && tab.localTabId) {
      useTerminalStore.getState().setTabSurface(tab.localTabId, 'bottom')
    } else if (tab.terminalSource === 'ssh' && tab.sshTabId) {
      useSshStore.getState().setTabSurface(tab.sshTabId, 'bottom')
    }
    if (tab.projectId) {
      useUIStore.getState().setBottomTerminalDockOpen(tab.projectId, true)
    }
  }

  const closeProjectTerminalSession = (tab: RightPanelTabInstance | undefined): void => {
    if (tab?.kind !== 'terminal' || !tab.terminalSource) return
    if (tab.terminalSource === 'local' && tab.localTabId) {
      void useTerminalStore.getState().closeTab(tab.localTabId)
      return
    }
    if (tab.terminalSource === 'ssh' && tab.sshTabId) {
      const sshTab = useSshStore.getState().openTabs.find((item) => item.id === tab.sshTabId)
      if (sshTab?.sessionId) {
        void useSshStore.getState().disconnect(sshTab.sessionId)
      } else {
        useSshStore.getState().closeTab(tab.sshTabId)
      }
    }
  }

  const handleCloseRightPanelTab = (tabId: string): void => {
    const tab = rightPanelTabs.find((item) => item.id === tabId)
    closeProjectTerminalSession(tab)
    closeRightPanelTab(tabId)
  }

  const renderActivePanel = (tab: RightPanelTabInstance | undefined): React.ReactNode => {
    if (!tab) return null
    if (tab.kind === 'review') {
      return (
        <SessionChangeReviewPanel
          initialChangeId={tab.initialChangeId}
          selectionRequestId={tab.selectionRequestId}
        />
      )
    }
    if (tab.kind === 'files') {
      return (
        <AgentFilesPanel
          sessionId={tab.sessionId ?? panelSessionId}
          surface="right-panel"
          initialTab={tab.initialChangeId ? 'changes' : 'files'}
        />
      )
    }
    if (tab.kind === 'preview') {
      return <PreviewPanel embedded showTabStrip={false} />
    }
    if (tab.kind === 'subagent') {
      return <SubAgentsPanel sessionId={tab.sessionId ?? panelSessionId} />
    }
    if (tab.kind === 'terminal' && tab.terminalSource) {
      return (
        <ProjectTerminalTabContent
          tab={tab}
          onMoveToBottom={() => {
            restoreProjectTerminalToBottom(tab)
            closeRightPanelTab(tab.id)
          }}
        />
      )
    }
    if (tab.kind === 'terminal' && tab.processId) {
      return <TerminalTabContent processId={tab.processId} />
    }
    if (tab.kind === 'browser') return null

    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t('thinking.thinkingEllipsis', { ns: 'chat', defaultValue: 'Loading...' })}
      </div>
    )
  }

  return (
    <div
      data-tour="right-panel"
      className="relative z-40 h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: rightPanelOpen ? targetPanelWidth : 0 }}
    >
      <aside
        className={cn(
          'relative flex h-full w-full flex-col border-l border-border/60 bg-background shadow-[-18px_0_42px_rgba(0,0,0,0.16)] transition-[opacity,transform] duration-300 ease-out',
          rightPanelOpen
            ? 'translate-x-0 opacity-100'
            : 'pointer-events-none translate-x-full opacity-0'
        )}
      >
        {rightPanelOpen ? (
          <>
            <RightPanelHeader
              tabs={tabs}
              activeTabId={activeTab?.id ?? 'review'}
              browserEnabled={browserPluginEnabled}
              onSelectTab={setRightPanelActiveTab}
              onCloseTab={handleCloseRightPanelTab}
              onOpenFiles={() => void handleOpenLocalFiles()}
              onAddBrowser={() => ensureBrowserTab(undefined, panelSessionId)}
              onClosePanel={() => setRightPanelOpen(false)}
              t={t}
            />

            <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
              <AnimatePresence mode="wait">
                {activeTab?.kind !== 'browser' ? (
                  <motion.div
                    key={activeTab?.id ?? 'empty'}
                    className="absolute inset-0 min-h-0"
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -6 }}
                    transition={{ duration: 0.16, ease: 'easeOut' }}
                  >
                    {renderActivePanel(activeTab)}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            <div
              className="absolute left-0 top-0 bottom-0 z-[60] w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
              onMouseDown={startResize}
            />
          </>
        ) : null}

        {/* Persistent browser layer: mounted whenever a browser tab exists so the
            webview keeps running even when the panel is closed or another tab is
            active. `top-10` clears the tab header when visible. When hidden it stays
            in the DOM (webview connected) but non-interactive and transparent. */}
        {browserTabAlive ? (
          <div
            className={cn(
              'absolute inset-x-0 bottom-0 top-10',
              browserVisible ? 'z-10 opacity-100' : 'pointer-events-none -z-10 opacity-0'
            )}
          >
            <BrowserPanel
              key={browserPanelKey}
              sessionId={browserSessionId}
              projectId={activeProjectId}
            />
          </div>
        ) : null}
      </aside>

      {isDragging && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
