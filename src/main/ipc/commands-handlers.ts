import { registerMessagePackHandler } from './messagepack-handler'
import {
  ensureNativeUserContent,
  getBundledResourceDirCandidates,
  nativeUserContentRequest
} from './user-content-native'

export interface CommandInfo {
  name: string
  summary: string
}

export interface CommandManageItem {
  id: string
  name: string
  summary: string
  path: string
  source: 'bundled' | 'user'
  editable: boolean
  effective: boolean
}

type CommandLoadResult =
  | { name: string; content: string; summary: string }
  | { error: string; notFound?: boolean }

type CommandManageReadResult =
  | (CommandManageItem & {
      content: string
    })
  | { error: string }

type CommandMutationResult = {
  success: boolean
  path?: string
  error?: string
}

function commandParams(args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...args,
    bundledDirCandidates: getBundledResourceDirCandidates('commands')
  }
}

export function registerCommandsHandlers(): void {
  ensureNativeUserContent('commands/ensure', commandParams())

  registerMessagePackHandler<undefined, CommandInfo[]>('commands:list', async () => {
    return nativeUserContentRequest<CommandInfo[]>('commands/list', commandParams())
  })

  registerMessagePackHandler<{ name: string }, CommandLoadResult>('commands:load', async (args) => {
    return nativeUserContentRequest<CommandLoadResult>('commands/load', commandParams(args))
  })

  registerMessagePackHandler<undefined, CommandManageItem[]>(
    'commands:manage-list',
    async () => {
      return nativeUserContentRequest<CommandManageItem[]>('commands/manage-list', commandParams())
    }
  )

  registerMessagePackHandler<{ path: string }, CommandManageReadResult>(
    'commands:manage-read',
    async (args) => {
      return nativeUserContentRequest<CommandManageReadResult>(
        'commands/manage-read',
        commandParams(args)
      )
    }
  )

  registerMessagePackHandler<{ name: string; content?: string }, CommandMutationResult>(
    'commands:manage-create',
    async (args) => {
      return nativeUserContentRequest<CommandMutationResult>(
        'commands/manage-create',
        commandParams(args)
      )
    }
  )

  registerMessagePackHandler<{ path: string; content: string }, CommandMutationResult>(
    'commands:manage-save',
    async (args) => {
      return nativeUserContentRequest<CommandMutationResult>(
        'commands/manage-save',
        commandParams(args)
      )
    }
  )
}
