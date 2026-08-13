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
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    icon: 'deepseek',
    type: 'openai-chat',
    contextLength: 1_000_000,
    maxOutputTokens: 384_000,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 1.74,
    outputPrice: 3.48,
    cacheHitPrice: 0.145,
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
    inputPrice: 0.14,
    outputPrice: 0.28,
    cacheHitPrice: 0.028,
    supportsThinking: true,
    thinkingConfig: { ...deepseekV4ThinkingConfig }
  },
  {
    id: 'deepseek-v4-flash-free',
    name: 'DeepSeek V4 Flash Free',
    icon: 'deepseek',
    type: 'openai-chat',
    contextLength: 200_000,
    maxOutputTokens: 32_768,
    supportsVision: false,
    supportsFunctionCall: true,
    inputPrice: 0,
    outputPrice: 0,
    cacheHitPrice: 0,
    supportsThinking: true,
    thinkingConfig: { ...deepseekV4ThinkingConfig }
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
  }
]

export const opencodePreset: BuiltinProviderPreset = {
  builtinId: 'opencode',
  version: 1,
  name: 'OpenCode Zen',
  type: 'openai-chat',
  defaultBaseUrl: OPENCODE_ZEN_BASE_URL,
  homepage: 'https://opencode.ai/docs/zen/',
  apiKeyUrl: 'https://opencode.ai/auth',
  defaultModel: 'deepseek-v4-flash',
  defaultModels: chatModels.map((model) => ({ ...model, enabled: true }))
}
