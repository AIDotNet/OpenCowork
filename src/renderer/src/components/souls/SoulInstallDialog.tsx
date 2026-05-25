import { AlertTriangle, FileText, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { useSoulsStore, type SoulInstallTarget } from '@renderer/stores/souls-store'
import { cn } from '@renderer/lib/utils'

interface SoulInstallDialogProps {
  projectRootPath?: string | null
}

export function SoulInstallDialog({
  projectRootPath
}: SoulInstallDialogProps): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const open = useSoulsStore((s) => s.installDialogOpen)
  const soul = useSoulsStore((s) => s.selectedSoul)
  const content = useSoulsStore((s) => s.downloadedContent)
  const target = useSoulsStore((s) => s.target)
  const targetPaths = useSoulsStore((s) => s.targetPaths)
  const downloading = useSoulsStore((s) => s.downloading)
  const installing = useSoulsStore((s) => s.installing)
  const setTarget = useSoulsStore((s) => s.setTarget)
  const installSoul = useSoulsStore((s) => s.installSoul)
  const closeInstallDialog = useSoulsStore((s) => s.closeInstallDialog)

  if (!open) return null

  const currentPath = target === 'project' ? targetPaths?.project.path : targetPaths?.global.path
  const projectAvailable = Boolean(targetPaths?.project.available)

  const handleInstall = async (): Promise<void> => {
    const result = await installSoul(projectRootPath)
    if (result.success) {
      toast.success(t('soulsPage.installed', { path: result.path }))
    } else {
      toast.error(t('soulsPage.installFailed', { error: result.error }))
    }
  }

  const targetOptions: { value: SoulInstallTarget; label: string; path?: string | null }[] = [
    { value: 'global', label: t('soulsPage.globalTarget'), path: targetPaths?.global.path },
    { value: 'project', label: t('soulsPage.projectTarget'), path: targetPaths?.project.path }
  ]

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeInstallDialog()}>
      <DialogContent className="sm:max-w-2xl max-h-[82vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-5" />
            {t('soulsPage.installSoul')}
            {soul ? `: ${soul.name}` : ''}
          </DialogTitle>
        </DialogHeader>

        {downloading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('soulsPage.downloading')}</p>
          </div>
        ) : content ? (
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            {soul?.description ? (
              <p className="text-sm text-muted-foreground">{soul.description}</p>
            ) : null}

            <div className="rounded-lg border p-3 space-y-2">
              <h4 className="text-xs font-semibold">{t('soulsPage.installTarget')}</h4>
              <div className="grid gap-2 sm:grid-cols-2">
                {targetOptions.map((option) => {
                  const disabled = option.value === 'project' && !projectAvailable
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => setTarget(option.value)}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        target === option.value
                          ? 'border-primary bg-primary/5'
                          : 'hover:bg-muted/50',
                        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{option.label}</span>
                        {target === option.value ? <Badge>{t('soulsPage.selected')}</Badge> : null}
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {option.path ?? t('soulsPage.noProjectTarget')}
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
              <div className="flex items-start gap-2 text-xs">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-semibold">{t('soulsPage.overwriteWarning')}</p>
                  <p className="mt-1 truncate font-mono text-[11px]">{currentPath}</p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border p-3 space-y-2">
              <h4 className="text-xs font-semibold">SOUL.md</h4>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground font-mono">
                {content.slice(0, 8000)}
                {content.length > 8000 ? '\n...' : ''}
              </pre>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t('soulsPage.downloadFailed')}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeInstallDialog} disabled={installing}>
            {t('soulsPage.cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void handleInstall()}
            disabled={
              downloading || installing || !content || (target === 'project' && !projectAvailable)
            }
          >
            {installing ? (
              <>
                <Loader2 className="size-3.5 animate-spin mr-1" />
                {t('soulsPage.installing')}
              </>
            ) : (
              t('soulsPage.confirmOverwrite')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
