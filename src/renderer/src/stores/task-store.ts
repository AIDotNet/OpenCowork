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

interface TaskStore {
  tasks: TaskItem[]
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
  currentSessionId: null,

  loadTasksForSession: async (sessionId) => {
    try {
      const rows = (await ipcClient.invoke('db:tasks:list-by-session', sessionId)) as TaskRow[]
      const tasks = rows.map(rowToTask)
      set({ tasks, todos: tasks, currentSessionId: sessionId })
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
      sortOrder = state.tasks.length
      const updated = [...state.tasks, newTask]
      return { tasks: updated, todos: updated }
    })
    dbCreateTask(newTask, sortOrder)
    return newTask
  },

  getTask: (id) => get().tasks.find((t) => t.id === id),

  updateTask: (id, patch) => {
    const state = get()
    const idx = state.tasks.findIndex((t) => t.id === id)
    if (idx === -1) return undefined
    const now = Date.now()
    const updated = { ...state.tasks[idx], ...patch, updatedAt: now }
    const tasks = [...state.tasks]
    tasks[idx] = updated
    set({ tasks, todos: tasks })
    // Persist to DB
    const dbPatch: Record<string, unknown> = { updatedAt: now }
    if (patch.subject !== undefined) dbPatch.subject = patch.subject
    if (patch.description !== undefined) dbPatch.description = patch.description
    if (patch.activeForm !== undefined) dbPatch.activeForm = patch.activeForm
    if (patch.status !== undefined) dbPatch.status = patch.status
    if (patch.owner !== undefined) dbPatch.owner = patch.owner
    if (patch.blocks !== undefined) dbPatch.blocks = patch.blocks
    if (patch.blockedBy !== undefined) dbPatch.blockedBy = patch.blockedBy
    if (patch.metadata !== undefined) dbPatch.metadata = patch.metadata
    dbUpdateTask(id, dbPatch)

    return updated
  },

  deleteTask: (id) => {
    const state = get()
    const before = state.tasks.length
    const tasks = state.tasks.filter((t) => t.id !== id)
    if (tasks.length === before) return false
    // Also remove this ID from blocks/blockedBy of other tasks
    const cleaned = tasks.map((t) => ({
      ...t,
      blocks: t.blocks.filter((b) => b !== id),
      blockedBy: t.blockedBy.filter((b) => b !== id),
    }))
    set({ tasks: cleaned, todos: cleaned })
    dbDeleteTask(id)
    return true
  },

  getTasks: () => get().tasks,

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
      const remaining = state.tasks.filter((task) => task.sessionId !== sessionId)
      if (remaining.length === state.tasks.length) return {}
      return {
        tasks: remaining,
        todos: remaining,
        currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
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
    set({ tasks, todos: tasks })
  },

  getTodos: () => get().tasks,

  getActiveTodo: () => get().tasks.find((t) => t.status === 'in_progress'),
}))
