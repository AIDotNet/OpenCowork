const FRAGMENT_SPLIT = /(?:\r?\n+|\*{3,}|-{3,}|—{2,})/g
const MAX_PREVIEW_CHARS = 72

function stripThinkingPreviewDecorators(line: string): string {
  return line
    .replace(/\r/g, '')
    .trim()
    .replace(/^(?:#{1,6}|[-*+]|\d+\.)\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^\*{1,2}(.+?)\*{1,2}$/, '$1')
    .replace(/^_{1,2}(.+?)_{1,2}$/, '$1')
    .replace(/^`(.+?)`$/, '$1')
    .replace(/\*{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+/

function capPreview(text: string): string {
  if (text.length <= MAX_PREVIEW_CHARS) return text
  return `${text.slice(0, MAX_PREVIEW_CHARS - 1).trimEnd()}…`
}

function lastReadablePreview(fragment: string): string {
  if (fragment.length <= MAX_PREVIEW_CHARS) return fragment
  const sentences = fragment
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean)
  return capPreview(sentences[sentences.length - 1] ?? fragment)
}

export function listThinkingPreviewFragments(thinking: string): string[] {
  return thinking.split(FRAGMENT_SPLIT).map(stripThinkingPreviewDecorators).filter(Boolean)
}

/** Latest cleaned fragment for the live header, plus a generation that only
 *  increments when a new fragment starts — so the ticker does not fire on
 *  every token of the same sentence. */
export function getLiveThinkingPreview(thinking: string): { text: string; generation: number } {
  const fragments = listThinkingPreviewFragments(thinking)
  if (fragments.length === 0) return { text: '', generation: 0 }
  return {
    text: lastReadablePreview(fragments[fragments.length - 1]),
    generation: fragments.length
  }
}
