export type ExecutionRunVisibility = 'hidden' | 'ordinary' | 'force'

export type GroupableExecutionBlock =
  | { type: 'thinking' }
  | { type: 'other' }
  | {
      type: 'tool'
      id: string
      visibility: ExecutionRunVisibility
      isolateBefore?: boolean
      isolateAfter?: boolean
    }

export interface ExecutionRunSpan {
  startBlockIndex: number
  endBlockIndex: number
  itemIds: string[]
}

/**
 * Consecutive thoughts and ordinary tools share one Exploring span. Force-visible
 * tools (AskUser, SubAgent, …) isolate themselves so a collapsed run cannot hide them.
 */
export function groupToolExecutionRuns(blocks: GroupableExecutionBlock[]): ExecutionRunSpan[] {
  const spans: ExecutionRunSpan[] = []
  let pending: (ExecutionRunSpan & { hasVisibleTool: boolean }) | null = null

  const closePending = (): void => {
    if (!pending) return
    if (pending.hasVisibleTool) {
      spans.push({
        startBlockIndex: pending.startBlockIndex,
        endBlockIndex: pending.endBlockIndex,
        itemIds: pending.itemIds
      })
    }
    pending = null
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]
    if (block.type === 'thinking') {
      if (!pending) {
        pending = {
          startBlockIndex: blockIndex,
          endBlockIndex: blockIndex,
          itemIds: [],
          hasVisibleTool: false
        }
      } else {
        pending.endBlockIndex = blockIndex
      }
      continue
    }

    if (block.type !== 'tool') {
      closePending()
      continue
    }

    if (block.isolateBefore || block.visibility === 'force') closePending()

    if (!pending) {
      pending = {
        startBlockIndex: blockIndex,
        endBlockIndex: blockIndex,
        itemIds: [],
        hasVisibleTool: false
      }
    }
    pending.endBlockIndex = blockIndex
    pending.itemIds.push(block.id)
    if (block.visibility !== 'hidden') pending.hasVisibleTool = true

    if (block.isolateBefore || block.visibility === 'force' || block.isolateAfter) {
      closePending()
    }
  }

  closePending()
  return spans
}
