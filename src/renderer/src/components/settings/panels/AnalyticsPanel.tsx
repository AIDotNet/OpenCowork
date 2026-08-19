import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { resolveIntlLocale } from '@renderer/lib/i18n-language'
import { useProviderStore } from '@renderer/stores/provider-store'
import {
  clearUsageEvents,
  getUsageActivityByModel,
  getUsageActivityByProvider,
  getUsageActivityDaily,
  getUsageActivityOverview,
  getUsageByModel,
  getUsageByProvider,
  getUsageDaily,
  getUsageOverview,
  getUsageTimeline,
  listUsageEvents,
  type UsageTimelineBucket
} from '@renderer/lib/usage-analytics'
import { getCacheReadRatio } from '@renderer/lib/format-tokens'
import { AnalyticsOverview } from '../AnalyticsOverview'
import { SettingsPanel } from '../settings-primitives'

export function AnalyticsPanel(): React.JSX.Element {
  const { t, i18n } = useTranslation('settings')
  const [rangeDays, setRangeDays] = useState<1 | 7 | 30>(7)
  const [loading, setLoading] = useState(true)
  const [selectedProviderId, setSelectedProviderId] = useState<string>('__all__')
  const [selectedModelId, setSelectedModelId] = useState<string>('__all__')
  const [selectedSourceKind, setSelectedSourceKind] = useState<string>('__all__')
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof getUsageOverview>> | null>(
    null
  )
  const [timeline, setTimeline] = useState<Record<string, unknown>[]>([])
  const [daily, setDaily] = useState<Record<string, unknown>[]>([])
  const [models, setModels] = useState<Record<string, unknown>[]>([])
  const [providers, setProviders] = useState<Record<string, unknown>[]>([])
  const [details, setDetails] = useState<Record<string, unknown>[]>([])
  const [clearing, setClearing] = useState(false)

  const providerOptions = useMemo(
    () =>
      useProviderStore
        .getState()
        .providers.filter((provider) => provider.enabled)
        .map((provider) => ({ id: provider.id, name: provider.name })),
    []
  )
  const modelOptions = useMemo(
    () =>
      useProviderStore.getState().providers.flatMap((provider) =>
        provider.models.map((model) => ({
          id: model.id,
          name: model.name,
          providerId: provider.id
        }))
      ),
    []
  )
  const sourceOptions = ['chat', 'agent', 'cron', 'plugin', 'draw', 'translate', 'team']
  const timelineBucket: UsageTimelineBucket = rangeDays === 1 ? 'hour' : 'day'
  const hasAnalyticsFilter =
    selectedProviderId !== '__all__' ||
    selectedModelId !== '__all__' ||
    selectedSourceKind !== '__all__'
  const useActivityAnalytics = rangeDays !== 1 && !hasAnalyticsFilter

  const query = useMemo(() => {
    const to = Date.now()
    const fromDate = new Date(to)

    if (rangeDays === 1) {
      fromDate.setMinutes(0, 0, 0)
      fromDate.setHours(fromDate.getHours() - 23)
    } else {
      fromDate.setHours(0, 0, 0, 0)
      fromDate.setDate(fromDate.getDate() - (rangeDays - 1))
    }

    return {
      from: fromDate.getTime(),
      to,
      limit: 50,
      offset: 0,
      providerId: selectedProviderId === '__all__' ? null : selectedProviderId,
      modelId: selectedModelId === '__all__' ? null : selectedModelId,
      sourceKind: selectedSourceKind === '__all__' ? null : selectedSourceKind
    }
  }, [rangeDays, selectedModelId, selectedProviderId, selectedSourceKind])

  const loadAnalytics = useCallback(
    async (signal?: { cancelled: boolean }): Promise<void> => {
      setLoading(true)
      try {
        if (useActivityAnalytics) {
          const [nextOverview, nextDaily, nextModels, nextProviders, nextDetails] =
            await Promise.all([
              getUsageActivityOverview(query),
              getUsageActivityDaily(query),
              getUsageActivityByModel(query),
              getUsageActivityByProvider(query),
              listUsageEvents(query)
            ])
          if (signal?.cancelled) return
          setOverview(nextOverview)
          setTimeline(nextDaily.map((row) => ({ ...row, bucket_label: row.day })))
          setDaily(nextDaily)
          setModels(nextModels)
          setProviders(nextProviders)
          setDetails(nextDetails)
          return
        }

        const [nextOverview, nextTimeline, nextDaily, nextModels, nextProviders, nextDetails] =
          await Promise.all([
            getUsageOverview(query),
            getUsageTimeline(query, timelineBucket),
            getUsageDaily(query),
            getUsageByModel(query),
            getUsageByProvider(query),
            listUsageEvents(query)
          ])
        if (signal?.cancelled) return
        setOverview(nextOverview)
        setTimeline(nextTimeline)
        setDaily(nextDaily)
        setModels(nextModels)
        setProviders(nextProviders)
        setDetails(nextDetails)
      } finally {
        if (!signal?.cancelled) setLoading(false)
      }
    },
    [query, timelineBucket, useActivityAnalytics]
  )

  useEffect(() => {
    const signal = { cancelled: false }
    void loadAnalytics(signal)
    return () => {
      signal.cancelled = true
    }
  }, [loadAnalytics])

  const handleClearLogs = useCallback(async (): Promise<void> => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const purgeQuery = { from: 0, to: cutoff }
    const preview = (await getUsageOverview(purgeQuery)) as { request_count?: number } | null
    const count = Number(preview?.request_count ?? 0)
    if (count <= 0) {
      toast.info(t('analytics.clearEmpty'))
      return
    }
    const cutoffLabel = new Date(cutoff).toLocaleString()
    const ok = await confirm({
      title: t('analytics.clearConfirmTitle'),
      description: t('analytics.clearConfirmDescription', { count, date: cutoffLabel }),
      variant: 'destructive'
    })
    if (!ok) return
    setClearing(true)
    try {
      const result = await clearUsageEvents(purgeQuery)
      toast.success(t('analytics.clearSuccess', { count: result.deleted }))
      await loadAnalytics()
    } catch (error) {
      console.error('[analytics] clear logs failed', error)
      toast.error(t('analytics.clearFailed'))
    } finally {
      setClearing(false)
    }
  }, [loadAnalytics, t])

  const tokenLocale = resolveIntlLocale(i18n.language)
  const inputTokenLabel = t('analytics.billableInputTokens', {
    defaultValue: tokenLocale === 'zh-CN' ? '计费输入 Token' : 'Billable Input Tokens'
  })
  const fmtInt = (value: unknown): string =>
    new Intl.NumberFormat(tokenLocale).format(
      typeof value === 'number' ? value : Number(value ?? 0)
    )
  const fmtTokenCompact = (value: unknown): string => {
    const number = typeof value === 'number' ? value : Number(value ?? 0)
    if (!Number.isFinite(number)) return '0'
    return new Intl.NumberFormat(tokenLocale, {
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: number >= 100000 ? 1 : 2
    }).format(Math.max(0, number))
  }
  const getEffectiveInputTokens = (row: Record<string, unknown>): number => {
    const billable = Number(row.billable_input_tokens ?? Number.NaN)
    if (Number.isFinite(billable)) return Math.max(0, billable)
    const input = Number(row.input_tokens ?? 0)
    if (row.created_at == null && row.id == null) return Math.max(0, input)
    const cacheRead = Number(row.cache_read_tokens ?? 0)
    const cacheCreation = Number(row.cache_creation_tokens ?? 0)
    return Math.max(0, input - cacheRead - cacheCreation)
  }
  const getTotalInputTokens = (row: Record<string, unknown>): number => {
    const total = Number(row.total_input_tokens ?? Number.NaN)
    if (Number.isFinite(total)) return Math.max(0, total)
    const input = Number(row.input_tokens ?? 0)
    if (row.created_at != null || row.id != null) return Math.max(0, input)
    const cacheRead = Number(row.cache_read_tokens ?? 0)
    const cacheCreation = Number(row.cache_creation_tokens ?? 0)
    return Math.max(0, input + cacheRead + cacheCreation)
  }
  const fmtPercent = (value: number): string =>
    new Intl.NumberFormat(tokenLocale, {
      style: 'percent',
      maximumFractionDigits: 1
    }).format(Math.max(0, value))
  const getRowCacheReadRatio = (row: Record<string, unknown>): number =>
    getCacheReadRatio(getTotalInputTokens(row), Number(row.cache_read_tokens ?? 0))
  const renderRateValue = (value: number): React.JSX.Element => (
    <span className="tabular-nums">{fmtPercent(value)}</span>
  )
  const renderTokenValue = (value: unknown, showRaw = false): React.JSX.Element => {
    const compact = fmtTokenCompact(value)
    const raw = fmtInt(value)
    const shouldShowRaw = showRaw && compact !== raw
    return (
      <span title={`${raw} Token`} className="inline-flex flex-col tabular-nums leading-tight">
        <span>{compact}</span>
        {shouldShowRaw ? <span className="text-[11px] text-muted-foreground">{raw}</span> : null}
      </span>
    )
  }
  const fmtMoney = (value: unknown): string =>
    typeof value === 'number' || typeof value === 'string'
      ? Number(value || 0).toFixed(6)
      : '0.000000'
  const fmtMs = (value: unknown): string => {
    const number = typeof value === 'number' ? value : Number(value ?? 0)
    return Number.isFinite(number) && number > 0 ? `${Math.round(number)} ms` : '-'
  }

  const renderSimpleTable = (
    title: string,
    rows: Record<string, unknown>[],
    columns: Array<{
      key: string
      label: string
      render?: (row: Record<string, unknown>) => React.JSX.Element | string
    }>
  ): React.JSX.Element => (
    <section className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('analytics.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                {columns.map((column) => (
                  <th key={column.key} className="px-2 py-2 font-medium">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${title}-${index}`} className="border-b border-border/30 last:border-0">
                  {columns.map((column) => (
                    <td key={column.key} className="px-2 py-2 align-top">
                      {column.render ? column.render(row) : String(row[column.key] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )

  return (
    <SettingsPanel title={t('analytics.title')} description={t('analytics.subtitle')}>
      <div className="flex items-end justify-end gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {([1, 7, 30] as const).map((days) => (
            <Button
              key={days}
              size="sm"
              variant={rangeDays === days ? 'default' : 'outline'}
              className="h-8 text-xs"
              onClick={() => setRangeDays(days)}
            >
              {days === 1
                ? t('analytics.range24h')
                : days === 7
                  ? t('analytics.range7d')
                  : t('analytics.range30d')}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs text-destructive hover:text-destructive"
            onClick={() => void handleClearLogs()}
            disabled={clearing || loading}
          >
            {clearing ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-1.5 size-3.5" />
            )}
            {clearing ? t('analytics.clearing') : t('analytics.clearLogs')}
          </Button>
        </div>
      </div>

      <section className="grid gap-3 rounded-2xl border border-border/50 bg-muted/10 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] md:grid-cols-3 xl:grid-cols-3">
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t('analytics.provider')}</div>
          <Select value={selectedProviderId} onValueChange={setSelectedProviderId}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('analytics.allProviders')}</SelectItem>
              {providerOptions.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t('analytics.model')}</div>
          <Select value={selectedModelId} onValueChange={setSelectedModelId}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('analytics.allModels')}</SelectItem>
              {modelOptions.map((model) => (
                <SelectItem key={`${model.providerId}-${model.id}`} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t('analytics.source')}</div>
          <Select value={selectedSourceKind} onValueChange={setSelectedSourceKind}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('analytics.allSources')}</SelectItem>
              {sourceOptions.map((source) => (
                <SelectItem key={source} value={source}>
                  {source}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('analytics.loading')}
        </div>
      ) : (
        <>
          <AnalyticsOverview
            overview={overview}
            timeline={timeline}
            rangeDays={rangeDays}
            bucket={timelineBucket}
            from={query.from}
            to={query.to}
            tokenLocale={tokenLocale}
            inputTokenLabel={inputTokenLabel}
          />

          {renderSimpleTable(t('analytics.daily'), daily, [
            { key: 'day', label: t('analytics.time') },
            { key: 'request_count', label: t('analytics.requests') },
            {
              key: 'input_tokens',
              label: inputTokenLabel,
              render: (row) => renderTokenValue(getEffectiveInputTokens(row))
            },
            {
              key: 'output_tokens',
              label: t('analytics.outputTokens'),
              render: (row) => renderTokenValue(row.output_tokens)
            },
            {
              key: 'cache_creation_tokens',
              label: t('analytics.cacheCreationTokens'),
              render: (row) => renderTokenValue(row.cache_creation_tokens)
            },
            {
              key: 'cache_read_tokens',
              label: t('analytics.cacheReadTokens'),
              render: (row) => renderTokenValue(row.cache_read_tokens)
            },
            {
              key: 'cache_read_ratio',
              label: t('analytics.cacheReadRatio', { defaultValue: 'Cache Read Ratio' }),
              render: (row) => renderRateValue(getRowCacheReadRatio(row))
            },
            {
              key: 'total_cost_usd',
              label: t('analytics.costUsd'),
              render: (row) => `$${fmtMoney(row.total_cost_usd)}`
            },
            {
              key: 'avg_ttft_ms',
              label: t('analytics.avgTtft'),
              render: (row) => fmtMs(row.avg_ttft_ms)
            },
            {
              key: 'avg_total_ms',
              label: t('analytics.avgTotal'),
              render: (row) => fmtMs(row.avg_total_ms)
            }
          ])}

          {renderSimpleTable(t('analytics.models'), models, [
            { key: 'model_name', label: t('analytics.model') },
            { key: 'provider_name', label: t('analytics.provider') },
            { key: 'request_count', label: t('analytics.requests') },
            {
              key: 'input_tokens',
              label: inputTokenLabel,
              render: (row) => renderTokenValue(getEffectiveInputTokens(row))
            },
            {
              key: 'output_tokens',
              label: t('analytics.outputTokens'),
              render: (row) => renderTokenValue(row.output_tokens)
            },
            {
              key: 'cache_creation_tokens',
              label: t('analytics.cacheCreationTokens'),
              render: (row) => renderTokenValue(row.cache_creation_tokens)
            },
            {
              key: 'cache_read_tokens',
              label: t('analytics.cacheReadTokens'),
              render: (row) => renderTokenValue(row.cache_read_tokens)
            },
            {
              key: 'cache_read_ratio',
              label: t('analytics.cacheReadRatio', { defaultValue: 'Cache Read Ratio' }),
              render: (row) => renderRateValue(getRowCacheReadRatio(row))
            },
            {
              key: 'total_cost_usd',
              label: t('analytics.costUsd'),
              render: (row) => `$${fmtMoney(row.total_cost_usd)}`
            }
          ])}

          {renderSimpleTable(t('analytics.providers'), providers, [
            { key: 'provider_name', label: t('analytics.provider') },
            { key: 'request_count', label: t('analytics.requests') },
            {
              key: 'input_tokens',
              label: inputTokenLabel,
              render: (row) => renderTokenValue(getEffectiveInputTokens(row))
            },
            {
              key: 'output_tokens',
              label: t('analytics.outputTokens'),
              render: (row) => renderTokenValue(row.output_tokens)
            },
            {
              key: 'cache_creation_tokens',
              label: t('analytics.cacheCreationTokens'),
              render: (row) => renderTokenValue(row.cache_creation_tokens)
            },
            {
              key: 'cache_read_tokens',
              label: t('analytics.cacheReadTokens'),
              render: (row) => renderTokenValue(row.cache_read_tokens)
            },
            {
              key: 'cache_read_ratio',
              label: t('analytics.cacheReadRatio', { defaultValue: 'Cache Read Ratio' }),
              render: (row) => renderRateValue(getRowCacheReadRatio(row))
            },
            {
              key: 'total_cost_usd',
              label: t('analytics.costUsd'),
              render: (row) => `$${fmtMoney(row.total_cost_usd)}`
            }
          ])}

          {renderSimpleTable(t('analytics.details'), details, [
            {
              key: 'created_at',
              label: t('analytics.time'),
              render: (row) => new Date(Number(row.created_at ?? 0)).toLocaleString()
            },
            { key: 'provider_name', label: t('analytics.provider') },
            { key: 'model_name', label: t('analytics.model') },
            {
              key: 'source_kind',
              label: t('analytics.source'),
              render: (row) => <Badge variant="secondary">{String(row.source_kind ?? '-')}</Badge>
            },
            {
              key: 'input_tokens',
              label: inputTokenLabel,
              render: (row) => renderTokenValue(getEffectiveInputTokens(row))
            },
            {
              key: 'output_tokens',
              label: t('analytics.outputTokens'),
              render: (row) => renderTokenValue(row.output_tokens)
            },
            {
              key: 'cache_creation_tokens',
              label: t('analytics.cacheCreationTokens'),
              render: (row) => renderTokenValue(row.cache_creation_tokens)
            },
            {
              key: 'cache_read_tokens',
              label: t('analytics.cacheReadTokens'),
              render: (row) => renderTokenValue(row.cache_read_tokens)
            },
            {
              key: 'cache_read_ratio',
              label: t('analytics.cacheReadRatio', { defaultValue: 'Cache Read Ratio' }),
              render: (row) => renderRateValue(getRowCacheReadRatio(row))
            },
            { key: 'ttft_ms', label: t('analytics.ttft'), render: (row) => fmtMs(row.ttft_ms) },
            {
              key: 'total_ms',
              label: t('analytics.totalMs'),
              render: (row) => fmtMs(row.total_ms)
            },
            {
              key: 'total_cost_usd',
              label: t('analytics.costUsd'),
              render: (row) => `$${fmtMoney(row.total_cost_usd)}`
            }
          ])}
        </>
      )}
    </SettingsPanel>
  )
}
