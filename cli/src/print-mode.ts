import type { AgentRuntime, PromptSubmission, UiEvent } from './types.js'

/**
 * Non-interactive consumer for the runtime UiEvent stream (cowork -p / --print).
 * The runtime is already Ink-free, so print mode is just a different consumer: no
 * terminal UI, plain stdout, and a strict no-approval policy suited to CI pipelines.
 */

export type PrintOutputFormat = 'json' | 'stream-json' | 'text'

export interface PrintModeOptions {
  outputFormat: PrintOutputFormat
  prompt: string
  timeoutSeconds?: number
}

export const PRINT_EXIT_SUCCESS = 0
export const PRINT_EXIT_RUN_ERROR = 1
export const PRINT_EXIT_CONFIG_ERROR = 2
export const PRINT_EXIT_INTERRUPTED = 130

export interface PrintModeResult {
  exitCode: number
  /** Concatenated text of the final assistant message, empty when the run failed early. */
  resultText: string
  errors: string[]
}

/** Reads piped stdin as the prompt for `echo "..." | cowork -p`. */
export async function readStdinPrompt(): Promise<string> {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
  return input.trim()
}

export async function runPrintMode(
  runtime: AgentRuntime,
  options: PrintModeOptions
): Promise<PrintModeResult> {
  const controller = new AbortController()
  let interrupted = false
  let timedOut = false
  const handleSigint = (): void => {
    interrupted = true
    controller.abort()
  }
  process.once('SIGINT', handleSigint)
  let timeout: NodeJS.Timeout | undefined
  if (options.timeoutSeconds && options.timeoutSeconds > 0) {
    timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutSeconds * 1_000)
    timeout.unref()
  }

  const streamJson = options.outputFormat === 'stream-json'
  const assistantTexts = new Map<string, string>()
  let lastAssistantId: string | null = null
  const errors: string[] = []

  const emit = (event: UiEvent): void => {
    if (streamJson) process.stdout.write(`${JSON.stringify(event)}\n`)
  }

  const submission: PromptSubmission = { text: options.prompt, images: [], references: [] }

  try {
    for await (const event of runtime.send(submission, controller.signal)) {
      emit(event)
      if (event.type === 'assistant.delta') {
        assistantTexts.set(event.id, (assistantTexts.get(event.id) ?? '') + event.text)
        lastAssistantId = event.id
      } else if (event.type === 'system') {
        if (event.message.tone === 'error') errors.push(event.message.text)
      } else if (event.type === 'permission.request') {
        // A pipeline has nobody to answer an approval prompt. Deny it explicitly and
        // stop the run: silent auto-allow is never acceptable here. Automation that
        // needs tool side effects must opt in via --permission-mode acceptEdits|auto.
        errors.push(
          `Approval required for ${event.request.tool} (${event.request.title}). ` +
            'Non-interactive mode denies approvals; rerun with --permission-mode acceptEdits or --permission-mode auto.'
        )
        await runtime.respondToPermission?.(event.request.id, 'deny').catch(() => undefined)
        controller.abort()
      } else if (event.type === 'askUser.request') {
        errors.push(
          'The agent asked an interactive question, which non-interactive mode cannot answer.'
        )
        controller.abort()
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    process.removeListener('SIGINT', handleSigint)
  }

  if (timedOut) errors.push(`Run timed out after ${options.timeoutSeconds}s.`)

  const resultText = (lastAssistantId ? (assistantTexts.get(lastAssistantId) ?? '') : '').trim()
  const exitCode = interrupted
    ? PRINT_EXIT_INTERRUPTED
    : errors.length > 0
      ? PRINT_EXIT_RUN_ERROR
      : PRINT_EXIT_SUCCESS

  if (options.outputFormat === 'text') {
    if (resultText) process.stdout.write(`${resultText}\n`)
    for (const error of errors) process.stderr.write(`${error}\n`)
  } else if (options.outputFormat === 'json') {
    process.stdout.write(
      `${JSON.stringify({
        errors,
        exitCode,
        interrupted,
        result: resultText,
        timedOut
      })}\n`
    )
  } else {
    // stream-json already emitted every event; close with a summary line for parsers.
    process.stdout.write(
      `${JSON.stringify({ type: 'run.summary', errors, exitCode, interrupted, timedOut })}\n`
    )
  }

  return { errors, exitCode, resultText }
}
