import { ipcMain } from 'electron'
import { getNativeSshConnectionPayload } from './ssh-handlers'
import { getNativeWorker } from '../lib/native-worker'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

const DEFAULT_SCAN_DEPTH = 3
const GIT_QUERY_FAST_TTL_MS = 1_500
const GIT_QUERY_STABLE_TTL_MS = 5_000
const GIT_QUERY_MAX_CACHE_ENTRIES = 256

interface GitExecResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  errorType?: GitErrorType
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

type GitErrorType =
  | 'NOT_GIT_REPO'
  | 'SSH_DISCONNECTED'
  | 'AUTH_REQUIRED'
  | 'MERGE_CONFLICT'
  | 'UNCOMMITTED_CHANGES_BLOCKING'
  | 'NON_FAST_FORWARD'
  | 'UNKNOWN'

interface GitTarget {
  cwd: string
  sshConnectionId?: string | null
}

interface NativeGitTarget extends GitTarget {
  connection?: Record<string, unknown>
}

interface ScanRepositoriesArgs extends GitTarget {
  rootPath: string
  maxDepth?: number
  excludeDirs?: string[]
}

interface GitRepositorySummary {
  name: string
  fullPath: string
  relativePath: string
  branch: string
  isRootRepo: boolean
  sshConnectionId?: string
}

interface GitStatusFile {
  path: string
  stagedStatus: string
  unstagedStatus: string
  originalPath?: string
}

interface GitStatusDetailed {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  staged: GitStatusFile[]
  unstaged: GitStatusFile[]
  untracked: GitStatusFile[]
  conflicted: GitStatusFile[]
}

interface GitCommitHistoryItem {
  hash: string
  shortHash: string
  author: string
  email: string
  date: string
  subject: string
}

interface GitBranchItem {
  name: string
  fullName: string
  type: 'local' | 'remote'
  isCurrent: boolean
}

interface GitRepoSummary {
  branch: string
  upstream?: string
  ahead: number
  behind: number
}

type NativeGitStatusDetailedResult =
  | ({ success: true } & { status: GitStatusDetailed })
  | {
      success: false
      error: string
      errorType: GitErrorType
      exitCode?: number
      stdout?: string
      stderr?: string
    }

type NativeGitQueryResult =
  | ({
      success: true
      commitId?: string
      commits?: string[]
      files?: string[]
      dirty?: boolean
      diff?: string
      isBinary?: boolean
      content?: string
      exists?: boolean
      stat?: string
      patch?: string
      empty?: boolean
      history?: GitCommitHistoryItem[]
      branches?: GitBranchItem[]
      current?: string | null
      added?: number
      deleted?: number
      binary?: number
    } & Record<string, unknown>)
  | {
      success: false
      error: string
      errorType: GitErrorType
      exitCode?: number
      stdout?: string
      stderr?: string
    }

const gitQueryInflight = new Map<string, Promise<NativeGitQueryResult>>()
const gitQueryCache = new Map<string, { expiresAt: number; result: NativeGitQueryResult }>()
const gitQueryRevisionByTarget = new Map<string, number>()

class GitRouteError extends Error {
  constructor(
    message: string,
    readonly errorType: GitErrorType = 'UNKNOWN'
  ) {
    super(message)
  }
}

function gitTraceEnabled(): boolean {
  return process.env.OPEN_COWORK_GIT_TRACE === '1' || process.env.OPEN_COWORK_NATIVE_DEBUG === '1'
}

function traceGitQuery(event: string, payload: Record<string, unknown>): void {
  if (!gitTraceEnabled()) return
  console.debug('[GitQuery]', event, payload)
}

function stableQueryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableQueryValue)
  if (!value || typeof value !== 'object') return value

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const nested = (value as Record<string, unknown>)[key]
    if (nested !== undefined) normalized[key] = stableQueryValue(nested)
  }
  return normalized
}

function gitTargetKey(target: GitTarget): string {
  return `${target.sshConnectionId?.trim() || 'local'}\u0000${target.cwd}`
}

function gitQueryKey(target: GitTarget, params: Record<string, unknown>): string {
  return `${gitTargetKey(target)}\u0000${JSON.stringify(stableQueryValue(params))}`
}

function gitQueryRevision(target: GitTarget): number {
  return gitQueryRevisionByTarget.get(gitTargetKey(target)) ?? 0
}

function gitQueryTtl(params: Record<string, unknown>): number {
  switch (params.operation) {
    case 'get-file-diff':
    case 'get-file-diff-at-commit':
    case 'get-file-content-at-ref':
    case 'get-file-history':
    case 'get-commit-history':
    case 'list-branches':
      return GIT_QUERY_STABLE_TTL_MS
    default:
      return GIT_QUERY_FAST_TTL_MS
  }
}

function pruneGitQueryCache(now = Date.now()): void {
  if (gitQueryCache.size <= GIT_QUERY_MAX_CACHE_ENTRIES) return

  for (const [key, entry] of gitQueryCache) {
    if (entry.expiresAt <= now) gitQueryCache.delete(key)
  }

  while (gitQueryCache.size > GIT_QUERY_MAX_CACHE_ENTRIES) {
    const oldestKey = gitQueryCache.keys().next().value
    if (!oldestKey) break
    gitQueryCache.delete(oldestKey)
  }
}

function invalidateGitQueryCache(target?: GitTarget): void {
  if (!target) {
    gitQueryCache.clear()
    gitQueryInflight.clear()
    gitQueryRevisionByTarget.clear()
    return
  }

  const targetKey = gitTargetKey(target)
  gitQueryRevisionByTarget.set(targetKey, gitQueryRevision(target) + 1)
  const prefix = `${targetKey}\u0000`
  for (const key of gitQueryCache.keys()) {
    if (key.startsWith(prefix)) gitQueryCache.delete(key)
  }
  for (const key of gitQueryInflight.keys()) {
    if (key.startsWith(prefix)) gitQueryInflight.delete(key)
  }
}

function toNativeGitTarget<T extends GitTarget>(target: T): T & NativeGitTarget {
  const sshConnectionId = target.sshConnectionId?.trim()
  if (!sshConnectionId) return { ...target, sshConnectionId: target.sshConnectionId ?? undefined }

  const connection = getNativeSshConnectionPayload(sshConnectionId)
  if (!connection) {
    throw new GitRouteError('SSH connection not found', 'SSH_DISCONNECTED')
  }

  return { ...target, sshConnectionId, connection }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorType(error: unknown): GitErrorType {
  return error instanceof GitRouteError ? error.errorType : 'UNKNOWN'
}

function failFromError(error: unknown): {
  success: false
  error: string
  errorType: GitErrorType
} {
  return {
    success: false,
    error: errorMessage(error),
    errorType: errorType(error)
  }
}

function ok<T extends object>(data: T): { success: true } & T {
  return { success: true, ...data }
}

function fail(
  result: GitExecResult,
  fallback: string
): {
  success: false
  error: string
  errorType: GitErrorType
  exitCode: number
  stdout: string
  stderr: string
} {
  return {
    success: false,
    error: result.stderr || fallback,
    errorType: result.errorType ?? 'UNKNOWN',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

function okMutation(
  target: GitTarget,
  result: GitExecResult
): { success: true; stdout: string; stderr: string } {
  invalidateGitQueryCache(target)
  return ok({ stdout: result.stdout, stderr: result.stderr })
}

async function nativeGitRequest<T>(
  method: string,
  target: GitTarget,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<T> {
  return await getNativeWorker().request<T>(
    method,
    {
      ...toNativeGitTarget(target),
      ...params
    },
    timeoutMs
  )
}

function queryGit<T extends NativeGitQueryResult = NativeGitQueryResult>(
  target: GitTarget,
  params: Record<string, unknown>
): Promise<T> {
  const cacheKey = gitQueryKey(target, params)
  const now = Date.now()
  const cached = gitQueryCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    traceGitQuery('cache-hit', {
      cwd: target.cwd,
      sshConnectionId: target.sshConnectionId ?? null,
      operation: params.operation,
      ttlRemainingMs: cached.expiresAt - now
    })
    return Promise.resolve(cached.result as T)
  }
  if (cached) gitQueryCache.delete(cacheKey)

  const pending = gitQueryInflight.get(cacheKey)
  if (pending) {
    traceGitQuery('coalesce', {
      cwd: target.cwd,
      sshConnectionId: target.sshConnectionId ?? null,
      operation: params.operation
    })
    return pending as Promise<T>
  }

  traceGitQuery('request', {
    cwd: target.cwd,
    sshConnectionId: target.sshConnectionId ?? null,
    operation: params.operation
  })
  const requestRevision = gitQueryRevision(target)
  const request = nativeGitRequest<T>('git/query', target, params)
    .then((result) => {
      const ttl = gitQueryTtl(params)
      if (gitQueryRevision(target) === requestRevision) {
        gitQueryCache.set(cacheKey, {
          expiresAt: Date.now() + ttl,
          result
        })
        pruneGitQueryCache()
      }
      return result
    })
    .catch((error) => failFromError(error) as T)
    .finally(() => {
      if (gitQueryInflight.get(cacheKey) === request) {
        gitQueryInflight.delete(cacheKey)
      }
    })

  gitQueryInflight.set(cacheKey, request as Promise<NativeGitQueryResult>)
  return request
}

async function execGit(args: string[], target: GitTarget): Promise<GitExecResult> {
  return await nativeGitRequest<GitExecResult>(
    'git/exec',
    target,
    {
      args,
      timeoutMs: 60_000,
      maxStdoutChars: 2 * 1024 * 1024,
      maxStderrChars: 64 * 1024
    },
    90_000
  )
}

function registerGitMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    try {
      const args = decodeMessagePackPayload<TArgs>(bytes)
      return encodeMessagePackPayload(await handler(args))
    } catch (error) {
      return encodeMessagePackPayload(failFromError(error))
    }
  })
}

export function registerGitHandlers(): void {
  registerGitMessagePackHandler<GitTarget>('git:get-head', async (args) => {
    return await queryGit(args, { operation: 'get-head' })
  })

  registerGitMessagePackHandler<GitTarget & { base: string; head?: string }>(
    'git:get-range-commits',
    async (args) => {
      return await queryGit(args, {
        operation: 'get-range-commits',
        base: args.base,
        head: args.head
      })
    }
  )

  registerGitMessagePackHandler<GitTarget & { base: string; head?: string }>(
    'git:get-changed-files',
    async (args) => {
      return await queryGit(args, {
        operation: 'get-changed-files',
        base: args.base,
        head: args.head
      })
    }
  )

  registerGitMessagePackHandler<GitTarget>('git:get-status', async (args) => {
    return await queryGit(args, { operation: 'get-status' })
  })

  registerGitMessagePackHandler<GitTarget>('git:get-line-summary', async (args) => {
    return await queryGit(args, { operation: 'get-line-summary' })
  })

  registerGitMessagePackHandler<ScanRepositoriesArgs>('git:scan-repositories', async (args) => {
    const repositories = await nativeGitRequest<GitRepositorySummary[]>(
      'git/scan-repositories',
      args,
      {
        rootPath: args.rootPath,
        maxDepth: args.maxDepth ?? DEFAULT_SCAN_DEPTH,
        excludeDirs: args.excludeDirs ?? []
      },
      90_000
    )
    return ok({ repositories })
  })

  registerGitMessagePackHandler<GitTarget>('git:get-repo-summary', async (args) => {
    const result = await nativeGitRequest<NativeGitStatusDetailedResult>('git/status-detailed', args)
    if (!result.success) return result
    const summary: GitRepoSummary = {
      branch: result.status.branch,
      upstream: result.status.upstream,
      ahead: result.status.ahead,
      behind: result.status.behind
    }
    return ok(summary)
  })

  registerGitMessagePackHandler<GitTarget>('git:get-status-detailed', async (args) => {
    return await nativeGitRequest<NativeGitStatusDetailedResult>('git/status-detailed', args)
  })

  registerGitMessagePackHandler<GitTarget & { filePath: string; staged?: boolean }>(
    'git:get-file-diff',
    async (args) => {
      return await queryGit(args, {
        operation: 'get-file-diff',
        filePath: args.filePath,
        staged: args.staged
      })
    }
  )

  registerGitMessagePackHandler<GitTarget & { filePath: string; commitHash: string }>(
    'git:get-file-diff-at-commit',
    async (args) => {
      return await queryGit(args, {
        operation: 'get-file-diff-at-commit',
        filePath: args.filePath,
        commitHash: args.commitHash
      })
    }
  )

  registerGitMessagePackHandler<GitTarget & { filePath: string; ref: string }>(
    'git:get-file-content-at-ref',
    async (args) => {
      return await queryGit(args, {
        operation: 'get-file-content-at-ref',
        filePath: args.filePath,
        ref: args.ref
      })
    }
  )

  registerGitMessagePackHandler<GitTarget & { maxPatchChars?: number }>(
    'git:get-staged-diff-bundle',
    async (args) => {
      return await queryGit(args, {
        operation: 'get-staged-diff-bundle',
        maxPatchChars: args.maxPatchChars
      })
    }
  )

  registerGitMessagePackHandler<GitTarget & { limit?: number; skip?: number }>(
    'git:get-commit-history',
    async (args) => {
      return await queryGit(args, {
        operation: 'get-commit-history',
        limit: args.limit,
        skip: args.skip
      })
    }
  )

  registerGitMessagePackHandler<GitTarget>('git:list-branches', async (args) => {
    return await queryGit(args, { operation: 'list-branches' })
  })

  registerGitMessagePackHandler<GitTarget>('git:fetch', async (args) => {
    const result = await execGit(['fetch'], args)
    if (!result.success) return fail(result, 'Failed to fetch repository')
    return okMutation(args, result)
  })

  registerGitMessagePackHandler<GitTarget>('git:pull-rebase', async (args) => {
    const result = await execGit(['pull', '--rebase'], args)
    if (!result.success) return fail(result, 'Failed to pull --rebase')
    return okMutation(args, result)
  })

  registerGitMessagePackHandler<GitTarget>('git:push', async (args) => {
    const result = await execGit(['push'], args)
    if (!result.success) return fail(result, 'Failed to push repository')
    return okMutation(args, result)
  })

  registerGitMessagePackHandler<GitTarget & { filePath: string; limit?: number; skip?: number }>(
    'git:get-file-history',
    async (args) => {
      return await queryGit(args, {
        operation: 'get-file-history',
        filePath: args.filePath,
        limit: args.limit,
        skip: args.skip
      })
    }
  )

  registerGitMessagePackHandler<GitTarget & { name: string; startPoint?: string }>(
    'git:create-branch',
    async (args) => {
      const result = await execGit(
        ['branch', args.name, ...(args.startPoint ? [args.startPoint] : [])],
        args
      )
      if (!result.success) return fail(result, 'Failed to create branch')
      return okMutation(args, result)
    }
  )

  registerGitMessagePackHandler<GitTarget & { name: string }>(
    'git:checkout-branch',
    async (args) => {
      const result = await execGit(['checkout', args.name], args)
      if (!result.success) return fail(result, 'Failed to checkout branch')
      return okMutation(args, result)
    }
  )

  registerGitMessagePackHandler<GitTarget & { ref: string }>('git:merge-branch', async (args) => {
    const result = await execGit(['merge', '--no-edit', args.ref], args)
    if (!result.success) return fail(result, 'Failed to merge branch')
    return okMutation(args, result)
  })

  registerGitMessagePackHandler<GitTarget & { ref: string }>('git:rebase-branch', async (args) => {
    const result = await execGit(['rebase', args.ref], args)
    if (!result.success) return fail(result, 'Failed to rebase branch')
    return okMutation(args, result)
  })

  registerGitMessagePackHandler<GitTarget & { name: string; force?: boolean }>(
    'git:delete-local-branch',
    async (args) => {
      const result = await execGit(['branch', args.force ? '-D' : '-d', args.name], args)
      if (!result.success) return fail(result, 'Failed to delete local branch')
      return okMutation(args, result)
    }
  )

  registerGitMessagePackHandler<GitTarget & { remote: string; branchName: string }>(
    'git:delete-remote-branch',
    async (args) => {
      const result = await execGit(['push', args.remote, '--delete', args.branchName], args)
      if (!result.success) return fail(result, 'Failed to delete remote branch')
      return okMutation(args, result)
    }
  )

  registerGitMessagePackHandler<GitTarget & { oldName?: string; newName: string }>(
    'git:rename-branch',
    async (args) => {
      const cmd =
        args.oldName !== undefined && args.oldName !== ''
          ? (['branch', '-m', args.oldName, args.newName] as const)
          : (['branch', '-m', args.newName] as const)
      const result = await execGit([...cmd], args)
      if (!result.success) return fail(result, 'Failed to rename branch')
      return okMutation(args, result)
    }
  )

  registerGitMessagePackHandler<GitTarget & { paths: string[] }>(
    'git:stage-files',
    async (args) => {
      if (!args.paths.length) return ok({})
      const result = await execGit(['add', '--', ...args.paths], args)
      if (!result.success) return fail(result, 'Failed to stage files')
      return okMutation(args, result)
    }
  )

  registerGitMessagePackHandler<GitTarget & { paths: string[] }>(
    'git:unstage-files',
    async (args) => {
      if (!args.paths.length) return ok({})
      const result = await execGit(['restore', '--staged', '--', ...args.paths], args)
      if (!result.success) return fail(result, 'Failed to unstage files')
      return okMutation(args, result)
    }
  )

  registerGitMessagePackHandler<GitTarget>('git:stage-all', async (args) => {
    const result = await execGit(['add', '-A'], args)
    if (!result.success) return fail(result, 'Failed to stage all changes')
    return okMutation(args, result)
  })

  registerGitMessagePackHandler<GitTarget>('git:unstage-all', async (args) => {
    const result = await execGit(['reset', 'HEAD'], args)
    if (!result.success) return fail(result, 'Failed to unstage all changes')
    return okMutation(args, result)
  })

  registerGitMessagePackHandler<
    GitTarget & { paths: string[]; scope: 'worktree' | 'full' | 'untracked' }
  >('git:discard-files', async (args) => {
    if (!args.paths.length) return ok({})
    if (args.scope === 'untracked') {
      const result = await execGit(['clean', '-fd', '--', ...args.paths], args)
      if (!result.success) return fail(result, 'Failed to remove untracked files')
      return okMutation(args, result)
    }
    const restoreArgs =
      args.scope === 'full'
        ? (['restore', '--source=HEAD', '--staged', '--worktree', '--', ...args.paths] as const)
        : (['restore', '--worktree', '--', ...args.paths] as const)
    const result = await execGit([...restoreArgs], args)
    if (!result.success) return fail(result, 'Failed to discard changes')
    return okMutation(args, result)
  })

  registerGitMessagePackHandler<GitTarget & { message: string }>('git:commit', async (args) => {
    const message = args.message.trim()
    if (!message) {
      return {
        success: false,
        error: 'Commit message is required',
        errorType: 'UNKNOWN' as GitErrorType
      }
    }
    const result = await execGit(['commit', '-m', message], args)
    if (!result.success) return fail(result, 'Failed to commit')
    return okMutation(args, result)
  })
}
