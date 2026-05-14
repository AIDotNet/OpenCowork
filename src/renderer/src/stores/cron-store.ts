import { create } from 'zustand'
import { ipcClient } from '../lib/ipc/ipc-client'
import { IPC } from '../lib/ipc/channels'

// ── Types ────────────────────────────────────────────────────────

export interface CronSchedule {
  kind: 'at' | 'every' | 'cron'
  at?: number | null
  every?: number | null
  expr?: string | null
  tz?: string
}

export interface CronJobEntry {
  id: string
  sessionId: string | null
  name: string
  schedule: CronSchedule
  prompt: string
  agentId: string | null
  model: string | null
  workingFolder: string | null
  sshConnectionId: string | null
  deliveryMode: string
  deliveryTarget: string | null
  pluginId: string | null
  pluginChatId: string | null
  enabled: boolean
  deleteAfterRun: boolean
  maxIterations: number
  deletedAt: number | null
  lastFiredAt: number | null
  fireCount: number
  createdAt: number
  updatedAt: number
  sourceSessionTitle: string | null
  sourceProjectId: string | null
  sourceProjectName: string | null
  sourceProviderId: string | null
  /** Is this job currently scheduled (timer/cron active in main process) */
  scheduled: boolean
  /** Is a CronAgent currently executing for this job */
  executing: boolean
  /** Timestamp when current execution started */
  executionStartedAt: number | null
  /** Real-time progress of current execution */
  executionProgress: { iteration: number; toolCalls: number; currentStep?: string } | null
}

export interface CronRunEntry {
  id: string
  jobId: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'success' | 'error' | 'aborted'
  toolCallCount: number
  outputSummary: string | null
  error: string | null
  scheduledFor: number | null
  jobNameSnapshot: string | null
  promptSnapshot: string | null
  sourceSessionIdSnapshot: string | null
  sourceSessionTitleSnapshot: string | null
  sourceProjectIdSnapshot: string | null
  sourceProjectNameSnapshot: string | null
  sourceProviderIdSnapshot: string | null
  modelSnapshot: string | null
  workingFolderSnapshot: string | null
  deliveryModeSnapshot: string | null
  deliveryTargetSnapshot: string | null
}

export interface CronAgentLogEntry {
  jobId: string
  timestamp: number
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
  content: string
}

export interface CronRunsLoadOptions {
  jobId?: string
  sessionId?: string | null
  start?: number
  end?: number
  limit?: number
}

// ── Store ────────────────────────────────────────────────────────

interface CronStore {
  jobs: CronJobEntry[]
  runs: CronRunEntry[]
  agentLogs: Record<string, CronAgentLogEntry[]>

  loadJobs: () => Promise<void>
  loadRuns: (jobIdOrOptions?: string | CronRunsLoadOptions) => Promise<void>
  addJob: (job: CronJobEntry) => void
  removeJob: (id: string) => void
  deleteJob: (id: string) => Promise<{ success: boolean; error?: string }>
  updateJob: (id: string, patch: Partial<CronJobEntry>) => void
  upsertJob: (job: CronJobEntry) => void
  recordRun: (run: CronRunEntry) => void
  appendAgentLog: (entry: CronAgentLogEntry) => void
  appendAgentLogs: (entries: CronAgentLogEntry[]) => void
  clearAgentLogs: (jobId: string) => void
  setExecutionStarted: (jobId: string) => void
  updateExecutionProgress: (
    jobId: string,
    progress: { iteration: number; toolCalls: number; currentStep?: string }
  ) => void
  clearExecutionState: (jobId: string) => void
}

const MAX_RUNS = 1000
const MAX_AGENT_LOG_ENTRIES = 100

export const useCronStore = create<CronStore>((set) => ({
  jobs: [],
  runs: [],
  agentLogs: {},

  loadJobs: async () => {
    try {
      const result = await ipcClient.invoke(IPC.CRON_LIST, {})
      if (Array.isArray(result)) {
        set({ jobs: result as CronJobEntry[] })
      }
    } catch (err) {
      console.error('[CronStore] Failed to load jobs:', err)
    }
  },

  loadRuns: async (jobIdOrOptions?: string | CronRunsLoadOptions) => {
    try {
      const options =
        typeof jobIdOrOptions === 'string' ? { jobId: jobIdOrOptions } : (jobIdOrOptions ?? {})
      const result = await ipcClient.invoke(IPC.CRON_RUNS, {
        ...options,
        limit: options.limit ?? MAX_RUNS
      })
      if (Array.isArray(result)) {
        set({ runs: result as CronRunEntry[] })
      }
    } catch (err) {
      console.error('[CronStore] Failed to load runs:', err)
    }
  },

  addJob: (job) => set((s) => ({ jobs: [job, ...s.jobs] })),

  removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),

  deleteJob: async (id) => {
    try {
      const result = (await ipcClient.invoke(IPC.CRON_DELETE, { jobId: id })) as {
        error?: string
        success?: boolean
      }
      if (result.error) return { success: false, error: result.error }
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }))
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  },

  upsertJob: (job) =>
    set((s) => {
      const existingIndex = s.jobs.findIndex((entry) => entry.id === job.id)
      if (existingIndex < 0) {
        return { jobs: [job, ...s.jobs] }
      }
      const jobs = s.jobs.slice()
      jobs[existingIndex] = { ...jobs[existingIndex], ...job }
      return { jobs }
    }),

  updateJob: (id, patch) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),

  recordRun: (run) =>
    set((s) => ({
      runs: [run, ...s.runs.filter((entry) => entry.id !== run.id)].slice(0, MAX_RUNS)
    })),

  appendAgentLog: (entry) =>
    set((s) => {
      const prev = s.agentLogs[entry.jobId] ?? []
      return {
        agentLogs: {
          ...s.agentLogs,
          [entry.jobId]: [...prev, entry].slice(-MAX_AGENT_LOG_ENTRIES)
        }
      }
    }),

  appendAgentLogs: (entries) =>
    set((s) => {
      if (entries.length === 0) {
        return { agentLogs: s.agentLogs }
      }

      const nextAgentLogs = { ...s.agentLogs }
      const grouped = new Map<string, CronAgentLogEntry[]>()
      for (const entry of entries) {
        const bucket = grouped.get(entry.jobId)
        if (bucket) {
          bucket.push(entry)
        } else {
          grouped.set(entry.jobId, [entry])
        }
      }

      for (const [jobId, group] of grouped) {
        const prev = nextAgentLogs[jobId] ?? []
        nextAgentLogs[jobId] = [...prev, ...group].slice(-MAX_AGENT_LOG_ENTRIES)
      }

      return { agentLogs: nextAgentLogs }
    }),

  clearAgentLogs: (jobId) =>
    set((s) => {
      const next = { ...s.agentLogs }
      delete next[jobId]
      return { agentLogs: next }
    }),

  setExecutionStarted: (jobId) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === jobId
          ? { ...j, executing: true, executionStartedAt: Date.now(), executionProgress: null }
          : j
      )
    })),

  updateExecutionProgress: (jobId, progress) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, executionProgress: progress } : j))
    })),

  clearExecutionState: (jobId) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === jobId
          ? { ...j, executing: false, executionStartedAt: null, executionProgress: null }
          : j
      )
    }))
}))
