import { homedir, platform as nodePlatform } from 'node:os'
import { join } from 'node:path'
import {
  buildAgentModeSystemPrompt,
  buildChatModeSystemPrompt,
  buildLeadCoordinatorPrompt,
  isAgentModePromptMode,
  mapNodePlatformToPromptPlatform,
  resolvePromptEnvironmentFromPlatform,
  resolvePromptLanguageName,
  type PromptSkill,
  type TeamCoordinatorSnapshot
} from '../../../shared/agent-system-prompt'

export type HostedSystemPromptInput = {
  mode: string
  workingFolder: string | null
  sshConnectionId?: string | null
  toolNames?: readonly string[]
  language?: string | null
  userRules?: string | null
  skills?: readonly PromptSkill[]
  sshConnection?: {
    name?: string | null
    host?: string | null
    defaultDirectory?: string | null
  } | null
  planMode?: boolean
  platform?: string
  globalHomePath?: string | null
  memoryContext?: string | null
  hasActiveTeam?: boolean
  activeTeam?: TeamCoordinatorSnapshot | null
  teamCoordinatorPrompt?: string | null
}

export function resolveDefaultGlobalMemoryHomePath(): string {
  return join(homedir(), '.open-cowork')
}

export function buildHostedSessionSystemPrompt(args: HostedSystemPromptInput): string {
  const promptPlatform = mapNodePlatformToPromptPlatform(args.platform ?? nodePlatform())
  const environmentContext = resolvePromptEnvironmentFromPlatform({
    platform: promptPlatform,
    sshConnectionId: args.sshConnectionId,
    workingFolder: args.workingFolder,
    sshConnection: args.sshConnection
  })
  const languageName = resolvePromptLanguageName(args.language)
  const userRules = args.userRules?.trim() || undefined
  const workingFolder = args.workingFolder
  const planMode = args.planMode === true

  if (!isAgentModePromptMode(args.mode)) {
    return buildChatModeSystemPrompt({
      languageName,
      userRules,
      workingFolder,
      environmentContext,
      planMode,
      memoryContext: args.memoryContext
    })
  }

  const skills = [...(args.skills ?? [])]
    .map((skill) => ({
      name: skill.name.trim(),
      description: skill.description.trim()
    }))
    .filter((skill) => skill.name)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))

  const activeTeam = args.activeTeam ?? null
  const teamCoordinatorPrompt =
    args.teamCoordinatorPrompt ?? (activeTeam ? buildLeadCoordinatorPrompt(activeTeam) : null)

  return buildAgentModeSystemPrompt({
    mode: args.mode,
    workingFolder,
    userRules,
    languageName,
    planMode,
    toolDefs: (args.toolNames ?? []).map((name) => ({ name })),
    skills,
    environmentContext,
    memoryContext: args.memoryContext,
    globalHomePath: args.globalHomePath ?? resolveDefaultGlobalMemoryHomePath(),
    hasActiveTeam: args.hasActiveTeam === true || activeTeam != null,
    teamCoordinatorPrompt
  })
}
