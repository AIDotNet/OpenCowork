export const HOOK_EVENTS = {
  sessionStart: 'SessionStart',
  userPromptSubmit: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  permissionRequest: 'PermissionRequest',
  postToolUse: 'PostToolUse',
  preCompact: 'PreCompact',
  postCompact: 'PostCompact',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  stop: 'Stop'
} as const

export type HookEventName = (typeof HOOK_EVENTS)[keyof typeof HOOK_EVENTS]
export const HOOK_EVENT_NAMES = Object.values(HOOK_EVENTS) as HookEventName[]

export const HOOK_TRUST_STATUS = {
  pending: 'pending',
  trusted: 'trusted',
  denied: 'denied',
  disabled: 'disabled',
  invalid: 'invalid',
  changed: 'changed'
} as const

export const HOOK_RUN_STATUS = {
  completed: 'completed',
  blocked: 'blocked',
  failed: 'failed',
  timeout: 'timeout',
  skipped: 'skipped'
} as const

export const HOOK_IPC_CHANNELS = {
  list: 'hooks:list',
  reload: 'hooks:reload',
  setTrust: 'hooks:set-trust',
  setDisabled: 'hooks:set-disabled',
  openSource: 'hooks:open-source',
  getRunHistory: 'hooks:get-run-history',
  openUserConfig: 'hooks:open-user-config',
  runUserPromptSubmit: 'hooks:run-user-prompt-submit'
} as const

export const HOOK_REVERSE_METHODS = {
  run: 'hooks/run'
} as const

export const HOOK_DECISION = {
  block: 'block'
} as const

export const HOOK_PERMISSION_BEHAVIOR = {
  allow: 'allow',
  deny: 'deny'
} as const

export const HOOK_SESSION_START_SOURCE = {
  startup: 'startup',
  resume: 'resume',
  clear: 'clear',
  compact: 'compact',
  background: 'background'
} as const

export const HOOK_RUN_SOURCE = {
  chat: 'chat',
  pluginAutoReply: 'plugin_auto_reply',
  pet: 'pet',
  translation: 'translation',
  cron: 'cron',
  continue: 'continue',
  agentBridge: 'agent_bridge'
} as const

export const HOOK_USER_PROMPT_SOURCE_KIND = {
  chat: 'chat',
  queued: 'queued',
  quoted: 'quoted',
  slashCommand: 'slash_command'
} as const

export const HOOK_COMPACT_TRIGGER = {
  manual: 'manual',
  auto: 'auto'
} as const

export const HOOK_STOP_REASON = {
  completed: 'completed',
  maxIterations: 'max_iterations',
  error: 'error',
  cancelled: 'cancelled',
  aborted: 'aborted'
} as const

export type HookSourceKind = 'user' | 'project'
export type HookTrustStatus = (typeof HOOK_TRUST_STATUS)[keyof typeof HOOK_TRUST_STATUS]
export type HookRunStatus = (typeof HOOK_RUN_STATUS)[keyof typeof HOOK_RUN_STATUS]
export type HookDecision = (typeof HOOK_DECISION)[keyof typeof HOOK_DECISION]
export type HookPermissionBehavior =
  (typeof HOOK_PERMISSION_BEHAVIOR)[keyof typeof HOOK_PERMISSION_BEHAVIOR]
export type HookSessionStartSource =
  (typeof HOOK_SESSION_START_SOURCE)[keyof typeof HOOK_SESSION_START_SOURCE]
export type HookRunSource = (typeof HOOK_RUN_SOURCE)[keyof typeof HOOK_RUN_SOURCE]
export type HookUserPromptSourceKind =
  (typeof HOOK_USER_PROMPT_SOURCE_KIND)[keyof typeof HOOK_USER_PROMPT_SOURCE_KIND]
export type HookCompactTrigger = (typeof HOOK_COMPACT_TRIGGER)[keyof typeof HOOK_COMPACT_TRIGGER]
export type HookStopReason = (typeof HOOK_STOP_REASON)[keyof typeof HOOK_STOP_REASON]

export interface HooksConfigFile {
  schemaVersion?: 1
  hooks: Partial<Record<HookEventName, HookMatcherGroupConfig[]>>
}

export interface HookMatcherGroupConfig {
  matcher?: string
  hooks: HookCommandHandlerConfig[]
}

export interface HookCommandHandlerConfig {
  type: 'command'
  command: string
  commandWindows?: string
  timeout?: number
  statusMessage?: string
  cwd?: string
  env?: Record<string, string>
  disabled?: boolean
  platforms?: Array<'darwin' | 'win32' | 'linux'>
}

export interface HookArtifactHashView {
  path: string
  hash: string
  status: 'ok' | 'changed' | 'unreadable' | 'untracked'
}

export interface HookSourceView {
  id: string
  kind: HookSourceKind
  label: string
  path: string
  realPath?: string
  exists: boolean
  totalHooks: number
  pendingHooks: number
  invalidHooks: number
  lastLoadedAt: number
  configHash?: string
  error?: string
}

export interface HookRunSummary {
  id: string
  trustKey: string
  runId?: string
  sessionId?: string
  eventName: HookEventName
  startedAt: number
  completedAt?: number
  durationMs?: number
  status: HookRunStatus
  exitCode?: number
  skippedReason?: string
  stdoutPreview?: string
  stderrPreview?: string
  decision?: unknown
  error?: string
}

export interface HookDefinitionView {
  id: string
  sourceId: string
  sourceKind: HookSourceKind
  sourcePath: string
  sourceRealPath?: string
  projectId?: string
  projectRoot?: string
  eventName: HookEventName
  eventLabel: string
  matcher: string
  handlerType: 'command'
  command: string
  resolvedCommand: string
  resolvedCwd: string
  timeoutSeconds: number
  statusMessage?: string
  definitionHash: string
  identityKey: string
  trustKey: string
  sourceConfigHash: string
  artifactHashes: HookArtifactHashView[]
  trustStatus: HookTrustStatus
  validationErrors: string[]
  configDisabled: boolean
  localDisabled: boolean
  envKeys: string[]
  groupIndex: number
  hookIndex: number
  lastRun?: HookRunSummary
}

export interface HookListView {
  runtime: {
    enabled: boolean
  }
  sources: HookSourceView[]
  hooks: HookDefinitionView[]
  summary: {
    total: number
    pending: number
    trusted: number
    denied: number
    disabled: number
    invalid: number
    changed: number
  }
}

export interface HooksListArgs {
  projectId?: string | null
  sessionId?: string | null
  projectRoot?: string | null
  sshConnectionId?: string | null
}

export interface HooksSetTrustArgs extends HooksListArgs {
  hookId: string
  decision: 'trusted' | 'denied'
  expectedTrustKey: string
  expectedDefinitionHash: string
  expectedSourceConfigHash: string
}

export interface HooksSetDisabledArgs extends HooksListArgs {
  hookId: string
  disabled: boolean
  expectedTrustKey: string
}

export interface HooksOpenSourceArgs extends HooksListArgs {
  hookId: string
  target: 'config' | 'artifact'
  expectedTrustKey: string
}

export interface HooksRunHistoryArgs extends HooksListArgs {
  hookId: string
  expectedTrustKey: string
  limit?: number
}

export interface HookSourceInput {
  kind: HookSourceKind
  path: string
  projectRoot?: string
}

export interface BaseHookInput {
  hookEventName: HookEventName
  hookRunId: string
  appVersion: string
  sessionId?: string
  runId?: string
  turnId?: string
  cwd: string
  hookSource: HookSourceInput
  hook: {
    eventName: HookEventName
    matcher: string
    definitionHash: string
    trustKey: string
  }
  workspace?: {
    projectId?: string
    workingFolder?: string
    target: 'local' | 'ssh' | 'none'
  }
  openCoworkPermissionMode?: 'default' | 'autoApprove' | 'plan' | 'background'
}

export interface SessionStartInput extends BaseHookInput {
  hookEventName: 'SessionStart'
  source: HookSessionStartSource
  runSource: HookRunSource
  sessionMode?: string
  toolNames: string[]
  providerType: string
  modelId?: string
}

export interface UserPromptSubmitInput extends BaseHookInput {
  hookEventName: 'UserPromptSubmit'
  prompt: string
  sourceKind: HookUserPromptSourceKind
  hasImages: boolean
}

export interface PreToolUseInput extends BaseHookInput {
  hookEventName: 'PreToolUse'
  toolName: string
  toolUseId: string
  toolInput: unknown
  requiresApproval: boolean
}

export interface PermissionRequestInput extends BaseHookInput {
  hookEventName: 'PermissionRequest'
  toolName: string
  toolInput: unknown
  reason?: string
  sourceRequiresUserApproval: boolean
}

export interface PostToolUseInput extends BaseHookInput {
  hookEventName: 'PostToolUse'
  toolName: string
  toolUseId: string
  toolInput: unknown
  toolResponse: unknown
  isError: boolean
}

export interface CompactInput extends BaseHookInput {
  hookEventName: 'PreCompact' | 'PostCompact'
  trigger: HookCompactTrigger
  originalCount?: number
  newCount?: number
}

export interface SubagentInput extends BaseHookInput {
  hookEventName: 'SubagentStart' | 'SubagentStop'
  agentId: string
  agentType: string
  toolUseId?: string
}

export interface StopInput extends BaseHookInput {
  hookEventName: 'Stop'
  reason: HookStopReason
  stopHookActive: boolean
  lastAssistantMessage?: string | null
}

export type HookInput =
  | SessionStartInput
  | UserPromptSubmitInput
  | PreToolUseInput
  | PermissionRequestInput
  | PostToolUseInput
  | CompactInput
  | SubagentInput
  | StopInput

export interface CommonHookOutput {
  systemMessage?: string
  stopReason?: string
}

export interface ContextHookOutput extends CommonHookOutput {
  hookSpecificOutput?: {
    additionalContext?: string
  }
}

export interface UserPromptSubmitOutput extends CommonHookOutput {
  decision?: HookDecision
  reason?: string
  hookSpecificOutput?: {
    additionalContext?: string
    updatedPrompt?: string
  }
}

export interface PreToolUseOutput extends CommonHookOutput {
  decision?: HookDecision
  reason?: string
  hookSpecificOutput?: {
    additionalContext?: string
    updatedInput?: Record<string, unknown>
  }
}

export interface PermissionRequestOutput extends CommonHookOutput {
  hookSpecificOutput?: {
    decision?: {
      behavior: HookPermissionBehavior
      message?: string
    }
  }
}

export interface PostToolUseOutput extends CommonHookOutput {
  decision?: HookDecision
  reason?: string
  hookSpecificOutput?: {
    additionalContext?: string
    replacementToolFeedback?: unknown
  }
}

export interface ContinuationHookOutput extends CommonHookOutput {
  decision?: HookDecision
  reason?: string
}

export type HookOutput =
  | ContextHookOutput
  | UserPromptSubmitOutput
  | PreToolUseOutput
  | PermissionRequestOutput
  | PostToolUseOutput
  | ContinuationHookOutput

export interface HookRunRequest {
  eventName: HookEventName
  matcherValue?: string
  sessionId?: string
  runId?: string
  projectId?: string
  projectRoot?: string
  sshConnectionId?: string | null
  cancellationKey?: string
  input: Record<string, unknown>
}

export interface HookRunDecision {
  behavior?: HookPermissionBehavior
  message?: string
}

export interface HookRunResult {
  ok: boolean
  blocked?: boolean
  reason?: string
  systemMessages?: string[]
  additionalContext?: string[]
  updatedPrompt?: string
  updatedInput?: Record<string, unknown>
  replacementToolFeedback?: unknown
  permissionDecision?: HookRunDecision
  error?: string
}

export function collectHookContextTexts(
  result: Pick<HookRunResult, 'systemMessages' | 'additionalContext'>
): string[] {
  return [
    ...(result.systemMessages ?? [])
      .filter((message) => message.trim().length > 0)
      .map((message) => `<hook-system-message>\n${message.trim()}\n</hook-system-message>`),
    ...(result.additionalContext ?? [])
      .filter((context) => context.trim().length > 0)
      .map((context) => `<hook-additional-context>\n${context.trim()}\n</hook-additional-context>`)
  ]
}
