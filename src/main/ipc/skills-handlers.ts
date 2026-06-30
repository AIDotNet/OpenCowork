import { app, shell } from 'electron'
import * as path from 'path'
import { getDefaultApiUserAgent } from '../lib/api-user-agent'
import { getNativeWorker } from '../lib/native-worker'
import { registerMessagePackHandler } from './messagepack-handler'

const SKILLS_NATIVE_TIMEOUT_MS = 120_000

type MutationResult = {
  success: boolean
  error?: string
}

type SkillPathResult = MutationResult & {
  path?: string
}

export interface MarketSkillInfo {
  id: string
  slug: string
  name: string
  description: string
  category?: string
  tags: string[]
  downloads: number
  updatedAt?: string
  filePath?: string
  url: string
  downloadUrl: string
  installCommand: string
}

export interface SkillInfo {
  name: string
  description: string
}

export interface ScanFileInfo {
  name: string
  size: number
  type: string
}

export interface RiskItem {
  severity: 'safe' | 'warning' | 'danger'
  category: string
  detail: string
  file: string
  line?: number
}

export interface ScanResult {
  name: string
  description: string
  files: ScanFileInfo[]
  risks: RiskItem[]
  skillMdContent: string
  scriptContents: { file: string; content: string }[]
}

function getBundledSkillDirCandidates(): string[] {
  if (!app.isPackaged) {
    return [path.join(app.getAppPath(), 'resources', 'skills')]
  }

  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'skills'),
    path.join(process.resourcesPath, 'resources', 'skills')
  ]
}

function skillsParams(args?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(args ?? {}),
    bundledDirCandidates: getBundledSkillDirCandidates(),
    userAgent: getDefaultApiUserAgent()
  }
}

async function nativeSkillsRequest<TResult>(
  method: string,
  args?: Record<string, unknown>
): Promise<TResult> {
  return await getNativeWorker().request<TResult>(
    method,
    skillsParams(args),
    SKILLS_NATIVE_TIMEOUT_MS
  )
}

export function registerSkillsHandlers(): void {
  void nativeSkillsRequest<MutationResult>('skills/ensure-builtins').catch((err) => {
    console.error('[Skills] Failed to initialize builtin skills:', err)
  })

  registerMessagePackHandler<{ name: string }, MutationResult & { name?: string }>(
    'skills:ensure-builtin',
    async (args) => nativeSkillsRequest('skills/ensure-builtin', args)
  )

  registerMessagePackHandler<undefined, SkillInfo[]>('skills:list', async () => {
    return nativeSkillsRequest<SkillInfo[]>('skills/list')
  })

  registerMessagePackHandler<
    { name: string },
    { content: string; workingDirectory: string } | { error: string }
  >('skills:load', async (args) => nativeSkillsRequest('skills/load', args))

  registerMessagePackHandler<{ name: string }, { content: string } | { error: string }>(
    'skills:read',
    async (args) => nativeSkillsRequest('skills/read', args)
  )

  registerMessagePackHandler<{ name: string }, { files: ScanFileInfo[] } | { error: string }>(
    'skills:list-files',
    async (args) => nativeSkillsRequest('skills/list-files', args)
  )

  registerMessagePackHandler<{ name: string }, MutationResult>('skills:delete', async (args) =>
    nativeSkillsRequest('skills/delete', args)
  )

  registerMessagePackHandler<{ name: string }, MutationResult>('skills:open-folder', async (args) => {
    const result = await nativeSkillsRequest<SkillPathResult>('skills/resolve-path', args)
    if (!result.success || !result.path) {
      return { success: false, error: result.error ?? 'Skill path not found' }
    }

    const error = await shell.openPath(result.path)
    return error ? { success: false, error } : { success: true }
  })

  registerMessagePackHandler<{ sourcePath: string }, MutationResult & { name?: string }>(
    'skills:add-from-folder',
    async (args) => nativeSkillsRequest('skills/add-from-folder', args)
  )

  registerMessagePackHandler<{ name: string; content: string }, MutationResult>(
    'skills:save',
    async (args) => nativeSkillsRequest('skills/save', args)
  )

  registerMessagePackHandler<{ sourcePath: string }, ScanResult | { error: string }>(
    'skills:scan',
    async (args) => nativeSkillsRequest('skills/scan', args)
  )

  registerMessagePackHandler<
    {
      offset?: number
      limit?: number
      query?: string
      provider?: 'skillsmp'
      apiKey?: string
    },
    { total: number; skills: MarketSkillInfo[] }
  >('skills:market-list', async (args) => nativeSkillsRequest('skills/market-list', args))

  registerMessagePackHandler<
    {
      slug?: string
      name: string
      provider?: 'skillsmp'
      apiKey?: string
      skillId?: string
      url?: string
      downloadUrl?: string
    },
    { tempPath?: string; files?: { path: string; content: string }[]; error?: string }
  >('skills:download-remote', async (args) => nativeSkillsRequest('skills/download-remote', args))

  registerMessagePackHandler<{ tempPath: string }, { success: boolean }>(
    'skills:cleanup-temp',
    async (args) => nativeSkillsRequest('skills/cleanup-temp', args)
  )
}
