import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Play, RefreshCw, Smartphone, Square, TriangleAlert } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import type { RemoteControlPhase } from '../../../../shared/remote-control'
import { QrCanvas } from './QrCanvas'
import { MobileConnectionList } from './MobileConnectionList'
import { QrOnlineFrame, RemoteConnectionVisual } from './RemoteConnectionVisual'
import { useRemoteControl } from '@renderer/hooks/use-remote-control'

function statusBadgeClass(phase: RemoteControlPhase): string {
  switch (phase) {
    case 'online':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'connecting':
    case 'reconnecting':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'error':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    default:
      return 'border-transparent bg-muted text-muted-foreground'
  }
}

function presentRemoteError(error: string, fallback: string): string {
  const cut = error.search(/<!DOCTYPE|<html/i)
  const text = (cut >= 0 ? error.slice(0, cut) : error)
    .replace(/\s+/g, ' ')
    .replace(/[:\s]+$/, '')
    .trim()
  if (text.length < 8) return fallback
  return text.length > 140 ? `${text.slice(0, 137)}…` : text
}

export function RemoteControlDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('layout')
  const remote = useRemoteControl()
  const phase = remote.state.phase
  const remoteUrl = remote.state.remoteUrl
  const [apiDraft, setApiDraft] = useState(remote.state.apiBaseUrl)
  const canStop = phase === 'connecting' || phase === 'online' || phase === 'reconnecting'
  const connectionFailed = t('remoteControl.connectionFailed', {
    defaultValue: 'Could not reach the remote control server.'
  })

  useEffect(() => {
    setApiDraft(remote.state.apiBaseUrl)
  }, [remote.state.apiBaseUrl])

  const copy = () => {
    if (!remoteUrl) return
    void navigator.clipboard?.writeText(remoteUrl).then(() => {
      toast.success(t('remoteControl.copied', { defaultValue: 'Link copied' }))
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-x-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <Smartphone className="size-5" />
            {t('remoteControl.title')}
            <Badge variant="outline" className={cn('text-[10px]', statusBadgeClass(phase))}>
              {t(`remoteControl.status.${phase}`)}
            </Badge>
          </DialogTitle>
          <DialogDescription>{t('remoteControl.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="remote-control-api-base-url">
            {t('remoteControl.apiBaseUrl', { defaultValue: 'API address' })}
          </label>
          <Input
            id="remote-control-api-base-url"
            value={apiDraft}
            onChange={(event) => setApiDraft(event.target.value)}
            onBlur={() => remote.setApiBaseUrl(apiDraft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            placeholder={t('remoteControl.apiBaseUrlPlaceholder', {
              defaultValue: 'https://api.routin.ai'
            })}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <p className="text-xs text-muted-foreground">
            {t('remoteControl.apiBaseUrlHint', {
              defaultValue: 'Host for the remote-control SignalR hub.'
            })}
          </p>
        </div>

        <div className="flex justify-center">
          {remoteUrl ? (
            <QrOnlineFrame>
              <QrCanvas value={remoteUrl} size={168} />
            </QrOnlineFrame>
          ) : (
            <RemoteConnectionVisual phase={phase} />
          )}
        </div>

        {remote.state.pairingRotatedAt && (
          <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {t('remoteControl.qrChanged')}
          </p>
        )}
        {remote.state.error && (
          <p className="text-xs leading-snug text-destructive">
            {presentRemoteError(remote.state.error, connectionFailed)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {canStop ? (
            <>
              <Button size="sm" variant="outline" onClick={remote.stop}>
                <Square className="size-3.5" />
                {t('remoteControl.stop')}
              </Button>
              <Button size="sm" variant="outline" onClick={remote.rotate} disabled={!remoteUrl}>
                <RefreshCw className="size-3.5" />
                {t('remoteControl.refreshQr')}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => remote.start(apiDraft)}>
              <Play className="size-3.5" />
              {t('remoteControl.start', { defaultValue: 'Enable' })}
            </Button>
          )}
          {remoteUrl && (
            <Button size="sm" variant="outline" className="ml-auto" onClick={copy}>
              <Copy className="size-3.5" />
              {t('remoteControl.copyLink')}
            </Button>
          )}
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('remoteControl.terminalWrite')}</p>
            <p className="text-xs text-muted-foreground">{t('remoteControl.terminalWarning')}</p>
          </div>
          <Switch
            className="mt-0.5"
            checked={remote.state.terminalWriteEnabled}
            onCheckedChange={remote.setTerminalWriteEnabled}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('remoteControl.gitWrite')}</p>
            <p className="text-xs text-muted-foreground">{t('remoteControl.gitWarning')}</p>
          </div>
          <Switch
            className="mt-0.5"
            checked={remote.state.gitWriteEnabled}
            onCheckedChange={remote.setGitWriteEnabled}
          />
        </div>

        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {t('remoteControl.connections')}
            {remote.state.mobiles.length > 0 && (
              <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                {remote.state.mobiles.length}
              </span>
            )}
          </h3>
          <MobileConnectionList
            mobiles={remote.state.mobiles}
            onDisconnect={remote.disconnectMobile}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
