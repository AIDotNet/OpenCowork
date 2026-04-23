import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { TeamMember, TeamTask, TeamMessage, TeamEvent } from '../lib/agent/teams/types'
import { emitAgentRuntimeSync, isAgentRuntimeSyncSuppressed } from '../lib/agent-runtime-sync'
import type {
  TeamRuntimeBackendType,
  TeamRuntimePermissionMode,
  TeamRuntimeSnapshot
} from '../../../shared/team-runtime-types'
import { ipcStorage } from '../lib/ipc/ipc-storage'

export interface ActiveTeam {
  name: string
  description: string
  sessionId?: string
  runtimePath?: string
  leadAgentId?: string
  defaultBackend?: TeamRuntimeBackendType
  permissionMode?: TeamRuntimePermissionMode
  teamAllowedPaths?: string[]
  lastRuntimeSyncAt?: number
  members: TeamMember[]
  tasks: TeamTask[]
  messages: TeamMessage[]
  createdAt: number
}

interface TeamStore {
  activeTeam: ActiveTeam | null
  /** Historical teams - persisted after team_end */
  teamHistory: ActiveTeam[]

  /** Unified event handler - called from use-chat-actions subscription */
  handleTeamEvent: (event: TeamEvent, sessionId?: string) => void
  syncRuntimeSnapshot: (snapshot: TeamRuntimeSnapshot, sessionId?: string) => void
  updateTeamMeta: (patch: Partial<Pick<ActiveTeam, 'permissionMode' | 'teamAllowedPaths'>>) => void

  /** Remove all team data that belongs to the given session */
  clearSessionTeam: (sessionId: string) => void
}

export const useTeamStore = create<TeamStore>()(
  persist(
    immer((set) => ({
      activeTeam: null,
      teamHistory: [],

      handleTeamEvent: (event, sessionId) => {
        const resolvedSessionId = sessionId ?? event.sessionId
        const eventWithSession =
          resolvedSessionId && !event.sessionId ? { ...event, sessionId: resolvedSessionId } : event
        set((state) => {
          switch (eventWithSession.type) {
            case 'team_start':
              state.activeTeam = {
                name: eventWithSession.teamName,
                description: eventWithSession.description,
                sessionId: resolvedSessionId,
                runtimePath: eventWithSession.runtimePath,
                leadAgentId: eventWithSession.leadAgentId,
                defaultBackend: eventWithSession.defaultBackend,
                permissionMode: eventWithSession.permissionMode,
                teamAllowedPaths: eventWithSession.teamAllowedPaths ?? [],
                members: [],
                tasks: [],
                messages: [],
                createdAt: eventWithSession.createdAt ?? Date.now(),
                lastRuntimeSyncAt: Date.now()
              }
              break
            case 'team_member_add':
              if (state.activeTeam) {
                // Guard: skip if a member with the same id or name already exists
                const dup = state.activeTeam.members.some(
                  (m) =>
                    m.id === eventWithSession.member.id || m.name === eventWithSession.member.name
                )
                if (!dup) state.activeTeam.members.push(eventWithSession.member)
              }
              break
            case 'team_member_update': {
              if (!state.activeTeam) break
              const member = state.activeTeam.members.find(
                (m) => m.id === eventWithSession.memberId
              )
              if (member) Object.assign(member, eventWithSession.patch)
              break
            }
            case 'team_member_remove': {
              if (!state.activeTeam) break
              const idx = state.activeTeam.members.findIndex(
                (m) => m.id === eventWithSession.memberId
              )
              if (idx !== -1) state.activeTeam.members.splice(idx, 1)
              break
            }
            case 'team_task_add':
              if (state.activeTeam) {
                // Guard: skip if a task with the same id already exists
                const dupTask = state.activeTeam.tasks.some(
                  (t) => t.id === eventWithSession.task.id
                )
                if (!dupTask) state.activeTeam.tasks.push(eventWithSession.task)
              }
              break
            case 'team_task_update': {
              if (!state.activeTeam) break
              const task = state.activeTeam.tasks.find((t) => t.id === eventWithSession.taskId)
              if (task) {
                // Guard: never roll back a completed task to a non-completed status
                if (
                  task.status === 'completed' &&
                  eventWithSession.patch.status &&
                  eventWithSession.patch.status !== 'completed'
                ) {
                  break
                }
                Object.assign(task, eventWithSession.patch)
              }
              break
            }
            case 'team_message':
              if (state.activeTeam) state.activeTeam.messages.push(eventWithSession.message)
              break
            case 'team_end':
              if (state.activeTeam) {
                state.teamHistory.push({ ...state.activeTeam })
              }
              state.activeTeam = null
              break
          }
        })
        if (!isAgentRuntimeSyncSuppressed()) {
          emitAgentRuntimeSync({
            kind: 'team_event',
            event: eventWithSession,
            sessionId: resolvedSessionId
          })
        }
      },
      syncRuntimeSnapshot: (snapshot, sessionId) => {
        set((state) => {
          const previous = state.activeTeam
          state.activeTeam = {
            name: snapshot.team.name,
            description: snapshot.team.description,
            sessionId: previous?.sessionId ?? sessionId,
            runtimePath: snapshot.team.runtimePath,
            leadAgentId: snapshot.team.leadAgentId,
            defaultBackend: snapshot.team.defaultBackend,
            permissionMode: snapshot.team.permissionMode,
            teamAllowedPaths: [...snapshot.team.teamAllowedPaths],
            createdAt: snapshot.team.createdAt,
            lastRuntimeSyncAt: Date.now(),
            members: snapshot.team.members.map((member) => {
              const previousMember = previous?.members.find(
                (item) => item.id === member.agentId || item.name === member.name
              )
              return {
                id: member.agentId,
                name: member.name,
                model: member.model ?? previousMember?.model ?? 'default',
                ...(member.agentType || previousMember?.agentName
                  ? { agentName: member.agentType ?? previousMember?.agentName }
                  : {}),
                backendType: member.backendType,
                role: member.role,
                status: member.status,
                currentTaskId: member.currentTaskId ?? null,
                iteration: previousMember?.iteration ?? 0,
                toolCalls: previousMember?.toolCalls ?? [],
                streamingText: previousMember?.streamingText ?? '',
                startedAt: member.startedAt,
                completedAt: member.completedAt ?? null,
                ...(previousMember?.usage ? { usage: previousMember.usage } : {})
              }
            }),
            tasks: snapshot.team.tasks.map((task) => {
              const previousTask = previous?.tasks.find((item) => item.id === task.id)
              return {
                id: task.id,
                subject: task.subject,
                description: task.description,
                status: task.status,
                owner: task.owner,
                dependsOn: [...task.dependsOn],
                ...(task.activeForm ? { activeForm: task.activeForm } : {}),
                ...((task.report ?? previousTask?.report)
                  ? { report: task.report ?? previousTask?.report }
                  : {})
              }
            }),
            messages: snapshot.recentMessages.map((msg) => ({
              id: msg.id,
              from: msg.from,
              to: msg.to,
              type: msg.type,
              content: msg.content,
              summary: msg.summary,
              timestamp: msg.timestamp
            }))
          }
        })
        if (!isAgentRuntimeSyncSuppressed()) {
          emitAgentRuntimeSync({ kind: 'team_snapshot', snapshot, sessionId })
        }
      },
      updateTeamMeta: (patch) => {
        set((state) => {
          if (!state.activeTeam) return
          Object.assign(state.activeTeam, patch)
          state.activeTeam.lastRuntimeSyncAt = Date.now()
        })
        if (!isAgentRuntimeSyncSuppressed()) {
          emitAgentRuntimeSync({ kind: 'team_meta', patch })
        }
      },
      clearSessionTeam: (sessionId) => {
        set((state) => {
          // Clear active team if it belongs to the session
          if (state.activeTeam?.sessionId === sessionId) {
            state.activeTeam = null
          }
          // Remove history entries belonging to the session
          state.teamHistory = state.teamHistory.filter((t) => t.sessionId !== sessionId)
        })
        if (!isAgentRuntimeSyncSuppressed()) {
          emitAgentRuntimeSync({ kind: 'clear_session_team', sessionId })
        }
      }
    })),
    {
      name: 'opencowork-team',
      storage: createJSONStorage(() => ipcStorage),
      partialize: (state) => ({
        activeTeam: state.activeTeam,
        teamHistory: state.teamHistory
      })
    }
  )
)
