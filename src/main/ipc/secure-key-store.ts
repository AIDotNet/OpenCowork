import { getNativeWorker } from '../lib/native-worker'
import { registerMessagePackHandler } from './messagepack-handler'

const CONFIG_TIMEOUT_MS = 60_000

type MutationResult = {
  success: boolean
  error?: string
}

export async function readConfig(): Promise<Record<string, unknown>> {
  try {
    return await getNativeWorker().request<Record<string, unknown>>(
      'config/read',
      {},
      CONFIG_TIMEOUT_MS
    )
  } catch (err) {
    console.error('[ConfigStore] Read error:', err)
    return {}
  }
}

export async function writeConfig(config: Record<string, unknown>): Promise<void> {
  const result = await getNativeWorker().request<MutationResult>(
    'config/write',
    config,
    CONFIG_TIMEOUT_MS
  )
  if (!result.success) {
    throw new Error(result.error ?? 'Config write failed')
  }
}

export async function getConfigValue(key?: string): Promise<unknown> {
  return await getNativeWorker().request('config/get', key ?? {}, CONFIG_TIMEOUT_MS)
}

export async function setConfigValue(key: string, value: unknown): Promise<MutationResult> {
  return await getNativeWorker().request('config/set', { key, value }, CONFIG_TIMEOUT_MS)
}

export async function deleteConfigValue(key: string): Promise<MutationResult> {
  return await getNativeWorker().request('config/delete', key, CONFIG_TIMEOUT_MS)
}

export function registerConfigHandlers(): void {
  registerMessagePackHandler<string | undefined>('config:get', async (key) => {
    return await getConfigValue(key)
  })

  registerMessagePackHandler<{ key: string; value: unknown }>('config:set', async (args) => {
    return await setConfigValue(args.key, args.value)
  })
}
