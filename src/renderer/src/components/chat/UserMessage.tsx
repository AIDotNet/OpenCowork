import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback } from '@renderer/components/ui/avatar'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { User, Pencil, Check, X, Copy } from 'lucide-react'
import { formatTokens } from '@renderer/lib/format-tokens'
import { useMemoizedTokens } from '@renderer/hooks/use-estimated-tokens'
import type { ImageBlock, ContentBlock } from '@renderer/lib/api/types'

interface UserMessageProps {
  content: string | ContentBlock[]
  images?: ImageBlock[]
  isLast?: boolean
  onEdit?: (newContent: string) => void
}

// Helper: Extract plain text from content, filtering out system-remind tags
function extractPlainText(content: string | ContentBlock[]): string {
  let text = ''
  
  if (typeof content === 'string') {
    text = content
  } else {
    // Extract text from ContentBlock[]
    text = content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }
  
  // Filter out <system-reminder>...</system-reminder> tags (also legacy <system-remind>)
  return text.replace(/<system-remind(?:er)?>[\s\S]*?<\/system-remind(?:er)?>\s*/g, '').trim()
}

// Helper: Extract images from ContentBlock[]
function extractImages(content: string | ContentBlock[]): ImageBlock[] {
  if (typeof content === 'string') return []
  return content.filter((block): block is ImageBlock => block.type === 'image')
}

export function UserMessage({ content, images, isLast, onEdit }: UserMessageProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const plainText = extractPlainText(content)
  const contentImages = extractImages(content)
  const allImages = [...(images || []), ...contentImages]
  
  // Token count should reflect actual content sent to LLM (including system-remind)
  const fullText = typeof content === 'string' 
    ? content 
    : content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  const memoizedTokens = useMemoizedTokens(fullText)
  
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(plainText)
  const [copied, setCopied] = useState(false)
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.selectionStart = textareaRef.current.value.length
    }
  }, [editing])

  const handleSave = (): void => {
    const trimmed = editText.trim()
    if (trimmed && trimmed !== plainText && onEdit) {
      onEdit(trimmed)
    }
    setEditing(false)
  }

  const handleCancel = (): void => {
    setEditText(plainText)
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
          <p className="text-sm font-medium">{t('userMessage.you')}</p>
          {!editing && (
            <span className="opacity-0 group-hover/user:opacity-100 transition-opacity flex items-center gap-0.5">
              <button
                onClick={() => { navigator.clipboard.writeText(plainText); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? t('userMessage.copied') : t('action.copy', { ns: 'common' })}
              </button>
              {isLast && onEdit && (
                <button
                  onClick={() => { setEditText(plainText); setEditing(true) }}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted-foreground/10 transition-colors"
                >
                  <Pencil className="size-3" />
                  {t('userMessage.edit')}
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
                {t('userMessage.saveAndResend')}
              </Button>
              <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={handleCancel}>
                <X className="size-3" />
                {t('action.cancel', { ns: 'common' })}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {allImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {allImages.map((img, idx) => {
                  const src = img.source.type === 'base64'
                    ? `data:${img.source.mediaType || 'image/png'};base64,${img.source.data}`
                    : img.source.url || ''
                  return (
                    <img
                      key={idx}
                      src={src}
                      alt=""
                      className="max-w-[240px] max-h-[180px] rounded-lg border border-border/60 shadow-sm object-contain cursor-zoom-in hover:shadow-md transition-shadow"
                      onClick={() => {
                        if (src) setPreviewImageSrc(src)
                      }}
                    />
                  )
                })}
              </div>
            )}
            {plainText && <div className="text-sm whitespace-pre-wrap leading-relaxed">{plainText}</div>}

            <Dialog
              open={Boolean(previewImageSrc)}
              onOpenChange={(open) => {
                if (!open) setPreviewImageSrc(null)
              }}
            >
              <DialogContent className="w-auto max-w-[min(96vw,1100px)] p-2">
                <DialogTitle className="sr-only">Image preview</DialogTitle>
                {previewImageSrc && (
                  <img
                    src={previewImageSrc}
                    alt="Image preview"
                    className="max-h-[85vh] max-w-[92vw] rounded object-contain"
                  />
                )}
              </DialogContent>
            </Dialog>
          </>
        )}
        {!editing && plainText.length > 50 && (
          <p className="mt-1 text-[10px] text-muted-foreground/0 group-hover/user:text-muted-foreground/40 transition-colors tabular-nums">
            {formatTokens(memoizedTokens)} {t('unit.tokens', { ns: 'common' })}
          </p>
        )}
      </div>
    </div>
  )
}
