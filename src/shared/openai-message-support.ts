export type OpenAIProtocol = 'chat-completions' | 'responses'

export type OpenAIMessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

export interface OpenAIImageReference {
  filePath?: string
  url?: string
}

export function supportsOpenAIImageParts(
  protocol: OpenAIProtocol,
  role: OpenAIMessageRole
): boolean {
  switch (protocol) {
    case 'chat-completions':
    case 'responses':
      return role === 'user'
  }
}

function formatImageReference(reference: OpenAIImageReference, index: number): string | null {
  const filePath = reference.filePath?.trim()
  if (filePath) return `- image ${index + 1} file path: ${filePath}`

  const url = reference.url?.trim()
  if (url) return `- image ${index + 1} URL: ${url}`

  return null
}

export function summarizeOpenAITextAndImages(
  textParts: string[],
  imageCount: number,
  imageReferences: OpenAIImageReference[] = []
): string {
  const text = textParts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
  const imageSummary =
    imageCount <= 0
      ? ''
      : imageCount === 1
        ? '[1 image omitted because this OpenAI-compatible message role does not support image parts.]'
        : `[${imageCount} images omitted because this OpenAI-compatible message role does not support image parts.]`
  const referenceText = imageReferences
    .map(formatImageReference)
    .filter((line): line is string => Boolean(line))
    .join('\n')
  const referenceSummary = referenceText
    ? `Image references available for inspection:\n${referenceText}`
    : ''

  return [text, imageSummary, referenceSummary].filter(Boolean).join('\n\n')
}

export function assertOpenAIImagePartsSupported(
  protocol: OpenAIProtocol,
  role: OpenAIMessageRole,
  context: string
): void {
  if (supportsOpenAIImageParts(protocol, role)) return

  const endpoint = protocol === 'chat-completions' ? '/v1/chat/completions' : '/v1/responses'
  throw new Error(
    `Cannot serialize image content for ${context} with role "${role}" via ${endpoint}. ` +
      'This protocol only supports image parts in user messages.'
  )
}
