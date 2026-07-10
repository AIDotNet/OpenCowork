import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Ban,
  Check,
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
    icon: Ban,
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

function classify(code: AgentErrorCode, message: string, errorType?: string): Category {
  const haystack = `${errorType ?? ''} ${message ?? ''}`.toLowerCase()
  const httpMatch = haystack.match(/\b([45]\d{2})\b/)
  const status = httpMatch ? Number(httpMatch[1]) : undefined

  if (/sidecar|native worker|native runtime|local agent runtime/.test(haystack)) {
    return 'runtimeUnavailable'
  }
  if (/abort|cancel/.test(haystack)) return 'aborted'
  if (/timeout|timed out|etimedout/.test(haystack)) return 'timeout'
  if (/rate ?limit|too many requests|429/.test(haystack)) return 'rateLimit'
  if (/quota|insufficient[_ ]?(balance|quota|credit)|billing|payment/.test(haystack)) return 'quota'
  if (
    /unauthorized|forbidden|invalid[_ ]?api[_ ]?key|authentication|permission denied|401|403/.test(
      haystack
    )
  )
    return 'auth'
  if (errorType === 'transport_circuit_open') return 'temporaryPause'
  if (/econnrefused|enotfound|network|fetch failed|socket|dns|tls|ssl/.test(haystack))
    return 'network'
  if (status && status >= 500) return 'server'
  if (status === 400 || /bad request|invalid request/.test(haystack)) return 'badRequest'

  if (code === 'tool_error') return 'tool'
  if (code === 'runtime_error') return 'runtime'
  return 'unknown'
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
  const Icon = view.icon
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

  const hasDetails = Boolean(errorType || details || stackTrace)

  const handleCopy = async (): Promise<void> => {
    const payload = [
      errorType ? `${t('assistantMessage.agentError.errorType')}: ${errorType}` : '',
      message,
      details ?? '',
      stackTrace ?? ''
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex gap-3">
        <div className="mt-0.5 shrink-0 self-start rounded-md bg-destructive/15 p-1.5">
          <Icon className="size-4 text-destructive" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-destructive/90">{t(view.titleKey)}</p>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/80 hover:bg-background/60 hover:text-foreground"
              aria-label={t('assistantMessage.agentError.copy')}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied
                ? t('assistantMessage.agentError.copied')
                : t('assistantMessage.agentError.copy')}
            </button>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(view.descKey)}</p>
          {displayMessage ? (
            <p className="mt-2 break-words rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
              {displayMessage}
            </p>
          ) : null}
          {hasDetails ? (
            <details className="mt-2 group">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground/80 hover:text-foreground">
                {t('assistantMessage.agentError.details')}
              </summary>
              <div className="mt-1 space-y-2 rounded-md bg-background/80 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {errorType ? (
                  <p className="break-words">
                    <span className="text-foreground/70">
                      {t('assistantMessage.agentError.errorType')}:
                    </span>{' '}
                    {errorType}
                  </p>
                ) : null}
                {details ? (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                    {details}
                  </pre>
                ) : null}
                {stackTrace ? (
                  <div>
                    <p className="mb-1 text-foreground/70">
                      {t('assistantMessage.agentError.stackTrace')}
                    </p>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                      {stackTrace}
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
