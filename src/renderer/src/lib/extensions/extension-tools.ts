import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { encodeToolError } from '@renderer/lib/tools/tool-result-format'
import type { ExtensionInstance, ExtensionToolDefinition } from '../../../../shared/extension-types'
import {
  resolveEffectiveActiveExtensionIds,
  useExtensionStore
} from '@renderer/stores/extension-store'
import { useChatStore } from '@renderer/stores/chat-store'
import type { ToolDefinition } from '@renderer/lib/api/types'

const EXTENSION_TOOL_PREFIX = 'extension__'
let registeredExtensionToolNames: string[] = []
let refreshPromise: Promise<void> | null = null

type ObjectInputSchema = Extract<
  ToolHandler['definition']['inputSchema'],
  { properties: Record<string, unknown> }
>

export function extensionToolName(extensionId: string, toolName: string): string {
  return `${EXTENSION_TOOL_PREFIX}${extensionId}__${toolName}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeObjectInputSchema(schema: Record<string, unknown>): ObjectInputSchema {
  return {
    type: 'object',
    properties: isRecord(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof schema.additionalProperties === 'boolean'
      ? { additionalProperties: schema.additionalProperties }
      : {})
  }
}

function normalizeToolInputSchema(
  schema: Record<string, unknown>
): ToolHandler['definition']['inputSchema'] {
  if (Array.isArray(schema.oneOf)) {
    const oneOf = schema.oneOf
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => normalizeObjectInputSchema(item))
    if (oneOf.length > 0) {
      return {
        type: 'object',
        oneOf
      }
    }
  }
  return normalizeObjectInputSchema(schema)
}

function isReadOnlyTool(tool: ExtensionToolDefinition): boolean {
  if (typeof tool.readOnly === 'boolean') return tool.readOnly
  if (tool.kind === 'http') return (tool.http?.method ?? 'GET').toUpperCase() === 'GET'
  return false
}

function nativeOnlyExtensionResult(toolName: string): string {
  return encodeToolError(
    `${toolName} executes in the .NET Native Worker and is unavailable through the renderer boundary.`
  )
}

function createExtensionToolHandler(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition
): ToolHandler {
  return {
    definition: {
      name: extensionToolName(extension.id, tool.name),
      description: `[Extension: ${extension.manifest.name}] ${tool.description}`,
      inputSchema: normalizeToolInputSchema(tool.inputSchema)
    },
    execute: async () => nativeOnlyExtensionResult(extensionToolName(extension.id, tool.name)),
    requiresApproval: () => !isReadOnlyTool(tool)
  }
}

/**
 * Resolve Extension definitions for an explicit project. This is the request-scoped path: passing
 * null intentionally selects the global scope and never falls back to the foreground project.
 */
export async function buildExtensionToolDefinitionsForProject(
  projectId: string | null
): Promise<ToolDefinition[]> {
  if (!useExtensionStore.getState().loaded) {
    await useExtensionStore.getState().loadExtensions()
  }
  const state = useExtensionStore.getState()
  const activeIds = new Set(
    resolveEffectiveActiveExtensionIds({
      projectId,
      activeExtensionIdsByProject: state.activeExtensionIdsByProject,
      extensions: state.extensions
    })
  )
  return state.extensions
    .filter((extension) => extension.enabled && activeIds.has(extension.id))
    .flatMap((extension) =>
      extension.manifest.tools.map((tool) => createExtensionToolHandler(extension, tool).definition)
    )
}

export function replaceExtensionToolDefinitions(
  definitions: readonly ToolDefinition[],
  scopedExtensions: readonly ToolDefinition[]
): ToolDefinition[] {
  const result = definitions.filter((tool) => !tool.name.startsWith(EXTENSION_TOOL_PREFIX))
  const names = new Set(result.map((tool) => tool.name))
  for (const definition of scopedExtensions) {
    if (names.has(definition.name)) {
      throw new Error(`Extension Tool wireName conflicts with another Tool: ${definition.name}`)
    }
    names.add(definition.name)
    result.push(definition)
  }
  return result
}

export function unregisterExtensionTools(): void {
  for (const name of registeredExtensionToolNames) {
    toolRegistry.unregister(name)
  }
  registeredExtensionToolNames = []
}

export async function refreshExtensionTools(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    await useExtensionStore.getState().loadExtensions()
    unregisterExtensionTools()

    const extensionStore = useExtensionStore.getState()
    const activeProjectId = useChatStore.getState().activeProjectId ?? null
    const activeExtensionIds = new Set(extensionStore.getActiveExtensionIds(activeProjectId))
    const names: string[] = []
    for (const extension of extensionStore.extensions) {
      if (!extension.enabled || !activeExtensionIds.has(extension.id)) continue
      for (const tool of extension.manifest.tools) {
        const handler = createExtensionToolHandler(extension, tool)
        toolRegistry.register(handler)
        names.push(handler.definition.name)
      }
    }
    registeredExtensionToolNames = names
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

export function isExtensionToolsRegistered(): boolean {
  return registeredExtensionToolNames.length > 0
}
