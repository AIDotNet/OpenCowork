import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { InputArea } from '@renderer/components/chat/InputArea'
import { WorkingFolderSelectorDialog } from './WorkingFolderSelectorDialog'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useChatActions, type SendMessageOptions } from '@renderer/hooks/use-chat-actions'
import type { ImageAttachment } from '@renderer/lib/image-attachments'

function applySuggestedPrompt(prompt: string): void {
  const textarea = document.querySelector('textarea')
  if (textarea instanceof window.HTMLTextAreaElement) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set
    nativeInputValueSetter?.call(textarea, prompt)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.focus()
    return
  }

  const editor = document.querySelector('[role="textbox"][contenteditable="true"]')
  if (editor instanceof HTMLDivElement) {
    editor.replaceChildren(document.createTextNode(prompt))
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.focus()
  }
}

export function ChatHomePage(): React.JSX.Element {
  const { t } = useTranslation('chat')
  const { t: tLayout } = useTranslation('layout')
  const mode = useUIStore((s) => s.mode)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const { activeProject, workingFolder, sshConnectionId } = useChatStore(
    useShallow((s) => {
      const project =
        s.projects.find((item) => item.id === s.activeProjectId) ??
        s.projects.find((item) => !item.pluginId) ??
        s.projects[0] ??
        null
      return {
        activeProject: project,
        workingFolder: project?.workingFolder,
        sshConnectionId: project?.sshConnectionId ?? null
      }
    })
  )
  const { sendMessage } = useChatActions()
  const [folderDialogOpen, setFolderDialogOpen] = React.useState(false)

  const handleSend = React.useCallback(
    (text: string, images?: ImageAttachment[], options?: SendMessageOptions): void => {
      const chatStore = useChatStore.getState()
      const sessionId =
        mode === 'chat'
          ? chatStore.createSession(mode, null, {
              ...options,
              preserveProjectless: true
            })
          : chatStore.createSession(mode, activeProject?.id ?? undefined, options)
      chatStore.setActiveSession(sessionId)
      useUIStore.getState().navigateToSession(sessionId)
      void sendMessage(text, images, undefined, sessionId, undefined, undefined, {
        ...options,
        clearCompletedTasksOnTurnStart: true
      })
    },
    [activeProject?.id, mode, sendMessage]
  )

  const updateHomeProjectDirectory = React.useCallback(
    async (patch: { workingFolder: string; sshConnectionId: string | null }): Promise<void> => {
      const chatStore = useChatStore.getState()
      let projectId: string | null = activeProject?.id ?? activeProjectId ?? null
      if (!projectId) {
        const ensured = await chatStore.ensureDefaultProject()
        projectId = ensured?.id ?? null
      }
      if (!projectId) return
      chatStore.setActiveProject(projectId)
      chatStore.updateProjectDirectory(projectId, patch)
    },
    [activeProject?.id, activeProjectId]
  )

  const quickPrompts =
    mode === 'chat'
      ? [t('messageList.explainAsync'), t('messageList.compareRest'), t('messageList.writeRegex')]
      : workingFolder
        ? [
            t('messageList.summarizeProject'),
            t('messageList.findBugs'),
            t('messageList.addErrorHandling')
          ]
        : [
            t('messageList.reviewCodebase'),
            t('messageList.addTests'),
            t('messageList.refactorError')
          ]

  const title =
    mode === 'chat'
      ? 'What should we talk through?'
      : workingFolder
        ? `What should we build in ${activeProject?.name ?? 'this workspace'}?`
        : t('messageList.startCoding')

  const description =
    mode === 'chat'
      ? t('messageList.startConversationDesc')
      : workingFolder
        ? t('messageList.startCodingDesc')
        : t('input.noWorkingFolder', { mode })

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="shrink-0 px-6 pt-5">
        <p className="text-sm font-medium text-foreground/90">
          {tLayout('sidebar.newChat', { defaultValue: '新建聊天' })}
        </p>
      </div>

      <div className="flex flex-1 flex-col px-6 pb-14 pt-8 sm:pt-10">
        <div className="flex flex-1 items-start justify-center pt-8 lg:items-center lg:pt-0">
          <div className="w-full max-w-[760px]">
            <div className="mb-6 flex flex-col items-center gap-3 text-center sm:mb-7">
              <p className="max-w-[760px] text-[30px] font-semibold tracking-tight text-foreground/92 sm:text-[42px]">
                {title}
              </p>
              <p className="max-w-[560px] text-sm leading-6 text-muted-foreground/72">
                {description}
              </p>

              {activeProject ? (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <span className="truncate text-foreground/88">{activeProject.name}</span>
                  {workingFolder ? (
                    <span className="max-w-[320px] truncate text-[11px] text-muted-foreground">
                      {workingFolder}
                    </span>
                  ) : null}
                  {sshConnectionId ? (
                    <span className="rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
                      SSH
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <InputArea
              sessionId={null}
              onSend={handleSend}
              onSelectFolder={mode !== 'chat' ? () => setFolderDialogOpen(true) : undefined}
              workingFolder={workingFolder}
              hideWorkingFolderIndicator
              hideWorkingFolderPicker
              isStreaming={false}
            />

            <div className="mt-4 flex flex-wrap gap-2 sm:mt-5">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-[11px] text-muted-foreground/72 transition-colors hover:bg-muted/40 hover:text-foreground"
                  onClick={() => applySuggestedPrompt(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {mode !== 'chat' && (
        <WorkingFolderSelectorDialog
          open={folderDialogOpen}
          onOpenChange={setFolderDialogOpen}
          workingFolder={workingFolder}
          sshConnectionId={sshConnectionId}
          onSelectLocalFolder={(folderPath) =>
            updateHomeProjectDirectory({
              workingFolder: folderPath,
              sshConnectionId: null
            })
          }
          onSelectSshFolder={(folderPath, connectionId) =>
            updateHomeProjectDirectory({
              workingFolder: folderPath,
              sshConnectionId: connectionId
            })
          }
        />
      )}
    </div>
  )
}
