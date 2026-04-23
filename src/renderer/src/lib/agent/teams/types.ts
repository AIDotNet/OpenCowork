import type { ToolCallState } from '../types'
import type { TokenUsage } from '../../api/types'
import type {
  TeamRuntimeBackendType,
  TeamRuntimeMessageType,
  TeamRuntimePermissionMode
} from '../../../../../shared/team-runtime-types'

export type TeamMemberStatus = 'working' | 'idle' | 'waiting' | 'stopped' | 'completed' | 'failed'

export interface TeamMember {
  id: string
  name: string
  model: string
  agentName?: string
  backendType?: TeamRuntimeBackendType
  role?: 'lead' | 'worker'
  status: TeamMemberStatus
  currentTaskId: string | null
  iteration: number
  toolCalls: ToolCallState[]
  streamingText: string
  startedAt: number
  completedAt: number | null
  usage?: TokenUsage
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TeamTask {
  id: string
  subject: string
  description: string
  status: TeamTaskStatus
  owner: string | null
  dependsOn: string[]
  activeForm?: string
  report?: string
}

export type TeamMessageType = TeamRuntimeMessageType

export interface TeamMessage {
  id: string
  from: string
  to: string | 'all'
  type: TeamMessageType
  content: string
  summary?: string
  timestamp: number
}

export type TeamEvent =
  | {
      type: 'team_start'
      sessionId?: string
      teamName: string
      description: string
      runtimePath?: string
      leadAgentId?: string
      defaultBackend?: TeamRuntimeBackendType
      permissionMode?: TeamRuntimePermissionMode
      teamAllowedPaths?: string[]
      createdAt?: number
    }
  | { type: 'team_member_add'; sessionId?: string; member: TeamMember }
  | { type: 'team_member_update'; sessionId?: string; memberId: string; patch: Partial<TeamMember> }
  | { type: 'team_member_remove'; sessionId?: string; memberId: string }
  | { type: 'team_task_add'; sessionId?: string; task: TeamTask }
  | { type: 'team_task_update'; sessionId?: string; taskId: string; patch: Partial<TeamTask> }
  | { type: 'team_message'; sessionId?: string; message: TeamMessage }
  | { type: 'team_end'; sessionId?: string }
