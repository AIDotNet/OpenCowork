import { useChatStore } from '../../stores/chat-store'
import { usePlanStore, type Plan, type PlanStatus } from '../../stores/plan-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'

type NativePlanUiUpdateResult = {
  ok: boolean
  error?: string
}

const PLAN_STATUSES = new Set<PlanStatus>([
  'drafting',
  'awaiting_review',
  'approved',
  'implementing',
  'completed',
  'rejected'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function coerceNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function coercePlanStatus(value: unknown): PlanStatus {
  return typeof value === 'string' && PLAN_STATUSES.has(value as PlanStatus)
    ? (value as PlanStatus)
    : 'drafting'
}

function coerceNativePlan(value: unknown): Plan | null {
  if (!isRecord(value)) return null

  const id = coerceString(value.id)
  const sessionId = coerceString(value.sessionId)
  const title = coerceString(value.title) ?? 'Plan'
  if (!id || !sessionId) return null

  const createdAt = coerceNumber(value.createdAt) ?? Date.now()
  const updatedAt = coerceNumber(value.updatedAt) ?? createdAt

  return {
    id,
    sessionId,
    title,
    status: coercePlanStatus(value.status),
    filePath: coerceString(value.filePath),
    content: typeof value.content === 'string' ? value.content : undefined,
    specJson: typeof value.specJson === 'string' ? value.specJson : undefined,
    createdAt,
    updatedAt
  }
}

export async function handleNativePlanUiUpdate(
  params: unknown
): Promise<NativePlanUiUpdateResult> {
  const record = isRecord(params) ? params : {}
  const action = coerceString(record.action)
  const plan = coerceNativePlan(record.plan)
  if (!plan) {
    return { ok: false, error: 'Invalid native plan UI update payload.' }
  }

  usePlanStore.getState().syncPlanFromNative(plan)

  const uiStore = useUIStore.getState()
  if (action === 'enter') {
    uiStore.enterPlanMode(plan.sessionId)
    const session = useChatStore.getState().sessions.find((item) => item.id === plan.sessionId)
    const autoSwitchTarget = useSettingsStore.getState().clarifyPlanModeAutoSwitchTarget
    if (session?.mode === 'clarify' && autoSwitchTarget !== 'off') {
      uiStore.setMode(autoSwitchTarget)
      useChatStore.getState().updateSessionMode(plan.sessionId, autoSwitchTarget)
    }
  } else if (action === 'exit') {
    uiStore.exitPlanMode(plan.sessionId)
  }

  const activeSessionId =
    coerceString(record.activeSessionId) ?? useChatStore.getState().activeSessionId
  if (activeSessionId === plan.sessionId) {
    usePlanStore.getState().setActivePlan(plan.id)
  }

  return { ok: true }
}
