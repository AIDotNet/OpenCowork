import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export interface PetExpLogEntry {
  id: string
  at: number
  model: string
  tokens: number
  premium: boolean
  exp: number
}

interface PetExpStore {
  totalExp: number
  /** Cumulative tokens the pet has "eaten". */
  totalTokens: number
  log: PetExpLogEntry[]
}

/**
 * Read-only mirror of the pet experience ledger. The main process owns all
 * writes (see pet-handlers 'pet:exp-add') so concurrent windows can't clobber
 * each other; every window just rehydrates on the broadcast below.
 */
export const usePetExpStore = create<PetExpStore>()(
  persist(
    () => ({
      totalExp: 0,
      totalTokens: 0,
      log: [] as PetExpLogEntry[]
    }),
    {
      name: 'opencowork-pet-exp',
      storage: createJSONStorage(() => ipcStorage)
    }
  )
)

ipcClient.on('pet:sync-event', (payload) => {
  if ((payload as { kind?: string } | null)?.kind === 'exp') {
    void usePetExpStore.persist.rehydrate()
  }
})
