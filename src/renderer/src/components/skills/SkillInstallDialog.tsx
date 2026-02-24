import { useTranslation } from 'react-i18next'
import { ShieldCheck, Loader2, AlertTriangle, FileText, FileCode, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useSkillsStore, type RiskItem } from '@renderer/stores/skills-store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@renderer/components/ui/dialog'
import { toast } from 'sonner'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileIcon(type: string): React.ReactNode {
  const codeExts = new Set(['.py', '.js', '.ts', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.rb', '.pl'])
  if (type === '.md') return <FileText className="size-3.5 text-blue-500" />
  if (codeExts.has(type)) return <FileCode className="size-3.5 text-amber-500" />
  return <FileText className="size-3.5 text-muted-foreground" />
}

const categoryLabels: Record<string, string> = {
  shell: 'riskShellCommand',
  execution: 'riskExecution',
  network: 'riskNetwork',
  credential: 'riskCredential',
  filesystem: 'riskFileSystem',
  exfiltration: 'riskExfiltration',
}

function RiskBadge({ severity }: { severity: RiskItem['severity'] }): React.JSX.Element {
  const { t } = useTranslation('layout')
  const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    safe: 'secondary',
    warning: 'outline',
    danger: 'destructive',
  }
  const labels: Record<string, string> = {
    safe: t('skillsPage.riskSafe'),
    warning: t('skillsPage.riskWarning'),
    danger: t('skillsPage.riskDanger'),
  }
  return <Badge variant={variants[severity]} className="text-[10px] px-1.5 py-0">{labels[severity]}</Badge>
}

export function SkillInstallDialog(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const open = useSkillsStore((s) => s.installDialogOpen)
  const scanning = useSkillsStore((s) => s.scanning)
  const installing = useSkillsStore((s) => s.installing)
  const scanResult = useSkillsStore((s) => s.installScanResult)
  const agentReviewText = useSkillsStore((s) => s.agentReviewText)
  const agentReviewDone = useSkillsStore((s) => s.agentReviewDone)
  const agentReviewPassed = useSkillsStore((s) => s.agentReviewPassed)
  const closeInstallDialog = useSkillsStore((s) => s.closeInstallDialog)
  const confirmInstall = useSkillsStore((s) => s.confirmInstall)

  if (!open) return null

  const handleInstall = async (): Promise<void> => {
    const result = await confirmInstall()
    if (result.success) {
      toast.success(t('skillsPage.added', { name: result.name }))
    } else {
      toast.error(t('skillsPage.addFailed', { error: result.error }))
    }
  }

  const dangerCount = scanResult?.risks.filter((r) => r.severity === 'danger').length ?? 0
  const warningCount = scanResult?.risks.filter((r) => r.severity === 'warning').length ?? 0
  const totalSize = scanResult?.files.reduce((sum, f) => sum + f.size, 0) ?? 0
  const hasDanger = dangerCount > 0

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeInstallDialog()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" />
            {t('skillsPage.installSkill')}{scanResult ? `: ${scanResult.name}` : ''}
          </DialogTitle>
        </DialogHeader>

        {scanning ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('skillsPage.scanning')}</p>
          </div>
        ) : scanResult ? (
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            {/* AI Security Review section */}
            {!agentReviewDone && (
              <div className="rounded-lg border p-3 space-y-2 bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800">
                <h4 className="text-xs font-semibold flex items-center gap-1.5 text-blue-900 dark:text-blue-100">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t('skillsPage.agentReview')}
                </h4>
                <p className="text-xs text-muted-foreground">{t('skillsPage.agentReviewing')}</p>
                {agentReviewText && (
                  <pre className="text-[10px] leading-relaxed text-muted-foreground font-mono max-h-24 overflow-y-auto whitespace-pre-wrap">
                    {agentReviewText.slice(0, 500)}
                  </pre>
                )}
              </div>
            )}

            {agentReviewDone && (
              <div className={cn('rounded-lg border p-3 space-y-2', agentReviewPassed ? 'bg-green-50/50 dark:bg-green-950/20 border-green-200 dark:border-green-800' : 'bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800')}>
                <h4 className="text-xs font-semibold flex items-center gap-1.5">
                  {agentReviewPassed ? (
                    <>
                      <CheckCircle className="size-3.5 text-green-600 dark:text-green-400" />
                      <span className="text-green-900 dark:text-green-100">{t('skillsPage.agentReviewPassed')}</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="size-3.5 text-amber-600 dark:text-amber-400" />
                      <span className="text-amber-900 dark:text-amber-100">{t('skillsPage.agentReviewFailed')}</span>
                    </>
                  )}
                </h4>
              </div>
            )}

            {/* Risk summary */}
            <div className="rounded-lg border p-3 space-y-2">
              <h4 className="text-xs font-semibold flex items-center gap-1.5">
                <AlertTriangle className={cn('size-3.5', hasDanger ? 'text-destructive' : warningCount > 0 ? 'text-amber-500' : 'text-green-500')} />
                {t('skillsPage.securityReview')}
              </h4>
              {scanResult.risks.length === 0 ? (
                <p className="text-xs text-green-600">{t('skillsPage.noRisks')}</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    {dangerCount > 0 && <span className="text-destructive font-medium">{dangerCount} {t('skillsPage.riskDanger')}</span>}
                    {warningCount > 0 && <span className="text-amber-500 font-medium">{warningCount} {t('skillsPage.riskWarning')}</span>}
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {scanResult.risks.map((risk, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs rounded-md bg-muted/50 px-2 py-1.5">
                        <RiskBadge severity={risk.severity} />
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{t(`skillsPage.${categoryLabels[risk.category]}` as never, { defaultValue: risk.category })}</span>
                          <span className="text-muted-foreground">: {risk.detail}</span>
                          <span className="text-muted-foreground/60 ml-1">{risk.file}{risk.line ? `:${risk.line}` : ''}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* File listing */}
            <div className="rounded-lg border p-3 space-y-2">
              <h4 className="text-xs font-semibold">
                {t('skillsPage.filesLabel')} ({t('skillsPage.filesCount', { count: scanResult.files.length, size: formatSize(totalSize) })})
              </h4>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {scanResult.files.map((file) => (
                  <div key={file.name} className="flex items-center gap-2 text-xs px-1 py-0.5">
                    {fileIcon(file.type)}
                    <span className="flex-1 truncate font-mono text-[11px]">{file.name}</span>
                    <span className="text-muted-foreground text-[10px] shrink-0">{formatSize(file.size)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* SKILL.md preview */}
            <div className="rounded-lg border p-3 space-y-2">
              <h4 className="text-xs font-semibold">SKILL.md</h4>
              <pre className="text-[11px] leading-relaxed text-muted-foreground font-mono max-h-40 overflow-y-auto whitespace-pre-wrap">
                {scanResult.skillMdContent.slice(0, 2000)}
                {scanResult.skillMdContent.length > 2000 ? '\n...' : ''}
              </pre>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t('skillsPage.addFailed', { error: 'Scan failed' })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeInstallDialog} disabled={installing}>
            {t('skillsPage.cancel')}
          </Button>
          <Button
            size="sm"
            variant={hasDanger ? 'destructive' : 'default'}
            onClick={() => void handleInstall()}
            disabled={scanning || installing || !scanResult || (agentReviewText !== '' && !agentReviewDone)}
          >
            {installing ? (
              <><Loader2 className="size-3.5 animate-spin mr-1" />{t('skillsPage.installing')}</>
            ) : hasDanger ? (
              t('skillsPage.installAnyway')
            ) : (
              t('skillsPage.installSafe')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
