import type { BuiltinProviderPreset } from './types'

export const moonshotCodingPreset: BuiltinProviderPreset = {
  builtinId: 'moonshot-coding',
  name: 'Moonshot（套餐）',
  type: 'anthropic',
  defaultBaseUrl: 'https://api.kimi.com/coding/',
  homepage: 'https://www.kimi.com',
  apiKeyUrl: 'https://www.kimi.com/code/console?from=membership',
  defaultEnabled: true,
  userAgent: 'RooCode/3.48.0',
  defaultModels: [
    {
      id: 'kimi-for-coding',
      name: 'Kimi for Coding',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.23,
      outputPrice: 3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }, forceTemperature: 1
      }
    },
  ],
}

export const moonshotPreset: BuiltinProviderPreset = {
  builtinId: 'moonshot',
  name: 'Moonshot（官方）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.moonshot.cn/v1',
  homepage: 'https://platform.moonshot.cn',
  apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  defaultModels: [
    // Kimi K2.x (OpenRouter USD pricing)
    // refs: https://openrouter.ai/moonshotai/kimi-k2.5, https://openrouter.ai/moonshotai/kimi-k2-thinking
    {
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.23,
      outputPrice: 3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }, forceTemperature: 1
      }
    },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', icon: 'kimi', enabled: true, contextLength: 131_072, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.47, outputPrice: 2 },
    // Moonshot V1 series (cache: 75% off input)
    { id: 'moonshot-v1-auto', name: 'Moonshot v1 Auto', icon: 'moonshot', enabled: true, maxOutputTokens: 4_096, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.6, outputPrice: 2.5, cacheHitPrice: 0.15 },
    { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', icon: 'moonshot', enabled: true, contextLength: 8_192, maxOutputTokens: 4_096, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.2, outputPrice: 2, cacheHitPrice: 0.05 },
    { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', icon: 'moonshot', enabled: true, contextLength: 32_000, maxOutputTokens: 4_096, supportsVision: false, supportsFunctionCall: true, inputPrice: 1, outputPrice: 3, cacheHitPrice: 0.25 },
    { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', icon: 'moonshot', enabled: true, contextLength: 128_000, maxOutputTokens: 4_096, supportsVision: false, supportsFunctionCall: true, inputPrice: 2, outputPrice: 5, cacheHitPrice: 0.5 },
  ],
}
