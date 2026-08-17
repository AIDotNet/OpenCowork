/** OpenAI short-context pricing tier. Prompts above this use long-context rates. */
export const GPT_STANDARD_CONTEXT_LENGTH = 272_000
/** OpenAI long-context window used when the 1M toggle is enabled. */
export const GPT_LONG_CONTEXT_LENGTH = 1_048_576

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
  // gpt-4 / gpt-4-turbo stay on their native 8K–128K windows.
  if (/^gpt-4(?!\.1)/.test(name)) return true
  return false
}

export function modelSupportsGptLongContext(
  model?: Pick<GptContextModel, 'id' | 'category' | 'supportsLongContext'> | null
): boolean {
  if (!model) return false
  if ((model.category ?? 'chat') !== 'chat') return false
  if (model.supportsLongContext === false) return false
  if (model.supportsLongContext === true) return true
  return isGptChatModelId(model.id) && !isGptFixedSmallContextModel(model.id)
}

export function isGptLongContextEnabled(
  model?: Pick<GptContextModel, 'enableLongContext'> | null
): boolean {
  return model?.enableLongContext === true
}

export function resolveGptLongContextLength(
  model?: Pick<GptContextModel, 'contextLength' | 'longContextLength'> | null
): number {
  if (typeof model?.longContextLength === 'number' && model.longContextLength > 0) {
    return Math.floor(model.longContextLength)
  }
  const configured =
    typeof model?.contextLength === 'number' && model.contextLength > GPT_STANDARD_CONTEXT_LENGTH
      ? Math.floor(model.contextLength)
      : 0
  if (configured > 0) {
    return Math.max(configured, GPT_LONG_CONTEXT_LENGTH)
  }
  return GPT_LONG_CONTEXT_LENGTH
}

/** Effective context window: 272K by default, 1M when the long-context toggle is on. */
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
