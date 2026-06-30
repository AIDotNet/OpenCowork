import { useAgentStore } from '@renderer/stores/agent-store'
import { useTeamStore } from '@renderer/stores/team-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { removeTeamLimiter } from '../sub-agents/create-tool'
import { abortAllTeammates } from './team-native-control'
import type { TeamRuntimeSnapshot } from '../../../../../shared/team-runtime-types'

type NativeTeamUiUpdateResult = {
  ok: boolean
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isTeamRuntimeSnapshot(value: unknown): value is TeamRuntimeSnapshot {
  return (
    isRecord(value) &&
    isRecord(value.team) &&
    typeof value.team.name === 'string' &&
    Array.isArray(value.recentMessages)
  )
}

export async function handleNativeTeamUiUpdate(params: unknown): Promise<NativeTeamUiUpdateResult> {
  const record = isRecord(params) ? params : {}
  const action = typeof record.action === 'string' ? record.action : ''
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined

  if (action === 'snapshot') {
    if (!isTeamRuntimeSnapshot(record.snapshot)) {
      return { ok: false, error: 'Invalid native team snapshot payload.' }
    }
    useTeamStore.getState().syncRuntimeSnapshot(record.snapshot, sessionId)
    if (record.openPanel === true) {
      const ui = useUIStore.getState()
      ui.setRightPanelOpen(true)
      ui.setRightPanelTab('team')
    }
    return { ok: true }
  }

  if (action === 'end') {
    const team = useTeamStore.getState().activeTeam
    if (team?.name) {
      abortAllTeammates()
      useAgentStore.getState().clearPendingApprovals()
      removeTeamLimiter(team.name)
    }
    useTeamStore
      .getState()
      .handleTeamEvent({ type: 'team_end', sessionId: sessionId ?? team?.sessionId })
    return { ok: true }
  }

  return { ok: false, error: `Unsupported native team UI action: ${action}` }
}
