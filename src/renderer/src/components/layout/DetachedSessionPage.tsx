import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useChatStore } from '@renderer/stores/chat-store'
import { cn } from '@renderer/lib/utils'
import { SessionConversationPane } from './SessionConversationPane'
import { WindowControls } from './WindowControls'

interface DetachedSessionPageProps {
  sessionId: string
}

export function DetachedSessionPage({ sessionId }: DetachedSessionPageProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const sessionTitle = useChatStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.title ?? null
  )
  const isMac = /Mac/.test(navigator.userAgent)

  useEffect(() => {
    document.title = sessionTitle ? `${sessionTitle} | OpenCoWork` : 'OpenCoWork'
  }, [sessionTitle])

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <header
          className={cn(
            'titlebar-drag relative flex h-10 shrink-0 items-center gap-3 border-b border-border/60 bg-background/85 px-3 backdrop-blur-md',
            isMac ? 'pl-[78px]' : 'pr-[132px]'
          )}
          style={{ paddingRight: isMac ? undefined : 'calc(132px + 0.75rem)' }}
        >
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/85">
            {sessionTitle ?? t('sidebar.newChat', { defaultValue: 'New chat' })}
          </div>

          {!isMac ? (
            <div className="absolute right-0 top-0 z-10">
              <WindowControls />
            </div>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <SessionConversationPane sessionId={sessionId} allowOpenInNewWindow={false} />
        </div>
      </div>
    </TooltipProvider>
  )
}
