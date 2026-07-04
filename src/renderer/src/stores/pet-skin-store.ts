import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { PET_POSE_KEYS, type PetPoseKey } from '@renderer/lib/pet/pet-pose-prompts'

export interface PetSkin {
  /** Directory name under ~/.open-cowork/pets — doubles as the skin id. */
  id: string
  name: string
  path: string
  subject?: string
  modelId?: string
  createdAt?: number
  /** pose -> absolute file path of `<pose>.png` inside the skin directory */
  poses: Partial<Record<PetPoseKey, string>>
}

interface DirEntry {
  name: string
  path: string
  type: 'directory' | 'file'
}

interface PetSkinStore {
  /** Scanned from disk; not persisted. */
  skins: PetSkin[]
  activeSkinId: string | null
  scanning: boolean
  petsDir: string | null
  scan: () => Promise<void>
  setActiveSkin: (id: string | null) => void
}

let cachedPetsDir: string | null = null

/** ~/.open-cowork/pets — one subdirectory per pet skin. */
export async function getPetsDir(): Promise<string> {
  if (cachedPetsDir) return cachedPetsDir
  const home = String(await ipcClient.invoke('app:homedir'))
  cachedPetsDir = `${home}/.open-cowork/pets`
  return cachedPetsDir
}

async function listDir(path: string): Promise<DirEntry[]> {
  const result = await ipcClient.invoke('fs:list-dir', { path, limit: 300 })
  return Array.isArray(result) ? (result as DirEntry[]) : []
}

async function readSkinMeta(path: string): Promise<Record<string, unknown>> {
  try {
    const doc = (await ipcClient.invoke('fs:read-document', { path })) as {
      content?: string
    } | null
    const parsed: unknown = doc?.content ? JSON.parse(doc.content) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function scanSkinDirectory(entry: DirEntry): Promise<PetSkin | null> {
  const files = await listDir(entry.path)
  const poses: Partial<Record<PetPoseKey, string>> = {}
  for (const pose of PET_POSE_KEYS) {
    const file = files.find(
      (item) => item.type === 'file' && item.name.toLowerCase() === `${pose}.png`
    )
    if (file) poses[pose] = file.path
  }
  if (Object.keys(poses).length === 0) return null

  const metaFile = files.find((item) => item.type === 'file' && item.name === 'pet.json')
  const meta = metaFile ? await readSkinMeta(metaFile.path) : {}
  return {
    id: entry.name,
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name : entry.name,
    path: entry.path,
    subject: typeof meta.subject === 'string' ? meta.subject : undefined,
    modelId: typeof meta.modelId === 'string' ? meta.modelId : undefined,
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : undefined,
    poses
  }
}

export const usePetSkinStore = create<PetSkinStore>()(
  persist(
    (set, get) => ({
      skins: [],
      activeSkinId: null,
      scanning: false,
      petsDir: null,

      scan: async () => {
        if (get().scanning) return
        set({ scanning: true })
        try {
          const dir = await getPetsDir()
          await ipcClient.invoke('fs:mkdir', { path: dir })
          const entries = await listDir(dir)
          const skins: PetSkin[] = []
          for (const entry of entries.filter((item) => item.type === 'directory')) {
            const skin = await scanSkinDirectory(entry)
            if (skin) skins.push(skin)
          }
          skins.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id))
          const activeSkinId = get().activeSkinId
          set({
            skins,
            petsDir: dir,
            activeSkinId:
              activeSkinId && skins.some((skin) => skin.id === activeSkinId) ? activeSkinId : null
          })
        } catch (error) {
          console.error('[Pet] skin scan failed:', error)
        } finally {
          set({ scanning: false })
        }
      },

      setActiveSkin: (id) => set({ activeSkinId: id })
    }),
    {
      name: 'opencowork-pet-skins',
      storage: createJSONStorage(() => ipcStorage),
      version: 1,
      migrate: (state) => ({
        activeSkinId:
          state && typeof state === 'object'
            ? ((state as { activeSkinId?: string | null }).activeSkinId ?? null)
            : null
      }),
      partialize: (state) => ({ activeSkinId: state.activeSkinId })
    }
  )
)
