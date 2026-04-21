import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownRight,
  ArrowUpRight,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Server,
  X
} from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  getSshChromePalette,
  resolveAppThemeMode,
  type SshChromePalette
} from '@renderer/lib/theme-presets'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/stores/settings-store'

type StatusProcess = {
  memoryKb: number
  cpu: number
  command: string
}

type StatusDisk = {
  path: string
  usage: string
}

type StatusSnapshot = {
  ip: string
  uptime: string
  load: string
  cpuPercent: number
  memTotalKb: number
  memUsedKb: number
  swapTotalKb: number
  swapUsedKb: number
  rxTotal: number
  txTotal: number
  processes: StatusProcess[]
  disks: StatusDisk[]
}

type RatePoint = {
  rx: number
  tx: number
}

const ACTIVE_REFRESH_INTERVAL_MS = 4000

const STATUS_COMMAND = `bash -lc '
IP=$(hostname -I 2>/dev/null | awk '"'"'{print $1}'"'"')
[ -z "$IP" ] && IP=$(hostname 2>/dev/null)
UPTIME=$(uptime -p 2>/dev/null | sed '"'"'s/^up //'"'"')
LOAD=$(cat /proc/loadavg 2>/dev/null | awk '"'"'{print $1" "$2" "$3}'"'"')
if [ -z "$LOAD" ]; then
  LOAD=$(uptime 2>/dev/null | awk -F "load average: " '"'"'{print $2}'"'"')
fi
CPU=$(LC_ALL=C top -bn1 2>/dev/null | awk -F"[, ]+" '"'"'/Cpu\\(s\\)|%Cpu/ {for (i=1; i<=NF; i++) {if ($i == "id") {printf "%.1f", 100-$(i-1); exit}}}'"'"')
MEM_TOTAL=$(awk "/MemTotal/ {print \\$2}" /proc/meminfo 2>/dev/null)
MEM_AVAIL=$(awk "/MemAvailable/ {print \\$2}" /proc/meminfo 2>/dev/null)
[ -z "$MEM_AVAIL" ] && MEM_AVAIL=$(awk "/MemFree/ {print \\$2}" /proc/meminfo 2>/dev/null)
MEM_USED=$(( \${MEM_TOTAL:-0} - \${MEM_AVAIL:-0} ))
SWAP_TOTAL=$(awk "/SwapTotal/ {print \\$2}" /proc/meminfo 2>/dev/null)
SWAP_FREE=$(awk "/SwapFree/ {print \\$2}" /proc/meminfo 2>/dev/null)
SWAP_USED=$(( \${SWAP_TOTAL:-0} - \${SWAP_FREE:-0} ))
NET=$(awk -F "[: ]+" "NR>2 && \\$1 != \\"lo\\" {rx += \\$3; tx += \\$11} END {printf \\"%s %s\\", rx, tx}" /proc/net/dev 2>/dev/null)
RX=$(printf "%s" "$NET" | awk "{print \\$1}")
TX=$(printf "%s" "$NET" | awk "{print \\$2}")
echo "__META__"
printf "ip=%s\\nuptime=%s\\nload=%s\\ncpu=%s\\nmem_total=%s\\nmem_used=%s\\nswap_total=%s\\nswap_used=%s\\nrx_total=%s\\ntx_total=%s\\n" "$IP" "$UPTIME" "$LOAD" "$CPU" "\${MEM_TOTAL:-0}" "\${MEM_USED:-0}" "\${SWAP_TOTAL:-0}" "\${SWAP_USED:-0}" "\${RX:-0}" "\${TX:-0}"
echo "__PROC__"
ps -eo rss,pcpu,comm --sort=-rss 2>/dev/null | awk "NR>1 && count<4 {printf \\"%s\\\\t%s\\\\t%s\\\\n\\", \\$1, \\$2, \\$3; count++}"
echo "__DISK__"
df -hP -x tmpfs -x devtmpfs 2>/dev/null | awk "NR>1 {printf \\"%s\\\\t%s/%s\\\\n\\", \\$6, \\$3, \\$2}"
'`

function formatGigabytes(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)}G`
}

function formatThroughput(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '0B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)}${units[unitIndex]}`
}

function percentOf(total: number, used: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, (used / total) * 100))
}

function parseSnapshot(stdout: string): StatusSnapshot {
  const sections = stdout.split('__PROC__')
  const metaAndDisks = sections[1]?.split('__DISK__') ?? []
  const metaText = sections[0]?.replace('__META__', '').trim() ?? ''
  const processText = metaAndDisks[0]?.trim() ?? ''
  const diskText = metaAndDisks[1]?.trim() ?? ''

  const meta = metaText.split('\n').reduce<Record<string, string>>((acc, line) => {
    const [key, ...rest] = line.split('=')
    if (key) acc[key.trim()] = rest.join('=').trim()
    return acc
  }, {})

  const processes = processText
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [memoryKb, cpu, command] = line.split('\t')
      return {
        memoryKb: Number(memoryKb || 0),
        cpu: Number(cpu || 0),
        command: command || ''
      }
    })

  const disks = diskText
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [path, usage] = line.split('\t')
      return { path: path || '/', usage: usage || '0/0' }
    })

  return {
    ip: meta.ip || '',
    uptime: meta.uptime || '',
    load: meta.load || '',
    cpuPercent: Number(meta.cpu || 0),
    memTotalKb: Number(meta.mem_total || 0),
    memUsedKb: Number(meta.mem_used || 0),
    swapTotalKb: Number(meta.swap_total || 0),
    swapUsedKb: Number(meta.swap_used || 0),
    rxTotal: Number(meta.rx_total || 0),
    txTotal: Number(meta.tx_total || 0),
    processes,
    disks
  }
}

function MetricBar({
  label,
  value,
  detail,
  accent,
  palette
}: {
  label: string
  value: number
  detail: string
  accent: string
  palette: SshChromePalette
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[0.78rem]">
        <span style={{ color: palette.muted }}>{label}</span>
        <span className="font-medium" style={{ color: palette.terminalText }}>
          {detail}
        </span>
      </div>
      <div className="h-2 rounded-full" style={{ background: palette.panelBorder }}>
        <div
          className="h-2 rounded-full transition-all"
          style={{
            width: `${Math.max(4, Math.min(100, value))}%`,
            background: accent
          }}
        />
      </div>
    </div>
  )
}

function HistoryBars({
  points,
  palette
}: {
  points: RatePoint[]
  palette: SshChromePalette
}): React.JSX.Element {
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.rx, point.tx]))

  return (
    <div className="mt-3">
      <div
        className="flex h-20 items-end gap-1 rounded-[18px] border px-3 py-2"
        style={{ borderColor: palette.panelBorder, background: palette.panelStrong }}
      >
        {points.map((point, index) => (
          <div key={`${point.rx}:${point.tx}:${index}`} className="flex flex-1 items-end gap-0.5">
            <div
              className="w-1.5 rounded-full"
              style={{
                background: palette.warning,
                height: `${Math.max(6, (point.tx / maxValue) * 100)}%`
              }}
              data-slot="tx-bar"
            />
            <div
              className="w-1.5 rounded-full"
              style={{
                background: palette.success,
                height: `${Math.max(6, (point.rx / maxValue) * 100)}%`
              }}
              data-slot="rx-bar"
            />
          </div>
        ))}
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
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const { resolvedTheme } = useTheme()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null)
  const [rates, setRates] = useState<RatePoint[]>([])
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const previousTotals = useRef<{ at: number; rxTotal: number; txTotal: number } | null>(null)
  const hasLoadedRef = useRef(false)
  const refreshInFlightRef = useRef(false)
  const queuedRefreshRef = useRef(false)
  const themePreset = useSettingsStore((state) => state.themePreset)
  const palette = getSshChromePalette(themePreset, resolveAppThemeMode(resolvedTheme))

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (refreshInFlightRef.current) {
        if (force) queuedRefreshRef.current = true
        return
      }

      refreshInFlightRef.current = true

      try {
        if (!hasLoadedRef.current) setLoading(true)
        const result = (await ipcClient.invoke(IPC.SSH_EXEC, {
          connectionId,
          command: STATUS_COMMAND,
          timeout: 20000
        })) as { stdout?: string; stderr?: string; exitCode?: number; error?: string }

        if (result.error) throw new Error(result.error)
        if (result.exitCode && result.exitCode !== 0 && result.stderr) {
          throw new Error(result.stderr)
        }

        const nextSnapshot = parseSnapshot(String(result.stdout ?? ''))
        const now = Date.now()
        const previous = previousTotals.current

        if (previous) {
          const seconds = Math.max(1, (now - previous.at) / 1000)
          const rx = Math.max(0, (nextSnapshot.rxTotal - previous.rxTotal) / seconds)
          const tx = Math.max(0, (nextSnapshot.txTotal - previous.txTotal) / seconds)
          setRates((current) => [...current.slice(-11), { rx, tx }])
        }

        previousTotals.current = {
          at: now,
          rxTotal: nextSnapshot.rxTotal,
          txTotal: nextSnapshot.txTotal
        }
        hasLoadedRef.current = true

        setSnapshot(nextSnapshot)
        setLastUpdatedAt(now)
        setError(null)
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
      } finally {
        refreshInFlightRef.current = false
        setLoading(false)

        if (queuedRefreshRef.current) {
          queuedRefreshRef.current = false
          void refresh()
        }
      }
    },
    [connectionId]
  )

  useEffect(() => {
    void refresh(true)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }, ACTIVE_REFRESH_INTERVAL_MS)

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh(true)
      }
    }

    const handleWindowFocus = (): void => {
      void refresh(true)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleWindowFocus)

    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [refresh])

  const memoryPercent = snapshot ? percentOf(snapshot.memTotalKb, snapshot.memUsedKb) : 0
  const swapPercent = snapshot ? percentOf(snapshot.swapTotalKb, snapshot.swapUsedKb) : 0
  const latestRates = rates[rates.length - 1] ?? { rx: 0, tx: 0 }
  const statusSubtitle =
    loading && !lastUpdatedAt
      ? t('workspace.terminalStatus.refreshing', { defaultValue: 'Refreshing…' })
      : lastUpdatedAt
        ? t('workspace.terminalStatus.updatedAt', {
            defaultValue: 'Updated {{time}}',
            time: new Date(lastUpdatedAt).toLocaleTimeString()
          })
        : host

  return (
    <aside
      className="relative flex h-full w-[340px] shrink-0 flex-col border-l"
      style={{
        borderColor: palette.panelBorder,
        background: palette.panelStrong,
        color: palette.terminalText
      }}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-4"
        style={{ borderColor: palette.panelBorder }}
      >
        <div>
          <div className="text-[1rem] font-semibold" style={{ color: palette.terminalText }}>
            {t('workspace.terminalStatus.title', { defaultValue: '终端状态' })}
          </div>
          <div className="mt-1 text-[0.78rem]" style={{ color: palette.muted }}>
            {statusSubtitle}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-9 rounded-[12px] hover:opacity-85"
            style={{ color: palette.terminalText }}
            onClick={() => void refresh()}
            title={t('list.refresh')}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-9 rounded-[12px] hover:opacity-85"
            style={{ color: palette.terminalText }}
            onClick={onClose}
            title={t('workspace.close', { defaultValue: '关闭' })}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <section
          className="rounded-[24px] border p-4 shadow-[0_20px_40px_rgba(5,8,18,0.34)]"
          style={{ borderColor: palette.panelBorder, background: palette.panel }}
        >
          <div className="flex items-start gap-3">
            <div
              className="flex size-11 shrink-0 items-center justify-center rounded-[16px] text-white shadow-[0_14px_30px_rgba(17,109,187,0.22)]"
              style={{ background: palette.accent }}
            >
              <Server className="size-5" />
            </div>
            <div className="min-w-0">
              <div
                className="truncate text-[0.96rem] font-semibold"
                style={{ color: palette.terminalText }}
              >
                {connectionName}
              </div>
              <div className="mt-1 text-[0.8rem]" style={{ color: palette.muted }}>
                {snapshot?.ip || host}
              </div>
            </div>
          </div>

          {error ? (
            <div
              className="mt-4 rounded-[18px] border px-3 py-3 text-[0.8rem]"
              style={{
                borderColor: palette.danger,
                background: palette.dangerSoft,
                color: palette.danger
              }}
            >
              {error}
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div
              className="rounded-[18px] border px-3 py-3"
              style={{ borderColor: palette.panelBorder, background: palette.panelStrong }}
            >
              <div
                className="text-[0.72rem] uppercase tracking-[0.16em]"
                style={{ color: palette.muted }}
              >
                IP
              </div>
              <div
                className="mt-2 truncate text-[0.94rem] font-semibold"
                style={{ color: palette.terminalText }}
              >
                {snapshot?.ip || host}
              </div>
            </div>
            <div
              className="rounded-[18px] border px-3 py-3"
              style={{ borderColor: palette.panelBorder, background: palette.panelStrong }}
            >
              <div
                className="text-[0.72rem] uppercase tracking-[0.16em]"
                style={{ color: palette.muted }}
              >
                {t('workspace.terminalStatus.load', { defaultValue: '负载' })}
              </div>
              <div
                className="mt-2 text-[0.94rem] font-semibold"
                style={{ color: palette.terminalText }}
              >
                {snapshot?.load || '--'}
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div
              className="rounded-[18px] border px-3 py-3"
              style={{ borderColor: palette.panelBorder, background: palette.panelStrong }}
            >
              <div
                className="text-[0.72rem] uppercase tracking-[0.16em]"
                style={{ color: palette.muted }}
              >
                {t('workspace.terminalStatus.uptime', { defaultValue: '运行' })}
              </div>
              <div
                className="mt-2 text-[0.88rem] font-semibold"
                style={{ color: palette.terminalText }}
              >
                {snapshot?.uptime || '--'}
              </div>
            </div>
            <div
              className="rounded-[18px] border px-3 py-3"
              style={{ borderColor: palette.panelBorder, background: palette.panelStrong }}
            >
              <div
                className="text-[0.72rem] uppercase tracking-[0.16em]"
                style={{ color: palette.muted }}
              >
                {t('workspace.terminalStatus.cpu', { defaultValue: 'CPU' })}
              </div>
              <div
                className="mt-2 text-[0.88rem] font-semibold"
                style={{ color: palette.terminalText }}
              >
                {snapshot ? `${snapshot.cpuPercent.toFixed(1)}%` : '--'}
              </div>
            </div>
          </div>
        </section>

        <section
          className="space-y-3 rounded-[24px] border p-4 shadow-[0_20px_40px_rgba(5,8,18,0.34)]"
          style={{ borderColor: palette.panelBorder, background: palette.panel }}
        >
          <div
            className="flex items-center gap-2 text-[0.86rem] font-semibold"
            style={{ color: palette.terminalText }}
          >
            <Cpu className="size-4" style={{ color: palette.accent }} />
            {t('workspace.terminalStatus.resources', { defaultValue: '系统资源' })}
          </div>
          <MetricBar
            label="CPU"
            value={snapshot?.cpuPercent ?? 0}
            detail={snapshot ? `${snapshot.cpuPercent.toFixed(1)}%` : '--'}
            accent={palette.warning}
            palette={palette}
          />
          <MetricBar
            label={t('workspace.terminalStatus.memory', { defaultValue: '内存' })}
            value={memoryPercent}
            detail={
              snapshot
                ? `${memoryPercent.toFixed(0)}% · ${formatGigabytes(snapshot.memUsedKb)}/${formatGigabytes(snapshot.memTotalKb)}`
                : '--'
            }
            accent={palette.accent}
            palette={palette}
          />
          <MetricBar
            label="Swap"
            value={swapPercent}
            detail={
              snapshot
                ? `${swapPercent.toFixed(0)}% · ${formatGigabytes(snapshot.swapUsedKb)}/${formatGigabytes(snapshot.swapTotalKb)}`
                : '--'
            }
            accent={palette.success}
            palette={palette}
          />
        </section>

        <section
          className="rounded-[24px] border p-4 shadow-[0_20px_40px_rgba(5,8,18,0.34)]"
          style={{ borderColor: palette.panelBorder, background: palette.panel }}
        >
          <div
            className="flex items-center gap-2 text-[0.86rem] font-semibold"
            style={{ color: palette.terminalText }}
          >
            <MemoryStick className="size-4" style={{ color: palette.accent }} />
            {t('workspace.terminalStatus.processes', { defaultValue: '进程占用' })}
          </div>
          <div
            className="mt-3 overflow-hidden rounded-[18px] border"
            style={{ borderColor: palette.panelBorder }}
          >
            <div
              className="grid grid-cols-[72px_66px_1fr] gap-2 px-3 py-2 text-[0.72rem] font-semibold text-white"
              style={{ background: palette.accent }}
            >
              <span>{t('workspace.terminalStatus.memory', { defaultValue: '内存' })}</span>
              <span>CPU</span>
              <span>{t('workspace.terminalStatus.command', { defaultValue: '命令' })}</span>
            </div>
            <div className="divide-y" style={{ borderColor: palette.panelBorder }}>
              {(snapshot?.processes ?? []).map((process, index) => (
                <div
                  key={`${process.command}:${index}`}
                  className="grid grid-cols-[72px_66px_1fr] gap-2 px-3 py-2 text-[0.78rem]"
                  style={{ color: palette.terminalText }}
                >
                  <span>{(process.memoryKb / 1024).toFixed(1)}M</span>
                  <span>{process.cpu.toFixed(1)}%</span>
                  <span className="truncate">{process.command}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          className="rounded-[24px] border p-4 shadow-[0_20px_40px_rgba(5,8,18,0.34)]"
          style={{ borderColor: palette.panelBorder, background: palette.panel }}
        >
          <div className="flex items-center justify-between gap-3">
            <div
              className="flex items-center gap-2 text-[0.86rem] font-semibold"
              style={{ color: palette.terminalText }}
            >
              <ArrowUpRight className="size-4" style={{ color: palette.warning }} />
              {t('workspace.terminalStatus.network', { defaultValue: '网络吞吐' })}
            </div>
            <div className="text-right text-[0.72rem]" style={{ color: palette.muted }}>
              <div className="flex items-center justify-end gap-1">
                <ArrowDownRight className="size-3.5" style={{ color: palette.success }} />
                <span>{formatThroughput(latestRates.rx)}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-end gap-1">
                <ArrowUpRight className="size-3.5" style={{ color: palette.warning }} />
                <span>{formatThroughput(latestRates.tx)}</span>
              </div>
            </div>
          </div>
          <HistoryBars points={rates.length > 0 ? rates : [{ rx: 0, tx: 0 }]} palette={palette} />
        </section>

        <section
          className="rounded-[24px] border p-4 shadow-[0_20px_40px_rgba(5,8,18,0.34)]"
          style={{ borderColor: palette.panelBorder, background: palette.panel }}
        >
          <div
            className="flex items-center gap-2 text-[0.86rem] font-semibold"
            style={{ color: palette.terminalText }}
          >
            <HardDrive className="size-4" style={{ color: palette.accent }} />
            {t('workspace.terminalStatus.disks', { defaultValue: '磁盘用量' })}
          </div>
          <div
            className="mt-3 overflow-hidden rounded-[18px] border"
            style={{ borderColor: palette.panelBorder }}
          >
            <div
              className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em]"
              style={{ background: palette.panelStrong, color: palette.muted }}
            >
              <span>{t('workspace.terminalStatus.path', { defaultValue: '路径' })}</span>
              <span>{t('workspace.terminalStatus.capacity', { defaultValue: '可用/大小' })}</span>
            </div>
            <div className="divide-y" style={{ borderColor: palette.panelBorder }}>
              {(snapshot?.disks ?? []).map((disk) => (
                <div
                  key={disk.path}
                  className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 text-[0.78rem]"
                  style={{ color: palette.terminalText }}
                >
                  <span className="truncate">{disk.path}</span>
                  <span>{disk.usage}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {loading ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center backdrop-blur-[1px]"
          style={{ background: `${palette.panelStrong}aa` }}
        >
          <Loader2 className="size-5 animate-spin" style={{ color: palette.terminalText }} />
        </div>
      ) : null}
    </aside>
  )
}
