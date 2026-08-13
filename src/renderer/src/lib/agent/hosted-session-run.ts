import type {
  StartRunParams,
  StartRunResult
} from '../../../../shared/runtime-contracts/generated/contracts'

export function shouldUseHostedSessionRun(args: {
  source?: string
  isPlanMode: boolean
  isImageModel: boolean
  triggerMessageId?: string | null
  providerId?: string | null
  modelId?: string | null
}): boolean {
  if (args.source === 'continue') return false
  if (args.isPlanMode) return false
  if (args.isImageModel) return false
  if (!args.triggerMessageId?.trim()) return false
  if (!args.providerId?.trim() || !args.modelId?.trim()) return false
  return true
}

export async function startHostedSessionRun(params: StartRunParams): Promise<StartRunResult> {
  return await window.api.runtime.startRun(params)
}

export async function cancelHostedSessionRun(runId: string, sessionId: string): Promise<void> {
  try {
    await window.api.runtime.cancelRun({ runId, sessionId })
  } catch {
    // Ignore cancellation race / process shutdown.
  }
}
