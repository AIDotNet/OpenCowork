import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback } from '@renderer/components/ui/avatar'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import { User, Pencil, Check, X, Copy, ImagePlus } from 'lucide-react'
import { formatTokens } from '@renderer/lib/format-tokens'
import { useMemoizedTokens } from '@renderer/hooks/use-estimated-tokens'
import type { AIModelConfig, ContentBlock } from '@renderer/lib/api/types'
import {
  ACCEPTED_IMAGE_TYPES,
  areEditableUserMessageDraftsEqual,
  cloneImageAttachments,
  extractEditableUserMessageDraft,
  fileToImageAttachment,
  hasEditableDraftContent,
  type EditableUserMessageDraft,
  type ImageAttachment
} from '@renderer/lib/image-attachments'

interface UserMessageProps {
  content: string | ContentBlock[]
  isLast?: boolean
  onEdit?: (draft: EditableUserMessageDraft) => void
}

export function UserMessage({ content, isLast, onEdit }: UserMessageProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const currentDraft = useMemo(() => extractEditableUserMessageDraft(content), [content])
  const plainText = currentDraft.text
  const allImages = currentDraft.images

  const fullText =
    typeof content === 'string'
      ? content
      : content
          .filter(
            (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text'
          )
          .map((block) => block.text)
          .join('\n')
  const memoizedTokens = useMemoizedTokens(fullText)

  const activeProvider = useProviderStore((s) => {
    const { providers, activeProviderId } = s
    if (!activeProviderId) return null
    return providers.find((provider) => provider.id === activeProviderId) ?? null
  })
  const activeModelId = useProviderStore((s) => s.activeModelId)
  const supportsVision = useMemo(() => {
    if (!activeProvider) return false
    const model = activeProvider.models.find((item) => item.id === activeModelId)
    return modelSupportsVision(model as AIModelConfig | undefined, activeProvider.type)
  }, [activeModelId, activeProvider])

  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(plainText)
  const [editImages, setEditImages] = useState<ImageAttachment[]>(() =>
    cloneImageAttachments(allImages)
  )
  const [copied, setCopied] = useState(false)
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.selectionStart = textareaRef.current.value.length
    }
  }, [editing])

  const nextDraft = useMemo<EditableUserMessageDraft>(
    () => ({
      text: editText.trim(),
      images: cloneImageAttachments(editImages)
    }),
    [editImages, editText]
  )
  const canSave =
    hasEditableDraftContent(nextDraft) &&
    !areEditableUserMessageDraftsEqual(nextDraft, currentDraft)

  const handleStartEdit = (): void => {
    setEditText(plainText)
    setEditImages(cloneImageAttachments(allImages))
    setEditing(true)
  }

  const handleSave = (): void => {
    if (!canSave || !onEdit) return
    onEdit(nextDraft)
    setEditing(false)
  }

  const handleCancel = (): void => {
    setEditText(plainText)
    setEditImages(cloneImageAttachments(allImages))
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

  const addImages = async (files: File[]): Promise<void> => {
    const results = await Promise.all(files.map(fileToImageAttachment))
    const valid = results.filter(Boolean) as ImageAttachment[]
    if (valid.length > 0) {
      setEditImages((prev) => [...prev, ...valid])
    }
  }

  const removeImage = (id: string): void => {
    setEditImages((prev) => prev.filter((img) => img.id !== id))
  }

  return (
    <div className="group/user flex gap-3">
      <Avatar className="size-7 shrink-0 ring-1 ring-border/50">
        <AvatarFallback className="bg-gradient-to-br from-primary to-primary/80 text-primary-foreground text-xs">
          <User className="size-3.5" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="mb-1 flex items-center gap-2">
          <p className="text-sm font-medium">{t('userMessage.you')}</p>
          {!editing && (
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(plainText)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted-foreground/10"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? t('userMessage.copied') : t('action.copy', { ns: 'common' })}
              </button>
              {isLast && onEdit && (
                <button
                  onClick={handleStartEdit}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted-foreground/10"
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
              className="min-h-[60px] w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              rows={Math.min(editText.split('\n').length + 1, 8)}
            />
            {editImages.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {editImages.map((img) => (
                  <div key={img.id} className="relative group/img shrink-0">
                    <img
                      src={img.dataUrl}
                      alt=""
                      className="size-16 rounded-lg border border-border/60 object-cover shadow-sm"
                    />
                    <button
                      type="button"
                      className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-md opacity-0 transition-opacity group-hover/img:opacity-100"
                      onClick={() => removeImage(img.id)}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) {
                  void addImages(Array.from(e.target.files))
                }
                e.target.value = ''
              }}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {supportsVision && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus className="size-3" />
                  {t('input.attachImages')}
                </Button>
              )}
              <Button
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={handleSave}
                disabled={!canSave}
              >
                <Check className="size-3" />
                {t('userMessage.saveAndResend')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-xs"
                onClick={handleCancel}
              >
                <X className="size-3" />
                {t('action.cancel', { ns: 'common' })}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {allImages.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {allImages.map((img) => (
                  <img
                    key={img.id}
                    src={img.dataUrl}
                    alt=""
                    className="max-h-[180px] max-w-[240px] cursor-zoom-in rounded-lg border border-border/60 object-contain shadow-sm transition-shadow hover:shadow-md"
                    onClick={() => {
                      if (img.dataUrl) setPreviewImageSrc(img.dataUrl)
                    }}
                  />
                ))}
              </div>
            )}
            {plainText && (
              <div className="text-sm whitespace-pre-wrap leading-relaxed">{plainText}</div>
            )}

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
          <p className="mt-1 text-[10px] text-muted-foreground/0 transition-colors tabular-nums group-hover/user:text-muted-foreground/40">
            {formatTokens(memoizedTokens)} {t('unit.tokens', { ns: 'common' })}
          </p>
        )}
      </div>
    </div>
  )
}
