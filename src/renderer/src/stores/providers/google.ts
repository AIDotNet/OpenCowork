import type { BuiltinProviderPreset } from './types'

// Google's Interactions API (POST /v1beta/interactions) is the current surface for
// Gemini models and agents; generateContent is legacy. The model list below tracks the
// "supported models and agents" table in the Interactions docs.
export const googlePreset: BuiltinProviderPreset = {
  builtinId: 'google',
  version: 4,
  name: 'Google Gemini',
  type: 'gemini-interactions',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  homepage: 'https://ai.google.dev',
  apiKeyUrl: 'https://aistudio.google.com/apikey',
  // Model IDs absent from the Interactions "supported models and agents" table.
  deprecatedModelIds: [
    'gemini-2.0-flash',
    'gemini-3.6-flash',
    'gemini-2.5-flash-image',
    'gemini-3-pro-preview'
  ],
  defaultModels: [
    // Gemini 3.5 (stable)
    {
      id: 'gemini-3.5-flash',
      name: 'Gemini 3.5 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1,
      outputPrice: 4,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    // Gemini 3.1 (preview)
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
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'high' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'high'
      }
    },
    {
      id: 'gemini-3.1-flash-lite',
      name: 'Gemini 3.1 Flash-Lite',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.25,
      outputPrice: 1.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
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
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    // Gemini 2.5 (stable)
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
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 2.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'gemini-2.5-flash-lite',
      name: 'Gemini 2.5 Flash-Lite',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.1,
      outputPrice: 0.4,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    // Image generation. `type` pins the transport so these keep using Interactions
    // rather than falling back to the OpenAI Images route.
    {
      id: 'gemini-3.1-flash-image',
      name: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
      icon: 'gemini',
      enabled: true,
      category: 'image',
      type: 'gemini-interactions',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'gemini-3-pro-image',
      name: 'Nano Banana Pro (Gemini 3 Pro Image)',
      icon: 'gemini',
      enabled: true,
      category: 'image',
      type: 'gemini-interactions',
      supportsVision: true,
      supportsFunctionCall: false
    }
  ]
}
