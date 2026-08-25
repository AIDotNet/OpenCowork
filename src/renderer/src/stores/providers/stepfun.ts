import type { AIModelConfig, ThinkingConfig } from '../../lib/api/types'
import type { BuiltinProviderPreset } from './types'

/** Step 3.7 has no non-thinking mode; official effort is low / medium / high. */
const step37ThinkingConfig: ThinkingConfig = {
  bodyParams: {},
  reasoningEffortLevels: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium'
}

const step35ThinkingConfig: ThinkingConfig = {
  bodyParams: { enable_thinking: true },
  disabledBodyParams: { enable_thinking: false }
}

const stepfunModels: AIModelConfig[] = [
  {
    id: 'step-3.7-flash',
    name: 'Step 3.7 Flash',
    icon: 'stepfun',
    enabled: true,
    contextLength: 262_144,
    maxOutputTokens: 262_144,
    supportsVision: true,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: step37ThinkingConfig
  },
  {
    id: 'step-3.5-flash',
    name: 'Step 3.5 Flash',
    icon: 'stepfun',
    enabled: true,
    contextLength: 262_144,
    maxOutputTokens: 65_536,
    supportsVision: false,
    supportsFunctionCall: true,
    supportsThinking: true,
    thinkingConfig: step35ThinkingConfig
  }
]

export const stepfunPreset: BuiltinProviderPreset = {
  builtinId: 'stepfun',
  version: 1,
  name: '阶跃星辰',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.stepfun.com/v1',
  homepage: 'https://platform.stepfun.com',
  apiKeyUrl: 'https://platform.stepfun.com/interface-key',
  defaultModel: 'step-3.7-flash',
  defaultModels: stepfunModels
}

export const stepfunPlanPreset: BuiltinProviderPreset = {
  builtinId: 'stepfun-plan',
  version: 1,
  name: '阶跃星辰（套餐）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.stepfun.com/step_plan/v1',
  homepage: 'https://platform.stepfun.com',
  apiKeyUrl: 'https://platform.stepfun.com/interface-key',
  defaultEnabled: false,
  defaultModel: 'step-3.7-flash',
  defaultModels: [
    ...stepfunModels,
    {
      id: 'step-3.5-flash-2603',
      name: 'Step 3.5 Flash 2603',
      icon: 'stepfun',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 65_536,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: step35ThinkingConfig
    }
  ]
}
