import type { ToolCallStatus } from '@renderer/lib/agent/types'

/**
 * The execution transcript — tool rows, run headers, the thinking header — stays English in
 * every locale. It reports what the agent did in the same vocabulary as the tool contract,
 * so it reads the same way as the tool names it sits next to. Localized copy belongs on the
 * surrounding app chrome, not here.
 */

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function toolStatusLabel(status: ToolCallStatus | 'completed'): string | null {
  if (status === 'streaming') return 'Receiving'
  if (status === 'running') return 'Running'
  if (status === 'pending_approval') return 'Awaiting approval'
  if (status === 'error') return 'Failed'
  if (status === 'canceled') return 'Canceled'
  return null
}

export function linesLabel(count: number): string {
  return countLabel(count, 'line')
}

export function filesLabel(count: number): string {
  return countLabel(count, 'file')
}

export function matchesLabel(matches: number, files: number): string {
  return `${countLabel(matches, 'match', 'matches')} in ${countLabel(files, 'file')}`
}

export function entriesLabel(folders: number, files: number): string {
  return `${countLabel(folders, 'folder')}, ${countLabel(files, 'file')}`
}

export function toolCallsLabel(count: number): string {
  return countLabel(count, 'tool call')
}

export function activeToolsLabel(count: number): string {
  return `${count} running`
}

export function thoughtLabel(seconds: number): string {
  return `${seconds}s`
}
