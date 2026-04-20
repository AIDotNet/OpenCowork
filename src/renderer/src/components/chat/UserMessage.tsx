import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useProviderStore, modelSupportsVision } from '@renderer/stores/provider-store'
import {
  Pencil,
  Check,
  X,
  Copy,
  ImagePlus,
  Trash2,
  Ellipsis,
  Languages,
  Volume2,
  Share2,
  ChevronsUpDown,
  ChevronsDownUp
} from 'lucide-react'
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
import { selectFileTextToPlainText } from '@renderer/lib/select-file-tags'
import { useTranslateStore } from '@renderer/stores/translate-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { SystemCommandCard } from './SystemCommandCard'
import { SelectFileInlineText } from './SelectFileInlineText'

interface UserMessageProps {
  messageId: string
  content: string | ContentBlock[]
  isLast?: boolean
  onEdit?: (messageId: string, draft: EditableUserMessageDraft) => void
  onDelete?: (messageId: string) => void
}

function ActionIconButton({
  label,
  icon,
  onClick,
  danger = false
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={`flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/80 text-muted-foreground transition-colors hover:bg-muted/80 ${danger ? 'hover:text-destructive' : 'hover:text-foreground'}`}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

const USER_MESSAGE_WIDTH_CLASS = 'w-full max-w-[min(82%,42rem)]'
const USER_MESSAGE_BUBBLE_CLASS =
  'rounded-[18px] border border-border/60 bg-muted/35 px-4 py-3 text-sm text-foreground shadow-sm dark:bg-muted/70'

export function UserMessage({
  messageId,
  content,
  onEdit,
  onDelete
}: UserMessageProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const currentDraft = useMemo(() => extractEditableUserMessageDraft(content), [content])
  const plainText = currentDraft.text
  const allImages = currentDraft.images
  const command = currentDraft.command
  const copyText = command
    ? `/${command.name}${plainText ? ` ${selectFileTextToPlainText(plainText)}` : ''}`
    : selectFileTextToPlainText(plainText)

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
  const openTranslatePage = useUIStore((s) => s.openTranslatePage)
  const setTranslateSourceText = useTranslateStore((s) => s.setSourceText)

  const [editing, setEditing] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
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
      images: cloneImageAttachments(editImages),
      command
    }),
    [command, editImages, editText]
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
    onEdit(messageId, nextDraft)
    setEditing(false)
  }

  const handleCancel = (): void => {
    setEditText(plainText)
    setEditImages(cloneImageAttachments(allImages))
    setEditing(false)
  }

  const handleCopy = useCallback((): void => {
    navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [copyText])

  const handleTranslate = useCallback((): void => {
    const text = plainText.trim()
    if (!text) return
    setTranslateSourceText(text)
    openTranslatePage()
    toast.success(t('messageActions.sentToTranslator'))
  }, [openTranslatePage, plainText, setTranslateSourceText, t])

  const handleSpeak = useCallback((): void => {
    const text = plainText.trim()
    if (!text) return
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      toast.error(t('messageActions.speechNotSupported'))
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }, [plainText, t])

  const handleShare = useCallback(async (): Promise<void> => {
    const text = plainText.trim()
    if (!text) return
    try {
      if (navigator.share) {
        await navigator.share({ text })
        return
      }
      await navigator.clipboard.writeText(text)
      toast.success(t('messageActions.copiedForShare'))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      toast.error(t('messageActions.shareFailed'))
    }
  }, [plainText, t])

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
    <div className="group/user flex flex-col items-end">
      <div className={USER_MESSAGE_WIDTH_CLASS}>
        {editing ? (
          <div className={`${USER_MESSAGE_BUBBLE_CLASS} space-y-2`}>
            {command && (
              <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs text-violet-700 dark:text-violet-300">
                <span className="font-medium">/{command.name}</span>
              </div>
            )}
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
        ) : collapsed ? (
          <div
            className={`${USER_MESSAGE_BUBBLE_CLASS} ml-auto w-fit max-w-full text-xs text-muted-foreground`}
          >
            <div className="max-h-10 overflow-hidden whitespace-pre-wrap break-words">
              {plainText.trim()
                ? plainText.trim()
                : t('messageActions.imagesCollapsed', {
                    count: allImages.length,
                    defaultValue: `${allImages.length} 张图片`
                  })}
            </div>
          </div>
        ) : (
          <div className={`${USER_MESSAGE_BUBBLE_CLASS} ml-auto w-fit max-w-full`}>
            {command && <SystemCommandCard command={command} />}
            {plainText && (
              <div className="text-sm leading-relaxed">
                <SelectFileInlineText text={plainText} />
              </div>
            )}
            {allImages.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
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

            <Dialog
              open={Boolean(previewImageSrc)}
              onOpenChange={(open) => {
                if (!open) setPreviewImageSrc(null)
              }}
            >
              <DialogContent className="max-h-[90vh] !w-fit !max-w-[min(96vw,1100px)] overflow-hidden p-2 sm:!max-w-[min(96vw,1100px)]">
                <DialogTitle className="sr-only">Image preview</DialogTitle>
                {previewImageSrc && (
                  <div className="flex max-w-full items-center justify-center overflow-hidden">
                    <img
                      src={previewImageSrc}
                      alt="Image preview"
                      className="block h-auto max-h-[calc(90vh-1rem)] w-auto max-w-[min(92vw,1068px)] rounded object-contain"
                    />
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </div>
        )}
        {!editing && plainText.length > 50 && (
          <p className="mt-1 pr-1 text-right text-[10px] text-muted-foreground/0 transition-colors tabular-nums group-hover/user:text-muted-foreground/40">
            {formatTokens(memoizedTokens)} {t('unit.tokens', { ns: 'common' })}
          </p>
        )}
        {!editing && (
          <div className="mt-2 flex w-full items-center justify-end gap-1 opacity-0 transition-opacity group-hover/user:opacity-100">
            <ActionIconButton
              label={copied ? t('userMessage.copied') : t('action.copy', { ns: 'common' })}
              icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              onClick={handleCopy}
            />
            {onEdit && (
              <ActionIconButton
                label={t('userMessage.edit')}
                icon={<Pencil className="size-3.5" />}
                onClick={handleStartEdit}
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('action.showMore', { ns: 'common' })}
                  title={t('action.showMore', { ns: 'common' })}
                  className="flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/80 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                >
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={handleCopy}>
                  <Copy className="size-4" />
                  {t('action.copy', { ns: 'common' })}
                </DropdownMenuItem>
                {onEdit && (
                  <DropdownMenuItem onSelect={handleStartEdit}>
                    <Pencil className="size-4" />
                    {t('userMessage.edit')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={handleTranslate} disabled={!plainText.trim()}>
                  <Languages className="size-4" />
                  {t('messageActions.translate')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleSpeak} disabled={!plainText.trim()}>
                  <Volume2 className="size-4" />
                  {t('messageActions.readAloud')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleShare()} disabled={!plainText.trim()}>
                  <Share2 className="size-4" />
                  {t('messageActions.share')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setCollapsed((value) => !value)}>
                  {collapsed ? (
                    <ChevronsDownUp className="size-4" />
                  ) : (
                    <ChevronsUpDown className="size-4" />
                  )}
                  {collapsed ? t('messageActions.expand') : t('messageActions.collapse')}
                </DropdownMenuItem>
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => onDelete(messageId)}>
                      <Trash2 className="size-4" />
                      {t('action.delete', { ns: 'common' })}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  )
}
