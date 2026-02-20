import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ToolCallState } from '../lib/agent/types'
import type { SubAgentEvent } from '../lib/agent/sub-agents/types'
import type { ToolResultContent } from '../lib/api/types'
import { ipcStorage } from '../lib/ipc/ipc-storage'
import { ipcClient } from '../lib/ipc/ipc-client'
import { IPC } from '../lib/ipc/channels'

// Approval resolvers live outside the store — they hold non-serializable
// callbacks and don't need to trigger React re-renders.
const approvalResolvers = new Map<string, (approved: boolean) => void>()

const MAX_TRACKED_TOOL_CALLS = 300
const MAX_TRACKED_SUBAGENT_TOOL_CALLS = 120
const MAX_COMPLETED_SUBAGENTS = 80
const MAX_SUBAGENT_HISTORY = 200
const MAX_STREAMING_TEXT_CHARS = 12_000
const MAX_TOOL_INPUT_PREVIEW_CHARS = 8_000
const MAX_TOOL_OUTPUT_TEXT_CHARS = 12_000
const MAX_TOOL_ERROR_CHARS = 2_000
const MAX_IMAGE_BASE64_CHARS = 4_096
const MAX_BACKGROUND_PROCESS_OUTPUT_CHARS = 20_000
const MAX_BACKGROUND_PROCESS_ENTRIES = 120

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n... [truncated, ${value.length} chars total]`
}

function normalizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(input)
    if (serialized.length <= MAX_TOOL_INPUT_PREVIEW_CHARS) return input
    return {
      _truncated: true,
      preview: truncateText(serialized, MAX_TOOL_INPUT_PREVIEW_CHARS),
    }
  } catch {
    return { _truncated: true, preview: '[unserializable input]' }
  }
}

function limitToolResultContent(output: ToolResultContent | undefined): ToolResultContent | undefined {
  if (output === undefined) return undefined
  if (typeof output === 'string') {
    return truncateText(output, MAX_TOOL_OUTPUT_TEXT_CHARS)
  }

  const normalized: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64' | 'url'; mediaType?: string; data?: string; url?: string } }
  > = []
  let totalChars = 0

  for (const block of output) {
    if (block.type === 'text') {
      const text = truncateText(block.text, MAX_TOOL_OUTPUT_TEXT_CHARS)
      totalChars += text.length
      normalized.push({ ...block, text })
      if (totalChars >= MAX_TOOL_OUTPUT_TEXT_CHARS) {
        normalized.push({
          type: 'text',
          text: `[tool output truncated after ${MAX_TOOL_OUTPUT_TEXT_CHARS} chars]`,
        })
        break
      }
      continue
    }

    if (
      block.type === 'image' &&
      block.source.data &&
      block.source.data.length > MAX_IMAGE_BASE64_CHARS
    ) {
      normalized.push({
        type: 'text',
        text: `[image data omitted, ${block.source.data.length} base64 chars]`,
      })
      continue
    }

    normalized.push(block)
  }

  return normalized
}

function normalizeToolCall(tc: ToolCallState): ToolCallState {
  return {
    ...tc,
    input: normalizeToolInput(tc.input),
    output: limitToolResultContent(tc.output),
    error: tc.error ? truncateText(tc.error, MAX_TOOL_ERROR_CHARS) : tc.error,
  }
}

function normalizeToolCallPatch(patch: Partial<ToolCallState>): Partial<ToolCallState> {
  return {
    ...patch,
    ...(patch.input ? { input: normalizeToolInput(patch.input) } : {}),
    ...(patch.output !== undefined ? { output: limitToolResultContent(patch.output) } : {}),
    ...(patch.error ? { error: truncateText(patch.error, MAX_TOOL_ERROR_CHARS) } : {}),
  }
}

function trimToolCallArray(toolCalls: ToolCallState[]): void {
  if (toolCalls.length <= MAX_TRACKED_TOOL_CALLS) return
  toolCalls.splice(0, toolCalls.length - MAX_TRACKED_TOOL_CALLS)
}

interface SubAgentState {
  name: string
  toolUseId: string
  sessionId?: string
  isRunning: boolean
  iteration: number
  toolCalls: ToolCallState[]
  streamingText: string
  startedAt: number
  completedAt: number | null
}

function trimCompletedSubAgentsMap(map: Record<string, SubAgentState>): void {
  const keys = Object.keys(map)
  if (keys.length <= MAX_COMPLETED_SUBAGENTS) return
  const removeCount = keys.length - MAX_COMPLETED_SUBAGENTS
  for (let i = 0; i < removeCount; i++) {
    delete map[keys[i]]
  }
}

function trimSubAgentHistory(history: SubAgentState[]): void {
  if (history.length <= MAX_SUBAGENT_HISTORY) return
  history.splice(0, history.length - MAX_SUBAGENT_HISTORY)
}

export interface BackgroundProcessState {
  id: string
  command: string
  cwd?: string
  sessionId?: string
  toolUseId?: string
  description?: string
  source?: string
  status: 'running' | 'exited' | 'stopped' | 'error'
  output: string
  port?: number
  exitCode?: number | null
  createdAt: number
  updatedAt: number
}

interface ProcessListItem {
  id: string
  command: string
  cwd?: string
  port?: number
  createdAt?: number
  running?: boolean
  exitCode?: number | null
  metadata?: {
    source?: string
    sessionId?: string
    toolUseId?: string
    description?: string
  }
}

interface ProcessOutputEvent {
  id: string
  data?: string
  port?: number
  exited?: boolean
  exitCode?: number | null
  metadata?: {
    source?: string
    sessionId?: string
    toolUseId?: string
    description?: string
  }
}

function appendBackgroundOutput(existing: string, chunk: string): string {
  const next = `${existing}${chunk}`
  if (next.length <= MAX_BACKGROUND_PROCESS_OUTPUT_CHARS) return next
  return truncateText(next, MAX_BACKGROUND_PROCESS_OUTPUT_CHARS)
}

function trimBackgroundProcessMap(map: Record<string, BackgroundProcessState>): void {
  const entries = Object.entries(map).sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  if (entries.length <= MAX_BACKGROUND_PROCESS_ENTRIES) return
  const removeCount = entries.length - MAX_BACKGROUND_PROCESS_ENTRIES
  for (let i = 0; i < removeCount; i++) {
    delete map[entries[i][0]]
  }
}

export type { SubAgentState }

interface AgentStore {
  isRunning: boolean
  currentLoopId: string | null
  pendingToolCalls: ToolCallState[]
  executedToolCalls: ToolCallState[]

  /** Per-session agent running state for sidebar indicators */
  runningSessions: Record<string, 'running' | 'completed'>

  /** Per-session tool-call cache — stores tool calls when switching away from a session */
  sessionToolCallsCache: Record<string, { pending: ToolCallState[]; executed: ToolCallState[] }>

  // SubAgent state keyed by toolUseId (supports multiple same-name SubAgent calls)
  activeSubAgents: Record<string, SubAgentState>
  /** Completed SubAgent results keyed by toolUseId — survives until clearToolCalls */
  completedSubAgents: Record<string, SubAgentState>
  /** Historical SubAgent records — persisted across agent runs */
  subAgentHistory: SubAgentState[]

  /** Tool names approved by user during this session — auto-approve on repeat */
  approvedToolNames: string[]
  addApprovedTool: (name: string) => void

  /** Background command sessions (spawned by Bash with run_in_background=true) */
  backgroundProcesses: Record<string, BackgroundProcessState>
  /** Foreground shell exec mapping (toolUseId -> execId), used for in-card stop actions */
  foregroundShellExecByToolUseId: Record<string, string>
  initBackgroundProcessTracking: () => Promise<void>
  registerForegroundShellExec: (toolUseId: string, execId: string) => void
  clearForegroundShellExec: (toolUseId: string) => void
  abortForegroundShellExec: (toolUseId: string) => Promise<void>
  registerBackgroundProcess: (process: {
    id: string
    command: string
    cwd?: string
    sessionId?: string
    toolUseId?: string
    description?: string
    source?: string
  }) => void
  stopBackgroundProcess: (id: string) => Promise<void>
  sendBackgroundProcessInput: (id: string, input: string, appendNewline?: boolean) => Promise<void>
  removeBackgroundProcess: (id: string) => void

  setRunning: (running: boolean) => void
  setCurrentLoopId: (id: string | null) => void
  /** Update per-session status. 'completed' auto-clears after ~3 s. null removes entry. */
  setSessionStatus: (sessionId: string, status: 'running' | 'completed' | null) => void
  /** Switch active tool-call context: save current tool calls for prevSession, restore for nextSession */
  switchToolCallSession: (prevSessionId: string | null, nextSessionId: string | null) => void
  addToolCall: (tc: ToolCallState) => void
  updateToolCall: (id: string, patch: Partial<ToolCallState>) => void
  clearToolCalls: () => void
  abort: () => void

  // SubAgent events
  handleSubAgentEvent: (event: SubAgentEvent, sessionId?: string) => void

  /** Remove all subagent / tool-call data that belongs to the given session */
  clearSessionData: (sessionId: string) => void

  // Approval flow
  requestApproval: (toolCallId: string) => Promise<boolean>
  resolveApproval: (toolCallId: string, approved: boolean) => void
  /** Resolve all pending approvals as denied and clear pendingToolCalls (e.g. on team delete) */
  clearPendingApprovals: () => void
}

let processTrackingInitialized = false

export const useAgentStore = create<AgentStore>()(
  persist(
    immer((set) => ({
      isRunning: false,
      currentLoopId: null,
      pendingToolCalls: [],
      executedToolCalls: [],
      runningSessions: {},
      sessionToolCallsCache: {},
      activeSubAgents: {},
      completedSubAgents: {},
      subAgentHistory: [],
      approvedToolNames: [],
      backgroundProcesses: {},
      foregroundShellExecByToolUseId: {},

      setRunning: (running) => set({ isRunning: running }),

      setCurrentLoopId: (id) => set({ currentLoopId: id }),

      setSessionStatus: (sessionId, status) => {
        set((state) => {
          if (status) {
            state.runningSessions[sessionId] = status
          } else {
            delete state.runningSessions[sessionId]
          }
        })
        // Auto-clear 'completed' after 3 seconds
        if (status === 'completed') {
          setTimeout(() => {
            set((state) => {
              if (state.runningSessions[sessionId] === 'completed') {
                delete state.runningSessions[sessionId]
              }
            })
          }, 3000)
        }
      },

      switchToolCallSession: (prevSessionId, nextSessionId) => {
        set((state) => {
          // Save current tool calls to cache for the previous session
          if (prevSessionId) {
            state.sessionToolCallsCache[prevSessionId] = {
              pending: [...state.pendingToolCalls],
              executed: [...state.executedToolCalls],
            }
          }
          // Restore tool calls from cache for the next session (or clear)
          const cached = nextSessionId ? state.sessionToolCallsCache[nextSessionId] : undefined
          state.pendingToolCalls = cached?.pending ?? []
          state.executedToolCalls = cached?.executed ?? []
        })
      },

      addToolCall: (tc) => {
        set((state) => {
          const normalizedTc = normalizeToolCall(tc)
          // Idempotent: if already exists (e.g. from streaming phase), update in-place
          const execIdx = state.executedToolCalls.findIndex((t) => t.id === normalizedTc.id)
          if (execIdx !== -1) {
            if (normalizedTc.status === 'pending_approval') {
              // Move from executed to pending
              const [moved] = state.executedToolCalls.splice(execIdx, 1)
              Object.assign(moved, normalizedTc)
              state.pendingToolCalls.push(moved)
            } else {
              Object.assign(state.executedToolCalls[execIdx], normalizedTc)
            }
            trimToolCallArray(state.executedToolCalls)
            trimToolCallArray(state.pendingToolCalls)
            return
          }
          const pendIdx = state.pendingToolCalls.findIndex((t) => t.id === normalizedTc.id)
          if (pendIdx !== -1) {
            if (normalizedTc.status !== 'pending_approval') {
              // Move from pending to executed
              const [moved] = state.pendingToolCalls.splice(pendIdx, 1)
              Object.assign(moved, normalizedTc)
              state.executedToolCalls.push(moved)
            } else {
              Object.assign(state.pendingToolCalls[pendIdx], normalizedTc)
            }
            trimToolCallArray(state.executedToolCalls)
            trimToolCallArray(state.pendingToolCalls)
            return
          }
          // New entry
          if (normalizedTc.status === 'pending_approval') {
            state.pendingToolCalls.push(normalizedTc)
          } else {
            state.executedToolCalls.push(normalizedTc)
          }
          trimToolCallArray(state.executedToolCalls)
          trimToolCallArray(state.pendingToolCalls)
        })
      },

      updateToolCall: (id, patch) => {
        set((state) => {
          const normalizedPatch = normalizeToolCallPatch(patch)
          const pending = state.pendingToolCalls.find((t) => t.id === id)
          if (pending) {
            Object.assign(pending, normalizedPatch)
            if (normalizedPatch.status && normalizedPatch.status !== 'pending_approval') {
              const idx = state.pendingToolCalls.findIndex((t) => t.id === id)
              if (idx !== -1) {
                const [moved] = state.pendingToolCalls.splice(idx, 1)
                state.executedToolCalls.push(moved)
              }
            }
            trimToolCallArray(state.executedToolCalls)
            trimToolCallArray(state.pendingToolCalls)
            return
          }
          const executed = state.executedToolCalls.find((t) => t.id === id)
          if (executed) {
            Object.assign(executed, normalizedPatch)
            trimToolCallArray(state.executedToolCalls)
          }
        })
      },

      addApprovedTool: (name) => {
        set((state) => {
          if (!state.approvedToolNames.includes(name)) {
            state.approvedToolNames.push(name)
          }
        })
      },

      registerForegroundShellExec: (toolUseId, execId) => {
        set((state) => {
          state.foregroundShellExecByToolUseId[toolUseId] = execId
        })
      },

      clearForegroundShellExec: (toolUseId) => {
        set((state) => {
          delete state.foregroundShellExecByToolUseId[toolUseId]
        })
      },

      abortForegroundShellExec: async (toolUseId) => {
        const execId = useAgentStore.getState().foregroundShellExecByToolUseId[toolUseId]
        if (!execId) return
        ipcClient.send(IPC.SHELL_ABORT, { execId })
        set((state) => {
          delete state.foregroundShellExecByToolUseId[toolUseId]
        })
      },

      initBackgroundProcessTracking: async () => {
        if (processTrackingInitialized) return
        processTrackingInitialized = true

        try {
          const list = (await ipcClient.invoke(IPC.PROCESS_LIST)) as ProcessListItem[]
          set((state) => {
            for (const item of list) {
              const existing = state.backgroundProcesses[item.id]
              state.backgroundProcesses[item.id] = {
                id: item.id,
                command: item.command ?? existing?.command ?? '',
                cwd: item.cwd ?? existing?.cwd,
                sessionId: item.metadata?.sessionId ?? existing?.sessionId,
                toolUseId: item.metadata?.toolUseId ?? existing?.toolUseId,
                description: item.metadata?.description ?? existing?.description,
                source: item.metadata?.source ?? existing?.source,
                status: item.running === false ? 'exited' : 'running',
                output: existing?.output ?? '',
                port: item.port ?? existing?.port,
                exitCode: item.exitCode ?? existing?.exitCode,
                createdAt: item.createdAt ?? existing?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
              }
            }
            trimBackgroundProcessMap(state.backgroundProcesses)
          })
        } catch (err) {
          console.error('[AgentStore] Failed to load process list:', err)
        }

        ipcClient.on(IPC.PROCESS_OUTPUT, (...args: unknown[]) => {
          const payload = args[0] as ProcessOutputEvent | undefined
          if (!payload?.id) return
          set((state) => {
            const existing = state.backgroundProcesses[payload.id]
            const now = Date.now()
            const next: BackgroundProcessState = existing
              ? { ...existing }
              : {
                  id: payload.id,
                  command: '',
                  cwd: undefined,
                  sessionId: payload.metadata?.sessionId,
                  toolUseId: payload.metadata?.toolUseId,
                  description: payload.metadata?.description,
                  source: payload.metadata?.source,
                  status: payload.exited ? 'exited' : 'running',
                  output: '',
                  port: payload.port,
                  exitCode: payload.exitCode,
                  createdAt: now,
                  updatedAt: now,
                }
            if (payload.data) {
              next.output = appendBackgroundOutput(next.output, payload.data)
            }
            if (payload.port) next.port = payload.port
            if (payload.metadata) {
              next.sessionId = payload.metadata.sessionId ?? next.sessionId
              next.toolUseId = payload.metadata.toolUseId ?? next.toolUseId
              next.description = payload.metadata.description ?? next.description
              next.source = payload.metadata.source ?? next.source
            }
            if (payload.exited) {
              next.status = next.status === 'stopped' ? 'stopped' : 'exited'
              next.exitCode = payload.exitCode
            }
            next.updatedAt = now
            state.backgroundProcesses[payload.id] = next
            trimBackgroundProcessMap(state.backgroundProcesses)
          })
        })
      },

      registerBackgroundProcess: (process) => {
        set((state) => {
          const now = Date.now()
          state.backgroundProcesses[process.id] = {
            id: process.id,
            command: process.command,
            cwd: process.cwd,
            sessionId: process.sessionId,
            toolUseId: process.toolUseId,
            description: process.description,
            source: process.source,
            status: 'running',
            output: state.backgroundProcesses[process.id]?.output ?? '',
            port: state.backgroundProcesses[process.id]?.port,
            exitCode: undefined,
            createdAt: state.backgroundProcesses[process.id]?.createdAt ?? now,
            updatedAt: now,
          }
          trimBackgroundProcessMap(state.backgroundProcesses)
        })
      },

      stopBackgroundProcess: async (id) => {
        set((state) => {
          const process = state.backgroundProcesses[id]
          if (!process) return
          process.updatedAt = Date.now()
          process.status = 'stopped'
          process.output = appendBackgroundOutput(process.output, '\n[Stopping process...]\n')
        })

        const result = (await ipcClient.invoke(IPC.PROCESS_KILL, { id })) as {
          success?: boolean
          error?: string
        }

        set((state) => {
          const process = state.backgroundProcesses[id]
          if (!process) return
          process.updatedAt = Date.now()
          if (result?.success) {
            process.output = appendBackgroundOutput(process.output, '[Stopped by user]\n')
            return
          }
          if (result?.error && result.error.includes('Process not found')) {
            process.output = appendBackgroundOutput(process.output, '[Process already exited]\n')
            return
          }
          process.status = 'error'
          process.output = appendBackgroundOutput(
            process.output,
            `[Stop failed: ${result?.error ?? 'Unknown error'}]\n`
          )
        })
      },

      sendBackgroundProcessInput: async (id, input, appendNewline = true) => {
        const result = (await ipcClient.invoke(IPC.PROCESS_WRITE, {
          id,
          input,
          appendNewline,
        })) as { success?: boolean; error?: string }
        set((state) => {
          const process = state.backgroundProcesses[id]
          if (!process) return
          process.updatedAt = Date.now()
          if (result?.success) {
            const displayInput = input === '\u0003' ? '^C' : input
            process.output = appendBackgroundOutput(process.output, `\n$ ${displayInput}\n`)
            return
          }
          process.status = 'error'
          process.output = appendBackgroundOutput(
            process.output,
            `\n[Input failed: ${result?.error ?? 'Unknown error'}]\n`
          )
        })
      },

      removeBackgroundProcess: (id) => {
        set((state) => {
          delete state.backgroundProcesses[id]
        })
      },

      clearToolCalls: () => {
        set((state) => {
          // Move completed SubAgents to history before clearing
          const completed = Object.values(state.completedSubAgents)
          if (completed.length > 0) {
            state.subAgentHistory.push(...completed)
            trimSubAgentHistory(state.subAgentHistory)
          }
          state.pendingToolCalls = []
          state.executedToolCalls = []
          state.activeSubAgents = {}
          state.completedSubAgents = {}
          state.approvedToolNames = []
          state.foregroundShellExecByToolUseId = {}
        })
      },

      handleSubAgentEvent: (event, sessionId) => {
        set((state) => {
          const id = event.toolUseId
          switch (event.type) {
            case 'sub_agent_start':
              state.activeSubAgents[id] = {
                name: event.subAgentName,
                toolUseId: id,
                sessionId,
                isRunning: true,
                iteration: 0,
                toolCalls: [],
                streamingText: '',
                startedAt: Date.now(),
                completedAt: null,
              }
              break
            case 'sub_agent_iteration': {
              const sa = state.activeSubAgents[id]
              if (sa) sa.iteration = event.iteration
              break
            }
            case 'sub_agent_tool_call': {
              const sa = state.activeSubAgents[id]
              if (sa) {
                const normalizedToolCall = normalizeToolCall(event.toolCall)
                const existing = sa.toolCalls.find((t) => t.id === normalizedToolCall.id)
                if (existing) {
                  Object.assign(existing, normalizedToolCall)
                } else {
                  sa.toolCalls.push(normalizedToolCall)
                }
                if (sa.toolCalls.length > MAX_TRACKED_SUBAGENT_TOOL_CALLS) {
                  sa.toolCalls.splice(0, sa.toolCalls.length - MAX_TRACKED_SUBAGENT_TOOL_CALLS)
                }
              }
              break
            }
            case 'sub_agent_text_delta': {
              const sa = state.activeSubAgents[id]
              if (sa) {
                sa.streamingText = truncateText(sa.streamingText + event.text, MAX_STREAMING_TEXT_CHARS)
              }
              break
            }
            case 'sub_agent_end': {
              const sa = state.activeSubAgents[id]
              if (sa) {
                sa.isRunning = false
                sa.completedAt = Date.now()
                state.completedSubAgents[id] = sa
                trimCompletedSubAgentsMap(state.completedSubAgents)
                delete state.activeSubAgents[id]
              }
              break
            }
          }
        })
      },

      abort: () => {
        set({ isRunning: false, currentLoopId: null })
        for (const [, resolve] of approvalResolvers) {
          resolve(false)
        }
        approvalResolvers.clear()
      },

      requestApproval: (toolCallId) => {
        return new Promise<boolean>((resolve) => {
          approvalResolvers.set(toolCallId, resolve)
        })
      },

      clearSessionData: (sessionId) => {
        const processIdsToKill: string[] = []
        set((state) => {
          // Remove active subagents belonging to the session
          for (const [key, sa] of Object.entries(state.activeSubAgents)) {
            if (sa.sessionId === sessionId) delete state.activeSubAgents[key]
          }
          // Remove completed subagents belonging to the session
          for (const [key, sa] of Object.entries(state.completedSubAgents)) {
            if (sa.sessionId === sessionId) delete state.completedSubAgents[key]
          }
          // Remove history entries belonging to the session
          state.subAgentHistory = state.subAgentHistory.filter((sa) => sa.sessionId !== sessionId)
          trimSubAgentHistory(state.subAgentHistory)

          // Remove cached tool calls for this session
          delete state.sessionToolCallsCache[sessionId]

          // Remove background processes bound to this session
          for (const [key, process] of Object.entries(state.backgroundProcesses)) {
            if (process.sessionId === sessionId) {
              processIdsToKill.push(key)
              delete state.backgroundProcesses[key]
            }
          }
        })
        for (const id of processIdsToKill) {
          ipcClient.invoke(IPC.PROCESS_KILL, { id }).catch(() => {})
        }
      },

      clearPendingApprovals: () => {
        // Resolve all pending approval promises as denied
        for (const [, resolve] of approvalResolvers) {
          resolve(false)
        }
        approvalResolvers.clear()
        // Move all pending tool calls to executed
        set((state) => {
          for (const tc of state.pendingToolCalls) {
            tc.status = 'error'
            tc.error = 'Aborted (team deleted)'
            state.executedToolCalls.push(normalizeToolCall(tc))
          }
          state.pendingToolCalls = []
          trimToolCallArray(state.executedToolCalls)
        })
      },

      resolveApproval: (toolCallId, approved) => {
        const resolve = approvalResolvers.get(toolCallId)
        if (resolve) {
          resolve(approved)
          approvalResolvers.delete(toolCallId)
        }
        // Move tool call from pending to executed so the dialog advances
        // to the next pending item. Without this, teammate tool calls
        // stay in pendingToolCalls and block subsequent approvals.
        set((state) => {
          const idx = state.pendingToolCalls.findIndex((t) => t.id === toolCallId)
          if (idx !== -1) {
            const [moved] = state.pendingToolCalls.splice(idx, 1)
            moved.status = approved ? 'running' : 'error'
            if (!approved) moved.error = 'User denied permission'
            state.executedToolCalls.push(normalizeToolCall(moved))
            trimToolCallArray(state.executedToolCalls)
          }
        })
      },
    })),
    {
      name: 'opencowork-agent',
      storage: createJSONStorage(() => ipcStorage),
      partialize: (state) => ({
        completedSubAgents: state.completedSubAgents,
        subAgentHistory: state.subAgentHistory,
      }),
    }
  )
)
