import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { nanoid } from 'nanoid'
import { ipcClient } from '../lib/ipc/ipc-client'

// --- Types ---

export type PlanStatus = 'drafting' | 'approved' | 'implementing' | 'completed' | 'rejected'

export interface Plan {
  id: string
  sessionId: string
  title: string
  status: PlanStatus
  filePath?: string
  content?: string
  specJson?: string
  createdAt: number
  updatedAt: number
}

// --- DB persistence helpers (fire-and-forget) ---

function dbCreatePlan(plan: Plan): void {
  ipcClient.invoke('db:plans:create', {
    id: plan.id,
    sessionId: plan.sessionId,
    title: plan.title,
    status: plan.status,
    filePath: plan.filePath,
    content: plan.content ?? null,
    specJson: plan.specJson ?? null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  }).catch(() => {})
}

function dbUpdatePlan(id: string, patch: Record<string, unknown>): void {
  ipcClient.invoke('db:plans:update', { id, patch }).catch(() => {})
}

function dbDeletePlan(id: string): void {
  ipcClient.invoke('db:plans:delete', id).catch(() => {})
}

// --- Row → Plan conversion ---

interface PlanRow {
  id: string
  session_id: string
  title: string
  status: string
  file_path: string | null
  content: string | null
  spec_json: string | null
  created_at: number
  updated_at: number
}

function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    status: row.status as PlanStatus,
    filePath: row.file_path ?? undefined,
    content: row.content ?? undefined,
    specJson: row.spec_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// --- Store ---

interface PlanStore {
  plans: Record<string, Plan>
  activePlanId: string | null
  _loaded: boolean

  // Initialization
  loadPlansFromDb: () => Promise<void>

  // CRUD
  createPlan: (
    sessionId: string,
    title: string,
    options?: Partial<Pick<Plan, 'status' | 'filePath' | 'content' | 'specJson'>>
  ) => Plan
  updatePlan: (planId: string, patch: Partial<Omit<Plan, 'id' | 'sessionId' | 'createdAt'>>) => void
  approvePlan: (planId: string) => void
  rejectPlan: (planId: string) => void
  startImplementing: (planId: string) => void
  completePlan: (planId: string) => void
  deletePlan: (planId: string) => void

  // Queries
  getPlanBySession: (sessionId: string) => Plan | undefined
  getActivePlan: () => Plan | undefined

  // Active plan
  setActivePlan: (planId: string | null) => void
}

export const usePlanStore = create<PlanStore>()(
  immer((set, get) => ({
    plans: {},
    activePlanId: null,
    _loaded: false,

    loadPlansFromDb: async () => {
      try {
        const rows = (await ipcClient.invoke('db:plans:list')) as PlanRow[]
        const plans: Record<string, Plan> = {}
        for (const row of rows) {
          plans[row.id] = rowToPlan(row)
        }
        set((state) => {
          state.plans = plans
          state._loaded = true
        })
      } catch (err) {
        console.error('[PlanStore] Failed to load from DB:', err)
        set({ _loaded: true })
      }
    },

    createPlan: (sessionId, title, options = {}) => {
      const id = nanoid()
      const now = Date.now()
      const plan: Plan = {
        id,
        sessionId,
        title,
        status: options.status ?? 'drafting',
        filePath: options.filePath,
        content: options.content,
        specJson: options.specJson,
        createdAt: now,
        updatedAt: now,
      }
      set((state) => {
        state.plans[id] = plan
        state.activePlanId = id
      })
      dbCreatePlan(plan)
      return plan
    },

    updatePlan: (planId, patch) => {
      const now = Date.now()
      set((state) => {
        const plan = state.plans[planId]
        if (plan) {
          Object.assign(plan, patch, { updatedAt: now })
        }
      })
      const dbPatch: Record<string, unknown> = { updatedAt: now }
      if (patch.title !== undefined) dbPatch.title = patch.title
      if (patch.status !== undefined) dbPatch.status = patch.status
      if (patch.filePath !== undefined) dbPatch.filePath = patch.filePath
      if (patch.content !== undefined) dbPatch.content = patch.content
      if (patch.specJson !== undefined) dbPatch.specJson = patch.specJson
      dbUpdatePlan(planId, dbPatch)
    },

    approvePlan: (planId) => {
      const now = Date.now()
      set((state) => {
        const plan = state.plans[planId]
        if (plan) {
          plan.status = 'approved'
          plan.updatedAt = now
        }
      })
      dbUpdatePlan(planId, { status: 'approved', updatedAt: now })
    },

    rejectPlan: (planId) => {
      const now = Date.now()
      set((state) => {
        const plan = state.plans[planId]
        if (plan) {
          plan.status = 'rejected'
          plan.updatedAt = now
        }
      })
      dbUpdatePlan(planId, { status: 'rejected', updatedAt: now })
    },

    startImplementing: (planId) => {
      const now = Date.now()
      set((state) => {
        const plan = state.plans[planId]
        if (plan) {
          plan.status = 'implementing'
          plan.updatedAt = now
        }
      })
      dbUpdatePlan(planId, { status: 'implementing', updatedAt: now })
    },

    completePlan: (planId) => {
      const now = Date.now()
      set((state) => {
        const plan = state.plans[planId]
        if (plan) {
          plan.status = 'completed'
          plan.updatedAt = now
        }
      })
      dbUpdatePlan(planId, { status: 'completed', updatedAt: now })
    },

    deletePlan: (planId) => {
      set((state) => {
        delete state.plans[planId]
        if (state.activePlanId === planId) {
          state.activePlanId = null
        }
      })
      dbDeletePlan(planId)
    },

    getPlanBySession: (sessionId) => {
      return Object.values(get().plans).find((p) => p.sessionId === sessionId)
    },

    getActivePlan: () => {
      const { plans, activePlanId } = get()
      return activePlanId ? plans[activePlanId] : undefined
    },

    setActivePlan: (planId) => set({ activePlanId: planId }),
  }))
)
