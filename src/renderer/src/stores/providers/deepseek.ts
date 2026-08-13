import type { ThinkingConfig } from '../../lib/api/types'
import type { BuiltinProviderPreset } from './types'

/** DeepSeek V4 Chat Completions: `thinking.type` toggle + `reasoning_effort` low/high/max (default high). */
const deepseekV4ThinkingConfig: ThinkingConfig = {
  bodyParams: { thinking: { type: 'enabled' } },
  disabledBodyParams: { thinking: { type: 'disabled' } },
  reasoningEffortLevels: ['low', 'high', 'max'],
  defaultReasoningEffort: 'high'
}

export const deepseekPreset: BuiltinProviderPreset = {
  builtinId: 'deepseek',
  // v2: DeepSeek 模型改用 OpenAI Chat Completions 协议（/chat/completions）
  // v3: DeepSeek V4 支持 reasoning_effort（low/high/max）
  version: 3,
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
      inputPrice: 0.14,
      outputPrice: 0.28,
      cacheCreationPrice: 0.14,
      cacheHitPrice: 0.0028,
      supportsThinking: true,
      thinkingConfig: deepseekV4ThinkingConfig
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
      inputPrice: 0.435,
      outputPrice: 0.87,
      cacheCreationPrice: 0.435,
      cacheHitPrice: 0.003625,
      supportsThinking: true,
      thinkingConfig: deepseekV4ThinkingConfig
    }
  ],
  deprecatedModelIds: ['deepseek-chat', 'deepseek-reasoner']
}
