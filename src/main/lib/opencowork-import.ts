import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import {
  applyOpenCoworkImportDocument,
  documentNeedsConfigRef,
  fetchOpenCoworkImportConfigRef,
  isOpenCoworkImportUrl,
  parseOpenCoworkImportUrlDocument,
  type ApplyOpenCoworkImportResult,
  type OpenCoworkImportDocument
} from '../../shared/opencowork-import-protocol'
import { readPersistedProviderStore, writePersistedProviderStore } from './ai-provider-store'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface OpenCoworkImportApplyResult {
  builtinId?: string
  modelId: string
  providerId: string
  providerName: string
  importedCount: number
  skippedCount: number
}

function broadcastProviderImported(payload: OpenCoworkImportApplyResult): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('ai-provider:imported', payload)
  }
}

function persistApplyResult(
  applied: ApplyOpenCoworkImportResult
): OpenCoworkImportApplyResult | null {
  if (applied.applied.length === 0) return null
  const first = applied.applied[0]
  const persisted = readPersistedProviderStore() ?? { state: {}, version: 0 }
  writePersistedProviderStore({
    state: applied.state,
    version: typeof persisted.version === 'number' ? persisted.version : 0
  })
  const result: OpenCoworkImportApplyResult = {
    ...(first.builtinId ? { builtinId: first.builtinId } : {}),
    modelId: first.modelId,
    providerId: first.providerId,
    providerName:
      applied.applied.length === 1 ? first.providerName : `${applied.applied.length} providers`,
    importedCount: applied.applied.length,
    skippedCount: applied.skipped.length
  }
  broadcastProviderImported(result)
  return result
}

async function resolveImportDocument(
  document: OpenCoworkImportDocument
): Promise<OpenCoworkImportDocument> {
  if (!documentNeedsConfigRef(document) || !document.configRef) return document
  return fetchOpenCoworkImportConfigRef(document.configRef)
}

export function findOpenCoworkImportUrl(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (candidate.startsWith('opencowork:')) return candidate
  }
  return null
}

export { isOpenCoworkImportUrl }

/**
 * Apply a device-login deep link into the shared ~/.open-cowork/ai-provider store.
 * Returns null when the URL is not an OpenCowork import link or nothing could be written.
 */
export async function applyOpenCoworkImportUrl(
  rawUrl: string
): Promise<OpenCoworkImportApplyResult | null> {
  const parsed = parseOpenCoworkImportUrlDocument(rawUrl)
  if (!parsed) return null

  const document = await resolveImportDocument(parsed)
  const persisted = readPersistedProviderStore() ?? { state: {}, version: 0 }
  const state = isRecord(persisted.state) ? { ...persisted.state } : {}
  const applied = applyOpenCoworkImportDocument(state, document, {
    createId: () => randomUUID()
  })
  return persistApplyResult(applied)
}
