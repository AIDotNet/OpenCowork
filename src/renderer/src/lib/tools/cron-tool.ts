import { toolRegistry } from '../agent/tool-registry'
import { IPC } from '../ipc/channels'
import { useCronStore } from '../../stores/cron-store'
import { useUIStore } from '../../stores/ui-store'
import type { ToolHandler } from './tool-types'

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
      'IMPORTANT: For "in X minutes/hours" requests, ALWAYS use kind="at" with relative offset like "+10m". NEVER use ISO timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for this job (shown in UI)',
        },
        schedule: {
          type: 'object',
          description: 'Schedule config. MUST include "kind" plus the corresponding field: at (for kind=at), every (for kind=every), or expr (for kind=cron).',
          properties: {
            kind: { type: 'string', description: '"at" (one-shot) | "every" (fixed interval) | "cron" (cron expression). For delayed one-shot tasks like "in 10 minutes", use "at".' },
            at: { type: 'string', description: 'Required for kind=at. MUST use relative offset format: "+1m" (1 min), "+10m" (10 min), "+2h" (2 hours), "+30s" (30 sec), "+1d" (1 day). Do NOT use ISO timestamps.' },
            every: { type: 'number', description: 'Required for kind=every. Interval in ms. 60000=1min, 300000=5min, 3600000=1hr.' },
            expr: { type: 'string', description: 'Required for kind=cron. 5-field cron: "0 9 * * *" (daily 9am), "*/15 * * * *" (every 15min).' },
            tz: { type: 'string', description: 'IANA timezone, e.g. "Asia/Shanghai". Default: "UTC".' },
          },
          required: ['kind'],
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
            'The agent has access to: Read, Write, Edit, Bash, Glob, Grep, Notify, and plugin messaging tools.',
        },
        agentId: {
          type: 'string',
          description: 'SubAgent to use (e.g. "CronAgent", "CodeReview"). Defaults to CronAgent.',
        },
        model: {
          type: 'string',
          description: 'Model override for this job. Defaults to provider settings.',
        },
        workingFolder: {
          type: 'string',
          description: 'Working directory for the Agent (defaults to current session working folder)',
        },
        deliveryMode: {
          type: 'string',
          description: '"desktop" (toast notification), "session" (inject into session), or "none". Default: "desktop"',
        },
        deliveryTarget: {
          type: 'string',
          description: 'Session ID for deliveryMode="session". Defaults to current session.',
        },
        deleteAfterRun: {
          type: 'boolean',
          description: 'Auto-delete after first run. Default: true for "at", false for others.',
        },
        maxIterations: {
          type: 'number',
          description: 'Max agent loop iterations. Default: 15.',
        },
      },
      required: ['name', 'schedule', 'prompt'],
    },
  },
  execute: async (input, ctx) => {
    const name = String(input.name ?? '')
    const prompt = String(input.prompt ?? '')
    if (!name) return JSON.stringify({ error: 'name is required' })
    if (!prompt) return JSON.stringify({ error: 'prompt is required' })

    const schedule = { ...(input.schedule as { kind: string; at?: string | number; every?: number; expr?: string; tz?: string }) }
    if (!schedule?.kind) return JSON.stringify({ error: 'schedule.kind is required' })

    // Resolve relative time offsets for "at" kind (e.g. "+10m", "+1h", "+30s")
    if (schedule.kind === 'at' && typeof schedule.at === 'string') {
      const relMatch = schedule.at.match(/^\+(\d+)\s*(s|sec|m|min|h|hr|d|day)s?$/i)
      if (relMatch) {
        const value = parseInt(relMatch[1], 10)
        const unit = relMatch[2].toLowerCase()
        const multipliers: Record<string, number> = { s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000, day: 86_400_000 }
        schedule.at = Date.now() + value * (multipliers[unit] ?? 60_000)
      } else {
        // AI passed an ISO timestamp or other string — try to parse it
        const parsed = new Date(schedule.at).getTime()
        if (!isNaN(parsed)) {
          // If the parsed time is in the past, reject with a helpful error
          if (parsed < Date.now() - 30_000) {
            return JSON.stringify({
              error: `The timestamp "${schedule.at}" is in the past. You do not know the current time, so do NOT use ISO timestamps. Use relative offset format instead: "+1m" for 1 minute, "+10m" for 10 minutes, "+1h" for 1 hour, "+1d" for 1 day.`,
            })
          }
          schedule.at = parsed
        } else {
          return JSON.stringify({
            error: `Invalid schedule.at value: "${schedule.at}". Use relative offset format: "+1m", "+10m", "+2h", "+1d".`,
          })
        }
      }
    }

    const result = await ctx.ipc.invoke(IPC.CRON_ADD, {
      name,
      sessionId: ctx.sessionId ?? null,
      schedule,
      prompt,
      agentId: input.agentId ? String(input.agentId) : undefined,
      model: input.model ? String(input.model) : undefined,
      workingFolder: input.workingFolder ? String(input.workingFolder) : ctx.workingFolder,
      deliveryMode: input.deliveryMode ? String(input.deliveryMode) : 'desktop',
      deliveryTarget: input.deliveryTarget ? String(input.deliveryTarget) : ctx.sessionId,
      deleteAfterRun: input.deleteAfterRun,
      maxIterations: input.maxIterations,
      // Auto-inject plugin channel info from context so cron can reply through the same plugin
      pluginId: ctx.pluginId,
      pluginChatId: ctx.pluginChatId,
    }) as { error?: string; jobId?: string; success?: boolean }

    if (result.error) return JSON.stringify({ error: result.error })

    useCronStore.getState().loadJobs(ctx.sessionId ?? undefined).catch(() => {})

    // Auto-open the Cron tab in the right panel so user can see the new job
    useUIStore.getState().setRightPanelTab('cron')
    useUIStore.getState().setRightPanelOpen(true)

    return JSON.stringify({
      success: true,
      jobId: result.jobId,
      name,
      scheduleKind: schedule.kind,
      message: `Job "${name}" created (id=${result.jobId}, kind=${schedule.kind}).`,
    })
  },
  requiresApproval: () => true,
}

// ── CronUpdate ───────────────────────────────────────────────────

const cronUpdateHandler: ToolHandler = {
  definition: {
    name: 'CronUpdate',
    description: 'Update an existing cron job. Provide the jobId and a patch object with fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID (e.g. "cron-abc12345")' },
        patch: {
          type: 'object',
          description: 'Fields to update. Any subset of: name, schedule, prompt, agentId, model, workingFolder, deliveryMode, deliveryTarget, enabled, deleteAfterRun, maxIterations.',
          properties: {
            name: { type: 'string' },
            schedule: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                at: { type: 'string' },
                every: { type: 'number' },
                expr: { type: 'string' },
                tz: { type: 'string' },
              },
            },
            prompt: { type: 'string' },
            agentId: { type: 'string' },
            model: { type: 'string' },
            workingFolder: { type: 'string' },
            deliveryMode: { type: 'string' },
            deliveryTarget: { type: 'string' },
            enabled: { type: 'boolean' },
            deleteAfterRun: { type: 'boolean' },
            maxIterations: { type: 'number' },
          },
        },
      },
      required: ['jobId', 'patch'],
    },
  },
  execute: async (input, ctx) => {
    const jobId = String(input.jobId ?? '')
    if (!jobId) return JSON.stringify({ error: 'jobId is required' })

    const result = await ctx.ipc.invoke(IPC.CRON_UPDATE, {
      jobId,
      patch: input.patch,
    }) as { error?: string; success?: boolean }

    if (result.error) return JSON.stringify({ error: result.error })

    useCronStore.getState().loadJobs(ctx.sessionId ?? undefined).catch(() => {})
    return JSON.stringify({ success: true, jobId, message: `Job ${jobId} updated.` })
  },
  requiresApproval: () => true,
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
          description: 'The job ID (e.g. "cron-abc12345")',
        },
      },
      required: ['jobId'],
    },
  },
  execute: async (input, ctx) => {
    const jobId = String(input.jobId ?? '')
    if (!jobId) return JSON.stringify({ error: 'jobId is required' })

    const result = await ctx.ipc.invoke(IPC.CRON_REMOVE, { jobId }) as { error?: string; success?: boolean }
    if (result.error) return JSON.stringify({ error: result.error })

    useCronStore.getState().removeJob(jobId)
    return JSON.stringify({ success: true, jobId, message: `Job ${jobId} removed.` })
  },
  requiresApproval: () => false,
}

// ── CronList ─────────────────────────────────────────────────────

const cronListHandler: ToolHandler = {
  definition: {
    name: 'CronList',
    description: 'List all cron jobs with their schedule, status, and execution history.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  execute: async (_input, ctx) => {
    const result = await ctx.ipc.invoke(IPC.CRON_LIST, {
      sessionId: ctx.sessionId ?? null,
    }) as unknown[] | { error?: string }

    if (!Array.isArray(result)) {
      return JSON.stringify({ error: (result as { error?: string }).error ?? 'Failed to list cron jobs' })
    }

    if (result.length === 0) {
      return JSON.stringify({ total: 0, jobs: [], message: 'No cron jobs scheduled.' })
    }

    return JSON.stringify({
      total: result.length,
      jobs: result.map((j: unknown) => {
        const job = j as {
          id: string
          name: string
          schedule: { kind: string; at?: number; every?: number; expr?: string; tz?: string }
          prompt: string
          agentId: string | null
          enabled: boolean
          scheduled: boolean
          executing: boolean
          fireCount: number
          lastFiredAt: number | null
        }
        return {
          id: job.id,
          name: job.name,
          schedule: job.schedule,
          prompt: job.prompt?.slice(0, 100),
          agentId: job.agentId,
          enabled: job.enabled,
          scheduled: job.scheduled,
          executing: job.executing,
          fireCount: job.fireCount,
          lastFiredAt: job.lastFiredAt ? new Date(job.lastFiredAt).toISOString() : null,
        }
      }),
    })
  },
  requiresApproval: () => false,
}

// ── Registration ─────────────────────────────────────────────────

export function registerCronTools(): void {
  toolRegistry.register(cronAddHandler)
  toolRegistry.register(cronUpdateHandler)
  toolRegistry.register(cronRemoveHandler)
  toolRegistry.register(cronListHandler)
}
