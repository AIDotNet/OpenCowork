import * as React from 'react'
import { useState, useCallback } from 'react'
import { Check, ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { resolveAskUserAnswers } from '@renderer/lib/tools/ask-user-tool'
import type { AskUserQuestionItem, AskUserAnswers } from '@renderer/lib/tools/ask-user-tool'
import type { ToolCallStatus } from '@renderer/lib/agent/types'
import type { ToolResultContent } from '@renderer/lib/api/types'

interface AskUserQuestionCardProps {
  toolUseId: string
  input: Record<string, unknown>
  output?: ToolResultContent
  status: ToolCallStatus | 'completed'
  isLive: boolean
}

function QuestionBlock({
  index,
  item,
  selected,
  customText,
  onToggle,
  onCustomTextChange,
  disabled,
}: {
  index: number
  item: AskUserQuestionItem
  selected: Set<string>
  customText: string
  onToggle: (index: number, value: string) => void
  onCustomTextChange: (index: number, text: string) => void
  disabled: boolean
}): React.JSX.Element {
  const isOtherSelected = selected.has('__other__')

  return (
    <div className="space-y-2.5">
      <p className="text-[13px] font-semibold leading-tight text-foreground">{item.question}</p>
      {item.options && item.options.length > 0 && (
        <div className="space-y-1.5">
          {item.options.map((opt, oi) => {
            const value = opt.label
            const isSelected = selected.has(value)
            return (
              <button
                key={oi}
                disabled={disabled}
                onClick={() => onToggle(index, value)}
                className={cn(
                  'flex items-start gap-2.5 w-full rounded-lg border px-3 py-2 text-left text-[13px] leading-tight transition-all',
                  isSelected
                    ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                    : 'border-border/80 bg-background/80 hover:border-primary/50 hover:bg-muted/40 hover:shadow-sm',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-all',
                    item.multiSelect ? 'rounded-md' : 'rounded-full',
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground scale-105'
                      : 'border-muted-foreground/40 bg-background'
                  )}
                >
                  {isSelected && <Check className="size-3 stroke-[2.5]" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'font-medium transition-colors',
                      isSelected ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {opt.label}
                  </div>
                  {opt.description && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground/80 leading-snug">{opt.description}</p>
                  )}
                </div>
              </button>
            )
          })}
          {/* "Other" option — always available */}
          <button
            disabled={disabled}
            onClick={() => onToggle(index, '__other__')}
            className={cn(
              'flex items-start gap-2.5 w-full rounded-lg border px-3 py-2 text-left text-[13px] leading-tight transition-all',
              isOtherSelected
                ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                : 'border-border/80 bg-background/80 hover:border-primary/50 hover:bg-muted/40 hover:shadow-sm',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-all',
                item.multiSelect ? 'rounded-md' : 'rounded-full',
                isOtherSelected
                  ? 'border-primary bg-primary text-primary-foreground scale-105'
                  : 'border-muted-foreground/40 bg-background'
              )}
            >
              {isOtherSelected && <Check className="size-3 stroke-[2.5]" />}
            </span>
            <span className={cn(
              'font-medium transition-colors',
              isOtherSelected ? 'text-foreground' : 'text-muted-foreground'
            )}>
              Other
            </span>
          </button>
        </div>
      )}
      {/* Text input: shown when no options or "Other" is selected */}
      {(!item.options || item.options.length === 0 || isOtherSelected) && (
        <textarea
          disabled={disabled}
          value={customText}
          onChange={(e) => onCustomTextChange(index, e.target.value)}
          placeholder="Type your answer..."
          rows={2}
          className={cn(
            'w-full rounded-lg border bg-background/70 px-3 py-2 text-sm',
            'placeholder:text-muted-foreground/50 resize-none',
            'transition-all duration-200',
            'focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary',
            'hover:border-primary/50',
            disabled && 'opacity-50 cursor-not-allowed bg-muted/20'
          )}
        />
      )}
    </div>
  )
}

/** Parse output string to extract answered questions for display */
function parseAnsweredOutput(output: ToolResultContent | undefined): string | null {
  if (!output) return null
  const text = typeof output === 'string' ? output : output
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
  if (!text || text.startsWith('{')) return null // JSON error
  return text
}

export function AskUserQuestionCard({
  toolUseId,
  input,
  output,
  status,
  isLive,
}: AskUserQuestionCardProps): React.JSX.Element {
  const questions = (input.questions as AskUserQuestionItem[]) ?? []
  const isAnswered = status === 'completed' && !!output
  const isPending = !isAnswered && (status === 'running' || isLive)

  // Per-question selection state
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map())
  const [customTexts, setCustomTexts] = useState<Map<number, string>>(() => new Map())
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)

  const handleToggle = useCallback(
    (qIdx: number, value: string) => {
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
        } else {
          if (current.has(value)) {
            current.delete(value)
          } else {
            if (!q?.multiSelect) {
              current.clear()
            }
            current.add(value)
          }
          // Deselect "Other" when a regular option is picked in single-select
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

  const handleSubmit = useCallback(() => {
    const answers: AskUserAnswers = {}
    for (let i = 0; i < questions.length; i++) {
      const sel = selections.get(i) ?? new Set()
      const custom = customTexts.get(i) ?? ''
      const q = questions[i]

      // Collect selected option labels (excluding __other__)
      const picked = [...sel].filter((v) => v !== '__other__')

      // If "Other" is selected or no options exist, use custom text
      if (sel.has('__other__') || (!q.options || q.options.length === 0)) {
        if (custom.trim()) {
          if (q.multiSelect) {
            answers[String(i)] = [...picked, custom.trim()]
          } else {
            answers[String(i)] = custom.trim()
          }
        } else if (picked.length > 0) {
          answers[String(i)] = q.multiSelect ? picked : picked[0]
        }
      } else if (picked.length > 0) {
        answers[String(i)] = q.multiSelect ? picked : picked[0]
      }
    }
    resolveAskUserAnswers(toolUseId, answers)
  }, [toolUseId, questions, selections, customTexts])

  // Check if current question has an answer
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

  // Check if all questions have answers
  const hasAllAnswers = React.useMemo(() => {
    for (let i = 0; i < questions.length; i++) {
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

  // Already answered — show summary
  if (isAnswered) {
    const answeredText = parseAnsweredOutput(output)
    return (
      <div className="my-2.5 rounded-lg border border-green-500/25 bg-green-500/10 p-3.5 space-y-2 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold text-green-600 dark:text-green-500">
          <Check className="size-4.5 stroke-[2.5]" />
          <span>Questions answered</span>
        </div>
        {answeredText && (
          <pre className="text-xs text-muted-foreground/90 whitespace-pre-wrap leading-relaxed">{answeredText}</pre>
        )}
      </div>
    )
  }

  const currentQuestion = questions[currentQuestionIndex]
  if (!currentQuestion) return <></>

  return (
    <div className="my-2.5 rounded-lg border border-border/70 bg-background/70 p-4 space-y-3 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground/80">
          {questions.length > 1 && (
            <span className="font-mono text-xs">
              {currentQuestionIndex + 1}/{questions.length}
            </span>
          )}
          {isPending && (
            <span className="flex items-center gap-1 text-primary/70">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              Waiting
            </span>
          )}
        </div>
      </div>

      {/* Current Question */}
      <QuestionBlock
        index={currentQuestionIndex}
        item={currentQuestion}
        selected={selections.get(currentQuestionIndex) ?? new Set()}
        customText={customTexts.get(currentQuestionIndex) ?? ''}
        onToggle={handleToggle}
        onCustomTextChange={handleCustomTextChange}
        disabled={!isPending}
      />

      {/* Navigation and Submit */}
      {isPending && (
        <div className="flex items-center gap-1.5 pt-0.5">
          {/* Previous button */}
          {questions.length > 1 && !isFirstQuestion && (
            <Button
              onClick={handlePrevious}
              variant="outline"
              size="xs"
              className="gap-1 text-[12px]"
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
          )}

          <div className="flex-1" />

          {/* Next button (if not last question) */}
          {questions.length > 1 && !isLastQuestion && (
            <Button
              onClick={handleNext}
              disabled={!hasCurrentAnswer}
              size="xs"
              className="gap-1 text-[12px]"
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          )}

          {/* Submit button (only on last question and all answered) */}
          {isLastQuestion && (
            <Button
              onClick={handleSubmit}
              disabled={!hasAllAnswers}
              size="xs"
              className="gap-1 text-[12px]"
            >
              Submit
              <ChevronRight className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
