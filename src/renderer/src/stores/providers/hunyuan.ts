import type { ThinkingConfig } from '../../lib/api/types'
import type { BuiltinProviderPreset } from './types'

/** Hy3: no_think / think_low / think_high. Off maps to official `no_think`. */
const hy3ThinkingConfig: ThinkingConfig = {
  bodyParams: {},
  disabledBodyParams: { reasoning_effort: 'no_think' },
  reasoningEffortLevels: ['low', 'high'],
  defaultReasoningEffort: 'low',
  forceTemperature: 0.9
}

export const hunyuanPreset: BuiltinProviderPreset = {
  builtinId: 'hunyuan',
  version: 1,
  name: '腾讯混元',
  type: 'openai-chat',
  defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
  homepage: 'https://cloud.tencent.com/product/tclm',
  apiKeyUrl: 'https://console.cloud.tencent.com/lkeap',
  defaultModel: 'hy3',
  defaultModels: [
    {
      id: 'hy3',
      name: 'Hy3',
      icon: 'hunyuan',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: hy3ThinkingConfig
    },
    {
      id: 'hy3-preview',
      name: 'Hy3 Preview',
      icon: 'hunyuan',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 128_000,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: hy3ThinkingConfig
    }
  ]
}
