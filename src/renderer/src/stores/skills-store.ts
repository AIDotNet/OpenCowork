import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export interface SkillInfo {
  name: string
  description: string
}

export interface ScanFileInfo {
  name: string
  size: number
  type: string
}

export interface RiskItem {
  severity: 'safe' | 'warning' | 'danger'
  category: string
  detail: string
  file: string
  line?: number
}

export interface ScanResult {
  name: string
  description: string
  files: ScanFileInfo[]
  risks: RiskItem[]
  skillMdContent: string
  scriptContents: { file: string; content: string }[]
}

export type SkillsTab = 'market' | 'installed'

export interface MarketSkillInfo {
  id: string
  name: string
  owner: string
  repo: string
  rank: number
  installs: number
  url: string
  github: string
  description?: string
  source_path?: string
}

interface SkillsStore {
  skills: SkillInfo[]
  loading: boolean
  selectedSkill: string | null
  skillContent: string | null
  skillFiles: ScanFileInfo[]
  searchQuery: string
  activeTab: SkillsTab

  // Market state
  marketSkills: MarketSkillInfo[]
  marketTotal: number
  marketLoading: boolean
  marketQuery: string
  marketOffset: number

  // Editing state
  editing: boolean
  editContent: string | null

  // Install dialog state
  installDialogOpen: boolean
  installSourcePath: string | null
  installScanResult: ScanResult | null
  scanning: boolean
  installing: boolean

  // Agent review state
  agentReviewText: string
  agentReviewDone: boolean
  agentReviewPassed: boolean | null

  // Actions
  loadSkills: () => Promise<void>
  setSearchQuery: (query: string) => void
  setActiveTab: (tab: SkillsTab) => void
  selectSkill: (name: string | null) => void
  readSkill: (name: string) => Promise<void>
  loadSkillFiles: (name: string) => Promise<void>
  deleteSkill: (name: string) => Promise<boolean>
  openSkillFolder: (name: string) => Promise<void>
  addSkillFromFolder: (sourcePath: string) => Promise<{ success: boolean; name?: string; error?: string }>

  // Market actions
  loadMarketSkills: (query?: string, reset?: boolean) => Promise<void>
  loadMoreMarketSkills: () => Promise<void>
  setMarketQuery: (query: string) => void
  downloadAndReviewMarketSkill: (skill: MarketSkillInfo) => Promise<void>

  // Edit actions
  setEditing: (editing: boolean) => void
  setEditContent: (content: string | null) => void
  saveSkill: (name: string, content: string) => Promise<boolean>

  // Install dialog actions
  openInstallDialog: (sourcePath: string) => void
  closeInstallDialog: () => void
  scanSkill: (sourcePath: string) => Promise<ScanResult | null>
  confirmInstall: () => Promise<{ success: boolean; name?: string; error?: string }>
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  skills: [],
  loading: false,
  selectedSkill: null,
  skillContent: null,
  skillFiles: [],
  searchQuery: '',
  activeTab: 'market',

  // Market state
  marketSkills: [],
  marketTotal: 0,
  marketLoading: false,
  marketQuery: '',
  marketOffset: 0,

  editing: false,
  editContent: null,

  installDialogOpen: false,
  installSourcePath: null,
  installScanResult: null,
  scanning: false,
  installing: false,

  agentReviewText: '',
  agentReviewDone: false,
  agentReviewPassed: null,

  loadSkills: async () => {
    set({ loading: true })
    try {
      const result = (await ipcClient.invoke('skills:list')) as SkillInfo[]
      set({ skills: Array.isArray(result) ? result : [] })
    } catch {
      set({ skills: [] })
    } finally {
      set({ loading: false })
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  setActiveTab: (tab) =>
    set({ activeTab: tab, selectedSkill: null, skillContent: null, skillFiles: [], editing: false, editContent: null }),

  selectSkill: (name) => {
    set({ selectedSkill: name, skillContent: null, skillFiles: [], editing: false, editContent: null })
    if (name) {
      get().readSkill(name)
      get().loadSkillFiles(name)
    }
  },

  readSkill: async (name) => {
    try {
      const result = (await ipcClient.invoke('skills:read', { name })) as { content?: string; error?: string }
      if (result.content) set({ skillContent: result.content })
    } catch {
      set({ skillContent: null })
    }
  },

  loadSkillFiles: async (name) => {
    try {
      const result = (await ipcClient.invoke('skills:list-files', { name })) as { files?: ScanFileInfo[]; error?: string }
      if (result.files) set({ skillFiles: result.files })
    } catch {
      set({ skillFiles: [] })
    }
  },

  deleteSkill: async (name) => {
    try {
      const result = (await ipcClient.invoke('skills:delete', { name })) as { success: boolean }
      if (result.success) {
        const state = get()
        set({
          skills: state.skills.filter((s) => s.name !== name),
          selectedSkill: state.selectedSkill === name ? null : state.selectedSkill,
          skillContent: state.selectedSkill === name ? null : state.skillContent,
          skillFiles: state.selectedSkill === name ? [] : state.skillFiles,
        })
        return true
      }
      return false
    } catch {
      return false
    }
  },

  openSkillFolder: async (name) => {
    try {
      await ipcClient.invoke('skills:open-folder', { name })
    } catch {
      // ignore
    }
  },

  addSkillFromFolder: async (sourcePath) => {
    try {
      const result = (await ipcClient.invoke('skills:add-from-folder', { sourcePath })) as {
        success: boolean
        name?: string
        error?: string
      }
      if (result.success) await get().loadSkills()
      return result
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },

  // Market actions
  loadMarketSkills: async (query, reset) => {
    const q = query ?? get().marketQuery
    const offset = reset ? 0 : get().marketOffset
    set({ marketLoading: true, marketQuery: q })
    try {
      const { useSettingsStore } = await import('@renderer/stores/settings-store')
      const { skillsMarketApiKey } = useSettingsStore.getState()
      const result = (await ipcClient.invoke('skills:market-list', {
        offset,
        limit: 50,
        query: q,
        provider: 'skillsmp',
        apiKey: skillsMarketApiKey,
      })) as {
        total: number
        skills: MarketSkillInfo[]
      }
      set({
        marketSkills: reset || offset === 0 ? result.skills : [...get().marketSkills, ...result.skills],
        marketTotal: result.total,
        marketOffset: (reset ? 0 : offset) + result.skills.length,
      })
    } catch {
      if (reset || offset === 0) set({ marketSkills: [], marketTotal: 0 })
    } finally {
      set({ marketLoading: false })
    }
  },

  loadMoreMarketSkills: async () => {
    const state = get()
    if (state.marketLoading || state.marketSkills.length >= state.marketTotal) return
    await state.loadMarketSkills(state.marketQuery, false)
  },

  setMarketQuery: (query) => {
    set({ marketQuery: query, marketOffset: 0 })
    get().loadMarketSkills(query, true)
  },

  downloadAndReviewMarketSkill: async (skill) => {
    set({ installDialogOpen: true, installSourcePath: null, installScanResult: null, scanning: true, installing: false, agentReviewText: '', agentReviewDone: false, agentReviewPassed: null })

    try {
      const { useSettingsStore } = await import('@renderer/stores/settings-store')
      const { skillsMarketApiKey } = useSettingsStore.getState()
      // Download from remote API
      const downloadResult = (await ipcClient.invoke('skills:download-remote', {
        owner: skill.owner,
        repo: skill.repo,
        name: skill.name,
        provider: 'skillsmp',
        apiKey: skillsMarketApiKey,
        skillId: skill.id,
        sourcePath: skill.source_path,
        github: skill.github,
      })) as { tempPath?: string; files?: { path: string; content: string }[]; error?: string }

      if (downloadResult.error || !downloadResult.tempPath) {
        console.error('[Skills] Download error:', downloadResult.error)
        set({ scanning: false })
        return
      }

      // Run regex scan first (fast preliminary check)
      const scanResult = (await ipcClient.invoke('skills:scan', { sourcePath: downloadResult.tempPath })) as ScanResult | { error: string }
      if ('error' in scanResult) {
        console.error('[Skills] Scan error:', scanResult.error)
        set({ scanning: false })
        await ipcClient.invoke('skills:cleanup-temp', { tempPath: downloadResult.tempPath })
        return
      }

      // Run agent security review
      set({ scanning: false, agentReviewDone: false })
      try {
        const { runSkillSecurityReview } = await import('@renderer/lib/agent/skill-reviewer')
        const { useSettingsStore } = await import('@renderer/stores/settings-store')
        const settingsState = useSettingsStore.getState()

        const providerConfig = {
          type: settingsState.provider,
          apiKey: settingsState.apiKey,
          baseUrl: settingsState.baseUrl,
          model: settingsState.model,
          maxTokens: settingsState.maxTokens,
          temperature: settingsState.temperature,
        }

        if (!settingsState.apiKey) {
          console.warn('[Skills] No API key configured, skipping agent review')
          set({
            installScanResult: scanResult,
            installSourcePath: downloadResult.tempPath,
            agentReviewDone: true,
            agentReviewPassed: scanResult.risks.length === 0,
          })
        } else {
          const agentRisks = await runSkillSecurityReview(
            skill.name,
            downloadResult.files || [],
            providerConfig,
            new AbortController().signal,
            (text) => set({ agentReviewText: text })
          )

          // Merge agent risks with regex risks
          const mergedRisks = [...scanResult.risks, ...agentRisks]
          const hasDanger = mergedRisks.some((r) => r.severity === 'danger')

          set({
            installScanResult: { ...scanResult, risks: mergedRisks },
            installSourcePath: downloadResult.tempPath,
            agentReviewDone: true,
            agentReviewPassed: !hasDanger,
          })
        }
      } catch (err) {
        console.error('[Skills] Agent review failed:', err)
        set({
          installScanResult: scanResult,
          installSourcePath: downloadResult.tempPath,
          agentReviewDone: true,
          agentReviewPassed: scanResult.risks.length === 0,
        })
      }
    } catch (err) {
      console.error('[Skills] Download failed:', err)
      set({ scanning: false })
    }
  },

  // Edit actions
  setEditing: (editing) => {
    const state = get()
    if (editing && state.skillContent) {
      set({ editing: true, editContent: state.skillContent })
    } else {
      set({ editing: false, editContent: null })
    }
  },

  setEditContent: (content) => set({ editContent: content }),

  saveSkill: async (name, content) => {
    try {
      const result = (await ipcClient.invoke('skills:save', { name, content })) as { success: boolean; error?: string }
      if (result.success) {
        set({ skillContent: content, editing: false, editContent: null })
        return true
      }
      return false
    } catch {
      return false
    }
  },

  // Install dialog actions
  openInstallDialog: (sourcePath) => {
    set({ installDialogOpen: true, installSourcePath: sourcePath, installScanResult: null, scanning: true, installing: false })
    get().scanSkill(sourcePath)
  },

  closeInstallDialog: () => {
    const state = get()
    if (state.installSourcePath && state.installSourcePath.includes('opencowork-skills')) {
      void ipcClient.invoke('skills:cleanup-temp', { tempPath: state.installSourcePath })
    }
    set({ installDialogOpen: false, installSourcePath: null, installScanResult: null, scanning: false, installing: false, agentReviewText: '', agentReviewDone: false, agentReviewPassed: null })
  },

  scanSkill: async (sourcePath) => {
    set({ scanning: true })
    try {
      const result = (await ipcClient.invoke('skills:scan', { sourcePath })) as ScanResult | { error: string }
      if ('error' in result) {
        set({ scanning: false })
        return null
      }
      set({ installScanResult: result, scanning: false })
      return result
    } catch {
      set({ scanning: false })
      return null
    }
  },

  confirmInstall: async () => {
    const state = get()
    if (!state.installSourcePath) return { success: false, error: 'No source path' }
    set({ installing: true })
    try {
      const result = await state.addSkillFromFolder(state.installSourcePath)
      if (result.success) {
        // Clean up temp directory if it's a downloaded skill
        if (state.installSourcePath.includes('opencowork-skills')) {
          await ipcClient.invoke('skills:cleanup-temp', { tempPath: state.installSourcePath })
        }

        // Switch to installed tab and select the newly installed skill
        set({
          installDialogOpen: false,
          installSourcePath: null,
          installScanResult: null,
          installing: false,
          activeTab: 'installed',
          selectedSkill: result.name || null,
          agentReviewText: '',
          agentReviewDone: false,
          agentReviewPassed: null,
        })

        // Load the newly installed skill's content
        if (result.name) {
          get().readSkill(result.name)
          get().loadSkillFiles(result.name)
        }
      } else {
        set({ installing: false })
      }
      return result
    } catch (err) {
      set({ installing: false })
      return { success: false, error: String(err) }
    }
  },
}))
