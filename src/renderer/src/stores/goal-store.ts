import { create } from 'zustand'
import { ipcClient } from '../lib/ipc/ipc-client'

export type SessionGoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete'
export type SessionGoalEventType =
  | 'created'
  | 'replaced'
  | 'objective_updated'
  | 'budget_updated'
  | 'status_changed'
  | 'usage_accounted'
  | 'budget_limited'
  | 'completion_deferred'
  | 'completed'
  | 'stall_paused'
  | 'auto_continue_blocked'
  | 'cleared'

export interface SessionGoal {
  sessionId: string
  goalId: string
  objective: string
  status: SessionGoalStatus
  tokenBudget?: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export interface SessionGoalEvent {
  id: string
  sessionId: string
  goalId?: string | null
  eventType: SessionGoalEventType
  message?: string | null
  metadata?: Record<string, unknown> | null
  createdAt: number
}

export const EMPTY_SESSION_GOAL_EVENTS: SessionGoalEvent[] = []

interface SessionGoalRow {
  session_id: string
  goal_id: string
  objective: string
  status: SessionGoalStatus
  token_budget: number | null
  tokens_used: number
  time_used_seconds: number
  created_at: number
  updated_at: number
}

interface SessionGoalEventRow {
  id: string
  session_id: string
  goal_id: string | null
  event_type: SessionGoalEventType
  message: string | null
  metadata_json: string | null
  created_at: number
}

interface GoalMutationResult {
  success?: boolean
  error?: string
  goal?: SessionGoalRow | null
  cleared?: boolean
}

interface GoalEventMutationResult {
  success?: boolean
  error?: string
  event?: SessionGoalEventRow | null
}

interface AccountGoalUsageInput {
  sessionId: string
  timeDeltaSeconds: number
  tokenDelta: number
  expectedGoalId?: string | null
}

interface GoalStore {
  goalsBySession: Record<string, SessionGoal>
  goalEventsBySession: Record<string, SessionGoalEvent[]>
  _loaded: boolean

  loadGoalsFromDb: () => Promise<void>
  loadGoalForSession: (sessionId: string, force?: boolean) => Promise<SessionGoal | undefined>
  loadGoalEventsForSession: (
    sessionId: string,
    options?: { goalId?: string | null; limit?: number; force?: boolean }
  ) => Promise<SessionGoalEvent[]>
  getGoalBySession: (sessionId: string) => SessionGoal | undefined
  getGoalEventsBySession: (sessionId: string) => SessionGoalEvent[]
  createGoal: (args: {
    sessionId: string
    objective: string
    tokenBudget?: number | null
  }) => Promise<{ success: boolean; goal?: SessionGoal; error?: string }>
  setGoal: (args: {
    sessionId: string
    objective: string
    status?: SessionGoalStatus
    tokenBudget?: number | null
  }) => Promise<{ success: boolean; goal?: SessionGoal; error?: string }>
  updateGoal: (
    sessionId: string,
    patch: Partial<Pick<SessionGoal, 'objective' | 'status' | 'tokenBudget'>>
  ) => Promise<{ success: boolean; goal?: SessionGoal; error?: string }>
  clearGoal: (sessionId: string) => Promise<{ success: boolean; cleared: boolean; error?: string }>
  accountGoalUsage: (
    input: AccountGoalUsageInput
  ) => Promise<{ success: boolean; goal?: SessionGoal; error?: string }>
  addGoalEvent: (args: {
    sessionId: string
    goalId?: string | null
    eventType: SessionGoalEventType
    message?: string | null
    metadata?: Record<string, unknown> | null
  }) => Promise<{ success: boolean; event?: SessionGoalEvent; error?: string }>
  applySyncedGoal: (goal: SessionGoal) => void
  applySyncedGoalClear: (sessionId: string) => void
  applySyncedGoalEvent: (event: SessionGoalEvent) => void
}

function rowToGoal(row: SessionGoalRow): SessionGoal {
  return {
    sessionId: row.session_id,
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToEvent(row: SessionGoalEventRow): SessionGoalEvent {
  let metadata: Record<string, unknown> | null = null
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      metadata = null
    }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    goalId: row.goal_id,
    eventType: row.event_type,
    message: row.message,
    metadata,
    createdAt: row.created_at
  }
}

function isGoalRow(value: GoalMutationResult | SessionGoalRow): value is SessionGoalRow {
  return 'session_id' in value
}

function asGoal(
  result: GoalMutationResult | SessionGoalRow | null | undefined
): SessionGoal | null {
  if (!result) return null
  const row = isGoalRow(result) ? result : result.goal
  return row ? rowToGoal(row) : null
}

function mutationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let goalEventsIpcUnavailable = false
let goalEventsIpcUnavailableWarned = false

function markGoalEventsIpcUnavailable(error: unknown): boolean {
  const message = mutationError(error)
  if (!message.includes('No handler registered') || !message.includes('db:goal-events')) {
    return false
  }

  goalEventsIpcUnavailable = true
  if (!goalEventsIpcUnavailableWarned) {
    goalEventsIpcUnavailableWarned = true
    console.warn(
      '[GoalStore] Goal event IPC is unavailable. Restart Electron to enable goal event history.'
    )
  }
  return true
}

type GoalStoreSetter = (
  partial: Partial<GoalStore> | ((state: GoalStore) => Partial<GoalStore>)
) => void

function upsertGoal(setState: GoalStoreSetter, goal: SessionGoal): void {
  setState((state) => ({
    goalsBySession: {
      ...state.goalsBySession,
      [goal.sessionId]: goal
    }
  }))
}

function upsertGoalEvent(setState: GoalStoreSetter, event: SessionGoalEvent): void {
  setState((state) => {
    const existing = state.goalEventsBySession[event.sessionId] ?? []
    const next = [event, ...existing.filter((item) => item.id !== event.id)]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
    return {
      goalEventsBySession: {
        ...state.goalEventsBySession,
        [event.sessionId]: next
      }
    }
  })
}

export const useGoalStore = create<GoalStore>((set, get) => ({
  goalsBySession: {},
  goalEventsBySession: {},
  _loaded: false,

  loadGoalsFromDb: async () => {
    try {
      const rows = (await ipcClient.invoke('db:goals:list')) as SessionGoalRow[]
      const goalsBySession: Record<string, SessionGoal> = {}
      for (const row of rows) {
        const goal = rowToGoal(row)
        goalsBySession[goal.sessionId] = goal
      }
      set({ goalsBySession, _loaded: true })
    } catch (error) {
      console.error('[GoalStore] Failed to load goals:', error)
      set({ _loaded: true })
    }
  },

  loadGoalForSession: async (sessionId, force = false) => {
    const cached = get().goalsBySession[sessionId]
    if (cached && !force) return cached

    try {
      const row = (await ipcClient.invoke('db:goals:get', sessionId)) as SessionGoalRow | null
      const goal = row ? rowToGoal(row) : undefined
      set((state) => {
        const next = { ...state.goalsBySession }
        if (goal) {
          next[sessionId] = goal
        } else {
          delete next[sessionId]
        }
        return { goalsBySession: next }
      })
      return goal
    } catch (error) {
      console.error('[GoalStore] Failed to load goal:', error)
      return cached
    }
  },

  loadGoalEventsForSession: async (sessionId, options = {}) => {
    const cached = get().goalEventsBySession[sessionId]
    if (cached && !options.force) return cached
    if (goalEventsIpcUnavailable) return cached ?? EMPTY_SESSION_GOAL_EVENTS

    try {
      const rows = (await ipcClient.invoke('db:goal-events:list', {
        sessionId,
        goalId: options.goalId,
        limit: options.limit ?? 40
      })) as SessionGoalEventRow[]
      const events = rows.map(rowToEvent)
      set((state) => ({
        goalEventsBySession: {
          ...state.goalEventsBySession,
          [sessionId]: events
        }
      }))
      return events
    } catch (error) {
      if (markGoalEventsIpcUnavailable(error)) {
        return cached ?? EMPTY_SESSION_GOAL_EVENTS
      }
      console.error('[GoalStore] Failed to load goal events:', error)
      return cached ?? EMPTY_SESSION_GOAL_EVENTS
    }
  },

  getGoalBySession: (sessionId) => get().goalsBySession[sessionId],
  getGoalEventsBySession: (sessionId) =>
    get().goalEventsBySession[sessionId] ?? EMPTY_SESSION_GOAL_EVENTS,

  createGoal: async (args) => {
    try {
      const result = (await ipcClient.invoke('db:goals:create', args)) as GoalMutationResult
      if (result.error) return { success: false, error: result.error }
      const goal = asGoal(result)
      if (!goal) return { success: false, error: 'Goal was not created' }
      upsertGoal(set, goal)
      void get().loadGoalEventsForSession(goal.sessionId, { goalId: goal.goalId, force: true })
      return { success: true, goal }
    } catch (error) {
      return { success: false, error: mutationError(error) }
    }
  },

  setGoal: async (args) => {
    try {
      const result = (await ipcClient.invoke('db:goals:set', args)) as GoalMutationResult
      if (result.error) return { success: false, error: result.error }
      const goal = asGoal(result)
      if (!goal) return { success: false, error: 'Goal was not set' }
      upsertGoal(set, goal)
      void get().loadGoalEventsForSession(goal.sessionId, { goalId: goal.goalId, force: true })
      return { success: true, goal }
    } catch (error) {
      return { success: false, error: mutationError(error) }
    }
  },

  updateGoal: async (sessionId, patch) => {
    try {
      const result = (await ipcClient.invoke('db:goals:update', {
        sessionId,
        patch
      })) as GoalMutationResult
      if (result.error) return { success: false, error: result.error }
      const goal = asGoal(result)
      if (!goal) return { success: false, error: 'Goal was not updated' }
      upsertGoal(set, goal)
      void get().loadGoalEventsForSession(goal.sessionId, { goalId: goal.goalId, force: true })
      return { success: true, goal }
    } catch (error) {
      return { success: false, error: mutationError(error) }
    }
  },

  clearGoal: async (sessionId) => {
    try {
      const result = (await ipcClient.invoke('db:goals:clear', sessionId)) as GoalMutationResult
      if (result.error) return { success: false, cleared: false, error: result.error }
      set((state) => {
        const next = { ...state.goalsBySession }
        delete next[sessionId]
        return { goalsBySession: next }
      })
      void get().loadGoalEventsForSession(sessionId, { force: true })
      return { success: true, cleared: result.cleared === true }
    } catch (error) {
      return { success: false, cleared: false, error: mutationError(error) }
    }
  },

  accountGoalUsage: async (input) => {
    try {
      const result = (await ipcClient.invoke('db:goals:account', input)) as GoalMutationResult
      if (result.error) return { success: false, error: result.error }
      const goal = asGoal(result)
      if (goal) upsertGoal(set, goal)
      if (goal) {
        void get().loadGoalEventsForSession(goal.sessionId, { goalId: goal.goalId, force: true })
      }
      return { success: true, ...(goal ? { goal } : {}) }
    } catch (error) {
      return { success: false, error: mutationError(error) }
    }
  },

  addGoalEvent: async (args) => {
    if (goalEventsIpcUnavailable) {
      return { success: false, error: 'Goal event IPC is unavailable until Electron restarts' }
    }

    try {
      const result = (await ipcClient.invoke('db:goal-events:add', args)) as GoalEventMutationResult
      if (result.error) return { success: false, error: result.error }
      if (!result.event) return { success: false, error: 'Goal event was not recorded' }
      const event = rowToEvent(result.event)
      upsertGoalEvent(set, event)
      return { success: true, event }
    } catch (error) {
      if (markGoalEventsIpcUnavailable(error)) {
        return { success: false, error: 'Goal event IPC is unavailable until Electron restarts' }
      }
      return { success: false, error: mutationError(error) }
    }
  },

  applySyncedGoal: (goal) => {
    upsertGoal(set, goal)
    void get().loadGoalEventsForSession(goal.sessionId, { goalId: goal.goalId, force: true })
  },

  applySyncedGoalClear: (sessionId) => {
    set((state) => {
      const next = { ...state.goalsBySession }
      delete next[sessionId]
      return { goalsBySession: next }
    })
    void get().loadGoalEventsForSession(sessionId, { force: true })
  },

  applySyncedGoalEvent: (event) => {
    upsertGoalEvent(set, event)
  }
}))

export function installGoalSyncListener(): () => void {
  const offUpdated = ipcClient.on('goal:updated', (payload: unknown) => {
    const row =
      payload && typeof payload === 'object' ? (payload as { goal?: SessionGoalRow }).goal : null
    if (!row) return
    useGoalStore.getState().applySyncedGoal(rowToGoal(row))
  })

  const offCleared = ipcClient.on('goal:cleared', (payload: unknown) => {
    const sessionId =
      payload && typeof payload === 'object'
        ? (payload as { sessionId?: unknown }).sessionId
        : undefined
    if (typeof sessionId === 'string') {
      useGoalStore.getState().applySyncedGoalClear(sessionId)
    }
  })

  const offEventAdded = ipcClient.on('goal:event-added', (payload: unknown) => {
    const row =
      payload && typeof payload === 'object'
        ? (payload as { event?: SessionGoalEventRow }).event
        : null
    if (!row) return
    useGoalStore.getState().applySyncedGoalEvent(rowToEvent(row))
  })

  return () => {
    offUpdated()
    offCleared()
    offEventAdded()
  }
}
