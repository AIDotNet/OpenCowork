import type { BuiltinProviderPreset } from './types'

export const routinAiPreset: BuiltinProviderPreset = {
  builtinId: 'routin-ai',
  name: 'Routin AI',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.routin.ai/v1',
  homepage: 'https://routin.ai',
  apiKeyUrl: 'https://routin.ai/dashboard/api-keys',
  defaultEnabled: true,
  defaultModel: 'mimo-v2-flash',
  defaultModels: [
    {
      id: "mimo-v2-flash", name: "Mimo V2 Flash",
      icon: 'mimo',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 131072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.09,
      outputPrice: 0.29,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
      },
    },
    // ── OpenAI — GPT-4o family (cache: 50% off input) ──
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2.5,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 1.25
    },
    {
      id: 'gpt-4o-mini', name: 'GPT-4o Mini', icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.15,
      outputPrice: 0.6,
      cacheCreationPrice: 0.15,
      cacheHitPrice: 0.075
    },
    // ── OpenAI — O-series reasoning (cache: 50% off input) ──
    {
      id: 'o1',
      name: 'o1',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 15.00,
      outputPrice: 60.00,
      cacheCreationPrice: 15.00,
      cacheHitPrice: 7.50,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
          reasoning_effort: 'medium'
        },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    }, {
      id: 'o1-pro',
      name: 'o1 Pro',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 150.00,
      outputPrice: 600.00,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
          reasoning_effort: 'medium'
        },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'o1-mini',
      name: 'o1 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.1,
      outputPrice: 4.4,
      cacheCreationPrice: 1.1,
      cacheHitPrice: 0.55,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
          reasoning_effort: 'medium'
        },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'o3-mini',
      name: 'o3 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.1,
      outputPrice: 4.4,
      cacheCreationPrice: 1.1,
      cacheHitPrice: 0.55,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
          reasoning_effort: 'medium'
        },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'o3-pro',
      name: 'o3 Pro',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 20.00,
      outputPrice: 80.00,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
          reasoning_effort: 'medium'
        },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'o4-mini',
      name: 'o4 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.1,
      outputPrice: 4.4,
      cacheCreationPrice: 1.1,
      cacheHitPrice: 0.55,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
          reasoning_effort: 'medium'
        },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    // ── OpenAI — GPT-4.1 family (cache: 75% off input) ──
    { id: 'gpt-4.1', name: 'GPT-4.1', icon: 'openai', enabled: true, contextLength: 1_048_576, maxOutputTokens: 32_768, supportsVision: true, supportsFunctionCall: true, inputPrice: 2, outputPrice: 8, cacheCreationPrice: 2, cacheHitPrice: 0.5 },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', icon: 'openai', enabled: true, contextLength: 1_048_576, maxOutputTokens: 32_768, supportsVision: true, supportsFunctionCall: true, inputPrice: 0.4, outputPrice: 1.6, cacheCreationPrice: 0.4, cacheHitPrice: 0.1 },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', icon: 'openai', enabled: true, contextLength: 1_048_576, maxOutputTokens: 32_768, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.1, outputPrice: 0.4, cacheCreationPrice: 0.1, cacheHitPrice: 0.025 },
    // ── OpenAI — GPT-5 family ──
    {
      id: 'gpt-5-chat',
      name: "GPT-5 Chat",
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-chat',
      name: "GPT-5.1 Chat",
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.2-chat',
      name: "GPT-5.2 Chat",
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: "gpt-5",
      name: "GPT 5",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: "gpt-5.1",
      name: "GPT 5.1",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: "gpt-5.2",
      name: "GPT 5.2",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5-codex",
      name: "GPT 5 Codex",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {

        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5.1-codex",
      name: "GPT 5.1 Codex",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5.1-codex-max",
      name: "GPT 5.1 Codex Max",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5.1-codex-mini",
      name: "GPT 5.1 Codex Mini",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.25,
      outputPrice: 2.00,
      cacheCreationPrice: 0.25,
      cacheHitPrice: 0.025,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5.2-codex",
      name: "GPT 5.2 Codex",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {

        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT 5.3 Codex",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {

        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5-pro",
      name: "GPT 5 Pro",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 272_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 15,
      outputPrice: 120,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {

        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'], defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5.2-pro",
      name: "GPT 5.2 Pro",
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 272_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 21.00,
      outputPrice: 168.00,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {

        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'], defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: "gpt-5.3-codex-spark",
      name: "GPT 5.3 Codex Spark",
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 2.5,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 0.25,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {

        },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-4o-transcribe',
      name: 'GPT-4o Transcribe',
      icon: 'openai',
      enabled: true,
      category: 'speech'
    },
    {
      id: 'gpt-4o-mini-transcribe',
      name: 'GPT-4o Mini Transcribe',
      icon: 'openai',
      enabled: true,
      category: 'speech'
    },

    // ── MiniMax ──
    { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', icon: 'minimax', enabled: true, contextLength: 196_608, maxOutputTokens: 16_384, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.27, outputPrice: 0.95, cacheHitPrice: 0.03 },
    { id: 'MiniMax-M2.1-lightning', name: 'MiniMax M2.1 Lightning', icon: 'minimax', enabled: true, contextLength: 196_608, maxOutputTokens: 16_384, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.14, outputPrice: 0.48 },
    { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', icon: 'minimax', enabled: true, contextLength: 196_608, maxOutputTokens: 16_384, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.3, outputPrice: 1.1, cacheHitPrice: 0.03 },
    // ── DeepSeek ──
    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', icon: 'deepseek', enabled: true, contextLength: 163_840, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.26, outputPrice: 0.38, cacheCreationPrice: 0.26, cacheHitPrice: 0.026, supportsThinking: true, thinkingConfig: { bodyParams: { enable_thinking: true } } },
    // ── Moonshot / Kimi ──
    {
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.23,
      outputPrice: 3,
      cacheHitPrice: 0.023,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    // ── Google Gemini ──
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', icon: 'gemini', enabled: true, contextLength: 1_048_576, maxOutputTokens: 65_536, supportsVision: true, supportsFunctionCall: true, inputPrice: 0.5, outputPrice: 3, supportsThinking: true, thinkingConfig: { bodyParams: { reasoning_effort: 'medium' } } },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', icon: 'gemini', enabled: true, contextLength: 1_048_576, maxOutputTokens: 65_536, supportsVision: true, supportsFunctionCall: true, inputPrice: 2, outputPrice: 12, supportsThinking: true, thinkingConfig: { bodyParams: { reasoning_effort: 'medium' } } },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', icon: 'gemini', enabled: true, contextLength: 1_048_576, maxOutputTokens: 65_536, supportsVision: true, supportsFunctionCall: true, inputPrice: 2, outputPrice: 12, supportsThinking: true, thinkingConfig: { bodyParams: { reasoning_effort: 'medium' } } },
    // ── Z.AI / GLM (智谱) ──
    {
      id: 'glm-4.5',
      name: 'GLM 4.5',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.07,
      outputPrice: 0.28
    },
    {
      id: 'glm-4.7',
      name: 'GLM 4.7',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.38,
      outputPrice: 1.7
    },
    {
      id: 'glm-4.7-flash',
      name: 'GLM 4.7 Flash',
      icon: 'chatglm',
      enabled: true,
      contextLength: 202_752,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.56
    },
    {
      id: 'glm-5',
      name: 'GLM 5',
      icon: 'chatglm',
      enabled: true,
      contextLength: 202_752,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.56
    },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', icon: 'claude', type: 'anthropic', enabled: true, contextLength: 200_000, maxOutputTokens: 64_384, supportsVision: true, supportsFunctionCall: true, inputPrice: 5, outputPrice: 25, cacheCreationPrice: 6.25, cacheHitPrice: 0.5, supportsThinking: true, thinkingConfig: { bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } }, forceTemperature: 1 } },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', icon: 'claude', type: 'anthropic', enabled: true, contextLength: 200_000, maxOutputTokens: 64_384, supportsVision: true, supportsFunctionCall: true, inputPrice: 3, outputPrice: 15, cacheCreationPrice: 3.75, cacheHitPrice: 0.3, supportsThinking: true, thinkingConfig: { bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } }, forceTemperature: 1 } },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', icon: 'claude', type: 'anthropic', enabled: true, contextLength: 200_000, maxOutputTokens: 64_384, supportsVision: true, supportsFunctionCall: true, inputPrice: 3, outputPrice: 15, cacheCreationPrice: 3.75, cacheHitPrice: 0.3, supportsThinking: true, thinkingConfig: { bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } }, forceTemperature: 1 } },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', icon: 'claude', type: 'anthropic', enabled: true, contextLength: 200_000, maxOutputTokens: 8_192, supportsVision: true, supportsFunctionCall: true, inputPrice: 1, outputPrice: 5, cacheCreationPrice: 1.25, cacheHitPrice: 0.1, supportsThinking: true, thinkingConfig: { bodyParams: { thinking: { type: 'enabled', budget_tokens: 8000 } }, forceTemperature: 1 } },
    {
      id: 'claude-opus-4-5-20251101',
      name: 'Claude Opus 4.5', icon: 'claude', type: 'anthropic',
      enabled: true, contextLength: 200_000,
      maxOutputTokens: 64_384, supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } }, forceTemperature: 1 }
    }, {
      id: 'claude-sonnet-4-20250514',
      name: 'Claude Sonnet 4',
      icon: 'claude', type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      supportsThinking: true,
      thinkingConfig:
      {
        bodyParams: {
          thinking: { type: 'enabled', budget_tokens: 10000 }
        },
        forceTemperature: 1
      }
    },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', icon: 'claude', type: 'anthropic', enabled: true, contextLength: 200_000, maxOutputTokens: 64_384, supportsVision: true, supportsFunctionCall: true, inputPrice: 15, outputPrice: 75, cacheCreationPrice: 18.75, cacheHitPrice: 1.5, supportsThinking: true, thinkingConfig: { bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } }, forceTemperature: 1 } },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', icon: 'claude', type: 'anthropic', enabled: true, contextLength: 200_000, maxOutputTokens: 8_192, supportsVision: true, supportsFunctionCall: true, inputPrice: 0.8, outputPrice: 4, cacheCreationPrice: 1, cacheHitPrice: 0.08, supportsThinking: true, thinkingConfig: { bodyParams: { thinking: { type: 'enabled', budget_tokens: 8000 } }, forceTemperature: 1 } },

  ],
}
