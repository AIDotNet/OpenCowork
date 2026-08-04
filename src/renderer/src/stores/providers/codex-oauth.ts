import type { BuiltinProviderPreset } from './types'

export const codexOAuthPreset: BuiltinProviderPreset = {
  builtinId: 'codex-oauth',
  // v2: server-tool capability flags (supportsBuiltinSearch)
  version: 2,
  name: 'Codex (OAuth)',
  type: 'openai-responses',
  defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
  homepage: 'https://openai.com/codex',
  requiresApiKey: false,
  authMode: 'oauth',
  defaultModel: 'gpt-5.4-mini',
  useSystemProxy: true,
  oauthConfig: {
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    clientIdLocked: true,
    scope: 'openid profile email offline_access',
    useSystemProxy: true,
    includeScopeInTokenRequest: false,
    tokenRequestHeaders: {
      'User-Agent': 'OpenAI-CLI/1.0',
      Accept: 'application/json'
    },
    refreshRequestMode: 'json',
    refreshRequestHeaders: {
      'User-Agent': 'OpenAI-CLI/1.0'
    },
    refreshScope: 'openid profile email',
    redirectPath: '/auth/callback',
    redirectPort: 1455,
    extraParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true'
    },
    usePkce: true
  },
  ui: { hideOAuthSettings: true },
  userAgent: 'codex_cli_rs/0.144.5 (Windows 10.0.26200; x86_64) vscode/1.105.1',
  requestOverrides: {
    headers: {
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: '{{sessionId}}',
      conversation_id: '{{sessionId}}'
    },
    body: {
      store: false,
      instructions: ''
    },
    omitBodyKeys: ['temperature', 'max_output_tokens']
  },
  deprecatedModelIds: [
    'gpt-5-codex',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex-max',
    'gpt-5.2-codex',
    'gpt-5.3-codex'
  ],
  defaultModels: [
    {
      id: 'gpt-5.3-codex-spark',
      name: 'GPT 5.3 Codex Spark',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 128_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2.5,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 0.25,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.4-mini',
      name: 'GPT 5.4 Mini',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
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
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.4',
      name: 'GPT 5.4',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
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
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.5',
      name: 'GPT 5.5',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
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
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.6-luna',
      name: 'GPT 5.6 Luna',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
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
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.6-terra',
      name: 'GPT 5.6 Terra',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
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
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
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
      enableSystemPromptCache: true,
      type: 'openai-responses'
    }
  ]
}
