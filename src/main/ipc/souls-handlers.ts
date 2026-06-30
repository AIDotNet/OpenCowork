import { getDefaultApiUserAgent } from '../lib/api-user-agent'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  getBundledResourceDirCandidates,
  nativeUserContentRequest
} from './user-content-native'
import {
  BUILTIN_SOUL_TEMPLATES,
  type BuiltinSoulTemplateWithContent
} from '../../shared/builtin-souls'

export interface SoulMarketInfo {
  id: string
  slug: string
  name: string
  description: string
  category?: string
  downloads: number
  updatedAt?: string
  filePath?: string
  url: string
  downloadUrl: string
}

export interface SoulCategoryInfo {
  value: string
  label: string
}

function soulParams(args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...args,
    bundledDirCandidates: getBundledResourceDirCandidates('souls'),
    builtinTemplates: BUILTIN_SOUL_TEMPLATES,
    userAgent: getDefaultApiUserAgent()
  }
}

export function registerSoulsHandlers(): void {
  registerMessagePackHandler<
    undefined,
    { templates: BuiltinSoulTemplateWithContent[]; error?: string }
  >('souls:builtin-list', async () => {
    return nativeUserContentRequest<{ templates: BuiltinSoulTemplateWithContent[]; error?: string }>(
      'souls/builtin-list',
      soulParams()
    )
  })

  registerMessagePackHandler<
    {
      query?: string
      category?: string
      offset?: number
      limit?: number
      sortBy?: 'recent' | 'name'
      apiKey?: string
    },
    { total: number; souls: SoulMarketInfo[]; error?: string }
  >('souls:market-list', async (args) => {
    return nativeUserContentRequest<{ total: number; souls: SoulMarketInfo[]; error?: string }>(
      'souls/market-list',
      soulParams(args)
    )
  })

  registerMessagePackHandler<
    { apiKey?: string } | undefined,
    { categories: SoulCategoryInfo[] }
  >('souls:categories', async (args = {}) => {
    return nativeUserContentRequest<{ categories: SoulCategoryInfo[] }>(
      'souls/categories',
      soulParams(args)
    )
  })

  registerMessagePackHandler<
    { slug?: string; downloadUrl?: string; apiKey?: string },
    { content?: string; error?: string }
  >('souls:download-remote', async (args) => {
    return nativeUserContentRequest<{ content?: string; error?: string }>(
      'souls/download-remote',
      soulParams(args)
    )
  })

  registerMessagePackHandler<{ projectRootPath?: string } | undefined>(
    'souls:get-target-paths',
    async (args = {}) => {
      return nativeUserContentRequest('souls/get-target-paths', soulParams(args))
    }
  )

  registerMessagePackHandler<
    { content?: string; target?: 'global' | 'project'; projectRootPath?: string },
    { success: boolean; path?: string; error?: string }
  >('souls:install', async (args) => {
    return nativeUserContentRequest<{ success: boolean; path?: string; error?: string }>(
      'souls/install',
      soulParams(args)
    )
  })
}
