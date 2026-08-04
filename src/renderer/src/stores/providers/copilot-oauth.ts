import type { BuiltinProviderPreset } from './types'

export const copilotOAuthPreset: BuiltinProviderPreset = {
  builtinId: 'copilot-oauth',
  version: 1,
  name: 'GitHub Copilot (OAuth)',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.githubcopilot.com',
  homepage: 'https://github.com/features/copilot',
  requiresApiKey: false,
  authMode: 'oauth',
  defaultModel: 'gpt-5-mini',
  useSystemProxy: true,
  userAgent: 'GitHubCopilotChat/0.26.7',
  oauthConfig: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenExchangeUrl: 'https://api.github.com/copilot_internal/v2/token',
    clientId: 'Iv1.b507a08c87ecfe98',
    clientIdLocked: true,
    scope: 'read:user copilot',
    flowType: 'device_code',
    host: 'https://github.com',
    apiHost: 'https://api.github.com',
    useSystemProxy: true,
    tokenRequestHeaders: {
      Accept: 'application/json'
    },
    refreshRequestHeaders: {
      Accept: 'application/json'
    },
    deviceCodeRequestHeaders: {
      Accept: 'application/json'
    },
    usePkce: false
  },
  requestOverrides: {
    headers: {
      'Copilot-Integration-Id': 'vscode-chat',
      'editor-version': 'vscode/1.105.0',
      'editor-plugin-version': 'copilot-chat/0.26.7'
    }
  },
  deprecatedModelIds: [
    'gpt-5-codex',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-4.1',
    'gpt-4o',
    'gpt-5',
    'gemini-2.5-flash'
  ],
  ui: { hideOAuthSettings: false },
  defaultModels: [
    {
      id: 'gpt-5-mini',
      name: 'GPT-5 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.25,
      outputPrice: 2,
      cacheCreationPrice: 0.25,
      cacheHitPrice: 0.025,
      premiumRequestMultiplier: 0,
      availablePlans: ['free', 'pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'gpt-5.3-codex',
      name: 'GPT-5.3 Codex',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
    {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 2.5,
      outputPrice: 15,
      cacheHitPrice: 0.25,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
    {
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4 Mini',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.75,
      outputPrice: 4.5,
      cacheHitPrice: 0.075,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
    {
      id: 'gpt-5.4-nano',
      name: 'GPT-5.4 Nano',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.2,
      outputPrice: 1.25,
      cacheHitPrice: 0.02,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 5,
      outputPrice: 30,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
    {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 400_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.2,
      outputPrice: 1.2,
      cacheCreationPrice: 0.25,
      cacheHitPrice: 0.02,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
    {
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 2,
      outputPrice: 12,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 0.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      icon: 'openai',
      enabled: true,
      type: 'openai-responses',
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 5,
      outputPrice: 30,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true
    },
    {
      id: 'claude-fable-5',
      name: 'Claude Fable 5',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 10,
      outputPrice: 50,
      cacheCreationPrice: 12.5,
      cacheHitPrice: 1,
      availablePlans: ['business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      premiumRequestMultiplier: 3,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-opus-4-7',
      name: 'Claude Opus 4.7',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      availablePlans: ['pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 0.2,
      premiumRequestMultiplier: 1,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      icon: 'claude',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      premiumRequestMultiplier: 1,
      availablePlans: ['pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'claude-sonnet-4-5-20250929',
      name: 'Claude Sonnet 4.5',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 3,
      outputPrice: 15,
      cacheCreationPrice: 3.75,
      cacheHitPrice: 0.3,
      premiumRequestMultiplier: 1,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 10000 } },
        forceTemperature: 1
      }
    },
    {
      id: 'claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 5,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.1,
      premiumRequestMultiplier: 0.25,
      availablePlans: ['free', 'pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled', budget_tokens: 8000 } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      icon: 'claude',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 5,
      outputPrice: 25,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      premiumRequestMultiplier: 3,
      availablePlans: ['pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'adaptive' } },
        forceTemperature: 1,
        reasoningEffortLevels: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 10,
      premiumRequestMultiplier: 1,
      availablePlans: ['pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' }
      }
    },
    {
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 12,
      cacheHitPrice: 0.2,
      availablePlans: ['pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' }
      }
    },
    {
      id: 'gemini-3-flash-preview',
      name: 'Gemini 3 Flash Preview',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.5,
      outputPrice: 3,
      cacheHitPrice: 0.05,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' }
      }
    },
    {
      id: 'gemini-3.5-flash',
      name: 'Gemini 3.5 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.5,
      outputPrice: 9,
      cacheHitPrice: 0.15,
      premiumRequestMultiplier: 0.25,
      availablePlans: ['pro', 'pro+', 'business', 'enterprise'],
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' }
      }
    },
    {
      id: 'mai-code-1-flash',
      name: 'MAI-Code-1-Flash',
      enabled: true,
      contextLength: 256_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.75,
      outputPrice: 4.5,
      cacheHitPrice: 0.075,
      availablePlans: ['free', 'pro', 'pro+', 'business', 'enterprise']
    },
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
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'raptor-mini',
      name: 'Raptor mini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.25,
      outputPrice: 2,
      cacheCreationPrice: 0.25,
      cacheHitPrice: 0.025
    }
  ]
}
