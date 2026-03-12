import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore, type RightPanelTab } from '@renderer/stores/ui-store'
import { StepsPanel } from '@renderer/components/cowork/StepsPanel'
import { ArtifactsPanel } from '@renderer/components/cowork/ArtifactsPanel'
import { ContextPanel } from '@renderer/components/cowork/ContextPanel'
import { SkillsPanel } from '@renderer/components/cowork/SkillsPanel'
import { FileTreePanel } from '@renderer/components/cowork/FileTreePanel'
import { SshFileExplorer } from '@renderer/components/ssh/SshFileExplorer'
import { TeamPanel } from '@renderer/components/cowork/TeamPanel'
import { PlanPanel } from '@renderer/components/cowork/PlanPanel'
import { usePlanStore } from '@renderer/stores/plan-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { AnimatePresence } from 'motion/react'
import { FadeIn } from '@renderer/components/animate-ui'
import { RightPanelHeader } from './RightPanelHeader'
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
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const connectedSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'connected'
  )
  const connectingSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'connecting'
  )
  const errorSession = Object.values(sessions).find(
    (s) => s.connectionId === connectionId && s.status === 'error'
  )

  useEffect(() => {
    setError(null)
    setConnecting(false)
  }, [connectionId])

  useEffect(() => {
    if (connectedSession) {
      setConnecting(false)
      setError(null)
      return
    }
    if (errorSession) {
      setConnecting(false)
      setError(errorSession.error ?? t('connectionFailed'))
      return
    }
    if (connectingSession) {
      setConnecting(true)
      return
    }
    if (connecting || error) return

    let active = true
    setConnecting(true)
    connect(connectionId)
      .then((sessionId) => {
        if (!active) return
        if (!sessionId) {
          setError(t('connectionFailed'))
          setConnecting(false)
        }
      })
      .catch(() => {
        if (!active) return
        setError(t('connectionFailed'))
        setConnecting(false)
      })

    return () => {
      active = false
    }
  }, [
    connectedSession,
    connectingSession,
    connect,
    connecting,
    connectionId,
    error,
    errorSession,
    t
  ])

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

  if (connecting || connectingSession) {
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
          onClick={() => setError(null)}
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
  const setTab = useUIStore((s) => s.setRightPanelTab)
  const setSection = useUIStore((s) => s.setRightPanelSection)
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth)
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen)

  const teamToolsEnabled = useSettingsStore((s) => s.teamToolsEnabled)

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)
  )
  const hasPlan = usePlanStore((s) => {
    if (!activeSessionId) return false
    return Object.values(s.plans).some((p) => p.sessionId === activeSessionId)
  })
  const planMode = useUIStore((s) => s.planMode)

  const visibleTabs = useMemo(
    () =>
      RIGHT_PANEL_TAB_DEFS.filter((item) => teamToolsEnabled || item.value !== 'team').filter(
        (item) => hasPlan || planMode || item.value !== 'plan'
      ),
    [teamToolsEnabled, hasPlan, planMode]
  )

  const availableSections = useMemo(
    () =>
      RIGHT_PANEL_SECTION_DEFS.filter((sectionDef) =>
        visibleTabs.some((tabDef) => tabDef.section === sectionDef.value)
      ),
    [visibleTabs]
  )

  useEffect(() => {
    if (visibleTabs.length === 0) return
    if (visibleTabs.some((tabDef) => tabDef.value === tab)) return
    setTab(visibleTabs[0].value)
  }, [visibleTabs, tab, setTab])

  useEffect(() => {
    if (availableSections.length === 0) return
    if (availableSections.some((sectionDef) => sectionDef.value === section)) return
    setSection(availableSections[0].value)
  }, [availableSections, section, setSection])

  const activeTabDef = visibleTabs.find((t) => t.value === tab) ?? visibleTabs[0]

  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(rightPanelWidth)
  const [isDragging, setIsDragging] = useState(false)

  const targetPanelWidth = compact
    ? Math.min(rightPanelWidth, RIGHT_PANEL_DEFAULT_WIDTH)
    : rightPanelWidth
  const computedPanelWidth = rightPanelOpen ? targetPanelWidth : 0

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

  const [isHoveringButton, setIsHoveringButton] = useState(false)
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleButtonMouseEnter = () => {
    if (rightPanelOpen) return
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHoveringButton(true)
    }, 150)
  }

  const handleButtonMouseLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHoveringButton(false)
    }, 250)
  }

  return (
    <aside
      className="relative flex h-full shrink-0 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] z-10"
      style={{ width: computedPanelWidth }}
    >
      {/* Floating Toggle Button & Hover Menu Wrapper */}
      <div
        className="absolute left-0 top-1/2 -translate-x-full -translate-y-1/2 z-50 flex items-center"
        onMouseEnter={handleButtonMouseEnter}
        onMouseLeave={handleButtonMouseLeave}
      >
        {/* Hover Menu */}
        <AnimatePresence>
          {!rightPanelOpen && isHoveringButton && (
            <FadeIn className="absolute right-full mr-2 py-1.5 w-36 bg-background/95 backdrop-blur-sm border border-border/50 rounded-lg shadow-xl overflow-hidden">
              {visibleTabs.map((tabDef) => {
                const TabIcon = tabDef.icon
                return (
                  <button
                    key={tabDef.value}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                    onClick={() => {
                      setTab(tabDef.value)
                      setRightPanelOpen(true)
                      setIsHoveringButton(false)
                    }}
                  >
                    <TabIcon className="size-4 shrink-0" />
                    <span>{t(`rightPanel.${tabDef.labelKey}`)}</span>
                  </button>
                )
              })}
            </FadeIn>
          )}
        </AnimatePresence>

        {/* Toggle Button */}
        <button
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
          className={cn(
            'w-5 h-14 bg-background border border-border/50 border-r-0',
            'rounded-l-xl flex items-center justify-center',
            'text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer shadow-sm transition-all duration-300'
          )}
          title={
            rightPanelOpen
              ? t('rightPanelAction.closePanel', { defaultValue: '收起面板' })
              : t('rightPanelAction.expandPanel', { defaultValue: '展开面板' })
          }
        >
          {rightPanelOpen ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronLeft className="size-4" />
          )}
        </button>
      </div>

      {/* Resize Handle */}
      {rightPanelOpen && (
        <div
          className="absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize hover:bg-primary/20 transition-colors"
          onMouseDown={startResize}
        />
      )}

      {isDragging && <div className="absolute inset-0 z-30" />}

      {/* Clipping Wrapper for smooth slide animation */}
      <div
        className={cn(
          'absolute inset-0 overflow-hidden bg-background shadow-2xl transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
          rightPanelOpen
            ? 'border-l border-border/50 rounded-l-2xl opacity-100'
            : 'border-l-0 rounded-none opacity-0'
        )}
      >
        {/* Fixed Width Content */}
        <div
          className="absolute right-0 top-0 h-full bg-background"
          style={{ width: targetPanelWidth }}
        >
          {activeTabDef && (
            <div className="flex min-w-0 flex-1 flex-col h-full w-full">
              <RightPanelHeader
                activeTabDef={activeTabDef}
                visibleTabs={visibleTabs}
                onSelectTab={handleSelectTab}
                onClose={() => setRightPanelOpen(false)}
                t={t}
              />

              <div className="flex-1 overflow-auto bg-background p-4">
                <AnimatePresence mode="wait">
                  {tab === 'steps' && (
                    <FadeIn key="steps" className="h-full">
                      <StepsPanel />
                    </FadeIn>
                  )}

                  {tab === 'team' && (
                    <FadeIn key="team" className="h-full">
                      <TeamPanel />
                    </FadeIn>
                  )}

                  {tab === 'files' && (
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

                  {tab === 'artifacts' && (
                    <FadeIn key="artifacts" className="h-full">
                      <ArtifactsPanel />
                    </FadeIn>
                  )}

                  {tab === 'context' && (
                    <FadeIn key="context" className="h-full">
                      <ContextPanel />
                    </FadeIn>
                  )}

                  {tab === 'skills' && (
                    <FadeIn key="skills" className="h-full">
                      <SkillsPanel />
                    </FadeIn>
                  )}

                  {tab === 'plan' && (
                    <FadeIn key="plan" className="h-full">
                      <PlanPanel />
                    </FadeIn>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
