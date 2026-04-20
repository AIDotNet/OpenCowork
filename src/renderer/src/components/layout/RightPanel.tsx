import { Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { FadeIn } from '@renderer/components/animate-ui'
import { useUIStore, type RightPanelTab } from '@renderer/stores/ui-store'
import { ArtifactsPanel } from '@renderer/components/cowork/ArtifactsPanel'
import { ContextPanel } from '@renderer/components/cowork/ContextPanel'
import { FileTreePanel } from '@renderer/components/cowork/FileTreePanel'
import { SshFileExplorer } from '@renderer/components/ssh/SshFileExplorer'
import { TerminalPanel } from '@renderer/components/terminal/TerminalPanel'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { TASK_TOOL_NAME } from '@renderer/lib/agent/sub-agents/create-tool'
import { isProjectSession } from '@renderer/lib/session-scope'
import { cn } from '@renderer/lib/utils'
import { RightPanelHeader } from './RightPanelHeader'
import { PreviewPanel } from './PreviewPanel'
import { BrowserPanel } from './BrowserPanel'
import { DetailPanel } from './DetailPanel'
import { SubAgentsPanel } from './SubAgentsPanel'
import { SubAgentExecutionDetail } from './SubAgentExecutionDetail'
import { OrchestrationConsole } from './OrchestrationConsole'
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_SECTION_DEFS,
  RIGHT_PANEL_TAB_DEFS,
  clampRightPanelWidth
} from './right-panel-defs'

function SshFilesPanel({
  connectionId,
  rootPath
}: {
  connectionId: string
  rootPath?: string
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const sessions = useSshStore((s) => s.sessions)
  const connect = useSshStore((s) => s.connect)

  const connectedSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'connected'
  )
  const connectingSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'connecting'
  )
  const errorSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'error'
  )
  const error = errorSession?.error ?? null

  useEffect(() => {
    if (connectedSession || connectingSession || errorSession) return
    void connect(connectionId)
  }, [connectedSession, connectingSession, errorSession, connect, connectionId])

  if (connectedSession) {
    return (
      <div className="h-full overflow-hidden rounded-md border border-border/50 bg-background/40">
        <SshFileExplorer
          sessionId={connectedSession.id}
          connectionId={connectionId}
          rootPath={rootPath}
        />
      </div>
    )
  }

  if (connectingSession) {
    return (
      <div className="flex h-full items-center justify-center rounded-md border border-border/50 bg-background/40 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-amber-500" />
        {t('connecting')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-md border border-border/50 bg-background/40 text-xs text-muted-foreground">
        <span>{error}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() => void connect(connectionId)}
        >
          {t('terminal.reconnect')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center rounded-md border border-border/50 bg-background/40 text-xs text-muted-foreground">
      {t('connecting')}
    </div>
  )
}

export function RightPanel({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const tab = useUIStore((s) => s.rightPanelTab)
  const section = useUIStore((s) => s.rightPanelSection)
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const detailPanelOpen = useUIStore((s) => s.detailPanelOpen)
  const previewPanelOpen = useUIStore((s) => s.previewPanelOpen)
  const selectedSubAgentToolUseId = useUIStore((s) => s.selectedSubAgentToolUseId)
  const subAgentExecutionDetailOpen = useUIStore((s) => s.subAgentExecutionDetailOpen)
  const subAgentExecutionDetailToolUseId = useUIStore((s) => s.subAgentExecutionDetailToolUseId)
  const subAgentExecutionDetailInlineText = useUIStore((s) => s.subAgentExecutionDetailInlineText)
  const chatView = useUIStore((s) => s.chatView)
  const setTab = useUIStore((s) => s.setRightPanelTab)
  const setSection = useUIStore((s) => s.setRightPanelSection)
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)

  const teamToolsEnabled = useSettingsStore((s) => s.teamToolsEnabled)
  const builtinBrowserEnabled = useSettingsStore((s) => s.builtinBrowserEnabled)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)
  )
  const sessionHasWorkspace = isProjectSession({
    chatView,
    session: activeSession,
    activeProjectId,
    workingFolder: activeSession?.workingFolder
  })
  const hasSessionTeam = useTeamStore((s) => {
    if (!activeSessionId) return false
    return (
      s.activeTeam?.sessionId === activeSessionId ||
      s.teamHistory.some((team) => team.sessionId === activeSessionId)
    )
  })
  const hasSessionSubAgents = useAgentStore((s) => {
    if (!activeSessionId) return false
    const matchSession = (item: { sessionId?: string }): boolean =>
      !item.sessionId || item.sessionId === activeSessionId
    const hasActive = Object.values(s.activeSubAgents).some(matchSession)
    const hasCompleted = Object.values(s.completedSubAgents).some(matchSession)
    const hasHistory = s.subAgentHistory.some(matchSession)
    return hasActive || hasCompleted || hasHistory
  })
  const hasSessionSubAgentMessages = useChatStore((s) => {
    if (!activeSessionId) return false
    return s.getSessionMessages(activeSessionId).some((message) => {
      if (!Array.isArray(message.content)) return false
      return message.content.some(
        (block) =>
          block.type === 'tool_use' &&
          block.name === TASK_TOOL_NAME &&
          block.input.run_in_background !== true
      )
    })
  })
  const shouldShowSubAgentsTab =
    hasSessionSubAgents ||
    hasSessionSubAgentMessages ||
    tab === 'subagents' ||
    tab === 'orchestration' ||
    !!selectedSubAgentToolUseId ||
    subAgentExecutionDetailOpen

  const visibleTabs = useMemo(
    () =>
      RIGHT_PANEL_TAB_DEFS.filter(
        (item) => (teamToolsEnabled && hasSessionTeam) || item.value !== 'team'
      )
        .filter((item) => builtinBrowserEnabled || item.value !== 'browser')
        .filter(
          (item) =>
            shouldShowSubAgentsTab || (item.value !== 'subagents' && item.value !== 'orchestration')
        )
        .filter((item) => {
          if (sessionHasWorkspace) return true
          if (item.value === 'preview') {
            return previewPanelOpen || detailPanelOpen || tab === 'preview'
          }
          return item.value !== 'files' && item.value !== 'terminal' && item.value !== 'artifacts'
        }),
    [
      builtinBrowserEnabled,
      detailPanelOpen,
      hasSessionTeam,
      previewPanelOpen,
      sessionHasWorkspace,
      shouldShowSubAgentsTab,
      tab,
      teamToolsEnabled
    ]
  )

  const availableSections = useMemo(
    () =>
      RIGHT_PANEL_SECTION_DEFS.filter((sectionDef) =>
        visibleTabs.some((tabDef) => tabDef.section === sectionDef.value)
      ),
    [visibleTabs]
  )
  const resolvedTab = visibleTabs.some((tabDef) => tabDef.value === tab)
    ? tab
    : (visibleTabs[0]?.value ?? 'context')
  const resolvedSection = availableSections.some((sectionDef) => sectionDef.value === section)
    ? section
    : (availableSections[0]?.value ?? 'monitoring')

  useEffect(() => {
    if (resolvedTab !== tab) setTab(resolvedTab)
  }, [resolvedTab, tab, setTab])

  useEffect(() => {
    if (resolvedSection !== section) setSection(resolvedSection)
  }, [resolvedSection, section, setSection])

  const activeTabDef = visibleTabs.find((item) => item.value === resolvedTab) ?? visibleTabs[0]
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
    startWidthRef.current = rightPanelWidth
    setIsDragging(true)
  }

  const handleSelectTab = (nextTab: RightPanelTab): void => {
    setTab(nextTab)
  }

  return (
    <div
      data-tour="right-panel"
      className="relative z-40 h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: rightPanelOpen ? targetPanelWidth : 0 }}
    >
      <aside
        className={cn(
          'relative flex h-full w-full border-l border-border/50 bg-background/55 backdrop-blur-sm transition-opacity duration-200',
          rightPanelOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        {activeTabDef ? (
          <div className="flex h-full min-h-0 w-full flex-col">
            <RightPanelHeader
              activeTabDef={activeTabDef}
              visibleTabs={visibleTabs}
              onSelectTab={handleSelectTab}
              onClose={() => setRightPanelOpen(false)}
              t={t}
            />
            <div className="min-h-0 flex-1 overflow-auto bg-background/5 p-4">
              <AnimatePresence mode="wait">
                {(resolvedTab === 'orchestration' || resolvedTab === 'team') && (
                  <FadeIn key="orchestration" className="h-full">
                    <OrchestrationConsole />
                  </FadeIn>
                )}

                {resolvedTab === 'subagents' && (
                  <FadeIn key="subagents" className="h-full">
                    {subAgentExecutionDetailOpen ? (
                      <SubAgentExecutionDetail
                        embedded
                        toolUseId={subAgentExecutionDetailToolUseId ?? selectedSubAgentToolUseId}
                        inlineText={subAgentExecutionDetailInlineText ?? undefined}
                        onClose={() => useUIStore.getState().closeSubAgentExecutionDetail()}
                      />
                    ) : (
                      <SubAgentsPanel />
                    )}
                  </FadeIn>
                )}

                {resolvedTab === 'files' && (
                  <FadeIn key="files" className="h-full">
                    {activeSession?.sshConnectionId ? (
                      <SshFilesPanel
                        connectionId={activeSession.sshConnectionId}
                        rootPath={activeSession.workingFolder}
                      />
                    ) : (
                      <FileTreePanel />
                    )}
                  </FadeIn>
                )}

                {resolvedTab === 'artifacts' && (
                  <FadeIn key="artifacts" className="h-full">
                    <ArtifactsPanel />
                  </FadeIn>
                )}

                {resolvedTab === 'preview' && (
                  <FadeIn key="preview" className="h-full">
                    {previewPanelOpen ? (
                      <PreviewPanel embedded />
                    ) : detailPanelOpen ? (
                      <DetailPanel embedded />
                    ) : (
                      <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/60 bg-background/40 text-xs text-muted-foreground">
                        {t('rightPanel.previewEmpty', { defaultValue: '暂无预览内容' })}
                      </div>
                    )}
                  </FadeIn>
                )}

                {resolvedTab === 'browser' && (
                  <FadeIn key="browser" className="h-full">
                    <BrowserPanel />
                  </FadeIn>
                )}

                {resolvedTab === 'terminal' && (
                  <FadeIn key="terminal" className="h-full">
                    <TerminalPanel />
                  </FadeIn>
                )}

                {resolvedTab === 'context' && (
                  <FadeIn key="context" className="h-full">
                    <ContextPanel />
                  </FadeIn>
                )}
              </AnimatePresence>
            </div>
          </div>
        ) : null}

        {rightPanelOpen && (
          <div
            className="absolute left-0 top-0 bottom-0 z-[60] w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
            onMouseDown={startResize}
          />
        )}
      </aside>

      {isDragging && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
