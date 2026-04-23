import { nanoid } from 'nanoid'
import type {
  TeamRuntimePlanApprovalRequestPayload,
  TeamRuntimePlanApprovalResponsePayload
} from '../../../../../shared/team-runtime-types'
import { appendTeamRuntimeMessage, consumeTeamRuntimeMessages } from './runtime-client'
import { useTeamStore } from '../../../stores/team-store'

const pendingPlanResolvers = new Map<
  string,
  (result: { approved: boolean; feedback?: string }) => void
>()
const workerPlanCursors = new Map<string, number>()
const workerPlanPollers = new Map<string, ReturnType<typeof setInterval>>()
const seenPlanMessageIds = new Set<string>()

function buildRequestId(memberName: string, taskId?: string | null): string {
  return `plan-${memberName}-${taskId ?? 'none'}-${nanoid(6)}`
}

function parsePlanApprovalResponse(content: string): TeamRuntimePlanApprovalResponsePayload | null {
  try {
    const parsed = JSON.parse(content) as TeamRuntimePlanApprovalResponsePayload
    if (!parsed || typeof parsed.requestId !== 'string' || typeof parsed.approved !== 'boolean') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function startWorkerPlanApprovalPoller(memberName: string): void {
  if (workerPlanPollers.has(memberName)) return

  const timer = setInterval(() => {
    const team = useTeamStore.getState().activeTeam
    if (!team?.name) return

    const afterTimestamp = workerPlanCursors.get(memberName) ?? 0

    void consumeTeamRuntimeMessages({
      teamName: team.name,
      afterTimestamp,
      recipient: memberName,
      includeBroadcast: true,
      limit: 20
    })
      .then((messages) => {
        for (const message of messages) {
          if (seenPlanMessageIds.has(message.id)) continue
          seenPlanMessageIds.add(message.id)
          workerPlanCursors.set(
            memberName,
            Math.max(workerPlanCursors.get(memberName) ?? 0, message.timestamp)
          )

          if (message.type !== 'plan_approval_response') continue
          const payload = parsePlanApprovalResponse(message.content)
          if (!payload) continue

          const resolver = pendingPlanResolvers.get(payload.requestId)
          if (!resolver) continue
          pendingPlanResolvers.delete(payload.requestId)
          resolver({ approved: payload.approved, feedback: payload.feedback })
        }
      })
      .catch((error) => {
        console.error('[TeamRuntime] Worker plan approval poll failed:', error)
      })
  }, 1000)

  workerPlanPollers.set(memberName, timer)
}

export function stopWorkerPlanApprovalPoller(memberName: string): void {
  const timer = workerPlanPollers.get(memberName)
  if (timer) {
    clearInterval(timer)
    workerPlanPollers.delete(memberName)
  }
  workerPlanCursors.delete(memberName)
}

export async function requestPlanApproval(params: {
  memberName: string
  plan: string
  taskId?: string | null
}): Promise<{ approved: boolean; feedback?: string }> {
  const team = useTeamStore.getState().activeTeam
  if (!team) return { approved: false, feedback: 'No active team' }

  startWorkerPlanApprovalPoller(params.memberName)

  const requestId = buildRequestId(params.memberName, params.taskId)
  const payload: TeamRuntimePlanApprovalRequestPayload = {
    requestId,
    plan: params.plan,
    taskId: params.taskId ?? null
  }

  await appendTeamRuntimeMessage({
    teamName: team.name,
    message: {
      id: requestId,
      from: params.memberName,
      to: 'lead',
      type: 'plan_approval_request',
      content: JSON.stringify(payload),
      summary: `${params.memberName} requests plan approval`,
      timestamp: Date.now()
    }
  })

  return new Promise((resolve) => {
    pendingPlanResolvers.set(requestId, resolve)
  })
}

export async function sendPlanApprovalResponse(params: {
  requestId: string
  approved: boolean
  to: string
  feedback?: string
}): Promise<void> {
  const team = useTeamStore.getState().activeTeam
  if (!team) return

  const payload: TeamRuntimePlanApprovalResponsePayload = {
    requestId: params.requestId,
    approved: params.approved,
    ...(params.feedback ? { feedback: params.feedback } : {})
  }

  await appendTeamRuntimeMessage({
    teamName: team.name,
    message: {
      id: `plan-res-${params.requestId}-${Date.now()}`,
      from: 'lead',
      to: params.to,
      type: 'plan_approval_response',
      content: JSON.stringify(payload),
      summary: params.approved ? 'Leader approved plan' : 'Leader rejected plan',
      timestamp: Date.now()
    }
  })
}
