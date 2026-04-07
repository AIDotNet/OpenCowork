import { Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore, type RightPanelTab } from '@renderer/stores/ui-store'
import { StepsPanel } from '@renderer/components/cowork/StepsPanel'
import { ArtifactsPanel } from '@renderer/components/cowork/ArtifactsPanel'
import { ContextPanel } from '@renderer/components/cowork/ContextPanel'
import { FileTreePanel } from '@renderer/components/cowork/FileTreePanel'
import { SshFileExplorer } from '@renderer/components/ssh/SshFileExplorer'
import { TeamPanel } from '@renderer/components/cowork/TeamPanel'
import { PlanPanel } from '@renderer/components/cowork/PlanPanel'
import { AcpPanel } from '@renderer/components/cowork/AcpPanel'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { AnimatePresence } from 'motion/react'
import { FadeIn } from '@renderer/components/animate-ui'
import { RightPanelHeader } from './RightPanelHeader'
import { RightPanelRail } from './RightPanelRail'
import { PreviewPanel } from './PreviewPanel'
import { DetailPanel } from './DetailPanel'
import { SubAgentsPanel } from './SubAgentsPanel'
import { SubAgentExecutionDetail } from './SubAgentExecutionDetail'
import { TerminalPanel } from '@renderer/components/terminal/TerminalPanel'
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_SECTION_DEFS,
  RIGHT_PANEL_TAB_DEFS,
  RIGHT_PANEL_RAIL_WIDTH,
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
      <div className="h-full overflow-hidden rounded-lg border border-border/50 bg-background/40">
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
      <div className="flex h-full items-center justify-center rounded-lg border border-border/50 bg-background/40 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-amber-500" />
        {t('connecting')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-border/50 bg-background/40 text-xs text-muted-foreground">
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
    <div className="flex h-full items-center justify-center rounded-lg border border-border/50 bg-background/40 text-xs text-muted-foreground">
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
  const setTab = useUIStore((s) => s.setRightPanelTab)
  const setSection = useUIStore((s) => s.setRightPanelSection)
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)

  const teamToolsEnabled = useSettingsStore((s) => s.teamToolsEnabled)

  const mode = useUIStore((s) => s.mode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)
  )
  const hasPlan = usePlanStore((s) => {
    if (!activeSessionId) return false
    return Object.values(s.plans).some((p) => p.sessionId === activeSessionId)
  })
  const hasSessionSubAgents = useAgentStore((s) => {
    if (!activeSessionId) return false
    const hasActive = Object.values(s.activeSubAgents).some(
      (item) => item.sessionId === activeSessionId
    )
    const hasCompleted = Object.values(s.completedSubAgents).some(
      (item) => item.sessionId === activeSessionId
    )
    const hasHistory = s.subAgentHistory.some((item) => item.sessionId === activeSessionId)
    return hasActive || hasCompleted || hasHistory
  })
  const planMode = useUIStore((s) => s.planMode)

  const shouldShowSubAgentsTab =
    hasSessionSubAgents ||
    tab === 'subagents' ||
    !!selectedSubAgentToolUseId ||
    subAgentExecutionDetailOpen

  const visibleTabs = useMemo(
    () =>
      RIGHT_PANEL_TAB_DEFS.filter((item) => teamToolsEnabled || item.value !== 'team')
        .filter((item) => hasPlan || planMode || item.value !== 'plan')
        .filter((item) => shouldShowSubAgentsTab || item.value !== 'subagents')
        .filter((item) => (activeSession?.mode ?? mode) === 'acp' || item.value !== 'acp'),
    [teamToolsEnabled, hasPlan, planMode, shouldShowSubAgentsTab, activeSession?.mode, mode]
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
    : (visibleTabs[0]?.value ?? 'steps')
  const resolvedSection = availableSections.some((sectionDef) => sectionDef.value === section)
    ? section
    : (availableSections[0]?.value ?? 'execution')

  useEffect(() => {
    if (resolvedTab !== tab) {
      setTab(resolvedTab)
    }
  }, [resolvedTab, tab, setTab])

  useEffect(() => {
    if (resolvedSection !== section) {
      setSection(resolvedSection)
    }
  }, [resolvedSection, section, setSection])

  const activeTabDef = visibleTabs.find((t) => t.value === resolvedTab) ?? visibleTabs[0]

  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(rightPanelWidth)
  const [isDragging, setIsDragging] = useState(false)

  const targetPanelWidth = compact
    ? Math.min(rightPanelWidth, RIGHT_PANEL_DEFAULT_WIDTH)
    : rightPanelWidth

  // Ensure rightPanelWidth has a valid initial value if it's somehow 0
  useEffect(() => {
    if (rightPanelWidth === 0) {
      setRightPanelWidth(RIGHT_PANEL_DEFAULT_WIDTH)
    }
  }, [rightPanelWidth, setRightPanelWidth])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = startXRef.current - event.clientX
      const nextWidth = clampRightPanelWidth(startWidthRef.current + delta)
      setRightPanelWidth(nextWidth)
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
      className="relative flex h-full shrink-0 z-40 transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{
        width: rightPanelOpen ? targetPanelWidth + RIGHT_PANEL_RAIL_WIDTH : RIGHT_PANEL_RAIL_WIDTH
      }}
    >
      <aside className="relative flex h-full w-full transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] bg-background/40 backdrop-blur-sm before:absolute before:left-0 before:top-2 before:bottom-2 before:w-px before:rounded-full before:bg-border/40">
        <div className="flex h-full w-full overflow-hidden">
          {/* Rail */}
          <RightPanelRail
            visibleTabs={visibleTabs}
            activeTab={resolvedTab}
            onSelectTab={handleSelectTab}
            showTabs
            isExpanded={rightPanelOpen}
            onToggle={() => setRightPanelOpen(!rightPanelOpen)}
          />

          {/* Content Area */}
          <div
            className={cn(
              'flex-1 min-w-0 border-l border-border/40 transition-all duration-500',
              rightPanelOpen ? 'opacity-100' : 'w-0 opacity-0 pointer-events-none'
            )}
          >
            {activeTabDef && (
              <div className="flex flex-col h-full w-full" style={{ width: targetPanelWidth }}>
                <RightPanelHeader
                  activeTabDef={activeTabDef}
                  onClose={() => setRightPanelOpen(false)}
                  t={t}
                />

                <div className="flex-1 overflow-auto bg-background/5 p-4">
                  <AnimatePresence mode="wait">
                    {resolvedTab === 'steps' && (
                      <FadeIn key="steps" className="h-full">
                        <StepsPanel />
                      </FadeIn>
                    )}

                    {resolvedTab === 'team' && (
                      <FadeIn key="team" className="h-full">
                        <TeamPanel />
                      </FadeIn>
                    )}

                    {resolvedTab === 'subagents' && (
                      <FadeIn key="subagents" className="h-full">
                        {subAgentExecutionDetailOpen ? (
                          <SubAgentExecutionDetail
                            embedded
                            toolUseId={
                              subAgentExecutionDetailToolUseId ?? selectedSubAgentToolUseId
                            }
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
                          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/60 bg-background/40 text-xs text-muted-foreground">
                            {t('rightPanel.previewEmpty', { defaultValue: '暂无预览内容' })}
                          </div>
                        )}
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

                    {resolvedTab === 'plan' && (
                      <FadeIn key="plan" className="h-full">
                        <PlanPanel />
                      </FadeIn>
                    )}

                    {resolvedTab === 'acp' && (
                      <FadeIn key="acp" className="h-full">
                        <AcpPanel />
                      </FadeIn>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Resize Handle */}
        {rightPanelOpen && (
          <div
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30 transition-colors z-[60]"
            onMouseDown={startResize}
            style={{ left: RIGHT_PANEL_RAIL_WIDTH }}
          />
        )}
      </aside>

      {isDragging && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
