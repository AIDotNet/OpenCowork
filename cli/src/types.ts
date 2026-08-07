export type TuiMode = 'classic' | 'fullscreen'

export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto'

export type Message =
  | {
      id: string
      kind: 'user'
      text: string
    }
  | {
      id: string
      kind: 'assistant'
      text: string
      thinking?: string
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

export interface AgentOption {
  description: string
  maxTurns?: number
  model?: string
  name: string
  source: 'native' | 'user'
}

/** UI projection events. The canonical AgentStreamEnvelope remains the worker wire contract. */
export type UiEvent =
  | { type: 'assistant.start'; id: string; model?: string }
  | { type: 'assistant.delta'; id: string; text: string }
  | { type: 'assistant.thinking'; id: string; thinking: string }
  | { type: 'assistant.done'; id: string }
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
      summary?: string
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
  | { type: 'system'; message: Extract<Message, { kind: 'system' }> }
  | { type: 'turn.done' }

export interface AgentRuntime {
  send(prompt: string, signal: AbortSignal): AsyncIterable<UiEvent>
  getAgentCatalog(): AgentOption[]
  getModelCatalog(): ModelCatalog
  selectModel?(selection: ModelSelection): void
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
