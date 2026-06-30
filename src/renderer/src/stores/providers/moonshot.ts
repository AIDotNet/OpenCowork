import type { BuiltinProviderPreset } from './types'

const KIMI_CLI_USER_AGENT = 'KimiCLI/1.30.0'
const KIMI_OAUTH_HOST = 'https://auth.kimi.com'
const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'

// Price fields below are USD per 1M tokens; Kimi publishes CNY prices, so values are converted.
export const moonshotCodingPreset: BuiltinProviderPreset = {
  builtinId: 'moonshot-coding',
  name: 'Moonshot（套餐）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.kimi.com/coding/v1',
  homepage: 'https://www.kimi.com',
  apiKeyUrl: 'https://www.kimi.com/code/console?from=membership',
  defaultEnabled: false,
  requiresApiKey: false,
  authMode: 'oauth',
  userAgent: KIMI_CLI_USER_AGENT,
  oauthConfig: {
    authorizeUrl: '',
    tokenUrl: `${KIMI_OAUTH_HOST}/api/oauth/token`,
    deviceCodeUrl: `${KIMI_OAUTH_HOST}/api/oauth/device_authorization`,
    clientId: KIMI_CLIENT_ID,
    clientIdLocked: true,
    flowType: 'device_code',
    tokenRequestHeaders: {
      Accept: 'application/json',
      'User-Agent': KIMI_CLI_USER_AGENT
    },
    refreshRequestHeaders: {
      Accept: 'application/json',
      'User-Agent': KIMI_CLI_USER_AGENT
    },
    deviceCodeRequestHeaders: {
      Accept: 'application/json',
      'User-Agent': KIMI_CLI_USER_AGENT
    },
    usePkce: false
  },
  ui: { hideOAuthSettings: true },
  defaultModels: [
    {
      id: 'kimi-for-coding',
      name: 'Kimi For Coding (K2.7 Code)',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.95,
      outputPrice: 4,
      cacheHitPrice: 0.19,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        forceTemperature: 1
      }
    }
  ]
}

export const moonshotPreset: BuiltinProviderPreset = {
  builtinId: 'moonshot',
  name: 'Moonshot（官方）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.moonshot.cn/v1',
  homepage: 'https://platform.moonshot.cn',
  apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  defaultModel: 'kimi-k2.7-code',
  deprecatedModelIds: [
    'kimi-k2-0905-preview',
    'kimi-k2-0711-preview',
    'kimi-k2-turbo-preview',
    'kimi-k2-thinking',
    'kimi-k2-thinking-turbo',
    'kimi-latest',
    'kimi-thinking-preview'
  ],
  defaultModels: [
    {
      id: 'kimi-k2.7-code',
      name: 'Kimi K2.7 Code',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.95,
      outputPrice: 4,
      cacheHitPrice: 0.19,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'kimi-k2.7-code-highspeed',
      name: 'Kimi K2.7 Code HighSpeed',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.9,
      outputPrice: 8,
      cacheHitPrice: 0.38,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        forceTemperature: 1
      }
    },
    // Kimi K2.6
    {
      id: 'kimi-k2.6',
      name: 'Kimi K2.6',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.95,
      outputPrice: 4,
      cacheHitPrice: 0.16,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    // Kimi K2.5
    {
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.56,
      outputPrice: 3,
      cacheHitPrice: 0.1,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    // Moonshot V1 series (cache: 75% off input)
    {
      id: 'moonshot-v1-auto',
      name: 'Moonshot v1 Auto',
      icon: 'moonshot',
      enabled: true,
      maxOutputTokens: 4_096,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.6,
      outputPrice: 2.5,
      cacheHitPrice: 0.15
    },
    {
      id: 'moonshot-v1-8k',
      name: 'Moonshot v1 8K',
      icon: 'moonshot',
      enabled: true,
      contextLength: 8_192,
      maxOutputTokens: 4_096,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.28,
      outputPrice: 1.4,
      cacheHitPrice: 0.07
    },
    {
      id: 'moonshot-v1-32k',
      name: 'Moonshot v1 32K',
      icon: 'moonshot',
      enabled: true,
      contextLength: 32_768,
      maxOutputTokens: 4_096,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.7,
      outputPrice: 2.8,
      cacheHitPrice: 0.18
    },
    {
      id: 'moonshot-v1-128k',
      name: 'Moonshot v1 128K',
      icon: 'moonshot',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 4_096,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.4,
      outputPrice: 4.2,
      cacheHitPrice: 0.35
    },
    {
      id: 'moonshot-v1-8k-vision-preview',
      name: 'Moonshot v1 8K Vision Preview',
      icon: 'moonshot',
      enabled: true,
      contextLength: 8_192,
      maxOutputTokens: 4_096,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.28,
      outputPrice: 1.4,
      cacheHitPrice: 0.07
    },
    {
      id: 'moonshot-v1-32k-vision-preview',
      name: 'Moonshot v1 32K Vision Preview',
      icon: 'moonshot',
      enabled: true,
      contextLength: 32_768,
      maxOutputTokens: 4_096,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.7,
      outputPrice: 2.8,
      cacheHitPrice: 0.18
    },
    {
      id: 'moonshot-v1-128k-vision-preview',
      name: 'Moonshot v1 128K Vision Preview',
      icon: 'moonshot',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 4_096,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.4,
      outputPrice: 4.2,
      cacheHitPrice: 0.35
    }
  ]
}
