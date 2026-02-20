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
  name: string
  schedule: CronSchedule
  prompt: string
  agentId: string | null
  model: string | null
  workingFolder: string | null
  deliveryMode: string
  deliveryTarget: string | null
  pluginId: string | null
  pluginChatId: string | null
  enabled: boolean
  deleteAfterRun: boolean
  maxIterations: number
  lastFiredAt: number | null
  fireCount: number
  createdAt: number
  updatedAt: number
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
}

export interface CronAgentLogEntry {
  jobId: string
  timestamp: number
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
  content: string
}

// ── Store ────────────────────────────────────────────────────────

interface CronStore {
  jobs: CronJobEntry[]
  runs: CronRunEntry[]
  agentLogs: Record<string, CronAgentLogEntry[]>

  loadJobs: () => Promise<void>
  loadRuns: (jobId?: string) => Promise<void>
  addJob: (job: CronJobEntry) => void
  removeJob: (id: string) => void
  updateJob: (id: string, patch: Partial<CronJobEntry>) => void
  recordRun: (run: CronRunEntry) => void
  appendAgentLog: (entry: CronAgentLogEntry) => void
  clearAgentLogs: (jobId: string) => void
  setExecutionStarted: (jobId: string) => void
  updateExecutionProgress: (jobId: string, progress: { iteration: number; toolCalls: number; currentStep?: string }) => void
  clearExecutionState: (jobId: string) => void
}

const MAX_RUNS = 100
const MAX_AGENT_LOG_ENTRIES = 100

export const useCronStore = create<CronStore>((set) => ({
  jobs: [],
  runs: [],
  agentLogs: {},

  loadJobs: async () => {
    try {
      const result = await ipcClient.invoke(IPC.CRON_LIST)
      if (Array.isArray(result)) {
        set({ jobs: result as CronJobEntry[] })
      }
    } catch (err) {
      console.error('[CronStore] Failed to load jobs:', err)
    }
  },

  loadRuns: async (jobId?: string) => {
    try {
      const result = await ipcClient.invoke(IPC.CRON_RUNS, { jobId, limit: MAX_RUNS })
      if (Array.isArray(result)) {
        set({ runs: result as CronRunEntry[] })
      }
    } catch (err) {
      console.error('[CronStore] Failed to load runs:', err)
    }
  },

  addJob: (job) =>
    set((s) => ({ jobs: [job, ...s.jobs] })),

  removeJob: (id) =>
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),

  updateJob: (id, patch) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),

  recordRun: (run) =>
    set((s) => ({ runs: [run, ...s.runs].slice(0, MAX_RUNS) })),

  appendAgentLog: (entry) =>
    set((s) => {
      const prev = s.agentLogs[entry.jobId] ?? []
      return {
        agentLogs: {
          ...s.agentLogs,
          [entry.jobId]: [...prev, entry].slice(-MAX_AGENT_LOG_ENTRIES),
        },
      }
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
      ),
    })),

  updateExecutionProgress: (jobId, progress) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === jobId ? { ...j, executionProgress: progress } : j
      ),
    })),

  clearExecutionState: (jobId) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === jobId
          ? { ...j, executing: false, executionStartedAt: null, executionProgress: null }
          : j
      ),
    })),
}))
