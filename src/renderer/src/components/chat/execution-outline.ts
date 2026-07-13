import type { ContentBlock, ToolResultContent } from '@renderer/lib/api/types'
import type { ToolCallState, ToolCallStatus } from '@renderer/lib/agent/types'
import { TASK_TOOL_NAME } from '@renderer/lib/agent/sub-agents/create-tool'
import { TEAM_TOOL_NAMES } from '@renderer/lib/agent/teams/register'
import { IMAGE_GENERATE_TOOL_NAME } from '@renderer/lib/app-plugin/types'
import { isBrowserToolName } from '@renderer/lib/app-plugin/browser-tool-names'
import { isDesktopControlToolName } from '@renderer/lib/app-plugin/desktop-routing'
import { isMcpTool } from '@renderer/lib/mcp/mcp-tools'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { inputSummary } from './tool-call-summary'

export type ToolExecutionVisibility = 'hidden' | 'ordinary' | 'force'

export type ToolExecutionCategory =
  | 'attention'
  | 'browser'
  | 'command'
  | 'context'
  | 'desktop'
  | 'file-change'
  | 'hidden'
  | 'interactive'
  | 'mcp'
  | 'orchestration'
  | 'skill'
  | 'visual'
  | 'unknown'

export interface ToolExecutionItem {
  toolUseId: string
  name: string
  blockIndex: number
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  error?: string
  summary: string
  category: ToolExecutionCategory
  visibility: ToolExecutionVisibility
  forceExpanded: boolean
  hasError: boolean
  isActive: boolean
  requiresApproval: boolean
  groupKey: string
}

export interface ToolExecutionRun {
  id: string
  startBlockIndex: number
  endBlockIndex: number
  itemIds: string[]
  ordinaryItemIds: string[]
  forceVisibleItemIds: string[]
  activeCount: number
  totalItemCount: number
  ordinaryItemCount: number
  defaultCollapsed: boolean
  showToggle: boolean
  activeSummary: string | null
}

export interface ToolExecutionOutline {
  items: ToolExecutionItem[]
  runs: ToolExecutionRun[]
  itemByToolUseId: Map<string, ToolExecutionItem>
  runById: Map<string, ToolExecutionRun>
  runByStartBlockIndex: Map<number, ToolExecutionRun>
  ordinaryItemIds: string[]
  forceVisibleItemIds: Set<string>
  activeCount: number
  totalItemCount: number
  ordinaryItemCount: number
  defaultCollapsed: boolean
  showToggle: boolean
  activeSummary: string | null
}

type ToolResultEntry = { content: ToolResultContent; isError?: boolean }

type TranslationFn = (key: string, options?: Record<string, unknown>) => string

interface BuildToolExecutionOutlineOptions {
  blocks: ContentBlock[] | null
  isStreaming?: boolean
  toolResults?: Map<string, ToolResultEntry>
  liveToolCallMap?: Map<string, ToolCallState> | null
  boundaryAfterBlockIndices?: Set<number>
  boundaryAfterToolUseIds?: Set<string>
  hiddenToolUseIds?: Set<string>
  t: TranslationFn
}

const COMMAND_TOOL_NAMES = new Set(['Bash', 'Shell', 'PowerShell'])
const HIDDEN_TOOL_NAMES = new Set(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'])
const ORDINARY_CONTEXT_TOOL_NAMES = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'MemoryList',
  'MemoryRead',
  'MemorySearch'
])
const FILE_CHANGE_TOOL_NAMES = new Set(['Write', 'Edit', 'Delete', 'NotebookEdit', 'SavePlan'])
const INTERACTIVE_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Notify'
])

export function isHiddenExecutionToolName(name: string): boolean {
  return HIDDEN_TOOL_NAMES.has(name)
}

export function isOrdinaryContextToolName(name: string): boolean {
  return (
    ORDINARY_CONTEXT_TOOL_NAMES.has(name) ||
    COMMAND_TOOL_NAMES.has(name) ||
    FILE_CHANGE_TOOL_NAMES.has(name) ||
    isMcpTool(name)
  )
}

export function isCommandToolName(name: string): boolean {
  return COMMAND_TOOL_NAMES.has(name)
}

function outputAsString(output: ToolResultContent | undefined): string | undefined {
  if (output === undefined) return undefined
  if (typeof output === 'string') return output
  const texts = output
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
  return texts.join('\n') || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasStructuredOutputError(name: string, output: ToolResultContent | undefined): boolean {
  const text = outputAsString(output)?.trim()
  if (!text) return false

  const decoded = decodeStructuredToolResult(text)
  if (!isRecord(decoded)) return false

  if (decoded.success === false) return true
  if (typeof decoded.error === 'string' && decoded.error.trim()) return true

  return (
    COMMAND_TOOL_NAMES.has(name) && typeof decoded.exitCode === 'number' && decoded.exitCode !== 0
  )
}

function resolveToolStatus(
  isStreaming: boolean | undefined,
  liveToolCall: ToolCallState | undefined,
  result: ToolResultEntry | undefined
): ToolCallStatus | 'completed' {
  if (result?.isError) return 'error'
  if (liveToolCall?.status) return liveToolCall.status
  if (!result) return isStreaming ? 'streaming' : 'canceled'
  return 'completed'
}

function getToolCategory(options: {
  name: string
  hasError: boolean
  status: ToolCallStatus | 'completed'
  requiresApproval: boolean
}): ToolExecutionCategory {
  const { name, hasError, status, requiresApproval } = options
  if (HIDDEN_TOOL_NAMES.has(name)) return 'hidden'
  if (
    hasError ||
    status === 'streaming' ||
    status === 'running' ||
    status === 'pending_approval' ||
    status === 'canceled' ||
    requiresApproval
  ) {
    return 'attention'
  }
  if (isMcpTool(name)) return 'mcp'
  if (ORDINARY_CONTEXT_TOOL_NAMES.has(name)) return 'context'
  if (FILE_CHANGE_TOOL_NAMES.has(name)) return 'file-change'
  if (COMMAND_TOOL_NAMES.has(name)) return 'command'
  if (isBrowserToolName(name)) return 'browser'
  if (isDesktopControlToolName(name)) return 'desktop'
  if (INTERACTIVE_TOOL_NAMES.has(name)) return 'interactive'
  if (name === TASK_TOOL_NAME || TEAM_TOOL_NAMES.has(name)) return 'orchestration'
  if (name === IMAGE_GENERATE_TOOL_NAME || name === 'visualize_show_widget') return 'visual'
  if (name === 'Skill') return 'skill'
  return 'unknown'
}

function getToolVisibility(category: ToolExecutionCategory): ToolExecutionVisibility {
  if (category === 'hidden') return 'hidden'
  if (
    category === 'context' ||
    category === 'mcp' ||
    category === 'command' ||
    category === 'file-change'
  ) {
    return 'ordinary'
  }
  return 'force'
}

function buildActiveSummary(item: ToolExecutionItem, t: TranslationFn): string | null {
  if (!item.isActive) return null

  const tool = t(`permission.toolLabels.${item.name}`, { defaultValue: item.name })
  const detail = item.summary ? `: ${item.summary}` : ''

  if (item.status === 'pending_approval' || item.requiresApproval) {
    return t('executionOutline.awaitingApproval', {
      tool,
      detail,
      defaultValue: 'Awaiting approval: {{tool}}{{detail}}'
    })
  }

  if (item.status === 'streaming') {
    return t('executionOutline.receiving', {
      tool,
      detail,
      defaultValue: 'Receiving {{tool}}{{detail}}'
    })
  }

  return t('executionOutline.running', {
    tool,
    detail,
    defaultValue: 'Running {{tool}}{{detail}}'
  })
}

export function buildToolExecutionOutline({
  blocks,
  isStreaming,
  toolResults,
  liveToolCallMap,
  boundaryAfterBlockIndices,
  boundaryAfterToolUseIds,
  hiddenToolUseIds,
  t
}: BuildToolExecutionOutlineOptions): ToolExecutionOutline {
  const items: ToolExecutionItem[] = []
  const runs: ToolExecutionRun[] = []
  const itemByToolUseId = new Map<string, ToolExecutionItem>()
  const runById = new Map<string, ToolExecutionRun>()
  const runByStartBlockIndex = new Map<number, ToolExecutionRun>()
  const ordinaryItemIds: string[] = []
  const forceVisibleItemIds = new Set<string>()
  let pendingRun: {
    startBlockIndex: number
    endBlockIndex: number
    itemIds: string[]
  } | null = null

  const closePendingRun = (): void => {
    if (!pendingRun) return

    const runItems = pendingRun.itemIds
      .map((toolUseId) => itemByToolUseId.get(toolUseId))
      .filter((item): item is ToolExecutionItem => !!item)
    const visibleItems = runItems.filter((item) => item.visibility !== 'hidden')

    if (visibleItems.length > 0) {
      const ordinaryRunItemIds = runItems
        .filter((item) => item.visibility === 'ordinary')
        .map((item) => item.toolUseId)
      const forceRunItemIds = runItems
        .filter((item) => item.visibility === 'force')
        .map((item) => item.toolUseId)
      const activeItems = visibleItems.filter((item) => item.isActive)
      const activeItem = activeItems[activeItems.length - 1]
      const run: ToolExecutionRun = {
        id: `tool-run:${visibleItems[0].toolUseId}`,
        startBlockIndex: pendingRun.startBlockIndex,
        endBlockIndex: pendingRun.endBlockIndex,
        itemIds: [...pendingRun.itemIds],
        ordinaryItemIds: ordinaryRunItemIds,
        forceVisibleItemIds: forceRunItemIds,
        activeCount: activeItems.length,
        totalItemCount: visibleItems.length,
        ordinaryItemCount: ordinaryRunItemIds.length,
        defaultCollapsed: ordinaryRunItemIds.length > 0,
        showToggle: ordinaryRunItemIds.length > 0,
        activeSummary: activeItem ? buildActiveSummary(activeItem, t) : null
      }

      runs.push(run)
      runById.set(run.id, run)
      runByStartBlockIndex.set(run.startBlockIndex, run)
    }

    pendingRun = null
  }

  for (let blockIndex = 0; blockIndex < (blocks?.length ?? 0); blockIndex += 1) {
    const block = blocks?.[blockIndex]
    if (!block || block.type !== 'tool_use') {
      closePendingRun()
      continue
    }

    // A Task owns a visible SubAgent card at this exact content position. Isolate it from
    // adjacent ordinary tools so a collapsed Read/Edit run can never hide or move the card.
    const isSubAgentTask = block.name === TASK_TOOL_NAME
    if (isSubAgentTask) closePendingRun()

    const result = toolResults?.get(block.id)
    const liveToolCall = liveToolCallMap?.get(block.id)
    const liveInput = liveToolCall?.input
    const input = liveInput && Object.keys(liveInput).length > 0 ? liveInput : block.input
    const output = result?.content ?? liveToolCall?.output
    const baseStatus = resolveToolStatus(isStreaming, liveToolCall, result)
    const hasError =
      baseStatus === 'error' ||
      !!result?.isError ||
      !!liveToolCall?.error ||
      hasStructuredOutputError(block.name, output)
    const status: ToolCallStatus | 'completed' = hasError ? 'error' : baseStatus
    const requiresApproval = liveToolCall?.requiresApproval === true
    const category = getToolCategory({
      name: block.name,
      hasError,
      status,
      requiresApproval
    })
    const visibility = hiddenToolUseIds?.has(block.id) ? 'hidden' : getToolVisibility(category)
    const isActive = status === 'streaming' || status === 'running' || status === 'pending_approval'
    const summary = inputSummary(block.name, input, outputAsString(output))
    const item: ToolExecutionItem = {
      toolUseId: block.id,
      name: block.name,
      blockIndex,
      input,
      output,
      status,
      error: liveToolCall?.error,
      summary,
      category,
      visibility,
      forceExpanded: hasError || isActive || requiresApproval,
      hasError,
      isActive,
      requiresApproval,
      groupKey: visibility === 'ordinary' ? `context:${block.name}` : `tool:${block.id}`
    }

    items.push(item)
    itemByToolUseId.set(block.id, item)

    if (!pendingRun) {
      pendingRun = {
        startBlockIndex: blockIndex,
        endBlockIndex: blockIndex,
        itemIds: []
      }
    }
    pendingRun.endBlockIndex = blockIndex
    pendingRun.itemIds.push(block.id)

    if (visibility === 'ordinary') {
      ordinaryItemIds.push(block.id)
    } else if (visibility === 'force') {
      forceVisibleItemIds.add(block.id)
    }

    if (
      isSubAgentTask ||
      boundaryAfterToolUseIds?.has(block.id) ||
      boundaryAfterBlockIndices?.has(blockIndex)
    ) {
      closePendingRun()
    }
  }

  closePendingRun()

  const activeItems = items.filter((item) => item.visibility !== 'hidden' && item.isActive)
  const activeItem = activeItems[activeItems.length - 1]
  const activeSummary = activeItem ? buildActiveSummary(activeItem, t) : null
  const totalItemCount = items.filter((item) => item.visibility !== 'hidden').length

  return {
    items,
    runs,
    itemByToolUseId,
    runById,
    runByStartBlockIndex,
    ordinaryItemIds,
    forceVisibleItemIds,
    activeCount: activeItems.length,
    totalItemCount,
    ordinaryItemCount: ordinaryItemIds.length,
    defaultCollapsed: ordinaryItemIds.length > 0,
    showToggle: ordinaryItemIds.length > 0,
    activeSummary
  }
}
