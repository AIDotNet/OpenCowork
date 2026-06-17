import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { Stats } from 'fs'
import type { Client } from 'ssh2'
import { getSshClientForGitExec } from './ssh-handlers'

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'target',
  'coverage',
  'tmp',
  'cache'
])

const DEFAULT_SCAN_DEPTH = 3
const DEFAULT_HISTORY_LIMIT = 50
const STATUS_SEPARATOR = '\u0001'
const HISTORY_SEPARATOR = '\u0001'

interface GitExecResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  errorType?: GitErrorType
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

interface SshSessionRef {
  connectionId: string
  client: Client
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function normalizeGitError(
  stderr: string,
  exitCode: number,
  defaultType: GitErrorType = 'UNKNOWN'
): { errorType?: GitErrorType; message: string } {
  const message = stderr.trim()
  const lower = message.toLowerCase()

  if (lower.includes('not a git repository')) {
    return { errorType: 'NOT_GIT_REPO' as GitErrorType, message }
  }
  if (
    lower.includes('authentication failed') ||
    lower.includes('could not read from remote repository')
  ) {
    return { errorType: 'AUTH_REQUIRED' as GitErrorType, message }
  }
  if (lower.includes('merge conflict') || lower.includes('conflict')) {
    return { errorType: 'MERGE_CONFLICT' as GitErrorType, message }
  }
  if (lower.includes('unstaged changes') || lower.includes('would be overwritten')) {
    return { errorType: 'UNCOMMITTED_CHANGES_BLOCKING' as GitErrorType, message }
  }
  if (lower.includes('non-fast-forward')) {
    return { errorType: 'NON_FAST_FORWARD' as GitErrorType, message }
  }

  return {
    errorType: exitCode === 0 ? undefined : defaultType,
    message: message || 'Git command failed'
  }
}

function execGitLocal(args: string[], cwd: string): Promise<GitExecResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (exitCode) => {
      const code = exitCode ?? 1
      const normalized = normalizeGitError(stderr, code)
      resolve({
        success: code === 0,
        stdout,
        stderr: normalized.message,
        exitCode: code,
        errorType: normalized.errorType
      })
    })
    child.on('error', (error) => {
      resolve({
        success: false,
        stdout,
        stderr: error.message || stderr,
        exitCode: 1,
        errorType: 'UNKNOWN'
      })
    })
  })
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

function shellPathExpr(str: string): string {
  if (str === '~') return '"$HOME"'
  if (str.startsWith('~/')) return `"$HOME"${shellEscape(str.slice(1))}`
  return shellEscape(str)
}

async function getSshSession(connectionId: string): Promise<SshSessionRef | null> {
  const client = await getSshClientForGitExec(connectionId)
  if (!client) return null
  return { connectionId, client }
}

function sshExec(session: SshSessionRef, command: string, timeout = 60000): Promise<GitExecResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        success: false,
        stdout: '',
        stderr: 'SSH exec timeout',
        exitCode: 1,
        errorType: 'SSH_DISCONNECTED'
      })
    }, timeout)

    session.client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          exitCode: 1,
          errorType: 'SSH_DISCONNECTED'
        })
        return
      }

      let stdout = ''
      let stderr = ''

      stream.on('data', (data: Buffer) => {
        stdout += data.toString('utf8')
      })
      stream.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf8')
      })
      stream.on('close', (code: number) => {
        clearTimeout(timer)
        const exitCode = code ?? 1
        const normalized = normalizeGitError(stderr, exitCode, 'SSH_DISCONNECTED')
        resolve({
          success: exitCode === 0,
          stdout,
          stderr: normalized.message,
          exitCode,
          errorType: normalized.errorType
        })
      })
    })
  })
}

async function execGit(args: string[], target: GitTarget): Promise<GitExecResult> {
  if (target.sshConnectionId) {
    const session = await getSshSession(target.sshConnectionId)
    if (!session) {
      return {
        success: false,
        stdout: '',
        stderr: 'No active SSH session for this connection',
        exitCode: 1,
        errorType: 'SSH_DISCONNECTED'
      }
    }
    const renderedArgs = args.map((arg) => shellEscape(arg)).join(' ')
    const cmd = `git -C ${shellPathExpr(target.cwd)} ${renderedArgs}`
    return sshExec(session, cmd)
  }

  return execGitLocal(['-C', target.cwd, ...args], target.cwd)
}

async function isGitRepository(
  repoPath: string,
  sshConnectionId?: string | null
): Promise<boolean> {
  const result = await execGit(['rev-parse', '--is-inside-work-tree'], {
    cwd: repoPath,
    sshConnectionId
  })
  return result.success && result.stdout.trim() === 'true'
}

async function readLocalDirs(
  dirPath: string
): Promise<Array<{ name: string; fullPath: string; stats: Stats }>> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const directories: Array<{ name: string; fullPath: string; stats: Stats }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const fullPath = path.join(dirPath, entry.name)
    const stats = await fs.stat(fullPath)
    directories.push({ name: entry.name, fullPath, stats })
  }
  return directories
}

async function readRemoteDirs(
  dirPath: string,
  sshConnectionId: string
): Promise<Array<{ name: string; fullPath: string }>> {
  const session = await getSshSession(sshConnectionId)
  if (!session) return []
  const command = `find ${shellPathExpr(dirPath)} -mindepth 1 -maxdepth 1 -type d -print`
  const result = await sshExec(session, command, 15000)
  if (!result.success) return []
  return normalizeLines(result.stdout).map((fullPath) => ({
    fullPath,
    name: path.posix.basename(fullPath)
  }))
}

async function getCurrentBranch(
  repoPath: string,
  sshConnectionId?: string | null
): Promise<string> {
  const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoPath,
    sshConnectionId
  })
  return result.success ? result.stdout.trim() : 'HEAD'
}

function normalizeRemoteScanRoot(rootPath: string): string {
  const trimmed = rootPath.trim().replace(/\\/g, '/')
  if (!trimmed) return trimmed
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

async function scanRepositories(args: ScanRepositoriesArgs): Promise<GitRepositorySummary[]> {
  const sshConnectionId = args.sshConnectionId ?? null
  const rootPath = sshConnectionId ? normalizeRemoteScanRoot(args.rootPath) : args.rootPath
  const maxDepth = args.maxDepth ?? DEFAULT_SCAN_DEPTH
  const excluded = new Set([...(args.excludeDirs ?? []), ...Array.from(EXCLUDED_DIRS)])
  const repositories: GitRepositorySummary[] = []
  const queue: Array<{ currentPath: string; depth: number }> = [{ currentPath: rootPath, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break

    const repoDetected = await isGitRepository(current.currentPath, sshConnectionId)
    if (repoDetected) {
      repositories.push({
        name: sshConnectionId
          ? path.posix.basename(current.currentPath)
          : path.basename(current.currentPath),
        fullPath: current.currentPath,
        relativePath:
          current.currentPath === rootPath
            ? '.'
            : sshConnectionId
              ? path.posix.relative(rootPath, current.currentPath)
              : path.relative(rootPath, current.currentPath),
        branch: await getCurrentBranch(current.currentPath, sshConnectionId),
        isRootRepo: current.currentPath === rootPath,
        sshConnectionId: sshConnectionId ?? undefined
      })
      continue
    }

    if (current.depth >= maxDepth) continue

    const dirs = sshConnectionId
      ? await readRemoteDirs(current.currentPath, sshConnectionId)
      : await readLocalDirs(current.currentPath)

    for (const dir of dirs) {
      if (excluded.has(dir.name)) continue
      queue.push({ currentPath: dir.fullPath, depth: current.depth + 1 })
    }
  }

  return repositories.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function parseAheadBehind(header: string): {
  branch: string
  upstream?: string
  ahead: number
  behind: number
} {
  const match = header.match(/^##\s+([^.]+?)(?:\.\.\.([^\s]+))?(?:\s+\[(.+)\])?$/)
  const branch = match?.[1] ?? 'HEAD'
  const upstream = match?.[2]
  const details = match?.[3] ?? ''
  let ahead = 0
  let behind = 0
  for (const part of details.split(',')) {
    const value = part.trim()
    const aheadMatch = value.match(/^ahead\s+(\d+)$/)
    const behindMatch = value.match(/^behind\s+(\d+)$/)
    if (aheadMatch) ahead = Number(aheadMatch[1])
    if (behindMatch) behind = Number(behindMatch[1])
  }
  return { branch, upstream, ahead, behind }
}

function parseStatusDetailed(output: string): GitStatusDetailed {
  const lines = output.split(/\r?\n/).filter(Boolean)
  const header = lines[0]?.startsWith('## ')
    ? parseAheadBehind(lines[0])
    : parseAheadBehind('## HEAD')
  const body = lines[0]?.startsWith('## ') ? lines.slice(1) : lines

  const staged: GitStatusFile[] = []
  const unstaged: GitStatusFile[] = []
  const untracked: GitStatusFile[] = []
  const conflicted: GitStatusFile[] = []

  for (const line of body) {
    if (line.length < 3) continue
    const stagedStatus = line[0]
    const unstagedStatus = line[1]
    const rawPath = line.slice(3)
    const renameParts = rawPath.split(' -> ')
    const filePath = renameParts[renameParts.length - 1]
    const originalPath = renameParts.length > 1 ? renameParts[0] : undefined
    const item: GitStatusFile = {
      path: filePath,
      stagedStatus,
      unstagedStatus,
      originalPath
    }

    if (stagedStatus === '?' && unstagedStatus === '?') {
      untracked.push(item)
      continue
    }

    if (
      'UADRC'.includes(stagedStatus) &&
      'UADRC'.includes(unstagedStatus) &&
      (stagedStatus === 'U' || unstagedStatus === 'U')
    ) {
      conflicted.push(item)
      continue
    }

    if (stagedStatus !== ' ') staged.push(item)
    if (unstagedStatus !== ' ') unstaged.push(item)
  }

  return {
    branch: header.branch,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    staged,
    unstaged,
    untracked,
    conflicted
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

export function registerGitHandlers(): void {
  ipcMain.handle('git:get-head', async (_event, args: GitTarget) => {
    const result = await execGit(['rev-parse', 'HEAD'], args)
    if (!result.success) return fail(result, 'Failed to get HEAD')
    return ok({ commitId: result.stdout.trim() })
  })

  ipcMain.handle(
    'git:get-range-commits',
    async (_event, args: GitTarget & { base: string; head?: string }) => {
      const head = args.head?.trim() || 'HEAD'
      const result = await execGit(['log', '--format=%H', `${args.base}..${head}`], args)
      if (!result.success) return fail(result, 'Failed to get commit range')
      return ok({ commits: normalizeLines(result.stdout) })
    }
  )

  ipcMain.handle(
    'git:get-changed-files',
    async (_event, args: GitTarget & { base: string; head?: string }) => {
      const head = args.head?.trim() || 'HEAD'
      const result = await execGit(['diff', '--name-only', `${args.base}..${head}`], args)
      if (!result.success) return fail(result, 'Failed to get changed files')
      return ok({ files: normalizeLines(result.stdout) })
    }
  )

  ipcMain.handle('git:get-status', async (_event, args: GitTarget) => {
    const result = await execGit(['status', '--short'], args)
    if (!result.success) return fail(result, 'Failed to get git status')
    const files = normalizeLines(result.stdout)
    return ok({ files, dirty: files.length > 0 })
  })

  ipcMain.handle('git:scan-repositories', async (_event, args: ScanRepositoriesArgs) => {
    try {
      return ok({ repositories: await scanRepositories(args) })
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorType: args.sshConnectionId ? 'SSH_DISCONNECTED' : 'UNKNOWN'
      }
    }
  })

  ipcMain.handle('git:get-repo-summary', async (_event, args: GitTarget) => {
    const result = await execGit(['status', '--porcelain=v1', '-b'], args)
    if (!result.success) return fail(result, 'Failed to get repository summary')
    const parsed = parseStatusDetailed(result.stdout)
    const summary: GitRepoSummary = {
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind
    }
    return ok(summary)
  })

  ipcMain.handle('git:get-status-detailed', async (_event, args: GitTarget) => {
    const result = await execGit(['status', '--porcelain=v1', '-b'], args)
    if (!result.success) return fail(result, 'Failed to get detailed status')
    return ok({ status: parseStatusDetailed(result.stdout) })
  })

  ipcMain.handle(
    'git:get-file-diff',
    async (_event, args: GitTarget & { filePath: string; staged?: boolean }) => {
      const diffArgs = args.staged
        ? ['diff', '--cached', '--', args.filePath]
        : ['diff', '--', args.filePath]
      const result = await execGit(diffArgs, args)
      if (!result.success && result.exitCode !== 0) return fail(result, 'Failed to get file diff')
      return ok({ diff: result.stdout, isBinary: result.stdout.includes('Binary files') })
    }
  )

  ipcMain.handle(
    'git:get-file-diff-at-commit',
    async (_event, args: GitTarget & { filePath: string; commitHash: string }) => {
      const hash = args.commitHash.trim()
      if (!hash) {
        return {
          success: false,
          error: 'commitHash is required',
          errorType: 'UNKNOWN' as GitErrorType
        }
      }
      const result = await execGit(
        ['show', '--no-color', '--pretty=format:', '--no-notes', hash, '--', args.filePath],
        args
      )
      if (!result.success) return fail(result, 'Failed to get file diff at commit')
      return ok({ diff: result.stdout, isBinary: result.stdout.includes('Binary files') })
    }
  )

  // Full file content at a git ref, for feeding the Monaco diff editor's
  // original/modified sides. ref is the object prefix before the colon:
  // 'HEAD' for the last commit, '' for the staged index (`git show :path`).
  ipcMain.handle(
    'git:get-file-content-at-ref',
    async (_event, args: GitTarget & { filePath: string; ref: string }) => {
      const ref = (args.ref ?? '').trim()
      const objectExpr = `${ref}:${args.filePath}`
      const result = await execGit(['show', objectExpr], args)
      if (!result.success) {
        // A path absent from the ref (new/untracked file) is not an error here.
        const stderr = result.stderr.toLowerCase()
        const missing =
          stderr.includes('does not exist') ||
          stderr.includes('exists on disk, but not in') ||
          stderr.includes('invalid object name')
        if (missing) return ok({ content: '', exists: false, isBinary: false })
        return fail(result, 'Failed to read file content at ref')
      }
      const content = result.stdout
      const isBinary = content.includes(String.fromCharCode(0))
      return ok({ content, exists: true, isBinary })
    }
  )

  ipcMain.handle(
    'git:get-staged-diff-bundle',
    async (_event, args: GitTarget & { maxPatchChars?: number }) => {
      const maxPatchChars = args.maxPatchChars ?? 96_000
      const statResult = await execGit(['diff', '--cached', '--stat'], args)
      if (!statResult.success) return fail(statResult, 'Failed to read staged diff stat')
      const statText = statResult.stdout.trim()
      if (!statText) {
        return ok({ stat: '', patch: '', empty: true as const })
      }
      const patchResult = await execGit(['diff', '--cached', '--no-color'], args)
      if (!patchResult.success) return fail(patchResult, 'Failed to read staged patch')
      let patch = patchResult.stdout
      if (patch.length > maxPatchChars) {
        patch =
          patch.slice(0, maxPatchChars) +
          '\n\n[… patch truncated for size; more changes exist in index …]'
      }
      return ok({ stat: statText, patch, empty: false as const })
    }
  )

  ipcMain.handle(
    'git:get-commit-history',
    async (_event, args: GitTarget & { limit?: number; skip?: number }) => {
      const limit = args.limit ?? DEFAULT_HISTORY_LIMIT
      const skip = args.skip ?? 0
      const format = ['%H', '%h', '%an', '%ae', '%ad', '%s'].join(HISTORY_SEPARATOR)
      const result = await execGit(
        [
          'log',
          '--date=iso',
          `--pretty=format:${format}`,
          `--max-count=${limit}`,
          `--skip=${skip}`
        ],
        args
      )
      if (!result.success) return fail(result, 'Failed to get commit history')
      const history: GitCommitHistoryItem[] = normalizeLines(result.stdout).map((line) => {
        const [hash, shortHash, author, email, date, subject] = line.split(HISTORY_SEPARATOR)
        return { hash, shortHash, author, email, date, subject }
      })
      return ok({ history })
    }
  )

  ipcMain.handle('git:list-branches', async (_event, args: GitTarget) => {
    const format =
      '%(refname)' + STATUS_SEPARATOR + '%(refname:short)' + STATUS_SEPARATOR + '%(HEAD)'
    const [localResult, remoteResult] = await Promise.all([
      execGit(['for-each-ref', '--format', format, 'refs/heads'], args),
      execGit(['for-each-ref', '--format', format, 'refs/remotes'], args)
    ])
    if (!localResult.success) return fail(localResult, 'Failed to list local branches')
    if (!remoteResult.success) return fail(remoteResult, 'Failed to list remote branches')

    const parseBranches = (text: string, type: 'local' | 'remote'): GitBranchItem[] =>
      normalizeLines(text).map((line) => {
        const [fullName, name, headMarker] = line.split(STATUS_SEPARATOR)
        return {
          fullName,
          name,
          type,
          isCurrent: headMarker === '*'
        }
      })

    const branches = [
      ...parseBranches(localResult.stdout, 'local'),
      ...parseBranches(remoteResult.stdout, 'remote')
    ]
    const current = branches.find((branch) => branch.isCurrent)?.name ?? null
    return ok({ branches, current })
  })

  ipcMain.handle('git:fetch', async (_event, args: GitTarget) => {
    const result = await execGit(['fetch'], args)
    if (!result.success) return fail(result, 'Failed to fetch repository')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle('git:pull-rebase', async (_event, args: GitTarget) => {
    const result = await execGit(['pull', '--rebase'], args)
    if (!result.success) return fail(result, 'Failed to pull --rebase')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle('git:push', async (_event, args: GitTarget) => {
    const result = await execGit(['push'], args)
    if (!result.success) return fail(result, 'Failed to push repository')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle(
    'git:get-file-history',
    async (_event, args: GitTarget & { filePath: string; limit?: number; skip?: number }) => {
      const limit = args.limit ?? DEFAULT_HISTORY_LIMIT
      const skip = args.skip ?? 0
      const format = ['%H', '%h', '%an', '%ae', '%ad', '%s'].join(HISTORY_SEPARATOR)
      const result = await execGit(
        [
          'log',
          '--date=iso',
          `--pretty=format:${format}`,
          `--max-count=${limit}`,
          `--skip=${skip}`,
          '--',
          args.filePath
        ],
        args
      )
      if (!result.success) return fail(result, 'Failed to get file history')
      const history: GitCommitHistoryItem[] = normalizeLines(result.stdout).map((line) => {
        const [hash, shortHash, author, email, date, subject] = line.split(HISTORY_SEPARATOR)
        return { hash, shortHash, author, email, date, subject }
      })
      return ok({ history })
    }
  )

  ipcMain.handle(
    'git:create-branch',
    async (_event, args: GitTarget & { name: string; startPoint?: string }) => {
      const result = await execGit(
        ['branch', args.name, ...(args.startPoint ? [args.startPoint] : [])],
        args
      )
      if (!result.success) return fail(result, 'Failed to create branch')
      return ok({ stdout: result.stdout, stderr: result.stderr })
    }
  )

  ipcMain.handle('git:checkout-branch', async (_event, args: GitTarget & { name: string }) => {
    const result = await execGit(['checkout', args.name], args)
    if (!result.success) return fail(result, 'Failed to checkout branch')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle('git:merge-branch', async (_event, args: GitTarget & { ref: string }) => {
    const result = await execGit(['merge', '--no-edit', args.ref], args)
    if (!result.success) return fail(result, 'Failed to merge branch')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle('git:rebase-branch', async (_event, args: GitTarget & { ref: string }) => {
    const result = await execGit(['rebase', args.ref], args)
    if (!result.success) return fail(result, 'Failed to rebase branch')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle(
    'git:delete-local-branch',
    async (_event, args: GitTarget & { name: string; force?: boolean }) => {
      const result = await execGit(['branch', args.force ? '-D' : '-d', args.name], args)
      if (!result.success) return fail(result, 'Failed to delete local branch')
      return ok({ stdout: result.stdout, stderr: result.stderr })
    }
  )

  ipcMain.handle(
    'git:delete-remote-branch',
    async (_event, args: GitTarget & { remote: string; branchName: string }) => {
      const result = await execGit(['push', args.remote, '--delete', args.branchName], args)
      if (!result.success) return fail(result, 'Failed to delete remote branch')
      return ok({ stdout: result.stdout, stderr: result.stderr })
    }
  )

  ipcMain.handle(
    'git:rename-branch',
    async (_event, args: GitTarget & { oldName?: string; newName: string }) => {
      const cmd =
        args.oldName !== undefined && args.oldName !== ''
          ? (['branch', '-m', args.oldName, args.newName] as const)
          : (['branch', '-m', args.newName] as const)
      const result = await execGit([...cmd], args)
      if (!result.success) return fail(result, 'Failed to rename branch')
      return ok({ stdout: result.stdout, stderr: result.stderr })
    }
  )

  ipcMain.handle('git:stage-files', async (_event, args: GitTarget & { paths: string[] }) => {
    if (!args.paths.length) return ok({})
    const result = await execGit(['add', '--', ...args.paths], args)
    if (!result.success) return fail(result, 'Failed to stage files')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle('git:unstage-files', async (_event, args: GitTarget & { paths: string[] }) => {
    if (!args.paths.length) return ok({})
    const result = await execGit(['restore', '--staged', '--', ...args.paths], args)
    if (!result.success) return fail(result, 'Failed to unstage files')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle('git:stage-all', async (_event, args: GitTarget) => {
    const result = await execGit(['add', '-A'], args)
    if (!result.success) return fail(result, 'Failed to stage all changes')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle('git:unstage-all', async (_event, args: GitTarget) => {
    const result = await execGit(['reset', 'HEAD'], args)
    if (!result.success) return fail(result, 'Failed to unstage all changes')
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  ipcMain.handle(
    'git:discard-files',
    async (
      _event,
      args: GitTarget & { paths: string[]; scope: 'worktree' | 'full' | 'untracked' }
    ) => {
      if (!args.paths.length) return ok({})
      if (args.scope === 'untracked') {
        const result = await execGit(['clean', '-fd', '--', ...args.paths], args)
        if (!result.success) return fail(result, 'Failed to remove untracked files')
        return ok({ stdout: result.stdout, stderr: result.stderr })
      }
      const restoreArgs =
        args.scope === 'full'
          ? (['restore', '--source=HEAD', '--staged', '--worktree', '--', ...args.paths] as const)
          : (['restore', '--worktree', '--', ...args.paths] as const)
      const result = await execGit([...restoreArgs], args)
      if (!result.success) return fail(result, 'Failed to discard changes')
      return ok({ stdout: result.stdout, stderr: result.stderr })
    }
  )

  ipcMain.handle('git:commit', async (_event, args: GitTarget & { message: string }) => {
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
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })
}
