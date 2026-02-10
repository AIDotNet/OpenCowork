import type { ToolCallState } from '../types'

// --- Team Member ---

export type TeamMemberStatus = 'working' | 'idle' | 'waiting' | 'stopped'

export interface TeamMember {
  id: string
  name: string
  model: string
  status: TeamMemberStatus
  currentTaskId: string | null
  iteration: number
  toolCalls: ToolCallState[]
  streamingText: string
  startedAt: number
  completedAt: number | null
}

// --- Team Task ---

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TeamTask {
  id: string
  subject: string
  description: string
  status: TeamTaskStatus
  owner: string | null
  dependsOn: string[]
  activeForm?: string
}

// --- Team Message ---

export type TeamMessageType = 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response'

export interface TeamMessage {
  id: string
  from: string
  to: string | 'all'
  type: TeamMessageType
  content: string
  summary?: string
  timestamp: number
}

// --- Team Events (yielded to UI) ---

export type TeamEvent =
  | { type: 'team_start'; teamName: string; description: string }
  | { type: 'team_member_add'; member: TeamMember }
  | { type: 'team_member_update'; memberId: string; patch: Partial<TeamMember> }
  | { type: 'team_member_remove'; memberId: string }
  | { type: 'team_task_add'; task: TeamTask }
  | { type: 'team_task_update'; taskId: string; patch: Partial<TeamTask> }
  | { type: 'team_message'; message: TeamMessage }
  | { type: 'team_end' }
