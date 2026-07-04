import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { getPetsDir } from '@renderer/stores/pet-skin-store'
import { localDateKey } from '@renderer/stores/pet-store'

/**
 * Persistent pet memory: ~/.open-cowork/pets/MEMORY.md, one `- [date] fact`
 * line per entry, human-editable. The agent saves memories by appending a
 * hidden `[[记住: ...]]` directive to its reply (see buildMemorySection);
 * the renderer strips the directive and appends the fact here — the model
 * never gets a file-writing tool.
 */
export interface PetMemoryEntry {
  date: string
  text: string
}

const MEMORY_LIMIT = 100
const MEMORY_HEADER = '# Pet Memory\n\n'
const ENTRY_RE = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/
const DIRECTIVE_RE = /\[\[\s*(?:记住|remember)\s*[:：]\s*([^\]]+)\]\]/gi

export async function getPetMemoryPath(): Promise<string> {
  return `${await getPetsDir()}/MEMORY.md`
}

export function parsePetMemories(content: string): PetMemoryEntry[] {
  const entries: PetMemoryEntry[] = []
  for (const line of content.split('\n')) {
    const match = ENTRY_RE.exec(line.trim())
    if (match) entries.push({ date: match[1], text: match[2].trim() })
  }
  return entries
}

export async function loadPetMemories(): Promise<PetMemoryEntry[]> {
  try {
    const doc = (await ipcClient.invoke('fs:read-document', {
      path: await getPetMemoryPath()
    })) as { content?: string } | null
    return parsePetMemories(doc?.content ?? '')
  } catch {
    return []
  }
}

async function writePetMemories(entries: PetMemoryEntry[]): Promise<void> {
  const dir = await getPetsDir()
  await ipcClient.invoke('fs:mkdir', { path: dir })
  const body = entries.map((entry) => `- [${entry.date}] ${entry.text}`).join('\n')
  await ipcClient.invoke('fs:write-file', {
    path: `${dir}/MEMORY.md`,
    content: MEMORY_HEADER + (body ? `${body}\n` : '')
  })
}

/** Append new facts (deduplicated, size-capped) and return the fresh list. */
export async function appendPetMemories(texts: string[]): Promise<PetMemoryEntry[]> {
  const cleaned = texts
    .map((text) => text.replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean)
  const entries = await loadPetMemories()
  if (cleaned.length === 0) return entries
  const known = new Set(entries.map((entry) => entry.text))
  const date = localDateKey()
  for (const text of cleaned) {
    if (known.has(text)) continue
    known.add(text)
    entries.push({ date, text })
  }
  const capped = entries.slice(-MEMORY_LIMIT)
  await writePetMemories(capped)
  return capped
}

export async function removePetMemory(index: number): Promise<PetMemoryEntry[]> {
  const entries = await loadPetMemories()
  if (index >= 0 && index < entries.length) {
    entries.splice(index, 1)
    await writePetMemories(entries)
  }
  return entries
}

export async function clearPetMemories(): Promise<void> {
  await writePetMemories([])
}

/** Create MEMORY.md (header only) if missing, without touching an existing file. */
export async function ensurePetMemoryFile(): Promise<string> {
  const path = await getPetMemoryPath()
  try {
    const doc = (await ipcClient.invoke('fs:read-document', { path })) as {
      content?: string
    } | null
    if (typeof doc?.content === 'string' && doc.content.length > 0) return path
  } catch {
    // missing — fall through and create it
  }
  await writePetMemories([])
  return path
}

/** Remove `[[记住: ...]]` directives (including a half-streamed trailing one). */
export function stripMemoryDirectives(text: string): string {
  return (
    text
      .replace(DIRECTIVE_RE, '')
      // While streaming, an unfinished trailing "[[…" (possibly just "[[记")
      // must not flash in the bubble — drop any unclosed bracket fragment.
      .replace(/\[\[(?:[^\]]|\][^\]])*$/, '')
      .trim()
  )
}

export function extractMemoryDirectives(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const value = match[1]?.trim()
    if (value) found.push(value)
  }
  return found
}

/** Persona section injected per turn: known facts + how to save new ones. */
export function buildMemorySection(entries: PetMemoryEntry[]): string {
  const list = entries
    .slice(-30)
    .map((entry) => `- [${entry.date}] ${entry.text}`)
    .join('\n')
  return [
    '【长期记忆】关于主人，你记得：',
    list || '（还没有任何记忆）',
    '',
    '【记忆规则】当主人告诉你值得长期记住的新信息（称呼、喜好、习惯、正在做的事、重要约定等），在回复的最后另起一行追加：[[记住: 一句话概括，不超过 40 字]]。这一行不会显示给主人。琐碎、临时或与已有记忆重复的内容不要记。'
  ].join('\n')
}
