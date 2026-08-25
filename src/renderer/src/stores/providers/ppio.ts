import type { BuiltinProviderPreset } from './types'

export const ppioPreset: BuiltinProviderPreset = {
  builtinId: 'ppio',
  version: 1,
  name: '派欧云 PPIO',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.ppio.com/openai/v1',
  homepage: 'https://ppio.com',
  apiKeyUrl: 'https://ppio.com/settings/key',
  defaultModel: 'deepseek/deepseek-v4-pro',
  defaultModels: [
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'qwen/qwen3-235b-a22b',
      name: 'Qwen3 235B',
      icon: 'qwen',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'moonshotai/kimi-k2.5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true
    }
  ]
}
