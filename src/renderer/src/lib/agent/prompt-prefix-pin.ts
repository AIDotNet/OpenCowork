import type { SessionPromptSnapshot } from '../../stores/chat-store'
import type { ToolDefinition } from '../api/types'

export function canReuseSessionPromptPrefix(args: {
  snapshot?: SessionPromptSnapshot
  mode: string
  projectId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  providerId?: string | null
  modelId?: string | null
  requirePluginSendMessage?: boolean
}): boolean {
  const snapshot = args.snapshot
  if (!snapshot) return false
  if (snapshot.mode !== args.mode) return false
  if ((snapshot.projectId ?? null) !== (args.projectId ?? null)) return false
  if ((snapshot.workingFolder ?? null) !== (args.workingFolder ?? null)) return false
  if ((snapshot.sshConnectionId ?? null) !== (args.sshConnectionId ?? null)) return false
  if ((snapshot.providerId ?? null) !== (args.providerId ?? null)) return false
  if ((snapshot.modelId ?? null) !== (args.modelId ?? null)) return false
  if (
    args.requirePluginSendMessage &&
    !snapshot.toolDefs.some((tool) => tool.name === 'PluginSendMessage')
  ) {
    return false
  }
  return true
}

export function pinnedToolDefinitions(snapshot: SessionPromptSnapshot): ToolDefinition[] {
  return snapshot.toolDefs.slice()
}
