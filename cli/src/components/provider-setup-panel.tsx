import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '../i18n.js'
import { fitText, graphemes, hasTerminalInputControl } from '../lib/text.js'
import { theme } from '../theme.js'
import type { ProviderSetupCatalog, ProviderSetupInput, ProviderSetupOption } from '../types.js'
import { Spinner } from './spinner.js'

interface ProviderSetupPanelProps {
  catalog: ProviderSetupCatalog
  maxVisible: number
  onCancel(): void
  onSave(input: ProviderSetupInput): Promise<void>
  width: number
}

type SetupStep = 'provider' | 'name' | 'endpoint' | 'apiKey' | 'model' | 'review'

interface ProviderDraft {
  apiKey: string
  baseUrl: string
  modelId: string
  name: string
  optionKey: string
}

function matches(option: ProviderSetupOption, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [option.name, option.description, option.providerType, option.builtinId ?? ''].some(
    (value) => value.toLocaleLowerCase().includes(normalized)
  )
}

function protocolLabel(option: ProviderSetupOption): string {
  const protocol = option.modelType ?? option.providerType
  if (protocol === 'anthropic') return 'Anthropic Messages'
  if (protocol === 'gemini-interactions') return 'Google Interactions'
  if (protocol === 'openai-responses') return 'OpenAI Responses'
  return 'OpenAI Chat Completions'
}

function optionStatus(option: ProviderSetupOption): string {
  if (option.source === 'custom') return t('cli.provider.newCustom', 'new custom provider')
  if (option.source === 'preset') return t('cli.provider.quickPreset', 'quick preset')
  if (!option.requiresApiKey) return t('cli.provider.noKeyRequired', 'configured · no key required')
  return option.hasApiKey
    ? t('cli.provider.keySaved', 'configured · key saved')
    : t('cli.provider.needsKey', 'needs API key')
}

function titleFor(step: SetupStep): string {
  if (step === 'name') return t('cli.provider.name', 'Provider name')
  if (step === 'endpoint') return t('cli.provider.baseUrl', 'Base URL')
  if (step === 'apiKey') return t('cli.panels.apiKey', 'API key')
  if (step === 'model') return t('cli.provider.modelId', 'Model ID')
  return t('cli.provider.configure', 'Configure provider')
}

function editorLimit(step: SetupStep): number {
  if (step === 'name') return 100
  if (step === 'endpoint') return 2_048
  if (step === 'apiKey') return 8_192
  return 300
}

function EditorValue({
  cursor,
  secret,
  value,
  width
}: {
  cursor: number
  secret: boolean
  value: string
  width: number
}): React.JSX.Element {
  const source = graphemes(value)
  const display = secret ? source.map(() => '•') : source
  const available = Math.max(8, width - 2)
  const start = Math.max(0, Math.min(cursor - available + 1, display.length - available))
  const end = Math.min(display.length, start + available)
  const visible = display.slice(start, end)
  const localCursor = Math.max(0, Math.min(cursor - start, visible.length))
  const before = visible.slice(0, localCursor).join('')
  const current = visible[localCursor] ?? ' '
  const after = visible.slice(localCursor + (visible[localCursor] ? 1 : 0)).join('')

  return (
    <Box>
      <Text color={theme.dim}>{start > 0 ? '…' : ''}</Text>
      <Text color={theme.primary}>{before}</Text>
      <Text backgroundColor={theme.primary} color={theme.selectedText}>
        {current}
      </Text>
      <Text color={theme.primary}>{after}</Text>
      <Text color={theme.dim}>{end < display.length ? '…' : ''}</Text>
    </Box>
  )
}

export function ProviderSetupPanel({
  catalog,
  maxVisible,
  onCancel,
  onSave,
  width
}: ProviderSetupPanelProps): React.JSX.Element {
  const [step, setStep] = useState<SetupStep>('provider')
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [editor, setEditor] = useState('')
  const [editorCursor, setEditorCursor] = useState(0)
  const [returnToReview, setReturnToReview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const filtered = useMemo(
    () => catalog.options.filter((option) => matches(option, query)),
    [catalog.options, query]
  )
  const option = draft
    ? catalog.options.find((candidate) => candidate.key === draft.optionKey)
    : undefined

  useEffect(() => {
    setSelectedIndex((index) => Math.max(0, Math.min(index, filtered.length - 1)))
  }, [filtered.length])

  const beginEditor = (
    nextStep: Exclude<SetupStep, 'provider' | 'review'>,
    value: string
  ): void => {
    setStep(nextStep)
    setEditor(value)
    setEditorCursor(graphemes(value).length)
    setError(undefined)
  }

  const beginSetup = (selected: ProviderSetupOption): void => {
    const nextDraft: ProviderDraft = {
      apiKey: '',
      baseUrl: selected.baseUrl,
      modelId: selected.defaultModelId,
      name: selected.name,
      optionKey: selected.key
    }
    setDraft(nextDraft)
    setQuery('')
    setReturnToReview(false)
    if (selected.source === 'custom') {
      beginEditor('name', nextDraft.name)
    } else if (!nextDraft.baseUrl) {
      beginEditor('endpoint', '')
    } else if (selected.requiresApiKey && !selected.hasApiKey) {
      beginEditor('apiKey', '')
    } else {
      beginEditor('model', nextDraft.modelId)
    }
  }

  const advanceAfterEndpoint = (current: ProviderDraft, selected: ProviderSetupOption): void => {
    if (selected.requiresApiKey && !selected.hasApiKey && !current.apiKey) {
      beginEditor('apiKey', current.apiKey)
    } else {
      beginEditor('model', current.modelId)
    }
  }

  const finishEditor = (): void => {
    if (!draft || !option) return
    const value = editor.trim()
    if (!value && step !== 'apiKey') {
      setError(`${titleFor(step)} is required.`)
      return
    }
    if (step === 'apiKey' && option.requiresApiKey && !value && !option.hasApiKey) {
      setError('API key is required for this provider.')
      return
    }
    if (step === 'model' && /\s/u.test(value)) {
      setError('Model ID must not contain whitespace.')
      return
    }

    const nextDraft: ProviderDraft = {
      ...draft,
      ...(step === 'name' ? { name: value } : {}),
      ...(step === 'endpoint' ? { baseUrl: value } : {}),
      ...(step === 'apiKey' ? { apiKey: value } : {}),
      ...(step === 'model' ? { modelId: value } : {})
    }
    setDraft(nextDraft)
    setError(undefined)
    if (returnToReview) {
      setReturnToReview(false)
      setStep('review')
      return
    }
    if (step === 'name') {
      beginEditor('endpoint', nextDraft.baseUrl)
    } else if (step === 'endpoint') {
      advanceAfterEndpoint(nextDraft, option)
    } else if (step === 'apiKey') {
      beginEditor('model', nextDraft.modelId)
    } else if (!nextDraft.baseUrl) {
      beginEditor('endpoint', nextDraft.baseUrl)
    } else {
      setStep('review')
    }
  }

  const editReviewField = (
    nextStep: Exclude<SetupStep, 'provider' | 'review'>,
    value: string
  ): void => {
    setReturnToReview(true)
    beginEditor(nextStep, value)
  }

  const backFromEditor = (): void => {
    if (!draft || !option) {
      setStep('provider')
      return
    }
    if (returnToReview) {
      setReturnToReview(false)
      setStep('review')
      setError(undefined)
      return
    }
    if (step === 'name') {
      setDraft(null)
      setStep('provider')
    } else if (step === 'endpoint' && option.source === 'custom') {
      beginEditor('name', draft.name)
    } else if (step === 'apiKey' && option.source === 'custom') {
      beginEditor('endpoint', draft.baseUrl)
    } else if (step === 'model' && option.source === 'custom') {
      if (option.requiresApiKey) beginEditor('apiKey', draft.apiKey)
      else beginEditor('endpoint', draft.baseUrl)
    } else if (step === 'model' && option.requiresApiKey && !option.hasApiKey) {
      beginEditor('apiKey', draft.apiKey)
    } else {
      setDraft(null)
      setStep('provider')
    }
  }

  const save = async (): Promise<void> => {
    if (!draft || saving) return
    setSaving(true)
    setError(undefined)
    try {
      await onSave({
        apiKey: draft.apiKey || undefined,
        baseUrl: draft.baseUrl,
        modelId: draft.modelId,
        name: draft.name,
        optionKey: draft.optionKey
      })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  useInput((input, key) => {
    if (saving) return
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }

    if (step === 'provider') {
      if (key.escape) {
        if (query) {
          setQuery('')
          setSelectedIndex(0)
        } else {
          onCancel()
        }
        return
      }
      if (key.upArrow) {
        setSelectedIndex((index) => (index <= 0 ? Math.max(0, filtered.length - 1) : index - 1))
        return
      }
      if (key.downArrow) {
        setSelectedIndex((index) => (filtered.length > 0 ? (index + 1) % filtered.length : 0))
        return
      }
      if (key.return) {
        const selected = filtered[selectedIndex]
        if (selected) beginSetup(selected)
        return
      }
      if (key.ctrl && input === 'u') {
        setQuery('')
        setSelectedIndex(0)
        return
      }
      if (key.backspace || key.delete) {
        setQuery((value) => graphemes(value).slice(0, -1).join(''))
        setSelectedIndex(0)
        return
      }
      if (!key.ctrl && !key.meta && input && !hasTerminalInputControl(input)) {
        setQuery((value) => value + input)
        setSelectedIndex(0)
      }
      return
    }

    if (step === 'review') {
      if (key.escape) {
        if (draft) beginEditor('model', draft.modelId)
        return
      }
      const shortcut = input.toLocaleLowerCase()
      if (shortcut === 'n' && draft) editReviewField('name', draft.name)
      else if (shortcut === 'e' && draft) editReviewField('endpoint', draft.baseUrl)
      else if (shortcut === 'k' && draft && option?.requiresApiKey) {
        editReviewField('apiKey', draft.apiKey)
      } else if (shortcut === 'm' && draft) editReviewField('model', draft.modelId)
      else if (key.return) void save()
      return
    }

    if (key.escape) {
      backFromEditor()
      return
    }
    if (key.return) {
      finishEditor()
      return
    }
    if (key.leftArrow || (key.ctrl && input === 'b')) {
      setEditorCursor((cursor) => Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow || (key.ctrl && input === 'f')) {
      setEditorCursor((cursor) => Math.min(graphemes(editor).length, cursor + 1))
      return
    }
    if (key.ctrl && input === 'a') {
      setEditorCursor(0)
      return
    }
    if (key.ctrl && input === 'e') {
      setEditorCursor(graphemes(editor).length)
      return
    }
    if (key.ctrl && input === 'u') {
      setEditor('')
      setEditorCursor(0)
      setError(undefined)
      return
    }
    if (key.backspace) {
      const characters = graphemes(editor)
      if (editorCursor <= 0) return
      setEditor(
        [...characters.slice(0, editorCursor - 1), ...characters.slice(editorCursor)].join('')
      )
      setEditorCursor(editorCursor - 1)
      setError(undefined)
      return
    }
    if (key.delete) {
      const characters = graphemes(editor)
      if (editorCursor >= characters.length) return
      setEditor(
        [...characters.slice(0, editorCursor), ...characters.slice(editorCursor + 1)].join('')
      )
      setError(undefined)
      return
    }
    if (!key.ctrl && !key.meta && input && !hasTerminalInputControl(input)) {
      const characters = graphemes(editor)
      const inserted = graphemes(input)
      if (characters.length + inserted.length > editorLimit(step)) {
        setError(`${titleFor(step)} is too long.`)
        return
      }
      setEditor(
        [...characters.slice(0, editorCursor), ...inserted, ...characters.slice(editorCursor)].join(
          ''
        )
      )
      setEditorCursor(editorCursor + inserted.length)
      setError(undefined)
    }
  })

  const visibleCount = Math.max(4, maxVisible)
  const windowStart = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleCount / 2), filtered.length - visibleCount)
  )
  const visible = filtered.slice(windowStart, windowStart + visibleCount)
  const contentWidth = Math.max(24, width - 6)

  return (
    <Box
      borderColor={theme.accent}
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Box>
        <Text bold color={theme.primary}>
          {titleFor(step)}
        </Text>
        {saving ? (
          <Box marginLeft={2}>
            <Spinner />
            <Text color={theme.muted}> {t('cli.common.saving', 'saving')}</Text>
          </Box>
        ) : null}
      </Box>
      <Text color={theme.muted}>
        {t('cli.panels.sharedDesktop', 'Shared with OpenCowork desktop · credentials are masked')}
      </Text>

      {step === 'provider' ? (
        <>
          <Box marginTop={1}>
            <Text color={theme.dim}>{t('cli.common.search', 'Search')} </Text>
            <Text color={query ? theme.text : theme.primary}>{query || ' '}▏</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {visible.length === 0 ? (
              <Text color={theme.muted}>
                {t('cli.provider.noMatches', 'No providers match “{{query}}”.', {
                  query: fitText(query, contentWidth - 22)
                })}
              </Text>
            ) : (
              visible.map((candidate, visibleIndex) => {
                const absoluteIndex = windowStart + visibleIndex
                const selected = absoluteIndex === selectedIndex
                return (
                  <Box flexDirection="column" key={candidate.key}>
                    <Box>
                      <Text color={selected ? theme.primary : theme.dim}>
                        {selected ? '❯' : ' '}
                      </Text>
                      <Text bold={selected} color={selected ? theme.text : undefined}>
                        {fitText(candidate.name, Math.max(12, contentWidth - 25))}
                      </Text>
                      <Text color={candidate.hasApiKey ? theme.success : theme.dim}>
                        {'  '}
                        {optionStatus(candidate)}
                      </Text>
                    </Box>
                    {selected ? (
                      <Box marginLeft={2}>
                        <Text color={theme.muted}>
                          {fitText(candidate.description, contentWidth - 2)}
                        </Text>
                      </Box>
                    ) : null}
                  </Box>
                )
              })
            )}
          </Box>
          <Text color={theme.dim}>
            {filtered.length > visible.length
              ? `${windowStart + 1}–${windowStart + visible.length} of ${filtered.length} · `
              : ''}
            {t(
              'cli.provider.listFooter',
              'Type to search · ↑↓ navigate · Enter select · Esc cancel'
            )}
          </Text>
        </>
      ) : step === 'review' && draft && option ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={theme.dim}>{t('cli.panels.provider', 'Provider')} </Text>
            <Text>{fitText(draft.name, contentWidth - 12)}</Text>
          </Box>
          <Box>
            <Text color={theme.dim}>{t('cli.panels.protocol', 'Protocol')} </Text>
            <Text>{protocolLabel(option)}</Text>
          </Box>
          <Box>
            <Text color={theme.dim}>{t('cli.panels.endpoint', 'Endpoint')} </Text>
            <Text>{fitText(draft.baseUrl, contentWidth - 12)}</Text>
          </Box>
          <Box>
            <Text color={theme.dim}>{t('cli.model.model', 'Model')} </Text>
            <Text>{fitText(draft.modelId, contentWidth - 12)}</Text>
          </Box>
          <Box>
            <Text color={theme.dim}>{t('cli.panels.apiKey', 'API key')} </Text>
            <Text color={option.requiresApiKey ? theme.success : theme.muted}>
              {option.requiresApiKey
                ? draft.apiKey
                  ? '•••••••• (new)'
                  : `•••••••• (${t('cli.provider.saved', 'saved')})`
                : t('cli.provider.notRequired', 'not required')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.muted} wrap="wrap">
              {t(
                'cli.provider.savedUnder',
                'Saved under {{directory}} with private file permissions. Existing provider fields and other providers are preserved.',
                { directory: fitText(catalog.dataDirectory, Math.max(12, contentWidth - 18)) }
              )}
            </Text>
          </Box>
          {error ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">
                {error}
              </Text>
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text color={theme.dim}>
              {t('cli.provider.reviewFooter', 'Enter save · M model · E endpoint')}
              {option.requiresApiKey ? ` · ${t('cli.provider.keyShortcut', 'K key')}` : ''}
              {option.source === 'custom' ? ` · ${t('cli.provider.nameShortcut', 'N name')}` : ''}
              {` · ${t('cli.common.back', 'Esc back')}`}
            </Text>
          </Box>
        </Box>
      ) : draft && option ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>{draft.name}</Text>
          <Box marginTop={1}>
            <EditorValue
              cursor={editorCursor}
              secret={step === 'apiKey'}
              value={editor}
              width={contentWidth}
            />
          </Box>
          <Text color={theme.muted}>
            {step === 'name'
              ? t('cli.provider.nameHint', 'A short label shown in model pickers.')
              : step === 'endpoint'
                ? t(
                    'cli.provider.endpointHint',
                    'HTTP(S) API root, for example https://api.example.com/v1.'
                  )
                : step === 'apiKey'
                  ? option.hasApiKey
                    ? t(
                        'cli.provider.keepKeyHint',
                        'Leave empty to keep the saved key. Input is never echoed.'
                      )
                    : t(
                        'cli.provider.keyHint',
                        'Input is masked and saved only in the shared provider store.'
                      )
                  : t('cli.provider.modelHint', 'Exact model identifier sent to the provider.')}
          </Text>
          {error ? (
            <Text color={theme.error} wrap="wrap">
              {error}
            </Text>
          ) : null}
          <Text color={theme.dim}>
            {t('cli.panels.enterContinue', 'Enter continue · Esc back · Ctrl+U clear')}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
