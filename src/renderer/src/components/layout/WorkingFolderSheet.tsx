import { useEffect, useRef, useState } from 'react'
import { FolderTree, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { FileTreePanel } from '@renderer/components/cowork/FileTreePanel'
import { Button } from '@renderer/components/ui/button'
import { SshFileExplorer } from '@renderer/components/ssh/SshFileExplorer'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { clampWorkingFolderPanelWidth } from './right-panel-defs'

function SshFilesPanel({
  connectionId,
  rootPath
}: {
  connectionId: string
  rootPath: string
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const sessions = useSshStore((s) => s.sessions)
  const connect = useSshStore((s) => s.connect)

  const connectedSession = Object.values(sessions).find(
    (session) => session.connectionId === connectionId && session.status === 'connected'
  )
  const connectingSession = Object.values(sessions).find(
    (session) => session.connectionId === connectionId && session.status === 'connecting'
  )
  const errorSession = Object.values(sessions).find(
    (session) => session.connectionId === connectionId && session.status === 'error'
  )
  const error = errorSession?.error ?? null

  useEffect(() => {
    if (connectedSession || connectingSession || errorSession) return
    void connect(connectionId)
  }, [connectedSession, connectingSession, errorSession, connect, connectionId])

  if (connectedSession) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
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
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin text-amber-500" />
        {t('connecting')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-xs text-muted-foreground">{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => void connect(connectionId)}
        >
          {t('terminal.reconnect')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
      {t('connecting')}
    </div>
  )
}

interface WorkingFolderSheetProps {
  sessionId?: string | null
}

export function WorkingFolderSheet({
  sessionId = null
}: WorkingFolderSheetProps): React.JSX.Element {
  const { t } = useTranslation(['cowork'])
  const open = useUIStore((s) => s.workingFolderSheetOpen)
  const setOpen = useUIStore((s) => s.setWorkingFolderSheetOpen)
  const panelWidth = useUIStore((s) => s.workingFolderPanelWidth)
  const setPanelWidth = useUIStore((s) => s.setWorkingFolderPanelWidth)
  const sessionView = useChatStore(
    useShallow((state) => {
      const resolvedSessionId = sessionId ?? state.activeSessionId
      const currentSession = resolvedSessionId
        ? state.sessions.find((item) => item.id === resolvedSessionId)
        : undefined
      const currentProject = currentSession?.projectId
        ? state.projects.find((item) => item.id === currentSession.projectId)
        : undefined

      return {
        sessionId: resolvedSessionId,
        workingFolder: currentSession?.workingFolder ?? currentProject?.workingFolder,
        sshConnectionId: currentSession?.sshConnectionId ?? currentProject?.sshConnectionId ?? null
      }
    })
  )

  useEffect(() => {
    if (open && !sessionView.sessionId) {
      setOpen(false)
    }
  }, [open, sessionView.sessionId, setOpen])

  const draggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(panelWidth)
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (event: MouseEvent): void => {
      if (!draggingRef.current) return
      const delta = startXRef.current - event.clientX
      setPanelWidth(clampWorkingFolderPanelWidth(startWidthRef.current + delta))
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
  }, [isDragging, setPanelWidth])

  const startResize = (event: React.MouseEvent): void => {
    if (!open) return
    event.preventDefault()
    draggingRef.current = true
    startXRef.current = event.clientX
    startWidthRef.current = panelWidth
    setIsDragging(true)
  }

  return (
    <div
      className="relative z-30 h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: open ? panelWidth : 0 }}
    >
      <aside
        className={`relative flex h-full w-[420px] flex-col border-l border-border/60 bg-background/92 backdrop-blur-xl transition-opacity duration-200 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        style={{ width: panelWidth }}
      >
        <div className="min-h-0 flex-1">
          {sessionView.workingFolder ? (
            sessionView.sshConnectionId ? (
              <SshFilesPanel
                connectionId={sessionView.sshConnectionId}
                rootPath={sessionView.workingFolder}
              />
            ) : (
              <FileTreePanel sessionId={sessionView.sessionId} surface="sheet" />
            )
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/25">
                <FolderTree className="size-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('fileTree.selectFolder', {
                    defaultValue: 'Select a working folder to view files'
                  })}
                </p>
              </div>
            </div>
          )}
        </div>

        {open && (
          <div
            className="absolute bottom-0 left-0 top-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
            onMouseDown={startResize}
          />
        )}
      </aside>

      {isDragging && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
