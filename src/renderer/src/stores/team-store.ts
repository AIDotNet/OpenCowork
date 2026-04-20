import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { TeamMember, TeamTask, TeamMessage, TeamEvent } from '../lib/agent/teams/types'
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
        set((state) => {
          switch (event.type) {
            case 'team_start':
              state.activeTeam = {
                name: event.teamName,
                description: event.description,
                sessionId,
                runtimePath: event.runtimePath,
                leadAgentId: event.leadAgentId,
                defaultBackend: event.defaultBackend,
                permissionMode: event.permissionMode,
                teamAllowedPaths: event.teamAllowedPaths ?? [],
                members: [],
                tasks: [],
                messages: [],
                createdAt: event.createdAt ?? Date.now(),
                lastRuntimeSyncAt: Date.now()
              }
              break
            case 'team_member_add':
              if (state.activeTeam) {
                // Guard: skip if a member with the same id or name already exists
                const dup = state.activeTeam.members.some(
                  (m) => m.id === event.member.id || m.name === event.member.name
                )
                if (!dup) state.activeTeam.members.push(event.member)
              }
              break
            case 'team_member_update': {
              if (!state.activeTeam) break
              const member = state.activeTeam.members.find((m) => m.id === event.memberId)
              if (member) Object.assign(member, event.patch)
              break
            }
            case 'team_member_remove': {
              if (!state.activeTeam) break
              const idx = state.activeTeam.members.findIndex((m) => m.id === event.memberId)
              if (idx !== -1) state.activeTeam.members.splice(idx, 1)
              break
            }
            case 'team_task_add':
              if (state.activeTeam) {
                // Guard: skip if a task with the same id already exists
                const dupTask = state.activeTeam.tasks.some((t) => t.id === event.task.id)
                if (!dupTask) state.activeTeam.tasks.push(event.task)
              }
              break
            case 'team_task_update': {
              if (!state.activeTeam) break
              const task = state.activeTeam.tasks.find((t) => t.id === event.taskId)
              if (task) {
                // Guard: never roll back a completed task to a non-completed status
                if (
                  task.status === 'completed' &&
                  event.patch.status &&
                  event.patch.status !== 'completed'
                ) {
                  break
                }
                Object.assign(task, event.patch)
              }
              break
            }
            case 'team_message':
              if (state.activeTeam) state.activeTeam.messages.push(event.message)
              break
            case 'team_end':
              if (state.activeTeam) {
                state.teamHistory.push({ ...state.activeTeam })
              }
              state.activeTeam = null
              break
          }
        })
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
      },
      updateTeamMeta: (patch) => {
        set((state) => {
          if (!state.activeTeam) return
          Object.assign(state.activeTeam, patch)
          state.activeTeam.lastRuntimeSyncAt = Date.now()
        })
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
