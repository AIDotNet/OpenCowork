import type { ToolDefinition } from './api/types'
import { APP_PLUGIN_DESCRIPTORS } from './app-plugin/types'
import { PLUGIN_TOOL_DEFINITIONS } from './channel/plugin-tools'
import { isMcpTool } from './mcp/mcp-tools'
import type { McpServerConfig, McpTool } from './mcp/types'
import type { LayeredMemorySnapshot, SessionMemoryScope } from './agent/memory-files'
import type { PromptEnvironmentContext } from './agent/system-prompt'
import { normalizeLanguageCode, resolveLanguageName } from './i18n-language'
import { buildChatModeSystemPrompt as buildSharedChatModeSystemPrompt } from '../../../shared/agent-system-prompt'

const CHAT_MODE_CORE_TOOL_NAMES = new Set([
  'WebSearch',
  'WebFetch',
  'visualize_show_widget',
  'MemoryList',
  'MemoryRead',
  'MemorySearch'
])
const CHAT_MODE_PLUGIN_TOOL_NAMES = new Set([
  ...APP_PLUGIN_DESCRIPTORS.flatMap((descriptor) => descriptor.toolNames),
  ...PLUGIN_TOOL_DEFINITIONS.map((tool) => tool.name)
])

type ChatModePromptOptions = {
  language?: string
  userRules?: string
  workingFolder?: string
  environmentContext?: PromptEnvironmentContext
  memorySnapshot?: LayeredMemorySnapshot
  sessionScope?: SessionMemoryScope
  planMode?: boolean
  hasWebSearch: boolean
  hasPluginTools?: boolean
  activeMcps?: Array<Pick<McpServerConfig, 'id' | 'name' | 'description' | 'transport'>>
  activeMcpTools?: Record<string, Array<Pick<McpTool, 'name'>>>
}

type PromptCacheEnvironmentContext = {
  target: string
  operatingSystem: string
  shell: string
  host?: string
  connectionName?: string
  pathStyle?: string
}

type PromptCacheTeamSnapshot = {
  name: string
  permissionMode?: string
  defaultBackend?: string
  members?: string[]
}

function normalizeUserRules(userRules?: string): string {
  return userRules?.trim() || ''
}

export function stableSerializePromptCacheValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializePromptCacheValue(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerializePromptCacheValue(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function isChatModeToolName(name: string): boolean {
  return (
    CHAT_MODE_CORE_TOOL_NAMES.has(name) ||
    CHAT_MODE_PLUGIN_TOOL_NAMES.has(name) ||
    isMcpTool(name) ||
    name.startsWith('extension__')
  )
}

export function hasChatModePluginTools(toolDefs: readonly Pick<ToolDefinition, 'name'>[]): boolean {
  return toolDefs.some((tool) => CHAT_MODE_PLUGIN_TOOL_NAMES.has(tool.name))
}

export function filterChatModeToolDefinitions(toolDefs: ToolDefinition[]): ToolDefinition[] {
  return toolDefs.filter((tool) => isChatModeToolName(tool.name))
}

export function buildToolDefinitionCacheKey(
  toolDefs: readonly Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>[]
): string {
  return stableSerializePromptCacheValue(
    toolDefs
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  )
}

export function haveSameToolDefinitions(
  left: readonly Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>[],
  right: readonly Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>[]
): boolean {
  if (left.length !== right.length) return false
  return buildToolDefinitionCacheKey(left) === buildToolDefinitionCacheKey(right)
}

export function buildSystemPromptContextCacheKey(options: {
  language?: string
  userRules?: string
  environmentContext?: PromptCacheEnvironmentContext
  activeTeam?: PromptCacheTeamSnapshot | null
  memorySnapshot?: unknown
}): string {
  return stableSerializePromptCacheValue({
    language: normalizeLanguageCode(options.language),
    userRules: normalizeUserRules(options.userRules),
    memorySnapshot: options.memorySnapshot ?? null,
    environmentContext: options.environmentContext
      ? {
          target: options.environmentContext.target,
          operatingSystem: options.environmentContext.operatingSystem,
          shell: options.environmentContext.shell,
          host: options.environmentContext.host,
          connectionName: options.environmentContext.connectionName,
          pathStyle: options.environmentContext.pathStyle
        }
      : null,
    activeTeam: options.activeTeam
      ? {
          name: options.activeTeam.name,
          permissionMode: options.activeTeam.permissionMode,
          defaultBackend: options.activeTeam.defaultBackend,
          members: options.activeTeam.members ?? []
        }
      : null
  })
}

export function buildChatModePromptContextCacheKey(options: ChatModePromptOptions): string {
  return stableSerializePromptCacheValue({
    language: normalizeLanguageCode(options.language),
    userRules: normalizeUserRules(options.userRules),
    workingFolder: options.workingFolder?.trim() || null,
    sessionScope: options.sessionScope ?? 'main',
    planMode: Boolean(options.planMode),
    memorySnapshot: options.memorySnapshot ?? null,
    environmentContext: options.environmentContext
      ? {
          target: options.environmentContext.target,
          operatingSystem: options.environmentContext.operatingSystem,
          shell: options.environmentContext.shell,
          host: options.environmentContext.host,
          connectionName: options.environmentContext.connectionName,
          pathStyle: options.environmentContext.pathStyle
        }
      : null,
    hasWebSearch: options.hasWebSearch,
    hasPluginTools: Boolean(options.hasPluginTools),
    activeMcps: (options.activeMcps ?? [])
      .map((server) => ({
        id: server.id,
        name: server.name,
        description: server.description?.trim() || '',
        transport: server.transport
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    activeMcpTools: Object.fromEntries(
      Object.entries(options.activeMcpTools ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([serverId, tools]) => [
          serverId,
          tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right))
        ])
    )
  })
}

export function buildChatModeSystemPrompt(options: ChatModePromptOptions): string {
  return buildSharedChatModeSystemPrompt({
    languageName: resolveLanguageName(options.language),
    userRules: options.userRules,
    workingFolder: options.workingFolder,
    environmentContext: options.environmentContext
  })
}
