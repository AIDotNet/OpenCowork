// Extracted from the former monolithic ssh-store.ts; behavior unchanged.
import type { StateCreator } from 'zustand'
import type { SshWorkspaceSection } from './types'
import type { SshStore } from './store'

export interface SshUiSlice {
  connectionListViewMode: 'table' | 'card'
  setConnectionListViewMode: (mode: 'table' | 'card') => void
  workspaceSection: SshWorkspaceSection
  setWorkspaceSection: (section: SshWorkspaceSection) => void
  detailConnectionId: string | null
  setDetailConnectionId: (id: string | null) => void
  inspectorMode: 'create' | 'edit'
  setInspectorMode: (mode: 'create' | 'edit') => void
}

export const createUiSlice: StateCreator<SshStore, [], [], SshUiSlice> = (set) => ({
  connectionListViewMode: 'card',
  setConnectionListViewMode: (mode) => set({ connectionListViewMode: mode }),
  workspaceSection: 'hosts',
  setWorkspaceSection: (section) => set({ workspaceSection: section }),
  detailConnectionId: null,
  setDetailConnectionId: (id) => set({ detailConnectionId: id }),
  inspectorMode: 'edit',
  setInspectorMode: (mode) => set({ inspectorMode: mode })
})
