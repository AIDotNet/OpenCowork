/** Split text into platform-safe chunks, preferring paragraph/line/word boundaries. */
export function splitTextChunks(text: string, limit: number): string[] {
  if (!text) return []
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit)
    const paragraphBreak = window.lastIndexOf('\n\n')
    const lineBreak = window.lastIndexOf('\n')
    const spaceBreak = window.lastIndexOf(' ')
    const breakAt =
      paragraphBreak > 0
        ? paragraphBreak + 2
        : lineBreak > 0
          ? lineBreak + 1
          : spaceBreak > 0
            ? spaceBreak + 1
            : limit
    chunks.push(remaining.slice(0, breakAt).trimEnd())
    remaining = remaining.slice(breakAt).trimStart()
  }
  if (remaining) {
    chunks.push(remaining)
  }
  return chunks.filter((chunk) => chunk.length > 0)
}

export function requireTextChunks(text: string, limit: number, platform: string): string[] {
  const chunks = splitTextChunks(text, limit)
  if (chunks.length === 0) {
    throw new Error(`${platform} sendMessage requires content`)
  }
  return chunks
}

/** Split text so each chunk stays within a UTF-8 byte budget (WeCom text is 2048 bytes). */
export function splitTextByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (!text) return []

  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= maxBytes) return [text]

  const chunks: string[] = []
  let current = ''
  let currentBytes = 0

  for (const char of text) {
    const charBytes = encoder.encode(char).byteLength
    if (currentBytes + charBytes > maxBytes) {
      if (current) chunks.push(current)
      current = char
      currentBytes = charBytes
    } else {
      current += char
      currentBytes += charBytes
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function requireUtf8ByteChunks(text: string, maxBytes: number, platform: string): string[] {
  const chunks = splitTextByUtf8Bytes(text, maxBytes)
  if (chunks.length === 0) {
    throw new Error(`${platform} sendMessage requires content`)
  }
  return chunks
}
