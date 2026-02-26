import { create } from 'zustand'
import { ipcClient } from '../lib/ipc/ipc-client'

export interface TaskItem {
  id: string
  sessionId?: string
  planId?: string
  subject: string
  description: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string | null
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** @deprecated Use TaskItem instead */
export type TodoItem = TaskItem

// --- DB persistence helpers (fire-and-forget) ---

function dbCreateTask(task: TaskItem, sortOrder: number): void {
  if (!task.sessionId) return
  ipcClient.invoke('db:tasks:create', {
    id: task.id,
    sessionId: task.sessionId,
    planId: task.planId,
    subject: task.subject,
    description: task.description,
    activeForm: task.activeForm,
    status: task.status,
    owner: task.owner,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    metadata: task.metadata,
    sortOrder,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }).catch(() => {})
}

function dbUpdateTask(id: string, patch: Record<string, unknown>): void {
  ipcClient.invoke('db:tasks:update', { id, patch }).catch(() => {})
}

function dbDeleteTask(id: string): void {
  ipcClient.invoke('db:tasks:delete', id).catch(() => {})
}

function dbDeleteTasksBySession(sessionId: string): void {
  ipcClient.invoke('db:tasks:delete-by-session', sessionId).catch(() => {})
}

interface TaskRow {
  id: string
  session_id: string
  plan_id: string | null
  subject: string
  description: string
  active_form: string | null
  status: string
  owner: string | null
  blocks: string
  blocked_by: string
  metadata: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

function rowToTask(row: TaskRow): TaskItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    planId: row.plan_id ?? undefined,
    subject: row.subject,
    description: row.description,
    activeForm: row.active_form ?? undefined,
    status: row.status as TaskItem['status'],
    owner: row.owner,
    blocks: JSON.parse(row.blocks || '[]'),
    blockedBy: JSON.parse(row.blocked_by || '[]'),
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function buildDbPatch(
  patch: Partial<Omit<TaskItem, 'id' | 'createdAt'>>,
  now: number
): Record<string, unknown> {
  const dbPatch: Record<string, unknown> = { updatedAt: now }
  if (patch.subject !== undefined) dbPatch.subject = patch.subject
  if (patch.description !== undefined) dbPatch.description = patch.description
  if (patch.activeForm !== undefined) dbPatch.activeForm = patch.activeForm
  if (patch.status !== undefined) dbPatch.status = patch.status
  if (patch.owner !== undefined) dbPatch.owner = patch.owner
  if (patch.blocks !== undefined) dbPatch.blocks = patch.blocks
  if (patch.blockedBy !== undefined) dbPatch.blockedBy = patch.blockedBy
  if (patch.metadata !== undefined) dbPatch.metadata = patch.metadata
  return dbPatch
}

interface TaskStore {
  tasks: TaskItem[]
  /** Session-scoped cache for background/concurrent session updates */
  tasksBySession: Record<string, TaskItem[]>
  /** The session ID tasks are currently loaded for */
  currentSessionId: string | null

  /** Load tasks for a session from DB */
  loadTasksForSession: (sessionId: string) => Promise<void>
  /** Add a single task (returns the added task) */
  addTask: (task: TaskItem) => TaskItem
  /** Get a task by ID */
  getTask: (id: string) => TaskItem | undefined
  /** Update a task by ID (partial patch). Returns updated task or undefined if not found. */
  updateTask: (id: string, patch: Partial<Omit<TaskItem, 'id' | 'createdAt'>>) => TaskItem | undefined
  /** Delete a task by ID */
  deleteTask: (id: string) => boolean
  /** Get all tasks */
  getTasks: () => TaskItem[]
  /** Get tasks for a specific session */
  getTasksBySession: (sessionId: string) => TaskItem[]
  /** Get the currently in_progress task */
  getActiveTask: () => TaskItem | undefined
  /** Get progress stats */
  getProgress: () => { total: number; completed: number; percentage: number }
  /** Clear all tasks in memory (does not touch DB) */
  clearTasks: () => void
  /** Delete all tasks for a session from DB and memory */
  deleteSessionTasks: (sessionId: string) => void

  // --- Backward-compatible aliases ---
  /** @deprecated Use tasks */
  todos: TaskItem[]
  /** @deprecated Use addTask / getTasks */
  setTodos: (todos: TaskItem[]) => void
  /** @deprecated Use getTasks */
  getTodos: () => TaskItem[]
  /** @deprecated Use getActiveTask */
  getActiveTodo: () => TaskItem | undefined
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  tasksBySession: {},
  currentSessionId: null,

  loadTasksForSession: async (sessionId) => {
    // Show cached tasks immediately to avoid stale UI while DB is loading.
    set((state) => {
      const cached = state.tasksBySession[sessionId] ?? []
      return { currentSessionId: sessionId, tasks: cached, todos: cached }
    })

    try {
      const rows = (await ipcClient.invoke('db:tasks:list-by-session', sessionId)) as TaskRow[]
      const tasks = rows.map(rowToTask)
      set((state) => {
        const nextTasksBySession = { ...state.tasksBySession, [sessionId]: tasks }
        // If user switched again before this async request resolved,
        // only refresh the cache and keep current visible list intact.
        if (state.currentSessionId !== sessionId) {
          return { tasksBySession: nextTasksBySession }
        }
        return { tasks, todos: tasks, tasksBySession: nextTasksBySession }
      })
    } catch (err) {
      console.error('[TaskStore] Failed to load tasks for session:', err)
    }
  },

  addTask: (task) => {
    const now = Date.now()
    const newTask: TaskItem = {
      ...task,
      blocks: task.blocks ?? [],
      blockedBy: task.blockedBy ?? [],
      createdAt: task.createdAt ?? now,
      updatedAt: now,
    }
    let sortOrder = 0
    set((state) => {
      const sessionId = newTask.sessionId
      if (!sessionId) {
        sortOrder = state.tasks.length
        const updated = [...state.tasks, newTask]
        return { tasks: updated, todos: updated }
      }

      const sessionTasks = state.tasksBySession[sessionId] ?? (state.currentSessionId === sessionId ? state.tasks : [])
      sortOrder = sessionTasks.length
      const nextSessionTasks = [...sessionTasks, newTask]
      const nextTasksBySession = { ...state.tasksBySession, [sessionId]: nextSessionTasks }

      if (state.currentSessionId === sessionId || (!state.currentSessionId && state.tasks.length === 0)) {
        return {
          currentSessionId: state.currentSessionId ?? sessionId,
          tasks: nextSessionTasks,
          todos: nextSessionTasks,
          tasksBySession: nextTasksBySession,
        }
      }
      return { tasksBySession: nextTasksBySession }
    })
    dbCreateTask(newTask, sortOrder)
    return newTask
  },

  getTask: (id) => {
    const state = get()
    const current = state.tasks.find((t) => t.id === id)
    if (current) return current

    for (const sessionTasks of Object.values(state.tasksBySession)) {
      const found = sessionTasks.find((t) => t.id === id)
      if (found) return found
    }

    return undefined
  },

  updateTask: (id, patch) => {
    const now = Date.now()
    let updatedTask: TaskItem | undefined

    set((state) => {
      const nextTasksBySession = { ...state.tasksBySession }

      const sessionEntries = Object.entries(state.tasksBySession)
      if (state.currentSessionId && !state.tasksBySession[state.currentSessionId]) {
        sessionEntries.push([state.currentSessionId, state.tasks])
      }

      for (const [sessionId, sessionTasks] of sessionEntries) {
        const idx = sessionTasks.findIndex((t) => t.id === id)
        if (idx === -1) continue

        const updated = { ...sessionTasks[idx], ...patch, updatedAt: now }
        const nextSessionTasks = [...sessionTasks]
        nextSessionTasks[idx] = updated
        nextTasksBySession[sessionId] = nextSessionTasks
        updatedTask = updated

        if (state.currentSessionId === sessionId) {
          return { tasks: nextSessionTasks, todos: nextSessionTasks, tasksBySession: nextTasksBySession }
        }
        return { tasksBySession: nextTasksBySession }
      }

      return {}
    })

    // Persist even when task is currently off-screen (another active session).
    if (updatedTask) {
      dbUpdateTask(id, buildDbPatch(patch, now))
    }
    return updatedTask
  },

  deleteTask: (id) => {
    let deleted = false

    set((state) => {
      const nextTasksBySession = { ...state.tasksBySession }
      const sessionEntries = Object.entries(state.tasksBySession)
      if (state.currentSessionId && !state.tasksBySession[state.currentSessionId]) {
        sessionEntries.push([state.currentSessionId, state.tasks])
      }

      for (const [sessionId, sessionTasks] of sessionEntries) {
        const hasTarget = sessionTasks.some((t) => t.id === id)
        if (!hasTarget) continue

        const cleaned = sessionTasks
          .filter((t) => t.id !== id)
          .map((t) => ({
            ...t,
            blocks: t.blocks.filter((b) => b !== id),
            blockedBy: t.blockedBy.filter((b) => b !== id),
          }))
        nextTasksBySession[sessionId] = cleaned
        deleted = true

        if (state.currentSessionId === sessionId) {
          return { tasks: cleaned, todos: cleaned, tasksBySession: nextTasksBySession }
        }
        return { tasksBySession: nextTasksBySession }
      }

      return {}
    })

    if (!deleted) return false
    dbDeleteTask(id)
    return true
  },

  getTasks: () => get().tasks,

  getTasksBySession: (sessionId) => {
    const state = get()
    if (state.currentSessionId === sessionId) return state.tasks
    return state.tasksBySession[sessionId] ?? []
  },

  getActiveTask: () => get().tasks.find((t) => t.status === 'in_progress'),

  getProgress: () => {
    const { tasks } = get()
    const total = tasks.length
    const completed = tasks.filter((t) => t.status === 'completed').length
    return {
      total,
      completed,
      percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
    }
  },

  clearTasks: () => set({ tasks: [], todos: [], currentSessionId: null }),

  deleteSessionTasks: (sessionId) => {
    set((state) => {
      const nextTasksBySession = { ...state.tasksBySession }
      delete nextTasksBySession[sessionId]

      if (state.currentSessionId !== sessionId) {
        return { tasksBySession: nextTasksBySession }
      }

      return {
        tasks: [],
        todos: [],
        currentSessionId: null,
        tasksBySession: nextTasksBySession,
      }
    })
    dbDeleteTasksBySession(sessionId)
  },

  // --- Backward-compatible aliases ---
  todos: [],

  setTodos: (todos) => {
    const now = Date.now()
    const tasks = todos.map((t) => ({
      ...t,
      blocks: t.blocks ?? [],
      blockedBy: t.blockedBy ?? [],
      createdAt: t.createdAt ?? now,
      updatedAt: now,
    }))
    set((state) => {
      if (!state.currentSessionId) return { tasks, todos: tasks }
      return {
        tasks,
        todos: tasks,
        tasksBySession: {
          ...state.tasksBySession,
          [state.currentSessionId]: tasks,
        },
      }
    })
  },

  getTodos: () => get().tasks,

  getActiveTodo: () => get().tasks.find((t) => t.status === 'in_progress'),
}))
