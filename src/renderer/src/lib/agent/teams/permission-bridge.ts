import { nanoid } from 'nanoid'
import type { ToolCallState } from '../types'
import { appendTeamRuntimeMessage, consumeTeamRuntimeMessages } from './runtime-client'
import { useTeamStore } from '../../../stores/team-store'

const pendingPermissionResolvers = new Map<string, (approved: boolean) => void>()
const pendingPermissionTargets = new Map<string, string>()
const workerMessageCursor = new Map<string, number>()
const workerPollers = new Map<string, ReturnType<typeof setInterval>>()
const seenWorkerMessageIds = new Set<string>()

function buildRequestId(memberName: string, toolCallId: string): string {
  return `perm-${memberName}-${toolCallId}-${nanoid(6)}`
}

function parsePermissionResponse(content: string): { approved: boolean; requestId: string } | null {
  try {
    const parsed = JSON.parse(content) as { approved?: boolean; requestId?: string }
    if (typeof parsed.approved !== 'boolean' || typeof parsed.requestId !== 'string') return null
    return { approved: parsed.approved, requestId: parsed.requestId }
  } catch {
    return null
  }
}

export function startWorkerPermissionPoller(memberName: string): void {
  if (workerPollers.has(memberName)) return

  const timer = setInterval(() => {
    const team = useTeamStore.getState().activeTeam
    if (!team?.name) return

    const afterTimestamp = workerMessageCursor.get(memberName) ?? 0

    void consumeTeamRuntimeMessages({
      teamName: team.name,
      afterTimestamp,
      recipient: memberName,
      includeBroadcast: true,
      limit: 20
    })
      .then((messages) => {
        for (const message of messages) {
          if (seenWorkerMessageIds.has(message.id)) continue
          seenWorkerMessageIds.add(message.id)
          workerMessageCursor.set(
            memberName,
            Math.max(workerMessageCursor.get(memberName) ?? 0, message.timestamp)
          )

          if (message.type !== 'permission_response') continue
          const payload = parsePermissionResponse(message.content)
          if (!payload) continue

          const resolver = pendingPermissionResolvers.get(payload.requestId)
          if (!resolver) continue
          pendingPermissionResolvers.delete(payload.requestId)
          pendingPermissionTargets.delete(payload.requestId)
          resolver(payload.approved)
        }
      })
      .catch((error) => {
        console.error('[TeamRuntime] Worker permission poll failed:', error)
      })
  }, 1000)

  workerPollers.set(memberName, timer)
}

export function stopWorkerPermissionPoller(memberName: string): void {
  const timer = workerPollers.get(memberName)
  if (timer) {
    clearInterval(timer)
    workerPollers.delete(memberName)
  }
  workerMessageCursor.delete(memberName)
}

export async function requestTeammatePermission(params: {
  memberName: string
  toolCall: ToolCallState
}): Promise<boolean> {
  const team = useTeamStore.getState().activeTeam
  if (!team) return false

  startWorkerPermissionPoller(params.memberName)

  const requestId = buildRequestId(params.memberName, params.toolCall.id)

  await appendTeamRuntimeMessage({
    teamName: team.name,
    message: {
      id: requestId,
      from: params.memberName,
      to: 'lead',
      type: 'permission_request',
      content: JSON.stringify(params.toolCall),
      summary: `${params.memberName} requests ${params.toolCall.name}`,
      timestamp: Date.now()
    }
  })

  return new Promise<boolean>((resolve) => {
    pendingPermissionResolvers.set(requestId, resolve)
    pendingPermissionTargets.set(requestId, params.memberName)
  })
}
