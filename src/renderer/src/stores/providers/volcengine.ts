import type { BuiltinProviderPreset } from './types'

export const volcenginePreset: BuiltinProviderPreset = {
  builtinId: 'volcengine',
  // v2: add the Seedance 2.0 video models (standard / fast / mini).
  version: 2,
  name: '火山引擎',
  type: 'openai-chat',
  defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  homepage: 'https://www.volcengine.com/product/doubao',
  apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  defaultEnabled: false,
  defaultModel: 'doubao-seed-2-1-pro-260628',
  defaultModels: [
    {
      id: 'doubao-seed-2-1-pro-260628',
      name: 'Doubao Seed 2.1 Pro (260628)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2-1-turbo-260628',
      name: 'Doubao Seed 2.1 Turbo (260628)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-evolving',
      name: 'Doubao Seed Evolving',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2-0-pro-260215',
      name: 'Doubao Seed 2.0 Pro (260215)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2-0-lite-260215',
      name: 'Doubao Seed 2.0 Lite (260215)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2-0-mini-260215',
      name: 'Doubao Seed 2.0 Mini (260215)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'doubao-seed-2.0-code',
      name: 'Doubao Seed 2.0 Code',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000
    },
    {
      id: 'doubao-seed-2-0-code-preview-260215',
      name: 'Doubao Seed 2.0 Code Preview (260215)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000
    },
    {
      id: 'doubao-seed-code-preview-latest',
      name: 'Doubao Seed Code Preview (Latest)',
      icon: 'doubao',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true,
      contextLength: 256_000
    },
    // ── Seedance 2.0（Ark 异步任务协议，顶层结构化参数）──
    {
      id: 'doubao-seedance-2-0-260128',
      name: 'Seedance 2.0',
      icon: 'doubao',
      enabled: true,
      category: 'video',
      type: 'seedance-video',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      id: 'doubao-seedance-2-0-fast-260128',
      name: 'Seedance 2.0 Fast',
      icon: 'doubao',
      enabled: true,
      category: 'video',
      type: 'seedance-video',
      supportsVision: true,
      supportsFunctionCall: false
    },
    {
      // mini 于 2026-06-16 上线，快照后缀与标准版/fast 的 260128 不同；分辨率上限 720p。
      id: 'doubao-seedance-2-0-mini-260615',
      name: 'Seedance 2.0 mini',
      icon: 'doubao',
      enabled: true,
      category: 'video',
      type: 'seedance-video',
      supportsVision: true,
      supportsFunctionCall: false
    }
  ]
}
