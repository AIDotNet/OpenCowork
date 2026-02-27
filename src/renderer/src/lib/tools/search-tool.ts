import { toolRegistry } from '../agent/tool-registry'
import { joinFsPath } from '../agent/memory-files'
import { IPC } from '../ipc/channels'
import type { ToolHandler } from './tool-types'

function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/') || p.startsWith('\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(p)
}

function resolveSearchPath(inputPath: unknown, workingFolder?: string): string | undefined {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  const base = workingFolder?.trim()
  if (!raw || raw === '.') {
    return base && base.length > 0 ? base : undefined
  }
  if (isAbsolutePath(raw)) return raw
  if (base && base.length > 0) return joinFsPath(base, raw)
  return raw
}

const globHandler: ToolHandler = {
  definition: {
    name: 'Glob',
    description: 'Fast file pattern matching tool',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: { type: 'string', description: 'Optional search directory (absolute or relative to the working folder)' },
      },
      required: ['pattern'],
    },
  },
  execute: async (input, ctx) => {
    const resolvedPath = resolveSearchPath(input.path, ctx.workingFolder)
    if (ctx.sshConnectionId) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_GLOB, {
        connectionId: ctx.sshConnectionId,
        pattern: input.pattern,
        path: resolvedPath,
      })
      return JSON.stringify(result)
    }
    const result = await ctx.ipc.invoke(IPC.FS_GLOB, {
      pattern: input.pattern,
      path: resolvedPath,
    })
    return JSON.stringify(result)
  },
  requiresApproval: () => false,
}

const grepHandler: ToolHandler = {
  definition: {
    name: 'Grep',
    description: 'Search file contents using regular expressions',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in (absolute or relative to the working folder)' },
        include: { type: 'string', description: 'File pattern filter, e.g. *.ts' },
      },
      required: ['pattern'],
    },
  },
  execute: async (input, ctx) => {
    const resolvedPath = resolveSearchPath(input.path, ctx.workingFolder)
    if (ctx.sshConnectionId) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_GREP, {
        connectionId: ctx.sshConnectionId,
        pattern: input.pattern,
        path: resolvedPath,
        include: input.include,
      })
      return JSON.stringify(result)
    }
    const result = await ctx.ipc.invoke(IPC.FS_GREP, {
      pattern: input.pattern,
      path: resolvedPath,
      include: input.include,
    })
    return JSON.stringify(result)
  },
  requiresApproval: () => false,
}

export function registerSearchTools(): void {
  toolRegistry.register(globHandler)
  toolRegistry.register(grepHandler)
}
