import type { BuiltinProviderPreset } from './types'

const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

type OpenCodeGoModel = {
  id: string
  name: string
  enabled?: true
  icon?: string
  type: 'openai-chat' | 'anthropic' | 'openai-responses'
  contextLength: number
  maxOutputTokens: number
  inputPrice: number
  outputPrice: number
  cacheHitPrice?: number
  cacheCreationPrice?: number
  supportsThinking?: boolean
  thinkingConfig?: {
    bodyParams: Record<string, unknown>
    disabledBodyParams?: Record<string, unknown>
    reasoningEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
    defaultReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    forceTemperature?: number
  }
  supportsVision?: boolean
  supportsFunctionCall: boolean
}

const shared = {
  contextLength: 262_144,
  maxOutputTokens: 32_768,
  supportsVision: false,
  supportsFunctionCall: true,
  supportsThinking: true,
  thinkingConfig: {
    bodyParams: { thinking: { type: 'enabled' } },
    disabledBodyParams: { thinking: { type: 'disabled' } }
  }
} as const

const chatModels: OpenCodeGoModel[] = [
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    icon: 'grok',
    type: 'openai-chat',
    contextLength: 256_000,
    maxOutputTokens: 32_768,
    inputPrice: 2,
    outputPrice: 6,
    cacheHitPrice: 0.3,
    supportsVision: true,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'high'
    }
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    icon: 'chatglm',
    type: 'openai-chat',
    ...shared,
    inputPrice: 1.4,
    outputPrice: 4.4,
    cacheHitPrice: 0.26
  },
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    icon: 'chatglm',
    type: 'openai-chat',
    ...shared,
    inputPrice: 1.4,
    outputPrice: 4.4,
    cacheHitPrice: 0.26
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    icon: 'kimi',
    type: 'openai-chat',
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    inputPrice: 3,
    outputPrice: 15,
    cacheHitPrice: 0.3,
    supportsVision: true,
    supportsFunctionCall: true,
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
    ...shared,
    inputPrice: 0.95,
    outputPrice: 4,
    cacheHitPrice: 0.19,
    supportsVision: true
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    icon: 'kimi',
    type: 'openai-chat',
    ...shared,
    inputPrice: 0.95,
    outputPrice: 4,
    cacheHitPrice: 0.16,
    supportsVision: true
  },
  {
    id: 'mimo-v2.5',
    name: 'MiMo-V2.5',
    icon: 'mimo',
    type: 'openai-chat',
    ...shared,
    inputPrice: 0.14,
    outputPrice: 0.28,
    cacheHitPrice: 0.0028
  },
  {
    id: 'mimo-v2.5-pro',
    name: 'MiMo-V2.5-Pro',
    icon: 'mimo',
    type: 'openai-chat',
    ...shared,
    maxOutputTokens: 131_072,
    inputPrice: 0.435,
    outputPrice: 0.87,
    cacheHitPrice: 0.003625
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax M3',
    icon: 'minimax',
    type: 'anthropic',
    ...shared,
    inputPrice: 0.3,
    outputPrice: 1.2,
    cacheHitPrice: 0.06
  },
  {
    id: 'minimax-m2.7',
    name: 'MiniMax M2.7',
    icon: 'minimax',
    type: 'anthropic',
    ...shared,
    inputPrice: 0.3,
    outputPrice: 1.2,
    cacheHitPrice: 0.06,
    cacheCreationPrice: 0.375
  },
  {
    id: 'minimax-m2.5',
    name: 'MiniMax M2.5',
    icon: 'minimax',
    type: 'anthropic',
    ...shared,
    inputPrice: 0.3,
    outputPrice: 1.2,
    cacheHitPrice: 0.06,
    cacheCreationPrice: 0.375
  },
  {
    id: 'qwen3.8-max',
    name: 'Qwen3.8 Max',
    icon: 'qwen',
    type: 'anthropic',
    ...shared,
    inputPrice: 2,
    outputPrice: 6,
    cacheHitPrice: 0.25,
    cacheCreationPrice: 2.5
  },
  {
    id: 'qwen3.7-max',
    name: 'Qwen3.7 Max',
    icon: 'qwen',
    type: 'anthropic',
    ...shared,
    inputPrice: 2.5,
    outputPrice: 7.5,
    cacheHitPrice: 0.5,
    cacheCreationPrice: 3.125
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7 Plus',
    icon: 'qwen',
    type: 'anthropic',
    ...shared,
    inputPrice: 0.4,
    outputPrice: 1.6,
    cacheHitPrice: 0.04,
    cacheCreationPrice: 0.5
  },
  {
    id: 'qwen3.6-plus',
    name: 'Qwen3.6 Plus',
    icon: 'qwen',
    type: 'anthropic',
    ...shared,
    inputPrice: 0.5,
    outputPrice: 3,
    cacheHitPrice: 0.05,
    cacheCreationPrice: 0.625
  },
  {
    id: 'hy3',
    name: 'Hy3',
    type: 'openai-chat',
    ...shared,
    inputPrice: 0.14,
    outputPrice: 0.58,
    cacheHitPrice: 0.035
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    icon: 'deepseek',
    type: 'openai-chat',
    ...shared,
    inputPrice: 0.435,
    outputPrice: 0.87,
    cacheHitPrice: 0.003625
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    icon: 'deepseek',
    type: 'openai-chat',
    ...shared,
    inputPrice: 0.14,
    outputPrice: 0.28,
    cacheHitPrice: 0.0028
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT 5.6 Luna',
    icon: 'openai',
    type: 'openai-responses',
    contextLength: 400_000,
    maxOutputTokens: 128_000,
    inputPrice: 0.2,
    outputPrice: 1.2,
    cacheHitPrice: 0.02,
    cacheCreationPrice: 0.25,
    supportsVision: true,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: {
      bodyParams: {},
      reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high'
    }
  }
]

export const opencodeGoPreset: BuiltinProviderPreset = {
  builtinId: 'opencode-go',
  version: 3,
  name: 'OpenCode Go',
  type: 'openai-chat',
  defaultBaseUrl: OPENCODE_GO_BASE_URL,
  homepage: 'https://opencode.ai/docs/zh-cn/go/',
  apiKeyUrl: 'https://opencode.ai/auth',
  defaultModel: 'deepseek-v4-flash',
  defaultModels: chatModels.map((model) => ({ ...model, enabled: true }))
}
