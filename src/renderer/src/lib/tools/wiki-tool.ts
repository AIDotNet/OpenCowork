import { toolRegistry } from '../agent/tool-registry'
import { useChatStore } from '@renderer/stores/chat-store'
import { IPC } from '../ipc/channels'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function getProjectIdFromContext(sessionId?: string): string | null {
  const store = useChatStore.getState()
  const session = sessionId ? store.sessions.find((item) => item.id === sessionId) : undefined
  return session?.projectId ?? store.activeProjectId ?? null
}

function parseSourceFiles(raw?: string): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

const wikiListDocumentsHandler: ToolHandler = {
  definition: {
    name: 'WikiListDocuments',
    description:
      'List all wiki documents for the current project. Returns document name and description.',
    inputSchema: { type: 'object', properties: {} }
  },
  execute: async (_input, ctx) => {
    const projectId = getProjectIdFromContext(ctx.sessionId)
    if (!projectId) return encodeToolError('No active project for wiki lookup')
    const rows = (await ctx.ipc.invoke(IPC.DB_WIKI_LIST_DOCUMENTS, projectId)) as Array<{
      name: string
      description: string
      parent_id: string | null
      is_leaf: number
      level: number
      source_files_json?: string
    }>
    return encodeStructuredToolResult(
      rows.map((row) => ({
        name: row.name,
        description: row.description,
        parentId: row.parent_id,
        level: row.level,
        isLeaf: row.is_leaf === 1,
        sourceFiles: row.is_leaf === 1 ? parseSourceFiles(row.source_files_json) : []
      }))
    )
  },
  requiresApproval: () => false
}

const wikiGetDocumentByNameHandler: ToolHandler = {
  definition: {
    name: 'WikiGetDocumentByName',
    description:
      'Get a wiki document by name for the current project. Returns content and source file list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact wiki document name' }
      },
      required: ['name']
    }
  },
  execute: async (input, ctx) => {
    const name = String(input.name ?? '').trim()
    if (!name) return encodeToolError('name is required')
    const projectId = getProjectIdFromContext(ctx.sessionId)
    if (!projectId) return encodeToolError('No active project for wiki lookup')
    const document = (await ctx.ipc.invoke(IPC.DB_WIKI_GET_DOCUMENT_BY_NAME, {
      projectId,
      name
    })) as {
      id: string
      name: string
      description: string
      content_markdown: string
      is_leaf: number
      source_files_json?: string
    } | null
    if (!document) return encodeToolError(`Wiki document not found: ${name}`)
    const sections = (await ctx.ipc.invoke(IPC.DB_WIKI_LIST_SECTIONS, document.id)) as Array<{
      id: string
    }>
    const sourceSet = new Set<string>(parseSourceFiles(document.source_files_json))
    for (const section of sections) {
      const sources = (await ctx.ipc.invoke(
        IPC.DB_WIKI_LIST_SECTION_SOURCES,
        section.id
      )) as Array<{
        file_path: string
      }>
      for (const source of sources) sourceSet.add(source.file_path)
    }
    return encodeStructuredToolResult({
      name: document.name,
      description: document.description,
      isLeaf: document.is_leaf === 1,
      content: document.content_markdown,
      sourceFiles: Array.from(sourceSet)
    })
  },
  requiresApproval: () => false
}

let registered = false

export function registerWikiTools(): void {
  if (registered) return
  registered = true
  toolRegistry.register(wikiListDocumentsHandler)
  toolRegistry.register(wikiGetDocumentByNameHandler)
}

export function unregisterWikiTools(): void {
  if (!registered) return
  registered = false
  toolRegistry.unregister('WikiListDocuments')
  toolRegistry.unregister('WikiGetDocumentByName')
}

export function updateWikiToolRegistration(enabled: boolean): void {
  if (enabled) registerWikiTools()
  else unregisterWikiTools()
}
