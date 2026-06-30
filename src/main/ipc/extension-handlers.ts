import { shell } from 'electron'
import { registerMessagePackHandler } from './messagepack-handler'
import type { ExtensionInstance } from '../../shared/extension-types'
import { nativeExtensionRequest } from './extension-native-bridge'

type MutationResult = {
  success: boolean
  error?: string
}

type ExtensionUpdateArgs = {
  id: string
  patch: {
    enabled?: boolean
    config?: Record<string, string>
  }
}

type ExtensionAssetArgs = {
  id: string
  path: string
}

type ExtensionStorageGetArgs = {
  extensionId: string
  key: string
}

type ExtensionStorageSetArgs = ExtensionStorageGetArgs & {
  value: unknown
}

type ExtensionPathResult = MutationResult & {
  path?: string
}

function getExtensionId(args: string | { id?: string }): string {
  return typeof args === 'string' ? args : (args.id ?? '')
}

export function registerExtensionHandlers(): void {
  registerMessagePackHandler<undefined, ExtensionInstance[]>('extension:list', async () => {
    return await nativeExtensionRequest<ExtensionInstance[]>('extension/list')
  })

  registerMessagePackHandler<{ sourcePath: string }, MutationResult>(
    'extension:install-from-folder',
    async (args) => {
      return await nativeExtensionRequest<MutationResult>('extension/install-from-folder', args)
    }
  )

  registerMessagePackHandler<ExtensionUpdateArgs, MutationResult>(
    'extension:update',
    async (args) => {
      return await nativeExtensionRequest<MutationResult>('extension/update', args)
    }
  )

  registerMessagePackHandler<string | { id?: string }, MutationResult>(
    'extension:remove',
    async (args) => {
      return await nativeExtensionRequest<MutationResult>('extension/remove', {
        id: getExtensionId(args)
      })
    }
  )

  registerMessagePackHandler<string | { id?: string }, MutationResult>(
    'extension:open-folder',
    async (args) => {
      const result = await nativeExtensionRequest<ExtensionPathResult>('extension/resolve-path', {
        id: getExtensionId(args)
      })
      if (!result.success || !result.path) {
        return { success: false, error: result.error ?? 'Extension path not found' }
      }

      const error = await shell.openPath(result.path)
      return error ? { success: false, error } : { success: true }
    }
  )

  registerMessagePackHandler<ExtensionAssetArgs, { content: string } | { error: string }>(
    'extension:read-asset',
    async (args) => {
      return await nativeExtensionRequest<{ content: string } | { error: string }>(
        'extension/read-asset',
        args
      )
    }
  )

  registerMessagePackHandler<ExtensionStorageGetArgs>('extension:storage-get', async (args) => {
    return await nativeExtensionRequest<unknown>('extension/storage-get', args)
  })

  registerMessagePackHandler<ExtensionStorageSetArgs, MutationResult>(
    'extension:storage-set',
    async (args) => {
      return await nativeExtensionRequest<MutationResult>('extension/storage-set', args)
    }
  )

  registerMessagePackHandler<ExtensionStorageGetArgs, MutationResult>(
    'extension:storage-delete',
    async (args) => {
      return await nativeExtensionRequest<MutationResult>('extension/storage-delete', args)
    }
  )
}
