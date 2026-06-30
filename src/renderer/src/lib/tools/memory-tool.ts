import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

const MEMORY_READ_FILES = ['memory_summary.md', 'MEMORY.md', 'USER.md', 'raw_memories.md'] as const

function encodeNativeOnlyMemoryResult(toolName: string): string {
  return encodeStructuredToolResult({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

const listHandler: ToolHandler = {
  definition: {
    name: 'MemoryList',
    description:
      'List available OpenCowork memory roots. Use before reading memory so citations can distinguish global and project memory.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'project', 'both'],
          description: 'Which memory scope to list. Defaults to both.'
        }
      },
      required: []
    }
  },
  execute: async () => encodeNativeOnlyMemoryResult('MemoryList'),
  requiresApproval: () => false
}

const readHandler: ToolHandler = {
  definition: {
    name: 'MemoryRead',
    description:
      'Read a scoped OpenCowork memory file. The result includes scope, memoryRootId, path, and numbered lines for citation.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project', 'both'] },
        memoryRootId: { type: 'string', description: 'Specific memory root id from MemoryList' },
        file: {
          type: 'string',
          enum: [...MEMORY_READ_FILES],
          description: 'Memory file to read. Defaults to memory_summary.md.'
        }
      },
      required: []
    }
  },
  execute: async () => encodeNativeOnlyMemoryResult('MemoryRead'),
  requiresApproval: () => false
}

const searchHandler: ToolHandler = {
  definition: {
    name: 'MemorySearch',
    description:
      'Search scoped OpenCowork memory files. Results include scope, memoryRootId, path, line, and text for citation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to search for' },
        scope: { type: 'string', enum: ['global', 'project', 'both'] },
        limit: { type: 'number', description: 'Maximum matches to return, default 20' }
      },
      required: ['query']
    }
  },
  execute: async () => encodeNativeOnlyMemoryResult('MemorySearch'),
  requiresApproval: () => false
}

export function registerMemoryTools(): void {
  toolRegistry.register(listHandler)
  toolRegistry.register(readHandler)
  toolRegistry.register(searchHandler)
}
