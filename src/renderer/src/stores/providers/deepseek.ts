import type { ThinkingConfig } from '../../lib/api/types'
import { DEEPSEEK_PRICING_SCHEDULE } from '../../lib/model-pricing'
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
  // v4: 2026-08-17 官方峰谷定价（高峰 UTC 01:00–04:00、06:00–10:00，低谷为高峰一半）
  version: 4,
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
      inputPrice: 0.44,
      outputPrice: 1.32,
      cacheCreationPrice: 0.44,
      cacheHitPrice: 0.014,
      offPeakInputPrice: 0.22,
      offPeakOutputPrice: 0.66,
      offPeakCacheCreationPrice: 0.22,
      offPeakCacheHitPrice: 0.007,
      pricingSchedule: DEEPSEEK_PRICING_SCHEDULE,
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
      inputPrice: 1.32,
      outputPrice: 3.96,
      cacheCreationPrice: 1.32,
      cacheHitPrice: 0.044,
      offPeakInputPrice: 0.66,
      offPeakOutputPrice: 1.98,
      offPeakCacheCreationPrice: 0.66,
      offPeakCacheHitPrice: 0.022,
      pricingSchedule: DEEPSEEK_PRICING_SCHEDULE,
      supportsThinking: true,
      thinkingConfig: deepseekV4ThinkingConfig
    }
  ],
  deprecatedModelIds: ['deepseek-chat', 'deepseek-reasoner']
}
