import type { BuiltinProviderPreset } from './types'

export const codexOAuthPreset: BuiltinProviderPreset = {
  builtinId: 'codex-oauth',
  name: 'Codex (OAuth)',
  type: 'openai-responses',
  defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
  homepage: 'https://openai.com/codex',
  requiresApiKey: false,
  authMode: 'oauth',
  defaultModel: 'gpt-5.1-codex',
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
  userAgent: 'codex_cli_rs/0.76.0 (Windows 10.0.26200; x86_64) vscode/1.105.1',
  requestOverrides: {
    headers: {
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: '{{sessionId}}',
      conversation_id: '{{sessionId}}'
    },
    body: {
      store: false
    },
    omitBodyKeys: ['temperature', 'max_output_tokens', 'service_tier']
  },
  instructionsPrompt: 'codex-instructions',
  defaultModels: [
    {
      id: 'gpt-5-codex',
      name: 'GPT 5 Codex',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-codex',
      name: 'GPT 5.1 Codex',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-codex-max',
      name: 'GPT 5.1 Codex Max',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.25,
      outputPrice: 10,
      cacheCreationPrice: 1.25,
      cacheHitPrice: 0.125,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-codex-mini',
      name: 'GPT 5.1 Codex Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.25,
      outputPrice: 2,
      cacheCreationPrice: 0.25,
      cacheHitPrice: 0.025,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.2-codex',
      name: 'GPT 5.2 Codex',
      icon: 'openai',
      enabled: true,
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
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.3-codex',
      name: 'GPT 5.3 Codex',
      icon: 'openai',
      enabled: true,
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
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.3-codex-spark',
      name: 'GPT 5.3 Codex Spark',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 64_384,
      supportsVision: true,
      supportsFunctionCall: false,
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
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    }
  ]
}
