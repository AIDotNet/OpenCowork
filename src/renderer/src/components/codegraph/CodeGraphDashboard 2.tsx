import { useTranslation } from 'react-i18next'
import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useTheme } from 'next-themes'
import { FileCode2, Boxes, GitFork, AlertTriangle, Database, Activity } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useCodeGraphStore } from '@renderer/stores/codegraph-store'
import type { CgBucket, CgIndexStatus, CgStats } from '@renderer/stores/codegraph-store'

// Muted ink for axis labels + value labels — identical in both modes (dataviz palette).
const AXIS_INK = '#898781'

// One solid hue per chart (bar length already encodes magnitude, so color is panel
// identity, not a gradient). Hues are validated categorical slots, stepped per mode.
function chartPalette(dark: boolean): { nodes: string; edges: string; langs: string } {
  return dark
    ? { nodes: '#3987e5', edges: '#9085e9', langs: '#d95926' }
    : { nodes: '#2a78d6', edges: '#4a3aa7', langs: '#eb6834' }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function num(n: number): string {
  return n.toLocaleString()
}

interface StatTileProps {
  label: string
  value: string
  icon: React.ReactNode
  accent?: string
}

function StatTile({ label, value, icon, accent }: StatTileProps): React.JSX.Element {
  return (
    <div className="relative rounded-lg border bg-muted/10 px-3 py-2">
      <div className="absolute right-2 top-2 text-muted-foreground/40">{icon}</div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold ${accent ?? ''}`}>{value}</p>
    </div>
  )
}

function DistributionChart({
  title,
  buckets,
  color,
  dark
}: {
  title: string
  buckets: CgBucket[]
  color: string
  dark: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const data = buckets.slice(0, 12)
  const height = Math.max(120, data.length * 28 + 16)
  const surface = dark ? '#1a1a19' : '#fcfcfb'
  const ink = dark ? '#ffffff' : '#0b0b0b'
  const border = dark ? 'rgba(255,255,255,0.10)' : 'rgba(11,11,11,0.10)'
  return (
    <div className="rounded-xl border p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
      {data.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {t('codegraphPage.charts.noData')}
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 2, right: 40, bottom: 2, left: 4 }}
          >
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="key"
              width={108}
              tick={{ fontSize: 11, fill: AXIS_INK }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: dark ? 'rgba(255,255,255,0.06)' : 'rgba(11,11,11,0.05)' }}
              contentStyle={{
                background: surface,
                border: `1px solid ${border}`,
                borderRadius: 8,
                fontSize: 12,
                color: ink
              }}
              labelStyle={{ color: ink }}
              itemStyle={{ color: ink }}
            />
            <Bar
              dataKey="count"
              fill={color}
              radius={[0, 4, 4, 0]}
              maxBarSize={16}
              isAnimationActive={false}
            >
              <LabelList dataKey="count" position="right" fill={AXIS_INK} fontSize={10} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export function CodeGraphDashboard({
  status,
  stats,
  loading
}: {
  status: CgIndexStatus | null
  stats: CgStats | null
  loading: boolean
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme !== 'light'
  const palette = chartPalette(dark)

  if (loading && !status) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    )
  }

  const state = status?.state ?? '—'
  const stateAccent =
    state === 'complete'
      ? 'text-emerald-600'
      : state === 'indexing'
        ? 'text-amber-600'
        : state === 'partial' || state === 'failed'
          ? 'text-destructive'
          : ''

  const lastIndexed = status?.lastIndexedAt
    ? new Date(status.lastIndexedAt).toLocaleString()
    : t('codegraphPage.freshness.never')

  return (
    <div className="space-y-4 p-4">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label={t('codegraphPage.kpi.files')}
          value={num(status?.fileCount ?? 0)}
          icon={<FileCode2 className="size-4" />}
        />
        <StatTile
          label={t('codegraphPage.kpi.nodes')}
          value={num(status?.nodeCount ?? 0)}
          icon={<Boxes className="size-4" />}
        />
        <StatTile
          label={t('codegraphPage.kpi.edges')}
          value={num(status?.edgeCount ?? 0)}
          icon={<GitFork className="size-4" />}
        />
        <StatTile
          label={t('codegraphPage.kpi.pendingRefs')}
          value={num(status?.pendingReferenceCount ?? 0)}
          icon={<AlertTriangle className="size-4" />}
          accent={status && status.pendingReferenceCount > 0 ? 'text-amber-600' : ''}
        />
        <StatTile
          label={t('codegraphPage.kpi.dbSize')}
          value={formatBytes(status?.dbSizeBytes ?? 0)}
          icon={<Database className="size-4" />}
        />
        <StatTile
          label={t('codegraphPage.kpi.state')}
          value={state}
          icon={<Activity className="size-4" />}
          accent={stateAccent}
        />
      </div>

      {/* Freshness card */}
      <div className="rounded-xl border p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium">{t('codegraphPage.freshness.title')}</p>
          {status?.indexing ? (
            <Badge variant="secondary" className="gap-1.5 text-[10px] text-amber-600">
              <Spinner className="size-3" />
              {t('codegraphPage.freshness.indexing')}
            </Badge>
          ) : status?.stale ? (
            <Badge variant="secondary" className="text-[10px] text-amber-600">
              {t('codegraphPage.freshness.stale')}
            </Badge>
          ) : status?.indexed ? (
            <Badge variant="secondary" className="text-[10px] text-emerald-600">
              {t('codegraphPage.freshness.upToDate')}
            </Badge>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">{t('codegraphPage.freshness.lastIndexed')}</dt>
            <dd className="mt-0.5 font-medium">{lastIndexed}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {t('codegraphPage.freshness.extractionVersion')}
            </dt>
            <dd className="mt-0.5 font-medium">{status?.indexedWithVersion ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('codegraphPage.freshness.backend')}</dt>
            <dd className="mt-0.5 font-medium">{status?.backend ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('codegraphPage.freshness.journal')}</dt>
            <dd className="mt-0.5 font-medium">{status?.journalMode ?? '—'}</dd>
          </div>
        </dl>
      </div>

      {/* Distribution charts */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <DistributionChart
          title={t('codegraphPage.charts.nodesByKind')}
          buckets={stats?.nodesByKind ?? []}
          color={palette.nodes}
          dark={dark}
        />
        <DistributionChart
          title={t('codegraphPage.charts.edgesByKind')}
          buckets={stats?.edgesByKind ?? []}
          color={palette.edges}
          dark={dark}
        />
        <DistributionChart
          title={t('codegraphPage.charts.filesByLanguage')}
          buckets={stats?.filesByLanguage ?? []}
          color={palette.langs}
          dark={dark}
        />
      </div>

      {/* Graph health analytics (M7-W3): cycles + dead code, computed on demand. */}
      <AnalyticsCard />

      {/* Agent tool surface (M7-W3): default = explore only (upstream DEFAULT_MCP_TOOLS);
          the switch registers the full 8-tool surface as shaped by codegraph/tools-list. */}
      <ToolSurfaceCard />
    </div>
  )
}

function AnalyticsCard(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const selectedRoot = useCodeGraphStore((s) => s.selectedRoot)
  const analytics = useCodeGraphStore((s) => s.analytics)
  const analyticsLoading = useCodeGraphStore((s) => s.analyticsLoading)
  const loadAnalytics = useCodeGraphStore((s) => s.loadAnalytics)
  if (!selectedRoot) return null

  return (
    <div className="rounded-xl border p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('codegraphPage.analytics.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('codegraphPage.analytics.description')}
          </p>
        </div>
        <button
          onClick={() => void loadAnalytics(selectedRoot)}
          disabled={analyticsLoading}
          className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {analyticsLoading ? (
            <span className="flex items-center gap-1.5">
              <Spinner className="size-3" />
              {t('codegraphPage.analytics.running')}
            </span>
          ) : analytics ? (
            t('codegraphPage.analytics.rerun')
          ) : (
            t('codegraphPage.analytics.run')
          )}
        </button>
      </div>

      {analytics ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* Circular dependencies */}
          <div className="rounded-lg border border-border/60 p-3">
            <p className="mb-2 text-xs font-medium">
              {t('codegraphPage.analytics.cycles', { count: analytics.circularTotal })}
              {analytics.circularTotal > analytics.circularDependencies.length
                ? ` (${t('codegraphPage.analytics.showingTop', { count: analytics.circularDependencies.length })})`
                : ''}
            </p>
            {analytics.circularDependencies.length === 0 ? (
              <p className="text-xs text-emerald-600">{t('codegraphPage.analytics.noCycles')}</p>
            ) : (
              <ul className="max-h-48 space-y-1.5 overflow-y-auto">
                {analytics.circularDependencies.map((cycle, i) => (
                  <li key={i} className="break-all font-mono text-[11px] text-muted-foreground">
                    {cycle.files.join(' → ')}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Dead code */}
          <div className="rounded-lg border border-border/60 p-3">
            <p className="mb-2 text-xs font-medium">
              {t('codegraphPage.analytics.deadCode', { count: analytics.deadCodeTotal })}
              {analytics.deadCodeTotal > analytics.deadCode.length
                ? ` (${t('codegraphPage.analytics.showingTop', { count: analytics.deadCode.length })})`
                : ''}
            </p>
            {analytics.deadCode.length === 0 ? (
              <p className="text-xs text-emerald-600">{t('codegraphPage.analytics.noDeadCode')}</p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {analytics.deadCode.map((d) => (
                  <li key={d.id} className="flex items-baseline gap-2 text-[11px]">
                    <span className="font-mono font-medium">{d.name}</span>
                    <span className="text-muted-foreground">{d.kind}</span>
                    <span className="min-w-0 truncate font-mono text-muted-foreground">
                      {d.filePath}:{d.startLine}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ToolSurfaceCard(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const fullSurface = useSettingsStore((s) => s.codegraphFullToolSurface)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('codegraphPage.toolSurface.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('codegraphPage.toolSurface.description')}
          </p>
        </div>
        <Switch
          checked={fullSurface}
          onCheckedChange={(checked) => updateSettings({ codegraphFullToolSurface: checked })}
        />
      </div>
    </div>
  )
}
