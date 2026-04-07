import { AlertTriangle } from 'lucide-react'

interface AgentErrorCardProps {
  code: 'runtime_error' | 'tool_error' | 'unknown'
  message: string
  errorType?: string
  details?: string
  stackTrace?: string
}

export function AgentErrorCard({
  code,
  message,
  errorType,
  details,
  stackTrace
}: AgentErrorCardProps): React.JSX.Element {
  const title =
    code === 'tool_error' ? '工具执行失败' : code === 'runtime_error' ? '运行失败' : '执行异常'

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex gap-3">
        <div className="mt-0.5 rounded-md bg-destructive/15 p-1.5">
          <AlertTriangle className="size-4 text-destructive" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive/90">{title}</p>
          <p className="mt-1 break-all text-xs leading-relaxed text-muted-foreground">{message}</p>
          {(errorType || details || stackTrace) && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground/80 hover:text-foreground">
                详细信息
              </summary>
              <div className="mt-1 space-y-2 rounded-md bg-background/80 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {errorType ? <p className="break-all">Type: {errorType}</p> : null}
                {details ? <pre className="whitespace-pre-wrap break-all">{details}</pre> : null}
                {stackTrace ? <pre className="whitespace-pre-wrap break-all">{stackTrace}</pre> : null}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
