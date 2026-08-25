import type { ThinkingConfig } from '../../lib/api/types'
import type { BuiltinProviderPreset } from './types'

const deepseekV4ThinkingConfig: ThinkingConfig = {
  bodyParams: { thinking: { type: 'enabled' } },
  disabledBodyParams: { thinking: { type: 'disabled' } },
  reasoningEffortLevels: ['low', 'high', 'max'],
  defaultReasoningEffort: 'high'
}

const glmThinkingConfig: ThinkingConfig = {
  bodyParams: { thinking: { type: 'enabled' } },
  disabledBodyParams: { thinking: { type: 'disabled' } }
}

const glm53ThinkingConfig: ThinkingConfig = {
  bodyParams: { thinking: { type: 'enabled' } },
  reasoningEffortLevels: ['low', 'high', 'max'],
  defaultReasoningEffort: 'max'
}

const kimiThinkingConfig: ThinkingConfig = {
  bodyParams: { thinking: { type: 'enabled' } },
  disabledBodyParams: { thinking: { type: 'disabled' } },
  forceTemperature: 1
}

const deprecatedBaiduCodingModelIds = [
  'deepseek-v3.2',
  'glm-4.7',
  'kimi-k2.5',
  'MiniMax-M2.1',
  'MiniMax-M2.5',
  'MiniMax-M2.7'
]

const deprecatedBaiduModelIds = [
  'deepseek-v3.2',
  'glm-4.7',
  'kimi-k2.5',
  'MiniMax-M2.1',
  'MiniMax-M2.5',
  'MiniMax-M2.7'
]

export const baiduCodingPreset: BuiltinProviderPreset = {
  builtinId: 'baidu-coding',
  // v2: Coding Plan → Token Plan; models from cloud.baidu.com/doc/qianfan/s/Dmrabu8b6 + enterprise catalog
  version: 2,
  name: '百度智能云（套餐）',
  type: 'anthropic',
  defaultBaseUrl: 'https://qianfan.baidubce.com/anthropic/tokenplan/personal',
  homepage: 'https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6',
  apiKeyUrl: 'https://console.bce.baidu.com/qianfan/resource/subscribe',
  defaultEnabled: false,
  defaultModel: 'deepseek-v4-flash',
  deprecatedModelIds: deprecatedBaiduCodingModelIds,
  defaultModels: [
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 393_216,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: deepseekV4ThinkingConfig
    },
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 393_216,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: deepseekV4ThinkingConfig
    },
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glm53ThinkingConfig
    },
    {
      id: 'glm-5.2',
      name: 'GLM-5.2',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig
    },
    {
      id: 'glm-5.1',
      name: 'GLM-5.1',
      icon: 'chatglm',
      enabled: true,
      contextLength: 202_752,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig
    },
    {
      id: 'glm-5',
      name: 'GLM 5',
      icon: 'chatglm',
      enabled: true,
      contextLength: 202_752,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig
    },
    {
      id: 'kimi-k2.6',
      name: 'Kimi K2.6',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 262_144,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: kimiThinkingConfig
    }
  ]
}

export const baiduPreset: BuiltinProviderPreset = {
  builtinId: 'baidu',
  // v2: sync Qianfan catalog (2026-08-20): ERNIE 5.x, DeepSeek V4, GLM-5.3
  version: 2,
  name: '百度智能云（官方）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
  homepage: 'https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j',
  apiKeyUrl: 'https://cloud.baidu.com/doc/qianfan/s/wmh8l6tnf',
  defaultModel: 'ernie-5.1',
  deprecatedModelIds: deprecatedBaiduModelIds,
  defaultModels: [
    {
      id: 'ernie-5.1',
      name: 'ERNIE 5.1',
      icon: 'ernie',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 65_536,
      supportsFunctionCall: true
    },
    {
      id: 'ernie-5.0',
      name: 'ERNIE 5.0',
      icon: 'ernie',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'ernie-4.5-turbo-128k',
      name: 'ERNIE 4.5 Turbo 128K',
      icon: 'ernie',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 12_288,
      supportsFunctionCall: true
    },
    {
      id: 'ernie-x1.1',
      name: 'ERNIE X1.1',
      icon: 'ernie',
      enabled: true,
      contextLength: 65_536,
      maxOutputTokens: 65_536,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 393_216,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: deepseekV4ThinkingConfig
    },
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 393_216,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: deepseekV4ThinkingConfig
    },
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glm53ThinkingConfig
    },
    {
      id: 'glm-5.2',
      name: 'GLM-5.2',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig
    },
    {
      id: 'glm-5.1',
      name: 'GLM-5.1',
      icon: 'chatglm',
      enabled: true,
      contextLength: 202_752,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: glmThinkingConfig
    },
    {
      id: 'kimi-k2.6',
      name: 'Kimi K2.6',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 262_144,
      supportsVision: true,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: kimiThinkingConfig
    }
  ]
}
