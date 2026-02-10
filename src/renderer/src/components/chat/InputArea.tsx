import * as React from 'react'
import { useState as useLocalState } from 'react'
import { Send, Square, FolderOpen, AlertTriangle, FileUp, Sparkles, X, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { SkillsMenu } from './SkillsMenu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'

const placeholders: Record<AppMode, string> = {
  chat: 'Type a message...',
  cowork: 'Ask the assistant to help with your project...',
  code: 'Describe what you want to build...',
}

interface InputAreaProps {
  onSend: (text: string) => void
  onStop?: () => void
  onSelectFolder?: () => void
  isStreaming?: boolean
  workingFolder?: string
  disabled?: boolean
}

export function InputArea({
  onSend,
  onStop,
  onSelectFolder,
  isStreaming = false,
  workingFolder,
  disabled = false,
}: InputAreaProps): React.JSX.Element {
  const [text, setText] = React.useState('')
  const [selectedSkill, setSelectedSkill] = React.useState<string | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const apiKey = useSettingsStore((s) => s.apiKey)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const mode = useUIStore((s) => s.mode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasMessages = useChatStore((s) => {
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId)
    return (session?.messages.length ?? 0) > 0
  })
  const clearSessionMessages = useChatStore((s) => s.clearSessionMessages)
  const hasApiKey = !!apiKey

  // Auto-focus textarea when not streaming or when switching sessions
  React.useEffect(() => {
    if (!isStreaming && !disabled) {
      textareaRef.current?.focus()
    }
  }, [isStreaming, disabled, activeSessionId])

  // Consume pendingInsertText from FileTree clicks
  const pendingInsert = useUIStore((s) => s.pendingInsertText)
  React.useEffect(() => {
    if (pendingInsert) {
      setText((prev) => {
        const prefix = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : ''
        return `${prev}${prefix}${pendingInsert}`
      })
      useUIStore.getState().setPendingInsertText(null)
      textareaRef.current?.focus()
    }
  }, [pendingInsert])

  const handleSend = (): void => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    const message = selectedSkill
      ? `[Skill: ${selectedSkill}]\n${trimmed}`
      : trimmed
    onSend(message)
    setText('')
    setSelectedSkill(null)
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isStreaming) return
      handleSend()
    }
    // Ctrl+Enter also sends
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (isStreaming) return
      handleSend()
    }
  }

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  // Drag-and-drop file path insertion
  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>): void => {
    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      e.preventDefault()
      const paths = Array.from(files).map((f) => (f as File & { path: string }).path).filter(Boolean)
      if (paths.length > 0) {
        const insertion = paths.join('\n')
        setText((prev) => prev ? `${prev}\n${insertion}` : insertion)
      }
    }
  }

  const [dragging, setDragging] = useLocalState(false)

  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>): void => {
    e.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = (): void => {
    setDragging(false)
  }

  const handleDropWrapped = (e: React.DragEvent<HTMLTextAreaElement>): void => {
    setDragging(false)
    handleDrop(e)
  }

  return (
    <div className="border-t bg-background/80 backdrop-blur-sm px-4 py-3">
      {/* API key warning */}
      {!hasApiKey && (
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-600 dark:text-amber-400 transition-colors hover:bg-amber-500/10"
          onClick={() => setSettingsOpen(true)}
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>No API key configured. Click here to open Settings.</span>
        </button>
      )}

      {/* Working folder indicator */}
      {workingFolder && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderOpen className="size-3" />
          <span className="truncate">{workingFolder}</span>
        </div>
      )}

      <div className="mx-auto max-w-3xl">
        <div className={`relative rounded-2xl border bg-background shadow-lg transition-shadow focus-within:shadow-xl focus-within:ring-1 focus-within:ring-ring/20 ${dragging ? 'ring-2 ring-primary/50' : ''}`}>
          {/* Skill tag */}
          {selectedSkill && (
            <div className="px-3 pt-3 pb-0">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-violet-500/10 border border-violet-500/20 px-2.5 py-1 text-xs font-medium text-violet-600 dark:text-violet-400">
                <Sparkles className="size-3" />
                {selectedSkill}
                <button
                  type="button"
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-violet-500/20 transition-colors"
                  onClick={() => setSelectedSkill(null)}
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          )}

          {/* Text input area */}
          <div className={`relative px-3 ${selectedSkill ? 'pt-1.5' : 'pt-3'}`}>
            {dragging && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/5 pointer-events-none">
                <span className="flex items-center gap-1.5 text-xs text-primary/70 font-medium">
                  <FileUp className="size-3.5" />
                  Drop files to insert paths
                </span>
              </div>
            )}
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onDrop={handleDropWrapped}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              placeholder={placeholders[mode] ?? 'Type a message...'}
              className="min-h-[60px] max-h-[300px] w-full resize-none border-0 bg-background dark:bg-background p-1 shadow-none focus-visible:ring-0 text-base md:text-sm"
              rows={1}
              disabled={disabled}
            />
          </div>

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-2 pb-2 mt-1">
            {/* Left tools */}
            <div className="flex items-center gap-1">
              {/* Skills menu (+ button) */}
              {mode !== 'chat' && (
                <SkillsMenu
                  onSelectSkill={(name) => {
                    setSelectedSkill(name)
                    textareaRef.current?.focus()
                  }}
                  disabled={disabled || isStreaming}
                />
              )}

              {/* Attachment / Folder button */}
              {onSelectFolder && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
                      onClick={onSelectFolder}
                    >
                      <FolderOpen className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Select working folder</TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Right actions */}
            <div className="flex items-center gap-2">
              {text.length > 0 && (
                <span className="text-[10px] text-muted-foreground/60 select-none">
                  {text.split(/\s+/).filter(Boolean).length} words
                </span>
              )}

              {/* Clear messages */}
              {hasMessages && !isStreaming && (
                <AlertDialog>
                  <Tooltip>
                    <AlertDialogTrigger asChild>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 rounded-lg text-muted-foreground/40 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                    </AlertDialogTrigger>
                    <TooltipContent>Clear conversation</TooltipContent>
                  </Tooltip>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Clear all messages?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will remove all messages in this conversation. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        size="sm"
                        onClick={() => activeSessionId && clearSessionMessages(activeSessionId)}
                      >
                        Clear
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}

              {/* Send / Stop button */}
              {isStreaming ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-8 rounded-lg px-3"
                      onClick={onStop}
                    >
                      <Square className="size-3.5 mr-1.5" />
                      Stop
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Stop (Esc)</TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      className="h-8 rounded-lg px-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-sm"
                      onClick={handleSend}
                      disabled={!text.trim() || disabled}
                    >
                      <span>Start</span>
                      <Send className="size-3.5 ml-1.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Send (Enter)</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
