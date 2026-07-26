import { AlertCircle, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@renderer/components/ui/dialog'

interface Props {
  error: string
}

function formatError(error: string): string {
  const jsonStart = error.indexOf('{')
  if (jsonStart < 0) return error

  try {
    const prefix = error.slice(0, jsonStart).trimEnd()
    const details = JSON.stringify(JSON.parse(error.slice(jsonStart)), null, 2)
    return prefix ? `${prefix}\n\n${details}` : details
  } catch {
    return error
  }
}

export function NodeErrorBanner({ error }: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const formattedError = formatError(error)

  const copyError = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(error)
      toast.success(t('drawPage.errorCopied', { defaultValue: 'Error copied' }))
    } catch {
      toast.error(t('drawPage.copyError', { defaultValue: 'Copy error' }))
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          data-nodrag
          title={error}
          className="absolute inset-x-2 bottom-2 flex min-w-0 items-center gap-1.5 rounded-md bg-destructive/90 px-2 py-1 text-left text-[11px] text-white transition-colors hover:bg-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
        >
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </button>
      </DialogTrigger>

      <DialogContent data-nodrag className="gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertCircle className="size-4 text-destructive" />
            {t('drawPage.errorDetails', { defaultValue: 'Error details' })}
          </DialogTitle>
          <DialogDescription>
            {t('drawPage.errorDetailsHint', {
              defaultValue: 'Review the complete provider response or copy it for troubleshooting.'
            })}
          </DialogDescription>
        </DialogHeader>

        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-3 font-mono text-xs leading-5 text-foreground">
          {formattedError}
        </pre>

        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => void copyError()}>
            <Copy className="size-3.5" />
            {t('drawPage.copyError', { defaultValue: 'Copy error' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
