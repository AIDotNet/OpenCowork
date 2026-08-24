// Main-process bookkeeping for in-flight agent run state.
//
// This tracks which runs are executing, how far each has streamed, the streaming
// assistant message id, and outstanding approvals, so any window can pull a
// snapshot (agent:runtime-state) when it mounts or reloads.
//
// It deliberately does not buffer stream frames. It used to: a per-run ring of
// raw MessagePack envelopes, capped at 2000 frames and 8 MiB, replayed to
// late-attaching windows. That cap silently dropped the middle of long runs, and
// it duplicated a job the worker already does better — the worker's SQLite outbox
// holds every envelope on disk with a cursor per consumer. Windows now subscribe
// to that outbox directly and resume with events/subscribe, so the only thing
// worth keeping here is run status, which is cheap and bounded.

// Keep a terminated run visible briefly so a window that reloads right as the run
// finishes still sees it in a snapshot.
const TERMINAL_RUN_RETENTION_MS = 30_000

export type AgentRunStatus = 'running' | 'completed' | 'error'

interface RunRecord {
  runId: string
  sessionId: string
  status: AgentRunStatus
  lastSeq: number
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
  private readonly runs = new Map<string, RunRecord>()
  // sessionId -> the assistant message id currently streaming for that session.
  // Observed from session-runtime:sync (set_streaming_message / add_message).
  private readonly sessionStreamingMessageIds = new Map<string, string>()
  private approvalSupplier: ApprovalSnapshotSupplier | null = null

  setApprovalSnapshotSupplier(supplier: ApprovalSnapshotSupplier | null): void {
    this.approvalSupplier = supplier
  }

  /** Records that a run produced a frame, tracking status and progress only. */
  recordFrame(frame: {
    runId?: string
    sessionId?: string
    seq?: number
    hasTerminalEvent?: boolean
  }): void {
    const runId = frame.runId
    const sessionId = frame.sessionId
    if (!runId || !sessionId) return

    let run = this.runs.get(runId)
    if (!run) {
      run = { runId, sessionId, status: 'running', lastSeq: -1, cleanupTimer: null }
      this.runs.set(runId, run)
    }

    // A late frame for an already-scheduled-for-cleanup run means the run is
    // somehow still emitting; cancel the pending deletion.
    if (run.cleanupTimer) {
      clearTimeout(run.cleanupTimer)
      run.cleanupTimer = null
      run.status = 'running'
    }

    const seq = typeof frame.seq === 'number' ? frame.seq : run.lastSeq + 1
    if (seq > run.lastSeq) run.lastSeq = seq

    if (frame.hasTerminalEvent === true) {
      // The terminal reason (completed vs error) isn't in the cheap route scan;
      // treat any terminal as 'completed' for status purposes — the renderer
      // reads the actual loop_end/error event off its own stream subscription.
      run.status = 'completed'
      run.cleanupTimer = setTimeout(() => {
        this.runs.delete(runId)
      }, TERMINAL_RUN_RETENTION_MS)
    }
  }

  getRunSnapshots(): RuntimeRunSnapshot[] {
    const snapshots: RuntimeRunSnapshot[] = []
    for (const run of this.runs.values()) {
      snapshots.push({
        runId: run.runId,
        sessionId: run.sessionId,
        status: run.status,
        lastSeq: run.lastSeq,
        assistantMessageId: this.sessionStreamingMessageIds.get(run.sessionId) ?? null
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
