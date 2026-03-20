import * as React from 'react'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import type { ImageAttachment } from '@renderer/lib/image-attachments'
import {
  getRecentConversationFingerprint,
  requestPromptRecommendation
} from '@renderer/lib/recommendation/prompt-recommendation'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { AppMode } from '@renderer/stores/ui-store'

const DEBOUNCE_MS = 1000

type RecommendationCacheValue = string | null

interface UsePromptRecommendationParams {
  mode: AppMode
  sessionId?: string | null
  text: string
  recentMessages: UnifiedMessage[]
  selectedSkill: string | null
  images: ImageAttachment[]
  disabled: boolean
  isStreaming: boolean
  fallbackSuggestion: string
  getCaretAtEnd?: () => boolean
}

interface UsePromptRecommendationResult {
  suggestionText: string
  measureText: string
  effectivePlaceholder?: string
  canAcceptSuggestion: boolean
  acceptSuggestion: () => string | null
  handleFocus: () => void
  handleBlur: () => void
  handleSelectionChange: () => void
  handleCompositionStart: () => void
  handleCompositionEnd: () => void
}

function buildContextKey(
  mode: AppMode,
  text: string,
  recentMessages: UnifiedMessage[],
  selectedSkill: string | null,
  images: ImageAttachment[],
  providerBindingKey: string
): string {
  return JSON.stringify({
    mode,
    text,
    recent: getRecentConversationFingerprint(recentMessages),
    selectedSkill,
    imageIds: images.map((image) => image.id),
    binding: providerBindingKey
  })
}

export function usePromptRecommendation({
  mode,
  sessionId,
  text,
  recentMessages,
  selectedSkill,
  images,
  disabled,
  isStreaming,
  fallbackSuggestion,
  getCaretAtEnd
}: UsePromptRecommendationParams): UsePromptRecommendationResult {
  const [fullSuggestion, setFullSuggestion] = React.useState('')
  const [isFocused, setIsFocused] = React.useState(false)
  const [isComposing, setIsComposing] = React.useState(false)
  const [caretAtEnd, setCaretAtEnd] = React.useState(true)
  const [isDocumentVisible, setIsDocumentVisible] = React.useState(
    () => document.visibilityState === 'visible'
  )
  const [isWindowFocused, setIsWindowFocused] = React.useState(() => document.hasFocus())
  const cacheRef = React.useRef<Map<string, RecommendationCacheValue>>(new Map())
  const requestSeqRef = React.useRef(0)
  const abortRef = React.useRef<AbortController | null>(null)
  const previousTextRef = React.useRef(text)
  const previousContextKeyRef = React.useRef('')
  const skipNextTextRef = React.useRef<string | null>(null)
  const language = useSettingsStore((state) => state.language)
  const promptRecommendationModels = useSettingsStore((state) => state.promptRecommendationModels)
  const activeProviderId = useProviderStore((state) => state.activeProviderId)
  const activeFastProviderId = useProviderStore((state) => state.activeFastProviderId)
  const activeFastModelId = useProviderStore((state) => state.activeFastModelId)

  const providerBinding = promptRecommendationModels[mode]
  const providerBindingKey =
    providerBinding === 'disabled'
      ? '__disabled__'
      : providerBinding
        ? `${providerBinding.providerId}::${providerBinding.modelId}`
        : activeFastProviderId || activeProviderId
          ? `${activeFastProviderId ?? activeProviderId}::${activeFastModelId || '__auto__'}`
          : '__fast__'

  const rawContextKey = React.useMemo(
    () => buildContextKey(mode, text, recentMessages, selectedSkill, images, providerBindingKey),
    [mode, text, recentMessages, selectedSkill, images, providerBindingKey]
  )

  const clearSuggestion = React.useCallback(() => {
    setFullSuggestion('')
  }, [])

  const updateCaretState = React.useCallback(() => {
    if (!getCaretAtEnd) {
      setCaretAtEnd(true)
      return
    }

    setCaretAtEnd(getCaretAtEnd())
  }, [getCaretAtEnd])

  const applyResolvedSuggestion = React.useCallback(
    (resolvedText: string | null, requestText: string, fromFallback = false) => {
      if (!resolvedText) {
        setFullSuggestion('')
        return
      }

      if (requestText.length > 0 && !resolvedText.startsWith(requestText)) {
        setFullSuggestion('')
        if (!fromFallback) {
          cacheRef.current.set(
            buildContextKey(
              mode,
              requestText,
              recentMessages,
              selectedSkill,
              images,
              providerBindingKey
            ),
            null
          )
        }
        return
      }

      setFullSuggestion(resolvedText)
    },
    [images, mode, providerBindingKey, recentMessages, selectedSkill]
  )

  const runRequest = React.useCallback(
    async (requestText: string, allowFallback: boolean, contextKey: string): Promise<void> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const requestSeq = ++requestSeqRef.current

      const response = await requestPromptRecommendation(
        {
          mode,
          sessionId,
          draftText: requestText,
          recentMessages,
          selectedSkill,
          images,
          fallbackLanguage: language
        },
        controller.signal
      )

      if (controller.signal.aborted || requestSeq !== requestSeqRef.current) {
        return
      }

      if (response.status === 'disabled') {
        cacheRef.current.delete(contextKey)
        setFullSuggestion('')
        return
      }

      if (response.status === 'success' && response.text) {
        cacheRef.current.set(contextKey, response.text)
        applyResolvedSuggestion(response.text, requestText)
        return
      }

      if (allowFallback && fallbackSuggestion.trim()) {
        cacheRef.current.set(contextKey, fallbackSuggestion)
        applyResolvedSuggestion(fallbackSuggestion, requestText, true)
        return
      }

      cacheRef.current.set(contextKey, null)
      setFullSuggestion('')
    },
    [
      applyResolvedSuggestion,
      fallbackSuggestion,
      images,
      language,
      mode,
      recentMessages,
      selectedSkill,
      sessionId
    ]
  )

  React.useEffect(() => {
    updateCaretState()
  }, [text, updateCaretState])

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  React.useEffect(() => {
    const handleVisibilityChange = (): void => {
      const visible = document.visibilityState === 'visible'
      setIsDocumentVisible(visible)
      if (!visible) {
        abortRef.current?.abort()
        setFullSuggestion('')
      }
    }

    const handleWindowFocus = (): void => {
      setIsWindowFocused(true)
    }

    const handleWindowBlur = (): void => {
      setIsWindowFocused(false)
      abortRef.current?.abort()
      setFullSuggestion('')
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [])

  React.useEffect(() => {
    abortRef.current?.abort()
    setFullSuggestion('')
  }, [sessionId])

  React.useEffect(() => {
    if (
      !isFocused ||
      disabled ||
      isStreaming ||
      isComposing ||
      !isDocumentVisible ||
      !isWindowFocused
    ) {
      return
    }

    if (!text.trim()) {
      return
    }

    if (skipNextTextRef.current === text) {
      skipNextTextRef.current = null
      return
    }

    const contextKey = rawContextKey
    const cached = cacheRef.current.get(contextKey)
    if (cached !== undefined) {
      applyResolvedSuggestion(cached, text)
      return
    }

    const timer = window.setTimeout(() => {
      void runRequest(text, false, contextKey)
    }, DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [
    applyResolvedSuggestion,
    disabled,
    isComposing,
    isDocumentVisible,
    isFocused,
    isStreaming,
    isWindowFocused,
    rawContextKey,
    runRequest,
    text
  ])

  React.useEffect(() => {
    if (!text && !isFocused) {
      clearSuggestion()
    }
  }, [clearSuggestion, isFocused, text])

  React.useEffect(() => {
    if (previousTextRef.current && !text) {
      setFullSuggestion('')
    }
    previousTextRef.current = text
  }, [text])

  React.useEffect(() => {
    if (previousContextKeyRef.current && previousContextKeyRef.current !== rawContextKey && !text) {
      setFullSuggestion('')
    }
    previousContextKeyRef.current = rawContextKey
  }, [rawContextKey, text])

  const handleFocus = React.useCallback(() => {
    setIsFocused(true)
    updateCaretState()
  }, [updateCaretState])

  const handleBlur = React.useCallback(() => {
    setIsFocused(false)
    abortRef.current?.abort()
    setFullSuggestion('')
  }, [])

  const handleSelectionChange = React.useCallback(() => {
    updateCaretState()
  }, [updateCaretState])

  const handleCompositionStart = React.useCallback(() => {
    setIsComposing(true)
    setFullSuggestion('')
  }, [])

  const handleCompositionEnd = React.useCallback(() => {
    setIsComposing(false)
    updateCaretState()
  }, [updateCaretState])

  const suggestionText = React.useMemo(() => {
    if (
      !isFocused ||
      disabled ||
      isStreaming ||
      isComposing ||
      !caretAtEnd ||
      !isDocumentVisible ||
      !isWindowFocused
    ) {
      return ''
    }

    if (!fullSuggestion) {
      return ''
    }

    if (!text) {
      return fullSuggestion
    }

    if (!fullSuggestion.startsWith(text)) {
      return ''
    }

    return fullSuggestion.slice(text.length)
  }, [
    caretAtEnd,
    disabled,
    fullSuggestion,
    isComposing,
    isDocumentVisible,
    isFocused,
    isStreaming,
    isWindowFocused,
    text
  ])

  const canAcceptSuggestion = suggestionText.length > 0
  const effectivePlaceholder = text.length === 0 && suggestionText ? '' : undefined
  const measureText = suggestionText ? `${text}${suggestionText}` : ''

  const acceptSuggestion = React.useCallback((): string | null => {
    if (!canAcceptSuggestion) {
      return null
    }

    skipNextTextRef.current = fullSuggestion
    setFullSuggestion('')
    return fullSuggestion
  }, [canAcceptSuggestion, fullSuggestion])

  return {
    suggestionText,
    measureText,
    effectivePlaceholder,
    canAcceptSuggestion,
    acceptSuggestion,
    handleFocus,
    handleBlur,
    handleSelectionChange,
    handleCompositionStart,
    handleCompositionEnd
  }
}
