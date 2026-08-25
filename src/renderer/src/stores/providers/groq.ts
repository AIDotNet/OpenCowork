import type { BuiltinProviderPreset } from './types'

export const groqPreset: BuiltinProviderPreset = {
  builtinId: 'groq',
  version: 1,
  name: 'Groq',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  homepage: 'https://groq.com',
  apiKeyUrl: 'https://console.groq.com/keys',
  defaultModel: 'openai/gpt-oss-120b',
  defaultModels: [
    {
      id: 'openai/gpt-oss-120b',
      name: 'GPT-OSS 120B',
      icon: 'openai',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 65_536,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.15,
      outputPrice: 0.6,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'openai/gpt-oss-20b',
      name: 'GPT-OSS 20B',
      icon: 'openai',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 65_536,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.075,
      outputPrice: 0.3
    },
    {
      id: 'qwen/qwen3.6-27b',
      name: 'Qwen3.6 27B',
      icon: 'qwen',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.6,
      outputPrice: 3
    },
    {
      id: 'minimaxai/minimax-m2.7',
      name: 'MiniMax M2.7',
      icon: 'minimax',
      enabled: true,
      contextLength: 196_608,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B',
      icon: 'meta',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'groq/compound',
      name: 'Groq Compound',
      icon: 'groq',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    }
  ]
}
