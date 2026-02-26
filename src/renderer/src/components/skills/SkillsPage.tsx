import { useEffect, useMemo, useState, useCallback } from 'react'
import { Search, FolderOpen, Trash2, Plus, Wand2, ArrowLeft, Pencil, Eye, Save, Download, FileText, FileCode, CheckCircle2, Loader2, Settings2, ExternalLink, AlertCircle, KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useSkillsStore, type ScanFileInfo, type MarketSkillInfo } from '@renderer/stores/skills-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { SkillInstallDialog } from './SkillInstallDialog'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileIcon({ type }: { type: string }): React.JSX.Element {
  const codeExts = new Set(['.py', '.js', '.ts', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.rb', '.pl'])
  if (type === '.md') return <FileText className="size-3.5 text-blue-500" />
  if (codeExts.has(type)) return <FileCode className="size-3.5 text-amber-500" />
  return <FileText className="size-3.5 text-muted-foreground" />
}

function FileListSection({ files, t }: { files: ScanFileInfo[]; t: (key: string) => string }): React.JSX.Element {
  if (files.length === 0) {
    return <p className="text-xs text-muted-foreground px-1">{t('skillsPage.noFiles')}</p>
  }
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  return (
    <div className="space-y-1">
      <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
        {t('skillsPage.skillFiles')} ({files.length}, {formatSize(totalSize)})
      </h4>
      <div className="space-y-0 max-h-48 overflow-y-auto">
        {files.map((file) => (
          <div key={file.name} className="flex items-center gap-2 text-xs px-1 py-0.5 rounded hover:bg-muted/50">
            <FileIcon type={file.type} />
            <span className="flex-1 truncate font-mono text-[11px]">{file.name}</span>
            <span className="text-muted-foreground text-[10px] shrink-0">{formatSize(file.size)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Market skill card ──────────────────────────────────────────────

function MarketSkillCard({
  skill,
  installed,
  onInstall,
}: {
  skill: MarketSkillInfo
  installed: boolean
  onInstall: () => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <div className="rounded-lg border bg-card p-4 hover:shadow-md transition-shadow flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold truncate">{skill.name}</h3>
          <p className="text-xs text-muted-foreground">{skill.owner}/{skill.repo}</p>
        </div>
        <div className="size-8 shrink-0 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 border border-border/60 flex items-center justify-center">
          <Wand2 className="size-4 text-primary/70" />
        </div>
      </div>

      {/* Description */}
      {skill.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-3 flex-1">{skill.description}</p>
      )}

      {/* Stats */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground mb-3 py-2 border-t border-b">
        <div className="flex items-center gap-1">
          <Download className="size-3" />
          <span>{skill.installs}</span>
        </div>
        <div className="flex items-center gap-1">
          <Wand2 className="size-3" />
          <span>Rank #{skill.rank}</span>
        </div>
      </div>

      {/* Action */}
      <div className="mt-auto">
        {installed ? (
          <Badge variant="secondary" className="w-full justify-center gap-1 text-[11px]">
            <CheckCircle2 className="size-3" />
            {t('skillsPage.alreadyInstalled')}
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="default"
            className="w-full gap-1.5 text-xs"
            onClick={onInstall}
          >
            <Download className="size-3" />
            {t('skillsPage.install')}
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Market Provider Config Popover ──────────────────────────────────────────
function MarketProviderConfig(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const provider = useSettingsStore((s) => s.skillsMarketProvider)
  const apiKey = useSettingsStore((s) => s.skillsMarketApiKey)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const loadMarketSkills = useSkillsStore((s) => s.loadMarketSkills)

  const handleProviderChange = useCallback((value: 'builtin' | 'skillsmp') => {
    updateSettings({ skillsMarketProvider: value })
    // Reload after a tick so store update propagates
    setTimeout(() => void loadMarketSkills('', true), 50)
  }, [updateSettings, loadMarketSkills])

  const handleApiKeyChange = useCallback((value: string) => {
    updateSettings({ skillsMarketApiKey: value })
  }, [updateSettings])

  const handleReload = useCallback(() => {
    void loadMarketSkills('', true)
  }, [loadMarketSkills])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
        >
          <Settings2 className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-4 space-y-4">
        <div>
          <p className="text-sm font-semibold">{t('skillsmarket.title')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('skillsmarket.providerDesc')}</p>
        </div>

        {/* Provider selector */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium">{t('skillsmarket.provider')}</label>
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skillsmp" className="text-xs">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">SkillsMP</span>
                  <span className="text-[10px] text-muted-foreground">{t('skillsmarket.skillsmpDesc')}</span>
                </div>
              </SelectItem>
              <SelectItem value="builtin" className="text-xs">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{t('skillsmarket.builtinLabel')}</span>
                  <span className="text-[10px] text-muted-foreground">{t('skillsmarket.builtinDesc')}</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* API Key — only for skillsmp */}
        {provider === 'skillsmp' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium flex items-center gap-1">
                <KeyRound className="size-3" />
                {t('skillsmarket.apiKey')}
              </label>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-[10px] text-primary"
                onClick={() => window.open('https://skillsmp.com', '_blank', 'noopener')}
              >
                {t('skillsmarket.getApiKey')} <ExternalLink className="ml-0.5 size-2.5" />
              </Button>
            </div>
            <Input
              type="password"
              placeholder={t('skillsmarket.apiKeyPlaceholder')}
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        )}

        <Button
          size="sm"
          variant="outline"
          className="w-full h-7 text-xs gap-1.5"
          onClick={handleReload}
        >
          <Loader2 className="size-3" />
          {t('skillsmarket.test')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function SkillsPage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const skills = useSkillsStore((s) => s.skills)
  const loading = useSkillsStore((s) => s.loading)
  const selectedSkill = useSkillsStore((s) => s.selectedSkill)
  const skillContent = useSkillsStore((s) => s.skillContent)
  const skillFiles = useSkillsStore((s) => s.skillFiles)
  const activeTab = useSkillsStore((s) => s.activeTab)
  const editing = useSkillsStore((s) => s.editing)
  const editContent = useSkillsStore((s) => s.editContent)
  const marketSkills = useSkillsStore((s) => s.marketSkills)
  const marketLoading = useSkillsStore((s) => s.marketLoading)
  const marketQuery = useSkillsStore((s) => s.marketQuery)
  const marketTotal = useSkillsStore((s) => s.marketTotal)
  const loadSkills = useSkillsStore((s) => s.loadSkills)
  const loadMarketSkills = useSkillsStore((s) => s.loadMarketSkills)
  const loadMoreMarketSkills = useSkillsStore((s) => s.loadMoreMarketSkills)
  const selectSkill = useSkillsStore((s) => s.selectSkill)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const setEditing = useSkillsStore((s) => s.setEditing)
  const setEditContent = useSkillsStore((s) => s.setEditContent)
  const setMarketQuery = useSkillsStore((s) => s.setMarketQuery)

  // Skills market provider settings
  const marketProvider = useSettingsStore((s) => s.skillsMarketProvider)
  const marketApiKey = useSettingsStore((s) => s.skillsMarketApiKey)

  // Installed tab search
  const [installedQuery, setInstalledQuery] = useState('')

  useEffect(() => {
    void loadSkills()
    void loadMarketSkills('', true)
  }, [loadSkills, loadMarketSkills])

  const installedNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills])

  const filteredInstalled = useMemo(() => {
    if (!installedQuery.trim()) return skills
    const q = installedQuery.toLowerCase()
    return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [skills, installedQuery])

  const handleAddSkill = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as { canceled?: boolean; path?: string }
    if (result.canceled || !result.path) return
    useSkillsStore.getState().openInstallDialog(result.path)
  }

  const handleInstallMarket = (skill: MarketSkillInfo): void => {
    void useSkillsStore.getState().downloadAndReviewMarketSkill(skill)
  }

  const handleDelete = async (name: string): Promise<void> => {
    const ok = await confirm({ title: t('skillsPage.deleteConfirm', { name }), variant: 'destructive' })
    if (!ok) return
    const success = await useSkillsStore.getState().deleteSkill(name)
    toast[success ? 'success' : 'error'](success ? t('skillsPage.deleted', { name }) : t('skillsPage.deleteFailed'))
  }

  const handleSave = async (): Promise<void> => {
    if (!selectedSkill || !editContent) return
    const success = await useSkillsStore.getState().saveSkill(selectedSkill, editContent)
    toast[success ? 'success' : 'error'](success ? t('skillsPage.saved') : t('skillsPage.saveFailed'))
  }

  const handleBack = (): void => useUIStore.getState().closeSkillsPage()

  // ── Shared top bar ──────────────────────────────────────────────────────────
  const TopBar = (
    <div className="flex items-center gap-3 border-b px-4 py-2.5 shrink-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleBack}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Back</TooltipContent>
      </Tooltip>

      {/* Tab switcher */}
      <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {(['market', 'installed'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-all',
              activeTab === tab ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`skillsPage.${tab}`)}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* Search — context-aware */}
      <div className="relative w-56">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        {activeTab === 'market' ? (
          <Input
            value={marketQuery}
            onChange={(e) => setMarketQuery(e.target.value)}
            placeholder={t('skillsPage.searchPlaceholder')}
            className="h-8 pl-8 text-xs"
          />
        ) : (
          <Input
            value={installedQuery}
            onChange={(e) => setInstalledQuery(e.target.value)}
            placeholder={t('skillsPage.searchPlaceholder')}
            className="h-8 pl-8 text-xs"
          />
        )}
      </div>

      {activeTab === 'market' && <MarketProviderConfig />}

      {activeTab === 'installed' && (
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => void handleAddSkill()}>
          <Plus className="size-3.5" />
          {t('skillsPage.addSkill')}
        </Button>
      )}
    </div>
  )

  // ── MARKET TAB — full-width grid ─────────────────────────────────────
  if (activeTab === 'market') {
    const needsApiKey = marketProvider === 'skillsmp' && !marketApiKey

    return (
      <div className="flex h-full flex-col">
        {TopBar}

        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Hero */}
          <div className="px-8 pt-8 pb-5 border-b shrink-0">
            <div className="flex items-end gap-3 mb-1">
              <h1 className="text-3xl font-bold tracking-tight">SKILLS</h1>
              <span className="text-sm text-muted-foreground mb-1">{t('skillsPage.skillCount', { count: marketSkills.length })}</span>
            </div>
            <p className="text-sm text-muted-foreground">{t('skillsPage.marketDescription')}</p>

            {/* API key missing banner */}
            {needsApiKey && (
              <div className="mt-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <AlertCircle className="size-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{t('skillsPage.noApiKeyTitle')}</p>
                  <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70 mt-0.5">{t('skillsPage.noApiKeyDesc')}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs shrink-0 border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
                  onClick={() => window.open('https://skillsmp.com', '_blank', 'noopener')}
                >
                  <ExternalLink className="size-3 mr-1" />
                  {t('skillsPage.getApiKey')}
                </Button>
              </div>
            )}
          </div>

          {/* Grid */}
          <div className="flex-1 overflow-y-auto p-8">
            {marketLoading && marketSkills.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                <Wand2 className="size-4 mr-2 animate-pulse" /> Loading...
              </div>
            ) : marketSkills.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <Wand2 className="size-10 text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground">{t('skillsPage.noResults')}</p>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {marketSkills.map((ms) => (
                    <MarketSkillCard
                      key={ms.id}
                      skill={ms}
                      installed={installedNames.has(ms.name)}
                      onInstall={() => handleInstallMarket(ms)}
                    />
                  ))}
                </div>

                {/* Load More */}
                {marketSkills.length < marketTotal && (
                  <div className="flex items-center justify-center py-4">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void loadMoreMarketSkills()}
                      disabled={marketLoading}
                    >
                      {marketLoading ? (
                        <><Loader2 className="size-3.5 animate-spin mr-2" />Loading...</>
                      ) : (
                        `Load More (${marketSkills.length}/${marketTotal})`
                      )}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <SkillInstallDialog />
      </div>
    )
  }

  // ── INSTALLED TAB — split panel ─────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      {TopBar}

      <div className="flex flex-1 overflow-hidden">
        {/* Left list */}
        <div className="flex w-64 shrink-0 flex-col border-r bg-muted/20 overflow-hidden">
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">Loading...</div>
            ) : filteredInstalled.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
                <Wand2 className="size-8 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">{skills.length === 0 ? t('skillsPage.noSkills') : t('skillsPage.noResults')}</p>
                {skills.length === 0 && <p className="text-[10px] text-muted-foreground/60">{t('skillsPage.noSkillsDesc')}</p>}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {filteredInstalled.map((skill) => (
                  <button
                    key={skill.name}
                    onClick={() => selectSkill(skill.name)}
                    className={cn(
                      'flex flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
                      selectedSkill === skill.name ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'
                    )}
                  >
                    <span className="text-xs font-medium truncate">{skill.name}</span>
                    <span className="text-[10px] text-muted-foreground line-clamp-2">{skill.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right detail */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {selectedSkill ? (
            <>
              <div className="flex items-center gap-2 border-b px-4 py-3 shrink-0">
                <Wand2 className="size-4 shrink-0 text-primary" />
                <h2 className="flex-1 text-sm font-semibold truncate">{selectedSkill}</h2>
                <div className="flex items-center gap-1">
                  {editing ? (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7" onClick={() => setEditing(false)}>
                            <Eye className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('skillsPage.previewMode')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="default" size="icon" className="size-7" onClick={() => void handleSave()}>
                            <Save className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('skillsPage.save')}</TooltipContent>
                      </Tooltip>
                    </>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-7" onClick={() => setEditing(true)}>
                          <Pencil className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('skillsPage.editMode')}</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => void useSkillsStore.getState().openSkillFolder(selectedSkill)}>
                        <FolderOpen className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('skillsPage.openFolder')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" onClick={() => void handleDelete(selectedSkill)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('skillsPage.delete')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                {editing && editContent !== null ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full h-full resize-none border-0 bg-transparent p-4 text-xs leading-relaxed font-mono focus:outline-none"
                    spellCheck={false}
                  />
                ) : skillContent ? (
                  <div className="p-4 space-y-4">
                    <pre className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90 font-mono">{skillContent}</pre>
                    {skillFiles.length > 0 && (
                      <div className="border-t pt-4">
                        <FileListSection files={skillFiles} t={t} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">Loading...</div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <Wand2 className="size-10 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">{t('skillsPage.selectSkill')}</p>
              <p className="text-xs text-muted-foreground/60">{t('skillsPage.selectSkillDesc')}</p>
            </div>
          )}
        </div>
      </div>

      <SkillInstallDialog />
    </div>
  )
}
