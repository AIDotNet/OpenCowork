import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'

// Remembers which plan revisions already auto-opened so returning to a session does not keep
// re-expanding the right panel. Bounded because it lives for the whole renderer session.
const PRESENTED_PLAN_REVIEW_KEY_LIMIT = 64
const presentedPlanReviewKeys = new Set<string>()

function rememberPresentedPlanReview(presentKey: string): void {
  presentedPlanReviewKeys.add(presentKey)
  while (presentedPlanReviewKeys.size > PRESENTED_PLAN_REVIEW_KEY_LIMIT) {
    const oldest = presentedPlanReviewKeys.values().next()
    if (oldest.done) break
    presentedPlanReviewKeys.delete(oldest.value)
  }
}

export function resolveSessionSshConnectionId(sessionId?: string | null): string | undefined {
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
  rememberPresentedPlanReview(args.presentKey)

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
