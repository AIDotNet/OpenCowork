import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { ToolCallState } from '../lib/agent/types'
import type { SubAgentEvent } from '../lib/agent/sub-agents/types'

// Approval resolvers live outside the store — they hold non-serializable
// callbacks and don't need to trigger React re-renders.
const approvalResolvers = new Map<string, (approved: boolean) => void>()

interface SubAgentState {
  name: string
  isRunning: boolean
  iteration: number
  toolCalls: ToolCallState[]
  streamingText: string
  startedAt: number
  completedAt: number | null
}

export type { SubAgentState }

interface AgentStore {
  isRunning: boolean
  currentLoopId: string | null
  pendingToolCalls: ToolCallState[]
  executedToolCalls: ToolCallState[]

  // SubAgent state
  activeSubAgent: SubAgentState | null
  /** Completed SubAgent results keyed by name — survives until clearToolCalls */
  completedSubAgents: Record<string, SubAgentState>

  /** Tool names approved by user during this session — auto-approve on repeat */
  approvedToolNames: string[]
  addApprovedTool: (name: string) => void

  setRunning: (running: boolean) => void
  setCurrentLoopId: (id: string | null) => void
  addToolCall: (tc: ToolCallState) => void
  updateToolCall: (id: string, patch: Partial<ToolCallState>) => void
  clearToolCalls: () => void
  abort: () => void

  // SubAgent events
  handleSubAgentEvent: (event: SubAgentEvent) => void

  // Approval flow
  requestApproval: (toolCallId: string) => Promise<boolean>
  resolveApproval: (toolCallId: string, approved: boolean) => void
}

export const useAgentStore = create<AgentStore>()(
  immer((set) => ({
    isRunning: false,
    currentLoopId: null,
    pendingToolCalls: [],
    executedToolCalls: [],
    activeSubAgent: null,
    completedSubAgents: {},
    approvedToolNames: [],

    setRunning: (running) => set({ isRunning: running }),

    setCurrentLoopId: (id) => set({ currentLoopId: id }),

    addToolCall: (tc) => {
      set((state) => {
        if (tc.status === 'pending_approval') {
          state.pendingToolCalls.push(tc)
        } else {
          state.executedToolCalls.push(tc)
        }
      })
    },

    updateToolCall: (id, patch) => {
      set((state) => {
        const pending = state.pendingToolCalls.find((t) => t.id === id)
        if (pending) {
          Object.assign(pending, patch)
          if (patch.status && patch.status !== 'pending_approval') {
            const idx = state.pendingToolCalls.findIndex((t) => t.id === id)
            if (idx !== -1) {
              const [moved] = state.pendingToolCalls.splice(idx, 1)
              state.executedToolCalls.push(moved)
            }
          }
          return
        }
        const executed = state.executedToolCalls.find((t) => t.id === id)
        if (executed) Object.assign(executed, patch)
      })
    },

    addApprovedTool: (name) => {
      set((state) => {
        if (!state.approvedToolNames.includes(name)) {
          state.approvedToolNames.push(name)
        }
      })
    },

    clearToolCalls: () =>
      set({ pendingToolCalls: [], executedToolCalls: [], activeSubAgent: null, completedSubAgents: {}, approvedToolNames: [] }),

    handleSubAgentEvent: (event) => {
      set((state) => {
        switch (event.type) {
          case 'sub_agent_start':
            // Archive previous SubAgent if it exists
            if (state.activeSubAgent && !state.activeSubAgent.isRunning) {
              state.completedSubAgents[state.activeSubAgent.name] = state.activeSubAgent
            }
            state.activeSubAgent = {
              name: event.subAgentName,
              isRunning: true,
              iteration: 0,
              toolCalls: [],
              streamingText: '',
              startedAt: Date.now(),
              completedAt: null,
            }
            break
          case 'sub_agent_iteration':
            if (state.activeSubAgent) {
              state.activeSubAgent.iteration = event.iteration
            }
            break
          case 'sub_agent_tool_call':
            if (state.activeSubAgent) {
              const existing = state.activeSubAgent.toolCalls.find((t) => t.id === event.toolCall.id)
              if (existing) {
                Object.assign(existing, event.toolCall)
              } else {
                state.activeSubAgent.toolCalls.push(event.toolCall)
              }
            }
            break
          case 'sub_agent_text_delta':
            if (state.activeSubAgent) {
              state.activeSubAgent.streamingText += event.text
            }
            break
          case 'sub_agent_end':
            if (state.activeSubAgent) {
              state.activeSubAgent.isRunning = false
              state.activeSubAgent.completedAt = Date.now()
              // Also archive to completedSubAgents immediately
              state.completedSubAgents[state.activeSubAgent.name] = state.activeSubAgent
            }
            break
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

    resolveApproval: (toolCallId, approved) => {
      const resolve = approvalResolvers.get(toolCallId)
      if (resolve) {
        resolve(approved)
        approvalResolvers.delete(toolCallId)
      }
    },
  }))
)
