import type { ChannelProviderDescriptor } from './channel-types'

/** Optional WS relay URL — only for platforms without native WS support */
const wsRelayField = {
  key: 'wsUrl',
  label: 'channel.wsUrl',
  type: 'text' as const,
  required: false,
  placeholder: 'wss://your-relay-server/ws'
}

const COMMON_PLUGIN_TOOLS = [
  'PluginSendMessage',
  'PluginReplyMessage',
  'PluginGetGroupMessages',
  'PluginListGroups',
  'PluginSummarizeGroup',
  'PluginGetCurrentChatMessages'
]

const FEISHU_PLUGIN_TOOLS = [
  ...COMMON_PLUGIN_TOOLS,
  'FeishuSendImage',
  'FeishuSendFile',
  'FeishuListChatMembers',
  'FeishuAtMember',
  'FeishuSendUrgent',
  'FeishuBitableListApps',
  'FeishuBitableListTables',
  'FeishuBitableListFields',
  'FeishuBitableGetRecords',
  'FeishuBitableCreateRecords',
  'FeishuBitableUpdateRecords',
  'FeishuBitableDeleteRecords'
]

/** Built-in channel provider descriptors */
export const CHANNEL_PROVIDERS: ChannelProviderDescriptor[] = [
  // ── China ──
  {
    type: 'feishu-bot',
    displayName: 'Feishu Bot',
    description: 'Lark/Feishu messaging bot (built-in WS)',
    icon: 'feishu',
    builtin: true,
    tools: FEISHU_PLUGIN_TOOLS,
    configSchema: [
      {
        key: 'appId',
        label: 'channel.feishu.appId',
        type: 'text',
        required: true,
        placeholder: 'cli_xxxxx'
      },
      {
        key: 'appSecret',
        label: 'channel.feishu.appSecret',
        type: 'secret',
        required: true
      }
    ]
  },
  {
    type: 'dingtalk-bot',
    displayName: 'DingTalk Bot',
    description: 'DingTalk messaging bot (built-in WS via Stream API)',
    icon: 'dingtalk',
    builtin: true,
    tools: COMMON_PLUGIN_TOOLS,
    configSchema: [
      {
        key: 'appKey',
        label: 'channel.dingtalk.appKey',
        type: 'text',
        required: true
      },
      {
        key: 'appSecret',
        label: 'channel.dingtalk.appSecret',
        type: 'secret',
        required: true
      },
      {
        key: 'cardTemplateId',
        label: 'channel.dingtalk.cardTemplateId',
        type: 'text',
        required: false,
        placeholder: 'AI streaming card template ID (optional)'
      }
    ]
  },
  {
    type: 'wecom-bot',
    displayName: 'WeCom Bot',
    description: 'WeCom (企业微信) messaging bot',
    icon: 'wecom',
    builtin: true,
    tools: COMMON_PLUGIN_TOOLS,
    configSchema: [
      {
        key: 'corpId',
        label: 'channel.wecom.corpId',
        type: 'text',
        required: true
      },
      {
        key: 'secret',
        label: 'channel.wecom.secret',
        type: 'secret',
        required: true
      },
      {
        key: 'agentId',
        label: 'channel.wecom.agentId',
        type: 'text',
        required: true
      },
      wsRelayField
    ]
  },
  {
    type: 'qq-bot',
    displayName: 'QQ Bot',
    description: 'Tencent QQ Bot (official Gateway WS)',
    icon: 'qq',
    builtin: true,
    tools: COMMON_PLUGIN_TOOLS,
    configSchema: [
      {
        key: 'appId',
        label: 'channel.qq.appId',
        type: 'text',
        required: true
      },
      {
        key: 'clientSecret',
        label: 'channel.qq.clientSecret',
        type: 'secret',
        required: true
      },
      {
        key: 'useSandbox',
        label: 'channel.qq.useSandbox',
        type: 'text',
        placeholder: 'true / false'
      },
      {
        key: 'markdownSupport',
        label: 'channel.qq.markdownSupport',
        type: 'text',
        placeholder: 'true / false'
      }
    ]
  },
  // ── International ──
  {
    type: 'telegram-bot',
    displayName: 'Telegram Bot',
    description: 'Telegram messaging bot (needs WS relay)',
    icon: 'telegram',
    builtin: true,
    tools: COMMON_PLUGIN_TOOLS,
    configSchema: [
      {
        key: 'botToken',
        label: 'channel.telegram.botToken',
        type: 'secret',
        required: true
      },
      wsRelayField
    ]
  },
  {
    type: 'discord-bot',
    displayName: 'Discord Bot',
    description: 'Discord messaging bot (built-in Gateway WS)',
    icon: 'discord',
    builtin: true,
    tools: COMMON_PLUGIN_TOOLS,
    configSchema: [
      {
        key: 'botToken',
        label: 'channel.discord.botToken',
        type: 'secret',
        required: true
      }
    ]
  },
  {
    type: 'whatsapp-bot',
    displayName: 'WhatsApp Bot',
    description: 'WhatsApp Cloud API bot (needs WS relay)',
    icon: 'whatsapp',
    builtin: true,
    tools: COMMON_PLUGIN_TOOLS,
    configSchema: [
      {
        key: 'phoneNumberId',
        label: 'channel.whatsapp.phoneNumberId',
        type: 'text',
        required: true
      },
      {
        key: 'accessToken',
        label: 'channel.whatsapp.accessToken',
        type: 'secret',
        required: true
      },
      wsRelayField
    ]
  }
]
