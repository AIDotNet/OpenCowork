import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export type MonitorProcessSample = {
  pid: number
  cpu: string
  memory: number
  command: string
}

export type MonitorSnapshot = {
  time: {
    timezone: string
    timezoneName: string
    timestamp: number
    uptime: string
  }
  os: {
    type: string
    prettyName: string
    version?: string
  }
  memory: {
    total: number
    free: number
    used: number
    buffcache: number
    swapTotal: number
    swapUsed: number
    swapFree: number
  }
  networkStat: {
    rxBytes: number
    txBytes: number
    rxBytesPerSec: number
    txBytesPerSec: number
    rxTotalBytes: number
    txTotalBytes: number
    interfaceNames: string[]
  }
  cpu: {
    percent: number
    load: string
  }
  fsSize: Array<{
    fs: string
    type: string
    size: number
    used: number
    available: number
    percent: number
    mount: string
  }>
  process: {
    all: number
    running: number
    blocked: number
    sleeping: number
    topsCostCpu: MonitorProcessSample[]
    topsCostMemory: MonitorProcessSample[]
  }
}

type RemoteMonitorPaths = {
  homeDir: string
  baseDir: string
  infoScriptPath: string
  outputPath: string
}

const REMOTE_MONITOR_DIR = '.open-cowork/xterminal'
const REMOTE_MONITOR_VERSION = '1'

const REMOTE_MONITOR_INFO_SCRIPT = `#!/bin/sh

BASE_DIR="$HOME/.open-cowork/xterminal"
LAST_UPDATE_FILE="$BASE_DIR/last_update"
OUTPUT_FILE="$BASE_DIR/output.stats"
NETWORK_TOTAL_FILE="$BASE_DIR/network_stats_total"
CPU_STATE_FILE="$BASE_DIR/cpu.tmp"

escape_yaml_double() {
    printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'
}

float_percent_one_decimal() {
    awk -v used="$1" -v total="$2" 'BEGIN {
        if (total <= 0) {
            printf "0.0"
        } else {
            printf "%.1f", (used * 100) / total
        }
    }'
}

format_cpu_percent() {
    value=$(printf '%s' "$1" | tr -cd '0-9.')
    [ -n "$value" ] || value="0"
    awk -v cpu="$value" 'BEGIN { printf "%.1f%%", cpu + 0 }'
}

collect_network_totals() {
    awk -F '[: ]+' 'NR > 2 && $1 != "lo" && $1 != "" {
        rx += $3
        tx += $11
        names = names sprintf("%s\\n", $1)
    }
    END {
        printf "%s\\t%s\\n", rx + 0, tx + 0
        printf "%s", names
    }' /proc/net/dev 2>/dev/null
}

main() {
    mkdir -p "$BASE_DIR"

    if [ -f "$LAST_UPDATE_FILE" ]; then
        last_update=$(cat "$LAST_UPDATE_FILE" 2>/dev/null)
        now=$(date +%s 2>/dev/null)
        if [ -n "$last_update" ] && [ -n "$now" ]; then
            diff=$((now - last_update))
            if [ "$diff" -lt 2 ] 2>/dev/null; then
                exit 0
            fi
        fi
    fi

    tmp_file="$BASE_DIR/output.stats.tmp"
    : > "$tmp_file"

    timezone_offset=$(date +%z 2>/dev/null)
    [ -n "$timezone_offset" ] || timezone_offset="+0000"
    timezone="GMT$(printf '%s' "$timezone_offset" | cut -c1-3)$(printf '%s' "$timezone_offset" | cut -c4-5)"
    timezone_name=$(date +"%Z" 2>/dev/null)
    [ -n "$timezone_name" ] || timezone_name="UTC"
    timestamp=$(date +%s 2>/dev/null)
    [ -n "$timestamp" ] || timestamp=0
    if read -r uptime _ < /proc/uptime 2>/dev/null; then :; else uptime=0; fi
    [ -n "$uptime" ] || uptime=0

    os_type=""
    os_pretty_name=""
    os_version=""
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        os_type=$NAME
        os_pretty_name=$PRETTY_NAME
        os_version=$VERSION
    elif [ -f /etc/lsb-release ]; then
        . /etc/lsb-release
        os_type=$DISTRIB_ID
        os_pretty_name=$DISTRIB_DESCRIPTION
        os_version=$DISTRIB_RELEASE
    else
        os_type="Linux"
        os_pretty_name="Linux"
    fi

    total_mem=0
    free_mem=0
    buffers_mem=0
    cached_mem=0
    reclaimable_mem=0
    swap_total=0
    swap_free=0
    while IFS=':' read -r key value; do
        set -- $value
        amount=\${1:-0}
        case "$key" in
            MemTotal) total_mem=$amount ;;
            MemFree) free_mem=$amount ;;
            Buffers) buffers_mem=$amount ;;
            Cached) cached_mem=$amount ;;
            SReclaimable) reclaimable_mem=$amount ;;
            SwapTotal) swap_total=$amount ;;
            SwapFree) swap_free=$amount ;;
        esac
    done < /proc/meminfo 2>/dev/null
    buffcache_mem=$((buffers_mem + cached_mem + reclaimable_mem))
    used_mem=$((total_mem - free_mem - buffcache_mem))
    [ "$used_mem" -lt 0 ] 2>/dev/null && used_mem=0
    swap_used=$((swap_total - swap_free))
    [ "$swap_used" -lt 0 ] 2>/dev/null && swap_used=0

    load_avg=$(awk '{print $1" "$2" "$3}' /proc/loadavg 2>/dev/null)
    [ -n "$load_avg" ] || load_avg="0.00 0.00 0.00"

    read -r _ user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat 2>/dev/null
    user=\${user:-0}
    nice=\${nice:-0}
    system=\${system:-0}
    idle=\${idle:-0}
    iowait=\${iowait:-0}
    irq=\${irq:-0}
    softirq=\${softirq:-0}
    steal=\${steal:-0}
    cpu_total=$((user + nice + system + idle + iowait + irq + softirq + steal))
    cpu_idle=$((idle + iowait))
    cpu_percent="0.0"
    if [ -f "$CPU_STATE_FILE" ]; then
        read -r prev_total prev_idle < "$CPU_STATE_FILE" 2>/dev/null
        prev_total=\${prev_total:-0}
        prev_idle=\${prev_idle:-0}
        diff_total=$((cpu_total - prev_total))
        diff_idle=$((cpu_idle - prev_idle))
        diff_active=$((diff_total - diff_idle))
        if [ "$diff_total" -gt 0 ] 2>/dev/null; then
            [ "$diff_active" -lt 0 ] 2>/dev/null && diff_active=0
            cpu_percent=$(float_percent_one_decimal "$diff_active" "$diff_total")
        fi
    fi
    printf "%s %s\\n" "$cpu_total" "$cpu_idle" > "$CPU_STATE_FILE"

    network_data=$(collect_network_totals)
    total_rx_current=$(printf '%s\\n' "$network_data" | sed -n '1p' | awk -F '\\t' '{print $1 + 0}')
    total_tx_current=$(printf '%s\\n' "$network_data" | sed -n '1p' | awk -F '\\t' '{print $2 + 0}')
    rx_delta=0
    tx_delta=0
    rx_per_sec=0
    tx_per_sec=0
    if [ -f "$NETWORK_TOTAL_FILE" ]; then
        read -r prev_time prev_rx prev_tx < "$NETWORK_TOTAL_FILE" 2>/dev/null
        prev_time=\${prev_time:-0}
        prev_rx=\${prev_rx:-0}
        prev_tx=\${prev_tx:-0}
        interval=$((timestamp - prev_time))
        [ "$interval" -le 0 ] 2>/dev/null && interval=1
        rx_delta=$((total_rx_current - prev_rx))
        tx_delta=$((total_tx_current - prev_tx))
        [ "$rx_delta" -lt 0 ] 2>/dev/null && rx_delta=0
        [ "$tx_delta" -lt 0 ] 2>/dev/null && tx_delta=0
        rx_per_sec=$((rx_delta / interval))
        tx_per_sec=$((tx_delta / interval))
    fi
    printf "%s %s %s\\n" "$timestamp" "$total_rx_current" "$total_tx_current" > "$NETWORK_TOTAL_FILE"

    {
        printf 'time:\\n'
        printf '  timezone: "%s"\\n' "$timezone"
        printf '  timezoneName: "%s"\\n' "$timezone_name"
        printf '  timestamp: %s\\n' "$timestamp"
        printf '  uptime: "%s"\\n' "$uptime"

        printf 'os:\\n'
        printf '  type: "%s"\\n' "$(escape_yaml_double "$os_type")"
        printf '  prettyName: "%s"\\n' "$(escape_yaml_double "$os_pretty_name")"
        printf '  version: "%s"\\n' "$(escape_yaml_double "$os_version")"

        printf 'memory:\\n'
        printf '  total: %s\\n' "$total_mem"
        printf '  free: %s\\n' "$free_mem"
        printf '  used: %s\\n' "$used_mem"
        printf '  buffcache: %s\\n' "$buffcache_mem"
        printf '  swapTotal: %s\\n' "$swap_total"
        printf '  swapUsed: %s\\n' "$swap_used"
        printf '  swapFree: %s\\n' "$swap_free"

        printf 'networkStat:\\n'
        printf '  rxBytes: %s\\n' "$rx_delta"
        printf '  txBytes: %s\\n' "$tx_delta"
        printf '  rxBytesPerSec: %s\\n' "$rx_per_sec"
        printf '  txBytesPerSec: %s\\n' "$tx_per_sec"
        printf '  rxTotalBytes: %s\\n' "$total_rx_current"
        printf '  txTotalBytes: %s\\n' "$total_tx_current"
        printf '  interfaceNames:\\n'
        printf '%s\\n' "$network_data" | sed '1d' | while IFS= read -r interface_name; do
            [ -n "$interface_name" ] || continue
            printf '    - "%s"\\n' "$(escape_yaml_double "$interface_name")"
        done

        printf 'cpu:\\n'
        printf '  percent: %s\\n' "$cpu_percent"
        printf '  load: "%s"\\n' "$load_avg"

        printf 'fsSize:\\n'
        df -kP 2>/dev/null | tail -n +2 | while read -r fs size used available percent mount; do
            [ -n "$fs" ] || continue
            [ -n "$mount" ] || continue
            fs_type=$(awk -v target="$mount" '$2 == target { print $3; exit }' /proc/mounts 2>/dev/null)
            case "$fs_type" in
                ""|tmpfs|devtmpfs)
                    continue
                    ;;
            esac
            percent_number=$(printf '%s' "$percent" | tr -cd '0-9')
            printf '  - fs: "%s"\\n' "$(escape_yaml_double "$fs")"
            printf '    type: "%s"\\n' "$(escape_yaml_double "$fs_type")"
            printf '    size: %s\\n' "\${size:-0}"
            printf '    used: %s\\n' "\${used:-0}"
            printf '    available: %s\\n' "\${available:-0}"
            printf '    percent: %s\\n' "\${percent_number:-0}"
            printf '    mount: "%s"\\n' "$(escape_yaml_double "$mount")"
        done

        total_processes=0
        running_processes=0
        blocked_processes=0
        sleeping_processes=0
        while IFS= read -r state_value; do
            [ -n "$state_value" ] || continue
            total_processes=$((total_processes + 1))
            case "$state_value" in
                R*) running_processes=$((running_processes + 1)) ;;
                D*) blocked_processes=$((blocked_processes + 1)) ;;
                S*) sleeping_processes=$((sleeping_processes + 1)) ;;
            esac
        done <<EOF
$(ps -eo state= 2>/dev/null)
EOF

        printf 'process:\\n'
        printf '  all: %s\\n' "$total_processes"
        printf '  running: %s\\n' "$running_processes"
        printf '  blocked: %s\\n' "$blocked_processes"
        printf '  sleeping: %s\\n' "$sleeping_processes"
        printf '  topsCostCpu:\\n'
        ps -eo pid=,pcpu=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 5 | while read -r pid pcpu rss command_name; do
            [ -n "$pid" ] || continue
            printf '    - pid: %s\\n' "$pid"
            printf '      cpu: "%s"\\n' "$(format_cpu_percent "$pcpu")"
            printf '      memory: %s\\n' "\${rss:-0}"
            printf '      command: "%s"\\n' "$(escape_yaml_double "$command_name")"
        done

        printf '  topsCostMemory:\\n'
        ps -eo pid=,pcpu=,rss=,comm= --sort=-rss 2>/dev/null | head -n 5 | while read -r pid pcpu rss command_name; do
            [ -n "$pid" ] || continue
            printf '    - pid: %s\\n' "$pid"
            printf '      cpu: "%s"\\n' "$(format_cpu_percent "$pcpu")"
            printf '      memory: %s\\n' "\${rss:-0}"
            printf '      command: "%s"\\n' "$(escape_yaml_double "$command_name")"
        done
    } > "$tmp_file"

    mv "$tmp_file" "$OUTPUT_FILE"
    date +%s > "$LAST_UPDATE_FILE"
}

main "$@"
`

function joinRemotePath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return part.replace(/\/+$/, '')
      return part.replace(/^\/+/, '').replace(/\/+$/, '')
    })
    .join('/')
}

function parseScalar(rawValue: string): number | string {
  const value = rawValue.trim()
  if (!value.length) return ''
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'")
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value)
  }
  return value
}

function parseMonitorYaml(source: string): Record<string, unknown> {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '    '))
    .filter((line) => line.trim().length > 0)

  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; value: unknown }> = [{ indent: -1, value: root }]

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const indent = line.match(/^ */)?.[0].length ?? 0
    const trimmed = line.trim()
    if (!trimmed.length) continue

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop()
    }

    const parent = stack[stack.length - 1]!.value

    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) continue
      const inline = trimmed.slice(2)
      if (!inline.includes(':')) {
        parent.push(parseScalar(inline))
        continue
      }
      const [rawKey, ...rest] = inline.split(':')
      const key = rawKey.trim()
      const value = parseScalar(rest.join(':'))
      const item: Record<string, unknown> = { [key]: value }
      parent.push(item)
      stack.push({ indent, value: item })
      continue
    }

    const separatorIndex = trimmed.indexOf(':')
    if (separatorIndex < 0 || typeof parent !== 'object' || parent === null) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()

    if (!rawValue.length) {
      const nextLine = lines[index + 1] ?? ''
      const nextTrimmed = nextLine.trim()
      const nextIndent = nextLine.match(/^ */)?.[0].length ?? 0
      const nextIsArray = nextTrimmed.startsWith('- ') && nextIndent > indent
      const container: Record<string, unknown> | Array<unknown> = nextIsArray ? [] : {}
      ;(parent as Record<string, unknown>)[key] = container
      stack.push({ indent, value: container })
      continue
    }

    ;(parent as Record<string, unknown>)[key] = parseScalar(rawValue)
  }

  return root
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return 0
}

function toStringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function normalizeProcessList(value: unknown): MonitorProcessSample[] {
  return toArray(value).map((item) => {
    const record = toRecord(item)
    return {
      pid: toNumber(record.pid),
      cpu: toStringValue(record.cpu),
      memory: toNumber(record.memory),
      command: toStringValue(record.command)
    }
  })
}

function normalizeMonitorSnapshot(parsed: Record<string, unknown>): MonitorSnapshot {
  const time = toRecord(parsed.time)
  const os = toRecord(parsed.os)
  const memory = toRecord(parsed.memory)
  const networkStat = toRecord(parsed.networkStat)
  const cpu = toRecord(parsed.cpu)
  const process = toRecord(parsed.process)

  return {
    time: {
      timezone: toStringValue(time.timezone, 'GMT+0000'),
      timezoneName: toStringValue(time.timezoneName, 'UTC'),
      timestamp: toNumber(time.timestamp),
      uptime: toStringValue(time.uptime, '0')
    },
    os: {
      type: toStringValue(os.type, 'Linux'),
      prettyName: toStringValue(os.prettyName, toStringValue(os.type, 'Linux')),
      version: toStringValue(os.version)
    },
    memory: {
      total: toNumber(memory.total),
      free: toNumber(memory.free),
      used: toNumber(memory.used),
      buffcache: toNumber(memory.buffcache),
      swapTotal: toNumber(memory.swapTotal),
      swapUsed: toNumber(memory.swapUsed),
      swapFree: toNumber(memory.swapFree)
    },
    networkStat: {
      rxBytes: toNumber(networkStat.rxBytes),
      txBytes: toNumber(networkStat.txBytes),
      rxBytesPerSec: toNumber(networkStat.rxBytesPerSec),
      txBytesPerSec: toNumber(networkStat.txBytesPerSec),
      rxTotalBytes: toNumber(networkStat.rxTotalBytes),
      txTotalBytes: toNumber(networkStat.txTotalBytes),
      interfaceNames: toArray(networkStat.interfaceNames).map((item) => toStringValue(item))
    },
    cpu: {
      percent: toNumber(cpu.percent),
      load: toStringValue(cpu.load, '0.00 0.00 0.00')
    },
    fsSize: toArray(parsed.fsSize).map((item) => {
      const record = toRecord(item)
      return {
        fs: toStringValue(record.fs),
        type: toStringValue(record.type),
        size: toNumber(record.size),
        used: toNumber(record.used),
        available: toNumber(record.available),
        percent: toNumber(record.percent),
        mount: toStringValue(record.mount)
      }
    }),
    process: {
      all: toNumber(process.all),
      running: toNumber(process.running),
      blocked: toNumber(process.blocked),
      sleeping: toNumber(process.sleeping),
      topsCostCpu: normalizeProcessList(process.topsCostCpu),
      topsCostMemory: normalizeProcessList(process.topsCostMemory)
    }
  }
}

export async function getRemoteMonitorPaths(connectionId: string): Promise<RemoteMonitorPaths> {
  const result = (await ipcClient.invoke(IPC.SSH_FS_HOME_DIR, {
    connectionId
  })) as { path?: string; homeDir?: string | null; success?: boolean; error?: string }

  if (result?.error) {
    throw new Error(result.error)
  }

  const homeDir = String(result?.path ?? result?.homeDir ?? '').trim()
  if (!homeDir) {
    throw new Error('Failed to resolve SSH home directory')
  }

  const baseDir = joinRemotePath(homeDir, REMOTE_MONITOR_DIR)
  return {
    homeDir,
    baseDir,
    infoScriptPath: joinRemotePath(baseDir, 'info.sh'),
    outputPath: joinRemotePath(baseDir, 'output.stats')
  }
}

export async function isRemoteMonitorInstalled(connectionId: string): Promise<boolean> {
  const paths = await getRemoteMonitorPaths(connectionId)
  const result = (await ipcClient.invoke(IPC.SSH_FS_STAT_PATH, {
    connectionId,
    path: paths.infoScriptPath
  })) as { exists?: boolean; error?: string }

  if (result?.error) return false
  return !!result?.exists
}

export async function installRemoteMonitorRuntime(connectionId: string): Promise<RemoteMonitorPaths> {
  const paths = await getRemoteMonitorPaths(connectionId)
  const mkdirResult = (await ipcClient.invoke(IPC.SSH_EXEC, {
    connectionId,
    command: `mkdir -p "${paths.baseDir.replace(/"/g, '\\"')}"`,
    timeout: 10000
  })) as { error?: string; exitCode?: number; stderr?: string }

  if (mkdirResult?.error) {
    throw new Error(mkdirResult.error)
  }
  if (mkdirResult?.exitCode && mkdirResult.exitCode !== 0) {
    throw new Error(mkdirResult.stderr || 'Failed to create remote monitor directory')
  }

  const writeInfoResult = (await ipcClient.invoke(IPC.SSH_FS_WRITE_FILE, {
    connectionId,
    path: paths.infoScriptPath,
    content: REMOTE_MONITOR_INFO_SCRIPT
  })) as { error?: string }

  if (writeInfoResult?.error) {
    throw new Error(writeInfoResult.error)
  }

  const versionResult = (await ipcClient.invoke(IPC.SSH_FS_WRITE_FILE, {
    connectionId,
    path: joinRemotePath(paths.baseDir, 'version'),
    content: REMOTE_MONITOR_VERSION
  })) as { error?: string }

  if (versionResult?.error) {
    throw new Error(versionResult.error)
  }

  return paths
}

export async function collectRemoteMonitorSnapshot(
  connectionId: string
): Promise<{ snapshot: MonitorSnapshot; paths: RemoteMonitorPaths }> {
  const paths = await getRemoteMonitorPaths(connectionId)
  const runResult = (await ipcClient.invoke(IPC.SSH_EXEC, {
    connectionId,
    command: `sh "${paths.infoScriptPath.replace(/"/g, '\\"')}"`,
    timeout: 20000
  })) as { error?: string; exitCode?: number; stderr?: string }

  if (runResult?.error) {
    throw new Error(runResult.error)
  }
  if (runResult?.exitCode && runResult.exitCode !== 0) {
    throw new Error(runResult.stderr || 'Failed to refresh remote monitor snapshot')
  }

  const readResult = (await ipcClient.invoke(IPC.SSH_FS_READ_FILE, {
    connectionId,
    path: paths.outputPath
  })) as string | { error?: string }

  if (typeof readResult !== 'string') {
    throw new Error(readResult?.error || 'Failed to read remote monitor snapshot')
  }

  const parsed = parseMonitorYaml(readResult)
  return {
    snapshot: normalizeMonitorSnapshot(parsed),
    paths
  }
}
