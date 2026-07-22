// Main-process authority for in-flight agent run state.
//
// Runtime state (which runs are executing, their per-run event stream, the
// streaming assistant message id, and outstanding approvals) used to live only
// in renderer memory and was delivered as live deltas. A full renderer reload
// (Vite HMR in dev) or a window that mounts after deltas were sent had no way to
// catch up. This registry keeps that state in the main process so any window can
// pull a snapshot (agent:runtime-state) and replay the per-run event tail
// (agent:attach-run) to reconstruct the in-progress message exactly as normal
// streaming would.
//
// The .NET worker is untouched: the journal is built from the raw agent-stream
// frames already flowing through the sidecar bridge (they carry a monotonic
// per-run seq), and the assistant message id is observed on the session-runtime
// sync channel that main already decodes before routing.

// Ring-buffer caps per run. A long run streams thousands of deltas; without a
// cap the journal would grow unbounded. On overflow the oldest non-first frame
// is dropped (the first frame, loop_start, is kept so replay can seed message
// structure). These bound worst-case memory to ~8 MiB per concurrent run.
const MAX_JOURNAL_FRAMES = 2000
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024

// Keep a terminated run's journal around briefly so a window that reloads right
// as the run finishes can still replay the tail (and see the terminal event).
const TERMINAL_JOURNAL_RETENTION_MS = 30_000

export type AgentRunStatus = 'running' | 'completed' | 'error'

interface JournalFrame {
  seq: number
  bytes: Buffer
}

interface RunJournal {
  runId: string
  sessionId: string
  status: AgentRunStatus
  lastSeq: number
  frames: JournalFrame[]
  byteLength: number
  cleanupTimer: ReturnType<typeof setTimeout> | null
}

export interface RuntimeRunSnapshot {
  runId: string
  sessionId: string
  status: AgentRunStatus
  lastSeq: number
  assistantMessageId: string | null
}

export interface RuntimeApprovalSnapshot {
  requestId: string
  sessionId: string | null
  runId: string | null
  params: unknown
}

/**
 * Supplier the sidecar layer registers so the registry can surface outstanding
 * approvals in a snapshot without importing the sidecar handler's closure state.
 */
type ApprovalSnapshotSupplier = () => RuntimeApprovalSnapshot[]

class RuntimeRegistry {
  private readonly journals = new Map<string, RunJournal>()
  // sessionId -> the assistant message id currently streaming for that session.
  // Observed from session-runtime:sync (set_streaming_message / add_message).
  private readonly sessionStreamingMessageIds = new Map<string, string>()
  private approvalSupplier: ApprovalSnapshotSupplier | null = null

  setApprovalSnapshotSupplier(supplier: ApprovalSnapshotSupplier | null): void {
    this.approvalSupplier = supplier
  }

  /**
   * Append a raw agent-stream frame to its run journal. `bytes` is the exact
   * MessagePack envelope that was (or will be) posted to the renderer, so replay
   * can re-post it verbatim.
   */
  recordFrame(frame: {
    runId?: string
    sessionId?: string
    seq?: number
    hasTerminalEvent?: boolean
    bytes: Buffer
    byteLength: number
  }): void {
    const runId = frame.runId
    const sessionId = frame.sessionId
    if (!runId || !sessionId) return

    let journal = this.journals.get(runId)
    if (!journal) {
      journal = {
        runId,
        sessionId,
        status: 'running',
        lastSeq: -1,
        frames: [],
        byteLength: 0,
        cleanupTimer: null
      }
      this.journals.set(runId, journal)
    }

    // A late frame for an already-scheduled-for-cleanup run means the run is
    // somehow still emitting; cancel the pending deletion.
    if (journal.cleanupTimer) {
      clearTimeout(journal.cleanupTimer)
      journal.cleanupTimer = null
      journal.status = 'running'
    }

    const seq = typeof frame.seq === 'number' ? frame.seq : journal.lastSeq + 1
    // Copy defensively: the caller's Buffer may be pooled/reused by the reader.
    const bytes = Buffer.from(frame.bytes)
    journal.frames.push({ seq, bytes })
    journal.byteLength += bytes.byteLength
    if (seq > journal.lastSeq) journal.lastSeq = seq

    this.trimJournal(journal)

    if (frame.hasTerminalEvent === true) {
      // The terminal reason (completed vs error) isn't in the cheap route scan;
      // treat any terminal as 'completed' for status purposes — the renderer
      // reads the actual loop_end/error event from the replayed frames.
      journal.status = 'completed'
      journal.cleanupTimer = setTimeout(() => {
        this.journals.delete(runId)
      }, TERMINAL_JOURNAL_RETENTION_MS)
    }
  }

  private trimJournal(journal: RunJournal): void {
    while (journal.frames.length > MAX_JOURNAL_FRAMES || journal.byteLength > MAX_JOURNAL_BYTES) {
      // Keep the first frame (loop_start) so replay can seed structure; drop the
      // second-oldest instead.
      const dropIndex = journal.frames.length > 1 ? 1 : 0
      const [dropped] = journal.frames.splice(dropIndex, 1)
      if (!dropped) break
      journal.byteLength -= dropped.bytes.byteLength
      if (journal.frames.length <= 1) break
    }
  }

  /** Frames with seq strictly greater than sinceSeq, in arrival order. */
  getFramesSince(runId: string, sinceSeq: number): Buffer[] {
    const journal = this.journals.get(runId)
    if (!journal) return []
    return journal.frames.filter((f) => f.seq > sinceSeq).map((f) => f.bytes)
  }

  getRunSnapshots(): RuntimeRunSnapshot[] {
    const snapshots: RuntimeRunSnapshot[] = []
    for (const journal of this.journals.values()) {
      snapshots.push({
        runId: journal.runId,
        sessionId: journal.sessionId,
        status: journal.status,
        lastSeq: journal.lastSeq,
        assistantMessageId: this.sessionStreamingMessageIds.get(journal.sessionId) ?? null
      })
    }
    return snapshots
  }

  getApprovalSnapshots(): RuntimeApprovalSnapshot[] {
    return this.approvalSupplier?.() ?? []
  }

  // --- Streaming assistant message id observation ---

  setStreamingMessageId(sessionId: string, messageId: string | null): void {
    if (!sessionId) return
    if (messageId) {
      this.sessionStreamingMessageIds.set(sessionId, messageId)
    } else {
      this.sessionStreamingMessageIds.delete(sessionId)
    }
  }

  getStreamingMessageId(sessionId: string): string | null {
    return this.sessionStreamingMessageIds.get(sessionId) ?? null
  }
}

let registry: RuntimeRegistry | null = null

export function getRuntimeRegistry(): RuntimeRegistry {
  if (!registry) registry = new RuntimeRegistry()
  return registry
}
