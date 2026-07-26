import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { nanoid } from 'nanoid'

export type AssistantActionKind = string

export interface AssistantAction {
  kind: AssistantActionKind
  ok: boolean
  /** Bounded structured tool result retained for conversational follow-up. */
  result?: unknown
}

export type AssistantTimelineBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool'
      kind: AssistantActionKind
      nodeId?: string
      subscriptionId?: string
      startedAt: number
      finishedAt?: number
      action?: AssistantAction
    }

export interface AssistantTurn {
  id: string
  createdAt: number
  role: 'user' | 'assistant'
  text: string
  /** Canvas operations the agent performed while producing this turn (display only). */
  actions?: AssistantAction[]
  /** Ordered display events. Older persisted turns fall back to text/actions. */
  timeline?: AssistantTimelineBlock[]
  contextNodeIds?: string[]
  attachmentCount?: number
  attachmentRefs?: Array<{ attachmentId: string; nodeId: string }>
}

export type AssistantTurnInput = Omit<AssistantTurn, 'id' | 'createdAt'> & {
  id?: string
  createdAt?: number
}

interface PanelPosition {
  x: number
  y: number
}

interface PanelSize {
  w: number
  h: number
}

const MAX_TURNS_PER_PROJECT = 80

export const ASSISTANT_DEFAULT_SIZE: PanelSize = { w: 330, h: 480 }
export const ASSISTANT_MIN_SIZE: PanelSize = { w: 300, h: 340 }

interface AssistantState {
  open: boolean
  collapsed: boolean
  /** Top-left offset inside the canvas container; null = default top-right anchor. */
  position: PanelPosition | null
  size: PanelSize
  /** Explicit chat model override; null falls back to the global active chat model. */
  providerId: string | null
  modelId: string | null
  /** Node ids pinned as conversation context. */
  contextIds: string[]
  /** Conversation turns keyed by canvas project id. */
  sessions: Record<string, AssistantTurn[]>
  setOpen: (open: boolean) => void
  toggle: () => void
  setCollapsed: (collapsed: boolean) => void
  setPosition: (position: PanelPosition | null) => void
  setSize: (size: PanelSize) => void
  setModel: (providerId: string | null, modelId: string | null) => void
  addContext: (ids: string[]) => void
  removeContext: (id: string) => void
  clearContext: () => void
  /** Drop context ids whose nodes no longer exist on the canvas. */
  pruneContext: (validIds: string[]) => void
  appendTurn: (projectId: string, turn: AssistantTurnInput) => void
  truncateFromTurn: (projectId: string, turnId: string) => void
  deleteTurn: (projectId: string, turnId: string) => void
  clearSession: (projectId: string) => void
}

function normalizeTurn(turn: AssistantTurnInput): AssistantTurn {
  return {
    ...turn,
    id: turn.id || nanoid(),
    createdAt: turn.createdAt ?? Date.now()
  }
}

function migrateAssistantState(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const state = value as { sessions?: Record<string, AssistantTurnInput[]> }
  if (!state.sessions || typeof state.sessions !== 'object') return value
  return {
    ...state,
    sessions: Object.fromEntries(
      Object.entries(state.sessions).map(([projectId, turns]) => [
        projectId,
        Array.isArray(turns) ? turns.map(normalizeTurn) : []
      ])
    )
  }
}

export const useAssistantStore = create<AssistantState>()(
  persist(
    (set) => ({
      open: false,
      collapsed: false,
      position: null,
      size: ASSISTANT_DEFAULT_SIZE,
      providerId: null,
      modelId: null,
      contextIds: [],
      sessions: {},
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
      setCollapsed: (collapsed) => set({ collapsed }),
      setPosition: (position) => set({ position }),
      setSize: (size) => set({ size }),
      setModel: (providerId, modelId) => set({ providerId, modelId }),
      addContext: (ids) =>
        set((s) => ({
          contextIds: [...s.contextIds, ...ids.filter((id) => !s.contextIds.includes(id))]
        })),
      removeContext: (id) => set((s) => ({ contextIds: s.contextIds.filter((c) => c !== id) })),
      clearContext: () => set({ contextIds: [] }),
      pruneContext: (validIds) =>
        set((s) => {
          const valid = new Set(validIds)
          const kept = s.contextIds.filter((id) => valid.has(id))
          return kept.length === s.contextIds.length ? s : { contextIds: kept }
        }),
      appendTurn: (projectId, turn) =>
        set((s) => ({
          sessions: {
            ...s.sessions,
            [projectId]: [...(s.sessions[projectId] ?? []), normalizeTurn(turn)].slice(
              -MAX_TURNS_PER_PROJECT
            )
          }
        })),
      truncateFromTurn: (projectId, turnId) =>
        set((s) => {
          const turns = s.sessions[projectId] ?? []
          const index = turns.findIndex((turn) => turn.id === turnId)
          if (index < 0) return s
          return { sessions: { ...s.sessions, [projectId]: turns.slice(0, index) } }
        }),
      deleteTurn: (projectId, turnId) =>
        set((s) => {
          const turns = s.sessions[projectId] ?? []
          const index = turns.findIndex((turn) => turn.id === turnId)
          if (index < 0) return s
          const turn = turns[index]
          if (turn.role === 'assistant') {
            return {
              sessions: {
                ...s.sessions,
                [projectId]: turns.filter((candidate) => candidate.id !== turnId)
              }
            }
          }
          const nextUserOffset = turns
            .slice(index + 1)
            .findIndex((candidate) => candidate.role === 'user')
          const end = nextUserOffset < 0 ? turns.length : index + 1 + nextUserOffset
          return {
            sessions: {
              ...s.sessions,
              [projectId]: [...turns.slice(0, index), ...turns.slice(end)]
            }
          }
        }),
      clearSession: (projectId) =>
        set((s) => {
          const { [projectId]: _dropped, ...rest } = s.sessions
          return { sessions: rest }
        })
    }),
    {
      name: 'open-cowork.draw.assistant',
      version: 1,
      migrate: migrateAssistantState,
      partialize: (s) => ({
        collapsed: s.collapsed,
        position: s.position,
        size: s.size,
        providerId: s.providerId,
        modelId: s.modelId,
        contextIds: s.contextIds,
        sessions: s.sessions
      })
    }
  )
)
