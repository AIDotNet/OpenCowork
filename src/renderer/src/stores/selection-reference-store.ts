import { create } from 'zustand'
import { nanoid } from 'nanoid'

const MAX_SELECTION_REFERENCES_PER_SESSION = 5
const MAX_SELECTION_REFERENCE_CHARS = 4000
export const EMPTY_SELECTION_REFERENCES: readonly TextSelectionReference[] = []

export interface TextSelectionReference {
  id: string
  text: string
  sourceMessageId?: string
  createdAt: number
}

interface SelectionReferenceStore {
  referencesBySessionId: Record<string, TextSelectionReference[]>
  addSelectionReference: (
    sessionId: string,
    reference: Pick<TextSelectionReference, 'text'> &
      Partial<Pick<TextSelectionReference, 'sourceMessageId'>>
  ) => void
  removeSelectionReference: (sessionId: string, referenceId: string) => void
  clearSelectionReferences: (sessionId: string) => void
}

function normalizeSelectionText(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()

  if (normalized.length <= MAX_SELECTION_REFERENCE_CHARS) return normalized
  return `${normalized.slice(0, MAX_SELECTION_REFERENCE_CHARS).trimEnd()}...`
}

export function summarizeSelectionReference(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 96) return normalized
  return `${normalized.slice(0, 96).trimEnd()}...`
}

export function formatSelectionReferencesForPrompt(
  references: readonly TextSelectionReference[]
): string {
  if (references.length === 0) return ''

  const sections = references.map((reference, index) => {
    return `Selection ${index + 1}:\n${reference.text}`
  })

  return `<system-reminder>\nThe user selected text from previous assistant responses for context in this turn. Use it as referenced context, but answer the user's actual prompt.\n\n${sections.join('\n\n')}\n</system-reminder>`
}

export const useSelectionReferenceStore = create<SelectionReferenceStore>()((set) => ({
  referencesBySessionId: {},

  addSelectionReference: (sessionId, reference) => {
    const text = normalizeSelectionText(reference.text)
    if (!sessionId || !text) return

    set((state) => {
      const current = state.referencesBySessionId[sessionId] ?? []
      const withoutDuplicate = current.filter(
        (item) => item.text !== text || item.sourceMessageId !== reference.sourceMessageId
      )
      const next: TextSelectionReference[] = [
        {
          id: nanoid(),
          text,
          sourceMessageId: reference.sourceMessageId,
          createdAt: Date.now()
        },
        ...withoutDuplicate
      ].slice(0, MAX_SELECTION_REFERENCES_PER_SESSION)

      return {
        referencesBySessionId: {
          ...state.referencesBySessionId,
          [sessionId]: next
        }
      }
    })
  },

  removeSelectionReference: (sessionId, referenceId) => {
    if (!sessionId || !referenceId) return

    set((state) => {
      const current = state.referencesBySessionId[sessionId] ?? []
      const next = current.filter((item) => item.id !== referenceId)
      if (next.length === current.length) return state

      const referencesBySessionId = { ...state.referencesBySessionId }
      if (next.length > 0) {
        referencesBySessionId[sessionId] = next
      } else {
        delete referencesBySessionId[sessionId]
      }
      return { referencesBySessionId }
    })
  },

  clearSelectionReferences: (sessionId) => {
    if (!sessionId) return

    set((state) => {
      if (!state.referencesBySessionId[sessionId]?.length) return state
      const referencesBySessionId = { ...state.referencesBySessionId }
      delete referencesBySessionId[sessionId]
      return { referencesBySessionId }
    })
  }
}))
