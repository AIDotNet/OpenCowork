import * as React from 'react'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  MessageSquare,
  Sparkles,
  PanelRight,
  ListChecks
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Textarea } from '@renderer/components/ui/textarea'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { coerceAskUserQuestions, resolveAskUserAnswers } from '@renderer/lib/tools/ask-user-tool'
import type {
  AskUserQuestionItem,
  AskUserAnswers,
  AskUserAnnotation,
  AskUserResolvedPayload,
  AskUserStructuredResult
} from '@renderer/lib/tools/ask-user-tool'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'
import {
  decodeStructuredToolResult,
  isStructuredToolErrorText
} from '@renderer/lib/tools/tool-result-format'

interface AskUserQuestionCardProps {
  toolUseId: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  isLive: boolean
}

interface AnsweredPair {
  question: string
  answer: string
  annotation?: AskUserAnnotation
}

const RECOMMENDED_OPTION_RE = /(?:\(|（)\s*(recommended|推荐)\s*(?:\)|）)/i

function getOptionLabel(label: string | undefined | null): string {
  return typeof label === 'string' ? label : ''
}

function isRecommendedOptionLabel(label: string | undefined | null): boolean {
  return RECOMMENDED_OPTION_RE.test(getOptionLabel(label))
}

function stripRecommendedMarker(label: string | undefined | null): string {
  return getOptionLabel(label).replace(RECOMMENDED_OPTION_RE, '').trim()
}

function outputAsText(output: ToolResultContent | undefined): string | null {
  if (!output) return null
  const text =
    typeof output === 'string'
      ? output
      : output
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n')
  return text || null
}

function parseStructuredAnsweredResult(
  output: ToolResultContent | undefined
): AskUserStructuredResult | null {
  const text = outputAsText(output)
  if (!text) return null
  const parsed = decodeStructuredToolResult(text)
  if (!parsed || Array.isArray(parsed)) return null
  if (!parsed.answers || typeof parsed.answers !== 'object' || Array.isArray(parsed.answers))
    return null

  const answers = parsed.answers as Record<string, unknown>
  const normalizedAnswers: Record<string, string> = {}
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === 'string') {
      normalizedAnswers[key] = value
    }
  }

  const annotationsSource =
    parsed.annotations &&
    typeof parsed.annotations === 'object' &&
    !Array.isArray(parsed.annotations)
      ? (parsed.annotations as Record<string, AskUserAnnotation>)
      : undefined

  return {
    questions: Array.isArray(parsed.questions) ? (parsed.questions as AskUserQuestionItem[]) : [],
    answers: normalizedAnswers,
    summary:
      typeof parsed.summary === 'string' ? parsed.summary : 'User has answered your questions.',
    ...(annotationsSource ? { annotations: annotationsSource } : {}),
    ...(typeof parsed.source === 'string' && parsed.source.trim()
      ? { source: parsed.source.trim() }
      : {}),
    ...(parsed.autoAnswered === true ? { autoAnswered: true } : {})
  }
}

function parseLegacyAnsweredPairs(output: ToolResultContent | undefined): AnsweredPair[] {
  const text = outputAsText(output)
  if (!text || !/^User answered:\s*/i.test(text)) return []

  const body = text.replace(/^User answered:\s*/i, '').trim()
  if (!body) return []

  const pairs: AnsweredPair[] = []
  const lines = body.split(/\r?\n/)
  let currentQuestion = ''
  let currentAnswerLines: string[] = []
  let collectingAnswer = false

  const flush = (): void => {
    const question = currentQuestion.trim()
    const answer = currentAnswerLines.join('\n').trim()
    if (question && answer) {
      pairs.push({ question, answer })
    }
    currentQuestion = ''
    currentAnswerLines = []
    collectingAnswer = false
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (collectingAnswer && currentAnswerLines.length > 0) {
        currentAnswerLines.push('')
      }
      continue
    }

    if (line.startsWith('Q: ')) {
      flush()
      currentQuestion = line.slice(3).trim()
      continue
    }

    if (line.startsWith('A: ')) {
      collectingAnswer = true
      currentAnswerLines = [line.slice(3).trim()]
      continue
    }

    if (collectingAnswer) {
      currentAnswerLines.push(line)
    } else if (currentQuestion) {
      currentQuestion = `${currentQuestion} ${line}`.trim()
    }
  }

  flush()
  return pairs
}

function parseAnsweredPairs(output: ToolResultContent | undefined): {
  pairs: AnsweredPair[]
  structured: AskUserStructuredResult | null
} {
  const structured = parseStructuredAnsweredResult(output)
  if (structured) {
    const pairs = Object.entries(structured.answers).map(([question, answer]) => ({
      question,
      answer,
      annotation: structured.annotations?.[question]
    }))
    return { pairs, structured }
  }

  return {
    pairs: parseLegacyAnsweredPairs(output),
    structured: null
  }
}

function isRedundantSummary(summary: string | undefined, pairs: AnsweredPair[]): boolean {
  const normalized = summary?.trim()
  if (!normalized) return true
  if (pairs.length === 0) return false

  return /^User has answered your questions(?::|\.)/i.test(normalized)
}

function buildRecommendedPayload(
  questions: AskUserQuestionItem[]
): { payload: AskUserResolvedPayload; selections: Map<number, Set<string>> } | null {
  const answers: AskUserAnswers = {}
  const annotations: Record<string, AskUserAnnotation> = {}
  const selections = new Map<number, Set<string>>()

  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index]
    const recommended = (item.options ?? []).filter((opt) => isRecommendedOptionLabel(opt.label))

    if (recommended.length === 0) {
      return null
    }

    const chosen = item.multiSelect ? recommended : [recommended[0]]
    const labels = chosen.map((opt) => getOptionLabel(opt.label)).filter(Boolean)
    if (labels.length === 0) {
      return null
    }
    selections.set(index, new Set(labels))
    answers[String(index)] = item.multiSelect ? labels : labels[0]

    if (!item.multiSelect && chosen[0]?.preview) {
      annotations[String(index)] = { preview: chosen[0].preview }
    }
  }

  return {
    payload: {
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {})
    },
    selections
  }
}

function looksLikeHtmlPreview(preview: string): boolean {
  return /<\s*[a-z!][^>]*>/i.test(preview)
}

function buildPreviewDocument(preview: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      html, body { margin: 0; padding: 0; }
      body {
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        line-height: 1.45;
        padding: 12px;
        background: transparent;
      }
      * { box-sizing: border-box; }
    </style>
  </head>
  <body>${preview}</body>
</html>`
}

function PreviewPane({ preview }: { preview: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  const isHtml = looksLikeHtmlPreview(preview)

  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <PanelRight className="size-3.5 text-primary/80" />
        <div className="text-xs font-medium text-foreground">
          {t('askUser.previewTitle', { defaultValue: '选项预览' })}
        </div>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {isHtml ? 'HTML' : 'Markdown'}
        </Badge>
      </div>
      {isHtml ? (
        <iframe
          title="Ask user question preview"
          sandbox=""
          srcDoc={buildPreviewDocument(preview)}
          className="h-56 w-full rounded-lg border border-border/60 bg-background"
        />
      ) : (
        <div className="max-h-56 overflow-auto rounded-lg border border-border/60 bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground">
          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-2 prose-pre:bg-muted prose-pre:px-3 prose-pre:py-2 prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded-sm">
            <Markdown remarkPlugins={[remarkGfm]}>{preview}</Markdown>
          </div>
        </div>
      )}
    </div>
  )
}

function QuestionBlock({
  index,
  item,
  selected,
  customText,
  notes,
  hoveredOption,
  onToggle,
  onCustomTextChange,
  onNotesChange,
  onHoverOption,
  disabled
}: {
  index: number
  item: AskUserQuestionItem
  selected: Set<string>
  customText: string
  notes: string
  hoveredOption?: string | null
  onToggle: (index: number, value: string) => void
  onCustomTextChange: (index: number, text: string) => void
  onNotesChange: (index: number, text: string) => void
  onHoverOption: (index: number, value: string | null) => void
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const isOtherSelected = selected.has('__other__')
  const selectedLabels = [...selected].filter((value) => value !== '__other__')
  const selectedOption =
    !item.multiSelect && selectedLabels.length === 1
      ? item.options?.find((option) => option.label === selectedLabels[0])
      : undefined
  const hoveredPreviewOption =
    !item.multiSelect && hoveredOption
      ? item.options?.find((option) => option.label === hoveredOption)
      : undefined
  const selectedPreview = hoveredPreviewOption?.preview ?? selectedOption?.preview
  const showNotes = !!item.options?.length && selectedLabels.length > 0 && !isOtherSelected

  return (
    <div
      className={cn(
        'grid gap-3',
        selectedPreview && 'lg:grid-cols-[minmax(0,1.1fr)_minmax(260px,0.9fr)]'
      )}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          {item.header && (
            <Badge variant="secondary" className="px-2 py-0.5 text-[10px] font-medium">
              {item.header}
            </Badge>
          )}
          <p className="text-[13px] font-semibold leading-tight text-foreground">{item.question}</p>
        </div>

        {item.options && item.options.length > 0 && (
          <div className="space-y-1.5">
            {item.options.map((opt, oi) => {
              const value = getOptionLabel(opt.label)
              if (!value) return null

              const isSelected = selected.has(value)
              const isRecommended = isRecommendedOptionLabel(value)
              return (
                <button
                  key={oi}
                  disabled={disabled}
                  onClick={() => onToggle(index, value)}
                  onMouseEnter={() => onHoverOption(index, value)}
                  onFocus={() => onHoverOption(index, value)}
                  onMouseLeave={() => onHoverOption(index, null)}
                  onBlur={() => onHoverOption(index, null)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left text-[13px] leading-tight transition-all',
                    isSelected
                      ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                      : 'border-border/80 bg-background/80 hover:border-primary/50 hover:bg-muted/40 hover:shadow-sm',
                    disabled && 'cursor-not-allowed opacity-50'
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-all',
                      item.multiSelect ? 'rounded-md' : 'rounded-full',
                      isSelected
                        ? 'scale-105 border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40 bg-background'
                    )}
                  >
                    {isSelected && <Check className="size-3 stroke-[2.5]" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <div
                        className={cn(
                          'font-medium transition-colors',
                          isSelected ? 'text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        {stripRecommendedMarker(opt.label)}
                      </div>
                      {isRecommended && (
                        <Badge
                          variant="outline"
                          className="border-primary/30 text-[10px] text-primary"
                        >
                          <Sparkles className="size-3" />
                          {t('askUser.recommended', { defaultValue: '推荐' })}
                        </Badge>
                      )}
                      {opt.preview && !item.multiSelect && (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          <PanelRight className="size-3" />
                          {t('askUser.previewBadge', { defaultValue: '预览' })}
                        </Badge>
                      )}
                    </div>
                    {opt.description && (
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">
                        {opt.description}
                      </p>
                    )}
                  </div>
                </button>
              )
            })}
            <button
              disabled={disabled}
              onClick={() => onToggle(index, '__other__')}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left text-[13px] leading-tight transition-all',
                isOtherSelected
                  ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                  : 'border-border/80 bg-background/80 hover:border-primary/50 hover:bg-muted/40 hover:shadow-sm',
                disabled && 'cursor-not-allowed opacity-50'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-all',
                  item.multiSelect ? 'rounded-md' : 'rounded-full',
                  isOtherSelected
                    ? 'scale-105 border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/40 bg-background'
                )}
              >
                {isOtherSelected && <Check className="size-3 stroke-[2.5]" />}
              </span>
              <span
                className={cn(
                  'font-medium transition-colors',
                  isOtherSelected ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {t('askUser.other', { defaultValue: '其他' })}
              </span>
            </button>
          </div>
        )}

        {(!item.options || item.options.length === 0 || isOtherSelected) && (
          <Textarea
            disabled={disabled}
            value={customText}
            onChange={(e) => onCustomTextChange(index, e.target.value)}
            placeholder={t('askUser.answerPlaceholder', { defaultValue: '输入你的回答…' })}
            rows={3}
            className={cn(
              'min-h-[84px] rounded-xl border bg-background/70 text-sm shadow-none',
              'placeholder:text-muted-foreground/50',
              'focus-visible:ring-2 focus-visible:ring-primary/25',
              disabled && 'cursor-not-allowed bg-muted/20 opacity-50'
            )}
          />
        )}

        {showNotes && (
          <div className="space-y-1.5 rounded-xl border border-dashed border-border/70 bg-muted/10 p-3">
            <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
              <ListChecks className="size-3.5" />
              {t('askUser.notesTitle', { defaultValue: '补充说明（可选）' })}
            </div>
            <Textarea
              disabled={disabled}
              value={notes}
              onChange={(e) => onNotesChange(index, e.target.value)}
              placeholder={t('askUser.notesPlaceholder', {
                defaultValue: '补充你的约束、偏好或说明…'
              })}
              rows={3}
              className={cn(
                'min-h-[76px] rounded-lg border bg-background/80 text-sm shadow-none',
                'placeholder:text-muted-foreground/50',
                'focus-visible:ring-2 focus-visible:ring-primary/25',
                disabled && 'cursor-not-allowed bg-muted/20 opacity-50'
              )}
            />
          </div>
        )}
      </div>

      {selectedPreview && <PreviewPane preview={selectedPreview} />}
    </div>
  )
}

function buildSubmissionPayload(
  questions: AskUserQuestionItem[],
  selections: Map<number, Set<string>>,
  customTexts: Map<number, string>,
  notesByQuestion: Map<number, string>
): AskUserResolvedPayload {
  const answers: AskUserAnswers = {}
  const annotations: Record<string, AskUserAnnotation> = {}

  for (let i = 0; i < questions.length; i += 1) {
    const sel = selections.get(i) ?? new Set()
    const custom = customTexts.get(i) ?? ''
    const notes = notesByQuestion.get(i)?.trim() ?? ''
    const q = questions[i]
    const picked = [...sel].filter((value) => value !== '__other__')

    if (sel.has('__other__') || !q.options || q.options.length === 0) {
      if (custom.trim()) {
        answers[String(i)] = q.multiSelect ? [...picked, custom.trim()] : custom.trim()
      } else if (picked.length > 0) {
        answers[String(i)] = q.multiSelect ? picked : picked[0]
      }
    } else if (picked.length > 0) {
      answers[String(i)] = q.multiSelect ? picked : picked[0]
    }

    if (!q.multiSelect && picked.length === 1) {
      const option = q.options?.find((candidate) => candidate.label === picked[0])
      if (option?.preview || notes) {
        annotations[String(i)] = {
          ...(option?.preview ? { preview: option.preview } : {}),
          ...(notes ? { notes } : {})
        }
      }
    } else if (notes) {
      annotations[String(i)] = { notes }
    }
  }

  return {
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {})
  }
}

export function AskUserQuestionCard({
  toolUseId,
  input,
  output,
  status,
  isLive
}: AskUserQuestionCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const questions = React.useMemo(() => coerceAskUserQuestions(input.questions), [input.questions])
  const clarifyAutoAcceptRecommended = useSettingsStore((s) => s.clarifyAutoAcceptRecommended)
  const parsedAnswers = React.useMemo(() => parseAnsweredPairs(output), [output])
  const answeredPairs = parsedAnswers.pairs
  const answeredStructured = parsedAnswers.structured
  const answeredText = React.useMemo(() => outputAsText(output), [output])
  const outputErrorMessage = React.useMemo(() => {
    const text = outputAsText(output)
    if (!text || !isStructuredToolErrorText(text)) return null
    const parsed = decodeStructuredToolResult(text)
    if (!parsed || Array.isArray(parsed) || typeof parsed.error !== 'string') return null
    return parsed.error
  }, [output])
  const isError = status === 'error' || !!outputErrorMessage
  const isCanceled = status === 'canceled'
  const isAnswered = status === 'completed' && answeredPairs.length > 0
  const isPending = !isAnswered && !isError && !isCanceled && (status === 'running' || isLive)
  const isCompletedWithoutAnswers =
    status === 'completed' && !isAnswered && !isError && !isCanceled && !!answeredText

  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map())
  const [customTexts, setCustomTexts] = useState<Map<number, string>>(() => new Map())
  const [notesByQuestion, setNotesByQuestion] = useState<Map<number, string>>(() => new Map())
  const [hoveredOptions, setHoveredOptions] = useState<Map<number, string | null>>(() => new Map())
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const autoSubmittedRef = React.useRef(false)

  const recommendedPayload = React.useMemo(() => buildRecommendedPayload(questions), [questions])

  React.useEffect(() => {
    autoSubmittedRef.current = false
    setSelections(new Map())
    setCustomTexts(new Map())
    setNotesByQuestion(new Map())
    setHoveredOptions(new Map())
    setCurrentQuestionIndex(0)
  }, [toolUseId])

  React.useEffect(() => {
    if (autoSubmittedRef.current) return
    if (!isPending || isAnswered) return
    if (!clarifyAutoAcceptRecommended) return
    if (!recommendedPayload) return

    autoSubmittedRef.current = true
    setSelections(recommendedPayload.selections)
    setCurrentQuestionIndex(Math.max(questions.length - 1, 0))
    resolveAskUserAnswers(toolUseId, recommendedPayload.payload)
  }, [
    clarifyAutoAcceptRecommended,
    isAnswered,
    isPending,
    questions.length,
    recommendedPayload,
    toolUseId
  ])

  const handleToggle = useCallback(
    (qIdx: number, value: string) => {
      if (value === '__other__') {
        setHoveredOptions((prev) => {
          const next = new Map(prev)
          next.delete(qIdx)
          return next
        })
      }

      setSelections((prev) => {
        const next = new Map(prev)
        const current = new Set(next.get(qIdx) ?? [])
        const q = questions[qIdx]
        if (value === '__other__') {
          if (current.has('__other__')) {
            current.delete('__other__')
          } else {
            if (!q?.multiSelect) current.clear()
            current.add('__other__')
          }
        } else if (current.has(value)) {
          current.delete(value)
        } else {
          if (!q?.multiSelect) {
            current.clear()
          }
          current.add(value)
          if (!q?.multiSelect) current.delete('__other__')
        }
        next.set(qIdx, current)
        return next
      })
    },
    [questions]
  )

  const handleCustomTextChange = useCallback((qIdx: number, text: string) => {
    setCustomTexts((prev) => {
      const next = new Map(prev)
      next.set(qIdx, text)
      return next
    })
  }, [])

  const handleNotesChange = useCallback((qIdx: number, text: string) => {
    setNotesByQuestion((prev) => {
      const next = new Map(prev)
      next.set(qIdx, text)
      return next
    })
  }, [])

  const handleHoverOption = useCallback((qIdx: number, value: string | null) => {
    setHoveredOptions((prev) => {
      const next = new Map(prev)
      if (value === null) {
        next.delete(qIdx)
      } else {
        next.set(qIdx, value)
      }
      return next
    })
  }, [])

  const handleSubmit = useCallback(() => {
    resolveAskUserAnswers(
      toolUseId,
      buildSubmissionPayload(questions, selections, customTexts, notesByQuestion)
    )
  }, [toolUseId, questions, selections, customTexts, notesByQuestion])

  const hasCurrentAnswer = React.useMemo(() => {
    const sel = selections.get(currentQuestionIndex) ?? new Set()
    const custom = customTexts.get(currentQuestionIndex) ?? ''
    const q = questions[currentQuestionIndex]
    if (!q) return false
    if (sel.size > 0 && !sel.has('__other__')) return true
    if (sel.has('__other__') && custom.trim()) return true
    if ((!q.options || q.options.length === 0) && custom.trim()) return true
    return false
  }, [currentQuestionIndex, questions, selections, customTexts])

  const hasAllAnswers = React.useMemo(() => {
    for (let i = 0; i < questions.length; i += 1) {
      const sel = selections.get(i) ?? new Set()
      const custom = customTexts.get(i) ?? ''
      const q = questions[i]
      const hasAnswer =
        (sel.size > 0 && !sel.has('__other__')) ||
        (sel.has('__other__') && custom.trim()) ||
        ((!q.options || q.options.length === 0) && custom.trim())
      if (!hasAnswer) return false
    }
    return true
  }, [questions, selections, customTexts])

  const isLastQuestion = currentQuestionIndex === questions.length - 1
  const isFirstQuestion = currentQuestionIndex === 0

  React.useEffect(() => {
    if (!isPending) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tagName = target.tagName.toLowerCase()
        const editable = target.getAttribute('contenteditable')
        if (tagName === 'textarea' || tagName === 'input' || editable === 'true') return
      }

      if (event.key === 'ArrowLeft' && questions.length > 1 && !isFirstQuestion) {
        event.preventDefault()
        setCurrentQuestionIndex((value) => Math.max(0, value - 1))
        return
      }

      if (
        event.key === 'ArrowRight' &&
        questions.length > 1 &&
        !isLastQuestion &&
        hasCurrentAnswer
      ) {
        event.preventDefault()
        setCurrentQuestionIndex((value) => Math.min(questions.length - 1, value + 1))
        return
      }

      if (event.key === 'Enter' && !event.shiftKey && isLastQuestion && hasAllAnswers) {
        event.preventDefault()
        handleSubmit()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    handleSubmit,
    hasAllAnswers,
    hasCurrentAnswer,
    isFirstQuestion,
    isLastQuestion,
    isPending,
    questions.length
  ])

  const handleNext = useCallback(() => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1)
    }
  }, [currentQuestionIndex, questions.length])

  const handlePrevious = useCallback(() => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1)
    }
  }, [currentQuestionIndex])

  if (isError || isCanceled) {
    const title = isCanceled
      ? t('askUser.canceledTitle', { defaultValue: '提问已取消' })
      : t('askUser.errorTitle', { defaultValue: '提问失败' })
    const subtitle = isCanceled
      ? t('askUser.canceledSubtitle', { defaultValue: '本次提问在等待回答前已中止。' })
      : t('askUser.errorSubtitle', { defaultValue: '这次没有进入等待回答状态。' })

    return (
      <div
        className={cn(
          'my-2.5 rounded-lg p-4 shadow-sm',
          isCanceled
            ? 'border border-border/70 bg-muted/20'
            : 'border border-destructive/40 bg-destructive/5'
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span
            className={cn(
              'flex size-7 items-center justify-center rounded-full border',
              isCanceled
                ? 'border-border/60 bg-background/70'
                : 'border-destructive/30 bg-destructive/10'
            )}
          >
            <MessageSquare
              className={cn('size-3.5', isCanceled ? 'text-muted-foreground' : 'text-destructive')}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div>{title}</div>
            <div className="text-[11px] text-muted-foreground">{subtitle}</div>
          </div>
        </div>

        {(outputErrorMessage ?? answeredText) && (
          <div
            className={cn(
              'mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap',
              isCanceled
                ? 'border-border/60 bg-background/60 text-muted-foreground'
                : 'border-destructive/30 bg-background/60 text-muted-foreground'
            )}
          >
            {outputErrorMessage ?? answeredText}
          </div>
        )}
      </div>
    )
  }

  if (isAnswered) {
    return (
      <div className="my-2.5 rounded-lg border border-border/70 bg-background/70 p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-muted/40">
            <CheckCircle2 className="size-3.5 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span>{t('askUser.answeredTitle', { defaultValue: '问题已回答' })}</span>
              {answeredStructured?.autoAnswered && (
                <Badge variant="outline" className="text-[10px] text-primary">
                  <Sparkles className="size-3" />
                  {t('askUser.autoAnswered', { defaultValue: '自动回答' })}
                </Badge>
              )}
              {answeredStructured?.source && (
                <Badge variant="secondary" className="text-[10px]">
                  {t('askUser.sourceLabel', { defaultValue: '来源' })}: {answeredStructured.source}
                </Badge>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t('askUser.answeredSubtitle', { defaultValue: '已记录你的选择与补充说明' })}
            </div>
          </div>
        </div>

        {answeredStructured?.summary &&
          !isRedundantSummary(answeredStructured.summary, answeredPairs) && (
            <div className="mt-3 rounded-xl border border-border/60 bg-muted/15 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
              {answeredStructured.summary}
            </div>
          )}

        <div className="mt-3 space-y-2.5">
          {answeredPairs.map((pair, index) => (
            <div
              key={`${pair.question}-${index}`}
              className="rounded-xl border border-border/60 bg-muted/20 px-3 py-3"
            >
              <div className="flex items-start gap-2 text-xs leading-5">
                <span className="mt-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Q
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground/90">{pair.question}</div>
                </div>
              </div>
              <div className="mt-1.5 flex items-start gap-2 text-xs leading-5">
                <span className="mt-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  A
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="whitespace-pre-wrap break-words text-muted-foreground">
                    {pair.answer}
                  </div>
                  {pair.annotation?.notes && (
                    <div className="rounded-lg border border-border/50 bg-background/70 px-2.5 py-2 text-[11px] text-muted-foreground">
                      <div className="mb-1 font-medium text-foreground/80">
                        {t('askUser.notesTitle', { defaultValue: '补充说明（可选）' })}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{pair.annotation.notes}</div>
                    </div>
                  )}
                  {pair.annotation?.preview && (
                    <div className="rounded-lg border border-border/50 bg-background/70 p-2.5">
                      <PreviewPane preview={pair.annotation.preview} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (isCompletedWithoutAnswers) {
    return (
      <div className="my-2.5 rounded-lg border border-border/70 bg-background/70 p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-muted/40">
            <MessageSquare className="size-3.5 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <div>{t('askUser.completedTitle', { defaultValue: '问题已处理' })}</div>
            <div className="text-[11px] text-muted-foreground">
              {t('askUser.completedSubtitle', { defaultValue: '这次没有进入交互式回答界面。' })}
            </div>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {answeredText}
        </div>
      </div>
    )
  }

  const currentQuestion = questions[currentQuestionIndex]
  if (!currentQuestion) return <></>

  return (
    <div className="my-2.5 rounded-lg border border-border/70 bg-background/70 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-muted/40">
          <MessageSquare className="size-3.5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {t('askUser.title', { defaultValue: '需要你的回答' })}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t('askUser.subtitle', { defaultValue: '回答这些问题后，我再继续处理。' })}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/80">
          {questions.length > 1 && (
            <span className="font-mono text-xs">
              {currentQuestionIndex + 1}/{questions.length}
            </span>
          )}
          {isPending && (
            <span className="flex items-center gap-1 text-primary/80">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              {t('askUser.waiting', { defaultValue: '等待回答' })}
            </span>
          )}
        </div>
      </div>

      {questions.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {questions.map((question, index) => {
            const isActive = index === currentQuestionIndex
            const isDone = (() => {
              const sel = selections.get(index) ?? new Set()
              const custom = customTexts.get(index) ?? ''
              return (
                (sel.size > 0 && !sel.has('__other__')) ||
                (sel.has('__other__') && custom.trim()) ||
                ((!question.options || question.options.length === 0) && custom.trim())
              )
            })()

            return (
              <button
                key={`${question.header ?? question.question}-${index}`}
                type="button"
                onClick={() => setCurrentQuestionIndex(index)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                  isActive
                    ? 'border-primary bg-primary/10 text-primary'
                    : isDone
                      ? 'border-border/70 bg-muted/30 text-foreground'
                      : 'border-border/70 bg-background/60 text-muted-foreground hover:bg-muted/30'
                )}
              >
                {isDone ? (
                  <Check className="size-3" />
                ) : (
                  <span className="size-3 rounded-full border" />
                )}
                <span>{question.header || `${index + 1}`}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-3">
        <QuestionBlock
          index={currentQuestionIndex}
          item={currentQuestion}
          selected={selections.get(currentQuestionIndex) ?? new Set()}
          customText={customTexts.get(currentQuestionIndex) ?? ''}
          notes={notesByQuestion.get(currentQuestionIndex) ?? ''}
          hoveredOption={hoveredOptions.get(currentQuestionIndex) ?? null}
          onToggle={handleToggle}
          onCustomTextChange={handleCustomTextChange}
          onNotesChange={handleNotesChange}
          onHoverOption={handleHoverOption}
          disabled={!isPending}
        />
      </div>

      {isPending && (
        <div className="mt-3 flex items-center gap-1.5 border-t border-border/50 pt-3">
          {questions.length > 1 && !isFirstQuestion && (
            <Button
              onClick={handlePrevious}
              variant="outline"
              size="xs"
              className="gap-1 text-[12px]"
            >
              <ChevronLeft className="size-3.5" />
              {t('askUser.previous', { defaultValue: '上一步' })}
            </Button>
          )}

          <div className="flex-1" />

          {questions.length > 1 && !isLastQuestion && (
            <Button
              onClick={handleNext}
              disabled={!hasCurrentAnswer}
              size="xs"
              className="gap-1 text-[12px]"
            >
              {t('askUser.next', { defaultValue: '下一步' })}
              <ChevronRight className="size-3.5" />
            </Button>
          )}

          {isLastQuestion && (
            <Button
              onClick={handleSubmit}
              disabled={!hasAllAnswers}
              size="xs"
              className="gap-1 text-[12px]"
            >
              {t('askUser.submit', { defaultValue: '提交' })}
              <ChevronRight className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
