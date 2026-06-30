import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Copy,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Wrench,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import {
  collectRemoteMonitorSnapshot,
  installRemoteMonitorRuntime,
  isRemoteMonitorInstalled,
  type MonitorProcessSample,
  type MonitorSnapshot
} from './ssh-monitor-runtime'

const ACTIVE_REFRESH_INTERVAL_MS = 4000

const FS = {
  bg: '#141414',
  panel: '#1b1b1b',
  inner: '#232323',
  card: '#202020',
  border: '#333333',
  text: '#e5e7eb',
  textStrong: '#fafafa',
  muted: '#9ca3af',
  green: '#30c56b',
  greenSoft: '#173620',
  blue: '#4b9fff',
  yellow: '#eab308',
  red: '#ef4444',
  track: '#2a2a2a'
} as const

function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`
}

function formatStorageKb(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return '--'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = kb
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`
}

function formatSeconds(value: string): string {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return '--'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatDiskKb(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return '--'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = kb
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%'
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function valuePercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, (used / total) * 100))
}

function RingMeter({ value, color }: { value: number; color: string }): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div
      className="relative size-[54px] rounded-full"
      style={{
        background: `conic-gradient(${color} 0 ${clamped}%, ${FS.track} ${clamped}% 100%)`
      }}
    >
      <div
        className="absolute inset-[8px] rounded-full"
        style={{ background: FS.card, boxShadow: `inset 0 0 0 1px ${FS.border}` }}
      />
      <div className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold">
        {formatPercent(clamped)}
      </div>
    </div>
  )
}

function MiniBars({ values, color }: { values: number[]; color: string }): React.JSX.Element {
  const slots = 28
  const recent = values.slice(-slots)
  const padded = [
    ...Array.from<number>({ length: Math.max(0, slots - recent.length) }).fill(0),
    ...recent
  ]
  const peak = Math.max(1, ...padded)

  return (
    <div className="flex h-10 items-end gap-[2px]">
      {padded.map((item, index) => (
        <div
          key={`bar-${index}`}
          className="flex-1 rounded-[2px] transition-[height] duration-300 ease-out"
          style={{
            height: `${Math.max(8, (item / peak) * 100)}%`,
            background: item > 0 ? color : FS.track,
            opacity: item > 0 ? 1 : 0.48
          }}
        />
      ))}
    </div>
  )
}

function Section({
  title,
  icon,
  children,
  action
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      className="rounded-[10px] border px-3 py-3"
      style={{ borderColor: FS.border, background: FS.card }}
    >
      <div className="flex items-center justify-between gap-3">
        <div
          className="flex items-center gap-2 text-[13px] font-semibold"
          style={{ color: FS.textStrong }}
        >
          {icon}
          <span>{title}</span>
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function DetailChip({
  label,
  value,
  tone = 'default'
}: {
  label: string
  value: string
  tone?: 'default' | 'green' | 'blue'
}): React.JSX.Element {
  const styles =
    tone === 'green'
      ? { background: FS.greenSoft, color: FS.green }
      : tone === 'blue'
        ? { background: '#1a2b44', color: FS.blue }
        : { background: FS.inner, color: FS.text }

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[8px] px-2.5 py-2" style={styles}>
      <span className="shrink-0 text-[11px]" style={{ color: FS.muted }}>
        {label}
      </span>
      <span className="truncate text-[12px] font-medium">{value}</span>
    </div>
  )
}

function TopProcess({ item }: { item: MonitorProcessSample | undefined }): React.JSX.Element {
  if (!item) {
    return (
      <div className="text-[12px]" style={{ color: FS.muted }}>
        --
      </div>
    )
  }

  return (
    <div className="rounded-[10px] px-2.5 py-2" style={{ background: FS.inner }}>
      <div className="truncate text-[12px] font-medium" style={{ color: FS.textStrong }}>
        {item.command}
      </div>
      <div
        className="mt-1 flex items-center justify-between gap-2 text-[11px]"
        style={{ color: FS.muted }}
      >
        <span>PID {item.pid}</span>
        <span>{item.cpu}</span>
      </div>
    </div>
  )
}

export function SshTerminalStatusPanel({
  connectionId,
  connectionName,
  host,
  onClose
}: {
  connectionId: string
  connectionName: string
  host: string
  onClose: () => void
  onExpandProcesses?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null)
  const [cpuPoints, setCpuPoints] = useState<number[]>([])
  const [rxPoints, setRxPoints] = useState<number[]>([])
  const [txPoints, setTxPoints] = useState<number[]>([])
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const refreshInFlightRef = useRef(false)

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (!installed) return
      if (refreshInFlightRef.current && !force) return
      refreshInFlightRef.current = true

      try {
        if (!snapshot) setLoading(true)
        const result = await collectRemoteMonitorSnapshot(connectionId)
        setSnapshot(result.snapshot)
        setCpuPoints((current) => [...current.slice(-27), result.snapshot.cpu.percent])
        setRxPoints((current) => [...current.slice(-27), result.snapshot.networkStat.rxBytesPerSec])
        setTxPoints((current) => [...current.slice(-27), result.snapshot.networkStat.txBytesPerSec])
        setLastUpdatedAt(Date.now())
        setError(null)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setLoading(false)
        refreshInFlightRef.current = false
      }
    },
    [connectionId, installed, snapshot]
  )

  useEffect(() => {
    let cancelled = false

    const bootstrap = async (): Promise<void> => {
      setLoading(true)
      try {
        const ready = await isRemoteMonitorInstalled(connectionId)
        if (cancelled) return
        setInstalled(ready)
        setError(null)
      } catch (reason) {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [connectionId])

  useEffect(() => {
    if (!installed) return
    void refresh(true)

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }, ACTIVE_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [installed, refresh])

  const handleInstall = useCallback(async (): Promise<void> => {
    setInstalling(true)
    try {
      await installRemoteMonitorRuntime(connectionId)
      setInstalled(true)
      toast.success(
        t('workspace.terminalStatus.installed', {
          defaultValue: 'Remote monitor runtime installed'
        })
      )
      await refresh(true)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      toast.error(message)
    } finally {
      setInstalling(false)
    }
  }, [connectionId, refresh, t])

  const ipText = host
  const memoryPercent = snapshot ? valuePercent(snapshot.memory.used, snapshot.memory.total) : 0
  const cachePercent = snapshot ? valuePercent(snapshot.memory.buffcache, snapshot.memory.total) : 0
  const freePercent = snapshot ? valuePercent(snapshot.memory.free, snapshot.memory.total) : 0
  const primaryDisk = useMemo(
    () => snapshot?.fsSize.find((entry) => entry.mount === '/') ?? snapshot?.fsSize[0] ?? null,
    [snapshot]
  )
  const statusSubtitle =
    lastUpdatedAt != null
      ? t('workspace.terminalStatus.updatedAt', {
          defaultValue: 'Updated {{time}}',
          time: new Date(lastUpdatedAt).toLocaleTimeString()
        })
      : host

  const copyIp = (): void => {
    void navigator.clipboard.writeText(ipText)
    toast.success(t('workspace.terminalStatus.copied', { defaultValue: 'Copied to clipboard' }))
  }

  return (
    <aside
      className="relative flex h-full min-w-0 flex-1 flex-col border-l"
      style={{ borderColor: FS.border, background: FS.bg, color: FS.text }}
    >
      <div
        className="flex items-center justify-between gap-3 border-b px-3 py-2.5"
        style={{ borderColor: FS.border }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px]"
            style={{
              background: installed ? FS.greenSoft : FS.inner,
              color: installed ? FS.green : FS.muted
            }}
          >
            {installed ? <Activity className="size-4" /> : <Wrench className="size-4" />}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold" style={{ color: FS.textStrong }}>
              {connectionName}
            </div>
            <div
              className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px]"
              style={{ color: FS.muted }}
            >
              <span className="truncate">
                {t('workspace.terminalStatus.title', { defaultValue: 'Monitor' })}
              </span>
              <span className="shrink-0">·</span>
              <span className="truncate">{statusSubtitle}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 rounded-[8px]"
            style={{ color: FS.muted }}
            onClick={copyIp}
            title={t('workspace.terminalStatus.copy', { defaultValue: 'Copy address' })}
          >
            <Copy className="size-3.5" />
          </Button>
          {installed ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 rounded-[8px]"
              style={{ color: FS.muted }}
              onClick={() => void refresh(true)}
              title={t('list.refresh')}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 rounded-[8px]"
            style={{ color: FS.muted }}
            onClick={onClose}
            title={t('workspace.close', { defaultValue: 'Close' })}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {!installed ? (
          <div className="flex h-full items-center justify-center">
            <div
              className="w-full rounded-[16px] border px-4 py-5"
              style={{ borderColor: FS.border, background: FS.card }}
            >
              <div
                className="inline-flex size-10 items-center justify-center rounded-[12px]"
                style={{ background: FS.greenSoft, color: FS.green }}
              >
                <Wrench className="size-4.5" />
              </div>
              <div className="mt-4 text-[15px] font-semibold" style={{ color: FS.textStrong }}>
                {t('workspace.terminalStatus.installTitle', {
                  defaultValue: 'Install monitor runtime'
                })}
              </div>
              <p className="mt-2 text-[12px] leading-6" style={{ color: FS.muted }}>
                {t('workspace.terminalStatus.installBody', {
                  defaultValue:
                    'Deploy the remote collector to ~/.open-cowork/xterminal, then OpenCowork will read output.stats on demand.'
                })}
              </p>
              {error ? (
                <div
                  className="mt-3 rounded-[10px] border px-3 py-2 text-[12px]"
                  style={{ borderColor: FS.red, background: '#291819', color: FS.red }}
                >
                  {error}
                </div>
              ) : null}
              <Button
                className="mt-4 h-10 w-full rounded-[12px] font-semibold"
                style={{ background: FS.green, color: '#0b120d' }}
                onClick={() => void handleInstall()}
                disabled={installing}
              >
                {installing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Wrench className="size-4" />
                )}
                {t('workspace.terminalStatus.installAction', {
                  defaultValue: 'Install monitor commands'
                })}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {error ? (
              <div
                className="rounded-[12px] border px-3 py-2 text-[12px]"
                style={{ borderColor: FS.red, background: '#291819', color: FS.red }}
              >
                {error}
              </div>
            ) : null}

            <Section
              title={t('workspace.terminalStatus.systemInfo', { defaultValue: 'System' })}
              icon={<Server className="size-3.5" style={{ color: FS.green }} />}
              action={
                <div
                  className="rounded-[8px] px-2 py-1 text-[11px] font-semibold"
                  style={{ background: FS.greenSoft, color: FS.green }}
                >
                  {snapshot?.os.type || 'Linux'}
                </div>
              }
            >
              <div className="space-y-2">
                <DetailChip
                  label={t('workspace.addressTitle', { defaultValue: 'Address' })}
                  value={ipText}
                  tone="blue"
                />
                <DetailChip
                  label={t('workspace.terminalStatus.os', { defaultValue: 'OS' })}
                  value={snapshot?.os.prettyName || '--'}
                />
                <div className="grid grid-cols-2 gap-2">
                  <DetailChip
                    label={t('workspace.terminalStatus.timezone', { defaultValue: 'Timezone' })}
                    value={
                      snapshot ? `${snapshot.time.timezone} ${snapshot.time.timezoneName}` : '--'
                    }
                  />
                  <DetailChip
                    label={t('workspace.terminalStatus.uptime', { defaultValue: 'Uptime' })}
                    value={snapshot ? formatSeconds(snapshot.time.uptime) : '--'}
                    tone="green"
                  />
                </div>
              </div>
            </Section>

            <Section
              title="CPU"
              icon={<Cpu className="size-3.5" style={{ color: FS.green }} />}
              action={
                <span className="text-[12px] font-semibold" style={{ color: FS.textStrong }}>
                  {snapshot ? formatPercent(snapshot.cpu.percent) : '--'}
                </span>
              }
            >
              <MiniBars values={cpuPoints} color={FS.green} />
              <div
                className="mt-2 flex items-center justify-between text-[12px]"
                style={{ color: FS.muted }}
              >
                <span>{t('workspace.terminalStatus.load', { defaultValue: 'Load' })}</span>
                <span className="font-mono" style={{ color: FS.text }}>
                  {snapshot?.cpu.load || '--'}
                </span>
              </div>
              <div className="mt-2">
                <TopProcess item={snapshot?.process.topsCostCpu[0]} />
              </div>
            </Section>

            <Section
              title={t('workspace.terminalStatus.memory', { defaultValue: 'Memory' })}
              icon={<MemoryStick className="size-3.5" style={{ color: FS.green }} />}
              action={
                <span className="text-[12px] font-semibold" style={{ color: FS.textStrong }}>
                  {snapshot ? formatStorageKb(snapshot.memory.total) : '--'}
                </span>
              }
            >
              <div className="flex items-center gap-3">
                <RingMeter value={memoryPercent} color={FS.green} />
                <div className="grid flex-1 gap-2">
                  <DetailChip
                    label={t('workspace.terminalStatus.used', { defaultValue: 'Used' })}
                    value={snapshot ? formatStorageKb(snapshot.memory.used) : '--'}
                  />
                  <DetailChip
                    label={t('workspace.terminalStatus.cached', { defaultValue: 'Cache' })}
                    value={snapshot ? formatStorageKb(snapshot.memory.buffcache) : '--'}
                  />
                  <DetailChip
                    label={t('workspace.terminalStatus.free', { defaultValue: 'Free' })}
                    value={snapshot ? formatStorageKb(snapshot.memory.free) : '--'}
                    tone="green"
                  />
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]" style={{ color: FS.muted }}>
                <div>
                  {t('workspace.terminalStatus.used', { defaultValue: 'Used' })}:{' '}
                  {formatPercent(memoryPercent)}
                </div>
                <div>
                  {t('workspace.terminalStatus.cached', { defaultValue: 'Cache' })}:{' '}
                  {formatPercent(cachePercent)}
                </div>
                <div>
                  {t('workspace.terminalStatus.free', { defaultValue: 'Free' })}:{' '}
                  {formatPercent(freePercent)}
                </div>
              </div>
            </Section>

            <Section
              title={t('workspace.terminalStatus.network', { defaultValue: 'Network' })}
              icon={<Network className="size-3.5" style={{ color: FS.green }} />}
            >
              <div className="space-y-2">
                <MiniBars values={rxPoints} color={FS.green} />
                <MiniBars values={txPoints} color={FS.blue} />
                <div className="grid grid-cols-2 gap-2">
                  <DetailChip
                    label={t('workspace.terminalStatus.upload', { defaultValue: 'Upload' })}
                    value={snapshot ? formatRate(snapshot.networkStat.txBytesPerSec) : '--'}
                    tone="green"
                  />
                  <DetailChip
                    label={t('workspace.terminalStatus.download', { defaultValue: 'Download' })}
                    value={snapshot ? formatRate(snapshot.networkStat.rxBytesPerSec) : '--'}
                    tone="blue"
                  />
                </div>
                <div
                  className="flex items-center justify-between text-[11px]"
                  style={{ color: FS.muted }}
                >
                  <span className="inline-flex items-center gap-1">
                    <ArrowUpRight className="size-3" />
                    {snapshot ? formatRate(snapshot.networkStat.txBytesPerSec) : '--'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ArrowDownRight className="size-3" />
                    {snapshot ? formatRate(snapshot.networkStat.rxBytesPerSec) : '--'}
                  </span>
                </div>
              </div>
            </Section>

            <Section
              title={t('workspace.terminalStatus.disks', { defaultValue: 'Disks' })}
              icon={<HardDrive className="size-3.5" style={{ color: FS.green }} />}
              action={
                <span className="text-[12px] font-semibold" style={{ color: FS.textStrong }}>
                  {primaryDisk
                    ? `${formatDiskKb(primaryDisk.used)} / ${formatDiskKb(primaryDisk.size)}`
                    : '--'}
                </span>
              }
            >
              {primaryDisk ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <DetailChip
                      label={t('workspace.terminalStatus.mount', { defaultValue: 'Mount' })}
                      value={primaryDisk.mount}
                      tone="green"
                    />
                    <DetailChip
                      label={t('workspace.terminalStatus.fsType', { defaultValue: 'Type' })}
                      value={primaryDisk.type || '--'}
                    />
                  </div>
                  <div className="rounded-[10px] px-2.5 py-2" style={{ background: FS.inner }}>
                    <div
                      className="mb-2 flex items-center justify-between text-[11px]"
                      style={{ color: FS.muted }}
                    >
                      <span>{primaryDisk.fs}</span>
                      <span>{formatPercent(primaryDisk.percent)}</span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full"
                      style={{ background: FS.track }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(4, primaryDisk.percent)}%`,
                          background: FS.green
                        }}
                      />
                    </div>
                    <div
                      className="mt-2 flex items-center justify-between text-[11px]"
                      style={{ color: FS.muted }}
                    >
                      <span>{formatDiskKb(primaryDisk.available)} free</span>
                      <span>{formatDiskKb(primaryDisk.size)} total</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-[12px]" style={{ color: FS.muted }}>
                  --
                </div>
              )}
            </Section>

            <Section
              title={t('workspace.terminalStatus.activity', { defaultValue: 'Activity' })}
              icon={<Activity className="size-3.5" style={{ color: FS.green }} />}
            >
              <div className="grid grid-cols-2 gap-2">
                <DetailChip
                  label={t('workspace.terminalStatus.running', { defaultValue: 'Running' })}
                  value={snapshot ? String(snapshot.process.running) : '--'}
                  tone="green"
                />
                <DetailChip
                  label={t('workspace.terminalStatus.sleeping', { defaultValue: 'Sleeping' })}
                  value={snapshot ? String(snapshot.process.sleeping) : '--'}
                />
              </div>
              <div className="mt-2">
                <TopProcess item={snapshot?.process.topsCostMemory[0]} />
              </div>
            </Section>
          </div>
        )}
      </div>

      {loading && installed && !snapshot ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ background: `${FS.bg}d9` }}
        >
          <Loader2 className="size-5 animate-spin" style={{ color: FS.textStrong }} />
        </div>
      ) : null}
    </aside>
  )
}
