import type { ContentBlock, ToolUseBlock } from '@renderer/lib/api/types'
import type { ToolCallState } from '@renderer/lib/agent/types'

const EMPTY_TOOL_USES: ToolUseBlock[] = []

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function collectFunctionCalls(value: unknown, target: Map<string, ToolUseBlock>): void {
  if (!value) return
  if (Array.isArray(value)) {
    for (const entry of value) collectFunctionCalls(entry, target)
    return
  }
  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  const name = typeof record.name === 'string' ? record.name : ''
  const callId =
    (typeof record.call_id === 'string' && record.call_id) ||
    (typeof record.callId === 'string' && record.callId) ||
    (typeof record.id === 'string' && record.id) ||
    ''

  if ((type === 'function_call' || type === 'tool_use') && callId && name) {
    target.set(callId, {
      type: 'tool_use',
      id: callId,
      name,
      input: parseJsonObject(record.arguments ?? record.input)
    })
  }

  const toolCalls = record.tool_calls
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== 'object') continue
      const item = toolCall as Record<string, unknown>
      const fn = item.function
      const fnRecord = fn && typeof fn === 'object' ? (fn as Record<string, unknown>) : null
      const toolId = typeof item.id === 'string' ? item.id : ''
      const toolName =
        (fnRecord && typeof fnRecord.name === 'string' && fnRecord.name) ||
        (typeof item.name === 'string' ? item.name : '')
      if (!toolId || !toolName) continue
      target.set(toolId, {
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: parseJsonObject(fnRecord?.arguments ?? item.arguments ?? item.input)
      })
    }
  }

  if (Array.isArray(record.input)) collectFunctionCalls(record.input, target)
  if (Array.isArray(record.messages)) collectFunctionCalls(record.messages, target)
  if (Array.isArray(record.output)) collectFunctionCalls(record.output, target)
}

export function parseFunctionCallsFromRequestDebugBody(
  body: string | undefined
): Map<string, ToolUseBlock> {
  const found = new Map<string, ToolUseBlock>()
  if (!body?.trim()) return found
  try {
    collectFunctionCalls(JSON.parse(body) as unknown, found)
  } catch {
    return found
  }
  return found
}

export function listOrphanToolResultIds(
  blocks: ContentBlock[] | null,
  toolResults?: Map<string, unknown> | null
): string[] {
  if (!blocks || !toolResults || toolResults.size === 0) return []
  const existing = new Set<string>()
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.id) existing.add(block.id)
  }
  const orphans: string[] = []
  for (const id of toolResults.keys()) {
    if (id && !existing.has(id)) orphans.push(id)
  }
  return orphans
}

export function resolveOrphanToolUses(options: {
  orphanIds: readonly string[]
  toolCalls?: readonly ToolCallState[]
  debugToolUses?: Map<string, ToolUseBlock>
}): ToolUseBlock[] {
  if (options.orphanIds.length === 0) return EMPTY_TOOL_USES

  const byId = new Map<string, ToolUseBlock>()
  for (const toolCall of options.toolCalls ?? []) {
    if (!toolCall.id || !toolCall.name) continue
    byId.set(toolCall.id, {
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input ?? {},
      ...(toolCall.extraContent ? { extraContent: toolCall.extraContent } : {})
    })
  }
  if (options.debugToolUses) {
    for (const [id, block] of options.debugToolUses) {
      if (!byId.has(id)) byId.set(id, block)
    }
  }

  const resolved: ToolUseBlock[] = []
  for (const id of options.orphanIds) {
    const block = byId.get(id)
    if (block) resolved.push(block)
  }
  return resolved
}

export function insertOrphanToolUseBlocks(
  blocks: ContentBlock[],
  orphans: readonly ToolUseBlock[]
): ContentBlock[] {
  if (orphans.length === 0) return blocks

  const existing = new Set<string>()
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.id) existing.add(block.id)
  }
  const toInsert = orphans.filter((block) => block.id && !existing.has(block.id))
  if (toInsert.length === 0) return blocks

  let insertAt = blocks.length
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].type === 'text') {
      insertAt = index
      continue
    }
    break
  }

  return [...blocks.slice(0, insertAt), ...toInsert, ...blocks.slice(insertAt)]
}
