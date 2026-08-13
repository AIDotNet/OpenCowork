import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'

const presentedPlanReviewKeys = new Set<string>()

function resolveSessionSshConnectionId(sessionId?: string | null): string | undefined {
  const chat = useChatStore.getState()
  const session = sessionId ? chat.sessions.find((item) => item.id === sessionId) : undefined
  const project = session?.projectId
    ? chat.projects.find((item) => item.id === session.projectId)
    : undefined
  return session?.sshConnectionId ?? project?.sshConnectionId ?? undefined
}

export function presentPlanReviewInRightPanel(args: {
  presentKey: string
  title: string
  content: string
  filePath?: string
  sessionId?: string | null
  force?: boolean
}): boolean {
  if (!args.filePath && !args.content.trim()) return false
  if (!args.force && presentedPlanReviewKeys.has(args.presentKey)) return false
  presentedPlanReviewKeys.add(args.presentKey)

  const uiStore = useUIStore.getState()
  const sshConnectionId = resolveSessionSshConnectionId(args.sessionId)
  if (args.filePath) {
    uiStore.openFilePreview(args.filePath, 'preview', sshConnectionId, args.sessionId)
  } else {
    uiStore.openMarkdownPreview(args.title, args.content, args.sessionId)
  }
  uiStore.expandRightPanelForReading()
  return true
}
