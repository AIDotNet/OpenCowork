import * as goalsDao from '../db/goals-dao'
import { safeSendMessagePackToAllWindows } from '../window-ipc'

export const GOAL_UPDATED_CHANNEL = 'goal:updated'
export const GOAL_CLEARED_CHANNEL = 'goal:cleared'
export const GOAL_EVENT_ADDED_CHANNEL = 'goal:event-added'
export const GOAL_RUN_STATE_CHANNEL = 'goal:run-state'
export const GOAL_CONTINUE_REQUESTED_CHANNEL = 'goal:continue-requested'

function emitGoalEvent(channel: string, payload: unknown): void {
  safeSendMessagePackToAllWindows(channel, payload)
}

export function emitGoalUpdated(goal: goalsDao.SessionGoalRow, reason: string): void {
  emitGoalEvent(GOAL_UPDATED_CHANNEL, { reason, goal })
}

export function emitGoalCleared(sessionId: string, reason: string): void {
  emitGoalEvent(GOAL_CLEARED_CHANNEL, { reason, sessionId })
}

export function emitGoalEventAdded(event: goalsDao.SessionGoalEventRow, reason: string): void {
  emitGoalEvent(GOAL_EVENT_ADDED_CHANNEL, { reason, event })
}

export function emitGoalRunState(args: {
  sessionId: string
  active: boolean
  goalId?: string | null
  startedAt?: number
  reason: string
}): void {
  emitGoalEvent(GOAL_RUN_STATE_CHANNEL, args)
}

export function emitGoalContinueRequested(args: {
  sessionId: string
  goalId?: string | null
  reason: string
}): void {
  emitGoalEvent(GOAL_CONTINUE_REQUESTED_CHANNEL, args)
}
