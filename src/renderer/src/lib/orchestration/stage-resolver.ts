import { getBillableTotalTokens } from '@renderer/lib/format-tokens'
import type {
  OrchestrationMember,
  OrchestrationRunStatus,
  OrchestrationStage,
  OrchestrationStageStatus
} from './types'

const STAGE_LABELS = [
  'Creating execution units',
  'Assigning tasks',
  'Executing',
  'Summarizing results',
  'Completed'
] as const

function resolveStageStatus(index: number, activeIndex: number): OrchestrationStageStatus {
  if (index < activeIndex) return 'completed'
  if (index === activeIndex) return 'active'
  return 'pending'
}

export function deriveRunStatus(members: OrchestrationMember[]): OrchestrationRunStatus {
  if (members.some((member) => member.status === 'failed')) return 'failed'
  if (members.some((member) => member.isRunning)) return 'running'
  return 'completed'
}

export function deriveStageIndex(args: {
  members: OrchestrationMember[]
  hasTasks: boolean
  hasMessages: boolean
}): number {
  const { members, hasTasks, hasMessages } = args
  const allDone = members.length > 0 && members.every((member) => !member.isRunning)
  const hasReports = members.some((member) => member.report?.trim() || member.summary.trim())
  const hasProgress = members.some(
    (member) => member.toolCallCount > 0 || member.iteration > 0 || member.summary.trim()
  )

  if (allDone) return 4
  if (hasReports || hasMessages) return 3
  if (hasProgress || members.some((member) => member.isRunning)) return 2
  if (hasTasks) return 1
  return 0
}

export function buildStages(args: {
  members: OrchestrationMember[]
  hasTasks: boolean
  hasMessages: boolean
}): { stageIndex: number; stageCount: number; stages: OrchestrationStage[] } {
  const stageIndex = deriveStageIndex(args)
  return {
    stageIndex,
    stageCount: STAGE_LABELS.length,
    stages: STAGE_LABELS.map((label, index) => ({
      id: `stage-${index + 1}`,
      label,
      status: resolveStageStatus(index, stageIndex)
    }))
  }
}

export function computeMemberProgress(member: {
  isRunning: boolean
  toolCallCount: number
  iteration: number
  summary: string
  report?: string
}): number {
  if (!member.isRunning) return 1
  if (member.report?.trim()) return 0.9
  if (member.summary.trim()) return 0.75
  const progress = member.toolCallCount * 0.08 + member.iteration * 0.12
  return Math.max(0.08, Math.min(progress, 0.82))
}

export function getUsageTokens(
  usage: Parameters<typeof getBillableTotalTokens>[0] | undefined
): number {
  return usage ? getBillableTotalTokens(usage) : 0
}
