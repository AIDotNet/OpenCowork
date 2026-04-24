import type { BuiltinProviderPreset } from './types'

export const deepseekPreset: BuiltinProviderPreset = {
  builtinId: 'deepseek',
  name: 'DeepSeek',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  homepage: 'https://platform.deepseek.com',
  apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  defaultModel: 'deepseek-v4-flash',
  defaultModels: [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 2,
      cacheCreationPrice: 1,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 12,
      outputPrice: 24,
      cacheCreationPrice: 12,
      cacheHitPrice: 1,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'deepseek-chat',
      name: 'DeepSeek V4 Flash (Chat, Deprecated)',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 2,
      cacheCreationPrice: 1,
      cacheHitPrice: 0.2
    },
    {
      id: 'deepseek-reasoner',
      name: 'DeepSeek V4 Flash (Reasoner, Deprecated)',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 2,
      cacheCreationPrice: 1,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    }
  ],
  deprecatedModelIds: ['deepseek-chat', 'deepseek-reasoner']
}
