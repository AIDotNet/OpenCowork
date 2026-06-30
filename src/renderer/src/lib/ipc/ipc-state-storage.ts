import type { StateStorage } from 'zustand/middleware'
import { ipcClient } from './ipc-client'

type IpcStateStorageOptions = {
  getChannel: string
  setChannel: string
}

function serializeStorageValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function parseStorageValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function createIpcStateStorage({
  getChannel,
  setChannel
}: IpcStateStorageOptions): StateStorage {
  // Zustand persist calls setItem after every store mutation, even when
  // partialized data is unchanged. Keep that churn at the renderer boundary.
  const serializedValueCache = new Map<string, string>()
  const writeQueues = new Map<string, Promise<void>>()

  const enqueueWrite = (name: string, task: () => Promise<void>): Promise<void> => {
    const previous = writeQueues.get(name) ?? Promise.resolve()
    const queued = previous.catch(() => {}).then(task)
    const tracked = queued.finally(() => {
      if (writeQueues.get(name) === tracked) {
        writeQueues.delete(name)
      }
    })
    writeQueues.set(name, tracked)
    return tracked
  }

  return {
    getItem: async (name: string): Promise<string | null> => {
      try {
        const value = await ipcClient.invoke(getChannel, name)
        const serialized = serializeStorageValue(value)
        if (serialized === null) {
          serializedValueCache.delete(name)
          return null
        }
        serializedValueCache.set(name, serialized)
        return serialized
      } catch {
        return null
      }
    },

    setItem: async (name: string, value: string): Promise<void> => {
      if (serializedValueCache.get(name) === value) return

      serializedValueCache.set(name, value)
      const parsed = parseStorageValue(value)

      try {
        await enqueueWrite(name, async () => {
          await ipcClient.invoke(setChannel, { key: name, value: parsed })
        })
      } catch {
        if (serializedValueCache.get(name) === value) {
          serializedValueCache.delete(name)
        }
      }
    },

    removeItem: async (name: string): Promise<void> => {
      serializedValueCache.delete(name)
      try {
        await enqueueWrite(name, async () => {
          await ipcClient.invoke(setChannel, { key: name, value: undefined })
        })
      } catch {
        // Silently fail — main process logs the error.
      }
    }
  }
}
