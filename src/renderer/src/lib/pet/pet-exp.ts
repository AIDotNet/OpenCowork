import { nanoid } from 'nanoid'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

/** Input price (USD per million tokens) above which a model counts as premium. */
export const PREMIUM_INPUT_PRICE_THRESHOLD = 2

/** Base rate: 1 exp per 1000 tokens; premium models earn double. */
export const TOKENS_PER_EXP = 1000
export const PREMIUM_EXP_MULTIPLIER = 2

export function isPremiumModelPrice(inputPrice: number | null | undefined): boolean {
  return typeof inputPrice === 'number' && inputPrice > PREMIUM_INPUT_PRICE_THRESHOLD
}

export function computePetExp(tokens: number, premium: boolean): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  const exp = (tokens / TOKENS_PER_EXP) * (premium ? PREMIUM_EXP_MULTIPLIER : 1)
  return Math.round(exp * 100) / 100
}

export async function accruePetExpFromUsage(args: {
  modelId: string | null
  modelName: string | null
  inputPrice: number | null | undefined
  tokens: number
}): Promise<void> {
  const premium = isPremiumModelPrice(args.inputPrice)
  const exp = computePetExp(args.tokens, premium)
  if (exp <= 0) return
  try {
    await ipcClient.invoke('pet:exp-add', {
      id: nanoid(),
      at: Date.now(),
      model: args.modelName ?? args.modelId ?? 'unknown',
      tokens: Math.round(args.tokens),
      premium,
      exp
    })
  } catch {
    // Experience accrual must never break usage recording.
  }
}
