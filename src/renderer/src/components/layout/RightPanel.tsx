import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Loader2, Terminal } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { useUIStore, type RightPanelTabInstance } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { BROWSER_PLUGIN_ID } from '@renderer/lib/app-plugin/types'
import { cn } from '@renderer/lib/utils'
import {
  findSubAgentInSelection,
  selectSessionScopedAgentState
} from '@renderer/lib/agent/session-scoped-agent-state'
import { RightPanelHeader } from './RightPanelHeader'
import { BrowserPanel } from './BrowserPanel'
import { PreviewPanel } from './PreviewPanel'
import { SubAgentsPanel } from './SubAgentsPanel'
import { SubAgentExecutionDetail } from './SubAgentExecutionDetail'
import { LocalTerminal } from '@renderer/components/terminal/LocalTerminal'
import { SessionChangeReviewPanel } from '@renderer/components/layout/SessionChangeReviewPanel'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { RIGHT_PANEL_DEFAULT_WIDTH, clampRightPanelWidth } from './right-panel-defs'

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
          <LocalTerminal terminalId={process.terminalId} readOnly={!isRunning} />
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

interface RightPanelProps {
  compact?: boolean
  sessionId?: string | null
}

export function RightPanel({ compact = false, sessionId }: RightPanelProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const rightPanelOpen = useUIStore((state) => state.rightPanelOpen)
  const rightPanelWidth = useUIStore((state) => state.rightPanelWidth)
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
  const needsSubAgentTitleLookup =
    rightPanelOpen &&
    rightPanelTabs.some(
      (tab) =>
        tab.kind === 'subagent' &&
        Boolean(tab.toolUseId) &&
        (tab.sessionId ?? panelSessionId) === panelSessionId
    )
  const sessionAgentSelection = useAgentStore((state) =>
    selectSessionScopedAgentState(state, needsSubAgentTitleLookup ? panelSessionId : null, {
      mode: 'coarse'
    })
  )

  const tabs = useMemo(() => {
    const visibleTabs = rightPanelTabs
    if (!rightPanelOpen) return visibleTabs
    return visibleTabs.map((tab) => {
      if (tab.kind === 'review') {
        return { ...tab, title: t('rightPanel.review', { defaultValue: 'Review' }) }
      }
      if (tab.kind === 'browser') {
        return { ...tab, title: t('rightPanel.browser', { defaultValue: 'Browser' }) }
      }
      if (tab.kind !== 'subagent') return tab
      if (!tab.toolUseId) {
        const title = t('subAgentsPanel.title', { defaultValue: 'Task Runs' })
        return title === tab.title ? tab : { ...tab, title }
      }
      const tabSessionId = tab.sessionId ?? panelSessionId
      const agent =
        tabSessionId === panelSessionId
          ? findSubAgentInSelection(sessionAgentSelection, tab.toolUseId)
          : null
      const title = agent?.displayName ?? agent?.name ?? tab.title
      return title === tab.title ? tab : { ...tab, title }
    })
  }, [panelSessionId, rightPanelOpen, rightPanelTabs, sessionAgentSelection, t])
  const selectedTab =
    tabs.find((tab) => tab.id === activeTabId) ??
    tabs.find((tab) => tab.kind === 'review') ??
    tabs[0]
  const hasBrowserTab =
    rightPanelOpen && tabs.some((tab) => tab.kind === 'browser') && browserPluginEnabled
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

  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(rightPanelWidth)
  const [isDragging, setIsDragging] = useState(false)

  const targetPanelWidth = clampRightPanelWidth(
    compact ? Math.min(rightPanelWidth, RIGHT_PANEL_DEFAULT_WIDTH) : rightPanelWidth
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

  const renderActivePanel = (tab: RightPanelTabInstance | undefined): React.ReactNode => {
    if (!tab) return null
    if (tab.kind === 'review') {
      return <SessionChangeReviewPanel />
    }
    if (tab.kind === 'preview') {
      return <PreviewPanel embedded showTabStrip={false} />
    }
    if (tab.kind === 'subagent') {
      return tab.toolUseId ? (
        <SubAgentExecutionDetail
          embedded
          toolUseId={tab.toolUseId}
          inlineText={tab.inlineText ?? undefined}
          sessionId={tab.sessionId ?? panelSessionId}
        />
      ) : (
        <SubAgentsPanel sessionId={tab.sessionId ?? panelSessionId} />
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
              onCloseTab={closeRightPanelTab}
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

              {hasBrowserTab ? (
                <div className={cn('absolute inset-0', activeTab?.kind !== 'browser' && 'hidden')}>
                  <BrowserPanel
                    key={browserPanelKey}
                    sessionId={browserSessionId}
                    projectId={activeProjectId}
                  />
                </div>
              ) : null}
            </div>

            <div
              className="absolute left-0 top-0 bottom-0 z-[60] w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
              onMouseDown={startResize}
            />
          </>
        ) : null}
      </aside>

      {isDragging && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
