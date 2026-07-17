import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readCodeGraphEnabled } from '../ipc/settings-handlers'

// =============================================================================
// Automatic incremental CodeGraph sync (reference/04 §7, analysis/05 §6.2).
//
// The app's existing fs watcher (fs-handlers directory watching) drives sync —
// the CodeGraph worker never runs its own watcher. File-change events for a
// watched project folder are collected here, debounced per project root, and
// flushed as a single `codegraph/sync` RPC ({ workingFolder, changedPaths? }).
//
// Hard gates on flush (auto-sync must NEVER spawn the worker for a project the
// user never indexed):
//   1. the CodeGraph feature flag is enabled, AND
//   2. the project's graph DB file already exists on disk (cheap fs check that
//      mirrors the sidecar's CodeGraphDataDir path derivation — no worker call).
// =============================================================================

const SYNC_DEBOUNCE_MS = 2_000
const MAX_PENDING_CHANGED_PATHS = 500
const SYNC_TIMEOUT_MS = 300_000

interface PendingRootSync {
  timer: NodeJS.Timeout | null
  changedPaths: Set<string>
  /** Set once the pending cap is hit (or a path-less event arrives): the flush
   *  then syncs without changedPaths, letting the sidecar re-scan the root. */
  overflowed: boolean
  /** Single-flight guard: one in-flight sync per root; trailing events re-debounce. */
  inFlight: boolean
}

const pendingByRoot = new Map<string, PendingRootSync>()

/**
 * Mirrors CodeGraphDataDir.CodeGraphBaseDir (sidecars/OpenCowork.CodeGraph.Core/
 * Support/CodeGraphDataDir.cs): `CODEGRAPH_HOME` overrides the whole base dir,
 * otherwise ~/.open-cowork/codegraph.
 */
function codeGraphBaseDir(): string {
  const override = process.env.CODEGRAPH_HOME
  if (override && override.length > 0) return override
  return path.join(os.homedir(), '.open-cowork', 'codegraph')
}

/**
 * Mirrors CodeGraphDataDir.HashRoot exactly: sha256 of the canonicalized
 * absolute project root as 64-char lowercase hex. Canonicalization: resolve to
 * a full path, forward-slash it, drop trailing slashes (root collapses to "/"),
 * and lowercase on Windows only (case-insensitive FS); POSIX keeps case.
 */
function hashCodeGraphRoot(projectRoot: string): string {
  let full = path.resolve(projectRoot).replace(/\\/g, '/').replace(/\/+$/, '')
  if (full.length === 0) full = '/'
  if (process.platform === 'win32') full = full.toLowerCase()
  return createHash('sha256').update(full, 'utf8').digest('hex')
}

/** Whether the project was ever indexed: …/codegraph/<hash>/graph.db exists. */
function graphDbExists(projectRoot: string): boolean {
  try {
    return fs.existsSync(path.join(codeGraphBaseDir(), hashCodeGraphRoot(projectRoot), 'graph.db'))
  } catch {
    return false
  }
}

function scheduleFlush(root: string, entry: PendingRootSync): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    void flushRoot(root, entry)
  }, SYNC_DEBOUNCE_MS)
}

function dropEntry(root: string, entry: PendingRootSync): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  entry.changedPaths.clear()
  entry.overflowed = false
  if (pendingByRoot.get(root) === entry) pendingByRoot.delete(root)
}

async function flushRoot(root: string, entry: PendingRootSync): Promise<void> {
  if (entry.inFlight) {
    // A sync for this root is already running — re-debounce the trailing events.
    scheduleFlush(root, entry)
    return
  }

  if (!readCodeGraphEnabled()) {
    dropEntry(root, entry)
    return
  }

  // Never index implicitly: skip roots whose graph DB was never created.
  if (!graphDbExists(root)) {
    dropEntry(root, entry)
    return
  }

  const changedPaths = entry.overflowed ? undefined : Array.from(entry.changedPaths)
  entry.changedPaths.clear()
  entry.overflowed = false
  entry.inFlight = true

  try {
    // Lazy import: keeps this module out of the sidecar-manager static import
    // cycle (settings-handlers → codegraph-sync → sidecar-manager → settings-handlers).
    const { handleCodeGraphRequest } = await import('../ipc/sidecar-manager')
    const result = await handleCodeGraphRequest(
      'codegraph/sync',
      changedPaths ? { workingFolder: root, changedPaths } : { workingFolder: root },
      SYNC_TIMEOUT_MS
    )
    const record = result as { errorKind?: unknown; isError?: unknown; message?: unknown } | null
    if (record && typeof record === 'object' && (record.errorKind || record.isError === true)) {
      console.warn(
        `[CodeGraph] Auto-sync skipped for ${root}: ${String(record.message ?? record.errorKind)}`
      )
    }
  } catch (error) {
    // handleCodeGraphRequest is success-shaped by convention; this is a last resort.
    console.warn(
      `[CodeGraph] Auto-sync failed for ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  } finally {
    entry.inFlight = false
    if (pendingByRoot.get(root) !== entry) {
      // Queues were cleared (feature disabled) while the sync ran — drop trailing state.
    } else if (entry.changedPaths.size > 0 || entry.overflowed) {
      // Events arrived during the flight: re-debounce a trailing sync.
      scheduleFlush(root, entry)
    } else if (!entry.timer) {
      pendingByRoot.delete(root)
    }
  }
}

/**
 * Record a file change under a watched project folder. Changes are collected
 * per project root and flushed (debounced, trailing-edge) as one incremental
 * `codegraph/sync`. Cheap when CodeGraph is disabled or the project was never
 * indexed — the gates run at flush time and simply drop the queue.
 */
export function notifyCodeGraphFileChanged(workingFolder: string, changedPath?: string): void {
  const root = path.resolve(workingFolder)
  let entry = pendingByRoot.get(root)
  if (!entry) {
    entry = { timer: null, changedPaths: new Set(), overflowed: false, inFlight: false }
    pendingByRoot.set(root, entry)
  }

  if (!entry.overflowed) {
    if (changedPath) {
      entry.changedPaths.add(path.resolve(changedPath))
      if (entry.changedPaths.size > MAX_PENDING_CHANGED_PATHS) {
        entry.changedPaths.clear()
        entry.overflowed = true
      }
    } else {
      // No specific path — fall back to a full incremental scan of the root.
      entry.changedPaths.clear()
      entry.overflowed = true
    }
  }

  scheduleFlush(root, entry)
}

/**
 * Cancel all pending debounces and drop queued paths. Called next to
 * stopCodeGraphWorker() when the CodeGraph toggle flips true→false so a stale
 * debounce cannot respawn the worker after disable.
 */
export function clearCodeGraphSyncQueues(): void {
  for (const entry of pendingByRoot.values()) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.changedPaths.clear()
    entry.overflowed = false
  }
  pendingByRoot.clear()
}
