import { useState, useRef, useEffect } from 'react'
import { Avatar, AvatarFallback } from '@renderer/components/ui/avatar'
import { Button } from '@renderer/components/ui/button'
import { User, Pencil, Check, X, Copy } from 'lucide-react'

interface UserMessageProps {
  content: string
  isLast?: boolean
  onEdit?: (newContent: string) => void
}

export function UserMessage({ content, isLast, onEdit }: UserMessageProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(content)
  const [copied, setCopied] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.selectionStart = textareaRef.current.value.length
    }
  }, [editing])

  const handleSave = (): void => {
    const trimmed = editText.trim()
    if (trimmed && trimmed !== content && onEdit) {
      onEdit(trimmed)
    }
    setEditing(false)
  }

  const handleCancel = (): void => {
    setEditText(content)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      handleCancel()
    }
  }

  return (
    <div className="group/user flex gap-3">
      <Avatar className="size-7 shrink-0 ring-1 ring-border/50">
        <AvatarFallback className="bg-gradient-to-br from-primary to-primary/80 text-primary-foreground text-xs">
          <User className="size-3.5" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-sm font-medium">You</p>
          {!editing && (
            <span className="opacity-0 group-hover/user:opacity-100 transition-opacity flex items-center gap-0.5">
              <button
                onClick={() => { navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              {isLast && onEdit && (
                <button
                  onClick={() => { setEditText(content); setEditing(true) }}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors"
                >
                  <Pencil className="size-3" />
                  Edit
                </button>
              )}
            </span>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full min-h-[60px] rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              rows={Math.min(editText.split('\n').length + 1, 8)}
            />
            <div className="flex items-center gap-1.5">
              <Button size="sm" className="h-6 gap-1 px-2 text-xs" onClick={handleSave}>
                <Check className="size-3" />
                Save & Resend
              </Button>
              <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={handleCancel}>
                <X className="size-3" />
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-sm whitespace-pre-wrap leading-relaxed">{content}</div>
        )}
        {!editing && content.length > 50 && (
          <p className="mt-1 text-[10px] text-muted-foreground/0 group-hover/user:text-muted-foreground/40 transition-colors">
            {content.split(/\s+/).filter(Boolean).length} words · {content.length} chars
          </p>
        )}
      </div>
    </div>
  )
}
