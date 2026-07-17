import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AssistantActionKind =
  | 'read_canvas'
  | 'create_text_node'
  | 'connect_nodes'
  | 'generate_image'

export interface AssistantAction {
  kind: AssistantActionKind
  ok: boolean
}

export interface AssistantTurn {
  role: 'user' | 'assistant'
  text: string
  /** Canvas operations the agent performed while producing this turn (display only). */
  actions?: AssistantAction[]
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
  appendTurn: (projectId: string, turn: AssistantTurn) => void
  clearSession: (projectId: string) => void
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
            [projectId]: [...(s.sessions[projectId] ?? []), turn].slice(-MAX_TURNS_PER_PROJECT)
          }
        })),
      clearSession: (projectId) =>
        set((s) => {
          const { [projectId]: _dropped, ...rest } = s.sessions
          return { sessions: rest }
        })
    }),
    {
      name: 'open-cowork.draw.assistant',
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
