import { useMemo } from 'react'
import { ArrowLeft, Image as ImageIcon, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { GraphCanvas } from './graph/GraphCanvas'
import { ProjectSwitcher } from './graph/ProjectSwitcher'
import { useDrawProjects } from './graph/use-draw-projects'
import { useVideoJobs } from './graph/use-video-jobs'
import { useGraphGeneration } from './graph/use-graph-generation'
import { useCanvasTriggers } from './graph/canvas-triggers'

export function DrawPage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const closeDrawPage = useUIStore((state) => state.closeDrawPage)
  const openSettingsPage = useUIStore((state) => state.openSettingsPage)
  const providers = useProviderStore((state) => state.providers)
  const graphActions = useGraphGeneration()
  useCanvasTriggers(graphActions)
  // Multi-project lifecycle: init/migrate, load active graph, autosave, switch.
  const projectsApi = useDrawProjects(t('drawPage.canvasBaseName', { defaultValue: 'Canvas' }))
  // Apply background video-generation job updates to video nodes.
  useVideoJobs()

  const canvasModelCount = useMemo(
    () =>
      providers.reduce(
        (count, provider) =>
          count +
          provider.models.filter((model) =>
            ['chat', 'image', 'video'].includes(model.category ?? 'chat')
          ).length,
        0
      ),
    [providers]
  )

  if (canvasModelCount === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
          <BackButton onClick={closeDrawPage} label={t('drawPage.back')} />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{t('drawPage.title')}</h1>
            <p className="truncate text-xs text-muted-foreground">{t('drawPage.subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-dashed border-border/70 bg-card/40 p-6 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <ImageIcon className="size-6" />
            </div>
            <h2 className="mt-4 text-base font-semibold">{t('drawPage.noModels')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('drawPage.noModelsDesc')}</p>
            <Button className="mt-4 gap-2" onClick={() => openSettingsPage('provider')}>
              <Settings className="size-4" />
              {t('drawPage.openProviderSettings')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <BackButton onClick={closeDrawPage} label={t('drawPage.back')} />
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-semibold">{t('drawPage.title')}</h1>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {t('drawPage.modelsLoaded', { count: canvasModelCount })}
          </Badge>
        </div>
        <div className="mx-1 h-5 w-px bg-border" />
        <ProjectSwitcher api={projectsApi} />
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => openSettingsPage('provider')}
        >
          <Settings className="size-3.5" />
          {t('drawPage.openProviderSettings')}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <GraphCanvas actions={graphActions} />
      </div>
    </div>
  )
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}
