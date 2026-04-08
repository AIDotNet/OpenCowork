import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { cloneImageAttachments, type ImageAttachment } from '@renderer/lib/image-attachments'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import type { SelectedFileItem } from '@renderer/lib/select-file-editor'

const MAX_INPUT_DRAFTS = 20
const SESSION_DRAFT_PREFIX = 'session:'

export interface InputDraftValue {
  text: string
  images: ImageAttachment[]
  skill: string | null
  selectedFiles: SelectedFileItem[]
}

interface PersistedInputDraft extends InputDraftValue {
  updatedAt: number
}

interface InputDraftStore {
  hydrated: boolean
  draftsByKey: Record<string, PersistedInputDraft>
  setHydrated: (hydrated: boolean) => void
  getDraft: (key: string) => InputDraftValue | null
  setDraft: (key: string, draft: InputDraftValue | null) => void
  removeDraft: (key: string) => void
  removeSessionDraft: (sessionId: string) => void
  clearAllSessionDrafts: () => void
}

export function getSessionInputDraftKey(sessionId: string): string {
  return `${SESSION_DRAFT_PREFIX}${sessionId}`
}

export function hasInputDraftContent(
  draft: Pick<InputDraftValue, 'text' | 'images' | 'skill'>
): boolean {
  return draft.text.length > 0 || draft.images.length > 0 || draft.skill !== null
}

function cloneSelectedFiles(files: SelectedFileItem[]): SelectedFileItem[] {
  return files.map((file) => ({ ...file }))
}

function sanitizeImageAttachments(value: unknown): ImageAttachment[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []

    const id = typeof item.id === 'string' ? item.id : null
    const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : null
    const mediaType = typeof item.mediaType === 'string' ? item.mediaType : null

    if (!id || !dataUrl || !mediaType) return []
    return [{ id, dataUrl, mediaType }]
  })
}

function sanitizeSelectedFileItem(value: unknown): SelectedFileItem | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as Partial<SelectedFileItem>
  const id = typeof candidate.id === 'string' ? candidate.id : null
  const name = typeof candidate.name === 'string' ? candidate.name : null
  const originalPath = typeof candidate.originalPath === 'string' ? candidate.originalPath : null
  const sendPath = typeof candidate.sendPath === 'string' ? candidate.sendPath : null
  const previewPath = typeof candidate.previewPath === 'string' ? candidate.previewPath : null

  if (!id || !name || !originalPath || !sendPath || !previewPath) return null

  return {
    id,
    name,
    originalPath,
    sendPath,
    previewPath,
    isWorkspaceFile: Boolean(candidate.isWorkspaceFile)
  }
}

function sanitizeSelectedFiles(value: unknown): SelectedFileItem[] {
  if (!Array.isArray(value)) return []

  return value
    .map(sanitizeSelectedFileItem)
    .filter((item): item is SelectedFileItem => item !== null)
}

function toInputDraftValue(draft: PersistedInputDraft): InputDraftValue {
  return {
    text: draft.text,
    images: cloneImageAttachments(draft.images),
    skill: draft.skill,
    selectedFiles: cloneSelectedFiles(draft.selectedFiles)
  }
}

function createPersistedDraft(draft: InputDraftValue, updatedAt = Date.now()): PersistedInputDraft {
  return {
    text: draft.text,
    images: cloneImageAttachments(draft.images),
    skill: draft.skill,
    selectedFiles: cloneSelectedFiles(draft.selectedFiles),
    updatedAt
  }
}

function sanitizePersistedDraft(value: unknown): PersistedInputDraft | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as Partial<PersistedInputDraft>
  const text = typeof candidate.text === 'string' ? candidate.text : ''
  const skill = typeof candidate.skill === 'string' ? candidate.skill : null
  const images = sanitizeImageAttachments(candidate.images)
  const selectedFiles = sanitizeSelectedFiles(candidate.selectedFiles)
  const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now()

  return createPersistedDraft(
    {
      text,
      images,
      skill,
      selectedFiles
    },
    updatedAt
  )
}

function trimDraftMap(
  draftsByKey: Record<string, PersistedInputDraft>
): Record<string, PersistedInputDraft> {
  return Object.fromEntries(
    Object.entries(draftsByKey)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_INPUT_DRAFTS)
  )
}

function sanitizeDraftMap(value: unknown): Record<string, PersistedInputDraft> {
  if (!value || typeof value !== 'object') return {}

  const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, draft]) => {
    if (!key) return []
    const sanitized = sanitizePersistedDraft(draft)
    if (!sanitized) return []
    return [[key, sanitized] as const]
  })

  return trimDraftMap(Object.fromEntries(entries))
}

export const useInputDraftStore = create<InputDraftStore>()(
  persist(
    (set, get) => ({
      hydrated: false,
      draftsByKey: {},

      setHydrated: (hydrated) => set({ hydrated }),

      getDraft: (key) => {
        const draft = get().draftsByKey[key]
        return draft ? toInputDraftValue(draft) : null
      },

      setDraft: (key, draft) => {
        if (!key) return

        set((state) => {
          const nextDrafts = { ...state.draftsByKey }

          if (!draft || !hasInputDraftContent(draft)) {
            delete nextDrafts[key]
            return { draftsByKey: nextDrafts }
          }

          nextDrafts[key] = createPersistedDraft(draft)
          return { draftsByKey: trimDraftMap(nextDrafts) }
        })
      },

      removeDraft: (key) => {
        if (!key) return

        set((state) => {
          if (!state.draftsByKey[key]) return state
          const nextDrafts = { ...state.draftsByKey }
          delete nextDrafts[key]
          return { draftsByKey: nextDrafts }
        })
      },

      removeSessionDraft: (sessionId) => {
        get().removeDraft(getSessionInputDraftKey(sessionId))
      },

      clearAllSessionDrafts: () => {
        set((state) => ({
          draftsByKey: Object.fromEntries(
            Object.entries(state.draftsByKey).filter(([key]) => !key.startsWith(SESSION_DRAFT_PREFIX))
          )
        }))
      }
    }),
    {
      name: 'opencowork-input-drafts',
      version: 1,
      storage: createJSONStorage(() => ipcStorage),
      migrate: (persisted: unknown) => {
        const state = persisted as { draftsByKey?: unknown }
        return {
          draftsByKey: sanitizeDraftMap(state?.draftsByKey)
        }
      },
      partialize: (state) => ({ draftsByKey: state.draftsByKey }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true)
      }
    }
  )
)
