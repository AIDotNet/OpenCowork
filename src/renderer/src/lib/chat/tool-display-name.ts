import { isMcpTool, parseMcpToolName } from '@renderer/lib/mcp/mcp-tools'

/**
 * A tool label names the tool the model called, so it stays in English across every
 * locale. Only the surrounding detail, counts and status text are translated.
 */
export function toolDisplayName(name: string): string {
  return isMcpTool(name) ? mcpToolDisplayName(name) : name
}

/** `mcp__server__get_issue` reads as `Get issue` — the server prefix is ambient context. */
export function mcpToolDisplayName(name: string): string {
  const parsed = parseMcpToolName(name)
  const toolName = parsed?.toolName ?? name
  const label = toolName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .join(' ')
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : toolName
}

/** Camel-case tool identifiers used as card titles read better spaced: `Browser Navigate`. */
export function toolTitleFromName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}
