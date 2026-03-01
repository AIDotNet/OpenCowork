import { toolRegistry } from '../agent/tool-registry'
import { joinFsPath } from '../agent/memory-files'
import { IPC } from '../ipc/channels'
import type { ToolHandler, ToolContext } from './tool-types'

// ── SSH routing helper ──

function isSsh(ctx: ToolContext): boolean {
  return !!ctx.sshConnectionId
}

function sshArgs(ctx: ToolContext, extra: Record<string, unknown>): Record<string, unknown> {
  return { connectionId: ctx.sshConnectionId, ...extra }
}

// ── Plugin path permission helpers ──

function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  if (/^[a-zA-Z]:/.test(normalized)) normalized = normalized.toLowerCase()
  return normalized
}

function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/') || p.startsWith('\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(p)
}

function resolveToolPath(inputPath: unknown, workingFolder?: string): string {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const base = workingFolder?.trim()
  if (!raw || raw === '.') {
    return base && base.length > 0 ? base : '.'
  }
  if (isAbsolutePath(raw)) return raw
  if (base && base.length > 0) return joinFsPath(base, raw)
  return raw
}

function isPluginPathAllowed(
  targetPath: string,
  ctx: ToolContext,
  mode: 'read' | 'write'
): boolean {
  const perms = ctx.pluginPermissions
  if (!perms) return true // No plugin context — defer to normal approval logic

  if (!targetPath) return mode === 'read'
  const normalized = normalizePath(targetPath)
  const normalizedWorkDir = ctx.workingFolder ? normalizePath(ctx.workingFolder) : ''
  const normalizedHome = ctx.pluginHomedir ? normalizePath(ctx.pluginHomedir) : ''

  // Always allow access within plugin working directory
  if (normalizedWorkDir && (normalized + '/').startsWith(normalizedWorkDir + '/')) return true

  const homePrefix = normalizedHome.length > 0 ? normalizedHome + '/' : ''
  const isUnderHome = homePrefix.length > 0 && (normalized + '/').startsWith(homePrefix)

  if (mode === 'read') {
    if (!isUnderHome) return true
    if (perms.allowReadHome) return true
    return perms.readablePathPrefixes.some((prefix) => {
      const np = normalizePath(prefix)
      return (normalized + '/').startsWith(np + '/')
    })
  }

  // Write mode
  if (isUnderHome && !perms.allowWriteOutside) return false
  return perms.allowWriteOutside
}

const readHandler: ToolHandler = {
  definition: {
    name: 'Read',
    description: 'Read a file from the filesystem',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path or relative to the working folder' },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  execute: async (input, ctx) => {
    const resolvedPath = resolveToolPath(input.file_path, ctx.workingFolder)
    if (isSsh(ctx)) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_READ_FILE, sshArgs(ctx, {
        path: resolvedPath,
        offset: input.offset,
        limit: input.limit,
      }))
      if (isErrorResult(result)) throw new Error(`Read failed: ${result.error}`)
      return String(result)
    }
    const result = await ctx.ipc.invoke(IPC.FS_READ_FILE, {
      path: resolvedPath,
      offset: input.offset,
      limit: input.limit,
    })
    // IPC returns { type: 'image', mediaType, data } for image files
    if (result && typeof result === 'object' && (result as Record<string, unknown>).type === 'image') {
      const img = result as { mediaType: string; data: string }
      return [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, mediaType: img.mediaType, data: img.data },
        },
      ]
    }
    return String(result)
  },
  requiresApproval: (input, ctx) => {
    // Plugin context: check read permission
    if (ctx.pluginPermissions) {
      const filePath = resolveToolPath(input.file_path, ctx.workingFolder)
      return !isPluginPathAllowed(filePath, ctx, 'read')
    }
    return false
  },
}

const writeHandler: ToolHandler = {
  definition: {
    name: 'Write',
    description: 'Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file\'s contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path or relative to the working folder' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  execute: async (input, ctx) => {
    if (typeof input.file_path !== 'string' || input.file_path.trim().length === 0) {
      throw new Error('Write requires a non-empty "file_path" string')
    }
    if (typeof input.content !== 'string') {
      throw new Error('Write requires a "content" string')
    }

    const resolvedPath = resolveToolPath(input.file_path, ctx.workingFolder)

    if (isSsh(ctx)) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_WRITE_FILE, sshArgs(ctx, {
        path: resolvedPath,
        content: input.content,
      }))
      if (isErrorResult(result)) throw new Error(`Write failed: ${result.error}`)
      return JSON.stringify({ success: true, path: resolvedPath })
    }
    const result = await ctx.ipc.invoke(IPC.FS_WRITE_FILE, {
      path: resolvedPath,
      content: input.content,
    })
    if (isErrorResult(result)) {
      throw new Error(`Write failed: ${result.error}`)
    }

    return JSON.stringify({ success: true, path: resolvedPath })
  },
  requiresApproval: (input, ctx) => {
    const filePath = resolveToolPath(input.file_path, ctx.workingFolder)
    // Plugin context: check write permission
    if (ctx.pluginPermissions) {
      return !isPluginPathAllowed(filePath, ctx, 'write')
    }
    // Normal sessions: writing outside working folder requires approval
    if (!ctx.workingFolder) return true
    return !filePath.startsWith(ctx.workingFolder)
  },
}

const editHandler: ToolHandler = {
  definition: {
    name: 'Edit',
    description: 'Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`. \n- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path or relative to the working folder'
        },
        old_string: {
          type: 'string',
          description: "The text to replace"
        },
        new_string: {
          type: 'string',
          description: "The text to replace it with (must be different from old_string)"
        },
        replace_all: { type: 'boolean', description: 'Replace all occurences of old_string (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  execute: async (input, ctx) => {
    const resolvedPath = resolveToolPath(input.file_path, ctx.workingFolder)
    // Read file, perform replacement, write back
    const readCh = isSsh(ctx) ? IPC.SSH_FS_READ_FILE : IPC.FS_READ_FILE
    const readArgs = isSsh(ctx) ? sshArgs(ctx, { path: resolvedPath }) : { path: resolvedPath }
    const content = String(await ctx.ipc.invoke(readCh, readArgs))
    const oldStr = String(input.old_string)
    const newStr = String(input.new_string)
    const replaceAll = Boolean(input.replace_all)

    let updated: string
    if (replaceAll) {
      updated = content.split(oldStr).join(newStr)
    } else {
      const idx = content.indexOf(oldStr)
      if (idx === -1) {
        return JSON.stringify({ error: 'old_string not found in file' })
      }
      updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length)
    }

    const writeCh = isSsh(ctx) ? IPC.SSH_FS_WRITE_FILE : IPC.FS_WRITE_FILE
    const writeArgs = isSsh(ctx)
      ? sshArgs(ctx, { path: resolvedPath, content: updated })
      : { path: resolvedPath, content: updated }
    await ctx.ipc.invoke(writeCh, writeArgs)
    return JSON.stringify({ success: true })
  },
  requiresApproval: (input, ctx) => {
    if (isSsh(ctx)) return false // SSH sessions: trust working folder
    const filePath = resolveToolPath(input.file_path, ctx.workingFolder)
    // Plugin context: check write permission
    if (ctx.pluginPermissions) {
      return !isPluginPathAllowed(filePath, ctx, 'write')
    }
    if (!ctx.workingFolder) return true
    return !filePath.startsWith(ctx.workingFolder)
  },
}

const lsHandler: ToolHandler = {
  definition: {
    name: 'LS',
    description: 'List files and directories in a given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or relative to the working folder' },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns to ignore',
        },
      },
      required: [],
    },
  },
  execute: async (input, ctx) => {
    const resolvedPath = resolveToolPath(input.path, ctx.workingFolder)
    if (isSsh(ctx)) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_LIST_DIR, sshArgs(ctx, {
        path: resolvedPath,
      }))
      return JSON.stringify(result)
    }
    const result = await ctx.ipc.invoke(IPC.FS_LIST_DIR, {
      path: resolvedPath,
      ignore: input.ignore,
    })
    return JSON.stringify(result)
  },
  requiresApproval: (input, ctx) => {
    if (ctx.pluginPermissions) {
      const targetPath = resolveToolPath(input.path, ctx.workingFolder)
      return !isPluginPathAllowed(targetPath, ctx, 'read')
    }
    return false
  },
}

export function registerFsTools(): void {
  toolRegistry.register(readHandler)
  toolRegistry.register(writeHandler)
  toolRegistry.register(editHandler)
  toolRegistry.register(lsHandler)
}

function isErrorResult(value: unknown): value is { error: string } {
  if (!value || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0
}
