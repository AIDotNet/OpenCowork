import type { BuiltinProviderPreset } from './types'

export const huggingfacePreset: BuiltinProviderPreset = {
  builtinId: 'huggingface',
  version: 1,
  name: 'Hugging Face',
  type: 'openai-chat',
  defaultBaseUrl: 'https://router.huggingface.co/v1',
  homepage: 'https://huggingface.co/inference',
  apiKeyUrl: 'https://huggingface.co/settings/tokens',
  defaultModel: 'deepseek-ai/DeepSeek-V3.2',
  defaultModels: [
    {
      id: 'deepseek-ai/DeepSeek-V3.2',
      name: 'DeepSeek V3.2',
      icon: 'deepseek',
      enabled: true,
      contextLength: 164_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
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
      id: 'zai-org/GLM-5.2',
      name: 'GLM-5.2',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    }
  ]
}
