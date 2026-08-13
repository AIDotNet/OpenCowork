import type { LayeredMemorySnapshot, SessionMemoryScope } from './memory-files'
import { toolRegistry } from './tool-registry'
import { buildLeadCoordinatorPrompt } from './teams/prompts'
import type { ActiveTeam } from '../../stores/team-store'
import { resolveLanguageName } from '../i18n-language'
import {
  buildAgentModeSystemPrompt,
  MULTI_AGENT_MODE_PROMPT,
  resolvePromptEnvironmentFromPlatform,
  type AgentModePromptMode,
  type PromptEnvironmentContext
} from '../../../../shared/agent-system-prompt'

export { MULTI_AGENT_MODE_PROMPT }
export type { AgentModePromptMode, PromptEnvironmentContext }

export function resolvePromptEnvironmentContext(options: {
  sshConnectionId?: string | null
  workingFolder?: string
  sshConnection?: {
    name?: string | null
    host?: string | null
    defaultDirectory?: string | null
  } | null
}): PromptEnvironmentContext {
  const rawPlatform = typeof navigator !== 'undefined' ? navigator.platform : 'unknown'
  return resolvePromptEnvironmentFromPlatform({
    platform: rawPlatform,
    sshConnectionId: options.sshConnectionId,
    workingFolder: options.workingFolder,
    sshConnection: options.sshConnection
  })
}

export function buildSystemPrompt(options: {
  mode: AgentModePromptMode
  workingFolder?: string
  sessionId?: string
  userRules?: string
  toolDefs?: import('../api/types').ToolDefinition[]
  language?: string
  planMode?: boolean
  hasActiveTeam?: boolean
  activeTeam?: ActiveTeam | null
  memorySnapshot?: LayeredMemorySnapshot
  sessionScope?: SessionMemoryScope
  environmentContext?: PromptEnvironmentContext
}): string {
  const toolDefs = options.toolDefs ?? toolRegistry.getStableDefinitions()
  const environmentContext =
    options.environmentContext ??
    resolvePromptEnvironmentContext({ workingFolder: options.workingFolder })
  return buildAgentModeSystemPrompt({
    mode: options.mode,
    workingFolder: options.workingFolder,
    userRules: options.userRules,
    languageName: resolveLanguageName(options.language),
    toolDefs,
    environmentContext,
    globalHomePath: options.memorySnapshot?.globalHomePath,
    hasActiveTeam: options.hasActiveTeam,
    teamCoordinatorPrompt: options.activeTeam
      ? buildLeadCoordinatorPrompt(options.activeTeam)
      : null
  })
}
