import * as React from 'react'
import {
  getInputDraft,
  hasInputDraftContent,
  removeInputDraft,
  setCachedInputDraft,
  setInputDraft,
  type InputDraftContext,
  type InputDraftRecord,
  type InputDraftValue
} from '@renderer/lib/input-drafts'

interface UseInputDraftPersistenceOptions {
  draftKey: string | null
  context: InputDraftContext
  enabled?: boolean
}

interface UseInputDraftPersistenceResult {
  hydrated: boolean
  loadedDraft: InputDraftRecord | null
  saveDraft: (draft: InputDraftValue) => Promise<void>
  removeDraft: () => Promise<void>
}

export function useInputDraftPersistence({
  draftKey,
  context,
  enabled = true
}: UseInputDraftPersistenceOptions): UseInputDraftPersistenceResult {
  const [hydrated, setHydrated] = React.useState(false)
  const [loadedDraft, setLoadedDraft] = React.useState<InputDraftRecord | null>(null)
  const loadRequestRef = React.useRef(0)

  React.useEffect(() => {
    const requestId = loadRequestRef.current + 1
    loadRequestRef.current = requestId
    let cancelled = false

    setHydrated(false)
    setLoadedDraft(null)

    if (!enabled || !draftKey) {
      setHydrated(true)
      return () => {
        cancelled = true
      }
    }

    void getInputDraft(draftKey)
      .then((draft) => {
        if (cancelled || loadRequestRef.current !== requestId) return
        setLoadedDraft(draft)
        setCachedInputDraft(draftKey, draft)
      })
      .catch((error) => {
        console.warn('[InputDraft] Failed to load draft:', error)
      })
      .finally(() => {
        if (cancelled || loadRequestRef.current !== requestId) return
        setHydrated(true)
      })

    return () => {
      cancelled = true
    }
  }, [draftKey, enabled])

  const saveDraft = React.useCallback(
    async (draft: InputDraftValue): Promise<void> => {
      if (!enabled || !draftKey) return

      const result = hasInputDraftContent(draft)
        ? await setInputDraft({ draftKey, draft, context })
        : await removeInputDraft(draftKey)

      if (!result.success) {
        console.warn('[InputDraft] Failed to save draft:', result.error)
      }
    },
    [context, draftKey, enabled]
  )

  const removeDraft = React.useCallback(async (): Promise<void> => {
    if (!draftKey) return
    const result = await removeInputDraft(draftKey)
    if (!result.success) {
      console.warn('[InputDraft] Failed to remove draft:', result.error)
    }
  }, [draftKey])

  return {
    hydrated,
    loadedDraft,
    saveDraft,
    removeDraft
  }
}
