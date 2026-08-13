import type { BuiltinProviderPreset } from './types'

export const openrouterPreset: BuiltinProviderPreset = {
  builtinId: 'openrouter',
  version: 2,
  name: 'OpenRouter',
  type: 'openai-chat',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  homepage: 'https://openrouter.ai',
  apiKeyUrl: 'https://openrouter.ai/keys',
  deprecatedModelIds: [
    'openai/gpt-5.2',
    'openai/gpt-5.2-codex',
    'anthropic/claude-sonnet-4',
    'anthropic/claude-opus-4.6',
    'x-ai/grok-4',
    'x-ai/grok-4.1-fast',
    'x-ai/grok-4-fast',
    'x-ai/grok-code-fast-1'
  ],
  defaultModels: [
    // ── Anthropic ──
    {
      id: 'anthropic/claude-opus-4.8',
      name: 'Claude Opus 4.8',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5
    },
    {
      id: 'anthropic/claude-opus-4.7',
      name: 'Claude Opus 4.7',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5
    },
    {
      id: 'anthropic/claude-sonnet-5',
      name: 'Claude Sonnet 5',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 0.2
    },
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Claude Haiku 4.5',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 5,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.1
    },
    {
      id: 'anthropic/claude-opus-4.5',
      name: 'Claude Opus 4.5',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5
    },

    // ── OpenAI — GPT-5 family ──
    {
      id: 'openai/gpt-5.1',
      name: 'GPT-5.1',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'openai/gpt-5-mini',
      name: 'GPT-5 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.25,
      outputPrice: 2,
      cacheCreationPrice: 0.25,
      cacheHitPrice: 0.025,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'openai/gpt-5-nano',
      name: 'GPT-5 Nano',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.05,
      outputPrice: 0.4,
      cacheCreationPrice: 0.05,
      cacheHitPrice: 0.005,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'openai/gpt-5-pro',
      name: 'GPT-5 Pro',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 100_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 15,
      outputPrice: 120,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'high' },
        reasoningEffortLevels: ['high'],
        defaultReasoningEffort: 'high'
      }
    },
    // ── OpenAI — GPT-5.4 / 5.5 ──
    {
      id: 'openai/gpt-5.5',
      name: 'GPT-5.5',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 30,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'openai/gpt-5.4',
      name: 'GPT-5.4',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2.5,
      outputPrice: 15,
      cacheHitPrice: 0.25,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      }
    },
    // ── OpenAI — O-series ──
    {
      id: 'openai/o3',
      name: 'o3',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 8,
      cacheCreationPrice: 2,
      cacheHitPrice: 1,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'openai/o4-mini',
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
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'openai/o3-mini',
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
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    // ── OpenAI — GPT-4.1 family ──
    {
      id: 'openai/gpt-4.1',
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
      id: 'openai/gpt-4.1-mini',
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
      id: 'openai/gpt-4.1-nano',
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
    // ── OpenAI — GPT-4o family ──
    {
      id: 'openai/gpt-4o',
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
      id: 'openai/gpt-4o-mini',
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

    // ── Google Gemini ──
    {
      id: 'google/gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 12,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { reasoning_effort: 'medium' } }
    },
    {
      id: 'google/gemini-3.5-flash',
      name: 'Gemini 3.5 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.5,
      outputPrice: 9,
      cacheHitPrice: 0.15,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { reasoning_effort: 'medium' } }
    },
    {
      id: 'google/gemini-3-flash-preview',
      name: 'Gemini 3 Flash Preview',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.5,
      outputPrice: 3,
      cacheHitPrice: 0.05
    },
    {
      id: 'google/gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 10,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { reasoning_effort: 'medium' } }
    },
    {
      id: 'google/gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 2.5,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { reasoning_effort: 'medium' } }
    },
    {
      id: 'google/gemini-2.5-flash-lite',
      name: 'Gemini 2.5 Flash-Lite',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.1,
      outputPrice: 0.4,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { reasoning_effort: 'medium' } }
    },
    {
      id: 'google/gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.1,
      outputPrice: 0.4
    },

    // ── DeepSeek ──
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.435,
      outputPrice: 0.87,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        reasoningEffortLevels: ['high', 'xhigh'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'deepseek/deepseek-v3.2',
      name: 'DeepSeek V3.2',
      icon: 'deepseek',
      enabled: true,
      contextLength: 163_840,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.26,
      outputPrice: 0.38,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    {
      id: 'deepseek/deepseek-r1',
      name: 'DeepSeek R1',
      icon: 'deepseek',
      enabled: true,
      contextLength: 163_840,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: false,
      inputPrice: 0.7,
      outputPrice: 2.5
    },
    {
      id: 'deepseek/deepseek-chat-v3.1',
      name: 'DeepSeek V3.1 Chat',
      icon: 'deepseek',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.15,
      outputPrice: 0.75,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },

    // ── Moonshot / Kimi ──
    {
      id: 'moonshotai/kimi-k2.6',
      name: 'Kimi K2.6',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.66,
      outputPrice: 3.41,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'moonshotai/kimi-k2.5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
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

    // ── MiniMax ──
    {
      id: 'minimax/minimax-m3',
      name: 'MiniMax M3',
      icon: 'minimax',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.2
    },
    {
      id: 'minimax/minimax-m2.1',
      name: 'MiniMax M2.1',
      icon: 'minimax',
      enabled: true,
      contextLength: 196_608,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.27,
      outputPrice: 0.95,
      cacheHitPrice: 0.03
    },
    {
      id: 'minimax/minimax-m2.1-lightning',
      name: 'MiniMax M2.1 Lightning',
      icon: 'minimax',
      enabled: true,
      contextLength: 196_608,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.48
    },
    {
      id: 'minimax/minimax-m2.5',
      name: 'MiniMax M2.5',
      icon: 'minimax',
      enabled: true,
      contextLength: 196_608,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.1
    },

    // ── xAI Grok ──
    {
      id: 'x-ai/grok-4.3',
      name: 'Grok 4.3',
      icon: 'grok',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 2.5
    },
    {
      id: 'x-ai/grok-4.20',
      name: 'Grok 4.20',
      icon: 'grok',
      enabled: true,
      contextLength: 2_000_000,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 2.5
    },
    {
      id: 'x-ai/grok-build-0.1',
      name: 'Grok Build 0.1',
      icon: 'grok',
      enabled: true,
      contextLength: 256_000,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 2
    },

    // ── Z.AI / GLM (智谱) ──
    {
      id: 'z-ai/glm-5.2',
      name: 'GLM-5.2',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.9,
      outputPrice: 2.86
    },
    {
      id: 'z-ai/glm-4.7',
      name: 'GLM-4.7',
      icon: 'chatglm',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.38,
      outputPrice: 1.7
    },
    {
      id: 'z-ai/glm-4.6',
      name: 'GLM-4.6',
      icon: 'chatglm',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.35,
      outputPrice: 1.71
    },
    {
      id: 'z-ai/glm-4.5-air',
      name: 'GLM-4.5 Air',
      icon: 'chatglm',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.13,
      outputPrice: 0.85
    },

    // ── Qwen ──
    {
      id: 'qwen/qwen3.7-max',
      name: 'Qwen3.7 Max',
      icon: 'qwen',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 3.75
    },
    {
      id: 'qwen/qwen3-235b-a22b',
      name: 'Qwen3 235B',
      icon: 'qwen',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.455,
      outputPrice: 1.82,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    {
      id: 'qwen/qwen3-coder-next',
      name: 'Qwen3 Coder Next',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.12,
      outputPrice: 0.75,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    {
      id: 'qwen/qwen3-30b-a3b',
      name: 'Qwen3 30B-A3B',
      icon: 'qwen',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.08,
      outputPrice: 0.28,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },

    // ── Meta Llama ──
    {
      id: 'meta-llama/llama-4-maverick',
      name: 'Llama 4 Maverick',
      icon: 'meta',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.15,
      outputPrice: 0.6
    },

    // ── Mistral ──
    {
      id: 'mistralai/devstral-small',
      name: 'Devstral Small',
      icon: 'mistral',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.1,
      outputPrice: 0.3
    },
    {
      id: 'mistralai/mistral-small-3.2',
      name: 'Mistral Small 3.2',
      icon: 'mistral',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.1,
      outputPrice: 0.3
    },

    // ── ByteDance / StepFun / Tencent ──
    {
      id: 'stepfun-ai/step3',
      name: 'Step 3',
      icon: 'stepfun',
      enabled: true,
      contextLength: 256_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.56,
      outputPrice: 2.24
    },
    {
      id: 'tencent/hunyuan-a13b-instruct',
      name: 'Hunyuan A13B',
      icon: 'hunyuan',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.57
    },

    // ── Free models ──
    {
      id: 'xiaomi/mimo-v2-flash',
      name: 'MiMo V2 Flash',
      icon: 'mimo',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 131072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.09,
      outputPrice: 0.29
    },
    {
      id: 'nvidia/nemotron-nano-9b-v2:free',
      name: 'Nemotron Nano 9B (Free)',
      icon: 'nvidia',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0,
      outputPrice: 0
    }
  ]
}
