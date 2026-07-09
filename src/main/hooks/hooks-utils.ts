import { createHash, randomUUID } from 'crypto'
import { homedir } from 'os'
import path from 'path'

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortStable(value))
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortStable(item)])
  )
}

export function hashStable(value: unknown): string {
  return sha256(stableJson(value))
}

export function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith(`~${path.sep}`)) return path.join(homedir(), input.slice(2))
  return input
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

export function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function nowMs(): number {
  return Date.now()
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
