import type { ToolDefinition } from './api/types'
import { APP_PLUGIN_DESCRIPTORS } from './app-plugin/types'
import { PLUGIN_TOOL_DEFINITIONS } from './channel/plugin-tools'
import { isMcpTool } from './mcp/mcp-tools'
import type { McpServerConfig, McpTool } from './mcp/types'

const CHAT_MODE_CORE_TOOL_NAMES = new Set(['WebSearch', 'WebFetch'])
const CHAT_MODE_PLUGIN_TOOL_NAMES = new Set([
  ...APP_PLUGIN_DESCRIPTORS.flatMap((descriptor) => descriptor.toolNames),
  ...PLUGIN_TOOL_DEFINITIONS.map((tool) => tool.name)
])

type ChatModePromptOptions = {
  language?: string
  userRules?: string
  hasWebSearch: boolean
  hasPluginTools?: boolean
  activeMcps: Array<Pick<McpServerConfig, 'id' | 'name' | 'description' | 'transport'>>
  activeMcpTools: Record<string, Array<Pick<McpTool, 'name'>>>
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
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${stableSerializePromptCacheValue(item)}`
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function isChatModeToolName(name: string): boolean {
  return (
    CHAT_MODE_CORE_TOOL_NAMES.has(name) || CHAT_MODE_PLUGIN_TOOL_NAMES.has(name) || isMcpTool(name)
  )
}

export function hasChatModePluginTools(toolDefs: readonly Pick<ToolDefinition, 'name'>[]): boolean {
  return toolDefs.some((tool) => CHAT_MODE_PLUGIN_TOOL_NAMES.has(tool.name))
}

export function filterChatModeToolDefinitions(toolDefs: ToolDefinition[]): ToolDefinition[] {
  return toolDefs.filter((tool) => isChatModeToolName(tool.name))
}

export function buildSystemPromptContextCacheKey(options: {
  language?: string
  userRules?: string
  environmentContext?: PromptCacheEnvironmentContext
  activeTeam?: PromptCacheTeamSnapshot | null
  memorySnapshot?: unknown
}): string {
  return stableSerializePromptCacheValue({
    language: options.language === 'zh' ? 'zh' : 'en',
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
    language: options.language === 'zh' ? 'zh' : 'en',
    userRules: normalizeUserRules(options.userRules),
    hasWebSearch: options.hasWebSearch,
    hasPluginTools: Boolean(options.hasPluginTools),
    activeMcps: options.activeMcps
      .map((server) => ({
        id: server.id,
        name: server.name,
        description: server.description?.trim() || '',
        transport: server.transport
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    activeMcpTools: Object.fromEntries(
      Object.entries(options.activeMcpTools)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([serverId, tools]) => [
          serverId,
          tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right))
        ])
    )
  })
}

export function buildChatModeSystemPrompt(options: ChatModePromptOptions): string {
  const parts: string[] = [
    'You are OpenCowork, a helpful AI assistant. Be concise, accurate, and friendly.',
    `IMPORTANT: You MUST respond in ${
      options.language === 'zh' ? 'Chinese (中文)' : 'English'
    } unless the user explicitly requests otherwise.`,
    'Before responding, follow this thinking process: (1) Understand — identify what the user truly needs, not just the literal words; consider context and implicit constraints. (2) Expand — think about the best way to solve the problem, consider edge cases, potential pitfalls, and better alternatives the user may not have thought of. (3) Validate — before finalizing, verify your answer is logically consistent: does it actually help the user achieve their stated goal? Check the full causal chain — if the user follows your advice, will they accomplish what they want? Watch for hidden contradictions. (4) Respond — deliver a well-reasoned, logically sound answer that best fits the user\'s real needs. Think first, answer second — never rush to conclusions.',
    'CRITICAL RULE: Before giving your final answer, always ask yourself: "If the user follows my advice step by step, will they actually achieve their stated goal?" If the answer is no, stop and reconsider.',
    'Use markdown formatting in your responses. Use code blocks with language identifiers for code.',
    '',
    '## Chat Mode',
    '- Chat mode is conversation-first. Answer directly when tools are unnecessary.'
  ]

  const userRules = normalizeUserRules(options.userRules)
  if (userRules) {
    parts.push('', '<Global Rules>\n', userRules, '\n</Global Rules>')
  }

  return parts.join('\n')
}
