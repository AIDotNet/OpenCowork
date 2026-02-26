import { toolRegistry } from '../agent/tool-registry'
import { IPC } from '../ipc/channels'
import type { ToolHandler } from './tool-types'

const globHandler: ToolHandler = {
  definition: {
    name: 'Glob',
    description: 'Fast file pattern matching tool',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: { type: 'string', description: 'Optional search directory' },
      },
      required: ['pattern'],
    },
  },
  execute: async (input, ctx) => {
    if (ctx.sshConnectionId) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_GLOB, {
        connectionId: ctx.sshConnectionId,
        pattern: input.pattern,
        path: input.path ?? ctx.workingFolder,
      })
      return JSON.stringify(result)
    }
    const result = await ctx.ipc.invoke(IPC.FS_GLOB, {
      pattern: input.pattern,
      path: input.path ?? ctx.workingFolder,
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
        path: { type: 'string', description: 'Directory to search in' },
        include: { type: 'string', description: 'File pattern filter, e.g. *.ts' },
      },
      required: ['pattern'],
    },
  },
  execute: async (input, ctx) => {
    if (ctx.sshConnectionId) {
      const result = await ctx.ipc.invoke(IPC.SSH_FS_GREP, {
        connectionId: ctx.sshConnectionId,
        pattern: input.pattern,
        path: input.path ?? ctx.workingFolder,
        include: input.include,
      })
      return JSON.stringify(result)
    }
    const result = await ctx.ipc.invoke(IPC.FS_GREP, {
      pattern: input.pattern,
      path: input.path ?? ctx.workingFolder,
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
