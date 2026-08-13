import { decode, encode } from '@toon-format/toon'
import { useSettingsStore } from '@renderer/stores/settings-store'

export type ToolResultFormat = 'toon' | 'json'

type StructuredToolResult = Record<string, unknown> | unknown[]

export function getCurrentToolResultFormat(): ToolResultFormat {
  return useSettingsStore.getState().toolResultFormat
}

export function encodeStructuredToolResult(
  value: StructuredToolResult,
  format: ToolResultFormat = getCurrentToolResultFormat()
): string {
  if (format === 'json') {
    return JSON.stringify(value)
  }
  return encode(value).trimEnd()
}

const SYSTEM_REMIND_BLOCK =
  /^<system-remind(?:er)?>\s*([\s\S]*?)\s*<\/system-remind(?:er)?>$/i
const IO_RESOURCE_KEY =
  /^(?<key>(?:IO|Arg|UnauthorizedAccess|net)_[A-Za-z0-9_]+)(?:,\s*(?<arg>[\s\S]+))?$/

export function sanitizeToolErrorMessage(message: string): string {
  const trimmed = message.trim()
  const match = trimmed.match(IO_RESOURCE_KEY)
  if (!match) return trimmed

  const key = match.groups?.key ?? ''
  const arg = match.groups?.arg?.trim()
  const path = arg && /[/\\]/.test(arg) ? arg : undefined
  if (/FileNotFound|PathNotFound|DirectoryNotFound/.test(key)) {
    return path ? `Path does not exist: ${path}` : 'Path does not exist.'
  }
  if (/UnauthorizedAccess|IODenied/.test(key)) {
    return path ? `Access denied: ${path}` : 'Access denied.'
  }
  if (/SharingViolation/.test(key)) {
    return path ? `The file is locked by another process: ${path}` : 'The file is locked by another process.'
  }
  if (/PathTooLong/.test(key)) {
    return path ? `The path is too long: ${path}` : 'The path is too long.'
  }
  if (/AlreadyExists|FileExists/.test(key)) {
    return path ? `The path already exists: ${path}` : 'The path already exists.'
  }
  if (/FileIsDirectory/.test(key)) {
    return path ? `Expected a file but found a directory: ${path}` : 'Expected a file but found a directory.'
  }
  if (key.startsWith('net_')) {
    return 'The network request failed.'
  }
  return path
    ? `The tool failed because of an unexpected I/O error at '${path}'.`
    : 'The tool failed because of an unexpected I/O error.'
}

export function stripToolErrorRemind(message: string): string {
  const trimmed = message.trim()
  const match = trimmed.match(SYSTEM_REMIND_BLOCK)
  return match?.[1]?.trim() ?? trimmed
}

export function formatToolErrorForDisplay(message: string): string {
  return stripToolErrorRemind(sanitizeToolErrorMessage(message)).trim()
}

export function formatToolErrorForModel(message: string): string {
  const display = formatToolErrorForDisplay(message)
  if (/<system-remind/i.test(message.trim())) {
    return message.trim()
  }
  return `<system-remind>\n${display}\n</system-remind>`
}

export function encodeToolError(
  message: string,
  format: ToolResultFormat = getCurrentToolResultFormat()
): string {
  return encodeStructuredToolResult({ error: formatToolErrorForModel(message) }, format)
}

export function decodeStructuredToolResult(text: string): StructuredToolResult | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (isStructuredToolResult(parsed)) return parsed
  } catch {
    // ignore JSON parse errors
  }

  try {
    const parsed = decode(trimmed) as unknown
    if (isStructuredToolResult(parsed)) return parsed
  } catch {
    // ignore TOON parse errors
  }

  return null
}

export function isStructuredToolResult(value: unknown): value is StructuredToolResult {
  return Array.isArray(value) || (!!value && typeof value === 'object')
}

export function isStructuredToolErrorText(text: string): boolean {
  const parsed = decodeStructuredToolResult(text)
  if (!parsed || Array.isArray(parsed)) return false
  const keys = Object.keys(parsed)
  return keys.length === 1 && typeof parsed.error === 'string'
}
