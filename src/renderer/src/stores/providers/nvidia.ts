import type { BuiltinProviderPreset } from './types'

export const nvidiaPreset: BuiltinProviderPreset = {
  builtinId: 'nvidia',
  version: 1,
  name: 'NVIDIA NIM',
  type: 'openai-chat',
  defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
  homepage: 'https://build.nvidia.com',
  apiKeyUrl: 'https://build.nvidia.com/settings/api-key',
  defaultModel: 'moonshotai/kimi-k2-instruct',
  defaultModels: [
    {
      id: 'moonshotai/kimi-k2-instruct',
      name: 'Kimi K2 Instruct',
      icon: 'kimi',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'deepseek-ai/deepseek-v3.1',
      name: 'DeepSeek V3.1',
      icon: 'deepseek',
      enabled: true,
      contextLength: 164_000,
      maxOutputTokens: 8_192,
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
      id: 'meta/llama-4-maverick-17b-128e-instruct',
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
