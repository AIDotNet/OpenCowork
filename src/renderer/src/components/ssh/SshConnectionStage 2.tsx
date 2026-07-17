import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { type SshChromePalette } from '@renderer/lib/theme-presets'
import { useSshStore } from '@renderer/stores/ssh-store'
import type { SshConnectLogEntry } from '@renderer/stores/ssh/types'
import { Button } from '@renderer/components/ui/button'

const STAGE_ORDER = ['dial', 'handshake', 'auth', 'shell'] as const
type StageKey = (typeof STAGE_ORDER)[number]

// Stable reference for the "no logs yet" case; an inline `?? []` in the
// selector returns a fresh array each render and drives zustand into an
// infinite re-render loop.
const EMPTY_LOGS: SshConnectLogEntry[] = []

function levelColor(level: SshConnectLogEntry['level'], palette: SshChromePalette): string {
  if (level === 'error') return palette.danger
  if (level === 'warn') return palette.warning
  if (level === 'debug') return palette.muted
  return palette.terminalText
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(
    d.getMilliseconds()
  ).padStart(3, '0')}`
}

export function ConnectionStage({
  connectionId,
  connectionName,
  connectionAddress,
  sessionStatus,
  sessionError,
  palette,
  onClose,
  onShowList,
  onRetry
}: {
  connectionId: string
  connectionName: string
  connectionAddress: string
  sessionStatus: 'connecting' | 'error' | 'disconnected' | null
  sessionError?: string
  palette: SshChromePalette
  onClose: () => void
  onShowList: () => void
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const logs = useSshStore((state) => state.connectLogs[connectionId] ?? EMPTY_LOGS)
  const logScrollRef = useRef<HTMLDivElement>(null)

  const isConnecting = sessionStatus === 'connecting'
  const isError = sessionStatus === 'error'

  // The furthest stage any log line has reached drives the step indicator.
  const reachedStage = useMemo<StageKey>(() => {
    let reached: StageKey = 'dial'
    for (const entry of logs) {
      if (entry.stage === 'reconnect') continue
      const idx = STAGE_ORDER.indexOf(entry.stage as StageKey)
      if (idx > STAGE_ORDER.indexOf(reached)) reached = entry.stage as StageKey
    }
    return reached
  }, [logs])

  useEffect(() => {
    const node = logScrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [logs])

  const reachedIndex = STAGE_ORDER.indexOf(reachedStage)

  return (
    <div
      className="flex flex-1 items-start justify-center overflow-auto px-6 py-12"
      style={{ background: palette.canvas }}
    >
      <div className="flex w-full max-w-[760px] flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-6">
          <div className="flex items-start gap-4">
            <div
              className="flex size-11 shrink-0 items-center justify-center rounded-[14px]"
              style={{ background: palette.accent, color: palette.accentContrast }}
            >
              {isError ? (
                <XCircle className="size-5" />
              ) : isConnecting ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <Terminal className="size-5" />
              )}
            </div>
            <div className="min-w-0">
              <div className="truncate text-[1.2rem] font-semibold" style={{ color: palette.text }}>
                {connectionName}
              </div>
              <div className="mt-1 truncate text-[0.84rem]" style={{ color: palette.muted }}>
                {connectionAddress}
              </div>
            </div>
          </div>
          <div
            className="rounded-full px-3 py-1 text-[0.78rem] font-semibold"
            style={{
              background: isError ? palette.dangerSoft : palette.accentSoft,
              color: isError ? palette.danger : palette.accent
            }}
          >
            {isError
              ? t('workspace.stage.failed', { defaultValue: 'Failed' })
              : t('workspace.stage.connecting', { defaultValue: 'Connecting…' })}
          </div>
        </div>

        {/* Step indicator */}
        <div className="mt-7 flex items-center gap-2">
          {STAGE_ORDER.map((stage, index) => {
            const done = index < reachedIndex || (!isConnecting && !isError)
            const current = isConnecting && index === reachedIndex
            const failed = isError && index === reachedIndex
            const dotColor = failed
              ? palette.danger
              : done || current
                ? palette.accent
                : palette.muted
            return (
              <div key={stage} className="flex flex-1 items-center gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-[0.66rem] font-semibold"
                    style={{ background: dotColor, color: palette.canvas }}
                  >
                    {done ? <CheckCircle2 className="size-3.5" /> : index + 1}
                  </div>
                  <span
                    className="text-[0.78rem] font-medium"
                    style={{ color: current || failed ? palette.text : palette.muted }}
                  >
                    {t(`workspace.stage.${stage}`, { defaultValue: stage })}
                  </span>
                </div>
                {index < STAGE_ORDER.length - 1 ? (
                  <div
                    className="h-0.5 flex-1 rounded-full"
                    style={{ background: index < reachedIndex ? palette.accent : palette.muted }}
                  />
                ) : null}
              </div>
            )
          })}
        </div>

        {/* Live protocol log */}
        <div
          className="mt-7 overflow-hidden rounded-[18px] border"
          style={{ borderColor: palette.panelBorder, background: palette.panel }}
        >
          <div
            className="flex items-center justify-between border-b px-4 py-2.5"
            style={{ borderColor: palette.panelBorder }}
          >
            <span
              className="text-[0.72rem] font-semibold uppercase tracking-[0.18em]"
              style={{ color: palette.muted }}
            >
              {t('workspace.connectionLog', { defaultValue: 'Connection log' })}
            </span>
            <span className="text-[0.72rem]" style={{ color: palette.muted }}>
              {logs.length} {t('workspace.stage.lines', { defaultValue: 'lines' })}
            </span>
          </div>
          <div
            ref={logScrollRef}
            className="h-[320px] overflow-y-auto px-4 py-3 font-mono text-[0.76rem] leading-[1.55]"
          >
            {logs.length === 0 ? (
              <div style={{ color: palette.muted }}>
                {t('workspace.stage.waitingLog', { defaultValue: 'Waiting for connection…' })}
              </div>
            ) : (
              logs.map((entry) => (
                <div key={entry.seq} className="flex gap-2 whitespace-pre-wrap break-all">
                  <span className="shrink-0 tabular-nums" style={{ color: palette.muted }}>
                    {formatTime(entry.ts)}
                  </span>
                  <span
                    className="shrink-0 uppercase"
                    style={{ color: palette.muted, minWidth: '3.2rem' }}
                  >
                    {entry.stage}
                  </span>
                  <span style={{ color: levelColor(entry.level, palette) }}>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {isError && sessionError ? (
          <div
            className="mt-4 rounded-[14px] border px-4 py-3 text-[0.85rem]"
            style={{
              borderColor: palette.danger,
              background: palette.dangerSoft,
              color: palette.danger
            }}
          >
            {sessionError}
          </div>
        ) : null}

        {/* Actions */}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            variant="outline"
            size="sm"
            className="h-10 rounded-2xl px-5 text-[0.88rem] font-semibold shadow-none hover:opacity-90"
            style={{
              borderColor: palette.panelBorder,
              background: palette.panel,
              color: palette.terminalText
            }}
            onClick={onClose}
          >
            {t('workspace.close', { defaultValue: 'Close' })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-10 rounded-2xl px-5 text-[0.88rem] font-semibold shadow-none hover:opacity-90"
            style={{
              borderColor: palette.panelBorder,
              background: palette.panel,
              color: palette.terminalText
            }}
            onClick={onShowList}
          >
            {t('workspace.backToHosts', { defaultValue: 'Back to hosts' })}
          </Button>
          {isError ? (
            <Button
              size="sm"
              className="h-10 rounded-2xl px-5 text-[0.88rem] font-semibold hover:opacity-90"
              style={{ background: palette.accent, color: palette.accentContrast }}
              onClick={onRetry}
            >
              {t('terminal.reconnect')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
