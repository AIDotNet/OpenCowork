import { useTranslation } from 'react-i18next'
import { AlertTriangle, Ban, ChevronDown, Clock3, WifiOff } from 'lucide-react'
import type { ImageErrorCode } from '@renderer/lib/api/types'

interface ImageGenerationErrorCardProps {
  code: ImageErrorCode
  message: string
  details?: string
}

interface ErrorViewModel {
  icon: React.ComponentType<{ className?: string }>
  titleKey: string
  descKey: string
}

function getErrorViewModel(code: ImageErrorCode): ErrorViewModel {
  switch (code) {
    case 'timeout':
      return {
        icon: Clock3,
        titleKey: 'assistantMessage.imageError.titleTimeout',
        descKey: 'assistantMessage.imageError.descTimeout'
      }
    case 'network':
      return {
        icon: WifiOff,
        titleKey: 'assistantMessage.imageError.titleNetwork',
        descKey: 'assistantMessage.imageError.descNetwork'
      }
    case 'request_aborted':
      return {
        icon: Ban,
        titleKey: 'assistantMessage.imageError.titleAborted',
        descKey: 'assistantMessage.imageError.descAborted'
      }
    case 'api_error':
      return {
        icon: AlertTriangle,
        titleKey: 'assistantMessage.imageError.titleApi',
        descKey: 'assistantMessage.imageError.descApi'
      }
    default:
      return {
        icon: AlertTriangle,
        titleKey: 'assistantMessage.imageError.titleUnknown',
        descKey: 'assistantMessage.imageError.descUnknown'
      }
  }
}

export function ImageGenerationErrorCard({
  code,
  message,
  details
}: ImageGenerationErrorCardProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const viewModel = getErrorViewModel(code)
  const Icon = viewModel.icon

  return (
    <div className="my-2 w-full max-w-[560px]">
      <div className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-destructive/85">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-destructive/25 bg-transparent">
          <Icon className="size-3" />
        </span>
        <span className="shrink-0 text-muted-foreground/55">gpt-image</span>
        <span className="shrink-0 text-muted-foreground/40">&gt;</span>
        <span className="shrink-0 font-mono font-medium text-foreground/82">image_generation</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
          ({t(viewModel.titleKey)})
        </span>
      </div>

      <div className="ml-3 mt-1.5 overflow-hidden border-l border-destructive/20 pl-5">
        <div className="rounded-lg border border-destructive/25 bg-destructive/[0.035] px-3 py-3">
          <p className="text-sm font-medium text-destructive/90">{t(viewModel.titleKey)}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t(viewModel.descKey)}
          </p>
          <details className="group mt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground/80 transition-colors hover:text-foreground">
              <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
              <span>{t('assistantMessage.imageError.details')}</span>
            </summary>
            <div className="mt-2 space-y-2">
              <p className="break-all rounded-md bg-background/80 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {message}
              </p>
              {details && (
                <p className="break-all rounded-md bg-background/80 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {details}
                </p>
              )}
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
