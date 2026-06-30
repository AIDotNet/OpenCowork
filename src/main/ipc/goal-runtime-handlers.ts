import { getGoalRuntimeService } from '../goals/goal-runtime'
import { registerMessagePackHandler } from './messagepack-handler'

export function registerGoalRuntimeHandlers(): void {
  registerMessagePackHandler<{ sessionId?: string; goalId?: string | null }>(
    'goal-runtime:can-mark-blocked',
    (args) => {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
      if (!sessionId) return { canMarkBlocked: false }
      const goalId = typeof args?.goalId === 'string' ? args.goalId.trim() : null
      return {
        canMarkBlocked: getGoalRuntimeService().canMarkGoalBlocked(sessionId, goalId)
      }
    }
  )
}
