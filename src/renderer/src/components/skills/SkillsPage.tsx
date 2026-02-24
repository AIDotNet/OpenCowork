import { useEffect, useMemo, useState } from 'react'
import { Search, FolderOpen, Trash2, Plus, Wand2, ArrowLeft, Pencil, Eye, Save, Download, FileText, FileCode, CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useSkillsStore, type ScanFileInfo, type SkillInfo } from '@renderer/stores/skills-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
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

// ── Market leaderboard row ──────────────────────────────────────────────────

function MarketRow({
  rank,
  skill,
  installed,
  onInstall,
  onSelect,
  selected,
}: {
  rank: number
  skill: SkillInfo
  installed: boolean
  onInstall: () => void
  onSelect: () => void
  selected: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-4 px-6 py-3.5 border-b border-border/50 cursor-pointer transition-colors',
        selected ? 'bg-primary/5' : 'hover:bg-muted/40'
      )}
    >
      {/* Rank */}
      <span className="w-6 shrink-0 text-center text-sm font-mono text-muted-foreground/50 select-none">
        {rank}
      </span>

      {/* Icon placeholder */}
      <div className="size-9 shrink-0 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 border border-border/60 flex items-center justify-center">
        <Wand2 className="size-4 text-primary/70" />
      </div>

      {/* Name + description */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-tight truncate">{skill.name}</p>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{skill.description}</p>
      </div>

      {/* Action */}
      <div className="shrink-0 flex items-center gap-2">
        {installed ? (
          <Badge variant="secondary" className="gap-1 text-[11px]">
            <CheckCircle2 className="size-3" />
            {t('skillsPage.alreadyInstalled')}
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => { e.stopPropagation(); onInstall() }}
          >
            <Download className="size-3" />
            {t('skillsPage.install')}
          </Button>
        )}
      </div>
    </div>
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
  const loadSkills = useSkillsStore((s) => s.loadSkills)
  const loadMarketSkills = useSkillsStore((s) => s.loadMarketSkills)
  const selectSkill = useSkillsStore((s) => s.selectSkill)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const setEditing = useSkillsStore((s) => s.setEditing)
  const setEditContent = useSkillsStore((s) => s.setEditContent)
  const setMarketQuery = useSkillsStore((s) => s.setMarketQuery)

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

  const handleInstallMarket = (skillName: string): void => {
    // For local skills, open folder picker; for remote, would use URL
    void handleAddSkill()
    void skillName
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

      {activeTab === 'installed' && (
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => void handleAddSkill()}>
          <Plus className="size-3.5" />
          {t('skillsPage.addSkill')}
        </Button>
      )}
    </div>
  )

  // ── MARKET TAB — full-width leaderboard ─────────────────────────────────────
  if (activeTab === 'market') {
    return (
      <div className="flex h-full flex-col">
        {TopBar}

        <div className="flex flex-1 overflow-hidden">
          {/* Leaderboard list */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Hero */}
            <div className="px-8 pt-8 pb-5 border-b">
              <div className="flex items-end gap-3 mb-1">
                <h1 className="text-3xl font-bold tracking-tight">SKILLS</h1>
                <span className="text-sm text-muted-foreground mb-1">{t('skillsPage.skillCount', { count: marketSkills.length })}</span>
              </div>
              <p className="text-sm text-muted-foreground">{t('skillsPage.marketDescription')}</p>
            </div>

            {/* Column header */}
            <div className="flex items-center gap-4 px-6 py-2 border-b bg-muted/30">
              <span className="w-6 shrink-0" />
              <span className="w-9 shrink-0" />
              <span className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Skill</span>
              <span className="shrink-0 w-24 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status</span>
            </div>

            {/* Rows */}
            <div className="flex-1 overflow-y-auto">
              {marketLoading ? (
                <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                  <Wand2 className="size-4 mr-2 animate-pulse" /> Loading...
                </div>
              ) : marketSkills.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <Wand2 className="size-10 text-muted-foreground/20" />
                  <p className="text-sm text-muted-foreground">{t('skillsPage.noResults')}</p>
                </div>
              ) : (
                marketSkills.map((ms, i) => (
                  <MarketRow
                    key={ms.id}
                    rank={i + 1}
                    skill={{ name: ms.name, description: '' }}
                    installed={installedNames.has(ms.name)}
                    selected={selectedSkill === ms.name}
                    onSelect={() => selectSkill(ms.name)}
                    onInstall={() => handleInstallMarket(ms.name)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Right detail panel */}
          <div className={cn('flex flex-col border-l transition-all duration-200', selectedSkill ? 'w-96' : 'w-0 overflow-hidden')}>
            {selectedSkill && (
              <>
                <div className="flex items-center gap-2 border-b px-4 py-3 shrink-0">
                  <Wand2 className="size-4 shrink-0 text-primary" />
                  <h3 className="flex-1 text-sm font-semibold truncate">{selectedSkill}</h3>
                  {installedNames.has(selectedSkill) ? (
                    <Badge variant="secondary" className="gap-1 text-[11px]">
                      <CheckCircle2 className="size-3" />
                      {t('skillsPage.alreadyInstalled')}
                    </Badge>
                  ) : (
                    <Button size="sm" variant="default" className="h-7 gap-1.5 text-xs" onClick={() => handleInstallMarket(selectedSkill)}>
                      <Download className="size-3" />
                      {t('skillsPage.install')}
                    </Button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {skillContent ? (
                    <pre className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90 font-mono">{skillContent}</pre>
                  ) : (
                    <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">Loading...</div>
                  )}
                </div>
              </>
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
