import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from './tool-types'
import { IPC } from '../ipc/channels'

/**
 * Notify tool — sends desktop toast notifications and/or injects messages into sessions.
 * Designed for use by any agent (especially CronAgent) to surface results to the user.
 */

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
          description: 'Notification title (shown as the header)',
        },
        body: {
          type: 'string',
          description: 'Notification body — the main content/summary to communicate',
        },
        type: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: 'Notification style. Default: "info"',
        },
        duration: {
          type: 'number',
          description: 'How long the desktop toast stays visible in milliseconds. Default: 5000',
        },
      },
      required: ['title', 'body'],
    },
  },

  execute: async (input, ctx) => {
    const title = String(input.title ?? '')
    const body = String(input.body ?? '')
    const type = String(input.type ?? 'info') as 'info' | 'success' | 'warning' | 'error'
    const duration = Number(input.duration) || 5000

    if (!title || !body) {
      return JSON.stringify({ error: 'title and body are required' })
    }

    // ── Delivery-once guard: block duplicate delivery calls within a single cron run ──
    console.log(`[Notify] callerAgent=${ctx.callerAgent}, sharedState=`, JSON.stringify(ctx.sharedState), `pluginId=${ctx.pluginId}, pluginChatId=${ctx.pluginChatId}`)
    if (ctx.callerAgent === 'CronAgent' && ctx.sharedState?.deliveryUsed) {
      console.warn('[Notify] CronAgent already delivered results this run — BLOCKING duplicate Notify call')
      return JSON.stringify({ success: true, skipped: true, reason: 'Already delivered results this run. Only one delivery call is allowed.' })
    }

    // When CronAgent has plugin context, redirect Notify → plugin channel automatically.
    // This is a safety net — the prompt tells the agent to use PluginSendMessage directly,
    // but if it still calls Notify, we redirect to the plugin channel instead of showing popups.
    // We call IPC directly here (not via PluginSendMessage handler) to avoid the delivery guard blocking our own redirect.
    if (ctx.callerAgent === 'CronAgent' && ctx.pluginId && ctx.pluginChatId) {
      console.log('[Notify] CronAgent has plugin context — redirecting to plugin channel via IPC')
      if (ctx.sharedState) ctx.sharedState.deliveryUsed = true
      try {
        const emoji = type === 'success' ? '✅' : type === 'warning' ? '⚠️' : type === 'error' ? '❌' : 'ℹ️'
        const content = `${emoji} ${title}\n${body}`
        const result = await ctx.ipc.invoke(IPC.PLUGIN_EXEC, {
          pluginId: ctx.pluginId,
          action: 'sendMessage',
          params: { chatId: ctx.pluginChatId, content },
        })
        console.log('[Notify] Plugin redirect done, sharedState=', JSON.stringify(ctx.sharedState))
        return JSON.stringify(result)
      } catch (err) {
        console.warn('[Notify] Plugin redirect failed, falling back to desktop:', err)
        // Fall through to desktop notification
      }
    }

    // Send desktop toast notification
    try {
      await ctx.ipc.invoke(IPC.NOTIFY_DESKTOP, { title, body, type, duration })

      // Mark delivery as used for CronAgent runs
      if (ctx.callerAgent === 'CronAgent' && ctx.sharedState) {
        ctx.sharedState.deliveryUsed = true
      }

      return JSON.stringify({
        success: true,
        title,
        body: body.slice(0, 200),
      })
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  requiresApproval: () => false,
}

export function registerNotifyTool(): void {
  toolRegistry.register(notifyHandler)
}
