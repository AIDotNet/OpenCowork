import type { ThinkingConfig } from '../../lib/api/types'
import type { BuiltinProviderPreset } from './types'

/** Muse Spark always thinks. Official accepts thinking.type=adaptive + output effort. */
const museThinkingConfig: ThinkingConfig = {
  bodyParams: { thinking: { type: 'adaptive' } },
  forceTemperature: 1,
  reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh'],
  defaultReasoningEffort: 'medium'
}

export const metaPreset: BuiltinProviderPreset = {
  builtinId: 'meta',
  version: 1,
  name: 'Meta',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.meta.ai/v1',
  homepage: 'https://llama.developer.meta.com/docs',
  apiKeyUrl: 'https://dev.meta.ai',
  defaultModel: 'muse-spark-1.2',
  defaultModels: [
    {
      id: 'muse-spark-1.2',
      name: 'Muse Spark 1.2',
      icon: 'meta',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 131_072,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 4.25,
      cacheHitPrice: 0.15,
      supportsThinking: true,
      thinkingConfig: museThinkingConfig
    },
    {
      id: 'muse-spark-1.1',
      name: 'Muse Spark 1.1',
      icon: 'meta',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 131_072,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 4.25,
      supportsThinking: true,
      thinkingConfig: museThinkingConfig
    },
    {
      id: 'muse-spark-1.2-contributor',
      name: 'Muse Spark 1.2 Contributor',
      icon: 'meta',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 131_072,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: museThinkingConfig
    }
  ]
}
