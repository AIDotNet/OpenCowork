import type { SubAgentEvent } from '@renderer/lib/agent/sub-agents/types'
import type { TeamEvent } from '@renderer/lib/agent/teams/types'
import type { ToolCallState } from '@renderer/lib/agent/types'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useTaskStore, type TaskItem } from '@renderer/stores/task-store'
import { useTeamStore, type ActiveTeam } from '@renderer/stores/team-store'
import type { TeamRuntimeSnapshot } from '../../../shared/team-runtime-types'

export type AgentRuntimeSyncEvent =
  | { kind: 'set_running'; running: boolean }
  | {
      kind: 'set_session_status'
      sessionId: string
      status: 'running' | 'retrying' | 'completed' | null
    }
  | { kind: 'add_tool_call'; toolCall: ToolCallState; sessionId?: string | null }
  | {
      kind: 'update_tool_call'
      id: string
      patch: Partial<ToolCallState>
      sessionId?: string | null
    }
  | { kind: 'task_add'; task: TaskItem }
  | {
      kind: 'task_update'
      id: string
      patch: Partial<Omit<TaskItem, 'id' | 'createdAt'>>
    }
  | { kind: 'task_delete'; id: string }
  | { kind: 'task_delete_session'; sessionId: string }
  | { kind: 'team_event'; event: TeamEvent; sessionId?: string | null }
  | { kind: 'team_snapshot'; snapshot: TeamRuntimeSnapshot; sessionId?: string | null }
  | {
      kind: 'team_meta'
      patch: Partial<Pick<ActiveTeam, 'permissionMode' | 'teamAllowedPaths'>>
    }
  | { kind: 'clear_session_team'; sessionId: string }
  | { kind: 'subagent_event'; event: SubAgentEvent; sessionId?: string | null }
  | { kind: 'resolve_approval'; toolCallId: string; approved: boolean }
  | { kind: 'clear_pending_approvals' }

let suppressionDepth = 0

export function isAgentRuntimeSyncSuppressed(): boolean {
  return suppressionDepth > 0
}

export function withAgentRuntimeSyncSuppressed<T>(fn: () => T): T {
  suppressionDepth += 1
  try {
    return fn()
  } finally {
    suppressionDepth = Math.max(0, suppressionDepth - 1)
  }
}

export function emitAgentRuntimeSync(event: AgentRuntimeSyncEvent): void {
  if (isAgentRuntimeSyncSuppressed()) return
  ipcClient.send(IPC.AGENT_RUNTIME_SYNC, event)
}

function applyAgentRuntimeSyncEvent(event: AgentRuntimeSyncEvent): void {
  withAgentRuntimeSyncSuppressed(() => {
    const store = useAgentStore.getState()
    switch (event.kind) {
      case 'set_running':
        store.setRunning(event.running)
        return
      case 'set_session_status':
        store.setSessionStatus(event.sessionId, event.status)
        return
      case 'add_tool_call':
        store.addToolCall(event.toolCall, event.sessionId)
        return
      case 'update_tool_call':
        store.updateToolCall(event.id, event.patch, event.sessionId)
        return
      case 'task_add':
        useTaskStore.getState().applySyncedTaskAdd(event.task)
        return
      case 'task_update':
        useTaskStore.getState().applySyncedTaskUpdate(event.id, event.patch)
        return
      case 'task_delete':
        useTaskStore.getState().applySyncedTaskDelete(event.id)
        return
      case 'task_delete_session':
        useTaskStore.getState().applySyncedDeleteSessionTasks(event.sessionId)
        return
      case 'team_event':
        useTeamStore.getState().handleTeamEvent(event.event, event.sessionId ?? undefined)
        return
      case 'team_snapshot':
        useTeamStore.getState().syncRuntimeSnapshot(event.snapshot, event.sessionId ?? undefined)
        return
      case 'team_meta':
        useTeamStore.getState().updateTeamMeta(event.patch)
        return
      case 'clear_session_team':
        useTeamStore.getState().clearSessionTeam(event.sessionId)
        return
      case 'subagent_event':
        store.handleSubAgentEvent(event.event, event.sessionId ?? undefined)
        return
      case 'resolve_approval':
        store.resolveApproval(event.toolCallId, event.approved)
        return
      case 'clear_pending_approvals':
        store.clearPendingApprovals()
        return
    }
  })
}

export function installAgentRuntimeSyncListener(): () => void {
  return ipcClient.on(IPC.AGENT_RUNTIME_SYNC, (data: unknown) => {
    applyAgentRuntimeSyncEvent(data as AgentRuntimeSyncEvent)
  })
}
