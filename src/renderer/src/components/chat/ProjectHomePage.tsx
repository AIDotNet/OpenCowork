import * as React from 'react'
import { BookOpen, FolderOpen, GitBranch, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { InputArea } from '@renderer/components/chat/InputArea'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useChatActions, type SendMessageOptions } from '@renderer/hooks/use-chat-actions'
import type { ImageAttachment } from '@renderer/lib/image-attachments'

export function ProjectHomePage(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projects = useChatStore((state) => state.projects)
  const mode = useUIStore((state) => state.mode)
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const workingFolder = activeProject?.workingFolder
  const sshConnectionId = activeProject?.sshConnectionId
  const { sendMessage } = useChatActions()
  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false)

  const handleSend = React.useCallback(
    (text: string, images?: ImageAttachment[], options?: SendMessageOptions): void => {
      if (!activeProjectId) return
      const chatStore = useChatStore.getState()
      const sessionId = chatStore.createSession(mode, activeProjectId, options)
      chatStore.setActiveSession(sessionId)
      useUIStore.getState().navigateToSession(sessionId)
      void sendMessage(text, images, undefined, sessionId, undefined, undefined, {
        ...options,
        clearCompletedTasksOnTurnStart: true
      })
    },
    [activeProjectId, mode, sendMessage]
  )

  const updateProjectDirectory = React.useCallback(
    async (patch: { workingFolder: string; sshConnectionId: string | null }): Promise<void> => {
      if (!activeProjectId) return
      useChatStore.getState().updateProjectDirectory(activeProjectId, patch)
    },
    [activeProjectId]
  )

  if (!activeProject) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-background px-6">
        <div className="w-full max-w-[520px] text-center">
          <p className="text-[28px] font-semibold tracking-tight text-foreground">
            {t('projectHome.noProjectSelected')}
          </p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {t('projectHome.noProjectSelectedDesc')}
          </p>
          <Button
            className="mt-6 h-9 rounded-md px-4"
            onClick={() => useUIStore.getState().navigateToHome()}
          >
            {t('projectHome.backHome')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="shrink-0 px-6 pt-5">
        <p className="truncate text-sm font-medium text-foreground/90">{activeProject.name}</p>
      </div>

      <div className="flex flex-1 flex-col px-6 pb-14 pt-8 sm:pt-10">
        <div className="flex flex-1 items-start justify-center pt-8 lg:items-center lg:pt-0">
          <div className="w-full max-w-[760px]">
            <div className="mb-6 flex flex-col items-center gap-3 text-center sm:mb-7">
              <p className="max-w-[760px] text-[30px] font-semibold tracking-tight text-foreground/92 sm:text-[42px]">
                {`What should we build in ${activeProject.name}?`}
              </p>
              <p className="max-w-[560px] text-sm leading-6 text-muted-foreground/72">
                {workingFolder ? t('projectHome.heroDesc') : t('projectHome.noWorkingFolder')}
              </p>

              <div className="flex flex-wrap justify-center gap-2">
                <span className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/60 bg-background/70 px-3 py-1.5 text-[11px] text-muted-foreground">
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {workingFolder ?? t('projectHome.noWorkingFolder')}
                  </span>
                </span>
                {sshConnectionId ? (
                  <span className="inline-flex items-center rounded-md border border-border/60 bg-background/70 px-3 py-1.5 text-[11px] text-muted-foreground">
                    SSH
                  </span>
                ) : null}
              </div>
            </div>

            <InputArea
              sessionId={null}
              onSend={handleSend}
              onSelectFolder={() => setFolderDialogOpen(true)}
              workingFolder={workingFolder}
              hideWorkingFolderIndicator
              hideWorkingFolderPicker
              isStreaming={false}
            />

            <div className="mt-4 flex flex-wrap gap-2 sm:mt-5">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-md border border-border/60 bg-background/50 px-3 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                onClick={() => useUIStore.getState().navigateToArchive(activeProject.id)}
              >
                <BookOpen className="size-3.5" />
                {t('projectHome.openArchive')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-md border border-border/60 bg-background/50 px-3 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                onClick={() => useUIStore.getState().navigateToChannels(activeProject.id)}
              >
                <MessageSquare className="size-3.5" />
                {t('projectHome.openChannels')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-md border border-border/60 bg-background/50 px-3 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                onClick={() => useUIStore.getState().navigateToGit(activeProject.id)}
              >
                <GitBranch className="size-3.5" />
                {t('projectHome.openGit')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <WorkingFolderSelectorDialog
        open={folderDialogOpen}
        onOpenChange={setFolderDialogOpen}
        workingFolder={workingFolder}
        sshConnectionId={sshConnectionId}
        onSelectLocalFolder={(folderPath) =>
          updateProjectDirectory({
            workingFolder: folderPath,
            sshConnectionId: null
          })
        }
        onSelectSshFolder={(folderPath, connectionId) =>
          updateProjectDirectory({
            workingFolder: folderPath,
            sshConnectionId: connectionId
          })
        }
      />
    </div>
  )
}
