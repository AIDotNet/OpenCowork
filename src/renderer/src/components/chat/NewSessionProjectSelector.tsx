import * as React from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Monitor,
  Search,
  Server,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@renderer/lib/utils'
import type { Project } from '@renderer/stores/chat-store'

export type NewSessionProjectOption = Pick<
  Project,
  'id' | 'name' | 'pluginId' | 'workingFolder' | 'sshConnectionId'
>

interface NewSessionProjectSelectorProps {
  projects: NewSessionProjectOption[]
  selectedProjectId: string | null
  allowNoProject?: boolean
  onSelectProject: (projectId: string | null) => void
  onCreateProject: () => void
  className?: string
}

export function NewSessionProjectSelector({
  projects,
  selectedProjectId,
  allowNoProject = true,
  onSelectProject,
  onCreateProject,
  className
}: NewSessionProjectSelectorProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const visibleProjects = React.useMemo(
    () => projects.filter((project) => !project.pluginId),
    [projects]
  )
  const selectedProject =
    visibleProjects.find((project) => project.id === selectedProjectId) ?? null
  const normalizedQuery = query.trim().toLowerCase()
  const filteredProjects = normalizedQuery
    ? visibleProjects.filter((project) => project.name.toLowerCase().includes(normalizedQuery))
    : visibleProjects
  const projectLabel = selectedProject?.name ?? t('input.noProject', { defaultValue: 'No project' })
  const transportLabel = selectedProject
    ? selectedProject.sshConnectionId
      ? t('input.sshMode', { defaultValue: 'SSH mode' })
      : t('input.localMode', { defaultValue: 'Local mode' })
    : t('input.globalSession', { defaultValue: 'Global session' })
  const SelectedProjectIcon = selectedProject?.sshConnectionId ? Server : FolderOpen

  const selectProject = React.useCallback(
    (projectId: string | null): void => {
      onSelectProject(projectId)
      setOpen(false)
      setQuery('')
    },
    [onSelectProject]
  )

  const handleCreateProject = React.useCallback((): void => {
    setOpen(false)
    setQuery('')
    onCreateProject()
  }, [onCreateProject])

  return (
    <div
      className={cn(
        'mx-4 -mt-px flex min-h-10 items-center gap-2 rounded-b-[18px] border border-t-0 border-border/45 bg-muted/35 px-3 py-1.5 text-xs shadow-sm backdrop-blur',
        className
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex h-7 max-w-[220px] min-w-0 items-center gap-1.5 rounded-full bg-background/55 px-2.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            aria-label={t('input.selectProject', { defaultValue: 'Select project' })}
          >
            <SelectedProjectIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{projectLabel}</span>
            <ChevronDown className="size-3 shrink-0 opacity-70" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-72 overflow-hidden rounded-xl p-1.5"
        >
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/65" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('input.searchProjects', { defaultValue: 'Search projects' })}
              className="h-8 rounded-lg border-0 bg-muted/45 pl-8 pr-2 text-xs shadow-none focus-visible:ring-1"
              autoFocus
            />
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {filteredProjects.length > 0 ? (
              filteredProjects.map((project) => {
                const selected = project.id === selectedProjectId
                return (
                  <button
                    key={project.id}
                    type="button"
                    className={cn(
                      'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors',
                      selected
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-muted/70'
                    )}
                    onClick={() => selectProject(project.id)}
                    title={project.workingFolder ?? project.name}
                  >
                    {project.sshConnectionId ? (
                      <Server className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {selected ? <Check className="size-3.5 shrink-0" /> : null}
                  </button>
                )
              })
            ) : (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t('input.noMatchingProjects', { defaultValue: 'No matching projects' })}
              </div>
            )}
          </div>

          <div className="border-t border-border/60 pt-1">
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted/70"
              onClick={handleCreateProject}
            >
              <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {t('input.addProject', { defaultValue: 'Add project' })}
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
            {allowNoProject ? (
              <button
                type="button"
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                onClick={() => selectProject(null)}
              >
                <X className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {t('input.noProject', { defaultValue: 'No project' })}
                </span>
                {!selectedProjectId ? <Check className="size-3.5 shrink-0" /> : null}
              </button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      <span className="h-4 w-px bg-border/60" />
      <span className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2 text-muted-foreground">
        {selectedProject?.sshConnectionId ? (
          <Server className="size-3.5 shrink-0" />
        ) : (
          <Monitor className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{transportLabel}</span>
      </span>
    </div>
  )
}
