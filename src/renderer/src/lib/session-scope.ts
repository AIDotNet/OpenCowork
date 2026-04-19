import type { Session } from '@renderer/stores/chat-store'
import type { ChatView } from '@renderer/stores/ui-store'

const PROJECT_SCOPED_VIEWS = new Set<ChatView>(['project', 'archive', 'channels', 'git'])

interface SessionScopeInput {
  chatView: ChatView
  session?: Pick<Session, 'projectId'> | null
  activeProjectId?: string | null
  workingFolder?: string | null
}

export function isProjectSession({
  chatView,
  session,
  activeProjectId
}: SessionScopeInput): boolean {
  if (session) {
    return Boolean(session.projectId)
  }

  return PROJECT_SCOPED_VIEWS.has(chatView) && Boolean(activeProjectId)
}

export function isChatSession(input: SessionScopeInput): boolean {
  return !isProjectSession(input)
}

export function workspaceContextAvailable(input: SessionScopeInput): boolean {
  return isProjectSession(input) && Boolean(input.workingFolder?.trim())
}
