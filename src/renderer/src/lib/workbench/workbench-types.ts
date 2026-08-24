import type React from 'react'
import type { ResourceUri } from '../../../../shared/workbench/uri'

export type PaneCapability =
  | 'canSplit'
  | 'hasAuxiliaryDrawer'
  | 'supportsBreadcrumb'
  | 'supportsDirtyState'
  | 'persistentWhenHidden'

export type WorkbenchTabKind =
  | 'review'
  | 'files'
  | 'preview'
  | 'browser'
  | 'subagent'
  | 'terminal'
  | 'context'
  | 'custom'

export interface IWorkbenchTab {
  id: string
  uri: ResourceUri
  kind: WorkbenchTabKind
  title: string
  closable: boolean
  pinned?: boolean
  modified?: boolean
  icon?: string | React.ReactNode
  sessionId?: string | null
  projectId?: string | null
  initialChangeId?: string | null
  selectionRequestId?: number
  toolUseId?: string | null
  inlineText?: string | null
  processId?: string
  terminalSource?: 'local' | 'ssh'
  localTabId?: string
  sshTabId?: string
  previewTabId?: string
  filePath?: string
  viewMode?: 'preview' | 'code' | 'split'
  createdAt: number
}

export interface IEditorPaneProps {
  tab: IWorkbenchTab
  isActive: boolean
  auxiliaryDrawerOpen?: boolean
  onToggleAuxiliaryDrawer?: () => void
}

export interface IEditorPaneDescriptor {
  typeId: string
  schemes: string[]
  priority?: number
  capabilities: PaneCapability[]
  component: React.ComponentType<IEditorPaneProps>
}

export interface IWorkbenchAction {
  id: string
  label: string
  icon?: React.ReactNode
  variant?: 'default' | 'ghost' | 'outline' | 'primary' | 'destructive'
  tooltip?: string
  disabled?: boolean
  active?: boolean
  onClick: (context: { tab: IWorkbenchTab }) => void | Promise<void>
}

export interface IContextActionProvider {
  typeId: string
  provideLeadingActions?: (tab: IWorkbenchTab) => React.ReactNode
  provideTrailingActions?: (tab: IWorkbenchTab) => IWorkbenchAction[]
}

export interface IAuxiliaryDrawerProps {
  tab: IWorkbenchTab
  onClose: () => void
}

export interface IAuxiliaryDrawerProvider {
  typeId: string
  title: string
  icon?: React.ReactNode
  component: React.ComponentType<IAuxiliaryDrawerProps>
}

export interface ITextDocumentContentProvider {
  scheme: string
  provideTextDocumentContent(uri: ResourceUri, signal?: AbortSignal): Promise<string>
  onDidChange?: (listener: (uri: ResourceUri) => void) => { dispose(): void }
}
