import { useMemo } from 'react'
import { toast } from 'sonner'
import {
  Bell,
  CircleAlert,
  ExternalLink,
  Eye,
  FileQuestion,
  ShieldAlert,
  TriangleAlert
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  useBackgroundSessionStore,
  type PendingInboxItem
} from '@renderer/stores/background-session-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { flushBackgroundSessionToForeground } from '@renderer/lib/agent/session-runtime-router'

function getInboxIcon(item: PendingInboxItem): React.JSX.Element {
  switch (item.type) {
    case 'approval':
      return <ShieldAlert className="size-3.5 text-amber-500" />
    case 'preview_ready':
      return <Eye className="size-3.5 text-sky-500" />
    case 'ask_user':
      return <FileQuestion className="size-3.5 text-violet-500" />
    case 'error':
      return <TriangleAlert className="size-3.5 text-destructive" />
    default:
      return <CircleAlert className="size-3.5 text-muted-foreground" />
  }
}

function getInboxTypeLabel(item: PendingInboxItem): string {
  switch (item.type) {
    case 'approval':
      return '审批'
    case 'preview_ready':
      return '预览'
    case 'ask_user':
      return '提问'
    case 'desktop_control':
      return '桌面'
    case 'foreground_bash':
      return '终端'
    case 'error':
      return '错误'
    default:
      return '待处理'
  }
}

function formatCreatedAt(timestamp: number): string {
  const delta = Date.now() - timestamp
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`
  if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`
  return `${Math.max(1, Math.floor(delta / 86_400_000))} 天前`
}

async function openInboxItem(item: PendingInboxItem): Promise<void> {
  const chatStore = useChatStore.getState()
  const uiStore = useUIStore.getState()

  try {
    chatStore.setActiveSession(item.sessionId)
    uiStore.navigateToSession()
    await flushBackgroundSessionToForeground(item.sessionId)

    if (item.type === 'preview_ready' && item.target?.kind === 'file') {
      uiStore.openFilePreview(
        item.target.filePath,
        item.target.viewMode,
        item.target.sshConnectionId,
        item.sessionId
      )
      useBackgroundSessionStore.getState().resolveInboxItem(item.id)
    }
  } catch (error) {
    console.error('[PendingInboxPopover] Failed to open inbox item:', error)
    toast.error('打开待处理项失败', {
      description: error instanceof Error ? error.message : '请稍后重试'
    })
  }
}

export function PendingInboxPopover(): React.JSX.Element | null {
  const inboxItems = useBackgroundSessionStore((state) => state.inboxItems)
  const resolveInboxItem = useBackgroundSessionStore((state) => state.resolveInboxItem)
  const sessions = useChatStore((state) => state.sessions)

  const unresolvedItems = inboxItems

  const sessionTitleById = useMemo(
    () =>
      Object.fromEntries(
        sessions.map((session) => [session.id, session.title || '未命名会话'])
      ) as Record<string, string>,
    [sessions]
  )

  if (unresolvedItems.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="titlebar-no-drag relative h-7 gap-1.5 px-2 text-[10px]"
        >
          <Bell className="size-3.5" />
          待处理
          <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[9px]">
            {unresolvedItems.length > 99 ? '99+' : unresolvedItems.length}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[24rem] p-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <div className="text-xs font-medium text-foreground/85">全局待处理</div>
          <div className="text-[10px] text-muted-foreground">{unresolvedItems.length} 项</div>
        </div>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {unresolvedItems.map((item) => (
            <div
              key={item.id}
              className="rounded-md border p-2 transition-colors hover:bg-muted/50"
            >
              <button
                type="button"
                className="flex w-full items-start gap-2 text-left"
                onClick={() => {
                  void openInboxItem(item)
                }}
              >
                <span className="mt-0.5 shrink-0">{getInboxIcon(item)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium text-foreground/90">
                      {sessionTitleById[item.sessionId] ?? '后台会话'}
                    </span>
                    <Badge variant="outline" className="px-1 py-0 text-[9px]">
                      {getInboxTypeLabel(item)}
                    </Badge>
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-foreground/80">
                    {item.title}
                  </span>
                  {item.description ? (
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
                  <span className="text-[9px] text-muted-foreground">
                    {formatCreatedAt(item.createdAt)}
                  </span>
                  <ExternalLink className="size-3 text-muted-foreground" />
                </span>
              </button>
              {item.type === 'error' ? (
                <div className="mt-2 flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => resolveInboxItem(item.id)}
                  >
                    忽略
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
