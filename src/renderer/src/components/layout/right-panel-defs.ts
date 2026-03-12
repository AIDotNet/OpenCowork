import {
  Activity,
  ClipboardList,
  Database,
  FileOutput,
  FolderTree,
  ListChecks,
  Sparkles,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { RightPanelSection, RightPanelTab } from '@renderer/stores/ui-store'

export const RIGHT_PANEL_DEFAULT_WIDTH = 384
export const RIGHT_PANEL_MIN_WIDTH = 320
export const RIGHT_PANEL_MAX_WIDTH = 760

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
  { value: 'artifacts', labelKey: 'artifacts', section: 'resources', icon: FileOutput },
  { value: 'team', labelKey: 'team', section: 'collaboration', icon: Users },
  { value: 'skills', labelKey: 'skills', section: 'collaboration', icon: Sparkles },
  { value: 'context', labelKey: 'context', section: 'monitoring', icon: Database },
]

export const RIGHT_PANEL_TAB_ORDER: RightPanelTab[] = RIGHT_PANEL_TAB_DEFS.map((tab) => tab.value)

export const RIGHT_PANEL_SECTION_DEFS: RightPanelSectionDef[] = [
  {
    value: 'execution',
    labelKey: 'sectionExecution',
    icon: Workflow,
  },
  {
    value: 'resources',
    labelKey: 'sectionResources',
    icon: FolderTree,
  },
  {
    value: 'collaboration',
    labelKey: 'sectionCollaboration',
    icon: Users,
  },
  {
    value: 'monitoring',
    labelKey: 'sectionMonitoring',
    icon: Activity,
  },
]

export const RIGHT_PANEL_DEFAULT_TAB_BY_SECTION: Record<RightPanelSection, RightPanelTab> = {
  execution: 'steps',
  resources: 'files',
  collaboration: 'team',
  monitoring: 'context',
}

export const RIGHT_PANEL_TAB_TO_SECTION: Record<RightPanelTab, RightPanelSection> =
  RIGHT_PANEL_TAB_DEFS.reduce(
    (acc, tabDef) => {
      acc[tabDef.value] = tabDef.section
      return acc
    },
    {} as Record<RightPanelTab, RightPanelSection>
  )

export function clampRightPanelWidth(width: number): number {
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, width))
}
