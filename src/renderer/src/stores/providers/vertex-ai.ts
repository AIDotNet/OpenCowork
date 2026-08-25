import type { BuiltinProviderPreset } from './types'

export const vertexAiPreset: BuiltinProviderPreset = {
  builtinId: 'vertex-ai',
  version: 1,
  name: 'Google Vertex AI',
  type: 'vertex-ai',
  // Replace YOUR_PROJECT with the GCP project id. Region can be changed in place.
  defaultBaseUrl: 'https://aiplatform.googleapis.com/v1/projects/YOUR_PROJECT/locations/us-central1',
  homepage: 'https://cloud.google.com/vertex-ai',
  apiKeyUrl: 'https://console.cloud.google.com/apis/credentials',
  defaultModel: 'gemini-3.7-flash',
  defaultModels: [
    {
      id: 'gemini-3.7-flash',
      name: 'Gemini 3.7 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.5,
      outputPrice: 3.75,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'gemini-3.6-flash',
      name: 'Gemini 3.6 Flash',
      icon: 'gemini',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.5,
      outputPrice: 7.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
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
      inputPrice: 1,
      outputPrice: 4,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'medium' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
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
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking_level: 'high' },
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
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
    }
  ]
}
