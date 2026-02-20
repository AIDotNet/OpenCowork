import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from './tool-types'

// --- Types ---

export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  question: string
  options?: AskUserOption[]
  multiSelect?: boolean
}

export interface AskUserAnswers {
  [questionIndex: string]: string | string[]
}

// --- Resolver map (module-level, non-serializable) ---

const answerResolvers = new Map<string, (answers: AskUserAnswers) => void>()

/**
 * Called by the UI component when the user submits answers.
 * Resolves the blocking promise inside the tool's execute().
 */
export function resolveAskUserAnswers(toolUseId: string, answers: AskUserAnswers): void {
  const resolve = answerResolvers.get(toolUseId)
  if (resolve) {
    resolve(answers)
    answerResolvers.delete(toolUseId)
  }
}

/**
 * Called on abort to reject all pending questions.
 */
export function clearPendingQuestions(): void {
  // Resolve with empty answers so the promise doesn't hang
  for (const [, resolve] of answerResolvers) {
    resolve({})
  }
  answerResolvers.clear()
}

// --- Tool Handler ---

const askUserQuestionHandler: ToolHandler = {
  definition: {
    name: 'AskUserQuestion',
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
      'Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ExitPlanMode for plan approval.\n',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to ask the user (1-4 questions)',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question text to display to the user',
              },
              options: {
                type: 'array',
                description: 'Predefined options for the user to choose from (up to 4)',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short label for the option' },
                    description: {
                      type: 'string',
                      description: 'Longer description explaining the option',
                    },
                  },
                  required: ['label'],
                },
              },
              multiSelect: {
                type: 'boolean',
                description: 'Whether the user can select multiple options (default: false)',
              },
            },
            required: ['question'],
          },
        },
        metadata: {
          type: 'object',
          description:
            'Optional metadata for tracking and analytics purposes. Not displayed to user.',
        },
      },
      required: ['questions'],
    },
  },

  execute: async (input, ctx) => {
    const toolUseId = ctx.currentToolUseId
    if (!toolUseId) {
      return JSON.stringify({ error: 'Missing tool use ID' })
    }

    const questions = input.questions as AskUserQuestionItem[] | undefined
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return JSON.stringify({ error: 'At least one question is required' })
    }
    if (questions.length > 4) {
      return JSON.stringify({ error: 'Maximum 4 questions allowed' })
    }

    // ── Plugin context: no UI interaction available ──
    // Return the questions as text so the LLM sends them as a message via the plugin channel.
    if (ctx.pluginId) {
      const lines: string[] = []
      for (const q of questions) {
        let line = `- ${q.question}`
        if (q.options?.length) {
          const opts = q.options.map((o) => o.label + (o.description ? ` (${o.description})` : '')).join(', ')
          line += `  [${opts}]`
        }
        lines.push(line)
      }
      return `You are in a plugin session and cannot show interactive UI to the user. Instead, ask the user these questions directly in your reply message:\n${lines.join('\n')}\nWait for the user to respond before proceeding.`
    }

    // Block until the user answers via the UI
    const answers = await new Promise<AskUserAnswers>((resolve) => {
      answerResolvers.set(toolUseId, resolve)

      // If the parent signal aborts, resolve with empty to unblock
      const onAbort = (): void => {
        if (answerResolvers.has(toolUseId)) {
          answerResolvers.delete(toolUseId)
          resolve({})
        }
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })

    if (ctx.signal.aborted) {
      return JSON.stringify({ error: 'Aborted by user' })
    }

    // Format the answers as a prompt-friendly string for the LLM
    const parts: string[] = []
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const a = answers[String(i)]
      if (a !== undefined) {
        const answerText = Array.isArray(a) ? a.join(', ') : a
        parts.push(`Q: ${q.question}\nA: ${answerText}`)
      }
    }

    return parts.length > 0
      ? `User answered:\n\n${parts.join('\n\n')}`
      : JSON.stringify({ error: 'No answers provided' })
  },

  requiresApproval: () => false,
}

// --- Registration ---

export function registerAskUserTools(): void {
  toolRegistry.register(askUserQuestionHandler)
}
