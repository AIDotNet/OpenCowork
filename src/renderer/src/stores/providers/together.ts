import type { BuiltinProviderPreset } from './types'

export const togetherPreset: BuiltinProviderPreset = {
  builtinId: 'together',
  version: 1,
  name: 'Together AI',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.together.xyz/v1',
  homepage: 'https://www.together.ai',
  apiKeyUrl: 'https://api.together.ai/settings/api-keys',
  defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
  defaultModels: [
    {
      id: 'deepseek-ai/DeepSeek-V4-Pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 512_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 2.1,
      outputPrice: 4.4
    },
    {
      id: 'moonshotai/Kimi-K2.5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true
    },
    {
      id: 'Qwen/Qwen3-235B-A22B',
      name: 'Qwen3 235B',
      icon: 'qwen',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      name: 'Llama 4 Maverick',
      icon: 'meta',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true
    }
  ]
}
