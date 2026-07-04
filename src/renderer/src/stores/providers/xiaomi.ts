import type { AIModelConfig } from '../../lib/api/types'
import type { BuiltinProviderPreset } from './types'

const xiaomiThinkingConfig = {
  bodyParams: { thinking: { type: 'enabled' } },
  disabledBodyParams: { thinking: { type: 'disabled' } }
} as const

const xiaomiTextModels: AIModelConfig[] = [
  {
    id: 'mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    icon: 'mimo',
    enabled: true,
    contextLength: 1_000_000,
    maxOutputTokens: 131_072,
    supportsVision: false,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: xiaomiThinkingConfig
  },
  {
    id: 'mimo-v2.5',
    name: 'MiMo V2.5',
    icon: 'mimo',
    enabled: true,
    contextLength: 1_000_000,
    maxOutputTokens: 131_072,
    supportsVision: true,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: xiaomiThinkingConfig
  },
  {
    id: 'mimo-v2-pro',
    name: 'MiMo V2 Pro',
    icon: 'mimo',
    enabled: true,
    contextLength: 1_000_000,
    maxOutputTokens: 131_072,
    supportsVision: false,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: xiaomiThinkingConfig
  },
  {
    id: 'mimo-v2-omni',
    name: 'MiMo V2 Omni',
    icon: 'mimo',
    enabled: true,
    contextLength: 262_144,
    maxOutputTokens: 131_072,
    supportsVision: true,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: xiaomiThinkingConfig
  },
  {
    id: 'mimo-v2-flash',
    name: 'MiMo V2 Flash',
    icon: 'mimo',
    enabled: true,
    contextLength: 262_144,
    maxOutputTokens: 65_536,
    supportsVision: false,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: xiaomiThinkingConfig
  },
  {
    id: 'mimo-v2.5-pro-ultraspeed',
    name: 'MiMo V2.5 Pro UltraSpeed',
    icon: 'mimo',
    enabled: true,
    contextLength: 1_000_000,
    maxOutputTokens: 131_072,
    supportsVision: false,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: xiaomiThinkingConfig
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
  }
]

export const xiaomiCodingPreset: BuiltinProviderPreset = {
  builtinId: 'xiaomi-coding',
  name: '小米（套餐）',
  type: 'anthropic',
  defaultBaseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  homepage: 'https://platform.xiaomimimo.com/token-plan',
  apiKeyUrl: 'https://platform.xiaomimimo.com/token-plan',
  defaultEnabled: false,
  defaultModel: 'mimo-v2.5-pro',
  defaultModels: xiaomiTextModels.map((model) => ({ ...model }))
}

export const xiaomiPreset: BuiltinProviderPreset = {
  builtinId: 'xiaomi',
  name: '小米',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
  homepage: 'https://platform.xiaomimimo.com/',
  apiKeyUrl: 'https://platform.xiaomimimo.com/',
  defaultModel: 'mimo-v2.5-pro',
  defaultModels: [
    {
      ...xiaomiTextModels[0],
      inputPrice: 0.435,
      outputPrice: 0.87,
      cacheHitPrice: 0.0036
    },
    {
      ...xiaomiTextModels[1],
      inputPrice: 0.14,
      outputPrice: 0.28,
      cacheHitPrice: 0.0028
    },
    {
      ...xiaomiTextModels[2],
      inputPrice: 0.435,
      outputPrice: 0.87,
      cacheHitPrice: 0.0036
    },
    {
      ...xiaomiTextModels[3],
      inputPrice: 0.14,
      outputPrice: 0.28,
      cacheHitPrice: 0.0028
    },
    {
      ...xiaomiTextModels[4],
      inputPrice: 0.14,
      outputPrice: 0.28,
      cacheHitPrice: 0.0028
    },
    {
      ...xiaomiTextModels[5],
      inputPrice: 1.305,
      outputPrice: 2.61,
      cacheHitPrice: 0.0108
    }
  ]
}
