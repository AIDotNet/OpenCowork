import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export interface SkillInfo {
  name: string
  description: string
}

interface SkillsStore {
  skills: SkillInfo[]
  loading: boolean
  /** Fetch available skills from ~/.open-cowork/skills/ via IPC */
  loadSkills: () => Promise<void>
}

export const useSkillsStore = create<SkillsStore>((set) => ({
  skills: [],
  loading: false,

  loadSkills: async () => {
    set({ loading: true })
    try {
      const result = await ipcClient.invoke('skills:list') as SkillInfo[]
      set({ skills: Array.isArray(result) ? result : [] })
    } catch {
      set({ skills: [] })
    } finally {
      set({ loading: false })
    }
  },
}))
