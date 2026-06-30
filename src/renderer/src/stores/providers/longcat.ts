import type { BuiltinProviderPreset } from './types'

const deprecatedLongCatModelIds = [
  'LongCat-Flash-Chat',
  'LongCat-Flash-Thinking',
  'LongCat-Flash-Thinking-2601',
  'LongCat-Flash-Lite',
  'LongCat-Flash-Omni-2603',
  'LongCat-Flash-Chat-2602-Exp'
]

export const longcatPreset: BuiltinProviderPreset = {
  builtinId: 'longcat',
  name: 'LongCat',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.longcat.chat/openai/v1',
  homepage: 'https://longcat.chat/platform',
  defaultEnabled: false,
  defaultModel: 'LongCat-2.0',
  deprecatedModelIds: deprecatedLongCatModelIds,
  defaultModels: [
    {
      id: 'LongCat-2.0',
      name: 'LongCat-2.0',
      icon: 'longcat',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 8,
      cacheHitPrice: 0.04,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    }
  ]
}
