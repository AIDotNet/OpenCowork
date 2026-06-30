import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from './tool-types'

/**
 * Notify tool — sends desktop toast notifications and/or injects messages into sessions.
 * Designed for use by any agent (especially CronAgent) to surface results to the user.
 */

function nativeOnlyNotifyResult(): string {
  return JSON.stringify({
    error: 'Notify execution has migrated to .NET Native Worker.'
  })
}

const notifyHandler: ToolHandler = {
  definition: {
    name: 'Notify',
    description:
      'Send a desktop notification to the user. Use this to surface results, alerts, or summaries.\n\n' +
      'This tool shows a non-intrusive toast notification in the app without adding to chat history.\n\n' +
      'Notification types control the visual style:\n' +
      '- "info": General information (blue)\n' +
      '- "success": Task completed successfully (green)\n' +
      '- "warning": Something needs attention (amber)\n' +
      '- "error": Something failed (red)',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Notification title (shown as the header)'
        },
        body: {
          type: 'string',
          description: 'Notification body — the main content/summary to communicate'
        },
        type: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: 'Notification style. Default: "info"'
        },
        duration: {
          type: 'number',
          description: 'How long the desktop toast stays visible in milliseconds. Default: 5000'
        }
      },
      required: ['title', 'body']
    }
  },

  execute: async () => nativeOnlyNotifyResult(),

  requiresApproval: () => false
}

export function registerNotifyTool(): void {
  toolRegistry.register(notifyHandler)
}
