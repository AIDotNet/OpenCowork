import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  ChevronsDownUp,
  Sparkles,
  Loader2,
  FileText,
  AlertCircle
} from 'lucide-react'
import { formatTokens } from '@renderer/lib/format-tokens'
import { useMemoizedTokens } from '@renderer/hooks/use-estimated-tokens'
import {
  writeImageBlobToClipboard,
  writeImageDataUrlToClipboard
} from '@renderer/lib/utils/image-clipboard'
import type {
  AIModelConfig,
  ContentBlock,
  MessageMeta,
  SelectedFileReadsMeta
} from '@renderer/lib/api/types'
import {
  ACCEPTED_IMAGE_TYPES,
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
import { useSkillsStore } from '@renderer/stores/skills-store'
import { cn } from '@renderer/lib/utils'
import { SystemCommandCard } from './SystemCommandCard'
import { SelectFileInlineText } from './SelectFileInlineText'

interface UserMessageProps {
  messageId: string
  content: string | ContentBlock[]
  meta?: MessageMeta
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
const SKILL_DIRECTIVE_RE = /^\s*\[Skill:\s*([^\]\n]+?)\s*\]\s*(?:\r?\n)?([\s\S]*)$/

interface UserSkillDirective {
  name: string
  body: string
}

function parseUserSkillDirective(text: string): UserSkillDirective | null {
  const match = SKILL_DIRECTIVE_RE.exec(text)
  if (!match) return null
  const name = match[1]?.trim()
  if (!name) return null
  return {
    name,
    body: (match[2] ?? '').trimStart()
  }
}

function serializeUserSkillDirective(name: string, body: string): string {
  const trimmedBody = body.trim()
  return trimmedBody ? `[Skill: ${name}]\n${trimmedBody}` : `[Skill: ${name}]`
}

function UserSkillBadge({ name }: { name: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <div className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
      <Sparkles className="size-3 shrink-0" />
      <span className="shrink-0 font-medium">{t('userMessage.skillLabel')}</span>
      <span className="min-w-0 truncate font-mono" title={name}>
        {name}
      </span>
    </div>
  )
}

function UserSelectedFileReadsView({
  reads
}: {
  reads?: SelectedFileReadsMeta
}): React.JSX.Element | null {
  const { t } = useTranslation('chat')
  const files = reads?.files ?? []
  if (files.length === 0) return null

  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <FileText className="size-3.5 shrink-0" />
        <span>{t('userMessage.selectedFileReadsTitle', { defaultValue: 'Read files' })}</span>
        <span className="rounded-md border border-border/60 bg-background/45 px-1.5 py-0.5 text-[10px] tabular-nums">
          {files.length}
        </span>
      </div>
      <div className="space-y-1">
        {files.map((file, index) => {
          const status = file.error
            ? t('userMessage.selectedFileReadFailed', { defaultValue: 'Read failed' })
            : file.truncated
              ? t('userMessage.selectedFileReadTruncated', {
                  count: file.lineCount,
                  maxLines: file.maxLines,
                  defaultValue: 'Read first {{count}} lines'
                })
              : t('userMessage.selectedFileReadLines', {
                  count: file.lineCount,
                  defaultValue: 'Read {{count}} lines'
                })

          return (
            <div
              key={`${file.path}-${index}`}
              className="flex min-w-0 items-center gap-2 rounded-md border border-border/50 bg-background/45 px-2 py-1.5"
              title={file.error || file.readPath || file.path}
            >
              {file.error ? (
                <AlertCircle className="size-3.5 shrink-0 text-amber-500" />
              ) : (
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-foreground/90">
                  {file.name}
                </div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {file.path}
                </div>
              </div>
              <span
                className={cn(
                  'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
                  file.error
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : file.truncated
                      ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
                      : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                )}
              >
                {status}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UserSkillEditControl({
  name,
  skills,
  loading,
  onChange,
  onOpen
}: {
  name: string
  skills: { name: string; description?: string }[]
  loading: boolean
  onChange: (name: string) => void
  onOpen: () => void | Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const selectedName = name.trim()

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (nextOpen) {
      void onOpen()
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {selectedName && (
        <div className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
          <Sparkles className="size-3 shrink-0" />
          <span className="shrink-0 font-medium">{t('userMessage.skillLabel')}</span>
          <span className="min-w-0 truncate font-mono" title={selectedName}>
            {selectedName}
          </span>
          <button
            type="button"
            aria-label={t('userMessage.removeSkill')}
            title={t('userMessage.removeSkill')}
            className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-emerald-700/70 transition-colors hover:bg-emerald-500/15 hover:text-emerald-900 dark:text-emerald-200/75 dark:hover:text-emerald-50"
            onClick={() => onChange('')}
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs">
            {loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Sparkles className="size-3" />
            )}
            {selectedName ? t('userMessage.changeSkill') : t('userMessage.addSkill')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>{t('userMessage.selectSkill')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {loading ? (
            <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              {t('skills.loadingSkills')}
            </div>
          ) : skills.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t('skills.noSkills')}
            </div>
          ) : (
            skills.map((skill) => (
              <DropdownMenuItem
                key={skill.name}
                className="flex flex-col items-start gap-1 py-2"
                onSelect={() => onChange(skill.name)}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
                  {skill.name === selectedName && <Check className="size-3.5 text-emerald-500" />}
                </span>
                {skill.description && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {skill.description}
                  </span>
                )}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

async function copyImageSourceToClipboard(src: string): Promise<void> {
  if (src.startsWith('data:')) {
    await writeImageDataUrlToClipboard(src)
    return
  }

  const response = await fetch(src)
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`)
  await writeImageBlobToClipboard(await response.blob())
}

async function copyImageAttachmentToClipboard(image: ImageAttachment): Promise<void> {
  await copyImageSourceToClipboard(image.dataUrl)
}

function UserImageAttachmentView({
  image,
  variant,
  onPreview,
  onRemove
}: {
  image: ImageAttachment
  variant: 'edit' | 'display'
  onPreview?: (src: string) => void
  onRemove?: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)

  const copyImage = useCallback(async (): Promise<void> => {
    try {
      await copyImageAttachmentToClipboard(image)
      setCopied(true)
      toast.success(t('userMessage.imageCopied'))
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('[UserMessage] Copy image failed:', error)
      toast.error(t('userMessage.copyImageFailed'))
    }
  }, [image, t])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        onPreview &&
        (event.key === 'Enter' || event.key === ' ')
      ) {
        event.preventDefault()
        onPreview(image.dataUrl)
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'c') return
      event.preventDefault()
      event.stopPropagation()
      void copyImage()
    },
    [copyImage, image.dataUrl, onPreview]
  )

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('userMessage.imageAttachment')}
      className={cn(
        'group/img relative shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring',
        variant === 'display' && 'cursor-zoom-in'
      )}
      onClick={() => onPreview?.(image.dataUrl)}
      onKeyDown={handleKeyDown}
      title={t('userMessage.copyImageShortcut')}
    >
      <img
        src={image.dataUrl}
        alt=""
        className={
          variant === 'edit'
            ? 'size-16 rounded-lg border border-border/60 object-cover shadow-sm'
            : 'max-h-[180px] max-w-[240px] rounded-lg border border-border/60 object-contain shadow-sm transition-shadow group-hover/img:shadow-md'
        }
      />
      <button
        type="button"
        className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md border border-border/50 bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover/img:opacity-100 group-focus-within/img:opacity-100"
        aria-label={copied ? t('userMessage.imageCopied') : t('userMessage.copyImage')}
        title={copied ? t('userMessage.imageCopied') : t('userMessage.copyImage')}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void copyImage()
        }}
      >
        {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
      </button>
      {onRemove && (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 shadow-md transition-opacity group-hover/img:opacity-100 group-focus-within/img:opacity-100"
          aria-label={t('userMessage.removeImage')}
          title={t('userMessage.removeImage')}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRemove(image.id)
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

export function UserMessage({
  messageId,
  content,
  meta,
  onEdit,
  onDelete
}: UserMessageProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const currentDraft = useMemo(() => extractEditableUserMessageDraft(content), [content])
  const plainText = currentDraft.text
  const allImages = currentDraft.images
  const command = currentDraft.command
  const skillDirective = useMemo(() => parseUserSkillDirective(plainText), [plainText])
  const displayText = skillDirective?.body ?? plainText
  const copyBodyText = selectFileTextToPlainText(displayText)
  const copyText = command
    ? `/${command.name}${copyBodyText ? ` ${copyBodyText}` : ''}`
    : skillDirective
      ? [`[Skill: ${skillDirective.name}]`, copyBodyText].filter(Boolean).join('\n')
      : copyBodyText

  const displayFullText = skillDirective ? displayText : plainText
  const memoizedTokens = useMemoizedTokens(displayFullText)

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
  const availableSkills = useSkillsStore((s) => s.skills)
  const skillsLoading = useSkillsStore((s) => s.loading)
  const loadSkills = useSkillsStore((s) => s.loadSkills)

  const [editing, setEditing] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [editText, setEditText] = useState(displayText)
  const [editSkillName, setEditSkillName] = useState(skillDirective?.name ?? '')
  const [editImages, setEditImages] = useState<ImageAttachment[]>(() =>
    cloneImageAttachments(allImages)
  )
  const [copied, setCopied] = useState(false)
  const [previewCopied, setPreviewCopied] = useState(false)
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.selectionStart = textareaRef.current.value.length
    }
  }, [editing])

  useEffect(() => {
    if (editing) {
      void loadSkills()
    }
  }, [editing, loadSkills])

  const nextDraft = useMemo<EditableUserMessageDraft>(() => {
    const skillName = editSkillName.trim()
    return {
      text: skillName ? serializeUserSkillDirective(skillName, editText) : editText.trim(),
      images: cloneImageAttachments(editImages),
      command
    }
  }, [command, editImages, editSkillName, editText])
  const canSave = hasEditableDraftContent(nextDraft)

  const handleStartEdit = (): void => {
    setEditText(displayText)
    setEditSkillName(skillDirective?.name ?? '')
    setEditImages(cloneImageAttachments(allImages))
    setEditing(true)
  }

  const handleSave = (): void => {
    if (!canSave || !onEdit) return
    onEdit(messageId, nextDraft)
    setEditing(false)
  }

  const handleCancel = (): void => {
    setEditText(displayText)
    setEditSkillName(skillDirective?.name ?? '')
    setEditImages(cloneImageAttachments(allImages))
    setEditing(false)
  }

  const handleCopy = useCallback((): void => {
    navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [copyText])

  const handleTranslate = useCallback((): void => {
    const text = displayText.trim()
    if (!text) return
    setTranslateSourceText(text)
    openTranslatePage()
    toast.success(t('messageActions.sentToTranslator'))
  }, [displayText, openTranslatePage, setTranslateSourceText, t])

  const handleSpeak = useCallback((): void => {
    const text = displayText.trim()
    if (!text) return
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      toast.error(t('messageActions.speechNotSupported'))
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }, [displayText, t])

  const handleShare = useCallback(async (): Promise<void> => {
    const text = displayText.trim()
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
  }, [displayText, t])

  const handleCopyPreviewImage = useCallback(async (): Promise<void> => {
    if (!previewImageSrc) return

    try {
      await copyImageSourceToClipboard(previewImageSrc)
      setPreviewCopied(true)
      toast.success(t('userMessage.imageCopied'))
      window.setTimeout(() => setPreviewCopied(false), 1500)
    } catch (error) {
      console.error('[UserMessage] Copy preview image failed:', error)
      toast.error(t('userMessage.copyImageFailed'))
    }
  }, [previewImageSrc, t])

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
            <UserSkillEditControl
              name={editSkillName}
              skills={availableSkills}
              loading={skillsLoading}
              onChange={setEditSkillName}
              onOpen={loadSkills}
            />
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
                  <UserImageAttachmentView
                    key={img.id}
                    image={img}
                    variant="edit"
                    onRemove={removeImage}
                  />
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
              {displayText.trim()
                ? displayText.trim()
                : skillDirective
                  ? `${t('userMessage.skillLabel')}: ${skillDirective.name}`
                  : t('messageActions.imagesCollapsed', {
                      count: allImages.length,
                      defaultValue: `${allImages.length} images`
                    })}
            </div>
          </div>
        ) : (
          <div className={`${USER_MESSAGE_BUBBLE_CLASS} ml-auto w-fit max-w-full`}>
            {command && <SystemCommandCard command={command} />}
            {skillDirective && <UserSkillBadge name={skillDirective.name} />}
            {displayText && (
              <div className="text-sm leading-relaxed">
                <SelectFileInlineText text={displayText} />
              </div>
            )}
            <UserSelectedFileReadsView reads={meta?.selectedFileReads} />
            {allImages.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {allImages.map((img) => (
                  <UserImageAttachmentView
                    key={img.id}
                    image={img}
                    variant="display"
                    onPreview={setPreviewImageSrc}
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
                <DialogTitle className="sr-only">{t('userMessage.imagePreview')}</DialogTitle>
                {previewImageSrc && (
                  <div
                    tabIndex={0}
                    className="relative flex max-w-full items-center justify-center overflow-hidden outline-none"
                    onKeyDown={(event) => {
                      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'c') {
                        return
                      }
                      event.preventDefault()
                      event.stopPropagation()
                      void handleCopyPreviewImage()
                    }}
                    title={t('userMessage.copyImageShortcut')}
                  >
                    <button
                      type="button"
                      className="absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-md border border-border/50 bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
                      aria-label={
                        previewCopied ? t('userMessage.imageCopied') : t('userMessage.copyImage')
                      }
                      title={
                        previewCopied ? t('userMessage.imageCopied') : t('userMessage.copyImage')
                      }
                      onClick={() => void handleCopyPreviewImage()}
                    >
                      {previewCopied ? (
                        <Check className="size-4 text-green-500" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                    </button>
                    <img
                      src={previewImageSrc}
                      alt={t('userMessage.imagePreview')}
                      className="block h-auto max-h-[calc(90vh-1rem)] w-auto max-w-[min(92vw,1068px)] rounded object-contain"
                    />
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </div>
        )}
        {!editing && displayText.length > 50 && (
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
                <DropdownMenuItem onSelect={handleTranslate} disabled={!displayText.trim()}>
                  <Languages className="size-4" />
                  {t('messageActions.translate')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleSpeak} disabled={!displayText.trim()}>
                  <Volume2 className="size-4" />
                  {t('messageActions.readAloud')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void handleShare()}
                  disabled={!displayText.trim()}
                >
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
