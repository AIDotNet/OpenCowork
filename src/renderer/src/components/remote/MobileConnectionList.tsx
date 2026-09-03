import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Monitor, Smartphone, Tablet, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import type { RemoteMobileConnection } from '../../../../shared/remote-control'
import { presentMobileDevice, type MobileDeviceKind } from './present-mobile-connection'

function DeviceIcon({ kind }: { kind: MobileDeviceKind }): React.JSX.Element {
  const Icon = kind === 'ipad' ? Tablet : kind === 'desktop' ? Monitor : Smartphone
  return <Icon className="size-4" />
}

function formatAttachedAt(ms: number, t: TFunction): string {
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000))
  if (minutes < 1) return t('remoteControl.justNow', { defaultValue: 'Just now' })
  if (minutes < 60) {
    return t('remoteControl.minutesAgo', {
      count: minutes,
      defaultValue: '{{count}} min ago'
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return t('remoteControl.hoursAgo', {
      count: hours,
      defaultValue: '{{count}} hr ago'
    })
  }
  return t('remoteControl.daysAgo', {
    count: Math.floor(hours / 24),
    defaultValue: '{{count}}d ago'
  })
}

export function MobileConnectionList({
  mobiles,
  onDisconnect
}: {
  mobiles: RemoteMobileConnection[]
  onDisconnect: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  if (!mobiles.length)
    return (
      <p className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-center text-xs text-muted-foreground">
        {t('remoteControl.noConnections')}
      </p>
    )
  return (
    <div className="space-y-1.5">
      {mobiles.map((mobile) => {
        const device = presentMobileDevice(mobile.userAgent, mobile.ipAddress)
        const title = device.titleKey
          ? t(`remoteControl.${device.titleKey}`, { defaultValue: device.title })
          : device.title
        const meta = [device.detail, device.ipAddress, formatAttachedAt(mobile.attachedAtMs, t)]
          .filter(Boolean)
          .join(' · ')
        return (
          <div
            key={mobile.mobileId}
            className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"
            title={mobile.userAgent || undefined}
          >
            <div className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <DeviceIcon kind={device.kind} />
              <span
                aria-hidden
                className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-emerald-500"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{title}</p>
              <p className="truncate text-[11px] text-muted-foreground">{meta}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('remoteControl.disconnect')}
              onClick={() => onDisconnect(mobile.mobileId)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
