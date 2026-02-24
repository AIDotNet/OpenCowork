import { useEffect, useMemo } from 'react'
import { Search, FolderOpen, Trash2, Plus, Wand2, ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useSkillsStore } from '@renderer/stores/skills-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export function SkillsPage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const skills = useSkillsStore((s) => s.skills)
  const loading = useSkillsStore((s) => s.loading)
  const selectedSkill = useSkillsStore((s) => s.selectedSkill)
  const skillContent = useSkillsStore((s) => s.skillContent)
  const searchQuery = useSkillsStore((s) => s.searchQuery)
  const loadSkills = useSkillsStore((s) => s.loadSkills)
  const selectSkill = useSkillsStore((s) => s.selectSkill)
  const setSearchQuery = useSkillsStore((s) => s.setSearchQuery)

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return skills
    const q = searchQuery.toLowerCase()
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    )
  }, [skills, searchQuery])

  const handleAddSkill = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (result.canceled || !result.path) return
    const addResult = await useSkillsStore.getState().addSkillFromFolder(result.path)
    if (addResult.success) {
      toast.success(t('skillsPage.added', { name: addResult.name }))
      if (addResult.name) selectSkill(addResult.name)
    } else {
      toast.error(t('skillsPage.addFailed', { error: addResult.error }))
    }
  }

  const handleDelete = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: t('skillsPage.deleteConfirm', { name }),
      variant: 'destructive',
    })
    if (!ok) return
    const success = await useSkillsStore.getState().deleteSkill(name)
    if (success) {
      toast.success(t('skillsPage.deleted', { name }))
    } else {
      toast.error(t('skillsPage.deleteFailed'))
    }
  }

  const handleOpenFolder = async (name: string): Promise<void> => {
    await useSkillsStore.getState().openSkillFolder(name)
  }

  const handleBack = (): void => {
    useUIStore.getState().closeSkillsPage()
  }

  return (
    <div className="flex h-full">
      {/* Left sidebar — skill list */}
      <div className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
        {/* Header */}
        <div className="flex items-center gap-2 border-b px-3 py-3">
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
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t('skillsPage.title')}</h2>
            <p className="text-[10px] text-muted-foreground">
              {t('skillsPage.skillCount', { count: skills.length })}
            </p>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('skillsPage.searchPlaceholder')}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        {/* Skill list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              Loading...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
              <Wand2 className="size-8 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">
                {skills.length === 0 ? t('skillsPage.noSkills') : t('skillsPage.noResults')}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((skill) => (
                <button
                  key={skill.name}
                  onClick={() => selectSkill(skill.name)}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
                    selectedSkill === skill.name
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-muted'
                  )}
                >
                  <span className="text-xs font-medium truncate">{skill.name}</span>
                  <span className="text-[10px] text-muted-foreground line-clamp-2">
                    {skill.description}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Add skill button */}
        <div className="border-t px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-xs"
            onClick={() => void handleAddSkill()}
          >
            <Plus className="size-3.5" />
            {t('skillsPage.addSkill')}
          </Button>
        </div>
      </div>

      {/* Right content — skill detail */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {selectedSkill ? (
          <>
            {/* Skill header */}
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <Wand2 className="size-4 shrink-0 text-primary" />
              <h2 className="flex-1 text-sm font-semibold truncate">{selectedSkill}</h2>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => void handleOpenFolder(selectedSkill)}
                    >
                      <FolderOpen className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('skillsPage.openFolder')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive hover:text-destructive"
                      onClick={() => void handleDelete(selectedSkill)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('skillsPage.delete')}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Skill content */}
            <div className="flex-1 overflow-y-auto p-4">
              {skillContent ? (
                <pre className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90 font-mono">
                  {skillContent}
                </pre>
              ) : (
                <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                  Loading...
                </div>
              )}
            </div>
          </>
        ) : (
          /* Empty state */
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <Wand2 className="size-10 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">{t('skillsPage.selectSkill')}</p>
            <p className="text-xs text-muted-foreground/60">{t('skillsPage.selectSkillDesc')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
