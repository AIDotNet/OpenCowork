type CronFiredEvent = {
  jobId: string
  name?: string
  prompt?: string
  agentId?: string | null
  model?: string | null
  workingFolder?: string | null
  deliveryMode?: string
  deliveryTarget?: string | null
  maxIterations?: number
  error?: string
}

type CronJobRemovedEvent = {
  jobId: string
  reason: 'delete_after_run' | 'manual'
}

type CronRunStartedEvent = {
  jobId: string
  runId: string
}

type CronRunProgressEvent = {
  jobId: string
  runId: string
  iteration: number
  toolCalls: number
  elapsed: number
  currentStep?: string
}

type CronRunFinishedEvent = {
  jobId: string
  runId: string
  status: 'success' | 'error' | 'aborted'
  toolCallCount: number
  outputSummary?: string
  error?: string
}

type CronEvent =
  | ({ type: 'fired' } & CronFiredEvent)
  | ({ type: 'job_removed' } & CronJobRemovedEvent)
  | ({ type: 'run_started' } & CronRunStartedEvent)
  | ({ type: 'run_progress' } & CronRunProgressEvent)
  | ({ type: 'run_finished' } & CronRunFinishedEvent)

type CronEventListener = (event: CronEvent) => void

const listeners = new Set<CronEventListener>()

export const cronEvents = {
  emit(event: CronEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[cronEvents] listener error:', err)
      }
    }
  },

  on(listener: CronEventListener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export type { CronFiredEvent, CronJobRemovedEvent, CronRunStartedEvent, CronRunProgressEvent, CronRunFinishedEvent, CronEvent }
