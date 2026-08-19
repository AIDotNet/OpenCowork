import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  FolderArchive,
  RefreshCw,
  Sparkles,
  TriangleAlert
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useMcpStore } from '@renderer/stores/mcp-store'
import type {
  MigrationAction,
  MigrationApplyDecision,
  MigrationApplyResult,
  MigrationItemKind,
  MigrationPreviewResult
} from '../../../../shared/migration-types'

const ITEM_KIND_ORDER: MigrationItemKind[] = [
  'provider',
  'mainModelSelection',
  'fastModelSelection',
  'command',
  'agent',
  'mcp',
  'instructions'
]

const ACTION_LABEL_KEYS: Record<MigrationAction, string> = {
  create: 'migration.actions.create',
  skip: 'migration.actions.skip',
  replace: 'migration.actions.replace',
  duplicate: 'migration.actions.duplicate'
}

const KIND_LABEL_KEYS: Record<MigrationItemKind, string> = {
  provider: 'migration.kinds.provider',
  mainModelSelection: 'migration.kinds.mainModelSelection',
  fastModelSelection: 'migration.kinds.fastModelSelection',
  command: 'migration.kinds.command',
  agent: 'migration.kinds.agent',
  mcp: 'migration.kinds.mcp',
  instructions: 'migration.kinds.instructions'
}

function statusBadgeVariant(
  status: MigrationApplyResult['results'][number]['status']
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'success') return 'default'
  if (status === 'failed') return 'destructive'
  if (status === 'skipped') return 'outline'
  return 'secondary'
}

interface MigrationPanelProps {
  /** Hides the panel's own heading when hosted inside another settings page. */
  embedded?: boolean
}

export function MigrationPanel({ embedded = false }: MigrationPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [preview, setPreview] = useState<MigrationPreviewResult | null>(null)
  const [decisions, setDecisions] = useState<Record<string, MigrationAction>>({})
  const [result, setResult] = useState<MigrationApplyResult | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [applying, setApplying] = useState(false)

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true)
    try {
      const nextPreview = (await ipcClient.invoke(
        IPC.MIGRATION_PREVIEW,
        'opencode'
      )) as MigrationPreviewResult
      setPreview(nextPreview)
      setDecisions(
        Object.fromEntries(
          nextPreview.items.map((item) => [item.id, item.defaultAction])
        ) as Record<string, MigrationAction>
      )
    } catch (error) {
      toast.error(
        t('migration.previewFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setLoadingPreview(false)
    }
  }, [t])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const groupedItems = useMemo(() => {
    const items = preview?.items ?? []
    return ITEM_KIND_ORDER.map((kind) => ({
      kind,
      items: items.filter((item) => item.kind === kind)
    })).filter((group) => group.items.length > 0)
  }, [preview])

  const actionableCount = useMemo(() => {
    if (!preview) return 0
    return preview.items.filter((item) => {
      const action = decisions[item.id] ?? item.defaultAction
      return action !== 'skip'
    }).length
  }, [decisions, preview])

  const handleDecisionChange = useCallback((itemId: string, action: MigrationAction) => {
    setDecisions((prev) => ({ ...prev, [itemId]: action }))
  }, [])

  const handleApply = useCallback(async () => {
    if (!preview) return
    setApplying(true)
    try {
      const payload: MigrationApplyDecision[] = preview.items.map((item) => ({
        id: item.id,
        action: decisions[item.id] ?? item.defaultAction
      }))
      const nextResult = (await ipcClient.invoke(IPC.MIGRATION_APPLY, {
        source: 'opencode',
        decisions: payload
      })) as MigrationApplyResult
      setResult(nextResult)

      if (nextResult.summary.applied > 0) {
        const providerStore = useProviderStore as typeof useProviderStore & {
          persist?: { rehydrate?: () => Promise<void> | void }
        }
        await providerStore.persist?.rehydrate?.()
        await useMcpStore.getState().loadServers()
      }

      if (nextResult.summary.failed > 0) {
        toast.error(
          t('migration.applyPartial', {
            applied: nextResult.summary.applied,
            failed: nextResult.summary.failed
          })
        )
      } else {
        toast.success(
          t('migration.applySuccess', {
            applied: nextResult.summary.applied,
            skipped: nextResult.summary.skipped
          })
        )
      }

      await loadPreview()
    } catch (error) {
      toast.error(
        t('migration.applyFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setApplying(false)
    }
  }, [decisions, loadPreview, preview, t])

  return (
    <div className="space-y-8">
      {embedded ? null : (
        <div>
          <h2 className="text-lg font-semibold">{t('migration.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('migration.subtitle')}</p>
        </div>
      )}

      <section className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <p className="text-sm font-medium">{t('migration.sourceTitle')}</p>
            </div>
            <p className="text-xs text-muted-foreground">{t('migration.sourceDesc')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => void loadPreview()}
              disabled={loadingPreview || applying}
            >
              <RefreshCw className={`mr-1.5 size-3.5 ${loadingPreview ? 'animate-spin' : ''}`} />
              {t('migration.reloadAction')}
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handleApply()}
              disabled={loadingPreview || applying || actionableCount === 0 || !preview?.detected}
            >
              <ArrowRightLeft className="mr-1.5 size-3.5" />
              {applying ? t('migration.applyingAction') : t('migration.applyAction')}
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-border/60 bg-background/70 p-3">
            <p className="text-xs text-muted-foreground">{t('migration.sourcePathLabel')}</p>
            <p className="mt-1 break-all text-xs">
              {preview?.sourcePath || t('migration.notDetected')}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/70 p-3">
            <p className="text-xs text-muted-foreground">{t('migration.detectedLabel')}</p>
            <p className="mt-1 text-xs">
              {preview?.detected ? t('migration.detected') : t('migration.notDetected')}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/70 p-3">
            <p className="text-xs text-muted-foreground">{t('migration.summary.total')}</p>
            <p className="mt-1 text-xs">{preview?.summary.total ?? 0}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/70 p-3">
            <p className="text-xs text-muted-foreground">{t('migration.summary.actionable')}</p>
            <p className="mt-1 text-xs">{actionableCount}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {t('migration.summary.conflicts')}: {preview?.summary.conflicts ?? 0}
          </Badge>
          <Badge variant="outline">
            {t('migration.summary.warnings')}: {preview?.summary.warnings ?? 0}
          </Badge>
          <Badge variant="outline">
            {t('migration.summary.actionable')}: {preview?.summary.actionable ?? 0}
          </Badge>
          <Badge variant="outline">{t('migration.backupHint')}</Badge>
        </div>
      </section>

      {preview?.warnings?.length ? (
        <section className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-4" />
            {t('migration.globalWarningsTitle')}
          </div>
          <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
            {preview.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>• {warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {groupedItems.map((group) => (
        <section key={group.kind} className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">{t(KIND_LABEL_KEYS[group.kind])}</h3>
            <p className="text-xs text-muted-foreground">
              {t('migration.groupCount', { count: group.items.length })}
            </p>
          </div>

          <div className="space-y-3">
            {group.items.map((item) => {
              const currentAction = decisions[item.id] ?? item.defaultAction
              return (
                <div
                  key={item.id}
                  className="rounded-lg border border-border/60 bg-background/70 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium break-all">{item.title}</p>
                        {item.conflict && (
                          <Badge variant="secondary">{t('migration.conflict')}</Badge>
                        )}
                        {item.warnings.length > 0 && (
                          <Badge variant="outline">
                            {t('migration.warningCount', { count: item.warnings.length })}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground break-all">
                        {item.sourceLabel} → {item.targetLabel}
                      </p>
                      {item.targetPath ? (
                        <p className="text-[11px] text-muted-foreground break-all">
                          {item.targetPath}
                        </p>
                      ) : null}
                    </div>

                    <Select
                      value={currentAction}
                      onValueChange={(value) =>
                        handleDecisionChange(item.id, value as MigrationAction)
                      }
                      disabled={applying || loadingPreview || item.allowedActions.length === 1}
                    >
                      <SelectTrigger className="h-8 w-[150px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {item.allowedActions.map((action) => (
                          <SelectItem key={action} value={action} className="text-xs">
                            {t(ACTION_LABEL_KEYS[action])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {item.details.length > 0 ? (
                    <div className="grid gap-2 md:grid-cols-2">
                      {item.details.map((detail) => (
                        <div
                          key={`${item.id}-${detail.label}`}
                          className="rounded-md border border-border/50 bg-muted/20 px-3 py-2"
                        >
                          <p className="text-[11px] text-muted-foreground">{detail.label}</p>
                          <p className="mt-1 text-xs break-all">{detail.value}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {item.unsupportedFields.length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t('migration.unsupportedFields')}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {item.unsupportedFields.map((field) => (
                          <Badge key={`${item.id}-${field}`} variant="outline">
                            {field}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {item.warnings.length > 0 ? (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      <div className="mb-1 flex items-center gap-1.5 font-medium">
                        <AlertTriangle className="size-3.5" />
                        {t('migration.itemWarnings')}
                      </div>
                      <ul className="space-y-1">
                        {item.warnings.map((warning, index) => (
                          <li key={`${item.id}-warning-${index}`}>• {warning}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {!preview?.items.length && !loadingPreview ? (
        <section className="rounded-lg border border-border/60 bg-background/70 p-8 text-center text-sm text-muted-foreground">
          {t('migration.empty')}
        </section>
      ) : null}

      {result ? (
        <section className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t('migration.resultTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('migration.resultSubtitle')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge>{t('migration.resultApplied', { count: result.summary.applied })}</Badge>
              <Badge variant="outline">
                {t('migration.resultSkipped', { count: result.summary.skipped })}
              </Badge>
              <Badge variant={result.summary.failed > 0 ? 'destructive' : 'outline'}>
                {t('migration.resultFailed', { count: result.summary.failed })}
              </Badge>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-background/70 p-3 text-xs">
            <div className="flex items-center gap-2 font-medium">
              <FolderArchive className="size-3.5 text-primary" />
              {t('migration.backupPathLabel')}
            </div>
            <p className="mt-1 break-all text-muted-foreground">
              {result.backupPath || t('migration.backupPathUnavailable')}
            </p>
          </div>

          <Separator />

          <div className="space-y-2">
            {result.results.map((item) => (
              <div
                key={`result-${item.id}`}
                className="rounded-lg border border-border/60 bg-background/70 px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium break-all">{item.title}</p>
                      <Badge variant={statusBadgeVariant(item.status)}>
                        {t(`migration.resultStatus.${item.status}`)}
                      </Badge>
                    </div>
                    {item.message ? (
                      <p className="mt-1 text-xs text-muted-foreground">{item.message}</p>
                    ) : null}
                    {item.targetPath ? (
                      <p className="mt-1 break-all text-[11px] text-muted-foreground">
                        {item.targetPath}
                      </p>
                    ) : null}
                  </div>
                  {item.status === 'success' ? (
                    <CheckCircle2 className="size-4 text-emerald-500" />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
