import { registerMessagePackHandler } from './messagepack-handler'
import {
  ensureNativeUserContent,
  getBundledResourceDirCandidates,
  nativeUserContentRequest
} from './user-content-native'

function promptParams(args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...args,
    bundledDirCandidates: getBundledResourceDirCandidates('prompts')
  }
}

export function registerPromptsHandlers(): void {
  ensureNativeUserContent('prompts/ensure', promptParams())

  registerMessagePackHandler<undefined, string[]>('prompts:list', async () => {
    return nativeUserContentRequest<string[]>('prompts/list', promptParams())
  })

  registerMessagePackHandler<{ name: string }, { content: string } | { error: string }>(
    'prompts:load',
    async (args) => {
      return nativeUserContentRequest<{ content: string } | { error: string }>(
        'prompts/load',
        promptParams(args)
      )
    }
  )
}
