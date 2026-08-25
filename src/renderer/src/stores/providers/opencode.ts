import type { BuiltinProviderPreset } from './types'

const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

/** DeepSeek V4 Chat Completions: `thinking.type` toggle + `reasoning_effort` low/high/max (default high). */
const deepseekV4ThinkingConfig = {
  bodyParams: { thinking: { type: 'enabled' } },
  disabledBodyParams: { thinking: { type: 'disabled' } },
  reasoningEffortLevels: ['low', 'high', 'max'] as const,
  defaultReasoningEffort: 'high' as const
}

const chatThinkingConfig = {
  bodyParams: { thinking: { type: 'enabled' } },
  disabledBodyParams: { thinking: { type: 'disabled' } }
}

// `enabled` is stamped on in `defaultModels` below, so the preset entries omit it.
type OpenCodeZenModel = Omit<BuiltinProviderPreset['defaultModels'][number], 'enabled'>

const chatModels: OpenCodeZenModel[] = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT 5.6 Sol',
    icon: 'openai',
    type: 'openai-responses',
    contextLength: 372_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsFunctionCall: false,
    inputPrice: 2,
    outputPrice: 10,
    cacheCreationPrice: 2.5,
    cacheHitPrice: 0.2,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'medium'
    }
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT 5.6 Terra',
    icon: 'openai',
    type: 'openai-responses',
    contextLength: 372_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsFunctionCall: false,
    inputPrice: 2,
    outputPrice: 12,
    cacheCreationPrice: 2.5,
    cacheHitPrice: 0.2,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'medium'
    }
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT 5.6 Luna',
    icon: 'openai',
    type: 'openai-responses',
    contextLength: 372_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsFunctionCall: false,
    inputPrice: 0.2,
    outputPrice: 1.2,
    cacheCreationPrice: 0.25,
    cacheHitPrice: 0.02,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'medium'
    }
  },
  {
    id: 'gpt-5.5',
    name: 'GPT 5.5',
    icon: 'openai',
    type: 'openai-responses',
    contextLength: 1_050_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsFunctionCall: false,
    inputPrice: 5,
    outputPrice: 30,
    cacheHitPrice: 0.5,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium'
    }
  },
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    icon: 'claude',
    type: 'anthropic',
    contextLength: 1_000_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsFunctionCall: true,
    inputPrice: 10,
    outputPrice: 50,
    cacheCreationPrice: 12.5,
    cacheHitPrice: 1,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: { thinking: { type: 'adaptive' } },
      forceTemperature: 1,
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high'
    }
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    icon: 'claude',
    type: 'anthropic',
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
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    icon: 'claude',
    type: 'anthropic',
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
    id: 'grok-4.6',
    name: 'Grok 4.6',
    icon: 'grok',
    type: 'openai-responses',
    contextLength: 500_000,
    supportsVision: true,
    supportsFunctionCall: true,
    inputPrice: 2,
    outputPrice: 6,
    cacheHitPrice: 0.5,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'high'
    }
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    icon: 'grok',
    type: 'openai-responses',
    contextLength: 500_000,
    supportsVision: true,
    supportsFunctionCall: true,
    inputPrice: 2,
    outputPrice: 6,
    cacheHitPrice: 0.3,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'high'
    }
  },
  {
    id: 'qwen3.7-max',
    name: 'Qwen3.7 Max',
    icon: 'qwen',
    type: 'anthropic',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 2.5,
    outputPrice: 7.5,
    cacheHitPrice: 0.5,
    cacheCreationPrice: 3.125,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7 Plus',
    icon: 'qwen',
    type: 'anthropic',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 0.4,
    outputPrice: 1.6,
    cacheHitPrice: 0.04,
    cacheCreationPrice: 0.5,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    icon: 'deepseek',
    type: 'openai-chat',
    contextLength: 1_000_000,
    maxOutputTokens: 384_000,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 0.66,
    outputPrice: 1.98,
    cacheHitPrice: 0.022,
    supportsThinking: true,
    thinkingConfig: { ...deepseekV4ThinkingConfig }
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    icon: 'deepseek',
    type: 'openai-chat',
    contextLength: 1_000_000,
    maxOutputTokens: 384_000,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 0.22,
    outputPrice: 0.66,
    cacheHitPrice: 0.007,
    supportsThinking: true,
    thinkingConfig: { ...deepseekV4ThinkingConfig }
  },
  {
    id: 'mimo-v2.5-free',
    name: 'MiMo-V2.5 Free',
    icon: 'mimo',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 0,
    outputPrice: 0,
    cacheHitPrice: 0,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  },
  {
    id: 'glm-5.2',
    name: 'GLM 5.2',
    icon: 'chatglm',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 1.4,
    outputPrice: 4.4,
    cacheHitPrice: 0.26,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  },
  {
    id: 'glm-5.1',
    name: 'GLM 5.1',
    icon: 'chatglm',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 1.4,
    outputPrice: 4.4,
    cacheHitPrice: 0.26,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax M3',
    icon: 'minimax',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 0.3,
    outputPrice: 1.2,
    cacheHitPrice: 0.06,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  },
  {
    id: 'minimax-m2.7',
    name: 'MiniMax M2.7',
    icon: 'minimax',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 0.3,
    outputPrice: 1.2,
    cacheHitPrice: 0.06,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    icon: 'kimi',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: true,
    supportsFunctionCall: true,
    inputPrice: 3,
    outputPrice: 15,
    cacheHitPrice: 0.3,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['max'],
      defaultReasoningEffort: 'max'
    }
  },
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    icon: 'kimi',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: true,
    supportsFunctionCall: true,
    inputPrice: 0.95,
    outputPrice: 4,
    cacheHitPrice: 0.19,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    icon: 'kimi',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    supportsVision: true,
    supportsFunctionCall: true,
    inputPrice: 0.95,
    outputPrice: 4,
    cacheHitPrice: 0.16,
    supportsThinking: true,
    thinkingConfig: chatThinkingConfig
  }
]

export const opencodePreset: BuiltinProviderPreset = {
  builtinId: 'opencode',
  version: 2,
  name: 'OpenCode Zen',
  type: 'openai-chat',
  defaultBaseUrl: OPENCODE_ZEN_BASE_URL,
  homepage: 'https://opencode.ai/docs/zen/',
  apiKeyUrl: 'https://opencode.ai/auth',
  defaultModel: 'deepseek-v4-flash',
  deprecatedModelIds: ['deepseek-v4-flash-free'],
  defaultModels: chatModels.map((model) => ({ ...model, enabled: true }))
}
