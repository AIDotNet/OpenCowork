import crypto from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type {
  InputDraftCleanupArgs,
  InputDraftCleanupResult,
  InputDraftContext,
  InputDraftGetArgs,
  InputDraftImageAttachment,
  InputDraftIndexEntry,
  InputDraftMutationResult,
  InputDraftRecord,
  InputDraftRemoveArgs,
  InputDraftScope,
  InputDraftSelectedFileItem,
  InputDraftSetArgs,
  InputDraftValue
} from '../../shared/input-draft-types'
import { INPUT_DRAFT_SCHEMA_VERSION } from '../../shared/input-draft-types'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  decodePersistedStoreState,
  initializeSettingsCache,
  setSettingsValue
} from './settings-handlers'

const DATA_DIR = path.join(os.homedir(), '.open-cowork')
const DRAFTS_DIR = path.join(DATA_DIR, 'input-drafts')
const INDEX_FILE = path.join(DRAFTS_DIR, 'index.json')
const LEGACY_SETTINGS_KEY = 'opencowork-input-drafts'
const DEFAULT_MAX_DRAFTS = 50
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_DRAFT_BYTES = 10 * 1024 * 1024

let mutationQueue: Promise<unknown> = Promise.resolve()
let legacyMigrationPromise: Promise<void> | null = null

interface InputDraftIndexFile {
  version: 1
  drafts: InputDraftIndexEntry[]
}

interface LegacyPersistedDraft {
  text: string
  images: InputDraftImageAttachment[]
  skill: string | null
  selectedFiles: InputDraftSelectedFileItem[]
  updatedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeDraftKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim()
  if (!key || key.length > 512) return null
  return key
}

function hashDraftKey(draftKey: string): string {
  return crypto.createHash('sha256').update(draftKey).digest('hex')
}

function getDraftFileName(draftKey: string): string {
  return `${hashDraftKey(draftKey)}.json`
}

function getDraftFilePath(fileName: string): string {
  return path.join(DRAFTS_DIR, fileName)
}

function hashContent(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function ensureDraftDir(): Promise<void> {
  await fs.mkdir(DRAFTS_DIR, { recursive: true })
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDraftDir()
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  await fs.rename(tempPath, filePath)
}

function sanitizeImageAttachments(value: unknown): InputDraftImageAttachment[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = toOptionalString(item.id)
    const dataUrl = toOptionalString(item.dataUrl)
    const mediaType = toOptionalString(item.mediaType)
    if (!id || !dataUrl || !mediaType) return []
    return [{ id, dataUrl, mediaType }]
  })
}

function sanitizeSelectedFileItem(value: unknown): InputDraftSelectedFileItem | null {
  if (!isRecord(value)) return null

  const id = toOptionalString(value.id)
  const name = toOptionalString(value.name)
  const originalPath = toOptionalString(value.originalPath)
  const sendPath = toOptionalString(value.sendPath)
  const previewPath = toOptionalString(value.previewPath)
  if (!id || !name || !originalPath || !sendPath || !previewPath) return null

  return {
    id,
    name,
    originalPath,
    sendPath,
    previewPath,
    isWorkspaceFile: Boolean(value.isWorkspaceFile)
  }
}

function sanitizeSelectedFiles(value: unknown): InputDraftSelectedFileItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map(sanitizeSelectedFileItem)
    .filter((item): item is InputDraftSelectedFileItem => item !== null)
}

function sanitizeDraftValue(value: unknown): InputDraftValue | null {
  if (!isRecord(value)) return null

  const text = typeof value.text === 'string' ? value.text : ''
  const skill = typeof value.skill === 'string' && value.skill.trim() ? value.skill : null
  const images = sanitizeImageAttachments(value.images)
  const selectedFiles = sanitizeSelectedFiles(value.selectedFiles)

  return { text, images, skill, selectedFiles }
}

function hasDraftContent(draft: InputDraftValue): boolean {
  return draft.text.length > 0 || draft.images.length > 0 || draft.skill !== null
}

function sanitizeScope(value: unknown): InputDraftScope {
  return value === 'session' ||
    value === 'home' ||
    value === 'project' ||
    value === 'subagent' ||
    value === 'custom'
    ? value
    : 'custom'
}

function sanitizeContext(value: unknown): InputDraftContext {
  if (!isRecord(value)) {
    return { scope: 'custom' }
  }

  return {
    scope: sanitizeScope(value.scope),
    sessionId: toOptionalString(value.sessionId),
    projectId: toOptionalString(value.projectId),
    mode: toOptionalString(value.mode),
    workingFolder: toOptionalString(value.workingFolder)
  }
}

function inferContextFromDraftKey(draftKey: string): InputDraftContext {
  if (draftKey.startsWith('session:')) {
    return {
      scope: 'session',
      sessionId: draftKey.slice('session:'.length) || null
    }
  }

  if (draftKey.startsWith('subagent:')) {
    const [, sessionId] = draftKey.split(':')
    return {
      scope: 'subagent',
      sessionId: sessionId || null
    }
  }

  if (draftKey.startsWith('project:')) {
    const [, projectId, mode] = draftKey.split(':')
    return {
      scope: 'project',
      projectId: projectId || null,
      mode: mode || null
    }
  }

  if (draftKey.startsWith('home:')) {
    return {
      scope: 'home',
      mode: draftKey.slice('home:'.length) || null
    }
  }

  return { scope: 'custom' }
}

function sanitizeIndexEntry(value: unknown): InputDraftIndexEntry | null {
  if (!isRecord(value)) return null

  const draftKey = normalizeDraftKey(value.draftKey)
  const fileName = toOptionalString(value.fileName)
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : null
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : null
  const sizeBytes = typeof value.sizeBytes === 'number' ? value.sizeBytes : 0

  if (!draftKey || !fileName || createdAt === null || updatedAt === null) return null
  if (path.basename(fileName) !== fileName || !fileName.endsWith('.json')) return null

  return {
    draftKey,
    fileName,
    scope: sanitizeScope(value.scope),
    sessionId: toOptionalString(value.sessionId),
    projectId: toOptionalString(value.projectId),
    mode: toOptionalString(value.mode),
    workingFolder: toOptionalString(value.workingFolder),
    createdAt,
    updatedAt,
    sizeBytes: Math.max(0, sizeBytes)
  }
}

async function readIndex(): Promise<InputDraftIndexEntry[]> {
  const file = await readJsonFile<InputDraftIndexFile | null>(INDEX_FILE, null)
  if (!file || !Array.isArray(file.drafts)) return []

  const entries = file.drafts
    .map(sanitizeIndexEntry)
    .filter((entry): entry is InputDraftIndexEntry => entry !== null)

  return dedupeIndexEntries(entries)
}

function dedupeIndexEntries(entries: InputDraftIndexEntry[]): InputDraftIndexEntry[] {
  const byKey = new Map<string, InputDraftIndexEntry>()
  for (const entry of entries) {
    const current = byKey.get(entry.draftKey)
    if (!current || entry.updatedAt >= current.updatedAt) {
      byKey.set(entry.draftKey, entry)
    }
  }
  return [...byKey.values()].sort((left, right) => right.updatedAt - left.updatedAt)
}

async function writeIndex(entries: InputDraftIndexEntry[]): Promise<void> {
  await writeJsonAtomic(INDEX_FILE, {
    version: 1,
    drafts: dedupeIndexEntries(entries)
  } satisfies InputDraftIndexFile)
}

function sanitizeDraftRecord(value: unknown, expectedDraftKey?: string): InputDraftRecord | null {
  if (!isRecord(value)) return null

  const draftKey = normalizeDraftKey(value.draftKey)
  if (!draftKey || (expectedDraftKey && draftKey !== expectedDraftKey)) return null
  const draft = sanitizeDraftValue(value)
  if (!draft) return null

  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : Date.now()
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : createdAt
  const contentHash =
    typeof value.contentHash === 'string'
      ? value.contentHash
      : hashContent({ draftKey, draft, context: value.context })
  const sizeBytes = typeof value.sizeBytes === 'number' ? value.sizeBytes : 0

  return {
    version: INPUT_DRAFT_SCHEMA_VERSION,
    draftKey,
    context: sanitizeContext(value.context),
    ...draft,
    createdAt,
    updatedAt,
    contentHash,
    sizeBytes: Math.max(0, sizeBytes)
  }
}

function createDraftRecord(
  draftKey: string,
  draft: InputDraftValue,
  context: InputDraftContext,
  existing?: InputDraftRecord | null,
  updatedAt = Date.now()
): InputDraftRecord {
  const base = {
    draftKey,
    context,
    text: draft.text,
    images: draft.images.map((image) => ({ ...image })),
    skill: draft.skill,
    selectedFiles: draft.selectedFiles.map((file) => ({ ...file }))
  }

  const record: InputDraftRecord = {
    version: INPUT_DRAFT_SCHEMA_VERSION,
    ...base,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
    contentHash: hashContent(base),
    sizeBytes: 0
  }
  record.sizeBytes = Buffer.byteLength(JSON.stringify(record), 'utf-8')
  return record
}

function indexEntryFromRecord(record: InputDraftRecord): InputDraftIndexEntry {
  return {
    draftKey: record.draftKey,
    fileName: getDraftFileName(record.draftKey),
    scope: record.context.scope,
    sessionId: record.context.sessionId ?? null,
    projectId: record.context.projectId ?? null,
    mode: record.context.mode ?? null,
    workingFolder: record.context.workingFolder ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sizeBytes: record.sizeBytes
  }
}

async function readDraftRecord(draftKey: string): Promise<InputDraftRecord | null> {
  const fileName = getDraftFileName(draftKey)
  const filePath = getDraftFilePath(fileName)
  const raw = await readJsonFile<unknown | null>(filePath, null)
  return sanitizeDraftRecord(raw, draftKey)
}

async function writeDraftRecord(record: InputDraftRecord, entries: InputDraftIndexEntry[]) {
  if (record.sizeBytes > MAX_DRAFT_BYTES) {
    throw new Error('Draft is too large to persist')
  }

  await writeJsonAtomic(getDraftFilePath(getDraftFileName(record.draftKey)), record)

  const nextEntries = [
    indexEntryFromRecord(record),
    ...entries.filter((entry) => entry.draftKey !== record.draftKey)
  ]
  await writeIndex(nextEntries)
  await cleanupDrafts({ maxDrafts: DEFAULT_MAX_DRAFTS, ttlMs: DEFAULT_TTL_MS }, false)
}

async function removeDraftByKey(draftKey: string): Promise<boolean> {
  const entries = await readIndex()
  const entry = entries.find((item) => item.draftKey === draftKey)
  const fileName = entry?.fileName ?? getDraftFileName(draftKey)

  let removed = false
  try {
    await fs.unlink(getDraftFilePath(fileName))
    removed = true
  } catch {
    // Missing files are already effectively removed.
  }

  if (entry) {
    await writeIndex(entries.filter((item) => item.draftKey !== draftKey))
    removed = true
  }

  return removed
}

async function cleanupDrafts(
  args: InputDraftCleanupArgs | undefined,
  awaitMigration = true
): Promise<InputDraftCleanupResult> {
  if (awaitMigration) {
    await migrateLegacyDrafts()
  }

  await ensureDraftDir()
  const maxDrafts = Math.max(1, Math.floor(args?.maxDrafts ?? DEFAULT_MAX_DRAFTS))
  const ttlMs = Math.max(0, Math.floor(args?.ttlMs ?? DEFAULT_TTL_MS))
  const now = Date.now()
  const entries = await readIndex()
  const keep = new Set<string>()
  const remove = new Set<string>()

  entries.forEach((entry, index) => {
    const expired = ttlMs > 0 && now - entry.updatedAt > ttlMs
    if (expired || index >= maxDrafts) {
      remove.add(entry.fileName)
    } else {
      keep.add(entry.fileName)
    }
  })

  try {
    const files = await fs.readdir(DRAFTS_DIR)
    for (const file of files) {
      if (file === 'index.json' || !file.endsWith('.json')) continue
      if (!keep.has(file)) remove.add(file)
    }
  } catch {
    // Ignore missing/unreadable directories; ensureDraftDir already retried creation.
  }

  let removed = 0
  for (const fileName of remove) {
    try {
      await fs.unlink(getDraftFilePath(fileName))
      removed += 1
    } catch {
      // Ignore missing files.
    }
  }

  await writeIndex(entries.filter((entry) => keep.has(entry.fileName)))
  return { success: true, removed }
}

function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const next = mutationQueue.catch(() => {}).then(task)
  mutationQueue = next.catch(() => {})
  return next
}

function sanitizeLegacyDraft(value: unknown): LegacyPersistedDraft | null {
  if (!isRecord(value)) return null

  const draft = sanitizeDraftValue(value)
  if (!draft || !hasDraftContent(draft)) return null

  return {
    ...draft,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now()
  }
}

async function migrateLegacyDrafts(): Promise<void> {
  if (legacyMigrationPromise) return legacyMigrationPromise

  legacyMigrationPromise = enqueueMutation(async () => {
    const settings = await initializeSettingsCache()
    const legacyState = decodePersistedStoreState<{ draftsByKey?: unknown }>(
      settings[LEGACY_SETTINGS_KEY]
    )
    if (!legacyState || !isRecord(legacyState.draftsByKey)) return

    const entries = await readIndex()
    const existingKeys = new Set(entries.map((entry) => entry.draftKey))
    let nextEntries = entries

    for (const [rawKey, rawDraft] of Object.entries(legacyState.draftsByKey)) {
      const draftKey = normalizeDraftKey(rawKey)
      if (!draftKey || existingKeys.has(draftKey)) continue

      const draft = sanitizeLegacyDraft(rawDraft)
      if (!draft) continue

      const record = createDraftRecord(
        draftKey,
        draft,
        inferContextFromDraftKey(draftKey),
        null,
        draft.updatedAt
      )
      if (record.sizeBytes > MAX_DRAFT_BYTES) continue

      await writeJsonAtomic(getDraftFilePath(getDraftFileName(draftKey)), record)
      nextEntries = [indexEntryFromRecord(record), ...nextEntries]
      existingKeys.add(draftKey)
    }

    await writeIndex(nextEntries)
    await setSettingsValue(LEGACY_SETTINGS_KEY, undefined)
  }).finally(() => {
    legacyMigrationPromise = null
  })

  return legacyMigrationPromise
}

export function registerInputDraftHandlers(): void {
  registerMessagePackHandler<InputDraftGetArgs, InputDraftRecord | null>(
    'input-draft:get',
    async (args) => {
      await migrateLegacyDrafts()
      const draftKey = normalizeDraftKey(args?.draftKey)
      if (!draftKey) return null

      const record = await readDraftRecord(draftKey)
      if (record) return record

      await enqueueMutation(async () => {
        const entries = await readIndex()
        if (entries.some((entry) => entry.draftKey === draftKey)) {
          await writeIndex(entries.filter((entry) => entry.draftKey !== draftKey))
        }
      })
      return null
    }
  )

  registerMessagePackHandler<InputDraftSetArgs, InputDraftMutationResult>(
    'input-draft:set',
    async (args) => {
      await migrateLegacyDrafts()
      return enqueueMutation(async () => {
        const draftKey = normalizeDraftKey(args?.draftKey)
        const draft = sanitizeDraftValue(args?.draft)
        if (!draftKey || !draft) return { success: false, error: 'Invalid draft payload' }

        if (!hasDraftContent(draft)) {
          await removeDraftByKey(draftKey)
          return { success: true }
        }

        const existing = await readDraftRecord(draftKey)
        const record = createDraftRecord(draftKey, draft, sanitizeContext(args?.context), existing)
        await writeDraftRecord(record, await readIndex())
        return { success: true }
      }).catch((error) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
  )

  registerMessagePackHandler<InputDraftRemoveArgs, InputDraftMutationResult>(
    'input-draft:remove',
    async (args) => {
      await migrateLegacyDrafts()
      return enqueueMutation(async () => {
        const draftKey = normalizeDraftKey(args?.draftKey)
        if (!draftKey) return { success: false, error: 'Invalid draft key' }
        await removeDraftByKey(draftKey)
        return { success: true }
      }).catch((error) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
  )

  registerMessagePackHandler<void, InputDraftIndexEntry[]>('input-draft:list', async () => {
    await migrateLegacyDrafts()
    return readIndex()
  })

  registerMessagePackHandler<InputDraftCleanupArgs, InputDraftCleanupResult>(
    'input-draft:cleanup',
    async (args) => {
      await migrateLegacyDrafts()
      return enqueueMutation(() => cleanupDrafts(args, false)).catch((error) => ({
        success: false,
        removed: 0,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
  )
}
