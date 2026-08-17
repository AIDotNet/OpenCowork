import { resolveEffectiveModelContextLength } from './gpt-context'

export const DEFAULT_CONTEXT_COMPRESSION_LIMIT = 200_000
export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 0.8
export const MIN_CONTEXT_COMPRESSION_THRESHOLD = 0.3
export const MAX_CONTEXT_COMPRESSION_THRESHOLD = 0.9
export const DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS = 20_000
export const CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS = 13_000
export const CONTEXT_COMPRESSION_PRE_BUFFER_TOKENS = 20_000
export const CONTEXT_COMPRESSION_PRE_GAP_TOKENS = 8_000
export const DEFAULT_PRECOMPRESS_THRESHOLD = 0.65

export type CompressionConfig = {
  enabled: boolean
  /** Model's max context token count. */
  contextLength: number
  /** Full compression trigger threshold, clamped to 0.3 ~ 0.9. */
  threshold: number
  /** Optional pre-compression trigger threshold before buffer adjustments. */
  preCompressThreshold?: number
  /** Tokens reserved for summary/output headroom before trigger calculations. */
  reservedOutputBudget?: number
}

export type CompressionModelProfile = {
  id?: string
  category?: string
  contextLength?: number
  enableExtendedContextCompression?: boolean
  enableLongContext?: boolean
  longContextLength?: number
  supportsLongContext?: boolean
  maxOutputTokens?: number
}

export function clampCompressionThreshold(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_COMPRESSION_THRESHOLD
  }
  return Math.min(
    MAX_CONTEXT_COMPRESSION_THRESHOLD,
    Math.max(MIN_CONTEXT_COMPRESSION_THRESHOLD, value)
  )
}

export function resolveCompressionThreshold(globalThreshold?: number | null): number {
  return clampCompressionThreshold(globalThreshold)
}

export function resolveCompressionContextLength(
  modelConfig?: Pick<
    CompressionModelProfile,
    | 'id'
    | 'category'
    | 'contextLength'
    | 'enableExtendedContextCompression'
    | 'enableLongContext'
    | 'longContextLength'
    | 'supportsLongContext'
  > | null
): number {
  const effectiveContextLength = resolveEffectiveModelContextLength(modelConfig)
  const configuredContextLength =
    typeof effectiveContextLength === 'number' && effectiveContextLength > 0
      ? effectiveContextLength
      : DEFAULT_CONTEXT_COMPRESSION_LIMIT

  if (configuredContextLength <= DEFAULT_CONTEXT_COMPRESSION_LIMIT) {
    return configuredContextLength
  }

  if (modelConfig?.enableExtendedContextCompression === false) {
    return DEFAULT_CONTEXT_COMPRESSION_LIMIT
  }

  return configuredContextLength
}

export function resolveCompressionReservedOutputBudget(
  modelConfig?: Pick<CompressionModelProfile, 'maxOutputTokens'> | null
): number {
  const maxOutputTokens =
    typeof modelConfig?.maxOutputTokens === 'number' && modelConfig.maxOutputTokens > 0
      ? Math.floor(modelConfig.maxOutputTokens)
      : DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  return Math.min(DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS, maxOutputTokens)
}

export function getEffectiveContextWindow(config: CompressionConfig): number {
  if (config.contextLength <= 0) return 0
  const reserved = Math.max(
    0,
    config.reservedOutputBudget ?? DEFAULT_CONTEXT_COMPRESSION_RESERVED_OUTPUT_TOKENS
  )
  return Math.max(1, config.contextLength - reserved)
}

export function getCompressionTriggerTokens(config: CompressionConfig): number {
  const effectiveWindow = getEffectiveContextWindow(config)
  if (effectiveWindow <= 0) return 0
  const ratioThreshold = Math.floor(effectiveWindow * config.threshold)
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_AUTO_BUFFER_TOKENS
  return Math.max(
    1,
    Math.min(ratioThreshold, bufferedThreshold > 0 ? bufferedThreshold : ratioThreshold)
  )
}

export function getPreCompressionTriggerTokens(config: CompressionConfig): number {
  const effectiveWindow = getEffectiveContextWindow(config)
  if (effectiveWindow <= 0) return 0

  const preThreshold = config.preCompressThreshold ?? DEFAULT_PRECOMPRESS_THRESHOLD
  const ratioThreshold = Math.floor(effectiveWindow * preThreshold)
  const fullThreshold = getCompressionTriggerTokens(config)
  const candidates = [ratioThreshold]
  const bufferedThreshold = effectiveWindow - CONTEXT_COMPRESSION_PRE_BUFFER_TOKENS
  if (bufferedThreshold > 0) candidates.push(bufferedThreshold)
  const gapThreshold = fullThreshold - CONTEXT_COMPRESSION_PRE_GAP_TOKENS
  if (gapThreshold > 0) candidates.push(gapThreshold)
  const threshold = Math.min(...candidates)
  return Math.max(1, Math.min(threshold, Math.max(1, fullThreshold - 1)))
}

export function shouldCompress(inputTokens: number, config: CompressionConfig): boolean {
  if (!config.enabled || config.contextLength <= 0) return false
  return inputTokens >= getCompressionTriggerTokens(config)
}

export function buildLoopCompressionConfig(args: {
  enabled: boolean
  threshold?: number | null
  model?: CompressionModelProfile | null
  persistedContextLength?: number
}): CompressionConfig | null {
  if (!args.enabled) return null

  const effectiveContextLength = resolveEffectiveModelContextLength(args.model)
  let contextLength =
    typeof effectiveContextLength === 'number' && effectiveContextLength > 0
      ? resolveCompressionContextLength(args.model)
      : 0
  if (contextLength <= 0) {
    const persisted = args.persistedContextLength
    contextLength = typeof persisted === 'number' && persisted > 0 ? persisted : 0
  }
  if (contextLength <= 0) return null

  return {
    enabled: true,
    contextLength,
    threshold: resolveCompressionThreshold(args.threshold),
    preCompressThreshold: DEFAULT_PRECOMPRESS_THRESHOLD,
    reservedOutputBudget: resolveCompressionReservedOutputBudget(args.model)
  }
}
