import { useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Badge } from '@renderer/components/ui/badge'
import {
  ShieldAlert,
  FileEdit,
  Terminal,
  FolderOpen,
  Trash2,
  FileSearch,
  Search,
  ListChecks,
  Eye,
  MessageCircle,
  AtSign,
  Bell,
  Table
} from 'lucide-react'
import { useChatStore } from '@renderer/stores/chat-store'
import type { ToolCallState } from '@renderer/lib/agent/types'

const toolMeta: Record<
  string,
  { icon: React.ReactNode; label: string; risk: 'low' | 'medium' | 'high' }
> = {
  Read: { icon: <Eye className="size-4 text-muted-foreground" />, label: 'Read File', risk: 'low' },
  Write: {
    icon: <FileEdit className="size-4 text-blue-500" />,
    label: 'Write File',
    risk: 'medium'
  },
  Edit: {
    icon: <FileEdit className="size-4 text-amber-500" />,
    label: 'Edit File',
    risk: 'medium'
  },
  Bash: {
    icon: <Terminal className="size-4 text-red-500" />,
    label: 'Shell Command',
    risk: 'high'
  },
  LS: {
    icon: <FolderOpen className="size-4 text-muted-foreground" />,
    label: 'List Directory',
    risk: 'low'
  },
  Glob: {
    icon: <FileSearch className="size-4 text-muted-foreground" />,
    label: 'Find Files',
    risk: 'low'
  },
  Grep: {
    icon: <Search className="size-4 text-muted-foreground" />,
    label: 'Search in Files',
    risk: 'low'
  },
  TaskCreate: {
    icon: <ListChecks className="size-4 text-blue-500" />,
    label: 'Create Task',
    risk: 'low'
  },
  TaskGet: {
    icon: <ListChecks className="size-4 text-muted-foreground" />,
    label: 'Get Task',
    risk: 'low'
  },
  TaskUpdate: {
    icon: <ListChecks className="size-4 text-blue-500" />,
    label: 'Update Task',
    risk: 'low'
  },
  TaskList: {
    icon: <ListChecks className="size-4 text-muted-foreground" />,
    label: 'List Tasks',
    risk: 'low'
  },
  Delete: { icon: <Trash2 className="size-4 text-destructive" />, label: 'Delete', risk: 'high' },
  PluginSendMessage: {
    icon: <MessageCircle className="size-4 text-amber-500" />,
    label: 'Send Plugin Message',
    risk: 'medium'
  },
  PluginReplyMessage: {
    icon: <MessageCircle className="size-4 text-amber-500" />,
    label: 'Reply via Plugin',
    risk: 'medium'
  },
  PluginGetGroupMessages: {
    icon: <MessageCircle className="size-4 text-muted-foreground" />,
    label: 'Read Group Messages',
    risk: 'low'
  },
  PluginGetCurrentChatMessages: {
    icon: <MessageCircle className="size-4 text-muted-foreground" />,
    label: 'Read Current Chat',
    risk: 'low'
  },
  FeishuSendImage: {
    icon: <MessageCircle className="size-4 text-amber-500" />,
    label: 'Send Feishu Image',
    risk: 'medium'
  },
  FeishuSendFile: {
    icon: <MessageCircle className="size-4 text-amber-500" />,
    label: 'Send Feishu File',
    risk: 'medium'
  },
  FeishuListChatMembers: {
    icon: <MessageCircle className="size-4 text-muted-foreground" />,
    label: 'List Feishu Members',
    risk: 'low'
  },
  FeishuAtMember: {
    icon: <AtSign className="size-4 text-amber-500" />,
    label: 'Mention Feishu Member',
    risk: 'medium'
  },
  FeishuSendUrgent: {
    icon: <Bell className="size-4 text-red-500" />,
    label: 'Send Urgent Push',
    risk: 'high'
  },
  FeishuBitableListApps: {
    icon: <Table className="size-4 text-muted-foreground" />,
    label: 'List Bitable Apps',
    risk: 'low'
  },
  FeishuBitableListTables: {
    icon: <Table className="size-4 text-muted-foreground" />,
    label: 'List Bitable Tables',
    risk: 'low'
  },
  FeishuBitableListFields: {
    icon: <Table className="size-4 text-muted-foreground" />,
    label: 'List Bitable Fields',
    risk: 'low'
  },
  FeishuBitableGetRecords: {
    icon: <Table className="size-4 text-muted-foreground" />,
    label: 'Get Bitable Records',
    risk: 'low'
  },
  FeishuBitableCreateRecords: {
    icon: <Table className="size-4 text-amber-500" />,
    label: 'Create Bitable Records',
    risk: 'medium'
  },
  FeishuBitableUpdateRecords: {
    icon: <Table className="size-4 text-amber-500" />,
    label: 'Update Bitable Records',
    risk: 'medium'
  },
  FeishuBitableDeleteRecords: {
    icon: <Table className="size-4 text-red-500" />,
    label: 'Delete Bitable Records',
    risk: 'high'
  }
}

function formatToolSummary(name: string, input: Record<string, unknown>): string | null {
  if (name === 'Bash') return String(input.command ?? '')
  if (name === 'Write') return `Create/overwrite: ${input.file_path ?? input.path ?? ''}`
  if (name === 'Edit') return `Edit: ${input.file_path ?? input.path ?? ''}`
  if (name === 'Read') return `Read: ${input.file_path ?? input.path ?? ''}`
  if (name === 'Glob') return `Pattern: ${input.pattern ?? ''} in ${input.path ?? '.'}`
  if (name === 'Grep') return `Search: "${input.pattern ?? ''}" in ${input.path ?? '.'}`
  if (name === 'LS') return `List: ${input.path ?? '.'}`
  if (name === 'Delete') return `Delete: ${input.file_path ?? input.path ?? ''}`
  if (name === 'TaskCreate') return `Create task: ${input.subject ?? ''}`
  if (name === 'TaskGet') return `Get task: #${input.taskId ?? ''}`
  if (name === 'TaskUpdate') return `Update task: #${input.taskId ?? ''}${input.status ? ` → ${input.status}` : ''}`
  if (name === 'TaskList') return `List all tasks`
  if (name === 'Task') return `[${input.subagent_type ?? '?'}] ${input.description ?? ''}`
  return null
}

interface PermissionDialogProps {
  toolCall: ToolCallState | null
  onAllow: () => void
  onDeny: () => void
}

export function PermissionDialog({
  toolCall,
  onAllow,
  onDeny
}: PermissionDialogProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!toolCall) return
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        onAllow()
      }
      if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault()
        onDeny()
      }
    },
    [toolCall, onAllow, onDeny]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const meta = toolCall ? toolMeta[toolCall.name] : null
  const summary = toolCall ? formatToolSummary(toolCall.name, toolCall.input) : null
  const riskColor =
    meta?.risk === 'high'
      ? 'text-red-500'
      : meta?.risk === 'medium'
        ? 'text-amber-500'
        : 'text-muted-foreground'
  const activeSession = useChatStore((s) => {
    const id = s.activeSessionId
    return id ? s.sessions.find((sess) => sess.id === id) : undefined
  })
  const workingFolder = activeSession?.workingFolder

  return (
    <AlertDialog open={!!toolCall}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className={`size-5 ${riskColor}`} />
            {t('permission.title')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {meta?.icon ?? <ShieldAlert className="size-4 text-muted-foreground" />}
                <span className="text-sm">{meta?.label ?? toolCall?.name}</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {toolCall?.name}
                </Badge>
                {meta && (
                  <Badge
                    variant={meta.risk === 'high' ? 'destructive' : 'secondary'}
                    className="text-[9px] px-1.5"
                  >
                    {meta.risk === 'high'
                      ? t('permission.dangerous')
                      : meta.risk === 'medium'
                        ? t('permission.caution')
                        : t('permission.safe')}
                  </Badge>
                )}
              </div>
              {summary && (
                <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
                  {summary}
                </div>
              )}
              {workingFolder &&
                ['Bash', 'Write', 'Edit', 'Delete', 'LS', 'Glob', 'Grep'].includes(
                  toolCall?.name ?? ''
                ) && (
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
                    <FolderOpen className="size-3 shrink-0" />
                    <span className="truncate">{workingFolder}</span>
                  </div>
                )}
              {toolCall && (
                <details className="group">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {t('permission.showFullInput')}
                  </summary>
                  <pre className="mt-1 max-h-40 max-w-full overflow-x-auto overflow-y-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                    {JSON.stringify(toolCall.input, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <p className="w-full text-[10px] text-muted-foreground/40 text-center mb-1">
            {t('permission.rememberTool')} ·{' '}
            <kbd className="rounded border bg-muted px-0.5 text-[9px]">Ctrl+Shift+A</kbd>{' '}
            {t('permission.autoApproveAll')}
          </p>
          <AlertDialogCancel onClick={onDeny}>
            {t('action.deny', { ns: 'common' })} <kbd className="ml-1.5 rounded border bg-muted px-1 text-[10px]">N</kbd>
          </AlertDialogCancel>
          <AlertDialogAction onClick={onAllow}>
            {t('action.allow', { ns: 'common' })}{' '}
            <kbd className="ml-1.5 rounded border bg-primary-foreground/20 px-1 text-[10px]">Y</kbd>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
