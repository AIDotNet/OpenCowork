import type { ToolDefinition } from './api/types'
import { APP_PLUGIN_DESCRIPTORS } from './app-plugin/types'
import { PLUGIN_TOOL_DEFINITIONS } from './channel/plugin-tools'
import { isMcpTool } from './mcp/mcp-tools'
import type { McpServerConfig, McpTool } from './mcp/types'
import { buildMemoryContext } from './agent/dynamic-context'
import type { LayeredMemorySnapshot, SessionMemoryScope } from './agent/memory-files'
import type { PromptEnvironmentContext } from './agent/system-prompt'

const CHAT_MODE_CORE_TOOL_NAMES = new Set(['WebSearch', 'WebFetch', 'visualize_show_widget'])
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
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerializePromptCacheValue(item)}`)
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
    workingFolder: options.workingFolder?.trim() || null,
    sessionScope: options.sessionScope ?? 'main',
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
    'You are **OpenCowork**, a helpful AI assistant running inside a desktop agents application.',
    'OpenCowork is developed by the **AIDotNet** team. Core contributor: **token** (GitHub: @AIDotNet).',
    `IMPORTANT: You MUST respond in ${
      options.language === 'zh' ? 'Chinese' : 'English'
    } unless the user explicitly requests otherwise.`,
    'Be concise, accurate, warm, and grounded in the loaded user profile, persona, and memory context.',
    'Before answering, reason internally about the user intent, relevant context, hidden constraints, and whether the answer actually helps the user reach their goal. Do not expose private chain-of-thought.',
    'Use markdown formatting when it improves readability. Use fenced code blocks with language identifiers for code.',
    '',
    '## Chat Mode',
    '- Chat mode is conversation-first. Answer directly when tools are unnecessary.',
    '- Preserve the lightweight Chat boundary: do not pretend to have Code/Cowork file-editing or shell tools unless they are actually available in the provided tool list.',
    '- If the user asks for implementation work that requires broader tool access, explain the needed mode/tool boundary briefly and keep the response actionable.',
    '- Treat loaded memory and project protocol as context with higher priority than ordinary conversation history, while still following this system prompt first.'
  ]

  const environmentContext = options.environmentContext
  if (environmentContext) {
    const executionTarget =
      environmentContext.target === 'ssh'
        ? environmentContext.host
          ? `SSH Remote Host (${environmentContext.host})`
          : 'SSH Remote Host'
        : 'Local Machine'
    parts.push('', '## Environment', `- Execution Target: ${executionTarget}`)
    if (environmentContext.connectionName) {
      parts.push(`- SSH Connection: ${environmentContext.connectionName}`)
    }
    parts.push(`- Operating System: ${environmentContext.operatingSystem}`)
    parts.push(`- Shell: ${environmentContext.shell}`)
    if (environmentContext.target === 'ssh') {
      parts.push('- Filesystem Scope: Remote filesystem over SSH')
      if (environmentContext.pathStyle === 'posix') {
        parts.push('- Path Style: Prefer POSIX-style paths unless evidence suggests otherwise')
      } else if (environmentContext.pathStyle === 'windows') {
        parts.push('- Path Style: Prefer Windows-style paths on the remote host')
      }
      parts.push(
        "- Remote Guidance: Do not assume the local computer's OS, shell, paths, or home directory when SSH is active."
      )
    }
  }

  const workingFolder = options.workingFolder?.trim()
  if (workingFolder) {
    parts.push(
      '',
      '## Working Folder',
      `\`${workingFolder}\``,
      'Resolve relative paths against this folder when discussing project files.'
    )
  }

  const memoryContext = options.memorySnapshot
    ? buildMemoryContext(options.memorySnapshot, options.sessionScope ?? 'main')
    : null
  if (memoryContext) {
    parts.push('', memoryContext)
  }

  const userRules = normalizeUserRules(options.userRules)
  if (userRules) {
    parts.push(
      '',
      '<user_rules>',
      'The following are user-defined rules. Follow them unless they conflict with higher-priority system instructions.',
      userRules,
      '</user_rules>'
    )
  }

  return parts.join('\n')
}
