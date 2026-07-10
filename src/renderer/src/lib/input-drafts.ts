import type {
  InputDraftContext,
  InputDraftIndexEntry,
  InputDraftMutationResult,
  InputDraftRecord,
  InputDraftSetArgs,
  InputDraftValue
} from '../../../shared/input-draft-types'
import { IPC } from './ipc/channels'
import { ipcClient } from './ipc/ipc-client'

const SESSION_DRAFT_PREFIX = 'session:'
const HOME_DRAFT_PREFIX = 'home:'
const PROJECT_DRAFT_PREFIX = 'project:'
const EMPTY_LISTENERS = new Set<() => void>()

const cachedDraftsByKey = new Map<string, InputDraftValue>()
let cacheListeners: Set<() => void> = EMPTY_LISTENERS

export type {
  InputDraftContext,
  InputDraftIndexEntry,
  InputDraftMutationResult,
  InputDraftRecord,
  InputDraftValue
}

export function getSessionInputDraftKey(sessionId: string): string {
  return `${SESSION_DRAFT_PREFIX}${sessionId}`
}

// Home/project composer drafts are intentionally NOT mode-scoped: switching
// session mode must preserve whatever the user has typed, so all modes share a
// single draft key per home/project.
export function getHomeInputDraftKey(): string {
  return `${HOME_DRAFT_PREFIX}default`
}

export function getProjectInputDraftKey(projectId: string): string {
  return `${PROJECT_DRAFT_PREFIX}${projectId}`
}

export function hasInputDraftContent(
  draft: Pick<InputDraftValue, 'text' | 'images' | 'skill'>
): boolean {
  return draft.text.length > 0 || draft.images.length > 0 || draft.skill !== null
}

export function getCachedInputDraft(draftKey: string | null | undefined): InputDraftValue | null {
  if (!draftKey) return null
  const draft = cachedDraftsByKey.get(draftKey)
  if (!draft) return null
  return {
    text: draft.text,
    images: draft.images.map((image) => ({ ...image })),
    skill: draft.skill,
    selectedFiles: draft.selectedFiles.map((file) => ({ ...file }))
  }
}

export function setCachedInputDraft(
  draftKey: string | null | undefined,
  draft: InputDraftValue | null
): void {
  if (!draftKey) return

  if (draft && hasInputDraftContent(draft)) {
    cachedDraftsByKey.set(draftKey, {
      text: draft.text,
      images: draft.images.map((image) => ({ ...image })),
      skill: draft.skill,
      selectedFiles: draft.selectedFiles.map((file) => ({ ...file }))
    })
  } else {
    cachedDraftsByKey.delete(draftKey)
  }

  for (const listener of cacheListeners) {
    listener()
  }
}

export function subscribeInputDraftCache(listener: () => void): () => void {
  if (cacheListeners === EMPTY_LISTENERS) {
    cacheListeners = new Set()
  }
  cacheListeners.add(listener)
  return () => {
    cacheListeners.delete(listener)
  }
}

function isMutationResult(value: unknown): value is InputDraftMutationResult {
  return !!value && typeof value === 'object' && 'success' in value
}

export async function getInputDraft(draftKey: string): Promise<InputDraftRecord | null> {
  return (await ipcClient.invoke(IPC.INPUT_DRAFT_GET, { draftKey })) as InputDraftRecord | null
}

export async function setInputDraft(args: InputDraftSetArgs): Promise<InputDraftMutationResult> {
  let normalized: InputDraftMutationResult
  try {
    const result = await ipcClient.invoke(IPC.INPUT_DRAFT_SET, args)
    normalized = isMutationResult(result)
      ? result
      : { success: false, error: 'Invalid draft response' }
  } catch (error) {
    normalized = {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (normalized.success) {
    setCachedInputDraft(args.draftKey, args.draft)
  }
  return normalized
}

export async function removeInputDraft(draftKey: string): Promise<InputDraftMutationResult> {
  let normalized: InputDraftMutationResult
  try {
    const result = await ipcClient.invoke(IPC.INPUT_DRAFT_REMOVE, { draftKey })
    normalized = isMutationResult(result)
      ? result
      : { success: false, error: 'Invalid draft response' }
  } catch (error) {
    normalized = {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (normalized.success) {
    setCachedInputDraft(draftKey, null)
  }
  return normalized
}

export async function removeSessionInputDraft(
  sessionId: string
): Promise<InputDraftMutationResult> {
  return removeInputDraft(getSessionInputDraftKey(sessionId))
}

export async function listInputDrafts(): Promise<InputDraftIndexEntry[]> {
  try {
    const result = await ipcClient.invoke(IPC.INPUT_DRAFT_LIST)
    return Array.isArray(result) ? (result as InputDraftIndexEntry[]) : []
  } catch {
    return []
  }
}
