import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  Copy,
  KeyRound,
  ServerCrash,
  Timer,
  WalletCards,
  WifiOff,
  Wrench
} from 'lucide-react'
import type { AgentErrorCode } from '@renderer/lib/api/types'
import { cn } from '@renderer/lib/utils'

interface AgentErrorCardProps {
  code: AgentErrorCode
  message: string
  errorType?: string
  details?: string
  stackTrace?: string
}

type Category =
  | 'tool'
  | 'runtime'
  | 'runtimeUnavailable'
  | 'auth'
  | 'rateLimit'
  | 'quota'
  | 'temporaryPause'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'server'
  | 'badRequest'
  | 'unknown'
  | 'runtimeFatal'

type Tone = 'neutral' | 'warning' | 'danger'

interface CategoryView {
  icon: React.ComponentType<{ className?: string }>
  titleKey: string
  descKey: string
}

const CATEGORY_VIEW: Record<Category, CategoryView> = {
  tool: {
    icon: Wrench,
    titleKey: 'assistantMessage.agentError.titleTool',
    descKey: 'assistantMessage.agentError.descTool'
  },
  runtime: {
    icon: AlertTriangle,
    titleKey: 'assistantMessage.agentError.titleRuntime',
    descKey: 'assistantMessage.agentError.descRuntime'
  },
  runtimeUnavailable: {
    icon: ServerCrash,
    titleKey: 'assistantMessage.agentError.titleRuntimeUnavailable',
    descKey: 'assistantMessage.agentError.descRuntimeUnavailable'
  },
  runtimeFatal: {
    icon: ServerCrash,
    titleKey: 'assistantMessage.agentError.titleRuntimeFatal',
    descKey: 'assistantMessage.agentError.descRuntimeFatal'
  },
  auth: {
    icon: KeyRound,
    titleKey: 'assistantMessage.agentError.titleAuth',
    descKey: 'assistantMessage.agentError.descAuth'
  },
  rateLimit: {
    icon: Timer,
    titleKey: 'assistantMessage.agentError.titleRateLimit',
    descKey: 'assistantMessage.agentError.descRateLimit'
  },
  quota: {
    icon: WalletCards,
    titleKey: 'assistantMessage.agentError.titleQuota',
    descKey: 'assistantMessage.agentError.descQuota'
  },
  temporaryPause: {
    icon: Timer,
    titleKey: 'assistantMessage.agentError.titleTemporaryPause',
    descKey: 'assistantMessage.agentError.descTemporaryPause'
  },
  network: {
    icon: WifiOff,
    titleKey: 'assistantMessage.agentError.titleNetwork',
    descKey: 'assistantMessage.agentError.descNetwork'
  },
  timeout: {
    icon: Clock3,
    titleKey: 'assistantMessage.agentError.titleTimeout',
    descKey: 'assistantMessage.agentError.descTimeout'
  },
  aborted: {
    icon: CircleStop,
    titleKey: 'assistantMessage.agentError.titleAborted',
    descKey: 'assistantMessage.agentError.descAborted'
  },
  server: {
    icon: ServerCrash,
    titleKey: 'assistantMessage.agentError.titleServer',
    descKey: 'assistantMessage.agentError.descServer'
  },
  badRequest: {
    icon: AlertTriangle,
    titleKey: 'assistantMessage.agentError.titleBadRequest',
    descKey: 'assistantMessage.agentError.descBadRequest'
  },
  unknown: {
    icon: AlertTriangle,
    titleKey: 'assistantMessage.agentError.titleUnknown',
    descKey: 'assistantMessage.agentError.descUnknown'
  }
}

const TONE_VIEW: Record<Tone, { card: string; iconWrap: string; title: string }> = {
  neutral: {
    card: 'border-border/60 bg-muted/15',
    iconWrap: 'bg-muted text-muted-foreground',
    title: 'text-foreground'
  },
  warning: {
    card: 'border-amber-500/25 bg-amber-500/[0.06]',
    iconWrap: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    title: 'text-amber-800 dark:text-amber-300'
  },
  danger: {
    card: 'border-destructive/30 bg-destructive/[0.06]',
    iconWrap: 'bg-destructive/15 text-destructive',
    title: 'text-destructive/90'
  }
}

/**
 * Stable error codes emitted by the native runtime. These are matched before any text pattern:
 * message text varies by locale, and framework exception messages degrade to resource keys in
 * the AOT-published worker, so text matching alone is not dependable.
 */
const ERROR_CODE_CATEGORY: Record<string, Category> = {
  network_transport: 'network',
  network_tls: 'network',
  network_proxy: 'network',
  network_timeout: 'timeout',
  transport_circuit_open: 'temporaryPause',
  sidecar_unavailable: 'runtimeUnavailable',
  worker_interrupted: 'aborted'
}

const FRAMEWORK_NOISE_RE =
  /^(?:system\.)?(?:operation|task)canceled(?:exception)?$|^a task was cancel+ed\.?$|^the (?:operation|request|task) was cancel+ed\.?$|^cancel+ed$|^abort(?:ed)?$/i

function classify(code: AgentErrorCode, message: string, errorType?: string): Category {
  if (errorType && ERROR_CODE_CATEGORY[errorType]) return ERROR_CODE_CATEGORY[errorType]

  const haystack = `${errorType ?? ''} ${message ?? ''}`.toLowerCase()
  const httpMatch = haystack.match(/\b([45]\d{2})\b/)
  const status = httpMatch ? Number(httpMatch[1]) : undefined

  // Fatal means retry cannot self-heal (stale binary, protocol mismatch,
  // restart budget exhausted); checked before the generic runtime patterns so
  // the card shows rebuild guidance instead of "just retry".
  if (/native worker fatal|protocol mismatch|failed to restart after \d+ attempts/.test(haystack)) {
    return 'runtimeFatal'
  }
  if (/sidecar|native worker|native runtime|local agent runtime/.test(haystack)) {
    return 'runtimeUnavailable'
  }
  // Checked before the abort test: a transport failure often mentions a cancelled or aborted
  // connection, and reporting that as a user cancellation hides a real network problem.
  if (
    /econnreset|econnrefused|enotfound|epipe|eai_again|socket hang up|network|fetch failed|socket|dns|tls|ssl|certificate|cert_|handshake/.test(
      haystack
    )
  )
    return 'network'
  if (/abort|cancel/.test(haystack)) return 'aborted'
  if (/timeout|timed out|etimedout|within \d+s/.test(haystack)) return 'timeout'
  if (/rate ?limit|too many requests|429/.test(haystack)) return 'rateLimit'
  if (/quota|insufficient[_ ]?(balance|quota|credit)|billing|payment/.test(haystack)) return 'quota'
  if (
    /unauthorized|forbidden|invalid[_ ]?api[_ ]?key|authentication|permission denied|401|403/.test(
      haystack
    )
  )
    return 'auth'
  if (status && status >= 500) return 'server'
  if (status === 400 || /bad request|invalid request/.test(haystack)) return 'badRequest'

  if (code === 'tool_error') return 'tool'
  if (code === 'runtime_error') return 'runtime'
  return 'unknown'
}

function toneFor(category: Category): Tone {
  switch (category) {
    case 'aborted':
      return 'neutral'
    case 'timeout':
    case 'rateLimit':
    case 'temporaryPause':
    case 'network':
    case 'quota':
    case 'badRequest':
      return 'warning'
    default:
      return 'danger'
  }
}

function normalizeDiagnostic(value?: string): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function isFrameworkNoise(value?: string): boolean {
  const normalized = normalizeDiagnostic(value)
  return !normalized || FRAMEWORK_NOISE_RE.test(normalized)
}

function usefulDiagnostic(value?: string): string {
  const normalized = normalizeDiagnostic(value)
  return !normalized || isFrameworkNoise(normalized) ? '' : value!.trim()
}

export function AgentErrorCard({
  code,
  message,
  errorType,
  details,
  stackTrace
}: AgentErrorCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)

  const category = useMemo(() => classify(code, message, errorType), [code, message, errorType])
  const view = CATEGORY_VIEW[category]
  const severity = toneFor(category)
  const tone = TONE_VIEW[severity]
  const Icon = view.icon
  const title = t(view.titleKey)
  const description = t(view.descKey)

  const displayMessage = useMemo(() => {
    if (errorType !== 'transport_circuit_open') return message

    const seconds = message.match(/\b(\d+)s\b/i)?.[1]
    const lastError = message.match(/last error:\s*(.+)$/i)?.[1]?.trim()
    const base = seconds
      ? t('assistantMessage.agentError.circuitOpenWithSeconds', { seconds })
      : t('assistantMessage.agentError.circuitOpenWithoutSeconds')

    return lastError
      ? `${base} ${t('assistantMessage.agentError.lastErrorLabel')}: ${lastError}`
      : base
  }, [errorType, message, t])

  const compact = category === 'aborted'
  const usefulMessage = compact ? '' : usefulDiagnostic(displayMessage)
  const usefulErrorType = compact ? '' : usefulDiagnostic(errorType)
  const usefulDetails = compact ? '' : usefulDiagnostic(details)
  const usefulStack = compact ? '' : (stackTrace?.trim() ?? '')
  const showMessage = Boolean(usefulMessage && usefulMessage !== usefulErrorType)
  const showErrorType = Boolean(usefulErrorType)
  const showDetailsBlock = Boolean(usefulDetails)
  const showStack = Boolean(usefulStack)
  const hasDiagnostics = showMessage || showErrorType || showDetailsBlock || showStack

  const handleCopy = async (): Promise<void> => {
    const payload = [
      title,
      description,
      usefulErrorType ? `${t('assistantMessage.agentError.errorType')}: ${usefulErrorType}` : '',
      usefulMessage,
      usefulDetails,
      usefulStack
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div
      role={severity === 'danger' ? 'alert' : 'status'}
      className={cn('rounded-xl border', tone.card, compact ? 'px-3 py-2.5' : 'p-3.5')}
    >
      <div className="flex gap-2.5">
        <div
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
            tone.iconWrap
          )}
        >
          <Icon className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className={cn('text-sm font-medium leading-5', tone.title)}>{title}</p>
            {hasDiagnostics ? (
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-background/70 hover:text-foreground"
                aria-label={t('assistantMessage.agentError.copy')}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          {showMessage ? (
            <p className="mt-2 break-words rounded-md bg-background/70 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
              {usefulMessage}
            </p>
          ) : null}
          {hasDiagnostics && (showErrorType || showDetailsBlock || showStack) ? (
            <details className="group mt-2">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/80 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                {t('assistantMessage.agentError.details')}
              </summary>
              <div className="mt-1.5 space-y-2 rounded-md bg-background/80 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
                {showErrorType ? (
                  <p className="break-words">
                    <span className="text-foreground/70">
                      {t('assistantMessage.agentError.errorType')}:
                    </span>{' '}
                    {usefulErrorType}
                  </p>
                ) : null}
                {showDetailsBlock ? (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                    {usefulDetails}
                  </pre>
                ) : null}
                {showStack ? (
                  <div>
                    <p className="mb-1 text-foreground/70">
                      {t('assistantMessage.agentError.stackTrace')}
                    </p>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                      {usefulStack}
                    </pre>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  )
}
