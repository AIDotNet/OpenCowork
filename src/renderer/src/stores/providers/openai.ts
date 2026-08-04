import type { BuiltinProviderPreset } from './types'

export const openaiPreset: BuiltinProviderPreset = {
  builtinId: 'openai',
  // v2: server-tool capability flags (supportsBuiltinSearch/supportsImageGeneration)
  version: 2,
  name: 'OpenAI',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.openai.com/v1',
  homepage: 'https://openai.com',
  apiKeyUrl: 'https://platform.openai.com/api-keys',
  deprecatedModelIds: [
    'gpt-5-codex',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.2-codex',
    'dall-e-2',
    'dall-e-3'
  ],
  defaultModels: [
    // GPT-5 family (cache: 90% off input)
    {
      id: 'gpt-5.2',
      name: 'GPT-5.2',
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
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1',
      name: 'GPT-5.1',
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
        reasoningEffortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5',
      name: 'GPT-5',
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
      type: 'openai-responses'
    },
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
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      enablePromptCache: true
    },
    {
      id: 'gpt-5-nano',
      name: 'GPT-5 Nano',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.05,
      outputPrice: 0.4,
      cacheCreationPrice: 0.05,
      cacheHitPrice: 0.005,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      enablePromptCache: true
    },
    // GPT-5 chat variants (Responses API)
    {
      id: 'gpt-5-chat',
      name: 'GPT-5 Chat',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
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
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.1-chat',
      name: 'GPT-5.1 Chat',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    {
      id: 'gpt-5.2-chat',
      name: 'GPT-5.2 Chat',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 1.75,
      outputPrice: 14,
      cacheCreationPrice: 1.75,
      cacheHitPrice: 0.175,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      },
      type: 'openai-responses'
    },
    // GPT-5 codex family (Responses API)
    {
      id: 'gpt-5.3-codex',
      name: 'GPT-5.3 Codex',
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
      name: 'GPT-5.3 Codex Spark',
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
      supportsFunctionCall: false,
      inputPrice: 2.5,
      outputPrice: 15,
      cacheHitPrice: 0.25,
      supportsThinking: true,
      supportsComputerUse: true,
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
      id: 'gpt-5.4-nano',
      name: 'GPT 5.4 Nano',
      icon: 'openai',
      enabled: true,
      serviceTier: 'priority',
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
      supportsFunctionCall: false,
      inputPrice: 5,
      outputPrice: 30,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      supportsComputerUse: true,
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
      // Synced with Codex's model catalog: 400K total window − 128K reserved output.
      contextLength: 372_000,
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
      // Synced with Codex's model catalog: 400K total window − 128K reserved output.
      contextLength: 372_000,
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
        // 'ultra' selects the Responses API "pro" reasoning mode (max reasoning +
        // automatic subagent task delegation); Terra and Sol expose it.
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
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
      // Synced with Codex's model catalog: 400K total window − 128K reserved output.
      contextLength: 372_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 5,
      outputPrice: 30,
      cacheCreationPrice: 6.25,
      cacheHitPrice: 0.5,
      supportsThinking: true,
      supportsComputerUse: true,
      thinkingConfig: {
        bodyParams: {},
        // 'ultra' selects the Responses API "pro" reasoning mode (max reasoning +
        // automatic subagent task delegation); Terra and Sol expose it.
        reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'medium'
      },
      responseSummary: 'detailed',
      enablePromptCache: true,
      enableSystemPromptCache: true,
      type: 'openai-responses'
    },
    // GPT-5 pro models
    {
      id: 'gpt-5-pro',
      name: 'GPT-5 Pro',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 272_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 15,
      outputPrice: 120,
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
      id: 'gpt-5.2-pro',
      name: 'GPT-5.2 Pro',
      icon: 'openai',
      enabled: true,
      contextLength: 400_000,
      maxOutputTokens: 272_000,
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 21,
      outputPrice: 168,
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
    // O-series reasoning (cache: 50% off input)
    {
      id: 'o3',
      name: 'o3',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 8,
      cacheCreationPrice: 2,
      cacheHitPrice: 1,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      enablePromptCache: true
    },
    {
      id: 'o4-mini',
      name: 'o4 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.1,
      outputPrice: 4.4,
      cacheCreationPrice: 1.1,
      cacheHitPrice: 0.55,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      enablePromptCache: true
    },
    {
      id: 'o3-mini',
      name: 'o3 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 200_000,
      maxOutputTokens: 100_000,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.1,
      outputPrice: 4.4,
      cacheCreationPrice: 1.1,
      cacheHitPrice: 0.55,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { reasoning_effort: 'medium' },
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      },
      enablePromptCache: true
    },
    // GPT-4.1 family (cache: 75% off input)
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 8,
      cacheCreationPrice: 2,
      cacheHitPrice: 0.5,
      enablePromptCache: true
    },
    {
      id: 'gpt-4.1-mini',
      name: 'GPT-4.1 Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.4,
      outputPrice: 1.6,
      cacheCreationPrice: 0.4,
      cacheHitPrice: 0.1,
      enablePromptCache: true
    },
    {
      id: 'gpt-4.1-nano',
      name: 'GPT-4.1 Nano',
      icon: 'openai',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.1,
      outputPrice: 0.4,
      cacheCreationPrice: 0.1,
      cacheHitPrice: 0.025,
      enablePromptCache: true
    },
    // GPT-4o family (cache: 50% off input)
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2.5,
      outputPrice: 10,
      cacheCreationPrice: 2.5,
      cacheHitPrice: 1.25,
      enablePromptCache: true
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      icon: 'openai',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.15,
      outputPrice: 0.6,
      cacheCreationPrice: 0.15,
      cacheHitPrice: 0.075,
      enablePromptCache: true
    },
    // Speech & transcription
    {
      id: 'gpt-4o-transcribe',
      name: 'GPT-4o Transcribe',
      icon: 'openai',
      enabled: true,
      category: 'speech'
    },
    {
      id: 'gpt-4o-mini-transcribe',
      name: 'GPT-4o Mini Transcribe',
      icon: 'openai',
      enabled: true,
      category: 'speech'
    },
    // Image generation models
    {
      id: 'gpt-image-2',
      name: 'GPT-Image 2',
      icon: 'openai',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.05,
      outputPrice: 0.21
    },
    {
      id: 'gpt-image-1',
      name: 'GPT-Image 1',
      icon: 'openai',
      enabled: true,
      category: 'image',
      type: 'openai-images',
      supportsVision: true,
      supportsFunctionCall: false,
      inputPrice: 0.04,
      outputPrice: 0.08
    }
  ]
}
