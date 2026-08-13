import type {
  AgentOption,
  AgentRuntime,
  ContextSnapshot,
  ModelCatalog,
  ModelSelection,
  PromptSubmission,
  UiEvent,
  UsageSnapshot
} from '../types.js'

/**
 * Deterministic in-process AgentRuntime used by the PTY golden tests
 * (OPENCOWORK_CLI_FIXTURE=1). It never spawns the Native Worker or contacts a provider:
 * every prompt produces the same scripted event sequence — one tool block and one
 * assistant reply echoing the prompt — so terminal snapshots are stable across runs,
 * machines, and CI.
 */

const FIXTURE_MODEL: ModelSelection = {
  providerId: 'fixture',
  providerName: 'Fixture',
  modelId: 'fixture-model',
  modelName: 'fixture-model'
}

function catalog(): ModelCatalog {
  return {
    active: FIXTURE_MODEL,
    totalModels: 1,
    groups: [
      {
        providerId: FIXTURE_MODEL.providerId,
        providerName: FIXTURE_MODEL.providerName,
        providerType: 'openai-chat',
        models: [
          {
            providerId: FIXTURE_MODEL.providerId,
            providerName: FIXTURE_MODEL.providerName,
            providerType: 'openai-chat',
            authMode: 'apiKey',
            modelId: FIXTURE_MODEL.modelId,
            modelName: FIXTURE_MODEL.modelName,
            description: 'Deterministic PTY test fixture',
            supportsVision: false
          }
        ]
      }
    ]
  } as ModelCatalog
}

export class FixtureAgentRuntime implements AgentRuntime {
  private turn = 0
  private messageCount = 0

  async *send(submission: PromptSubmission, signal: AbortSignal): AsyncIterable<UiEvent> {
    this.turn += 1
    this.messageCount += 2
    const turn = this.turn
    const toolId = `fixture-tool-${turn}`
    const assistantId = `fixture-assistant-${turn}`
    const prompt = submission.text.trim()

    const initRequest = prompt.startsWith('OpenCowork /init workflow:')
    const spawnAgents = /\bspawn agents\b/iu.test(prompt)
    const startedAt = Date.now() - 150_000
    const script: UiEvent[] = initRequest
      ? [
          { type: 'runtime.activity', activity: 'working' },
          { type: 'tool.start', id: toolId, title: 'Inspect fixture workspace' },
          {
            type: 'tool.done',
            id: toolId,
            status: 'success',
            summary: 'Read package.json and src/index.tsx',
            title: 'Inspect fixture workspace'
          },
          {
            type: 'askUser.request',
            request: {
              id: `fixture-init-${turn}`,
              toolUseId: `fixture-init-tool-${turn}`,
              questions: [
                {
                  header: 'AGENTS.md',
                  question: 'Review the proposed workspace instructions before writing AGENTS.md.',
                  multiSelect: false,
                  options: [
                    {
                      label: 'Create or update AGENTS.md',
                      description: 'Write the reviewed instructions to the workspace root.',
                      preview: '# AGENTS.md\n\n## Development\n- Run npm test before submitting changes.\n'
                    },
                    {
                      label: 'Cancel',
                      description: 'Keep the workspace unchanged.'
                    }
                  ]
                }
              ]
            }
          },
          { type: 'turn.done' }
        ]
      : spawnAgents
        ? [
            { type: 'runtime.activity', activity: 'working' },
            {
              type: 'tool.start',
              id: `${toolId}-a`,
              title: 'explore',
              subAgent: {
                name: 'explore',
                description: 'Inspect fixture workspace layout',
                model: FIXTURE_MODEL.modelName,
                effort: 'high',
                toolCount: 13,
                tokens: 31_000,
                startedAt,
                completedAt: startedAt + 150_000,
                phase: 'completed',
                report: 'Found the fixture workspace layout.'
              }
            },
            {
              type: 'tool.done',
              id: `${toolId}-a`,
              status: 'success',
              subAgent: { phase: 'completed', completedAt: startedAt + 150_000, currentActivity: '' }
            },
            {
              type: 'tool.start',
              id: `${toolId}-b`,
              title: 'explore',
              subAgent: {
                name: 'explore',
                description: 'Trace fixture tool rendering path',
                model: FIXTURE_MODEL.modelName,
                effort: 'high',
                toolCount: 30,
                tokens: 91_000,
                startedAt,
                phase: 'running',
                currentActivity: 'Used Grep (spawn agents)'
              }
            },
            {
              type: 'tool.update',
              id: `${toolId}-b`,
              subAgent: {
                phase: 'running',
                toolCount: 30,
                currentActivity: 'Used Grep (spawn agents)'
              }
            },
            { type: 'turn.done' }
          ]
        : [
            { type: 'runtime.activity', activity: 'working' },
            { type: 'tool.start', id: toolId, title: 'Read fixture.txt' },
            {
              type: 'tool.done',
              id: toolId,
              status: 'success',
              summary: 'Read 3 lines',
              title: 'Read fixture.txt'
            },
            { type: 'assistant.start', id: assistantId, model: FIXTURE_MODEL.modelName },
            { type: 'assistant.delta', id: assistantId, text: `You said: ${prompt}` },
            { type: 'assistant.done', id: assistantId },
            { type: 'runtime.usage', inputTokens: 42, outputTokens: 7, contextTokens: 42 },
            { type: 'turn.done' }
          ]
    for (const event of script) {
      if (signal.aborted) return
      yield event
    }
  }

  getAgentCatalog(): AgentOption[] {
    return [
      {
        name: 'fixture-agent',
        description: 'Deterministic fixture agent',
        source: 'native'
      }
    ]
  }

  getModelCatalog(): ModelCatalog {
    return catalog()
  }

  getContextSnapshot(): ContextSnapshot {
    return {
      compressionEnabled: false,
      contextLength: 128_000,
      estimatedTokens: 42,
      messageCount: this.messageCount,
      threshold: 0.8,
      triggerTokens: 102_400
    }
  }

  getUsageSnapshot(): UsageSnapshot {
    return {
      billableInputTokens: 42 * this.turn,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCostUsd: null,
      inputTokens: 42 * this.turn,
      model: FIXTURE_MODEL.modelName,
      outputTokens: 7 * this.turn,
      reasoningTokens: 0,
      requestCount: this.turn
    }
  }

  estimateRequestTokens(submission: PromptSubmission): number {
    return Math.max(1, Math.ceil(submission.text.length / 4))
  }

  async respondToAskUser(): Promise<void> {
    // The fixture models the preview/selection handoff; file writes remain Worker-owned in production.
  }

  async dispose(): Promise<void> {
    // Nothing to release: the fixture holds no processes or sockets.
  }
}

export function isFixtureRuntimeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCOWORK_CLI_FIXTURE === '1'
}
