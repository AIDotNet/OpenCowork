export type TeamRuntimeBackendType = 'in-process'

export type TeamRuntimePermissionMode = 'default' | 'plan'

export type TeamRuntimeMessageType =
  | 'message'
  | 'broadcast'
  | 'shutdown_request'
  | 'shutdown_response'
  | 'idle_notification'
  | 'permission_request'
  | 'permission_response'
  | 'plan_approval_request'
  | 'plan_approval_response'
  | 'team_permission_update'
  | 'mode_set_request'

export type TeamRuntimeMemberStatus = 'working' | 'idle' | 'waiting' | 'stopped'

export interface TeamRuntimeMemberRecord {
  agentId: string
  name: string
  role: 'lead' | 'worker'
  backendType: TeamRuntimeBackendType
  model?: string
  agentType?: string
  status: TeamRuntimeMemberStatus
  currentTaskId?: string | null
  sessionId?: string
  isActive: boolean
  startedAt: number
  completedAt?: number | null
}

export interface TeamRuntimeMessageRecord {
  id: string
  from: string
  to: string | 'all'
  type: TeamRuntimeMessageType
  content: string
  summary?: string
  timestamp: number
}

export type TeamRuntimeTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TeamRuntimeTaskRecord {
  id: string
  subject: string
  description: string
  status: TeamRuntimeTaskStatus
  owner: string | null
  dependsOn: string[]
  activeForm?: string
  report?: string
}

export interface TeamRuntimePermissionResponsePayload {
  approved: boolean
  requestId: string
}

export interface TeamRuntimePlanApprovalRequestPayload {
  requestId: string
  plan: string
  taskId?: string | null
}

export interface TeamRuntimePlanApprovalResponsePayload {
  approved: boolean
  requestId: string
  feedback?: string
}

export interface TeamRuntimePermissionUpdatePayload {
  permissionMode?: TeamRuntimePermissionMode
  teamAllowedPaths?: string[]
}

export interface UpdateTeamRuntimeMemberArgs {
  teamName: string
  memberId: string
  patch: Partial<TeamRuntimeMemberRecord>
}

export interface UpdateTeamRuntimeManifestArgs {
  teamName: string
  patch: Partial<
    Pick<TeamRuntimeManifest, 'permissionMode' | 'teamAllowedPaths' | 'tasks' | 'updatedAt'>
  >
}

export interface TeamRuntimeManifest {
  version: 1
  name: string
  description: string
  createdAt: number
  updatedAt: number
  runtimePath: string
  leadAgentId: string
  leadSessionId?: string
  defaultBackend: TeamRuntimeBackendType
  permissionMode: TeamRuntimePermissionMode
  teamAllowedPaths: string[]
  members: TeamRuntimeMemberRecord[]
  tasks: TeamRuntimeTaskRecord[]
}

export interface TeamRuntimeSnapshot {
  team: TeamRuntimeManifest
  recentMessages: TeamRuntimeMessageRecord[]
}

export interface CreateTeamRuntimeArgs {
  teamName: string
  description: string
  sessionId?: string
  workingFolder?: string
  defaultBackend?: TeamRuntimeBackendType
}

export interface TeamRuntimeCreateResult {
  teamName: string
  runtimePath: string
  leadAgentId: string
  createdAt: number
  defaultBackend: TeamRuntimeBackendType
  permissionMode: TeamRuntimePermissionMode
  teamAllowedPaths: string[]
}

export interface DeleteTeamRuntimeArgs {
  teamName: string
}

export interface AppendTeamRuntimeMessageArgs {
  teamName: string
  message: TeamRuntimeMessageRecord
}

export interface GetTeamRuntimeSnapshotArgs {
  teamName: string
  limit?: number
}

export interface ConsumeTeamRuntimeMessagesArgs {
  teamName: string
  afterTimestamp?: number
  recipient?: string
  includeBroadcast?: boolean
  limit?: number
}
