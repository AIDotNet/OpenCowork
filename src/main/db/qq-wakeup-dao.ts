import { getNativeWorker } from '../lib/native-worker'

export interface QqWakeupEligibility {
  enabled: boolean
  periodKey: string | null
  sourceMessageId: string | null
  sourceTimestamp: number
}

interface QqWakeupEligibilityResult extends QqWakeupEligibility {
  success: boolean
  error?: string | null
}

interface QqWakeupMutationResult {
  success: boolean
  changed: number
  error?: string | null
}

export async function resolveQqWakeupEligibility(
  pluginId: string,
  openId: string,
  now = Date.now()
): Promise<QqWakeupEligibility> {
  console.log('[QqWakeup][Native] resolve start', { pluginId })
  const result = await getNativeWorker().request<QqWakeupEligibilityResult>(
    'db/qq-wakeup-resolve',
    { pluginId, openId, now },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native QQ wakeup resolve failed')
  }
  console.log('[QqWakeup][Native] resolve done', {
    pluginId,
    enabled: result.enabled,
    periodKey: result.periodKey
  })
  return {
    enabled: result.enabled,
    periodKey: result.periodKey ?? null,
    sourceMessageId: result.sourceMessageId ?? null,
    sourceTimestamp: result.sourceTimestamp
  }
}

export async function markQqWakeupSent(args: {
  pluginId: string
  openId: string
  periodKey: string
  sourceMessageId: string | null
  sourceTimestamp: number
  now?: number
}): Promise<void> {
  console.log('[QqWakeup][Native] mark sent start', {
    pluginId: args.pluginId,
    periodKey: args.periodKey
  })
  const result = await getNativeWorker().request<QqWakeupMutationResult>(
    'db/qq-wakeup-mark-sent',
    { ...args, now: args.now ?? Date.now() },
    120_000
  )
  if (!result.success) {
    throw new Error(result.error || 'Native QQ wakeup mark sent failed')
  }
  console.log('[QqWakeup][Native] mark sent done', {
    pluginId: args.pluginId,
    changed: result.changed
  })
}
