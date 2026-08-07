import { create } from 'zustand'
import { emitAgentRuntimeSync } from '../lib/agent-runtime-sync'
import { invokeMessagePackBinary } from '../lib/ipc/messagepack-ipc-client'
import {
  DB_TASKS_LIST_ALL_MSGPACK_CHANNEL,
  DB_TASKS_UPDATE_MSGPACK_CHANNEL
} from '../../../shared/messagepack/binary-ipc'
import {
  readTaskBoardMeta,
  useTaskStore,
  type TaskItem,
  type TaskPriority,
  type TaskStatus
} from './task-store'

export type TaskBoardView = 'dashboard' | 'kanban' | 'list' | 'gantt'

/** Statuses rendered as kanban columns, in display order. */
export const BOARD_COLUMN_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'in_review'
]

export interface TaskBoardItem {
  id: string
  sessionId: string
  planId?: string
  subject: string
  description: string
  activeForm?: string
  status: TaskStatus
  owner?: string | null
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  sortOrder: number
  createdAt: number
  updatedAt: number
  priority?: TaskPriority
  tags: string[]
  dueAt?: number
  sessionTitle: string | null
  sessionMode: string | null
  sessionWorkingFolder: string | null
}

interface TaskBoardRowPayload {
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
  session_title: string | null
  session_mode: string | null
  session_working_folder: string | null
}

const KNOWN_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'in_review',
  'completed'
]

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rowToBoardItem(row: TaskBoardRowPayload): TaskBoardItem {
  let metadata: Record<string, unknown> | undefined
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata)
    } catch {
      metadata = undefined
    }
  }
  const meta = readTaskBoardMeta(metadata)
  const status = KNOWN_STATUSES.find((s) => s === row.status) ?? 'pending'
  return {
    id: row.id,
    sessionId: row.session_id,
    planId: row.plan_id ?? undefined,
    subject: row.subject,
    description: row.description,
    activeForm: row.active_form ?? undefined,
    status,
    owner: row.owner,
    blocks: parseJsonArray(row.blocks),
    blockedBy: parseJsonArray(row.blocked_by),
    metadata,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    priority: meta.priority,
    tags: meta.tags,
    dueAt: meta.dueAt,
    sessionTitle: row.session_title,
    sessionMode: row.session_mode,
    sessionWorkingFolder: row.session_working_folder
  }
}

export interface TaskBoardFilters {
  keyword: string
  sessionId: string | null
  priority: TaskPriority | null
}

export interface TaskBoardSessionOption {
  id: string
  title: string
  taskCount: number
}

interface TaskBoardStore {
  items: TaskBoardItem[]
  loading: boolean
  loaded: boolean
  view: TaskBoardView
  filters: TaskBoardFilters
  selectedTaskId: string | null

  refresh: () => Promise<void>
  setView: (view: TaskBoardView) => void
  setKeyword: (keyword: string) => void
  setSessionFilter: (sessionId: string | null) => void
  setPriorityFilter: (priority: TaskPriority | null) => void
  selectTask: (id: string | null) => void
  /** Patch board-editable fields; persists via task-store when cached, else direct DB. */
  updateBoardTask: (
    id: string,
    patch: Partial<{
      subject: string
      description: string
      status: TaskStatus
      priority: TaskPriority | null
      tags: string[]
      dueAt: number | null
      sortOrder: number
    }>
  ) => void
  /** Drag-and-drop move: status change and/or reorder. */
  moveTask: (id: string, status: TaskStatus, sortOrder: number) => void
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null

export const useTaskBoardStore = create<TaskBoardStore>((set, get) => ({
  items: [],
  loading: false,
  loaded: false,
  view: 'kanban',
  filters: { keyword: '', sessionId: null, priority: null },
  selectedTaskId: null,

  refresh: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const rows = await invokeMessagePackBinary<TaskBoardRowPayload[]>(
        DB_TASKS_LIST_ALL_MSGPACK_CHANNEL,
        {}
      )
      set({ items: rows.map(rowToBoardItem), loading: false, loaded: true })
    } catch (err) {
      console.error('[TaskBoard] Failed to load tasks:', err)
      set({ loading: false })
    }
  },

  setView: (view) => set({ view }),
  setKeyword: (keyword) => set((s) => ({ filters: { ...s.filters, keyword } })),
  setSessionFilter: (sessionId) => set((s) => ({ filters: { ...s.filters, sessionId } })),
  setPriorityFilter: (priority) => set((s) => ({ filters: { ...s.filters, priority } })),
  selectTask: (id) => set({ selectedTaskId: id }),

  updateBoardTask: (id, patch) => {
    const item = get().items.find((t) => t.id === id)
    if (!item) return

    const now = Date.now()
    const nextMetadata: Record<string, unknown> = { ...(item.metadata ?? {}) }
    if (patch.priority !== undefined) {
      if (patch.priority === null) delete nextMetadata.priority
      else nextMetadata.priority = patch.priority
    }
    if (patch.tags !== undefined) {
      if (patch.tags.length === 0) delete nextMetadata.tags
      else nextMetadata.tags = patch.tags
    }
    if (patch.dueAt !== undefined) {
      if (patch.dueAt === null) delete nextMetadata.dueAt
      else nextMetadata.dueAt = patch.dueAt
    }
    const metadataChanged =
      patch.priority !== undefined || patch.tags !== undefined || patch.dueAt !== undefined

    // Optimistic local update.
    set((s) => ({
      items: s.items.map((t) => {
        if (t.id !== id) return t
        const meta = readTaskBoardMeta(nextMetadata)
        return {
          ...t,
          subject: patch.subject ?? t.subject,
          description: patch.description ?? t.description,
          status: patch.status ?? t.status,
          sortOrder: patch.sortOrder ?? t.sortOrder,
          metadata: metadataChanged ? nextMetadata : t.metadata,
          priority: metadataChanged ? meta.priority : t.priority,
          tags: metadataChanged ? meta.tags : t.tags,
          dueAt: metadataChanged ? meta.dueAt : t.dueAt,
          updatedAt: now
        }
      })
    }))

    // Prefer the task-store path so in-session UIs (StepsPanel, chat) stay in sync.
    const storePatch: Partial<Omit<TaskItem, 'id' | 'createdAt'>> = {}
    if (patch.subject !== undefined) storePatch.subject = patch.subject
    if (patch.description !== undefined) storePatch.description = patch.description
    if (patch.status !== undefined) storePatch.status = patch.status
    if (metadataChanged) storePatch.metadata = nextMetadata
    const viaStore =
      Object.keys(storePatch).length > 0
        ? useTaskStore.getState().updateTask(id, storePatch)
        : undefined

    if (!viaStore) {
      // Task not cached in task-store: persist directly and notify other windows.
      const dbPatch: Record<string, unknown> = { updatedAt: now }
      if (patch.subject !== undefined) dbPatch.subject = patch.subject
      if (patch.description !== undefined) dbPatch.description = patch.description
      if (patch.status !== undefined) dbPatch.status = patch.status
      if (metadataChanged) dbPatch.metadata = nextMetadata
      if (patch.sortOrder !== undefined) dbPatch.sortOrder = patch.sortOrder
      invokeMessagePackBinary(DB_TASKS_UPDATE_MSGPACK_CHANNEL, { id, patch: dbPatch }).catch(
        () => {}
      )
      emitAgentRuntimeSync({
        kind: 'task_update',
        id,
        patch: storePatch
      })
    } else if (patch.sortOrder !== undefined) {
      // task-store patch does not carry sortOrder; persist it separately.
      invokeMessagePackBinary(DB_TASKS_UPDATE_MSGPACK_CHANNEL, {
        id,
        patch: { sortOrder: patch.sortOrder, updatedAt: now }
      }).catch(() => {})
    }
  },

  moveTask: (id, status, sortOrder) => {
    get().updateBoardTask(id, { status, sortOrder })
  }
}))

/** Debounced board refresh; used by the task-store subscription while the board is open. */
export function scheduleTaskBoardRefresh(): void {
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void useTaskBoardStore.getState().refresh()
  }, 400)
}

/** Session options derived from loaded items, for the session filter dropdown. */
export function buildSessionOptions(items: TaskBoardItem[]): TaskBoardSessionOption[] {
  const map = new Map<string, TaskBoardSessionOption>()
  for (const item of items) {
    const existing = map.get(item.sessionId)
    if (existing) {
      existing.taskCount += 1
    } else {
      map.set(item.sessionId, {
        id: item.sessionId,
        title: item.sessionTitle || item.sessionId.slice(0, 8),
        taskCount: 1
      })
    }
  }
  return [...map.values()].sort((a, b) => b.taskCount - a.taskCount)
}

export function applyBoardFilters(
  items: TaskBoardItem[],
  filters: TaskBoardFilters
): TaskBoardItem[] {
  const keyword = filters.keyword.trim().toLowerCase()
  return items.filter((item) => {
    if (filters.sessionId && item.sessionId !== filters.sessionId) return false
    if (filters.priority && item.priority !== filters.priority) return false
    if (keyword) {
      const haystack =
        `${item.subject}\n${item.description}\n${item.tags.join(' ')}\n${item.sessionTitle ?? ''}`.toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
}
