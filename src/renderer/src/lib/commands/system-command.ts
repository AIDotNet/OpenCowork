export interface SystemCommandSnapshot {
  name: string
  content: string
}

export interface ParsedSlashCommandInput {
  commandName: string
  userText: string
  args: string[]
}

export interface ParsedSystemCommandTag {
  command: SystemCommandSnapshot
  remainingText: string
}

const SYSTEM_COMMAND_TAG_RE = /<system-command\s+name=(['"])(.*?)\1>([\s\S]*?)<\/system-command>/i

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function encodeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function serializeSystemCommandTag(
  command: SystemCommandSnapshot,
  remainingText = ''
): string {
  const tag = `<system-command name="${encodeAttribute(command.name)}">${command.content}</system-command>`
  const remaining = remainingText.trim()
  return remaining ? `${tag}\n\n${remaining}` : tag
}

export function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase()
}

function tokenizeSlashCommandArguments(text: string): string[] {
  const normalized = text.trim()
  if (!normalized) return []

  const args: string[] = []
  let current = ''
  let quoteChar: '"' | "'" | null = null
  let escaping = false
  let tokenStarted = false

  for (const char of normalized) {
    if (escaping) {
      current += char
      escaping = false
      tokenStarted = true
      continue
    }

    if (char === '\\') {
      escaping = true
      tokenStarted = true
      continue
    }

    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = null
      } else {
        current += char
      }
      tokenStarted = true
      continue
    }

    if (char === '"' || char === "'") {
      quoteChar = char
      tokenStarted = true
      continue
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current)
        current = ''
        tokenStarted = false
      }
      continue
    }

    current += char
    tokenStarted = true
  }

  if (escaping) {
    current += '\\'
  }

  if (tokenStarted) {
    args.push(current)
  }

  return args
}

export function parseSlashCommandInput(text: string): ParsedSlashCommandInput | null {
  const normalized = text.trimStart()
  if (!normalized.startsWith('/')) return null

  const match = normalized.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null

  const userText = match[2]?.trim() ?? ''

  return {
    commandName: match[1].trim(),
    userText,
    args: tokenizeSlashCommandArguments(userText)
  }
}

export function parseSystemCommandTag(text: string): ParsedSystemCommandTag | null {
  const match = SYSTEM_COMMAND_TAG_RE.exec(text)
  if (!match) return null

  const [fullMatch, , rawName, rawContent] = match
  const before = text.slice(0, match.index).trim()
  const after = text.slice(match.index + fullMatch.length).trim()
  const remainingParts = [before, after].filter(Boolean)

  return {
    command: {
      name: decodeAttribute(rawName.trim()),
      content: rawContent.trim()
    },
    remainingText: remainingParts.join('\n\n').trim()
  }
}

export function stripSystemCommandTag(text: string): string {
  return parseSystemCommandTag(text)?.remainingText ?? text
}
