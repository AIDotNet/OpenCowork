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

export function isChatModeToolName(name: string): boolean {
  return (
    CHAT_MODE_CORE_TOOL_NAMES.has(name) || CHAT_MODE_PLUGIN_TOOL_NAMES.has(name) || isMcpTool(name)
  )
}

export function filterChatModeToolDefinitions(toolDefs: ToolDefinition[]): ToolDefinition[] {
  return toolDefs.filter((tool) => isChatModeToolName(tool.name))
}

export function buildChatModeSystemPrompt(options: {
  language?: string
  userRules?: string
  hasWebSearch: boolean
  activeMcps: Array<Pick<McpServerConfig, 'id' | 'name' | 'description' | 'transport'>>
  activeMcpTools: Record<string, Array<Pick<McpTool, 'name'>>>
}): string {
  const parts: string[] = [
    'You are OpenCowork, a helpful AI assistant.',
    `IMPORTANT: You MUST respond in ${
      options.language === 'zh' ? 'Chinese (中文)' : 'English'
    } unless the user explicitly requests otherwise.`,
    '',
    '## Chat Mode',
    '- Chat mode is conversation-first. Answer directly when tools are unnecessary.',
    '- You may use web search tools for current events, factual lookup, or source-backed answers.',
    '- You may use enabled plugin tools when they materially improve the answer.',
    '- You may use user-selected MCP tools when they materially improve the answer.',
    '- Do not claim access to Bash, terminal commands, local file reads, project search, or file editing in Chat mode.',
    '- If the request depends on filesystem inspection, shell execution, or code changes, tell the user to switch to Clarify, Cowork, or Code mode.'
  ]

  if (options.hasWebSearch) {
    parts.push('- Web search is currently enabled.')
  }

  if (options.activeMcps.length > 0) {
    parts.push('', '## Active MCP Servers')
    for (const server of options.activeMcps) {
      const toolNames = (options.activeMcpTools[server.id] ?? []).map((tool) => tool.name)
      parts.push(`- ${server.name} (${toolNames.length} tools, transport: ${server.transport})`)
      if (server.description?.trim()) {
        parts.push(`  ${server.description.trim()}`)
      }
      if (toolNames.length > 0) {
        parts.push(
          `  Available tools: ${toolNames.map((name) => `mcp__${server.id}__${name}`).join(', ')}`
        )
      }
    }
    parts.push(
      '- MCP tools require user approval before execution.',
      '- MCP tools use the `mcp__{serverId}__{toolName}` naming pattern.'
    )
  }

  if (options.userRules?.trim()) {
    parts.push('', '## Additional Instructions', options.userRules.trim())
  }

  return parts.join('\n')
}
