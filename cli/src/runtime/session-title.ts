export interface SessionTitleResult {
  icon: string
  title: string
}

const SESSION_ICON_NAMES = [
  'terminal',
  'code',
  'file-code',
  'bug',
  'git-branch',
  'database',
  'cloud',
  'globe',
  'package',
  'brain',
  'bot',
  'sparkles',
  'chart-line',
  'calculator',
  'target',
  'flask-conical',
  'briefcase',
  'clipboard',
  'file-text',
  'list-todo',
  'book-open',
  'palette',
  'image',
  'lightbulb',
  'graduation-cap',
  'message-square',
  'users',
  'house',
  'calendar',
  'plane',
  'map',
  'heart',
  'shield-check',
  'leaf',
  'gamepad-2',
  'lock',
  'wrench',
  'settings',
  'construction',
  'search'
] as const

export const SESSION_TITLE_SYSTEM_PROMPT = `You are a title generator. Given a user message or conversation excerpt, produce:
1. A concise title (max 30 characters) that summarizes the intent.
2. Pick ONE icon name from the following Lucide icon list that best represents the topic:
${SESSION_ICON_NAMES.join(', ')}

Reply with ONLY a JSON object in this exact format (no markdown, no explanation):
{"title":"your title here","icon":"icon-name"}`

const stripReasoningBlocks = (value: string): string =>
  value.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/giu, '').replace(/<\/think>/giu, '')

const stripMarkdown = (value: string): string =>
  value
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/\*(.+?)\*/gu, '$1')
    .replace(/__(.+?)__/gu, '$1')
    .replace(/_(.+?)_/gu, '$1')
    .replace(/~~(.+?)~~/gu, '$1')
    .replace(/`(.+?)`/gu, '$1')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/^\s*\d+\.\s+/gmu, '')

function looksLikeReasoning(value: string): boolean {
  const markers = [/思考过程/u, /分析.*指令/u, /\*\*目标\*\*/u, /步骤\s*\d/u, /^(?:\d+\.\s)/mu]
  return markers.filter((marker) => marker.test(value)).length >= 2
}

function cleanTitle(value: string): string {
  let title = stripMarkdown(stripReasoningBlocks(value))
    .replace(/^["']|["']$/gu, '')
    .replace(/\n+/gu, ' ')
    .trim()
  if (title.length > 40) title = `${title.slice(0, 40)}...`
  return title
}

export function parseSessionTitle(value: string): SessionTitleResult | null {
  if (looksLikeReasoning(value)) return null
  const cleaned = stripReasoningBlocks(value)
    .replace(/```(?:json)?\s*([\s\S]*?)```/giu, '$1')
    .trim()
  if (!cleaned) return null

  try {
    const jsonMatch =
      cleaned.match(/\{[^{}]*"title"\s*:\s*"[^"]*"[^{}]*\}/u) ?? cleaned.match(/\{[\s\S]*?\}/u)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const result = parsed as Record<string, unknown>
        const title = cleanTitle(String(result.title ?? ''))
        const icon = String(result.icon ?? '').trim()
        if (title && icon) return { title, icon }
      }
    }
  } catch {
    // Fall through to the same plain-text fallback as the desktop title generator.
  }

  const title = cleanTitle(cleaned.replace(/[{}]/gu, ''))
  return title ? { title, icon: 'message-square' } : null
}
