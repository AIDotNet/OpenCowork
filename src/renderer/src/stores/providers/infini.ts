import type { BuiltinProviderPreset } from './types'

export const infiniPreset: BuiltinProviderPreset = {
  builtinId: 'infini',
  version: 1,
  name: '无问芯穹',
  type: 'openai-chat',
  defaultBaseUrl: 'https://cloud.infini-ai.com/maas/v1',
  homepage: 'https://cloud.infini-ai.com',
  apiKeyUrl: 'https://cloud.infini-ai.com',
  defaultModel: 'deepseek-v4-flash',
  defaultModels: [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true
    },
    {
      id: 'qwen3-235b-a22b',
      name: 'Qwen3 235B',
      icon: 'qwen',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    }
  ]
}
