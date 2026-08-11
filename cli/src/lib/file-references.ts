import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { FileReferenceCandidate, PromptFileReference, PromptReference } from '../types.js'
import { graphemes } from './text.js'

export const MAX_PROMPT_FILE_REFERENCES = 20
export const MAX_FILE_REFERENCE_RESULTS = 20
export const MAX_FILE_REFERENCE_LINES = 1_000
export const MAX_FILE_REFERENCE_CONTEXT_CHARS = 256 * 1_024

export interface FileReferenceMention {
  end: number
  query: string
  start: number
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').trim()
}

function referenceKey(value: string): string {
  const normalized = normalizePath(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized
}

const SENSITIVE_FILE_NAMES = new Set([
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '_netrc',
  'application_default_credentials.json',
  'credentials',
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'tokens.json'
])

/** Files likely to contain credentials are never offered for automatic context injection. */
export function isSensitiveFileReferencePath(value: string): boolean {
  const normalized = normalizePath(value).toLocaleLowerCase()
  const fileName = basename(normalized).toLocaleLowerCase()
  if (!fileName) return false

  if (fileName === '.env' || fileName.startsWith('.env.')) {
    return !/\.(?:dist|example|sample|template)$/u.test(fileName)
  }
  if (SENSITIVE_FILE_NAMES.has(fileName)) return true
  if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/u.test(fileName)) return true
  if (/\.(?:jks|key|keystore|p12|pem|pfx)$/u.test(fileName)) return true
  return normalized.endsWith('/.docker/config.json')
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\[\]]/gu, (character) => `\\${character}`).replace(/\r?\n/gu, ' ')
}

function encodeMarkdownDestination(value: string): string {
  return /[\s()<>]/u.test(value)
    ? `<${value.replace(/[\\<>]/gu, (character) => `\\${character}`)}>`
    : value
}

/** Find an @file query ending at the editor cursor, using grapheme offsets like PromptInput. */
export function findFileReferenceMention(
  value: string,
  cursor: number
): FileReferenceMention | null {
  const characters = graphemes(value)
  const safeCursor = Math.max(0, Math.min(cursor, characters.length))
  let start = safeCursor - 1

  while (start >= 0 && !/\s/u.test(characters[start] ?? '')) {
    if (characters[start] === '@') break
    start -= 1
  }

  if (start < 0 || characters[start] !== '@') return null
  const previous = characters[start - 1]
  if (previous !== undefined && !/\s/u.test(previous)) return null

  const query = characters.slice(start + 1, safeCursor).join('')
  if (query.includes('@')) return null
  return { end: safeCursor, query, start }
}

/** Use the same durable markdown form as the desktop composer. */
export function createFileReferenceMarkdown(path: string, label?: string): string {
  const normalized = normalizePath(path)
  if (!normalized) return ''
  const displayLabel = (label ?? basename(normalized)).trim() || normalized
  return `[${escapeMarkdownLabel(displayLabel)}](${encodeMarkdownDestination(normalized)})`
}

export function createPromptFileReference(
  candidate: FileReferenceCandidate
): PromptFileReference | null {
  const path = normalizePath(candidate.path)
  if (!path) return null
  return {
    id: `file-${randomUUID()}`,
    kind: 'file',
    name: candidate.name.trim() || basename(path),
    path,
    isWorkspaceFile: true
  }
}

export function addPromptFileReference(
  current: PromptReference[],
  candidate: FileReferenceCandidate
): { reference: PromptFileReference | null; references: PromptReference[] } {
  const created = createPromptFileReference(candidate)
  if (!created) return { reference: null, references: current }
  const existing = current.find(
    (reference) =>
      reference.kind === 'file' && referenceKey(reference.path) === referenceKey(created.path)
  )
  if (existing?.kind === 'file') return { reference: existing, references: current }
  if (current.length >= MAX_PROMPT_FILE_REFERENCES) return { reference: null, references: current }
  return { reference: created, references: [...current, created] }
}

export function normalizePromptReferences(value: unknown): PromptReference[] {
  if (!Array.isArray(value)) return []
  const references: PromptReference[] = []
  const seen = new Set<string>()

  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (record.kind !== 'file' || typeof record.path !== 'string') continue
    const path = normalizePath(record.path)
    if (!path) continue
    const key = referenceKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    references.push({
      id: typeof record.id === 'string' && record.id ? record.id : `file-${randomUUID()}`,
      kind: 'file',
      name:
        typeof record.name === 'string' && record.name.trim() ? record.name.trim() : basename(path),
      path,
      isWorkspaceFile: record.isWorkspaceFile !== false
    })
    if (references.length >= MAX_PROMPT_FILE_REFERENCES) break
  }

  return references
}
