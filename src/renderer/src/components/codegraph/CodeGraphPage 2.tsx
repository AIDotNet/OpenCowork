import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  FolderPlus,
  RefreshCw,
  RotateCw,
  Settings,
  Trash2,
  Waypoints
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useUIStore } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import {
  getCodeGraphAssetStatus,
  useCodeGraphStore,
  type CgNode
} from '@renderer/stores/codegraph-store'
import { CodeGraphDashboard } from './CodeGraphDashboard'
import { CodeGraphFileTree } from './CodeGraphFileTree'
import { CodeGraphGraphView } from './CodeGraphGraphView'
import { CodeGraphIndexProgressBar } from './CodeGraphIndexProgressBar'

type Tab = 'dashboard' | 'files' | 'graph'

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

function GateCard({
  message,
  onOpenSettings,
  buttonLabel
}: {
  message: string
  onOpenSettings: () => void
  buttonLabel: string
}): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border border-dashed border-border/70 bg-card/40 p-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Waypoints className="size-6" />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">{message}</p>
        <Button className="mt-4 gap-2" onClick={onOpenSettings}>
          <Settings className="size-4" />
          {buttonLabel}
        </Button>
      </div>
    </div>
  )
}

export function CodeGraphPage({
  embedded = false
}: { embedded?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const closeCodeGraphPage = useUIStore((s) => s.closeCodeGraphPage)
  const openSettingsPage = useUIStore((s) => s.openSettingsPage)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const enabled = useAppPluginStore((s) => s.isCodeGraphToolAvailable(activeProjectId))

  const projects = useCodeGraphStore((s) => s.projects)
  const projectsLoading = useCodeGraphStore((s) => s.projectsLoading)
  const selectedRoot = useCodeGraphStore((s) => s.selectedRoot)
  const status = useCodeGraphStore((s) => s.status)
  const stats = useCodeGraphStore((s) => s.stats)
  const detailLoading = useCodeGraphStore((s) => s.detailLoading)
  const busyKey = useCodeGraphStore((s) => s.busyKey)
  const indexProgress = useCodeGraphStore((s) => s.indexProgress)
  const refreshProjects = useCodeGraphStore((s) => s.refreshProjects)
  const selectProject = useCodeGraphStore((s) => s.selectProject)
  const addFolder = useCodeGraphStore((s) => s.addFolder)
  const indexProject = useCodeGraphStore((s) => s.indexProject)
  const syncProject = useCodeGraphStore((s) => s.syncProject)
  const removeProject = useCodeGraphStore((s) => s.removeProject)

  const [needsDownload, setNeedsDownload] = useState(false)
  const [tab, setTab] = useState<Tab>('dashboard')
  const [seed, setSeed] = useState<{ node?: CgNode; symbol?: string } | null>(null)

  useEffect(() => {
    if (!enabled) return
    void refreshProjects()
    void getCodeGraphAssetStatus().then((s) => setNeedsDownload(Boolean(s?.needsDownload)))
  }, [enabled, refreshProjects])

  const selected = useMemo(
    () => projects.find((p) => p.root === selectedRoot) ?? null,
    [projects, selectedRoot]
  )
  const busy = busyKey !== null

  const onSelectSymbol = (node: CgNode): void => {
    setSeed({ node })
    setTab('graph')
  }

  const header = (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
      {embedded ? null : (
        <>
          <BackButton onClick={closeCodeGraphPage} label={t('codegraphPage.back')} />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{t('codegraphPage.title')}</h1>
          </div>
          <div className="mx-1 h-5 w-px bg-border" />
        </>
      )}
      {/* Project selector */}
      <select
        value={selectedRoot ?? ''}
        onChange={(e) => selectProject(e.target.value || null)}
        disabled={projects.length === 0}
        className="max-w-[280px] truncate rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        title={selectedRoot ?? undefined}
      >
        {projects.length === 0 ? (
          <option value="">{t('codegraphPage.selectProject')}</option>
        ) : (
          projects.map((p) => (
            <option key={p.hash} value={p.root}>
              {p.root || t('codegraphPage.unknownRoot', { hash: p.hash.slice(0, 8) })}
            </option>
          ))
        )}
      </select>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={busy}
        onClick={() => void addFolder()}
      >
        <FolderPlus className="size-3.5" />
        {t('codegraphPage.addFolder')}
      </Button>
      <div className="flex-1" />
      {selectedRoot ? (
        <>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busy}
            onClick={() => void indexProject(selectedRoot)}
          >
            <RotateCw className="size-3.5" />
            {busyKey === `index:${selectedRoot}`
              ? t('codegraphPage.reindexing')
              : t('codegraphPage.reindex')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busy || !status?.indexed}
            onClick={() => void syncProject(selectedRoot)}
          >
            <RefreshCw className="size-3.5" />
            {busyKey === `sync:${selectedRoot}`
              ? t('codegraphPage.syncing')
              : t('codegraphPage.sync')}
          </Button>
          {selected ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive"
              disabled={busy}
              onClick={() => void removeProject(selected.root, selected.hash)}
            >
              <Trash2 className="size-3.5" />
              {busyKey === `remove:${selected.hash}`
                ? t('codegraphPage.deleting')
                : t('codegraphPage.delete')}
            </Button>
          ) : null}
        </>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={projectsLoading}
        onClick={() => void refreshProjects()}
      >
        <RefreshCw className={`size-3.5 ${projectsLoading ? 'animate-spin' : ''}`} />
      </Button>
    </div>
  )

  let body: React.JSX.Element
  if (!enabled) {
    body = (
      <GateCard
        message={t('codegraphPage.pluginDisabled')}
        buttonLabel={t('codegraphPage.openSettings')}
        onOpenSettings={() => openSettingsPage('plugin')}
      />
    )
  } else if (needsDownload) {
    body = (
      <GateCard
        message={t('codegraphPage.needsDownload')}
        buttonLabel={t('codegraphPage.openSettings')}
        onOpenSettings={() => openSettingsPage('plugin')}
      />
    )
  } else if (!selectedRoot) {
    body = (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-dashed border-border/70 bg-card/40 p-6 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <FolderPlus className="size-6" />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">{t('codegraphPage.noProjects')}</p>
          <Button className="mt-4 gap-2" disabled={busy} onClick={() => void addFolder()}>
            <FolderPlus className="size-4" />
            {t('codegraphPage.addFolder')}
          </Button>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Tab bar */}
        <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
          {(['dashboard', 'files', 'graph'] as Tab[]).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                tab === key
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t(`codegraphPage.tabs.${key}`)}
            </button>
          ))}
          {indexProgress ? (
            <CodeGraphIndexProgressBar progress={indexProgress} className="ml-2 w-56" />
          ) : busyKey === `index:${selectedRoot}` ? (
            <span className="ml-2 flex items-center gap-1.5 text-[11px] text-amber-600">
              <Spinner className="size-3" />
              {t('codegraphPage.indexing')}
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {status && !status.indexed && !detailLoading ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div className="max-w-sm">
                <p className="text-sm font-medium">{t('codegraphPage.notIndexedTitle')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('codegraphPage.notIndexedDesc')}
                </p>
                <Button
                  className="mt-4 gap-2"
                  disabled={busy}
                  onClick={() => void indexProject(selectedRoot)}
                >
                  <RotateCw className="size-4" />
                  {t('codegraphPage.reindex')}
                </Button>
              </div>
            </div>
          ) : tab === 'dashboard' ? (
            <CodeGraphDashboard status={status} stats={stats} loading={detailLoading} />
          ) : tab === 'files' ? (
            <CodeGraphFileTree root={selectedRoot} onSelectSymbol={onSelectSymbol} />
          ) : (
            <CodeGraphGraphView root={selectedRoot} seed={seed} />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {header}
      {body}
    </div>
  )
}
