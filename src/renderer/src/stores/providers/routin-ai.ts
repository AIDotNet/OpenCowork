import type { BuiltinProviderPreset } from './types'

export const routinAiPreset: BuiltinProviderPreset = {
  builtinId: 'routin-ai',
  name: 'Routin AI',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.routin.ai/v1',
  homepage: 'https://routin.ai',
  apiKeyUrl: 'https://routin.ai/dashboard/api-keys',
  defaultEnabled: true,
  defaultModel: 'deepseek-v4-flash',
  defaultModels: [
    {
      id: 'kimi-k2.7-code',
      name: 'Kimi K2.7 Code',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.95,
      outputPrice: 4,
      cacheHitPrice: 0.19,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'kimi-k2.7-code-highspeed',
      name: 'Kimi K2.7 Code HighSpeed',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.9,
      outputPrice: 8,
      cacheHitPrice: 0.38,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'kimi-k2.6',
      name: 'Kimi K2.6',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.15,
      outputPrice: 0.9,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
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
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'kimi-k2-thinking',
      name: 'Kimi K2 Thinking',
      icon: 'kimi',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.47,
      outputPrice: 2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'glm-5.2',
      name: 'GLM 5.2',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.694,
      outputPrice: 2.778,
      cacheHitPrice: 0.069,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    {
      id: 'mimo-v2.5-pro',
      name: 'MiMo V2.5 Pro',
      icon: 'mimo',
      enabled: true,
      type: 'anthropic',
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.435,
      outputPrice: 0.87,
      cacheHitPrice: 0.0036,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    {
      id: 'mimo-v2.5',
      name: 'MiMo V2.5',
      icon: 'mimo',
      enabled: true,
      type: 'anthropic',
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.28,
      cacheHitPrice: 0.0028,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    {
      id: 'mimo-v2.5-pro-ultraspeed',
      name: 'MiMo V2.5 Pro UltraSpeed',
      icon: 'mimo',
      enabled: true,
      type: 'anthropic',
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.305,
      outputPrice: 2.61,
      cacheHitPrice: 0.0108,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
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
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      icon: 'openai',
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
      inputPrice: 15.0,
      outputPrice: 60.0,
      cacheCreationPrice: 15.0,
      cacheHitPrice: 7.5,
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
      id: 'o1-pro',
      name: 'o1 Pro',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 150.0,
      outputPrice: 600.0,
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
      inputPrice: 20.0,
      outputPrice: 80.0,
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
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 8,
      cacheCreationPrice: 2,
      cacheHitPrice: 0.5
    },
    {
      id: 'gpt-4.1-mini',
      name: 'GPT-4.1 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.4,
      outputPrice: 1.6,
      cacheCreationPrice: 0.4,
      cacheHitPrice: 0.1
    },
    {
      id: 'gpt-4.1-nano',
      name: 'GPT-4.1 Nano',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.1,
      outputPrice: 0.4,
      cacheCreationPrice: 0.1,
      cacheHitPrice: 0.025
    },
    // ── OpenAI — GPT-5 family ──
    {
      id: 'gpt-5-chat',
      name: 'GPT-5 Chat',
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
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-chat',
      name: 'GPT-5.1 Chat',
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
        bodyParams: {},
        reasoningEffortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.2-chat',
      name: 'GPT-5.2 Chat',
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
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5',
      name: 'GPT 5',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1',
      name: 'GPT 5.1',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.2',
      name: 'GPT 5.2',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5-codex',
      name: 'GPT 5 Codex',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-codex',
      name: 'GPT 5.1 Codex',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-codex-max',
      name: 'GPT 5.1 Codex Max',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-codex-mini',
      name: 'GPT 5.1 Codex Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.25,
      outputPrice: 2.0,
      cacheCreationPrice: 0.25,
      cacheHitPrice: 0.025,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.2-codex',
      name: 'GPT 5.2 Codex',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.3-codex',
      name: 'GPT 5.3 Codex',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.4-nano',
      name: 'GPT 5.4 Nano',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 400_000, // 400k
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.2,
      outputPrice: 1.25,
      cacheHitPrice: 0.02,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.4-mini',
      name: 'GPT 5.4 Mini',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.75,
      outputPrice: 4.5,
      cacheHitPrice: 0.075,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.4',
      name: 'GPT 5.4',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 268_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 2.5,
      outputPrice: 15,
      cacheHitPrice: 0.25,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.5',
      name: 'GPT 5.5',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 268_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 5,
      outputPrice: 30,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5-pro',
      name: 'GPT 5 Pro',
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
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.2-pro',
      name: 'GPT 5.2 Pro',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 272_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 21.0,
      outputPrice: 168.0,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.3-codex-spark',
      name: 'GPT 5.3 Codex Spark',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 2.5,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 0.25,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'mimo-v2.5-tts',
      name: 'MiMo V2.5 TTS',
      icon: 'mimo',
      enabled: true,
      category: 'speech',
      audio: true
    },
    {
      id: 'mimo-v2.5-tts-voicedesign',
      name: 'MiMo V2.5 TTS VoiceDesign',
      icon: 'mimo',
      enabled: true,
      category: 'speech',
      audio: true
    },
    {
      id: 'mimo-v2.5-tts-voiceclone',
      name: 'MiMo V2.5 TTS VoiceClone',
      icon: 'mimo',
      enabled: true,
      category: 'speech',
      audio: true
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

    // ── OpenAI — Image generation ──
    {
      id: 'gpt-image-1',
      name: 'GPT Image 1',
      icon: 'openai',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'gpt-image-1.5',
      name: 'GPT Image 1.5',
      icon: 'openai',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      icon: 'openai',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false
    },
    // ── MiniMax ──
    {
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      icon: 'minimax',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.29,
      outputPrice: 1.17,
      cacheHitPrice: 0.06,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      },
      type: 'anthropic'
    },
    {
      id: 'MiniMax-M2.7',
      name: 'MiniMax M2.7',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.2,
      cacheHitPrice: 0.06,
      cacheCreationPrice: 0.375,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      },
      type: 'anthropic'
    },
    {
      id: 'MiniMax-M2.7-highspeed',
      name: 'MiniMax M2.7 Highspeed',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.6,
      outputPrice: 2.4,
      cacheHitPrice: 0.06,
      cacheCreationPrice: 0.375,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      },
      type: 'anthropic'
    },
    {
      id: 'MiniMax-M2.1',
      name: 'MiniMax M2.1',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 64_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.1,
      cacheHitPrice: 0.03,
      cacheCreationPrice: 0.4,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      },
      type: 'anthropic'
    },
    {
      id: 'MiniMax-M2.5',
      name: 'MiniMax M2.5',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.1,
      cacheHitPrice: 0.03,
      cacheCreationPrice: 0.4,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      },
      type: 'anthropic'
    },
    {
      id: 'MiniMax-M2.5-highspeed',
      name: 'MiniMax M2.5 Highspeed',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsVision: false,
      type: 'anthropic',
      supportsFunctionCall: true,
      inputPrice: 0.6,
      outputPrice: 2.4,
      cacheHitPrice: 0.06,
      cacheCreationPrice: 0.7,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    // ── DeepSeek ──
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      type: 'anthropic',
      inputPrice: 1,
      outputPrice: 2,
      cacheCreationPrice: 1,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      type: 'anthropic',
      inputPrice: 12,
      outputPrice: 24,
      cacheCreationPrice: 12,
      cacheHitPrice: 1,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    // ── Google Gemini ──
    {
      id: 'gemini-3.5-flash',
      name: 'Gemini 3.5 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.5,
      outputPrice: 9,
      cacheHitPrice: 0.15
    },
    {
      id: 'gemini-3-flash-preview',
      name: 'Gemini 3 Flash Preview',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.5,
      outputPrice: 3
    },
    {
      id: 'gemini-3-pro-preview',
      name: 'Gemini 3 Pro Preview',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 12
    },
    {
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 12
    },
    {
      id: 'gemini-3.1-flash-lite-preview',
      name: 'Gemini 3.1 flash Lite Preview',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.2,
      outputPrice: 1.5
    },
    {
      id: 'gemini-3.1-flash-image-preview',
      name: 'Gemini 3.1 Flash Image Preview',
      icon: 'gemini',
      enabled: true,
      category: 'image',
      type: 'gemini',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'gemini-3-pro-image-preview',
      name: 'Gemini 3 Pro Image Preview',
      icon: 'gemini',
      enabled: true,
      category: 'image',
      type: 'gemini',
      supportsVision: true,
      supportsFunctionCall: false
    },
    // ── ByteDance Doubao（官方价格为人民币元/百万tokens，按 1 USD ≈ 7.2 CNY 换算为 USD） ──
    {
      id: 'doubao-seed-2-0-code-preview-260215',
      name: 'Doubao Seed 2.0 Code Preview (260215)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      contextLength: 256_000,
      inputPrice: 0.444,
      outputPrice: 2.222,
      cacheHitPrice: 0.089
    },
    {
      id: 'doubao-seed-code-preview-latest',
      name: 'Doubao Seed Code Preview (Latest)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      contextLength: 256_000,
      inputPrice: 0.444,
      outputPrice: 2.222,
      cacheHitPrice: 0.089
    },
    {
      id: 'doubao-seed-2-0-mini-260215',
      name: 'Doubao Seed 2.0 Mini (260215)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      inputPrice: 0.028,
      outputPrice: 0.278,
      cacheHitPrice: 0.006,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2.0-code',
      name: 'Doubao Seed 2.0 Code',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      inputPrice: 0.444,
      outputPrice: 2.222,
      cacheHitPrice: 0.089
    },
    {
      id: 'doubao-seed-2-0-pro-260215',
      name: 'Doubao Seed 2.0 Pro (260215)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      inputPrice: 0.444,
      outputPrice: 2.222,
      cacheHitPrice: 0.089,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2-0-lite-260215',
      name: 'Doubao Seed 2.0 Lite (260215)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      inputPrice: 0.083,
      outputPrice: 0.5,
      cacheHitPrice: 0.017,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-evolving',
      name: 'Doubao Seed Evolving',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      inputPrice: 0.833,
      outputPrice: 4.167,
      cacheHitPrice: 0.167,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2-1-pro-260628',
      name: 'Doubao Seed 2.1 Pro (260628)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      inputPrice: 0.833,
      outputPrice: 4.167,
      cacheHitPrice: 0.167,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2-1-turbo-260628',
      name: 'Doubao Seed 2.1 Turbo (260628)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      inputPrice: 0.417,
      outputPrice: 2.083,
      cacheHitPrice: 0.083,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seedream-4-5-251128',
      name: 'Doubao Seedream 4.5 (251128)',
      icon: 'doubao',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'doubao-seedream-4-0-250828',
      name: 'Doubao Seedream 4.0 (250828)',
      icon: 'doubao',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'doubao-seedream-5-0-260128',
      name: 'Doubao Seedream 5.0 (260128)',
      icon: 'doubao',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'doubao-seedream-3-0-t2i-250415',
      name: 'Doubao Seedream 3.0 T2I (250415)',
      icon: 'doubao',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-opus-4-7',
      name: 'Claude Opus 4.7',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-5-20250929',
      name: 'Claude Sonnet 4.5',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 5,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.1,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 8000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'claude-opus-4-5-20251101',
      name: 'Claude Opus 4.5',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-20250514',
      name: 'Claude Sonnet 4',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {
          thinking: { type: 'enabled', budget_tokens: 10000 }
        },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-opus-4-20250514',
      name: 'Claude Opus 4',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 15,
      outputPrice: 75,
      cacheCreationPrice: 18.75,
      cacheHitPrice: 1.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-3-5-haiku-20241022',
      name: 'Claude 3.5 Haiku',
      icon: 'claude',
      type: 'anthropic',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.8,
      outputPrice: 4,
      cacheCreationPrice: 1,
      cacheHitPrice: 0.08,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 8000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    // ── Qwen3.5 ──
    {
      id: 'qwen3.5-27b',
      name: 'Qwen3.5 27B',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    {
      id: 'qwen3.5-35b-a3b',
      name: 'Qwen3.5 35B-A3B',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.25,
      outputPrice: 1.0,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    {
      id: 'qwen3.5-122b-a10b',
      name: 'Qwen3.5 122B-A10B',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.5,
      outputPrice: 2.0,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    {
      id: 'qwen3.5-397b-a17b',
      name: 'Qwen3.5 397B-A17B',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.0,
      outputPrice: 4.0,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    // ── xAI Grok ──（官方标注无输出 token 上限；4.3 与 multi-agent 支持 reasoning_effort low/high）
    {
      id: 'grok-4.3',
      name: 'Grok 4.3',
      icon: 'grok',
      enabled: true,
      contextLength: 1_000_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 2.5,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'grok-4.20',
      name: 'Grok 4.20',
      icon: 'grok',
      enabled: true,
      contextLength: 2_000_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 2.5,
      cacheHitPrice: 0.2
    },
    {
      id: 'grok-4.20-multi-agent',
      name: 'Grok 4.20 Multi-Agent',
      icon: 'grok',
      enabled: true,
      contextLength: 2_000_000,
      supportsVision: true,
      // 多智能体变体不支持 tools/tool_choice 参数
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 2.5,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'grok-build-0.1',
      name: 'Grok Build 0.1',
      icon: 'grok',
      enabled: true,
      contextLength: 256_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 2,
      cacheHitPrice: 0.2
    }
  ]
}

/** Model IDs for Routin 套餐（https://api.routin.ai/plan/v1）：Codex 全系、GPT-5.4 系、Claude 全系 */
const ROUTIN_AI_PLAN_MODEL_ORDER = [
  'gpt-5.3-codex-spark',
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514'
] as const

const routinAiModelById = new Map(routinAiPreset.defaultModels.map((m) => [m.id, m]))

export const routinAiPlanPreset: BuiltinProviderPreset = {
  builtinId: 'routin-ai-plan',
  name: 'Routin AI（套餐）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.routin.ai/plan/v1',
  homepage: 'https://routin.ai',
  apiKeyUrl: 'https://routin.ai/dashboard/api-keys',
  defaultEnabled: true,
  defaultModel: 'gpt-5.4',
  defaultModels: ROUTIN_AI_PLAN_MODEL_ORDER.map((id) => {
    const config = routinAiModelById.get(id)
    if (!config) {
      throw new Error(`routin-ai plan preset: missing model ${id}`)
    }
    return config
  })
}
