import type { BuiltinProviderPreset } from './types'

export const novitaPreset: BuiltinProviderPreset = {
  builtinId: 'novita',
  version: 1,
  name: 'Novita',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.novita.ai/v3/openai',
  homepage: 'https://novita.ai',
  apiKeyUrl: 'https://novita.ai/settings/key',
  defaultModel: 'deepseek/deepseek-v4-pro',
  defaultModels: [
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.69,
      outputPrice: 3.38
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
    },
    {
      id: 'zai-org/glm-5.2',
      name: 'GLM-5.2',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
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
    }
  ]
}
