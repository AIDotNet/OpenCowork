import type { BuiltinProviderPreset } from './types'

export const bigmodelCodingPreset: BuiltinProviderPreset = {
  builtinId: 'bigmodel-coding',
  name: '智谱AI（套餐）',
  type: 'anthropic',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  homepage: 'https://bigmodel.cn/glm-coding',
  apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
  defaultEnabled: true,
  defaultModels: [
    // GLM-5 (Max & Pro tiers only, consumes 2-3x quota)
    { id: 'glm-5', name: 'GLM-5 (Max/Pro)', icon: 'bigmodel', enabled: true, supportsFunctionCall: true, supportsThinking: true, thinkingConfig: { bodyParams: { thinking_mode: 'auto' } } },
    // GLM-4.7 (All tiers, default flagship model)
    { id: 'glm-4.7', name: 'GLM-4.7', icon: 'bigmodel', enabled: true, supportsFunctionCall: true },
    // GLM-4.5 Air (All tiers, default lightweight model)
    { id: 'glm-4.5-air', name: 'GLM-4.5 Air', icon: 'bigmodel', enabled: true, supportsFunctionCall: true },
  ],
}

export const bigmodelPreset: BuiltinProviderPreset = {
  builtinId: 'bigmodel',
  name: '智谱AI（官方）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  homepage: 'https://bigmodel.cn',
  apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
  defaultModels: [
    // GLM-5 series (latest generation)
    { id: 'glm-5', name: 'GLM-5', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 32_768, supportsVision: false, supportsFunctionCall: true, supportsThinking: true, thinkingConfig: { bodyParams: { thinking_mode: 'auto' } } },
    // GLM-4 series
    { id: 'glm-4.7', name: 'GLM-4.7', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true, supportsThinking: true, thinkingConfig: { bodyParams: { thinking_mode: 'auto' } } },
    { id: 'glm-4.6', name: 'GLM-4.6', icon: 'bigmodel', enabled: true, contextLength: 200_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true, supportsThinking: true, thinkingConfig: { bodyParams: { thinking_mode: 'auto' } } },
    { id: 'glm-4.5', name: 'GLM-4.5', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true, supportsThinking: true, thinkingConfig: { bodyParams: { thinking_mode: 'auto' } } },
    { id: 'glm-4.5v', name: 'GLM-4.5V', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: true, supportsFunctionCall: true, supportsThinking: true, thinkingConfig: { bodyParams: { thinking_mode: 'auto' } } },
    { id: 'glm-4.6v', name: 'GLM-4.6V', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: true, supportsFunctionCall: true, supportsThinking: true, thinkingConfig: { bodyParams: { thinking_mode: 'auto' } } },
    { id: 'glm-4.1v-thinking', name: 'GLM-4.1V Thinking', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: true, supportsFunctionCall: true, supportsThinking: true, thinkingConfig: { bodyParams: { thinking_mode: 'auto' } } },
    { id: 'glm-4-plus', name: 'GLM-4 Plus', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    { id: 'glm-4-air', name: 'GLM-4 Air', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    { id: 'glm-4-air-250414', name: 'GLM-4 Air 250414', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    { id: 'glm-4-airx', name: 'GLM-4 AirX', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    { id: 'glm-4-flashx', name: 'GLM-4 FlashX', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    { id: 'glm-4-flash', name: 'GLM-4 Flash', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    { id: 'glm-4-flash-250414', name: 'GLM-4 Flash 250414 (Free)', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    // GLM-Z1 series (reasoning models)
    { id: 'glm-z1-airx', name: 'GLM-Z1 AirX (极速版)', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    { id: 'glm-z1-air', name: 'GLM-Z1 Air (高性价比版)', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
    { id: 'glm-z1-flash', name: 'GLM-Z1 Flash (免费版)', icon: 'bigmodel', enabled: true, contextLength: 128_000, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true },
  ],
}
