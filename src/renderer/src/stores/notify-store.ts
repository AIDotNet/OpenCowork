import { create } from 'zustand'
import { nanoid } from 'nanoid'

export type NotifyType = 'info' | 'success' | 'warning' | 'error'

export interface NotifyAction {
  label: string
  onClick: () => void
}

export interface NotifyItem {
  id: string
  title: string
  body: string
  type: NotifyType
  duration: number
  createdAt: number
  /** If true, notification won't auto-dismiss — user must close manually */
  persistent?: boolean
  /** Optional action buttons rendered at the bottom of the toast */
  actions?: NotifyAction[]
}

export interface NotifyOptions {
  type?: NotifyType
  duration?: number
  persistent?: boolean
  actions?: NotifyAction[]
}

interface NotifyStore {
  items: NotifyItem[]
  push: (title: string, body: string, typeOrOpts?: NotifyType | NotifyOptions, duration?: number) => void
  dismiss: (id: string) => void
}

export const useNotifyStore = create<NotifyStore>((set) => ({
  items: [],
  push: (title, body, typeOrOpts?: NotifyType | NotifyOptions, duration?: number) => {
    let type: NotifyType = 'info'
    let dur = duration ?? 5000
    let persistent = false
    let actions: NotifyAction[] | undefined

    if (typeof typeOrOpts === 'object' && typeOrOpts !== null) {
      type = typeOrOpts.type ?? 'info'
      dur = typeOrOpts.duration ?? dur
      persistent = typeOrOpts.persistent ?? false
      actions = typeOrOpts.actions
    } else if (typeof typeOrOpts === 'string') {
      type = typeOrOpts
    }

    const item: NotifyItem = {
      id: nanoid(6),
      title,
      body,
      type,
      duration: dur,
      createdAt: Date.now(),
      persistent,
      actions,
    }
    set((s) => ({ items: [...s.items, item] }))
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}))
