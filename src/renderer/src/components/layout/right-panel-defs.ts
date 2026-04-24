import {
  Activity,
  Database,
  FileOutput,
  Globe,
  Monitor,
  Users,
  Bot,
  Workflow,
  type LucideIcon
} from 'lucide-react'
import type { RightPanelSection, RightPanelTab } from '@renderer/stores/ui-store'

export const LEFT_SIDEBAR_DEFAULT_WIDTH = 292
export const LEFT_SIDEBAR_MIN_WIDTH = 272
export const LEFT_SIDEBAR_MAX_WIDTH = 420

export const RIGHT_PANEL_DEFAULT_WIDTH = 384
export const RIGHT_PANEL_MIN_WIDTH = 320
export const RIGHT_PANEL_MAX_WIDTH = Number.POSITIVE_INFINITY
export const RIGHT_PANEL_MAX_WIDTH_RATIO = 0.5
export const RIGHT_PANEL_RAIL_WIDTH = 48
export const RIGHT_PANEL_RAIL_SLIM_WIDTH = 12
export const WORKING_FOLDER_PANEL_DEFAULT_WIDTH = 420
export const WORKING_FOLDER_PANEL_MIN_WIDTH = 280
export const WORKING_FOLDER_PANEL_MAX_WIDTH = 560
export const BOTTOM_TERMINAL_DOCK_DEFAULT_HEIGHT = 220
export const BOTTOM_TERMINAL_DOCK_MIN_HEIGHT = 160
export const BOTTOM_TERMINAL_DOCK_MAX_HEIGHT = 560

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
  { value: 'preview', labelKey: 'preview', section: 'resources', icon: Monitor },
  { value: 'browser', labelKey: 'browser', section: 'resources', icon: Globe },
  { value: 'artifacts', labelKey: 'artifacts', section: 'resources', icon: FileOutput },
  { value: 'orchestration', labelKey: 'orchestration', section: 'collaboration', icon: Users },
  { value: 'subagents', labelKey: 'subagents', section: 'collaboration', icon: Bot },
  { value: 'team', labelKey: 'team', section: 'collaboration', icon: Users },
  { value: 'context', labelKey: 'context', section: 'monitoring', icon: Database }
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
    icon: Monitor
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
  execution: 'plan',
  resources: 'preview',
  collaboration: 'orchestration',
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

export function clampWorkingFolderPanelWidth(width: number): number {
  return Math.min(WORKING_FOLDER_PANEL_MAX_WIDTH, Math.max(WORKING_FOLDER_PANEL_MIN_WIDTH, width))
}

export function clampBottomTerminalDockHeight(
  height: number,
  maxHeight = BOTTOM_TERMINAL_DOCK_MAX_HEIGHT
): number {
  return Math.min(maxHeight, Math.max(BOTTOM_TERMINAL_DOCK_MIN_HEIGHT, height))
}
