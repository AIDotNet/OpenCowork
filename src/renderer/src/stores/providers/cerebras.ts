import type { BuiltinProviderPreset } from './types'

export const cerebrasPreset: BuiltinProviderPreset = {
  builtinId: 'cerebras',
  version: 1,
  name: 'Cerebras',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.cerebras.ai/v1',
  homepage: 'https://www.cerebras.ai',
  apiKeyUrl: 'https://cloud.cerebras.ai',
  defaultModel: 'gpt-oss-120b',
  defaultModels: [
    {
      id: 'gpt-oss-120b',
      name: 'GPT-OSS 120B',
      icon: 'openai',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 65_536,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'gemma-4-31b',
      name: 'Gemma 4 31B',
      icon: 'gemini',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    }
  ]
}
