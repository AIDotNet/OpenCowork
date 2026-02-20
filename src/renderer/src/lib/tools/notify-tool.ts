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
      'Send a notification to the user. Use this to surface results, alerts, or summaries.\n\n' +
      'Delivery methods:\n' +
      '- "desktop" (default): Show a toast notification in the app\n' +
      '- "session": Inject a message into a chat session to trigger a follow-up agent turn\n' +
      '- "all": Both desktop toast and session message\n\n' +
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
        action: {
          type: 'string',
          enum: ['desktop', 'session', 'all'],
          description: 'Delivery method. Default: "desktop"',
        },
        duration: {
          type: 'number',
          description: 'How long the desktop toast stays visible in milliseconds. Default: 5000',
        },
        session_id: {
          type: 'string',
          description: 'Target session ID for "session" or "all" action. Uses current session if omitted.',
        },
      },
      required: ['title', 'body'],
    },
  },

  execute: async (input, ctx) => {
    const title = String(input.title ?? '')
    const body = String(input.body ?? '')
    const type = String(input.type ?? 'info') as 'info' | 'success' | 'warning' | 'error'
    let action = String(input.action ?? 'desktop') as 'desktop' | 'session' | 'all'
    const duration = Number(input.duration) || 5000
    const sessionId = input.session_id ? String(input.session_id) : ctx.sessionId

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

    // Prevent CronAgent from injecting into sessions (causes infinite loops)
    if (ctx.callerAgent === 'CronAgent' && (action === 'session' || action === 'all')) {
      console.warn('[Notify] CronAgent attempted session injection — forcing desktop-only to prevent loop')
      action = 'desktop'
    }

    const results: string[] = []

    // Desktop toast notification
    if (action === 'desktop' || action === 'all') {
      try {
        await ctx.ipc.invoke(IPC.NOTIFY_DESKTOP, { title, body, type, duration })
        results.push('desktop notification sent')
      } catch (err) {
        results.push(`desktop notification failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Session message injection
    if (action === 'session' || action === 'all') {
      if (!sessionId) {
        results.push('session injection skipped: no session_id available')
      } else {
        try {
          await ctx.ipc.invoke(IPC.NOTIFY_SESSION, { sessionId, title, body })
          results.push(`message injected into session ${sessionId}`)
        } catch (err) {
          results.push(`session injection failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // Mark delivery as used for CronAgent runs
    if (ctx.callerAgent === 'CronAgent' && ctx.sharedState) {
      ctx.sharedState.deliveryUsed = true
    }

    return JSON.stringify({
      success: true,
      delivered: results,
      title,
      body: body.slice(0, 200),
    })
  },

  requiresApproval: () => false,
}

export function registerNotifyTool(): void {
  toolRegistry.register(notifyHandler)
}
