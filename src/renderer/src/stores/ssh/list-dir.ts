// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
import type { SshFileEntry } from './types'

const MAX_CONCURRENT_LIST_DIR = 2
export const SSH_FILE_EXPLORER_PAGE_SIZE = 200
export const SSH_FILE_EXPLORER_STALE_LOAD_MS = 30000
export const IPC_LIST_DIR_TIMEOUT_MS = 45000

export const listDirInFlightSince = new Map<string, number>()

export function ipcWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('IPC list-dir timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function getListDirKey(sessionId: string, path: string): string {
  return `${sessionId}:${path}`
}

export type FileExplorerPageInfo = {
  cursor?: string
  hasMore: boolean
}

export type ListDirPagedResult = {
  entries?: SshFileEntry[]
  nextCursor?: string
  hasMore?: boolean
  error?: string
}

type ListDirQueue = {
  active: number
  queue: Array<() => void>
}

const listDirQueues = new Map<string, ListDirQueue>()

function getListDirQueue(sessionId: string): ListDirQueue {
  const existing = listDirQueues.get(sessionId)
  if (existing) return existing
  const created = { active: 0, queue: [] }
  listDirQueues.set(sessionId, created)
  return created
}

const SLOT_ACQUIRE_TIMEOUT_MS = 10000

export function acquireListDirSlot(sessionId: string): Promise<() => void> {
  const queue = getListDirQueue(sessionId)
  return new Promise((resolve) => {
    let resolved = false
    const tryAcquire = (): void => {
      if (resolved) return
      if (queue.active < MAX_CONCURRENT_LIST_DIR) {
        resolved = true
        queue.active += 1
        resolve(() => {
          queue.active = Math.max(0, queue.active - 1)
          const next = queue.queue.shift()
          if (next) next()
        })
        return
      }
      queue.queue.push(tryAcquire)
    }

    tryAcquire()

    if (!resolved) {
      console.warn('[SshStore] slot queue full, waiting...', {
        sessionId,
        active: queue.active,
        queued: queue.queue.length
      })
      setTimeout(() => {
        if (resolved) return
        console.warn('[SshStore] slot acquire timeout — force-resetting queue', {
          sessionId,
          active: queue.active,
          queued: queue.queue.length
        })
        resolved = true
        queue.active = 0
        queue.queue.length = 0
        queue.active = 1
        resolve(() => {
          queue.active = Math.max(0, queue.active - 1)
          const next = queue.queue.shift()
          if (next) next()
        })
      }, SLOT_ACQUIRE_TIMEOUT_MS)
    }
  })
}

export function sortEntries(entries: SshFileEntry[]): SshFileEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
  })
}

export function normalizePageInfo(meta?: ListDirPagedResult): FileExplorerPageInfo {
  const cursor = typeof meta?.nextCursor === 'string' ? meta.nextCursor : undefined
  const hasMore = typeof meta?.hasMore === 'boolean' ? meta.hasMore : Boolean(cursor)
  return { cursor, hasMore }
}

export function areStringSetsEqual(left: Set<string> | undefined, right: Set<string>): boolean {
  if (!left || left.size !== right.size) return false
  for (const value of right) {
    if (!left.has(value)) return false
  }
  return true
}
