import type { PluginProviderDescriptor } from './plugin-types'

/** Optional WS relay URL — only for platforms without native WS support */
const wsRelayField = {
  key: 'wsUrl',
  label: 'plugin.wsUrl',
  type: 'text' as const,
  required: false,
  placeholder: 'wss://your-relay-server/ws',
}

/** Built-in plugin provider descriptors */
export const PLUGIN_PROVIDERS: PluginProviderDescriptor[] = [
  // ── China ──
  {
    type: 'feishu-bot',
    displayName: 'Feishu Bot',
    description: 'Lark/Feishu messaging bot (built-in WS)',
    icon: 'feishu',
    builtin: true,
    configSchema: [
      {
        key: 'appId',
        label: 'plugin.feishu.appId',
        type: 'text',
        required: true,
        placeholder: 'cli_xxxxx',
      },
      {
        key: 'appSecret',
        label: 'plugin.feishu.appSecret',
        type: 'secret',
        required: true,
      },
    ],
  },
  {
    type: 'dingtalk-bot',
    displayName: 'DingTalk Bot',
    description: 'DingTalk messaging bot (built-in WS via Stream API)',
    icon: 'dingtalk',
    builtin: true,
    configSchema: [
      {
        key: 'appKey',
        label: 'plugin.dingtalk.appKey',
        type: 'text',
        required: true,
      },
      {
        key: 'appSecret',
        label: 'plugin.dingtalk.appSecret',
        type: 'secret',
        required: true,
      },
      {
        key: 'cardTemplateId',
        label: 'plugin.dingtalk.cardTemplateId',
        type: 'text',
        required: false,
        placeholder: 'AI streaming card template ID (optional)',
      },
    ],
  },
  {
    type: 'wecom-bot',
    displayName: 'WeCom Bot',
    description: 'WeCom (企业微信) messaging bot',
    icon: 'wecom',
    builtin: true,
    configSchema: [
      {
        key: 'corpId',
        label: 'plugin.wecom.corpId',
        type: 'text',
        required: true,
      },
      {
        key: 'secret',
        label: 'plugin.wecom.secret',
        type: 'secret',
        required: true,
      },
      {
        key: 'agentId',
        label: 'plugin.wecom.agentId',
        type: 'text',
        required: true,
      },
      wsRelayField,
    ],
  },
  // ── International ──
  {
    type: 'telegram-bot',
    displayName: 'Telegram Bot',
    description: 'Telegram messaging bot (needs WS relay)',
    icon: 'telegram',
    builtin: true,
    configSchema: [
      {
        key: 'botToken',
        label: 'plugin.telegram.botToken',
        type: 'secret',
        required: true,
      },
      wsRelayField,
    ],
  },
  {
    type: 'discord-bot',
    displayName: 'Discord Bot',
    description: 'Discord messaging bot (built-in Gateway WS)',
    icon: 'discord',
    builtin: true,
    configSchema: [
      {
        key: 'botToken',
        label: 'plugin.discord.botToken',
        type: 'secret',
        required: true,
      },
    ],
  },
  {
    type: 'whatsapp-bot',
    displayName: 'WhatsApp Bot',
    description: 'WhatsApp Cloud API bot (needs WS relay)',
    icon: 'whatsapp',
    builtin: true,
    configSchema: [
      {
        key: 'phoneNumberId',
        label: 'plugin.whatsapp.phoneNumberId',
        type: 'text',
        required: true,
      },
      {
        key: 'accessToken',
        label: 'plugin.whatsapp.accessToken',
        type: 'secret',
        required: true,
      },
      wsRelayField,
    ],
  },
]
