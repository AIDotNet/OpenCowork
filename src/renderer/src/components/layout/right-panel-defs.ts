import type { RightPanelTabKind } from '@renderer/stores/ui-store'

export const LEFT_SIDEBAR_DEFAULT_WIDTH = 292
export const LEFT_SIDEBAR_MIN_WIDTH = 272
export const LEFT_SIDEBAR_MAX_WIDTH = 420

export const RIGHT_PANEL_DEFAULT_WIDTH = 384
export const RIGHT_PANEL_MIN_WIDTH = 280
export const RIGHT_PANEL_MAX_WIDTH = Number.POSITIVE_INFINITY
// The right panel must never occupy more than 80% of the viewport width.
export const RIGHT_PANEL_MAX_WIDTH_RATIO = 0.8
export const RIGHT_PANEL_RAIL_WIDTH = 48
export const RIGHT_PANEL_RAIL_SLIM_WIDTH = 12
export const WORKING_FOLDER_PANEL_DEFAULT_WIDTH = 420
export const WORKING_FOLDER_PANEL_MIN_WIDTH = 280
export const WORKING_FOLDER_PANEL_MAX_WIDTH = 560
export const BOTTOM_TERMINAL_DOCK_DEFAULT_HEIGHT = 220
export const BOTTOM_TERMINAL_DOCK_MIN_HEIGHT = 160
export const BOTTOM_TERMINAL_DOCK_MAX_HEIGHT = 560

export const RIGHT_PANEL_TAB_ORDER: RightPanelTabKind[] = [
  'review',
  'preview',
  'browser',
  'subagent',
  'terminal'
]

export function clampLeftSidebarWidth(width: number): number {
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, width))
}

export function clampRightPanelWidth(width: number): number {
  const viewportMax =
    typeof window !== 'undefined' && window.innerWidth > 0
      ? window.innerWidth * RIGHT_PANEL_MAX_WIDTH_RATIO
      : RIGHT_PANEL_MAX_WIDTH
  const maxWidth = Math.min(RIGHT_PANEL_MAX_WIDTH, viewportMax)
  return Math.min(maxWidth, Math.max(RIGHT_PANEL_MIN_WIDTH, width))
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
