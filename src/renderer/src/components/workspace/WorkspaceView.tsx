import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Files, GitBranch, MessageSquare, Terminal } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { FileTreePanel } from '@renderer/components/cowork/FileTreePanel'
import { PreviewPanel } from '@renderer/components/layout/PreviewPanel'
import { ProjectTerminalDock } from '@renderer/components/terminal/ProjectTerminalDock'
import { SourceControlPanel } from '@renderer/components/scm/SourceControlPanel'

type WorkspaceLeftView = 'explorer' | 'scm'

const MIN_LEFT_WIDTH = 220
const MAX_LEFT_WIDTH = 520
const DEFAULT_LEFT_WIDTH = 300

function ActivityButton({
  active,
  label,
  onClick,
  children
}: {
  active?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'flex size-10 items-center justify-center border-l-2 text-muted-foreground transition-colors hover:text-foreground',
        active ? 'border-l-primary text-foreground' : 'border-l-transparent'
      )}
    >
      {children}
    </button>
  )
}

export function WorkspaceView(): React.JSX.Element {
  const { t } = useTranslation(['layout', 'common'])
  const [leftView, setLeftView] = React.useState<WorkspaceLeftView>('explorer')
  const [leftWidth, setLeftWidth] = React.useState(DEFAULT_LEFT_WIDTH)
  const [isDragging, setIsDragging] = React.useState(false)
  const draggingRef = React.useRef(false)
  const startXRef = React.useRef(0)
  const startWidthRef = React.useRef(DEFAULT_LEFT_WIDTH)

  const setMode = useUIStore((s) => s.setMode)
  const setBottomTerminalDockOpen = useUIStore((s) => s.setBottomTerminalDockOpen)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  const sessionView = useChatStore(
    useShallow((state) => {
      const session = state.activeSessionId
        ? state.sessions.find((item) => item.id === state.activeSessionId)
        : undefined
      const project = session?.projectId
        ? state.projects.find((item) => item.id === session.projectId)
        : undefined
      return {
        sessionId: session?.id ?? null,
        projectId: session?.projectId ?? project?.id ?? null,
        projectName: project?.name,
        workingFolder: session?.workingFolder ?? project?.workingFolder ?? null,
        sshConnectionId: session?.sshConnectionId ?? project?.sshConnectionId ?? null
      }
    })
  )

  const terminalOpen = useUIStore((s) =>
    sessionView.projectId
      ? Boolean(s.bottomTerminalDockOpenByProjectId[sessionView.projectId])
      : false
  )

  React.useEffect(() => {
    if (!isDragging) return
    const onMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = event.clientX - startXRef.current
      setLeftWidth(
        Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, startWidthRef.current + delta))
      )
    }
    const onUp = (): void => {
      draggingRef.current = false
      setIsDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDragging])

  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault()
    draggingRef.current = true
    startXRef.current = event.clientX
    startWidthRef.current = leftWidth
    setIsDragging(true)
  }

  const goToChat = (): void => {
    setMode('cowork')
    if (activeSessionId) updateSessionMode(activeSessionId, 'cowork')
  }

  const toggleTerminal = (): void => {
    if (sessionView.projectId) setBottomTerminalDockOpen(sessionView.projectId, !terminalOpen)
  }

  return (
    <div className="flex flex-1 overflow-hidden bg-background">
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-border/50 py-1">
        <ActivityButton
          active={leftView === 'explorer'}
          label={t('layout:files', { defaultValue: 'Explorer' })}
          onClick={() => setLeftView('explorer')}
        >
          <Files className="size-5" />
        </ActivityButton>
        <ActivityButton
          active={leftView === 'scm'}
          label={t('layout:scmTitle', { defaultValue: 'Source Control' })}
          onClick={() => setLeftView('scm')}
        >
          <GitBranch className="size-5" />
        </ActivityButton>
        <div className="flex-1" />
        <ActivityButton
          active={terminalOpen}
          label={t('layout:commandPalette.toggleTerminal', { defaultValue: 'Terminal' })}
          onClick={toggleTerminal}
        >
          <Terminal className="size-5" />
        </ActivityButton>
        <ActivityButton
          label={t('common:mode.cowork', { defaultValue: 'Chat' })}
          onClick={goToChat}
        >
          <MessageSquare className="size-5" />
        </ActivityButton>
      </div>

      <div
        className="flex shrink-0 flex-col overflow-hidden border-r border-border/50"
        style={{ width: leftWidth }}
      >
        {leftView === 'explorer' ? (
          sessionView.workingFolder ? (
            <FileTreePanel
              sessionId={sessionView.sessionId}
              surface="agent"
              watchEnabled={leftView === 'explorer'}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t('layout:scmNoFolder', { defaultValue: 'Open a working folder to browse files.' })}
            </div>
          )
        ) : (
          <SourceControlPanel sessionId={sessionView.sessionId} />
        )}
      </div>

      <div
        className={cn(
          'w-1 shrink-0 cursor-col-resize transition-colors hover:bg-primary/30',
          isDragging && 'bg-primary/30'
        )}
        onMouseDown={startResize}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <PreviewPanel embedded showTabStrip />
        </div>
        {terminalOpen && sessionView.projectId ? (
          <div className="min-h-0 shrink-0 border-t border-border/50">
            <ProjectTerminalDock
              projectId={sessionView.projectId}
              projectName={sessionView.projectName}
              workingFolder={sessionView.workingFolder ?? null}
              sshConnectionId={sessionView.sshConnectionId}
            />
          </div>
        ) : null}
      </div>

      {isDragging && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
