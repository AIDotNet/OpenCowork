import type { ThinkingConfig } from '../../lib/api/types'
import type { BuiltinProviderPreset } from './types'

/** Qwen3.8：混合思考，默认开；reasoning_effort 为 low/medium/xhigh（默认 xhigh）。 */
const qwen38ThinkingConfig: ThinkingConfig = {
  bodyParams: { enable_thinking: true },
  disabledBodyParams: { enable_thinking: false },
  reasoningEffortLevels: ['low', 'medium', 'xhigh'],
  defaultReasoningEffort: 'xhigh'
}

export const qwenCodingPreset: BuiltinProviderPreset = {
  builtinId: 'qwen-coding',
  version: 1,
  name: '通义千问（套餐）',
  type: 'anthropic',
  defaultBaseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
  homepage: 'https://dashscope.aliyun.com',
  apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
  defaultEnabled: false,
  userAgent: 'claude-cli/2.1.71 (external, cli)',
  defaultModels: [
    // Coding Plan models (official: Coding Plan 概述 / 套餐详情)
    {
      id: 'qwen3.5-plus',
      name: 'Qwen3.5 Plus',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } }
      }
    },
    {
      id: 'qwen3-coder-next',
      name: 'Qwen3 Coder Next',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.22,
      outputPrice: 1.0,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'qwen3-coder-plus',
      name: 'Qwen3 Coder Plus',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.22,
      outputPrice: 1.0,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { enable_thinking: true },
        disabledBodyParams: { enable_thinking: false }
      }
    },
    {
      id: 'qwen3-max-2026-01-23',
      name: 'Qwen3 Max 2026-01-23',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.2,
      outputPrice: 6,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    {
      id: 'kimi-k2.6',
      name: 'Kimi K2.6',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.15,
      outputPrice: 0.9,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.23,
      outputPrice: 3,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'kimi-k2-thinking',
      name: 'Kimi K2 Thinking',
      icon: 'kimi',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.47,
      outputPrice: 2,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      }
    },
    {
      id: 'glm-5',
      name: 'GLM 5',
      icon: 'chatglm',
      enabled: true,
      contextLength: 202_752,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.14,
      outputPrice: 0.56
    },
    {
      id: 'glm-4.7',
      name: 'GLM 4.7',
      icon: 'chatglm',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.38,
      outputPrice: 1.7
    },
    {
      id: 'MiniMax-M2.5',
      name: 'MiniMax M2.5',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsVision: false,
      supportsFunctionCall: true,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: { thinking: { type: 'enabled' } },
        disabledBodyParams: { thinking: { type: 'disabled' } },
        forceTemperature: 1
      },
      inputPrice: 0.3,
      outputPrice: 1.1
    }
  ]
}

export const qwenPreset: BuiltinProviderPreset = {
  builtinId: 'qwen',
  // v2: add Qwen3.8 Flash (1M context, hybrid thinking, multimodal).
  // v3: add Qwen3.8 Max and Qwen3.8 27B.
  version: 3,
  name: '通义千问（官方）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  homepage: 'https://dashscope.aliyun.com',
  apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
  defaultModels: [
    // Qwen3.8 series
    {
      id: 'qwen3.8-max',
      name: 'Qwen3.8 Max',
      icon: 'qwen',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 6,
      cacheHitPrice: 0.25,
      cacheCreationPrice: 2.5,
      supportsThinking: true,
      thinkingConfig: qwen38ThinkingConfig
    },
    {
      id: 'qwen3.8-flash',
      name: 'Qwen3.8 Flash',
      icon: 'qwen',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.16,
      outputPrice: 0.47,
      cacheHitPrice: 0.02,
      supportsThinking: true,
      thinkingConfig: qwen38ThinkingConfig
    },
    {
      id: 'qwen3.8-27b',
      name: 'Qwen3.8 27B',
      icon: 'qwen',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.4,
      outputPrice: 3,
      cacheHitPrice: 0.05,
      supportsThinking: true,
      thinkingConfig: qwen38ThinkingConfig
    },
    // Qwen3.7 series (2026-05 flagship refresh)
    {
      id: 'qwen3.7-max',
      name: 'Qwen3.7 Max',
      icon: 'qwen',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.25,
      outputPrice: 3.75,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    {
      id: 'qwen3.7-plus',
      name: 'Qwen3.7 Plus',
      icon: 'qwen',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.32,
      outputPrice: 1.28,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    // Qwen3 series (tiered pricing, base tier ≤32K/≤256K shown)
    {
      id: 'qwen3-max',
      name: 'Qwen3 Max',
      icon: 'qwen',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.2,
      outputPrice: 6,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    {
      id: 'qwen-plus',
      name: 'Qwen Plus (Qwen3)',
      icon: 'qwen',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.4,
      outputPrice: 1.2,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    },
    // Legacy Qwen models
    {
      id: 'qwen-max',
      name: 'Qwen Max',
      icon: 'qwen',
      enabled: true,
      contextLength: 32_768,
      maxOutputTokens: 8_192,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 1.6,
      outputPrice: 6.4
    },
    // Qwen-Flash (low-cost tier; free trial ended 2026-04-15)
    {
      id: 'qwen-flash',
      name: 'Qwen Flash',
      icon: 'qwen',
      enabled: true,
      contextLength: 1_000_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true,
      inputPrice: 0.05,
      outputPrice: 0.4,
      supportsThinking: true,
      thinkingConfig: { bodyParams: { enable_thinking: true } }
    }
  ]
}
