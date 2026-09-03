import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, LogIn, LogOut, RefreshCw, Settings, Loader2, X, Smartphone } from 'lucide-react'
import { RemoteControlDialog } from '@renderer/components/remote/RemoteControlDialog'
import appIconUrl from '../../../../../resources/icon.png'
import { Avatar, AvatarFallback, AvatarImage } from '@renderer/components/ui/avatar'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useUIStore } from '@renderer/stores/ui-store'
import { useAccountSession } from '@renderer/hooks/use-account-session'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import packageJson from '../../../../../package.json'
import { ACCOUNT_OAUTH_DEFAULT_BASE_URL } from '../../../../shared/account-oauth'

const ACCOUNT_PAGE_URL = `${ACCOUNT_OAUTH_DEFAULT_BASE_URL}/dashboard`

// Mirrors SIDEBAR_NAV_BUTTON_CLASS in WorkspaceSidebar so the account row keeps
// the same metrics as the rest of the sidebar navigation.
const ACCOUNT_ROW_CLASS =
  'relative flex min-h-7 w-full min-w-0 items-center justify-between gap-1.5 overflow-hidden rounded-lg px-2 py-1 text-left text-sm font-medium outline-none text-muted-foreground transition-colors hover:text-foreground focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring'

function initialsOf(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) return '?'
  return trimmed.slice(0, 1).toUpperCase()
}

export function AccountMenu(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [open, setOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const { session, isSigningIn, error, login, logout, refresh, cancelLogin } = useAccountSession()

  const displayName = useMemo(() => {
    if (!session) return ''
    return (
      session.user.name ?? session.user.preferredUsername ?? session.user.email ?? session.user.sub
    )
  }, [session])

  // Every menu action closes the popover; the sidebar footer only ever shows one row.
  const runAndClose = (action: () => void): void => {
    setOpen(false)
    action()
  }

  const openSettings = (): void => useUIStore.getState().openSettingsPage('general')
  const openExternal = (url: string): void => {
    void ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, url)
  }

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex w-full items-center gap-1">
        <PopoverTrigger asChild>
        <button type="button" aria-label={t('account.openMenu')} className={`${ACCOUNT_ROW_CLASS} flex-1`}>
          <span className="flex min-w-0 items-center gap-2">
            {session ? (
              <Avatar size="sm" className="size-5">
                {session.user.picture && <AvatarImage src={session.user.picture} alt="" />}
                <AvatarFallback className="text-[10px]">{initialsOf(displayName)}</AvatarFallback>
              </Avatar>
            ) : (
              <img src={appIconUrl} alt="" className="size-5 shrink-0 rounded-md" />
            )}
            <span className="min-w-0 truncate">
              {session ? displayName : t('account.signedOutTitle')}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {!session && isSigningIn && (
              <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden="true" />
            )}
            {error && <span className="size-1.5 rounded-full bg-destructive" aria-hidden="true" />}
            {!session && !isSigningIn && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {t('account.badge')}
              </Badge>
            )}
          </span>
        </button>
        </PopoverTrigger>
        {session && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('account.remoteControl')}
            onClick={() => setRemoteOpen(true)}
          >
            <Smartphone className="size-3.5" />
          </Button>
        )}
      </div>

      <PopoverContent align="start" side="top" className="w-64 p-2">
        <div className="flex items-center gap-2 px-1 pb-2">
          {session ? (
            <>
              <Avatar>
                {session.user.picture && <AvatarImage src={session.user.picture} alt="" />}
                <AvatarFallback>{initialsOf(displayName)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{displayName}</p>
                {session.user.email && (
                  <p className="truncate text-xs text-muted-foreground">{session.user.email}</p>
                )}
              </div>
            </>
          ) : (
            <>
              <img src={appIconUrl} alt="" className="size-8 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t('account.signedOutTitle')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t('account.signedOutSubtitle')}
                </p>
              </div>
            </>
          )}
        </div>

        {error && (
          <p className="px-1 pb-2 text-xs text-destructive">
            {t(`account.error.${error}`)} ({error})
          </p>
        )}

        <div className="flex flex-col gap-0.5 border-t pt-2">
          {session ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 justify-start gap-2 text-xs"
                onClick={() => runAndClose(() => openExternal(ACCOUNT_PAGE_URL))}
              >
                <ExternalLink className="size-3.5" />
                {t('account.manageAccount')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 justify-start gap-2 text-xs"
                onClick={() => runAndClose(() => void refresh())}
              >
                <RefreshCw className="size-3.5" />
                {t('account.refresh')}
              </Button>
            </>
          ) : isSigningIn ? (
            <>
              <div className="flex h-8 items-center gap-2 px-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t('account.signingIn')}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 justify-start gap-2 text-xs"
                onClick={() => runAndClose(() => void cancelLogin())}
              >
                <X className="size-3.5" />
                {t('account.cancelSignIn')}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 justify-start gap-2 text-xs"
              onClick={() => runAndClose(() => void login())}
            >
              <LogIn className="size-3.5" />
              {t('account.signIn')}
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-8 justify-between gap-2 text-xs"
            onClick={() => runAndClose(openSettings)}
          >
            <span className="flex items-center gap-2">
              <Settings className="size-3.5" />
              {t('account.systemSettings')}
            </span>
            <span className="text-[10px] text-muted-foreground/80">v{packageJson.version}</span>
          </Button>

          {session && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 justify-start gap-2 text-xs text-destructive hover:text-destructive"
              onClick={() => runAndClose(() => void logout())}
            >
              <LogOut className="size-3.5" />
              {t('account.signOut')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
    {session && <RemoteControlDialog open={remoteOpen} onOpenChange={setRemoteOpen} />}
    </>
  )
}
