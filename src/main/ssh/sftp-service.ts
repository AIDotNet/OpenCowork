import * as fs from 'fs'
import * as path from 'path'
import type { SFTPWrapper, Stats } from 'ssh2'
import { withSshConnection, withSshSftp } from './connection-manager'

// SFTP/exec-backed implementation of the ssh/fs-* and ssh/exec request
// surface. Response shapes mirror the native worker's results exactly so the
// IPC handlers stay unchanged; only the transport moved from "spawn an
// OpenSSH process per operation" to channels on the shared ssh2 connection.

const MAX_TEXT_READ_BYTES = 10 * 1024 * 1024
const MAX_BINARY_READ_BYTES = 100 * 1024 * 1024
const MAX_EXEC_OUTPUT_BYTES = 2 * 1024 * 1024

export interface SshExecServiceResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string | null
  timing?: { totalMs: number; spawnMs: number; timedOut: boolean; engine: string }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

// ── Exec ──

export async function execSshCommand(
  connectionId: string,
  command: string,
  timeoutMs = 60_000
): Promise<SshExecServiceResult> {
  const startedAt = Date.now()
  try {
    return await withSshConnection(connectionId, (client) => {
      return new Promise<SshExecServiceResult>((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err)
          let stdout = ''
          let stderr = ''
          let outputBytes = 0
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            try {
              stream.close()
            } catch {
              // ignore
            }
          }, timeoutMs)
          const append = (target: 'out' | 'err', data: Buffer): void => {
            if (outputBytes >= MAX_EXEC_OUTPUT_BYTES) return
            const text = data.toString('utf-8')
            outputBytes += data.length
            if (target === 'out') stdout += text
            else stderr += text
          }
          stream.on('data', (data: Buffer) => append('out', data))
          stream.stderr.on('data', (data: Buffer) => append('err', data))
          stream.on('close', (code: number | null) => {
            clearTimeout(timer)
            resolve({
              success: !timedOut,
              exitCode: timedOut ? 124 : (code ?? 0),
              stdout,
              stderr,
              error: timedOut ? `Command timed out after ${timeoutMs}ms` : undefined,
              timing: {
                totalMs: Date.now() - startedAt,
                spawnMs: 0,
                timedOut,
                engine: 'ssh2'
              }
            })
          })
          stream.on('error', (streamErr: Error) => {
            clearTimeout(timer)
            reject(streamErr)
          })
        })
      })
    })
  } catch (err) {
    const message = errorMessage(err)
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: message,
      error: message,
      timing: { totalMs: Date.now() - startedAt, spawnMs: 0, timedOut: false, engine: 'ssh2' }
    }
  }
}

export async function testSshConnection(
  connectionId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await withSshConnection(connectionId, async () => undefined)
    return { success: true }
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

// ── SFTP primitives ──

function normalizeRemoteInput(remotePath: string): string {
  const trimmed = remotePath.trim()
  if (!trimmed || trimmed === '~') return '.'
  if (trimmed.startsWith('~/')) return `./${trimmed.slice(2)}`
  return trimmed
}

function sftpRealpath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(normalizeRemoteInput(remotePath), (err, resolved) =>
      err ? reject(err) : resolve(resolved)
    )
  })
}

export async function resolveRemotePath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return sftpRealpath(sftp, remotePath)
}

// For destinations that may not exist yet: resolve the parent, keep the leaf.
export async function resolveRemotePathForWrite(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<string> {
  try {
    return await sftpRealpath(sftp, remotePath)
  } catch {
    const normalized = normalizeRemoteInput(remotePath)
    const parent = path.posix.dirname(normalized)
    const leaf = path.posix.basename(normalized)
    const resolvedParent = await sftpRealpath(sftp, parent)
    return path.posix.join(resolvedParent, leaf)
  }
}

export function sftpLstat(sftp: SFTPWrapper, remotePath: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (err, stats) => {
      if (err) {
        const code = (err as { code?: number | string }).code
        // SFTP status 2 = SSH_FX_NO_SUCH_FILE
        if (code === 2 || code === 'ENOENT') return resolve(null)
        return reject(err)
      }
      resolve(stats)
    })
  })
}

export function statType(stats: Stats): 'file' | 'directory' | 'symlink' | 'other' {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  return 'other'
}

function sftpReadFile(sftp: SFTPWrapper, remotePath: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (err, data) => {
      if (err) return reject(err)
      if (data.length > maxBytes) {
        return reject(new Error(`File is too large (${data.length} bytes)`))
      }
      resolve(data)
    })
  })
}

function sftpWriteFile(sftp: SFTPWrapper, remotePath: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, data, (err) => (err ? reject(err) : resolve()))
  })
}

export function sftpReaddir(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<Array<{ filename: string; longname: string; attrs: Stats }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)))
  })
}

export async function sftpMkdirRecursive(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const resolved = await resolveRemotePathForWrite(sftp, remotePath)
  const segments = resolved.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    const existing = await sftpLstat(sftp, current)
    if (existing) continue
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(current, (err) => (err ? reject(err) : resolve()))
    })
  }
}

// ── fs-* operations (native result shapes) ──

async function fsReadFile(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => {
      const resolved = await resolveRemotePath(sftp, String(params.path ?? ''))
      const data = await sftpReadFile(sftp, resolved, MAX_TEXT_READ_BYTES)
      const content = data.toString('utf-8')
      return {
        success: true,
        content,
        name: path.posix.basename(resolved),
        path: resolved,
        lineCount: content.length ? content.split('\n').length : 0
      }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsReadTextFileLines(
  connectionId: string,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    const maxLines = typeof params.maxLines === 'number' ? params.maxLines : 1000
    return await withSshSftp(connectionId, async (sftp) => {
      const resolved = await resolveRemotePath(sftp, String(params.path ?? ''))
      const data = await sftpReadFile(sftp, resolved, MAX_TEXT_READ_BYTES)
      const normalized = data.toString('utf-8').replace(/\r\n/g, '\n')
      const lines = normalized.split('\n')
      const truncated = lines.length > maxLines
      return {
        success: true,
        content: truncated ? lines.slice(0, maxLines).join('\n') : normalized,
        name: path.posix.basename(resolved),
        path: resolved,
        lineCount: lines.length,
        maxLines,
        truncated
      }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsStatPath(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => {
      let resolved: string
      try {
        resolved = await resolveRemotePath(sftp, String(params.path ?? ''))
      } catch {
        return { success: true, exists: false }
      }
      const stats = await sftpLstat(sftp, resolved)
      if (!stats) return { success: true, exists: false }
      return {
        success: true,
        exists: true,
        type: statType(stats),
        size: stats.size,
        mtimeMs: stats.mtime * 1000
      }
    })
  } catch (err) {
    return { success: false, exists: false, error: errorMessage(err) }
  }
}

async function fsWriteFile(
  connectionId: string,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => {
      const resolved = await resolveRemotePathForWrite(sftp, String(params.path ?? ''))
      const existing = await sftpLstat(sftp, resolved)
      await sftpWriteFile(sftp, resolved, Buffer.from(String(params.content ?? ''), 'utf-8'))
      return { success: true, op: existing ? 'modify' : 'create' }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsReadFileBinary(
  connectionId: string,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => {
      const resolved = await resolveRemotePath(sftp, String(params.path ?? ''))
      const data = await sftpReadFile(sftp, resolved, MAX_BINARY_READ_BYTES)
      return { success: true, data: data.toString('base64') }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsWriteFileBinary(
  connectionId: string,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => {
      const resolved = await resolveRemotePathForWrite(sftp, String(params.path ?? ''))
      await sftpWriteFile(sftp, resolved, Buffer.from(String(params.data ?? ''), 'base64'))
      return { success: true }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsListDir(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => {
      const resolved = await resolveRemotePath(sftp, String(params.path ?? '.'))
      const raw = await sftpReaddir(sftp, resolved)
      const entries = raw
        .map((item) => ({
          name: item.filename,
          path: path.posix.join(resolved, item.filename),
          type:
            statType(item.attrs) === 'directory'
              ? ('directory' as const)
              : statType(item.attrs) === 'symlink'
                ? ('symlink' as const)
                : ('file' as const),
          size: item.attrs.size ?? 0,
          modifyTime: (item.attrs.mtime ?? 0) * 1000
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const offset = typeof params.cursor === 'string' ? Number.parseInt(params.cursor, 10) || 0 : 0
      const limit =
        typeof params.limit === 'number' && params.limit > 0 ? params.limit : entries.length
      const page = entries.slice(offset, offset + limit)
      const hasMore = offset + limit < entries.length
      return {
        success: true,
        entries: page,
        hasMore,
        ...(hasMore ? { nextCursor: String(offset + limit) } : {})
      }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsHomeDir(connectionId: string): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => ({
      success: true,
      path: await sftpRealpath(sftp, '.')
    }))
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsResolvePath(
  connectionId: string,
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => ({
      success: true,
      path: await resolveRemotePath(sftp, String(params.path ?? '.'))
    }))
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsMkdir(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => {
      await sftpMkdirRecursive(sftp, String(params.path ?? ''))
      return { success: true }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsDelete(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    const resolved = await withSshSftp(connectionId, (sftp) =>
      resolveRemotePath(sftp, String(params.path ?? ''))
    )
    if (!resolved || resolved === '/') {
      return { success: false, error: 'Refusing to delete this path' }
    }
    const result = await execSshCommand(connectionId, `rm -rf ${shellEscape(resolved)}`, 120_000)
    return result.exitCode === 0
      ? { success: true }
      : { success: false, error: result.stderr || result.error || 'SSH delete failed' }
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsMove(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await withSshSftp(connectionId, async (sftp) => {
      const from = await resolveRemotePath(sftp, String(params.from ?? ''))
      const to = await resolveRemotePathForWrite(sftp, String(params.to ?? ''))
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
        })
        return { success: true }
      } catch {
        const result = await execSshCommand(
          connectionId,
          `mv ${shellEscape(from)} ${shellEscape(to)}`,
          120_000
        )
        return result.exitCode === 0
          ? { success: true }
          : { success: false, error: result.stderr || result.error || 'SSH move failed' }
      }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

async function fsDownload(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    const remotePath = String(params.remotePath ?? params.path ?? '')
    const localPath = String(params.localPath ?? '')
    if (!remotePath || !localPath) {
      return { success: false, error: 'remotePath and localPath are required' }
    }
    return await withSshSftp(connectionId, async (sftp) => {
      const resolved = await resolveRemotePath(sftp, remotePath)
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true })
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(resolved, localPath, (err) => (err ? reject(err) : resolve()))
      })
      const stat = await fs.promises.stat(localPath)
      return { success: true, path: localPath, bytes: stat.size }
    })
  } catch (err) {
    return { success: false, error: errorMessage(err) }
  }
}

// ── Remote search (find/grep over the exec channel) ──

function buildSearchMeta(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    backend: 'ssh',
    pathStyle: 'absolute',
    truncated: false,
    timedOut: false,
    limitReason: null,
    hiddenIncluded: true,
    ignoredDefaultsApplied: false,
    ...overrides
  }
}

async function fsGlob(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  const pattern = String(params.pattern ?? '*')
  const searchPathInput = String(params.path ?? '.')
  const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 500
  try {
    const root = await withSshSftp(connectionId, (sftp) => resolveRemotePath(sftp, searchPathInput))
    const cmd = `find ${shellEscape(root)} -name ${shellEscape(pattern)} 2>/dev/null | head -n ${limit + 1}`
    const result = await execSshCommand(connectionId, cmd, 60_000)
    if (result.error && !result.stdout) {
      return {
        kind: 'glob',
        matches: [],
        meta: buildSearchMeta({ engine: 'find', searchRoot: root, pattern }),
        error: result.error
      }
    }
    const lines = result.stdout.split('\n').filter(Boolean)
    const truncated = lines.length > limit
    return {
      kind: 'glob',
      matches: lines.slice(0, limit).map((line) => ({ path: line })),
      meta: buildSearchMeta({
        engine: 'find',
        searchRoot: root,
        pattern,
        truncated,
        limitReason: truncated ? 'max_results' : null,
        maxResults: limit,
        timedOut: result.timing?.timedOut === true
      })
    }
  } catch (err) {
    return {
      kind: 'glob',
      matches: [],
      meta: buildSearchMeta({ engine: 'find', searchRoot: searchPathInput, pattern }),
      error: errorMessage(err)
    }
  }
}

async function fsGrep(connectionId: string, params: Record<string, unknown>): Promise<unknown> {
  const pattern = String(params.pattern ?? '')
  const searchPathInput = String(params.path ?? '.')
  const outputMode = (typeof params.outputMode === 'string' ? params.outputMode : 'matches') as
    | 'matches'
    | 'files_with_matches'
    | 'files_without_matches'
    | 'count'
  const maxResults =
    typeof params.maxResults === 'number' && params.maxResults > 0 ? params.maxResults : 200
  const include = typeof params.include === 'string' ? params.include : null
  const caseInsensitive = params.caseInsensitive === true || params.ignoreCase === true
  try {
    const root = await withSshSftp(connectionId, (sftp) => resolveRemotePath(sftp, searchPathInput))
    const flags = ['-r', '-I']
    if (caseInsensitive) flags.push('-i')
    if (outputMode === 'files_with_matches') flags.push('-l')
    else if (outputMode === 'files_without_matches') flags.push('-L')
    else if (outputMode === 'count') flags.push('-c')
    else flags.push('-n')
    if (include) flags.push(`--include=${shellEscape(include)}`)
    const cmd = `grep ${flags.join(' ')} -e ${shellEscape(pattern)} ${shellEscape(root)} 2>/dev/null | head -n ${maxResults + 1}`
    const result = await execSshCommand(connectionId, cmd, 60_000)
    const lines = result.stdout.split('\n').filter(Boolean)
    const truncated = lines.length > maxResults
    const sliced = lines.slice(0, maxResults)
    const matches =
      outputMode === 'files_with_matches' || outputMode === 'files_without_matches'
        ? sliced.map((line) => ({ path: line }))
        : outputMode === 'count'
          ? sliced.map((line) => {
              const idx = line.lastIndexOf(':')
              return {
                path: idx > 0 ? line.slice(0, idx) : line,
                count: idx > 0 ? Number.parseInt(line.slice(idx + 1), 10) || 0 : 0
              }
            })
          : sliced.map((line) => {
              const first = line.indexOf(':')
              const second = line.indexOf(':', first + 1)
              if (first <= 0 || second <= first) return { path: line, kind: 'match' as const }
              return {
                path: line.slice(0, first),
                line: Number.parseInt(line.slice(first + 1, second), 10) || undefined,
                text: line.slice(second + 1),
                kind: 'match' as const
              }
            })
    return {
      kind: 'grep',
      matches,
      meta: buildSearchMeta({
        engine: 'grep',
        searchRoot: root,
        pattern,
        include,
        outputMode,
        truncated,
        limitReason: truncated ? 'max_results' : null,
        maxResults,
        timedOut: result.timing?.timedOut === true
      })
    }
  } catch (err) {
    return {
      kind: 'grep',
      matches: [],
      meta: buildSearchMeta({ engine: 'grep', searchRoot: searchPathInput, pattern, outputMode }),
      error: errorMessage(err)
    }
  }
}

// ── Dispatch ──

export const LOCAL_SSH_FS_METHODS = new Set([
  'ssh/fs-read-file',
  'ssh/fs-read-text-file-lines',
  'ssh/fs-stat-path',
  'ssh/fs-write-file',
  'ssh/fs-read-file-binary',
  'ssh/fs-write-file-binary',
  'ssh/fs-list-dir',
  'ssh/fs-home-dir',
  'ssh/fs-resolve-path',
  'ssh/fs-mkdir',
  'ssh/fs-delete',
  'ssh/fs-move',
  'ssh/fs-download',
  'ssh/fs-glob',
  'ssh/fs-grep',
  'ssh/test-connection'
])

export async function localSshFsRequest(
  method: string,
  connectionId: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  switch (method) {
    case 'ssh/fs-read-file':
      return fsReadFile(connectionId, params)
    case 'ssh/fs-read-text-file-lines':
      return fsReadTextFileLines(connectionId, params)
    case 'ssh/fs-stat-path':
      return fsStatPath(connectionId, params)
    case 'ssh/fs-write-file':
      return fsWriteFile(connectionId, params)
    case 'ssh/fs-read-file-binary':
      return fsReadFileBinary(connectionId, params)
    case 'ssh/fs-write-file-binary':
      return fsWriteFileBinary(connectionId, params)
    case 'ssh/fs-list-dir':
      return fsListDir(connectionId, params)
    case 'ssh/fs-home-dir':
      return fsHomeDir(connectionId)
    case 'ssh/fs-resolve-path':
      return fsResolvePath(connectionId, params)
    case 'ssh/fs-mkdir':
      return fsMkdir(connectionId, params)
    case 'ssh/fs-delete':
      return fsDelete(connectionId, params)
    case 'ssh/fs-move':
      return fsMove(connectionId, params)
    case 'ssh/fs-download':
      return fsDownload(connectionId, params)
    case 'ssh/fs-glob':
      return fsGlob(connectionId, params)
    case 'ssh/fs-grep':
      return fsGrep(connectionId, params)
    case 'ssh/test-connection':
      return testSshConnection(connectionId)
    default:
      throw new Error(`Unsupported local SSH fs method: ${method}`)
  }
}
