import { t } from '../i18n.js'
import type {
  AskUserRequest,
  ConfigCatalog,
  PermissionMode,
  Message,
  ModelConfiguration,
  PermissionRequest,
  PlanSnapshot,
  ProviderSetupCatalog,
  ResumeResult,
  TaskItem,
  TurnStatusSnapshot
} from '../types.js'

export type ActiveOverlay =
  | { type: 'askUser'; request: AskUserRequest }
  | { type: 'plan'; plan: PlanSnapshot }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'resume' }
  | { type: 'providerSetup'; catalog: ProviderSetupCatalog }
  | { type: 'effort'; configuration: ModelConfiguration }
  | { type: 'modelConfig'; configuration: ModelConfiguration }
  | { type: 'modelPicker'; purpose: 'session' | 'compression' }
  | { type: 'config'; catalog: ConfigCatalog }
  | { type: 'agents' }
  | null

export interface CliState {
  activity?: string
  askUserRequest: AskUserRequest | null
  isRunning: boolean
  messages: Message[]
  permissionRequest: PermissionRequest | null
  plan: PlanSnapshot | null
  showTasks: boolean
  tasks: TaskItem[]
  turnStatus: TurnStatusSnapshot | null
}

export function createInitialCliState(initialResume?: ResumeResult): CliState {
  const messages: Message[] = initialResume
    ? [
        ...initialResume.transcript,
        {
          id: 'startup-resume',
          kind: 'system',
          text: t('cli.runtime.resumedSession', 'Resumed session · {{count}} canonical messages', {
            count: initialResume.session.messageCount
          }),
          tone: 'success'
        },
        ...(initialResume.warning
          ? [
              {
                id: 'startup-resume-warning',
                kind: 'system',
                text: initialResume.warning,
                tone: 'warning'
              } satisfies Message
            ]
          : [])
      ]
    : []

  return {
    askUserRequest: null,
    isRunning: false,
    messages,
    permissionRequest: null,
    plan: null,
    showTasks: false,
    tasks: [],
    turnStatus: null
  }
}

export function isPlanOverlayVisible(plan: PlanSnapshot | null): plan is PlanSnapshot {
  return plan !== null && (plan.status === 'drafting' || plan.status === 'awaiting_review')
}

export interface OverlayInputs {
  askUserRequest: AskUserRequest | null
  agentPanelOpen: boolean
  configCatalog: ConfigCatalog | null
  configOpen: boolean
  effortConfiguration: ModelConfiguration | null
  modelConfiguration: ModelConfiguration | null
  modelPickerPurpose: 'session' | 'compression' | null
  permissionMode: PermissionMode
  permissionRequest: PermissionRequest | null
  plan: PlanSnapshot | null
  providerSetupCatalog: ProviderSetupCatalog | null
  resumeOpen: boolean
}

export function resolveActiveOverlay({
  askUserRequest,
  agentPanelOpen,
  configCatalog,
  configOpen,
  effortConfiguration,
  modelConfiguration,
  modelPickerPurpose,
  permissionMode,
  permissionRequest,
  plan,
  providerSetupCatalog,
  resumeOpen
}: OverlayInputs): ActiveOverlay {
  if (askUserRequest) return { type: 'askUser', request: askUserRequest }
  if (permissionMode === 'plan' && isPlanOverlayVisible(plan)) {
    return { type: 'plan', plan }
  }
  if (permissionRequest) return { type: 'permission', request: permissionRequest }
  if (resumeOpen) return { type: 'resume' }
  if (providerSetupCatalog) return { type: 'providerSetup', catalog: providerSetupCatalog }
  if (effortConfiguration) return { type: 'effort', configuration: effortConfiguration }
  if (modelConfiguration) return { type: 'modelConfig', configuration: modelConfiguration }
  if (modelPickerPurpose) return { type: 'modelPicker', purpose: modelPickerPurpose }
  if (configOpen && configCatalog) return { type: 'config', catalog: configCatalog }
  if (agentPanelOpen) return { type: 'agents' }
  return null
}

export function isOverlayOpen(overlay: ActiveOverlay): boolean {
  return overlay !== null
}
