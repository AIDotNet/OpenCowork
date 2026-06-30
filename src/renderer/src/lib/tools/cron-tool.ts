import { toolRegistry } from '../agent/tool-registry'
import type { ToolHandler } from './tool-types'

function nativeOnlyCronResult(toolName: string): string {
  return JSON.stringify({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

// ── CronAdd ──────────────────────────────────────────────────────

const cronAddHandler: ToolHandler = {
  definition: {
    name: 'CronAdd',
    description:
      'Schedule a background Agent task. Three schedule kinds:\n\n' +
      '1. kind="at" — ONE-SHOT, runs once then auto-deletes.\n' +
      '   ALWAYS use relative offset format for the "at" field:\n' +
      '   - "1 minute later" → { kind: "at", at: "+1m" }\n' +
      '   - "10 minutes later" → { kind: "at", at: "+10m" }\n' +
      '   - "2 hours later" → { kind: "at", at: "+2h" }\n' +
      '   - "30 seconds later" → { kind: "at", at: "+30s" }\n' +
      '   - "1 day later" → { kind: "at", at: "+1d" }\n' +
      '   Supported units: s (seconds), m (minutes), h (hours), d (days).\n' +
      '   DO NOT use ISO 8601 timestamps or absolute times — you do not know the current time. ONLY use "+Xm" / "+Xh" / "+Xs" / "+Xd" format.\n\n' +
      '2. kind="every" — REPEATING at fixed interval (ms):\n' +
      '   - "every 30 minutes" → { kind: "every", every: 1800000 }\n' +
      '   - "every hour" → { kind: "every", every: 3600000 }\n\n' +
      '3. kind="cron" — REPEATING with cron expression (5-field):\n' +
      '   - "daily at 9am" → { kind: "cron", expr: "0 9 * * *" }\n' +
      '   - "every 15 min" → { kind: "cron", expr: "*/15 * * * *" }\n' +
      '   - "weekdays at 6pm" → { kind: "cron", expr: "0 18 * * 1-5" }\n\n' +
      'IMPORTANT: For "in X minutes/hours" requests, ALWAYS use kind="at" with relative offset like "+10m". NEVER use ISO timestamps.\n\n' +
      'Delivery: by default, CronAgent will Notify on desktop. To force delivery through a messaging plugin (Feishu, WhatsApp, etc.), provide pluginId + pluginChatId explicitly when creating the job.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for this job (shown in UI)'
        },
        schedule: {
          type: 'object',
          description:
            'Schedule config. MUST include "kind" plus the corresponding field: at (for kind=at), every (for kind=every), or expr (for kind=cron).',
          properties: {
            kind: {
              type: 'string',
              description:
                '"at" (one-shot) | "every" (fixed interval) | "cron" (cron expression). For delayed one-shot tasks like "in 10 minutes", use "at".'
            },
            at: {
              type: 'string',
              description:
                'Required for kind=at. MUST use relative offset format: "+1m" (1 min), "+10m" (10 min), "+2h" (2 hours), "+30s" (30 sec), "+1d" (1 day). Do NOT use ISO timestamps.'
            },
            every: {
              type: 'number',
              description:
                'Required for kind=every. Interval in ms. 60000=1min, 300000=5min, 3600000=1hr.'
            },
            expr: {
              type: 'string',
              description:
                'Required for kind=cron. 5-field cron: "0 9 * * *" (daily 9am), "*/15 * * * *" (every 15min).'
            },
            tz: {
              type: 'string',
              description: 'IANA timezone, e.g. "Asia/Shanghai". Default: "UTC".'
            }
          },
          required: ['kind']
        },
        prompt: {
          type: 'string',
          description:
            'The task instruction for the CronAgent to execute when the job fires. ' +
            'Write clear, actionable instructions that include the desired tone and output format.\n\n' +
            'Examples:\n' +
            '- Reminder: "Send a friendly lunch reminder. Use casual tone with a food emoji. Keep it short and warm."\n' +
            '- Build check: "Run `npm run build`. Report success or failure with error details and suggested fixes."\n' +
            '- Monitoring: "Check /var/log/app.log for ERROR entries in the last hour. Summarize findings."\n' +
            '- Code quality: "Run `npm run lint`. Report violation count, top issues, and suggestions."\n\n' +
            'The agent has access to: Read, Write, Edit, Bash, Glob, Grep, Notify, and plugin messaging tools.'
        },
        agentId: {
          type: 'string',
          description: 'SubAgent to use. Defaults to CronAgent. Use any registered sub-agent name.'
        },
        model: {
          type: 'string',
          description: 'Model override for this job. Defaults to provider settings.'
        },
        workingFolder: {
          type: 'string',
          description:
            'Working directory for the Agent (defaults to current session working folder)'
        },
        deliveryMode: {
          type: 'string',
          description:
            '"desktop" (toast notification), "session" (inject into session), or "none". Default: "desktop"'
        },
        deliveryTarget: {
          type: 'string',
          description: 'Session ID for deliveryMode="session". Defaults to current session.'
        },
        deleteAfterRun: {
          type: 'boolean',
          description: 'Auto-delete after first run. Default: true for "at", false for others.'
        },
        maxIterations: {
          type: 'number',
          description: 'Max agent loop iterations. Default: 15.'
        },
        pluginId: {
          type: 'string',
          description:
            'Optional messaging plugin ID to deliver the results through (e.g. cron reminders to WhatsApp).'
        },
        pluginChatId: {
          type: 'string',
          description:
            'Chat/channel ID for the messaging plugin. Required when pluginId is provided.'
        }
      },
      required: ['name', 'schedule', 'prompt']
    }
  },
  execute: async () => nativeOnlyCronResult('CronAdd'),
  requiresApproval: () => true
}

// ── CronUpdate ───────────────────────────────────────────────────

const cronUpdateHandler: ToolHandler = {
  definition: {
    name: 'CronUpdate',
    description:
      'Update an existing cron job. Provide the jobId and a patch object with fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID (e.g. "cron-abc12345")' },
        patch: {
          type: 'object',
          description:
            'Fields to update. Any subset of: name, schedule, prompt, agentId, model, workingFolder, sshConnectionId, deliveryMode, deliveryTarget, enabled, deleteAfterRun, maxIterations.',
          properties: {
            name: { type: 'string' },
            schedule: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                at: { type: 'string' },
                every: { type: 'number' },
                expr: { type: 'string' },
                tz: { type: 'string' }
              }
            },
            prompt: { type: 'string' },
            agentId: { type: 'string' },
            model: { type: 'string' },
            workingFolder: { type: 'string' },
            sshConnectionId: { type: 'string' },
            deliveryMode: { type: 'string' },
            deliveryTarget: { type: 'string' },
            enabled: { type: 'boolean' },
            deleteAfterRun: { type: 'boolean' },
            maxIterations: { type: 'number' }
          }
        }
      },
      required: ['jobId', 'patch']
    }
  },
  execute: async () => nativeOnlyCronResult('CronUpdate'),
  requiresApproval: () => true
}

// ── CronRemove ───────────────────────────────────────────────────

const cronRemoveHandler: ToolHandler = {
  definition: {
    name: 'CronRemove',
    description: 'Remove and delete a scheduled cron job by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The job ID (e.g. "cron-abc12345")'
        }
      },
      required: ['jobId']
    }
  },
  execute: async () => nativeOnlyCronResult('CronRemove'),
  requiresApproval: () => false
}

// ── CronList ─────────────────────────────────────────────────────

const cronListHandler: ToolHandler = {
  definition: {
    name: 'CronList',
    description: 'List all cron jobs with their schedule, status, and execution history.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async () => nativeOnlyCronResult('CronList'),
  requiresApproval: () => false
}

// ── Registration ─────────────────────────────────────────────────

const cronCreateHandler: ToolHandler = {
  ...cronAddHandler,
  definition: {
    ...cronAddHandler.definition,
    name: 'CronCreate',
    description: 'Code-agent-compatible alias for CronAdd. Schedule a background agent task.'
  },
  execute: async () => nativeOnlyCronResult('CronCreate')
}

const cronDeleteHandler: ToolHandler = {
  definition: {
    name: 'CronDelete',
    description: 'Code-agent-compatible alias for CronRemove. Delete a scheduled cron job by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron job ID' },
        jobId: { type: 'string', description: 'Cron job ID' }
      }
    }
  },
  execute: async () => nativeOnlyCronResult('CronDelete'),
  requiresApproval: () => false
}

export function registerCronTools(): void {
  toolRegistry.register(cronAddHandler)
  toolRegistry.register(cronCreateHandler)
  toolRegistry.register(cronUpdateHandler)
  toolRegistry.register(cronRemoveHandler)
  toolRegistry.register(cronDeleteHandler)
  toolRegistry.register(cronListHandler)
}
