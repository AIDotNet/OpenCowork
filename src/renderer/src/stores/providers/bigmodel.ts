import type { ThinkingConfig } from '../../lib/api/types'
import type { BuiltinProviderPreset } from './types'

const glmThinkingConfig = (): ThinkingConfig => ({
  bodyParams: { thinking: { type: 'enabled' } },
  disabledBodyParams: { thinking: { type: 'disabled' } }
})

export const bigmodelCodingPreset: BuiltinProviderPreset = {
  builtinId: 'bigmodel-coding',
  name: '智谱AI（套餐）',
  type: 'anthropic',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  homepage: 'https://bigmodel.cn/glm-coding',
  apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
  defaultEnabled: false,
  defaultModel: 'glm-4.7',
  defaultModels: [
    {
      id: 'glm-5.1',
      name: 'GLM-5.1',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-5-turbo',
      name: 'GLM-5-Turbo',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.7',
      name: 'GLM-4.7',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.5-air',
      name: 'GLM-4.5 Air',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 96_000,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    }
  ]
}

export const bigmodelPreset: BuiltinProviderPreset = {
  builtinId: 'bigmodel',
  name: '智谱AI（官方）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  homepage: 'https://bigmodel.cn',
  apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
  defaultModel: 'glm-5.1',
  defaultModels: [
    // GLM-5 series
    {
      id: 'glm-5.1',
      name: 'GLM-5.1',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig(),
      inputPrice: 1.395,
      outputPrice: 4.4,
      cacheHitPrice: 0.3
    },
    {
      id: 'glm-5.2',
      name: 'GLM-5.2',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-5',
      name: 'GLM-5',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-5-turbo',
      name: 'GLM-5-Turbo',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-5v-turbo',
      name: 'GLM-5V-Turbo',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    // GLM-4.7 series
    {
      id: 'glm-4.7',
      name: 'GLM-4.7',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.7-flashx',
      name: 'GLM-4.7 FlashX',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.7-flash',
      name: 'GLM-4.7 Flash (Free)',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    // GLM-4.6 series
    {
      id: 'glm-4.6',
      name: 'GLM-4.6',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.6v',
      name: 'GLM-4.6V',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 32_000,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.6v-flash',
      name: 'GLM-4.6V Flash (Free)',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 32_000,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    // GLM-4.5 series
    {
      id: 'glm-4.5',
      name: 'GLM-4.5',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 96_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.5-air',
      name: 'GLM-4.5 Air',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 96_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.5-airx',
      name: 'GLM-4.5 AirX',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 96_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    {
      id: 'glm-4.5v',
      name: 'GLM-4.5V',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 32_000,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig()
    },
    // GLM-4.1V series
    {
      id: 'glm-4.1v-thinking-flashx',
      name: 'GLM-4.1V Thinking FlashX',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 64_000,
      maxOutputTokens: 16_000,
      supportsVision: true,
      supportsFunctionCall: false,
      supportsThinking: true
    },
    {
      id: 'glm-4.1v-thinking-flash',
      name: 'GLM-4.1V Thinking Flash (Free)',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 64_000,
      maxOutputTokens: 16_000,
      supportsVision: true,
      supportsFunctionCall: false,
      supportsThinking: true
    },
    {
      id: 'glm-4.1v-thinking',
      name: 'GLM-4.1V Thinking',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 64_000,
      maxOutputTokens: 16_000,
      supportsVision: true,
      supportsFunctionCall: false,
      supportsThinking: true
    },
    // GLM-4 legacy models
    {
      id: 'glm-4-long',
      name: 'GLM-4 Long',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 4_000,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-4-plus',
      name: 'GLM-4 Plus',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-4-air',
      name: 'GLM-4 Air',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-4-air-250414',
      name: 'GLM-4 Air 250414',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-4-airx',
      name: 'GLM-4 AirX',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-4-flashx',
      name: 'GLM-4 FlashX',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-4-flash',
      name: 'GLM-4 Flash',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-4-flash-250414',
      name: 'GLM-4 Flash 250414 (Free)',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_000,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-4v-flash',
      name: 'GLM-4V Flash (Free)',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 16_000,
      maxOutputTokens: 1_000,
      supportsVision: true,
      supportsFunctionCall: false
    },
    // GLM-Z1 series (deprecated by BigModel on 2025-11-15, kept for existing users)
    {
      id: 'glm-z1-airx',
      name: 'GLM-Z1 AirX (极速版)',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-z1-air',
      name: 'GLM-Z1 Air (高性价比版)',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'glm-z1-flash',
      name: 'GLM-Z1 Flash (免费版)',
      icon: 'bigmodel',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true
    }
  ]
}
