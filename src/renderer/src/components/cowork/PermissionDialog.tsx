import { useEffect, useCallback } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Badge } from '@renderer/components/ui/badge'
import { ShieldAlert, FileEdit, Terminal, FolderOpen, Trash2, FileSearch, Search, ListChecks, Eye } from 'lucide-react'
import { useChatStore } from '@renderer/stores/chat-store'
import type { ToolCallState } from '@renderer/lib/agent/types'

const toolMeta: Record<string, { icon: React.ReactNode; label: string; risk: 'low' | 'medium' | 'high' }> = {
  Read: { icon: <Eye className="size-4 text-muted-foreground" />, label: 'Read File', risk: 'low' },
  Write: { icon: <FileEdit className="size-4 text-blue-500" />, label: 'Write File', risk: 'medium' },
  Edit: { icon: <FileEdit className="size-4 text-amber-500" />, label: 'Edit File', risk: 'medium' },
  MultiEdit: { icon: <FileEdit className="size-4 text-amber-500" />, label: 'Multi-Edit File', risk: 'medium' },
  Bash: { icon: <Terminal className="size-4 text-red-500" />, label: 'Shell Command', risk: 'high' },
  LS: { icon: <FolderOpen className="size-4 text-muted-foreground" />, label: 'List Directory', risk: 'low' },
  Glob: { icon: <FileSearch className="size-4 text-muted-foreground" />, label: 'Find Files', risk: 'low' },
  Grep: { icon: <Search className="size-4 text-muted-foreground" />, label: 'Search in Files', risk: 'low' },
  TodoRead: { icon: <ListChecks className="size-4 text-muted-foreground" />, label: 'Read Todo', risk: 'low' },
  TodoWrite: { icon: <ListChecks className="size-4 text-blue-500" />, label: 'Write Todo', risk: 'low' },
  Delete: { icon: <Trash2 className="size-4 text-destructive" />, label: 'Delete', risk: 'high' },
}

function formatToolSummary(name: string, input: Record<string, unknown>): string | null {
  if (name === 'Bash') return String(input.command ?? '')
  if (name === 'Write') return `Create/overwrite: ${input.file_path ?? input.path ?? ''}`
  if (name === 'Edit') return `Edit: ${input.file_path ?? input.path ?? ''}`
  if (name === 'MultiEdit') return `Multi-edit: ${input.file_path ?? input.path ?? ''}`
  if (name === 'Read') return `Read: ${input.file_path ?? input.path ?? ''}`
  if (name === 'Glob') return `Pattern: ${input.pattern ?? ''} in ${input.path ?? '.'}`
  if (name === 'Grep') return `Search: "${input.pattern ?? ''}" in ${input.path ?? '.'}`
  if (name === 'LS') return `List: ${input.path ?? '.'}`
  if (name === 'Delete') return `Delete: ${input.file_path ?? input.path ?? ''}`
  if (name === 'TodoWrite') return `Update todo list (${Array.isArray(input.todos) ? input.todos.length : '?'} items)`
  if (name === 'TodoRead') return `Read current todo list`
  if (name === 'CodeSearch') return `Search codebase: ${input.query ?? ''}`
  if (name === 'CodeReview') return `Review: ${input.target ?? ''} (${input.focus ?? 'all'})`
  if (name === 'Planner') return `Plan: ${input.task ?? ''}`
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
  onDeny,
}: PermissionDialogProps): React.JSX.Element {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!toolCall) return
    if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); onAllow() }
    if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); onDeny() }
  }, [toolCall, onAllow, onDeny])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const meta = toolCall ? toolMeta[toolCall.name] : null
  const summary = toolCall ? formatToolSummary(toolCall.name, toolCall.input) : null
  const riskColor = meta?.risk === 'high' ? 'text-red-500' : meta?.risk === 'medium' ? 'text-amber-500' : 'text-muted-foreground'
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
            Permission Required
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {meta?.icon ?? <ShieldAlert className="size-4 text-muted-foreground" />}
                <span className="text-sm">
                  {meta?.label ?? toolCall?.name}
                </span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {toolCall?.name}
                </Badge>
                {meta && (
                  <Badge
                    variant={meta.risk === 'high' ? 'destructive' : 'secondary'}
                    className="text-[9px] px-1.5"
                  >
                    {meta.risk === 'high' ? 'Dangerous' : meta.risk === 'medium' ? 'Caution' : 'Safe'}
                  </Badge>
                )}
              </div>
              {summary && (
                <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
                  {summary}
                </div>
              )}
              {workingFolder && ['Bash', 'Write', 'Edit', 'MultiEdit', 'Delete', 'LS', 'Glob', 'Grep'].includes(toolCall?.name ?? '') && (
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
                  <FolderOpen className="size-3 shrink-0" />
                  <span className="truncate">{workingFolder}</span>
                </div>
              )}
              {toolCall && (
                <details className="group">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
                    Show full input
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed">
                    {JSON.stringify(toolCall.input, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <p className="w-full text-[10px] text-muted-foreground/40 text-center mb-1">
            Allowing will remember this tool for the session · <kbd className="rounded border bg-muted px-0.5 text-[9px]">Ctrl+Shift+A</kbd> auto-approve all
          </p>
          <AlertDialogCancel onClick={onDeny}>
            Deny <kbd className="ml-1.5 rounded border bg-muted px-1 text-[10px]">N</kbd>
          </AlertDialogCancel>
          <AlertDialogAction onClick={onAllow}>
            Allow <kbd className="ml-1.5 rounded border bg-primary-foreground/20 px-1 text-[10px]">Y</kbd>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
