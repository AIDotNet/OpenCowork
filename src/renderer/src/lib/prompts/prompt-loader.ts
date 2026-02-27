import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

const promptCache = new Map<string, string>()

export async function loadPrompt(name: string): Promise<string | null> {
  const key = name.trim()
  if (!key) return null

  const cached = promptCache.get(key)
  if (cached) return cached

  try {
    const result = await ipcClient.invoke(IPC.PROMPTS_LOAD, { name: key }) as
      | { content?: string; error?: string }
      | undefined

    if (result && typeof result === 'object' && typeof result.content === 'string') {
      promptCache.set(key, result.content)
      return result.content
    }
  } catch {
    // ignore prompt load failures
  }

  return null
}

export function clearPromptCache(): void {
  promptCache.clear()
}
