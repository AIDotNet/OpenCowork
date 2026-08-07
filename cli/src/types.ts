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

export type RuntimeEvent =
  | { type: 'assistant.start'; id: string; model?: string }
  | { type: 'assistant.delta'; id: string; text: string }
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
  | { type: 'permission.request'; request: PermissionRequest }
  | { type: 'tasks.update'; tasks: TaskItem[] }
  | { type: 'system'; message: Extract<Message, { kind: 'system' }> }
  | { type: 'turn.done' }

export interface AgentRuntime {
  initialMessages?: Message[]
  initialTasks?: TaskItem[]
  send(prompt: string, signal: AbortSignal): AsyncIterable<RuntimeEvent>
  respondToPermission?(requestId: string, decision: PermissionDecision): Promise<void>
  dispose(): Promise<void>
}

export type PermissionDecision = 'allow_once' | 'allow_session' | 'deny'
