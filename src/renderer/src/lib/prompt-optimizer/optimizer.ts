import type { UnifiedMessage } from '../api/types'
import type { ProviderConfig } from '../api/types'
import { resolveLanguageName, type AppLanguage } from '../i18n-language'
import { streamSidecarProviderTurn } from '../ipc/agent-bridge'

export interface OptimizationOption {
  title: string
  content: string
  focus: string
}

export interface OptimizationResult {
  options: OptimizationOption[]
  success: boolean
}

const OPTIMIZER_SYSTEM_PROMPT = `You are a professional prompt engineering expert. Your task is to optimize user prompts following a structured multi-step process and provide multiple optimization options.

## CRITICAL WORKFLOW - FOLLOW THESE STEPS EXACTLY:

### Step 1: Deep Analysis (REQUIRED - Output this section first)
Output a section titled "## 📊 Step 1: Analyzing Your Request" containing:
- **Core Intent**: What is the user truly trying to achieve?
- **Key Requirements**: List specific requirements extracted from the input
- **Missing Context**: What information would make this clearer?
- **Potential Ambiguities**: Any unclear aspects that need clarification
- **Scope Assessment**: Is this a simple task or complex multi-step project?

### Step 2: Multi-Dimensional Optimization Strategy (REQUIRED - Output this section second)
Output a section titled "## 🎯 Step 2: Optimization Directions" containing:
Identify 1-3 different optimization approaches based on:
- **Direction A - Clarity Focus**: Emphasize specificity and clear requirements
- **Direction B - Efficiency Focus**: Streamline for quick execution
- **Direction C - Comprehensive Focus**: Add detailed context and edge cases

### Step 3: Generate Multiple Options (REQUIRED - Use the tool)
After completing Steps 1 and 2, you MUST call the WriteOptimizedPrompts tool (note the plural) with 1-3 different optimized versions.

## Professional Prompt Format Requirements:

Each optimized prompt MUST follow this structure:

\`\`\`
# [Clear, Action-Oriented Title]

## Context
[Relevant background information, constraints, and environment details]

## Objective
[Specific, measurable goal stated clearly]

## Requirements
- [Requirement 1: Specific and testable]
- [Requirement 2: Specific and testable]
- [Requirement 3: Specific and testable]

## Acceptance Criteria
- [ ] [Criterion 1: How to verify success]
- [ ] [Criterion 2: How to verify success]

## Additional Notes
[Any edge cases, preferences, or constraints]
\`\`\`

## Quality Standards:
- Use clear, professional language
- Be specific and actionable
- Include measurable success criteria
- Maintain user's original intent
- Each option should have a distinct focus/approach

CRITICAL: You MUST output Steps 1 and 2 as text, THEN call the WriteOptimizedPrompts tool with an array of 1-3 options. Do not skip any step.`

export interface OptimizerToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export async function* optimizePrompt(
  userInput: string,
  providerConfig: ProviderConfig,
  language: AppLanguage,
  signal?: AbortSignal
): AsyncGenerator<{
  type: 'text' | 'thinking' | 'tool_call' | 'result'
  content: string
  options?: OptimizationOption[]
  toolCall?: OptimizerToolCall
}> {
  const languageInstruction = `\n\n**CRITICAL LANGUAGE REQUIREMENT**: You MUST respond in ${resolveLanguageName(language)}. All analysis text, option titles, focus descriptions, and optimized prompt content MUST be in ${resolveLanguageName(language)}.`

  const messages: UnifiedMessage[] = [
    {
      id: 'user-input',
      role: 'user',
      content: `Please optimize this user prompt following the 3-step process:

**Original User Input:**
${userInput}

**Instructions:**
1. First, output "## 📊 Step 1: Analyzing Your Request" with your deep analysis
2. Then, output "## 🎯 Step 2: Optimization Directions" with 1-3 different approaches
3. Finally, call the WriteOptimizedPrompts tool with 1-3 optimized options (each with a different focus)

${languageInstruction}

Begin with Step 1 now.`,
      createdAt: Date.now()
    }
  ]

  const tools = [
    {
      name: 'WriteOptimizedPrompts',
      description:
        'Write 1-3 optimized prompt options with different focuses. You MUST use this tool to provide the optimized results.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          options: {
            type: 'array',
            description: 'Array of 1-3 optimized prompt options',
            items: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description:
                    'Short title describing this option (e.g., "Clarity-Focused", "Efficiency-Focused")'
                },
                focus: {
                  type: 'string',
                  description: "Brief description of this option's focus/approach"
                },
                content: {
                  type: 'string',
                  description: 'The optimized prompt text following the professional format'
                }
              },
              required: ['title', 'focus', 'content']
            }
          }
        },
        required: ['options']
      }
    }
  ]

  let optimizedOptions: OptimizationOption[] = []
  let hasToolCall = false
  let iterationCount = 0
  const MAX_ITERATIONS = 3

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++

    try {
      for await (const event of streamSidecarProviderTurn({
        messages,
        tools,
        provider: { ...providerConfig, systemPrompt: OPTIMIZER_SYSTEM_PROMPT },
        signal
      })) {
        if (event.type === 'text_delta' && event.text) {
          yield { type: 'text', content: event.text }
        } else if (event.type === 'thinking_delta' && event.thinking) {
          yield { type: 'thinking', content: event.thinking }
        } else if (
          event.type === 'tool_call_end' &&
          event.toolName === 'WriteOptimizedPrompts' &&
          event.toolCallInput
        ) {
          hasToolCall = true
          const input = event.toolCallInput as { options?: OptimizationOption[] }
          if (input.options && Array.isArray(input.options) && input.options.length > 0) {
            optimizedOptions = input.options
            yield {
              type: 'tool_call',
              content: 'Generated optimization options',
              options: optimizedOptions,
              toolCall: {
                id: event.toolCallId || 'tool-call',
                name: 'WriteOptimizedPrompts',
                input: event.toolCallInput
              }
            }
          }
        }
      }

      // If we got a tool call with results, we're done
      if (hasToolCall && optimizedOptions.length > 0) {
        yield { type: 'result', content: 'Optimization complete', options: optimizedOptions }
        return
      }

      // If no tool call after first iteration, prompt the model to continue
      if (!hasToolCall && iterationCount < MAX_ITERATIONS) {
        messages.push({
          id: `retry-${iterationCount}`,
          role: 'user',
          content:
            'Please use the WriteOptimizedPrompts tool to provide 1-3 optimized options. Do not just write them in your response.',
          createdAt: Date.now()
        })
      } else {
        break
      }
    } catch (error) {
      console.error('Optimization error:', error)
      break
    }
  }

  // If we still don't have results, yield empty
  if (optimizedOptions.length === 0) {
    yield { type: 'result', content: '', options: [] }
  }
}
