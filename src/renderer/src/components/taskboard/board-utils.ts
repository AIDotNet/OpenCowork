import type { TaskPriority, TaskStatus } from '@renderer/stores/task-store'
import type { TaskBoardItem } from '@renderer/stores/task-board-store'
import { BOARD_COLUMN_STATUSES } from '@renderer/stores/task-board-store'

/** Column accent colors keyed by status (tailwind-safe static classes). */
export const STATUS_DOT_CLASS: Record<TaskStatus, string> = {
  pending: 'bg-slate-400',
  in_progress: 'bg-blue-500',
  blocked: 'bg-red-500',
  in_review: 'bg-amber-500',
  completed: 'bg-emerald-500'
}

export const STATUS_TEXT_CLASS: Record<TaskStatus, string> = {
  pending: 'text-slate-500',
  in_progress: 'text-blue-600 dark:text-blue-400',
  blocked: 'text-red-600 dark:text-red-400',
  in_review: 'text-amber-600 dark:text-amber-400',
  completed: 'text-emerald-600 dark:text-emerald-400'
}

export const PRIORITY_BADGE_CLASS: Record<TaskPriority, string> = {
  urgent: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30',
  medium: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30',
  low: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30'
}

const TAG_PALETTE = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300'
]

/** Stable tag color derived from the tag text. */
export function tagColorClass(tag: string): string {
  let hash = 0
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) | 0
  }
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length]
}

/** Short display id like "T-3f9a" derived from the task id. */
export function shortTaskId(id: string): string {
  return `T-${id.slice(0, 4)}`
}

export function formatBoardDate(ts: number, locale: string): string {
  const date = new Date(ts)
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

export function columnIndexOf(status: TaskStatus): number {
  const idx = BOARD_COLUMN_STATUSES.indexOf(status)
  return idx === -1 ? BOARD_COLUMN_STATUSES.length : idx
}

const SORT_BASE_STEP = 1000
const SORT_GAP_STEP = 10

/**
 * Compute the sort order for inserting at `destIndex` within `columnItems`
 * (the destination column WITHOUT the dragged item). Returns either a single
 * integer slot, or a full-column renumbering when no integer gap remains.
 */
export function computeInsertSortOrder(
  columnItems: TaskBoardItem[],
  destIndex: number,
  status: TaskStatus
): { sortOrder: number; renumber: { id: string; sortOrder: number }[] | null } {
  const base = (columnIndexOf(status) + 1) * SORT_BASE_STEP
  const prev = destIndex > 0 ? columnItems[destIndex - 1].sortOrder : undefined
  const next = destIndex < columnItems.length ? columnItems[destIndex].sortOrder : undefined

  if (prev === undefined && next === undefined) {
    return { sortOrder: base, renumber: null }
  }
  if (prev === undefined) {
    return { sortOrder: next! - SORT_GAP_STEP, renumber: null }
  }
  if (next === undefined) {
    return { sortOrder: prev + SORT_GAP_STEP, renumber: null }
  }
  if (next - prev > 1) {
    return { sortOrder: Math.floor((prev + next) / 2), renumber: null }
  }

  // No integer gap left: renumber the whole column with fresh spacing.
  const renumber: { id: string; sortOrder: number }[] = []
  let slot = base
  let inserted = -1
  for (let i = 0; i <= columnItems.length; i++) {
    if (i === destIndex) {
      inserted = slot
      slot += SORT_GAP_STEP
    }
    if (i < columnItems.length) {
      renumber.push({ id: columnItems[i].id, sortOrder: slot })
      slot += SORT_GAP_STEP
    }
  }
  return { sortOrder: inserted, renumber }
}

export function sortColumnItems(items: TaskBoardItem[]): TaskBoardItem[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
}
