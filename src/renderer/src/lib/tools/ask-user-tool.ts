import { toast } from 'sonner'
import i18n from '@renderer/locales'
import { toolRegistry } from '../agent/tool-registry'
import type { ToolDefinition } from '../api/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useBackgroundSessionStore } from '@renderer/stores/background-session-store'
import { isSessionForeground } from '@renderer/lib/agent/session-runtime-router'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'

export interface AskUserOption {
  label: string
  description?: string
  preview?: string
}

export interface AskUserQuestionItem {
  question: string
  header?: string
  options?: AskUserOption[]
  multiSelect?: boolean
}

export interface AskUserAnswers {
  [questionIndex: string]: string | string[]
}

export interface AskUserAnnotation {
  preview?: string
  notes?: string
}

export interface AskUserResolvedPayload {
  answers: AskUserAnswers
  annotations?: Record<string, AskUserAnnotation>
}

export interface AskUserStructuredResult {
  questions: AskUserQuestionItem[]
  answers: Record<string, string>
  annotations?: Record<string, AskUserAnnotation>
  summary: string
  source?: string
  autoAnswered?: boolean
}

const MAX_CHIP_WIDTH = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function coerceStringField(
  value: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return undefined
}

function coerceBooleanField(value: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    const raw = value[key]
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase()
      if (normalized === 'true') return true
      if (normalized === 'false') return false
    }
  }
  return false
}

function coerceArrayInput(value: unknown): unknown[] {
  if (Array.isArray(value)) return value

  if (typeof value === 'string') {
    const parsed = tryParseJson(value)
    return parsed === undefined ? [] : coerceArrayInput(parsed)
  }

  if (!isRecord(value)) return []

  if ('items' in value) {
    const nested = coerceArrayInput(value.items)
    if (nested.length > 0) return nested
  }

  if (
    coerceStringField(value, ['question', 'text', 'prompt', 'query', 'message', 'content']) ||
    'options' in value ||
    'choices' in value
  ) {
    return [value]
  }

  return Object.entries(value)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, item]) => item)
}

function coerceQuestionOption(value: unknown): AskUserOption | null {
  if (typeof value === 'string') {
    return { label: value.trim() }
  }

  if (!isRecord(value)) return null

  const label = coerceStringField(value, ['label', 'text', 'value', 'title', 'name'])
  const description = coerceStringField(value, [
    'description',
    'desc',
    'detail',
    'details',
    'impact',
    'rationale'
  ])
  const preview = coerceStringField(value, ['preview', 'example', 'snippet'])

  return {
    label: label ?? '',
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {})
  }
}

function coerceQuestionOptions(value: unknown): AskUserOption[] | undefined {
  if (value === undefined) return undefined

  return coerceArrayInput(value)
    .map((option) => coerceQuestionOption(option))
    .filter((option): option is AskUserOption => option !== null)
}

export function coerceAskUserQuestions(value: unknown): AskUserQuestionItem[] {
  return coerceArrayInput(value)
    .map((item) => {
      const normalized = typeof item === 'string' ? tryParseJson(item) : item
      if (!isRecord(normalized)) return null
      const question = coerceStringField(normalized, [
        'question',
        'text',
        'prompt',
        'query',
        'message',
        'content'
      ])
      const header = coerceStringField(normalized, ['header', 'label', 'title', 'name', 'id'])
      const optionsInput =
        normalized.options ?? normalized.choices ?? normalized.answers ?? normalized.items
      const fallbackQuestion =
        question ??
        coerceStringField(normalized, ['description', 'desc', 'summary']) ??
        (header ? `${header}?` : undefined)

      return {
        question: fallbackQuestion ?? '',
        ...(header ? { header } : {}),
        ...(optionsInput !== undefined ? { options: coerceQuestionOptions(optionsInput) } : {}),
        ...(coerceBooleanField(normalized, ['multiSelect', 'multi_select', 'multiple'])
          ? { multiSelect: true }
          : {})
      }
    })
    .filter((question): question is AskUserQuestionItem => question !== null)
}

function deriveHeader(question: string, index: number): string {
  const compact = question
    .replace(/[?\uFF1F]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!compact) return `Q${index + 1}`
  return Array.from(compact).slice(0, MAX_CHIP_WIDTH).join('')
}

function headerLength(header: string): number {
  return Array.from(header).length
}

function normalizeQuestions(questions: AskUserQuestionItem[]): AskUserQuestionItem[] {
  return questions.map((question, index) => ({
    question: question.question.trim(),
    header: question.header?.trim() || deriveHeader(question.question, index),
    multiSelect: question.multiSelect === true,
    options: question.options?.map((option) => ({
      label: option.label.trim(),
      ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      ...(option.preview?.trim() ? { preview: option.preview.trim() } : {})
    }))
  }))
}

function looksLikeHtmlFragment(preview: string): boolean {
  return /<\s*[a-z!][^>]*>/i.test(preview)
}

function validatePreview(preview: string | undefined): string | null {
  if (!preview || !looksLikeHtmlFragment(preview)) return null
  if (/<\s*(html|body|!doctype)\b/i.test(preview)) {
    return 'preview must be an HTML fragment, not a full document'
  }
  if (/<\s*(script|style)\b/i.test(preview)) {
    return 'preview must not contain <script> or <style> tags'
  }
  return null
}

function validateQuestions(questions: AskUserQuestionItem[]): string | null {
  if (questions.length === 0) return 'At least one question is required'
  if (questions.length > 4) return 'Maximum 4 questions allowed'

  const seenQuestions = new Set<string>()

  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index]
    const questionText = item.question?.trim()
    const header = item.header?.trim() || deriveHeader(item.question ?? '', index)

    if (!questionText) return `Question ${index + 1} is missing question text`
    if (seenQuestions.has(questionText)) return 'Question texts must be unique'
    seenQuestions.add(questionText)

    if (!header) return `Question "${questionText}" is missing a header`
    if (headerLength(header) > MAX_CHIP_WIDTH) {
      return `Question "${questionText}" header must be at most ${MAX_CHIP_WIDTH} characters`
    }

    const options = item.options
    if (!options || options.length < 2 || options.length > 4) {
      return `Question "${questionText}" must provide 2-4 options`
    }

    const seenLabels = new Set<string>()
    for (const option of options) {
      const label = option.label?.trim()
      if (!label) return `Question "${questionText}" contains an option without a label`
      if (seenLabels.has(label)) {
        return `Option labels must be unique within question "${questionText}"`
      }
      seenLabels.add(label)

      const previewError = validatePreview(option.preview)
      if (previewError) return `Option "${label}" in question "${questionText}": ${previewError}`
    }

    if (item.multiSelect && options.some((option) => !!option.preview)) {
      return `Question "${questionText}" cannot use preview with multiSelect=true`
    }
  }

  return null
}

function isResolvedPayload(payload: unknown): payload is AskUserResolvedPayload {
  return (
    !!payload &&
    typeof payload === 'object' &&
    'answers' in payload &&
    !!(payload as { answers?: unknown }).answers &&
    typeof (payload as { answers?: unknown }).answers === 'object' &&
    !Array.isArray((payload as { answers?: unknown }).answers)
  )
}

function normalizeResolvedPayload(
  payload: AskUserAnswers | AskUserResolvedPayload
): AskUserResolvedPayload {
  if (isResolvedPayload(payload)) {
    return payload
  }
  return { answers: payload }
}

function serializeAnswer(answer: string | string[]): string {
  return Array.isArray(answer) ? answer.join(', ') : answer
}

function buildStructuredResult(
  questions: AskUserQuestionItem[],
  payload: AskUserResolvedPayload,
  options?: { autoAnswered?: boolean; source?: string }
): AskUserStructuredResult {
  const answers: Record<string, string> = {}
  const annotations: Record<string, AskUserAnnotation> = {}

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    const answer = payload.answers[String(index)]
    if (answer === undefined) continue

    answers[question.question] = serializeAnswer(answer)

    const annotation = payload.annotations?.[String(index)]
    const notes = annotation?.notes?.trim()
    if (annotation?.preview || notes) {
      annotations[question.question] = {
        ...(annotation?.preview ? { preview: annotation.preview } : {}),
        ...(notes ? { notes } : {})
      }
    }
  }

  const summaryParts = Object.entries(answers).map(([questionText, answerText]) => {
    const annotation = annotations[questionText]
    const extras: string[] = []
    if (annotation?.preview) extras.push('selected preview attached')
    if (annotation?.notes) extras.push(`notes: ${annotation.notes}`)
    return extras.length > 0
      ? `"${questionText}"="${answerText}" (${extras.join('; ')})`
      : `"${questionText}"="${answerText}"`
  })

  return {
    questions,
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    summary:
      summaryParts.length > 0
        ? `User has answered your questions: ${summaryParts.join(', ')}. You can now continue with the user's answers in mind.`
        : 'User has answered your questions.',
    ...(options?.source ? { source: options.source } : {}),
    ...(options?.autoAnswered ? { autoAnswered: true } : {})
  }
}

const answerResolvers = new Map<string, (payload: AskUserResolvedPayload) => void>()

export function resolveAskUserAnswers(
  toolUseId: string,
  payload: AskUserAnswers | AskUserResolvedPayload
): void {
  const resolve = answerResolvers.get(toolUseId)
  if (resolve) {
    resolve(normalizeResolvedPayload(payload))
    answerResolvers.delete(toolUseId)
  }
  useBackgroundSessionStore.getState().resolveInboxItemByToolUseId(toolUseId)
}

export function clearPendingQuestions(): void {
  for (const [, resolve] of answerResolvers) {
    resolve({ answers: {} })
  }
  answerResolvers.clear()
}

const askUserToolDefinition: Omit<ToolDefinition, 'name'> = {
  description:
    'Use this tool when you need to ask the user questions during execution. This allows you to:\n' +
    '1. Gather user preferences or requirements\n' +
    '2. Clarify ambiguous instructions\n' +
    '3. Get decisions on implementation choices as you work\n' +
    '4. Offer choices to the user about what direction to take.\n\n' +
    'Usage notes:\n' +
    '- Users will always be able to select "Other" to provide custom text input\n' +
    '- Use multiSelect: true to allow multiple answers to be selected for a question\n' +
    '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label\n\n' +
    'Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT ask for plan approval here. Do NOT ask "Is my plan ready?" or "Should I proceed?". Use ExitPlanMode for plan approval instead, and do not reference a plan the user cannot yet see.\n' +
    '\n' +
    'Preview feature:\n' +
    'Use the optional preview field on options when presenting concrete artifacts that users need to visually compare:\n' +
    '- ASCII mockups of UI layouts or components\n' +
    '- Code snippets showing different implementations\n' +
    '- Diagram variations\n' +
    '- Configuration examples\n\n' +
    'Preview content is rendered as markdown in a monospace-friendly preview box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Preview is only supported for single-select questions. HTML fragments are accepted for compatibility only; never include <script>, <style>, <html>, <body>, or <!DOCTYPE>.\n',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask the user (1-4 questions)',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description:
                'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"'
            },
            header: {
              type: 'string',
              description:
                'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".'
            },
            options: {
              type: 'array',
              description:
                'The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice unless multiSelect is enabled. Do not include an Other option; the UI provides it automatically.',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description:
                      'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.'
                  },
                  description: {
                    type: 'string',
                    description:
                      'Explanation of what this option means or what will happen if chosen. Useful for context about trade-offs or implications.'
                  },
                  preview: {
                    type: 'string',
                    description:
                      'Optional preview content rendered when this option is focused. Use for mockups, code snippets, diagrams, or configuration examples that help users compare options.'
                  }
                },
                required: ['label', 'description'],
                additionalProperties: false
              }
            },
            multiSelect: {
              type: 'boolean',
              default: false,
              description:
                'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.'
            }
          },
          required: ['question', 'header', 'options', 'multiSelect'],
          additionalProperties: false
        }
      },
      answers: {
        type: 'object',
        description: 'User answers collected by the permission component.',
        propertyNames: {
          type: 'string'
        },
        additionalProperties: {
          type: 'string'
        }
      },
      annotations: {
        type: 'object',
        description:
          'Optional per-question annotations from the user, such as notes on preview selections. Keyed by question text.',
        propertyNames: {
          type: 'string'
        },
        additionalProperties: {
          type: 'object',
          properties: {
            preview: {
              type: 'string',
              description:
                'The preview content of the selected option, if the question used previews.'
            },
            notes: {
              type: 'string',
              description: 'Free-text notes the user added to their selection.'
            }
          },
          additionalProperties: false
        }
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata for tracking or analytics. Not shown to the user.',
        properties: {
          source: {
            type: 'string',
            description: 'Optional identifier for where the question originated.'
          }
        },
        additionalProperties: false
      }
    },
    required: ['questions'],
    additionalProperties: false
  }
}

const askUserToolExecute: ToolHandler['execute'] = async (input, ctx) => {
  const toolUseId = ctx.currentToolUseId
  if (!toolUseId) {
    return encodeToolError(
      'Missing tool use ID. AskUserQuestion requires a tool_use block id to keep the question pending and map the user reply back to the running tool call.'
    )
  }

  const rawQuestions = coerceAskUserQuestions(input.questions ?? input)
  if (rawQuestions.length === 0) {
    return encodeToolError('At least one question is required')
  }

  const validationError = validateQuestions(rawQuestions)
  if (validationError) {
    return encodeToolError(validationError)
  }

  const questions = normalizeQuestions(rawQuestions)
  const metadata =
    input.metadata && typeof input.metadata === 'object'
      ? (input.metadata as { source?: unknown })
      : undefined
  const metadataSource = typeof metadata?.source === 'string' ? metadata.source.trim() : undefined
  if (ctx.pluginId) {
    const lines: string[] = []
    for (const q of questions) {
      let line = `- [${q.header}] ${q.question}`
      if (q.options?.length) {
        const opts = q.options
          .map((o) => o.label + (o.description ? ` (${o.description})` : ''))
          .join(', ')
        line += `  [${opts}]`
      }
      lines.push(line)
    }
    return `You are in a plugin session and cannot show interactive UI to the user. Instead, ask the user these questions directly in your reply message:\n${lines.join('\n')}\nWait for the user to respond before proceeding.`
  }

  if (ctx.sessionId && !isSessionForeground(ctx.sessionId)) {
    const sessionTitle =
      useChatStore.getState().sessions.find((item) => item.id === ctx.sessionId)?.title ??
      i18n.t('askUser.backgroundSessionFallback', {
        ns: 'chat',
        defaultValue: 'Background session'
      })
    useBackgroundSessionStore.getState().addInboxItem({
      sessionId: ctx.sessionId,
      type: 'ask_user',
      title:
        questions[0]?.header ||
        i18n.t('askUser.backgroundInboxTitle', {
          ns: 'chat',
          defaultValue: 'Input needed'
        }),
      description: i18n.t('askUser.backgroundInboxDescription', {
        ns: 'chat',
        defaultValue: '{{title}} is waiting for your choice',
        title: sessionTitle
      }),
      toolUseId
    })
    toast.warning(
      i18n.t('askUser.backgroundToast', {
        ns: 'chat',
        defaultValue: 'Background session is waiting for your choice'
      }),
      { description: sessionTitle }
    )
  }

  const payload = await new Promise<AskUserResolvedPayload>((resolve) => {
    answerResolvers.set(toolUseId, resolve)

    const onAbort = (): void => {
      if (answerResolvers.has(toolUseId)) {
        answerResolvers.delete(toolUseId)
        resolve({ answers: {} })
      }
    }

    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })

  if (ctx.signal.aborted) {
    useBackgroundSessionStore.getState().resolveInboxItemByToolUseId(toolUseId)
    return encodeToolError('Aborted by user')
  }

  useBackgroundSessionStore.getState().resolveInboxItemByToolUseId(toolUseId)

  if (Object.keys(payload.answers).length === 0) {
    return encodeToolError('No answers provided')
  }

  return encodeStructuredToolResult(
    buildStructuredResult(questions, payload, { source: metadataSource }) as unknown as Record<
      string,
      unknown
    >
  )
}

const askUserQuestionHandler: ToolHandler = {
  definition: {
    name: 'AskUserQuestion',
    ...askUserToolDefinition
  },
  execute: askUserToolExecute,
  requiresApproval: () => false
}

export function registerAskUserTools(): void {
  toolRegistry.register(askUserQuestionHandler)
}
