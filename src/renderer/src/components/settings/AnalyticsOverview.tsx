import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { Badge } from '@renderer/components/ui/badge'
import { getCacheReadRatio } from '@renderer/lib/format-tokens'
import { useSettingsStore } from '@renderer/stores/settings-store'
import type {
  UsageAnalyticsGroupRow,
  UsageAnalyticsOverview,
  UsageTimelineBucket
} from '@renderer/lib/usage-analytics'

type AnalyticsOverviewProps = {
  overview: UsageAnalyticsOverview | null
  timeline: UsageAnalyticsGroupRow[]
  rangeDays: 1 | 7 | 30
  bucket: UsageTimelineBucket
  from: number
  to: number
  tokenLocale: string
  inputTokenLabel: string
}

type TimelineDatum = {
  bucketLabel: string
  requestCount: number
  inputTokens: number
  totalInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
}

type ChartCardProps = {
  title: string
  badge: string
  summaryLabel: string
  summaryValue: React.JSX.Element | string
  children: React.JSX.Element
}

type MetricCardProps = {
  label: string
  value: React.JSX.Element | string
}

type AnalyticsTooltipEntry = {
  dataKey?: string | number
  value?: number | string
  color?: string
  name?: string | number
  payload?: Partial<TimelineDatum>
}

type AnalyticsTooltipProps = {
  active?: boolean
  payload?: AnalyticsTooltipEntry[]
  label?: string | number
  locale: string
}

const COST_COLOR = '#38bdf8'
const REQUESTS_STROKE = '#a78bfa'
const REQUESTS_FILL = '#a78bfa'
const INPUT_COLOR = '#f472b6'
const OUTPUT_COLOR = '#38bdf8'
const CACHE_HIT_COLOR = '#fbbf24'
const CACHE_CREATION_COLOR = '#a78bfa'
const GRID_COLOR = 'hsl(var(--border) / 0.28)'
const AXIS_COLOR = 'hsl(var(--muted-foreground) / 0.78)'

function toNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatBucketKey(date: Date, bucket: UsageTimelineBucket): string {
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())

  if (bucket === 'hour') {
    return `${year}-${month}-${day} ${pad(date.getHours())}:00`
  }

  return `${year}-${month}-${day}`
}

function startOfBucket(timestamp: number, bucket: UsageTimelineBucket): Date {
  const date = new Date(timestamp)

  if (bucket === 'hour') {
    date.setMinutes(0, 0, 0)
    return date
  }

  date.setHours(0, 0, 0, 0)
  return date
}

function stepBucket(date: Date, bucket: UsageTimelineBucket): Date {
  const next = new Date(date)

  if (bucket === 'hour') {
    next.setHours(next.getHours() + 1)
    return next
  }

  next.setDate(next.getDate() + 1)
  return next
}

function formatAxisLabel(label: string, bucket: UsageTimelineBucket): string {
  if (bucket === 'hour') {
    return label.slice(5)
  }

  return label.slice(5)
}

function fmtInt(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value)
}

function trimShortNumber(value: string): string {
  return value.replace(/\.0(?=[KMBT]$)/, '').replace(/(\.\d*[1-9])0(?=[KMBT]$)/, '$1')
}

function fmtTokenCompact(value: number): string {
  const normalized = Math.max(0, value)
  const units = [
    { threshold: 1_000_000_000_000, suffix: 'T' },
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' }
  ]

  for (const unit of units) {
    if (normalized >= unit.threshold) {
      return trimShortNumber(`${(normalized / unit.threshold).toFixed(2)}${unit.suffix}`)
    }
  }

  return `${Math.round(normalized)}`
}

function fmtAxisCompact(value: number, locale: string): string {
  if (value === 0) return '0'
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1
  }).format(value)
}

function fmtMoney(value: number): string {
  return value.toFixed(6)
}

function fmtMoneyCompact(value: number, locale: string): string {
  if (value === 0) return '$0'
  if (Math.abs(value) < 1) return '$' + value.toFixed(2)
  return '$' + fmtAxisCompact(value, locale)
}

function fmtPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1
  }).format(Math.max(0, value))
}

function fmtMs(value: unknown): string {
  const number = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(number) && number > 0 ? `${Math.round(number)} ms` : '-'
}

function renderTokenValue(value: number, locale: string, showRaw = false): React.JSX.Element {
  const compact = fmtTokenCompact(value)
  const raw = fmtInt(value, locale)
  const shouldShowRaw = showRaw && compact !== raw

  return (
    <span title={`${raw} Token`} className="inline-flex flex-col tabular-nums leading-tight">
      <span>{compact}</span>
      {shouldShowRaw ? <span className="text-[11px] text-muted-foreground">{raw}</span> : null}
    </span>
  )
}

function buildTimeline(
  rows: UsageAnalyticsGroupRow[],
  from: number,
  to: number,
  bucket: UsageTimelineBucket
): TimelineDatum[] {
  const byKey = new Map(rows.map((row) => [String(row.bucket_label ?? ''), row]))
  const normalized: TimelineDatum[] = []
  let cursor = startOfBucket(from, bucket)
  const end = startOfBucket(to, bucket)

  while (cursor.getTime() <= end.getTime()) {
    const bucketLabel = formatBucketKey(cursor, bucket)
    const row = byKey.get(bucketLabel)

    const inputTokens = toNumber(row?.input_tokens)
    const cacheReadTokens = toNumber(row?.cache_read_tokens)
    const cacheCreationTokens = toNumber(row?.cache_creation_tokens)
    const totalInputTokens = Math.max(
      toNumber(row?.total_input_tokens),
      inputTokens + cacheReadTokens + cacheCreationTokens
    )

    normalized.push({
      bucketLabel,
      requestCount: toNumber(row?.request_count),
      inputTokens,
      totalInputTokens,
      outputTokens: toNumber(row?.output_tokens),
      cacheReadTokens,
      cacheCreationTokens,
      totalCostUsd: toNumber(row?.total_cost_usd)
    })

    cursor = stepBucket(cursor, bucket)
  }

  return normalized
}

function MetricCard({
  label,
  value,
  index = 0,
  animationsEnabled = true
}: MetricCardProps & { index?: number; animationsEnabled?: boolean }): React.JSX.Element {
  return (
    <motion.div
      initial={animationsEnabled ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={
        animationsEnabled
          ? { duration: 0.22, delay: index * 0.04, ease: 'easeOut' }
          : { duration: 0 }
      }
      className="rounded-2xl border border-border/50 bg-background/50 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]"
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-2 text-lg font-semibold tabular-nums">{value}</div>
    </motion.div>
  )
}

function ChartCard({
  title,
  badge,
  summaryLabel,
  summaryValue,
  children,
  delay = 0,
  animationsEnabled = true
}: ChartCardProps & { delay?: number; animationsEnabled?: boolean }): React.JSX.Element {
  return (
    <motion.section
      initial={animationsEnabled ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={
        animationsEnabled ? { duration: 0.24, delay, ease: 'easeOut' } : { duration: 0 }
      }
      className="flex h-full min-h-0 flex-col rounded-2xl border border-border/50 bg-background/50 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Badge
            variant="outline"
            className="border-border/50 bg-muted/10 px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {badge}
          </Badge>
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-muted-foreground">{summaryLabel}</div>
          <div className="mt-1 text-base font-semibold tabular-nums">{summaryValue}</div>
        </div>
      </div>
      <div className="mt-4 flex-1 min-h-0">{children}</div>
    </motion.section>
  )
}

function EmptyChart({
  title,
  badge,
  animationsEnabled = true,
  delay = 0
}: {
  title: string
  badge: string
  animationsEnabled?: boolean
  delay?: number
}): React.JSX.Element {
  const { t } = useTranslation('settings')

  return (
    <ChartCard
      title={title}
      badge={badge}
      summaryLabel={t('analytics.requests')}
      summaryValue="0"
      animationsEnabled={animationsEnabled}
      delay={delay}
    >
      <div className="flex h-72 items-center justify-center rounded-xl border border-dashed border-border/40 bg-muted/15 text-sm text-muted-foreground">
        {t('analytics.empty')}
      </div>
    </ChartCard>
  )
}

function AnalyticsTooltip({
  active,
  payload,
  label,
  locale
}: AnalyticsTooltipProps): React.JSX.Element | null {
  const { t } = useTranslation('settings')

  if (!active || !payload?.length) return null

  const inputTokens = toNumber(
    payload.find((entry) => String(entry.dataKey ?? '') === 'inputTokens')?.value
  )
  const cacheReadTokens = toNumber(
    payload.find((entry) => String(entry.dataKey ?? '') === 'cacheReadTokens')?.value
  )
  const cacheCreationTokens = toNumber(
    payload.find((entry) => String(entry.dataKey ?? '') === 'cacheCreationTokens')?.value
  )
  const datumTotalInputTokens = toNumber(
    payload.find((entry) => entry.payload?.totalInputTokens != null)?.payload?.totalInputTokens
  )
  const totalInputTokens = Math.max(
    datumTotalInputTokens,
    inputTokens + cacheReadTokens + cacheCreationTokens
  )
  const cacheReadRatio = getCacheReadRatio(totalInputTokens, cacheReadTokens)
  const showCacheReadRatio =
    payload.some((entry) => {
      const key = String(entry.dataKey ?? '')
      return key === 'inputTokens' || key === 'cacheReadTokens' || key === 'cacheCreationTokens'
    }) && totalInputTokens > 0

  return (
    <div className="min-w-44 rounded-xl border border-border/60 bg-background/95 px-3 py-2 shadow-2xl backdrop-blur-sm">
      <div className="text-[11px] text-muted-foreground">{String(label ?? '')}</div>
      <div className="mt-2 space-y-1.5">
        {payload.map((entry) => {
          const key = String(entry.dataKey ?? '')
          const value = toNumber(entry.value)
          const formattedValue =
            key === 'totalCostUsd'
              ? '$' + fmtMoney(value)
              : key === 'requestCount'
                ? fmtInt(value, locale)
                : `${fmtTokenCompact(value)} Token`

          return (
            <div key={key} className="flex items-center justify-between gap-4 text-xs">
              <span className="flex items-center gap-2 text-muted-foreground">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: entry.color ?? 'currentColor' }}
                />
                <span>{String(entry.name ?? key)}</span>
              </span>
              <span className="font-medium tabular-nums text-foreground">{formattedValue}</span>
            </div>
          )
        })}
        {showCacheReadRatio ? (
          <div className="mt-2 flex items-center justify-between gap-4 border-t border-border/40 pt-2 text-xs">
            <span className="text-muted-foreground">
              {t('analytics.cacheReadRatio', { defaultValue: 'Cache Read Ratio' })}
            </span>
            <span className="font-medium tabular-nums text-foreground">
              {fmtPercent(cacheReadRatio, locale)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AnalyticsOverview({
  overview,
  timeline,
  rangeDays,
  bucket,
  from,
  to,
  tokenLocale,
  inputTokenLabel
}: AnalyticsOverviewProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)

  const rangeLabel =
    rangeDays === 1
      ? t('analytics.range24h')
      : rangeDays === 7
        ? t('analytics.range7d')
        : t('analytics.range30d')
  const bucketLabel = bucket === 'hour' ? t('analytics.hourly') : t('analytics.daily')
  const chartBadge = `${rangeLabel} · ${bucketLabel}`

  const chartData = useMemo(
    () => buildTimeline(timeline, from, to, bucket),
    [timeline, from, to, bucket]
  )
  const hasData = chartData.some(
    (row) =>
      row.requestCount > 0 ||
      row.totalCostUsd > 0 ||
      row.inputTokens > 0 ||
      row.outputTokens > 0 ||
      row.cacheReadTokens > 0 ||
      row.cacheCreationTokens > 0
  )

  const totalCost = toNumber(overview?.total_cost_usd)
  const totalRequests = toNumber(overview?.request_count)
  const totalInputTokens = toNumber(overview?.input_tokens)
  const totalOutputTokens = toNumber(overview?.output_tokens)
  const totalCacheReadTokens = toNumber(overview?.cache_read_tokens)
  const totalCacheCreationTokens = toNumber(overview?.cache_creation_tokens)
  const totalPromptInputTokens = Math.max(
    toNumber(overview?.total_input_tokens),
    totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens
  )
  const totalCacheReadRatio = getCacheReadRatio(totalPromptInputTokens, totalCacheReadTokens)
  const totalTokenComposition =
    totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheCreationTokens

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          index={0}
          animationsEnabled={animationsEnabled}
          label={t('analytics.costUsd')}
          value={'$' + fmtMoney(totalCost)}
        />
        <MetricCard
          index={1}
          animationsEnabled={animationsEnabled}
          label={t('analytics.requests')}
          value={fmtInt(totalRequests, tokenLocale)}
        />
        <MetricCard
          index={2}
          animationsEnabled={animationsEnabled}
          label={t('analytics.outputTokens')}
          value={renderTokenValue(totalOutputTokens, tokenLocale, true)}
        />
        <MetricCard
          index={3}
          animationsEnabled={animationsEnabled}
          label={t('analytics.cacheReadRatio', { defaultValue: 'Cache Read Ratio' })}
          value={fmtPercent(totalCacheReadRatio, tokenLocale)}
        />
        <MetricCard
          index={4}
          animationsEnabled={animationsEnabled}
          label={t('analytics.avgTotal')}
          value={fmtMs(overview?.avg_total_ms)}
        />
      </section>

      <section className="grid gap-4 items-stretch xl:grid-cols-12">
        <div className="h-full xl:col-span-5">
          {hasData ? (
            <ChartCard
              delay={0.08}
              animationsEnabled={animationsEnabled}
              title={t('analytics.chartCost')}
              badge={chartBadge}
              summaryLabel={t('analytics.costUsd')}
              summaryValue={'$' + fmtMoney(totalCost)}
            >
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} barGap={2}>
                    <CartesianGrid stroke={GRID_COLOR} vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="bucketLabel"
                      tickFormatter={(value) => formatAxisLabel(String(value), bucket)}
                      tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={28}
                      tickMargin={8}
                    />
                    <YAxis
                      tickFormatter={(value: number) => fmtMoneyCompact(value, tokenLocale)}
                      tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                    />
                    <Tooltip
                      cursor={{ fill: 'hsl(var(--muted) / 0.25)' }}
                      content={<AnalyticsTooltip locale={tokenLocale} />}
                    />
                    <Legend wrapperStyle={{ paddingTop: 8, fontSize: 12, color: AXIS_COLOR }} />
                    <Bar
                      dataKey="totalCostUsd"
                      name={t('analytics.costUsd')}
                      fill={COST_COLOR}
                      radius={[6, 6, 0, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          ) : (
            <EmptyChart
              title={t('analytics.chartCost')}
              badge={chartBadge}
              animationsEnabled={animationsEnabled}
              delay={0.08}
            />
          )}
        </div>

        <div className="h-full xl:col-span-7">
          {hasData ? (
            <ChartCard
              delay={0.12}
              animationsEnabled={animationsEnabled}
              title={t('analytics.chartTokens')}
              badge={chartBadge}
              summaryLabel={t('analytics.chartTokens')}
              summaryValue={renderTokenValue(totalTokenComposition, tokenLocale)}
            >
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} barGap={2}>
                    <CartesianGrid stroke={GRID_COLOR} vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="bucketLabel"
                      tickFormatter={(value) => formatAxisLabel(String(value), bucket)}
                      tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={28}
                      tickMargin={8}
                    />
                    <YAxis
                      tickFormatter={(value: number) => fmtTokenCompact(value)}
                      tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                    />
                    <Tooltip
                      cursor={{ fill: 'hsl(var(--muted) / 0.25)' }}
                      content={<AnalyticsTooltip locale={tokenLocale} />}
                    />
                    <Legend wrapperStyle={{ paddingTop: 8, fontSize: 12, color: AXIS_COLOR }} />
                    <Bar
                      dataKey="inputTokens"
                      name={inputTokenLabel}
                      stackId="tokens"
                      fill={INPUT_COLOR}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="outputTokens"
                      name={t('analytics.outputTokens')}
                      stackId="tokens"
                      fill={OUTPUT_COLOR}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="cacheReadTokens"
                      name={t('analytics.cacheReadTokens')}
                      stackId="tokens"
                      fill={CACHE_HIT_COLOR}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="cacheCreationTokens"
                      name={t('analytics.cacheCreationTokens')}
                      stackId="tokens"
                      fill={CACHE_CREATION_COLOR}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          ) : (
            <EmptyChart
              title={t('analytics.chartTokens')}
              badge={chartBadge}
              animationsEnabled={animationsEnabled}
              delay={0.12}
            />
          )}
        </div>

        <div className="h-full xl:col-span-12">
          {hasData ? (
            <ChartCard
              delay={0.16}
              animationsEnabled={animationsEnabled}
              title={t('analytics.chartRequests')}
              badge={chartBadge}
              summaryLabel={t('analytics.requests')}
              summaryValue={fmtInt(totalRequests, tokenLocale)}
            >
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="analytics-requests-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={REQUESTS_FILL} stopOpacity={0.35} />
                        <stop offset="95%" stopColor={REQUESTS_FILL} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={GRID_COLOR} vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="bucketLabel"
                      tickFormatter={(value) => formatAxisLabel(String(value), bucket)}
                      tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={28}
                      tickMargin={8}
                    />
                    <YAxis
                      tickFormatter={(value: number) => fmtTokenCompact(value)}
                      tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={48}
                    />
                    <Tooltip
                      cursor={{
                        stroke: 'hsl(var(--muted-foreground) / 0.25)',
                        strokeDasharray: '4 4'
                      }}
                      content={<AnalyticsTooltip locale={tokenLocale} />}
                    />
                    <Legend wrapperStyle={{ paddingTop: 8, fontSize: 12, color: AXIS_COLOR }} />
                    <Area
                      type="monotone"
                      dataKey="requestCount"
                      name={t('analytics.requests')}
                      stroke={REQUESTS_STROKE}
                      fill="url(#analytics-requests-fill)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          ) : (
            <EmptyChart
              title={t('analytics.chartRequests')}
              badge={chartBadge}
              animationsEnabled={animationsEnabled}
              delay={0.16}
            />
          )}
        </div>
      </section>
    </div>
  )
}
