import type { BuiltinProviderPreset } from './types'

export const qwenCodingPreset: BuiltinProviderPreset = {
  builtinId: 'qwen-coding',
  name: '通义千问（套餐）',
  type: 'anthropic',
  defaultBaseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
  homepage: 'https://dashscope.aliyun.com',
  apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
  defaultEnabled: true,
  defaultModels: [
    // Coding Plan models (official: Coding Plan 概述 / 套餐详情)
    { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', icon: 'qwen', enabled: true, supportsFunctionCall: true },
    { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', icon: 'qwen', enabled: true, supportsFunctionCall: true },
    { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', icon: 'qwen', enabled: true, supportsFunctionCall: true },
    { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max 2026-01-23', icon: 'qwen', enabled: true, supportsFunctionCall: true },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', icon: 'kimi', enabled: true, supportsFunctionCall: true },
    { id: 'glm-5', name: 'GLM 5', icon: 'chatglm', enabled: true, supportsFunctionCall: true },
    { id: 'glm-4.7', name: 'GLM 4.7', icon: 'chatglm', enabled: true, supportsFunctionCall: true },
    { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', icon: 'minimax', enabled: true, supportsFunctionCall: true },
  ],
}

export const qwenPreset: BuiltinProviderPreset = {
  builtinId: 'qwen',
  name: '通义千问（官方）',
  type: 'openai-chat',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  homepage: 'https://dashscope.aliyun.com',
  apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
  defaultModels: [
    // Qwen3 series (tiered pricing, base tier ≤32K/≤256K shown)
    { id: 'qwen3-max', name: 'Qwen3 Max', icon: 'qwen', enabled: true, contextLength: 262_144, maxOutputTokens: 32_768, supportsVision: false, supportsFunctionCall: true, inputPrice: 1.2, outputPrice: 6, supportsThinking: true, thinkingConfig: { bodyParams: { enable_thinking: true } } },
    { id: 'qwen-plus', name: 'Qwen Plus (Qwen3)', icon: 'qwen', enabled: true, contextLength: 1_000_000, maxOutputTokens: 32_768, supportsVision: false, supportsFunctionCall: true, inputPrice: 0.4, outputPrice: 1.2, supportsThinking: true, thinkingConfig: { bodyParams: { enable_thinking: true } } },
    // Legacy Qwen models
    { id: 'qwen-max', name: 'Qwen Max', icon: 'qwen', enabled: true, contextLength: 32_768, maxOutputTokens: 8_192, supportsVision: false, supportsFunctionCall: true, inputPrice: 1.6, outputPrice: 6.4 },
    // Qwen-Flash (free tier available)
    { id: 'qwen-flash', name: 'Qwen Flash', icon: 'qwen', enabled: true, contextLength: 1_000_000, maxOutputTokens: 32_768, supportsVision: false, supportsFunctionCall: true, inputPrice: 0, outputPrice: 0, supportsThinking: true, thinkingConfig: { bodyParams: { enable_thinking: true } } },
  ],
}
