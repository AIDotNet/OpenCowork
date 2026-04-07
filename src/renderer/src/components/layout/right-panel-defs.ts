import {
  Activity,
  ClipboardList,
  Database,
  FileOutput,
  FolderTree,
  ListChecks,
  Monitor,
  ShieldCheck,
  Users,
  Bot,
  Workflow,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import type { RightPanelSection, RightPanelTab } from '@renderer/stores/ui-store'

export const LEFT_SIDEBAR_DEFAULT_WIDTH = 320
export const LEFT_SIDEBAR_MIN_WIDTH = 240
export const LEFT_SIDEBAR_MAX_WIDTH = 520

export const RIGHT_PANEL_DEFAULT_WIDTH = 384
export const RIGHT_PANEL_MIN_WIDTH = 320
export const RIGHT_PANEL_MAX_WIDTH = 760
export const RIGHT_PANEL_RAIL_WIDTH = 48
export const RIGHT_PANEL_RAIL_SLIM_WIDTH = 12

export interface RightPanelTabDef {
  value: RightPanelTab
  labelKey: string
  section: RightPanelSection
  icon: LucideIcon
}

export interface RightPanelSectionDef {
  value: RightPanelSection
  labelKey: string
  icon: LucideIcon
}

export const RIGHT_PANEL_TAB_DEFS: RightPanelTabDef[] = [
  { value: 'steps', labelKey: 'steps', section: 'execution', icon: ListChecks },
  { value: 'plan', labelKey: 'plan', section: 'execution', icon: ClipboardList },
  { value: 'files', labelKey: 'files', section: 'resources', icon: FolderTree },
  { value: 'preview', labelKey: 'preview', section: 'resources', icon: Monitor },
  { value: 'terminal', labelKey: 'terminal', section: 'resources', icon: SquareTerminal },
  { value: 'artifacts', labelKey: 'artifacts', section: 'resources', icon: FileOutput },
  { value: 'subagents', labelKey: 'subagents', section: 'collaboration', icon: Bot },
  { value: 'team', labelKey: 'team', section: 'collaboration', icon: Users },
  { value: 'context', labelKey: 'context', section: 'monitoring', icon: Database },
  { value: 'acp', labelKey: 'acp', section: 'monitoring', icon: ShieldCheck }
]

export const RIGHT_PANEL_TAB_ORDER: RightPanelTab[] = RIGHT_PANEL_TAB_DEFS.map((tab) => tab.value)

export const RIGHT_PANEL_SECTION_DEFS: RightPanelSectionDef[] = [
  {
    value: 'execution',
    labelKey: 'sectionExecution',
    icon: Workflow
  },
  {
    value: 'resources',
    labelKey: 'sectionResources',
    icon: FolderTree
  },
  {
    value: 'collaboration',
    labelKey: 'sectionCollaboration',
    icon: Users
  },
  {
    value: 'monitoring',
    labelKey: 'sectionMonitoring',
    icon: Activity
  }
]

export const RIGHT_PANEL_DEFAULT_TAB_BY_SECTION: Record<RightPanelSection, RightPanelTab> = {
  execution: 'steps',
  resources: 'files',
  collaboration: 'team',
  monitoring: 'context'
}

export const RIGHT_PANEL_TAB_TO_SECTION: Record<RightPanelTab, RightPanelSection> =
  RIGHT_PANEL_TAB_DEFS.reduce(
    (acc, tabDef) => {
      acc[tabDef.value] = tabDef.section
      return acc
    },
    {} as Record<RightPanelTab, RightPanelSection>
  )

export function clampLeftSidebarWidth(width: number): number {
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, width))
}

export function clampRightPanelWidth(width: number): number {
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, width))
}
