import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DiagnosticsPerfSample } from '../../../../shared/diagnostics-perf'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'

const PERF_SAMPLE_MS = 1_000
const FPS_FLUSH_MS = 500

type OverlayMetrics = {
  fps: number | null
  cpuPercent: number | null
  memoryPercent: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
}

const EMPTY_METRICS: OverlayMetrics = {
  fps: null,
  cpuPercent: null,
  memoryPercent: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null
}

export function DevPerfOverlayReserve(): React.JSX.Element | null {
  const devMode = useSettingsStore((state) => state.devMode)
  if (!devMode) return null
  return <div className="w-[196px] shrink-0" aria-hidden />
}

export function DevPerfOverlay(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const devMode = useSettingsStore((state) => state.devMode)
  const [metrics, setMetrics] = useState<OverlayMetrics>(EMPTY_METRICS)

  useEffect(() => {
    if (!devMode) {
      setMetrics(EMPTY_METRICS)
      return
    }

    let disposed = false
    let frameCount = 0
    let fpsAnchor = performance.now()
    let rafId = 0
    let sampleTimer = 0

    const flushFps = (now: number): void => {
      const elapsed = now - fpsAnchor
      if (elapsed < FPS_FLUSH_MS) return
      const nextFps = Math.round((frameCount * 1000) / elapsed)
      frameCount = 0
      fpsAnchor = now
      setMetrics((current) => (current.fps === nextFps ? current : { ...current, fps: nextFps }))
    }

    const tickFps = (now: number): void => {
      frameCount += 1
      flushFps(now)
      rafId = window.requestAnimationFrame(tickFps)
    }

    const applySample = (sample: DiagnosticsPerfSample): void => {
      setMetrics((current) => ({
        ...current,
        cpuPercent: sample.cpuPercent,
        memoryPercent: sample.memoryPercent,
        memoryUsedBytes: sample.memoryUsedBytes,
        memoryTotalBytes: sample.memoryTotalBytes
      }))
    }

    const pollSystem = (): void => {
      void ipcClient
        .invoke('diagnostics:perf-sample', {})
        .then((result) => {
          if (!disposed) applySample(result as DiagnosticsPerfSample)
        })
        .catch(() => {
          // Keep the last reading when a sample fails.
        })
    }

    const startSampling = (): void => {
      if (disposed || document.hidden) return
      fpsAnchor = performance.now()
      frameCount = 0
      rafId = window.requestAnimationFrame(tickFps)
      pollSystem()
      sampleTimer = window.setInterval(pollSystem, PERF_SAMPLE_MS)
    }

    const stopSampling = (): void => {
      window.cancelAnimationFrame(rafId)
      window.clearInterval(sampleTimer)
      rafId = 0
      sampleTimer = 0
    }

    const onVisibility = (): void => {
      stopSampling()
      if (document.hidden) return
      startSampling()
    }

    startSampling()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      stopSampling()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [devMode])

  if (!devMode) return null

  const isMac = /Mac/.test(navigator.userAgent)
  const fpsLabel = formatWhole(metrics.fps)
  const cpuLabel = formatPercent(metrics.cpuPercent)
  const memoryLabel = formatPercent(metrics.memoryPercent)
  const memoryDetail = formatMemoryDetail(metrics.memoryUsedBytes, metrics.memoryTotalBytes)

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('perfOverlay.summary', {
        defaultValue: '{{fps}} FPS, CPU {{cpu}}, memory {{memory}}',
        fps: fpsLabel,
        cpu: cpuLabel,
        memory: memoryLabel
      })}
      title={
        memoryDetail
          ? t('perfOverlay.memoryDetail', {
              defaultValue: 'Memory {{detail}}',
              detail: memoryDetail
            })
          : undefined
      }
      className={cn(
        'pointer-events-none fixed z-[400] flex items-center gap-2 rounded-md border border-border/70 bg-background/80 px-2 py-1 font-mono text-[10px] leading-none shadow-sm backdrop-blur-md',
        isMac ? 'right-3 top-[7px]' : 'right-[140px] top-[7px]'
      )}
    >
      <PerfStat
        label={t('perfOverlay.fps', { defaultValue: 'FPS' })}
        value={fpsLabel}
        tone={fpsTone(metrics.fps)}
      />
      <PerfStat
        label={t('perfOverlay.cpu', { defaultValue: 'CPU' })}
        value={cpuLabel}
        tone={usageTone(metrics.cpuPercent)}
      />
      <PerfStat
        label={t('perfOverlay.memory', { defaultValue: 'MEM' })}
        value={memoryLabel}
        tone={usageTone(metrics.memoryPercent)}
      />
    </div>
  )
}

function PerfStat({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone: 'good' | 'warn' | 'bad' | 'idle'
}): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[9px] tracking-wide text-muted-foreground">{label}</span>
      <span
        className={cn(
          'tabular-nums font-medium',
          tone === 'good' && 'text-emerald-500',
          tone === 'warn' && 'text-amber-500',
          tone === 'bad' && 'text-red-500',
          tone === 'idle' && 'text-foreground/80'
        )}
      >
        {value}
      </span>
    </span>
  )
}

function formatWhole(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return String(Math.round(value))
}

function formatPercent(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

function formatMemoryDetail(usedBytes: number | null, totalBytes: number | null): string | null {
  if (
    typeof usedBytes !== 'number' ||
    typeof totalBytes !== 'number' ||
    !Number.isFinite(usedBytes) ||
    !Number.isFinite(totalBytes)
  ) {
    return null
  }
  return `${formatGigabytes(usedBytes)} / ${formatGigabytes(totalBytes)}`
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function fpsTone(fps: number | null): 'good' | 'warn' | 'bad' | 'idle' {
  if (typeof fps !== 'number') return 'idle'
  if (fps >= 50) return 'good'
  if (fps >= 30) return 'warn'
  return 'bad'
}

function usageTone(percent: number | null): 'good' | 'warn' | 'bad' | 'idle' {
  if (typeof percent !== 'number') return 'idle'
  if (percent >= 85) return 'bad'
  if (percent >= 65) return 'warn'
  return 'good'
}
