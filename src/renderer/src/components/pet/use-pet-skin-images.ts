import { useEffect, useState } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { usePetSkinStore } from '@renderer/stores/pet-skin-store'
import type { PetPoseKey } from '@renderer/lib/pet/pet-pose-prompts'

const dataUrlCache = new Map<string, string>()

export async function loadPetImageDataUrl(filePath: string): Promise<string | null> {
  const cached = dataUrlCache.get(filePath)
  if (cached) return cached
  try {
    const result = (await ipcClient.invoke('fs:read-file-binary', { path: filePath })) as {
      data?: string
      error?: string
    } | null
    if (!result?.data) return null
    const url = `data:image/png;base64,${result.data}`
    dataUrlCache.set(filePath, url)
    return url
  } catch {
    return null
  }
}

/**
 * Resolves the active pet skin's pose images to data URLs.
 * Returns null when the bundled default skin is active.
 */
export function usePetSkinImages(): Partial<Record<PetPoseKey, string>> | null {
  const skins = usePetSkinStore((s) => s.skins)
  const activeSkinId = usePetSkinStore((s) => s.activeSkinId)
  const [images, setImages] = useState<Partial<Record<PetPoseKey, string>> | null>(null)

  // First consumer in a window triggers the disk scan of ~/.open-cowork/pets.
  useEffect(() => {
    if (usePetSkinStore.getState().petsDir === null) {
      void usePetSkinStore.getState().scan()
    }
  }, [])

  useEffect(() => {
    const skin = activeSkinId ? skins.find((entry) => entry.id === activeSkinId) : null
    if (!skin) {
      setImages(null)
      return
    }

    let disposed = false
    void (async () => {
      const entries = await Promise.all(
        Object.entries(skin.poses).map(async ([pose, filePath]) => {
          if (!filePath) return null
          const url = await loadPetImageDataUrl(filePath)
          return url ? ([pose as PetPoseKey, url] as const) : null
        })
      )
      if (disposed) return
      const resolved: Partial<Record<PetPoseKey, string>> = {}
      for (const entry of entries) {
        if (entry) resolved[entry[0]] = entry[1]
      }
      setImages(Object.keys(resolved).length > 0 ? resolved : null)
    })()

    return () => {
      disposed = true
    }
  }, [skins, activeSkinId])

  return images
}
