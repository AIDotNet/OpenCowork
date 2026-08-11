export type TuiMode = 'classic' | 'fullscreen'

export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto'

export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface PromptImageAttachment {
  id: string
  name: string
  mediaType: SupportedImageMediaType
  data: string
  size: number
}

export type PromptImageSummary = Omit<PromptImageAttachment, 'data'>

export interface FileReferenceCandidate {
  name: string
  path: string
}

export interface PromptFileReference {
  id: string
  kind: 'file'
  name: string
  path: string
  isWorkspaceFile: boolean
}

/** References are structured separately from editor text so future message/shell sources can share it. */
export type PromptReference = PromptFileReference

export type PromptReferenceSummary = PromptReference

export interface PromptSubmission {
  text: string
  images: PromptImageAttachment[]
  references: PromptReference[]
}

export type AssistantContentSegment =
  | {
      kind: 'text'
      text: string
    }
  | {
      completedAt?: number
      kind: 'thinking'
      startedAt: number
      text: string
      traceAvailable: boolean
    }

export interface ToolDiffLine {
  kind: 'context' | 'removed' | 'added' | 'meta'
  text: string
}

export interface ToolDiff {
  additions: number
  deletions: number
  lines: ToolDiffLine[]
  path: string
  replaceAll: boolean
}

export type Message =
  | {
      id: string
      kind: 'user'
      text: string
      images?: PromptImageSummary[]
      references?: PromptReferenceSummary[]
    }
  | {
      id: string
      kind: 'assistant'
      text: string
      segments?: AssistantContentSegment[]
      reasoningTokens?: number
      streaming?: boolean
      model?: string
      timestamp?: string
    }
  | {
      id: string
      kind: 'tool'
      title: string
      detail?: string
      status: 'running' | 'success' | 'error'
      summary?: string
      diff?: ToolDiff
    }
  | {
      id: string
      kind: 'system'
      text: string
      tone?: 'muted' | 'warning' | 'error' | 'success'
    }

export interface TaskItem {
  id: string
  label: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface PermissionRequest {
  id: string
  tool: string
  title: string
  detail: string
  risk?: string
}

export interface AskUserOption {
  label: string
  description?: string
  preview?: string
}

export interface AskUserQuestion {
  question: string
  header: string
  options: AskUserOption[]
  multiSelect: boolean
}

export interface AskUserRequest {
  id: string
  toolUseId: string
  runId?: string
  sessionId?: string
  questions: AskUserQuestion[]
}

export interface AskUserAnnotation {
  preview?: string
  notes?: string
}

export interface AskUserAnswerPayload {
  answers: Record<string, string | string[]>
  annotations?: Record<string, AskUserAnnotation>
}

export type PlanStatus =
  | 'drafting'
  | 'awaiting_review'
  | 'approved'
  | 'implementing'
  | 'completed'
  | 'rejected'

export interface PlanSnapshot {
  id: string
  sessionId: string
  title: string
  status: PlanStatus
  filePath?: string
  content?: string
  specJson?: string
  createdAt: number
  updatedAt: number
}

export type PlanApprovalMode = 'auto' | 'acceptEdits' | 'manual'

export interface CodeGraphStatus {
  enabled: boolean
  fullToolSurface: boolean
  indexed: boolean
  toolNames: string[]
  message: string
}

export interface ModelOption {
  providerId: string
  providerName: string
  providerType: string
  providerBuiltinId?: string
  authMode: 'apiKey' | 'oauth' | 'channel'
  modelId: string
  modelName: string
  description: string
  supportsVision: boolean
}

export interface ModelGroup {
  providerId: string
  providerName: string
  providerType: string
  providerBuiltinId?: string
  authMode: 'apiKey' | 'oauth' | 'channel'
  models: ModelOption[]
}

export interface ModelSelection {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
}

export interface ModelCatalog {
  groups: ModelGroup[]
  active: ModelSelection | null
  totalModels: number
}

export interface ModelConfiguration {
  builtinSearchEnabled: boolean
  cacheTtl: '5m' | '1h'
  contextLength?: number
  defaultReasoningEffort: string
  fastModeEnabled: boolean
  imageGenerationEnabled: boolean
  inputPrice?: number
  maxOutputTokens?: number
  outputPrice?: number
  providerType: string
  reasoningEffort: string
  reasoningEffortCustomized: boolean
  reasoningEffortLevels: string[]
  selection: ModelSelection
  supportsBuiltinSearch: boolean
  supportsCacheTtl: boolean
  supportsFastMode: boolean
  supportsImageGeneration: boolean
  supportsResponsesWebsocket: boolean
  supportsThinking: boolean
  supportsVision: boolean
  thinkingBudget?: number
  thinkingBudgetMax?: number
  thinkingBudgetMin?: number
  thinkingEnabled: boolean
  websocketMode: 'auto' | 'disabled'
}

export interface ModelConfigurationPatch {
  builtinSearchEnabled?: boolean
  cacheTtl?: '5m' | '1h'
  fastModeEnabled?: boolean
  imageGenerationEnabled?: boolean
  reasoningEffort?: string | null
  thinkingBudget?: number
  thinkingEnabled?: boolean
  websocketMode?: 'auto' | 'disabled'
}

export interface AgentOption {
  description: string
  maxTurns?: number
  model?: string
  name: string
  source: 'native' | 'user'
}

export type RuntimeActivityKind = 'working' | 'compressing'

export interface ContextCompressionResult {
  compressed: boolean
  originalCount: number
  newCount: number
  messagesSummarized?: number
  summarizerFailed?: boolean
  error?: string
}

export interface ContextSnapshot {
  compressionEnabled: boolean
  contextLength: number
  estimatedTokens: number
  messageCount: number
  threshold: number
  triggerTokens: number
}

export type RewindAction =
  | 'restore-code-and-conversation'
  | 'restore-conversation'
  | 'restore-code'
  | 'summarize-from'
  | 'summarize-up-to'

export interface RewindCheckpoint {
  changedFileCount: number
  codeRestoreAvailable: boolean
  createdAt: number
  id: string
  prompt: string
  userIndex: number
}

export interface RewindResult {
  action: RewindAction
  checkpoint: RewindCheckpoint
  conversationForked: boolean
  failedFiles: string[]
  newMessageCount: number
  originalMessageCount: number
  restoredFileCount: number
  restoredImages?: PromptImageAttachment[]
  restoredPrompt?: string
  restoredReferences?: PromptReference[]
  summarized: boolean
  transcript: Message[]
}

export interface UsageSnapshot {
  billableInputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  estimatedCostUsd: number | null
  inputTokens: number
  model: string
  outputTokens: number
  reasoningTokens: number
  requestCount: number
}

export type TurnStatusPhase = 'requesting' | 'thinking' | 'responding' | 'tool-use'

export interface TurnStatusSnapshot {
  activeResponseCharacters: number
  completedOutputTokens: number
  id: string
  phase: TurnStatusPhase
  requestTokens: number
  startedAt: number
  verb: string
}

export type ConfigSettingValue = boolean | number | string

export interface ConfigChoice {
  label: string
  value: string
}

export interface ConfigEntry {
  action?: 'model' | 'compressionModel'
  category: 'Model' | 'Context' | 'Runtime' | 'Tools'
  choices?: ConfigChoice[]
  description: string
  disabled?: boolean
  format?: 'integer' | 'percentage' | 'seconds'
  key: string
  kind: 'action' | 'boolean' | 'enum' | 'number'
  label: string
  max?: number
  min?: number
  step?: number
  value: ConfigSettingValue
}

export interface ConfigCatalog {
  compressionModel: ModelSelection | null
  entries: ConfigEntry[]
}

export interface RuntimeDoctorSnapshot {
  agentProtocolVersion: number
  configuredModel: string
  executable: string
  pid: number
  protocolVersion: number
  routeCount: number
  runtime: string
  runtimeVersion: string
}

/** UI projection events. The canonical AgentStreamEnvelope remains the worker wire contract. */
export type UiEvent =
  | { type: 'assistant.start'; id: string; model?: string }
  | { type: 'assistant.delta'; id: string; text: string }
  | { type: 'assistant.thinking'; id: string; thinking: string }
  | { type: 'assistant.done'; id: string; reasoningTokens?: number }
  | {
      type: 'tool.start'
      id: string
      title: string
      detail?: string
    }
  | {
      type: 'tool.done'
      id: string
      status: 'success' | 'error'
      diff?: ToolDiff
      summary?: string
      title?: string
    }
  | {
      type: 'tool.update'
      id: string
      detail?: string
      summary?: string
      title?: string
    }
  | { type: 'permission.request'; request: PermissionRequest }
  | { type: 'permission.cancel'; requestId: string }
  | { type: 'askUser.request'; request: AskUserRequest }
  | { type: 'askUser.cancel'; requestId: string }
  | { type: 'plan.update'; action: 'enter' | 'exit' | 'sync'; plan: PlanSnapshot }
  | { type: 'tasks.update'; tasks: TaskItem[] }
  | { type: 'runtime.activity'; activity: RuntimeActivityKind }
  | {
      type: 'runtime.usage'
      contextTokens?: number
      inputTokens?: number
      outputTokens?: number
    }
  | {
      type: 'runtime.retry'
      attempt: number
      maxAttempts: number
      delayMs: number
      reason?: string
      statusCode?: number
    }
  | { type: 'context-compression.start' }
  | {
      type: 'context-compression.done'
      originalCount: number
      newCount: number
      messagesSummarized?: number
      summarizerFailed?: boolean
      error?: string
    }
  | { type: 'system'; message: Extract<Message, { kind: 'system' }> }
  | { type: 'turn.done' }

export interface AgentRuntime {
  send(submission: PromptSubmission, signal: AbortSignal): AsyncIterable<UiEvent>
  getAgentCatalog(): AgentOption[]
  getConfigCatalog?(): ConfigCatalog
  getContextSnapshot?(): ContextSnapshot
  getModelCatalog(): ModelCatalog
  getModelConfiguration?(selection: ModelSelection): ModelConfiguration
  estimateRequestTokens?(submission: PromptSubmission): number
  searchFiles?(query: string, signal?: AbortSignal): Promise<FileReferenceCandidate[]>
  getUsageSnapshot?(): UsageSnapshot
  selectModel?(selection: ModelSelection): void
  configureModel?(selection: ModelSelection, patch: ModelConfigurationPatch): Promise<void>
  selectCompressionModel?(selection: ModelSelection | null): Promise<void>
  updateConfig?(key: string, value: ConfigSettingValue): Promise<void>
  compactContext?(
    focusPrompt: string | undefined,
    signal: AbortSignal
  ): Promise<ContextCompressionResult>
  listRewindCheckpoints?(): Promise<RewindCheckpoint[]>
  rewind?(
    checkpointId: string,
    action: RewindAction,
    instructions: string | undefined,
    signal: AbortSignal
  ): Promise<RewindResult>
  clearContext?(): Promise<void>
  newSession?(): Promise<void>
  doctor?(): Promise<RuntimeDoctorSnapshot>
  configure?(config: Partial<RuntimeSessionConfig>): void
  respondToPermission?(requestId: string, decision: PermissionDecision): Promise<void>
  respondToAskUser?(requestId: string, payload: AskUserAnswerPayload): Promise<void>
  approvePlan?(plan: PlanSnapshot, mode: PlanApprovalMode): Promise<void>
  revisePlan?(plan: PlanSnapshot, feedback: string): Promise<void>
  getCodeGraphStatus?(): Promise<CodeGraphStatus>
  dispose(): Promise<void>
}

export type PermissionDecision = 'allow_once' | 'allow_session' | 'deny'

export interface RuntimeSessionConfig {
  effort: string
  model: string
  providerId: string
  permissionMode: PermissionMode
}
