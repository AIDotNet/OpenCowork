/** Default window for 1M-capable models when the long-context toggle is off. */
export const GPT_STANDARD_CONTEXT_LENGTH = 360_000
/** Native 1M+ window used when the long-context toggle is enabled. */
export const GPT_LONG_CONTEXT_LENGTH = 1_048_576
/** Models at or above this window get the 360K / 1M split. */
const MILLION_TOKEN_CONTEXT_LENGTH = 1_000_000

export type GptContextModel = {
  id?: string
  category?: string
  contextLength?: number
  enableLongContext?: boolean
  longContextLength?: number
  supportsLongContext?: boolean
}

function normalizeGptModelId(id?: string): string {
  if (!id) return ''
  const trimmed = id.trim().toLowerCase()
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

function isGptChatModelId(id?: string): boolean {
  const name = normalizeGptModelId(id)
  if (!name.startsWith('gpt-')) return false
  return !/(image|transcribe|whisper|realtime|tts|audio|speech|embedding)/.test(name)
}

function isGptFixedSmallContextModel(id?: string): boolean {
  const name = normalizeGptModelId(id)
  if (!name) return false
  if (name.startsWith('gpt-4o')) return true
  if (name.includes('-chat')) return true
  if (name.includes('spark')) return true
  if (/^gpt-4(?!\.1)/.test(name)) return true
  return false
}

function tokenWindow(value?: number): number {
  return typeof value === 'number' && value > 0 ? Math.floor(value) : 0
}

function hasMillionTokenWindow(
  model?: Pick<GptContextModel, 'contextLength' | 'longContextLength'> | null
): boolean {
  return (
    tokenWindow(model?.contextLength) >= MILLION_TOKEN_CONTEXT_LENGTH ||
    tokenWindow(model?.longContextLength) >= MILLION_TOKEN_CONTEXT_LENGTH
  )
}

export function modelSupportsGptLongContext(
  model?: Pick<
    GptContextModel,
    'id' | 'category' | 'supportsLongContext' | 'contextLength' | 'longContextLength'
  > | null
): boolean {
  if (!model) return false
  if ((model.category ?? 'chat') !== 'chat') return false
  if (model.supportsLongContext === false) return false
  if (model.supportsLongContext === true) return true
  if (hasMillionTokenWindow(model)) return true
  return isGptChatModelId(model.id) && !isGptFixedSmallContextModel(model.id)
}

export function isGptLongContextEnabled(
  model?: Pick<GptContextModel, 'enableLongContext'> | null
): boolean {
  return model?.enableLongContext === true
}

export function resolveGptLongContextLength(
  model?: Pick<GptContextModel, 'id' | 'contextLength' | 'longContextLength'> | null
): number {
  const storedLong = tokenWindow(model?.longContextLength)
  if (storedLong > 0) {
    return storedLong
  }
  const configured = tokenWindow(model?.contextLength)
  if (configured >= MILLION_TOKEN_CONTEXT_LENGTH) {
    return configured
  }
  if (
    configured > GPT_STANDARD_CONTEXT_LENGTH &&
    isGptChatModelId(model?.id) &&
    !isGptFixedSmallContextModel(model?.id)
  ) {
    return GPT_LONG_CONTEXT_LENGTH
  }
  return GPT_LONG_CONTEXT_LENGTH
}

export function resolveEffectiveModelContextLength(
  model?: GptContextModel | null
): number | undefined {
  if (!model) return undefined
  if (modelSupportsGptLongContext(model)) {
    return isGptLongContextEnabled(model)
      ? resolveGptLongContextLength(model)
      : GPT_STANDARD_CONTEXT_LENGTH
  }
  return typeof model.contextLength === 'number' && model.contextLength > 0
    ? model.contextLength
    : undefined
}

export function applyGptLongContextDefaults<T extends GptContextModel>(model: T): T {
  if (!modelSupportsGptLongContext(model)) return model
  const longContextLength = resolveGptLongContextLength(model)
  return {
    ...model,
    contextLength: GPT_STANDARD_CONTEXT_LENGTH,
    supportsLongContext: true,
    longContextLength,
    enableLongContext: model.enableLongContext === true
  }
}
