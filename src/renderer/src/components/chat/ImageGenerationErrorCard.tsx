import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock3, WifiOff, Ban } from 'lucide-react'
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
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex gap-3">
        <div className="mt-0.5 rounded-md bg-destructive/15 p-1.5">
          <Icon className="size-4 text-destructive" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive/90">{t(viewModel.titleKey)}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t(viewModel.descKey)}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground/80 hover:text-foreground">
              {t('assistantMessage.imageError.details')}
            </summary>
            <div className="mt-1 space-y-2">
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
