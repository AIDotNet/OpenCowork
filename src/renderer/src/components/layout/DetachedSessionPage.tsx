import { useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'
import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider
} from '@renderer/components/ui/tooltip'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { cn } from '@renderer/lib/utils'
import { SessionConversationPane } from './SessionConversationPane'
import { WorkingFolderSheet } from './WorkingFolderSheet'
import { WindowControls } from './WindowControls'
import { RightPanel } from './RightPanel'
import { setSessionForegroundVisibility } from '@renderer/lib/agent/session-runtime-router'
import { agentStream } from '@renderer/lib/ipc/agent-stream-receiver'

interface DetachedSessionPageProps {
  sessionId: string
}

export function DetachedSessionPage({ sessionId }: DetachedSessionPageProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const sessionView = useChatStore(
    useShallow((state) => {
      const session = state.sessions.find((item) => item.id === sessionId)
      const project = session?.projectId
        ? state.projects.find((item) => item.id === session.projectId)
        : undefined

      return {
        projectId: session?.projectId ?? null,
        title: session?.title ?? null,
        workingFolder: session?.workingFolder ?? project?.workingFolder ?? null
      }
    })
  )
  const pendingApproval = useAgentStore(
    (state) => state.pendingToolCalls.find((toolCall) => toolCall.sessionId === sessionId) ?? null
  )
  const resolveApproval = useAgentStore((state) => state.resolveApproval)
  const workingFolderSheetOpen = useUIStore((state) => state.workingFolderSheetOpen)
  const toggleWorkingFolderSheet = useUIStore((state) => state.toggleWorkingFolderSheet)
  const isMac = /Mac/.test(navigator.userAgent)

  useEffect(() => {
    document.title = sessionView.title ? `${sessionView.title} | OpenCoWork` : 'OpenCoWork'
  }, [sessionView.title])

  useEffect(() => {
    setSessionForegroundVisibility(sessionId, true)
    agentStream.notifySessionVisibility(sessionId, true)
    return () => {
      setSessionForegroundVisibility(sessionId, false)
      agentStream.notifySessionVisibility(sessionId, false)
    }
  }, [sessionId])

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <header
          className={cn(
            'titlebar-drag relative flex h-10 shrink-0 items-center gap-3 bg-background/85 px-3 backdrop-blur-md',
            isMac ? 'pl-[78px]' : 'pr-[132px]'
          )}
          style={{ paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)' }}
        >
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/85">
            {sessionView.title ?? t('sidebar.newChat', { defaultValue: 'New chat' })}
          </div>

          <div className="flex items-center gap-1">
            {sessionView.projectId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-pressed={workingFolderSheetOpen}
                    aria-disabled={!sessionView.workingFolder}
                    className={cn(
                      'titlebar-no-drag size-7 rounded-md transition-colors',
                      workingFolderSheetOpen
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      !sessionView.workingFolder &&
                        'cursor-not-allowed opacity-40 hover:bg-transparent'
                    )}
                    onClick={() => {
                      if (!sessionView.workingFolder) return
                      toggleWorkingFolderSheet()
                    }}
                  >
                    <FolderOpen className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {sessionView.workingFolder
                    ? workingFolderSheetOpen
                      ? t('topbar.closeFileManager', { defaultValue: 'Close file manager' })
                      : t('topbar.openFileManager', { defaultValue: 'Open file manager' })
                    : t('topbar.fileManagerUnavailable', {
                        defaultValue: 'Select a working folder to open the file manager'
                      })}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>

          {!isMac ? (
            <div className="absolute right-0 top-0 z-10">
              <WindowControls />
            </div>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <SessionConversationPane sessionId={sessionId} allowOpenInNewWindow={false} />
          <WorkingFolderSheet sessionId={sessionId} />
          <RightPanel sessionId={sessionId} />
        </div>

        <PermissionDialog
          toolCall={pendingApproval}
          onAllow={() => pendingApproval && resolveApproval(pendingApproval.id, true)}
          onDeny={() => pendingApproval && resolveApproval(pendingApproval.id, false)}
        />
      </div>
    </TooltipProvider>
  )
}
