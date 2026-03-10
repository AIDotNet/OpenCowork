import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent
} from 'react'
import { nanoid } from 'nanoid'
import {
  ArrowLeft,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Settings,
  Sparkles,
  Square,
  Trash2,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Textarea } from '@renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ImageGenerationErrorCard } from '@renderer/components/chat/ImageGenerationErrorCard'
import { ImagePreview } from '@renderer/components/chat/ImagePreview'
import { ModelIcon, ProviderIcon } from '@renderer/components/settings/provider-icons'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { createProvider } from '@renderer/lib/api/provider'
import type {
  AIModelConfig,
  AIProvider,
  ContentBlock,
  ProviderConfig,
  StreamEvent,
  UnifiedMessage
} from '@renderer/lib/api/types'
import {
  ACCEPTED_IMAGE_TYPES,
  fileToImageAttachment,
  imageAttachmentToContentBlock,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import { optimizeDrawPrompt } from '@renderer/lib/draw-prompt-optimizer'
import {
  clearPersistedDrawRuns,
  deletePersistedDrawRun,
  listPersistedDrawRuns,
  savePersistedDrawRun,
  type DrawRun,
  type DrawRunImage
} from '@renderer/lib/draw-history'
import { cn } from '@renderer/lib/utils'
import { modelSupportsVision, useProviderStore } from '@renderer/stores/provider-store'
import { useUIStore } from '@renderer/stores/ui-store'

interface ProviderModelGroup {
  provider: AIProvider
  models: AIModelConfig[]
}

function toOptionValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

function fromOptionValue(value: string): { providerId: string; modelId: string } {
  const separatorIndex = value.indexOf('::')
  if (separatorIndex === -1) {
    return { providerId: '', modelId: '' }
  }

  return {
    providerId: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 2)
  }
}

function normalizeImageSrc(event: StreamEvent): DrawRunImage | null {
  const imageBlock = event.imageBlock
  if (!imageBlock) return null

  const src =
    imageBlock.source.type === 'base64'
      ? `data:${imageBlock.source.mediaType || 'image/png'};base64,${imageBlock.source.data}`
      : (imageBlock.source.url ?? '')

  if (!src) return null

  return {
    id: nanoid(),
    src,
    mediaType: imageBlock.source.mediaType
  }
}

function pickFastTextModel(
  providers: AIProvider[]
): { provider: AIProvider; model: AIModelConfig; config: ProviderConfig } | null {
  const enabledProviders = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.models.some((model) => model.enabled && (model.category ?? 'chat') === 'chat')
  )

  const provider =
    enabledProviders.find((candidate) =>
      candidate.models.some(
        (model) =>
          model.enabled &&
          (model.category ?? 'chat') === 'chat' &&
          (model.id.includes('haiku') ||
            model.id.includes('4o-mini') ||
            model.id.includes('gpt-4o-mini'))
      )
    ) ?? enabledProviders[0]

  if (!provider) return null

  const model =
    provider.models.find(
      (candidate) =>
        candidate.enabled &&
        (candidate.category ?? 'chat') === 'chat' &&
        (candidate.id.includes('haiku') ||
          candidate.id.includes('4o-mini') ||
          candidate.id.includes('gpt-4o-mini'))
    ) ??
    provider.models.find(
      (candidate) => candidate.enabled && (candidate.category ?? 'chat') === 'chat'
    )

  if (!model) return null

  const config = useProviderStore.getState().getProviderConfigById(provider.id, model.id)
  if (!config) return null

  return { provider, model, config }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function DrawPage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const closeDrawPage = useUIStore((state) => state.closeDrawPage)
  const openSettingsPage = useUIStore((state) => state.openSettingsPage)

  const providers = useProviderStore((state) => state.providers)
  const activeImageProviderId = useProviderStore((state) => state.activeImageProviderId)
  const activeImageModelId = useProviderStore((state) => state.activeImageModelId)
  const setActiveImageProvider = useProviderStore((state) => state.setActiveImageProvider)
  const setActiveImageModel = useProviderStore((state) => state.setActiveImageModel)

  const [prompt, setPrompt] = useState('')
  const [runs, setRuns] = useState<DrawRun[]>([])
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false)
  const [optimizedPrompt, setOptimizedPrompt] = useState('')
  const [optimizationDialogOpen, setOptimizationDialogOpen] = useState(false)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [dialogProviderId, setDialogProviderId] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const providerModelGroups = useMemo<ProviderModelGroup[]>(
    () =>
      providers
        .map((provider) => ({
          provider,
          models: provider.models.filter((model) => (model.category ?? 'chat') === 'image')
        }))
        .filter((group) => group.models.length > 0),
    [providers]
  )

  const imageModelCount = useMemo(
    () => providerModelGroups.reduce((count, group) => count + group.models.length, 0),
    [providerModelGroups]
  )

  const selectedGroup = useMemo(
    () => providerModelGroups.find((group) => group.provider.id === activeImageProviderId) ?? null,
    [providerModelGroups, activeImageProviderId]
  )

  const selectedProvider = selectedGroup?.provider ?? providerModelGroups[0]?.provider ?? null
  const selectedModel =
    selectedGroup?.models.find((model) => model.id === activeImageModelId) ??
    selectedGroup?.models[0] ??
    providerModelGroups[0]?.models[0] ??
    null

  useEffect(() => {
    const firstGroup = providerModelGroups[0]
    const firstModel = firstGroup?.models[0]
    if (!firstGroup || !firstModel) return

    if (!selectedGroup) {
      setActiveImageProvider(firstGroup.provider.id)
      setActiveImageModel(firstModel.id)
      return
    }

    if (!selectedModel) {
      setActiveImageModel(selectedGroup.models[0].id)
    }
  }, [
    providerModelGroups,
    selectedGroup,
    selectedModel,
    setActiveImageModel,
    setActiveImageProvider
  ])

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void listPersistedDrawRuns(t('drawPage.interrupted'))
      .then((persistedRuns) => {
        if (!cancelled) {
          setRuns(persistedRuns)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [t])

  useEffect(() => {
    if (!modelDialogOpen) return
    setDialogProviderId(selectedProvider?.id ?? providerModelGroups[0]?.provider.id ?? null)
  }, [modelDialogOpen, providerModelGroups, selectedProvider])

  const addImages = useCallback(async (files: File[]): Promise<void> => {
    const results = await Promise.all(files.map(fileToImageAttachment))
    const valid = results.filter(Boolean) as ImageAttachment[]
    if (valid.length > 0) {
      setAttachedImages([valid[0]])
    }
  }, [])

  const persistRun = useCallback((run: DrawRun): void => {
    void savePersistedDrawRun(run)
  }, [])

  const updateRun = useCallback(
    (runId: string, updater: (run: DrawRun) => DrawRun): void => {
      let nextRun: DrawRun | null = null

      setRuns((current) =>
        current.map((run) => {
          if (run.id !== runId) return run
          nextRun = updater(run)
          return nextRun
        })
      )

      if (nextRun) {
        persistRun(nextRun)
      }
    },
    [persistRun]
  )

  const finishRun = useCallback(
    (runId: string): void => {
      updateRun(runId, (run) => ({
        ...run,
        isGenerating: false,
        error:
          run.error || run.images.length > 0
            ? run.error
            : {
                code: 'unknown',
                message: t('drawPage.noImageOutput')
              }
      }))
    },
    [t, updateRun]
  )

  const handleStop = useCallback((): void => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
  }, [])

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>): void => {
      const imageFiles = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === 'file' && ACCEPTED_IMAGE_TYPES.includes(item.type))
        .map((item) => item.getAsFile())
        .filter(Boolean) as File[]

      if (imageFiles.length > 0) {
        event.preventDefault()
        void addImages(imageFiles)
      }
    },
    [addImages]
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLTextAreaElement>): void => {
      const files = Array.from(event.dataTransfer.files ?? [])
      const imageFiles = files.filter((file) => ACCEPTED_IMAGE_TYPES.includes(file.type))

      if (imageFiles.length > 0) {
        event.preventDefault()
        void addImages(imageFiles)
      }
    },
    [addImages]
  )

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const files = Array.from(event.target.files ?? [])
      if (files.length > 0) {
        void addImages(files)
      }
      event.target.value = ''
    },
    [addImages]
  )

  const handleRemoveAttachedImage = useCallback((imageId: string): void => {
    setAttachedImages((current) => current.filter((image) => image.id !== imageId))
  }, [])

  const handleDeleteRun = useCallback((runId: string): void => {
    setRuns((current) => current.filter((run) => run.id !== runId))
    void deletePersistedDrawRun(runId)
  }, [])

  const handleClearHistory = useCallback((): void => {
    setRuns([])
    void clearPersistedDrawRuns()
  }, [])

  const handleSelectModel = useCallback(
    (value: string): void => {
      const { providerId, modelId } = fromOptionValue(value)
      if (!providerId || !modelId) return
      setActiveImageProvider(providerId)
      setActiveImageModel(modelId)
      setModelDialogOpen(false)
    },
    [setActiveImageModel, setActiveImageProvider]
  )

  const handleOptimizePrompt = useCallback(async (): Promise<void> => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || isGenerating || isOptimizingPrompt) return

    const fastTarget = pickFastTextModel(providers)
    if (!fastTarget) {
      toast.error(t('drawPage.optimizeUnavailable'))
      return
    }

    setIsOptimizingPrompt(true)
    setOptimizedPrompt('')

    try {
      const optimizeImages = modelSupportsVision(fastTarget.model, fastTarget.provider.type)
        ? attachedImages
        : []
      const result = await optimizeDrawPrompt(trimmedPrompt, fastTarget.config, optimizeImages)
      setOptimizedPrompt(result.prompt)
      setOptimizationDialogOpen(true)
    } catch (error) {
      toast.error(t('drawPage.optimizeFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setIsOptimizingPrompt(false)
    }
  }, [attachedImages, isGenerating, isOptimizingPrompt, prompt, providers, t])

  const handleUseOptimizedPrompt = useCallback((): void => {
    if (!optimizedPrompt.trim()) return
    setPrompt(optimizedPrompt)
    setOptimizationDialogOpen(false)
  }, [optimizedPrompt])

  const handleOptimizationDialogChange = useCallback((open: boolean): void => {
    setOptimizationDialogOpen(open)
    if (!open) {
      setOptimizedPrompt('')
    }
  }, [])

  const handleGenerate = useCallback(async (): Promise<void> => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) return
    if (!selectedProvider || !selectedModel) return

    if (!selectedProvider.enabled) {
      toast.error(t('drawPage.providerDisabled'))
      return
    }

    if (!selectedModel.enabled) {
      toast.error(t('drawPage.modelDisabled'))
      return
    }

    const ready = await ensureProviderAuthReady(selectedProvider.id)
    if (!ready) {
      toast.error(t('drawPage.authRequired'), {
        action: {
          label: t('drawPage.openProviderSettings'),
          onClick: () => openSettingsPage('provider')
        }
      })
      return
    }

    const providerConfig = useProviderStore
      .getState()
      .getProviderConfigById(selectedProvider.id, selectedModel.id)
    if (!providerConfig) {
      toast.error(t('drawPage.noModel'))
      return
    }

    const runId = nanoid()
    const createdAt = Date.now()
    const controller = new AbortController()
    const newRun: DrawRun = {
      id: runId,
      prompt: trimmedPrompt,
      providerName: selectedProvider.name,
      modelName: selectedModel.name,
      createdAt,
      isGenerating: true,
      images: [],
      error: null
    }

    abortControllerRef.current = controller
    setIsGenerating(true)
    setRuns((current) => [newRun, ...current])
    persistRun(newRun)

    const provider = createProvider(providerConfig)
    const content: string | ContentBlock[] =
      attachedImages.length > 0
        ? [
            ...attachedImages.map(imageAttachmentToContentBlock),
            {
              type: 'text',
              text: trimmedPrompt
            }
          ]
        : trimmedPrompt

    const messages: UnifiedMessage[] = [
      {
        id: nanoid(),
        role: 'user',
        content,
        createdAt: Date.now()
      }
    ]

    try {
      for await (const event of provider.sendMessage(
        messages,
        [],
        providerConfig,
        controller.signal
      )) {
        switch (event.type) {
          case 'image_generated': {
            const image = normalizeImageSrc(event)
            if (!image) break
            updateRun(runId, (run) => ({
              ...run,
              images: [...run.images, image],
              error: null
            }))
            break
          }
          case 'image_error': {
            const imageError = event.imageError
            if (!imageError) break
            updateRun(runId, (run) => ({
              ...run,
              error: {
                code: imageError.code,
                message: imageError.message
              }
            }))
            break
          }
          case 'error': {
            updateRun(runId, (run) => ({
              ...run,
              error: {
                code: 'unknown',
                message: event.error?.message || t('drawPage.unknownError')
              }
            }))
            break
          }
          case 'message_end': {
            finishRun(runId)
            break
          }
          default:
            break
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        updateRun(runId, (run) => ({
          ...run,
          error: {
            code: 'unknown',
            message: error instanceof Error ? error.message : String(error)
          }
        }))
      }
    } finally {
      finishRun(runId)
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
      setIsGenerating(false)
    }
  }, [
    attachedImages,
    finishRun,
    openSettingsPage,
    persistRun,
    prompt,
    selectedModel,
    selectedProvider,
    t,
    updateRun
  ])

  const canGenerate =
    !!prompt.trim() &&
    !!selectedProvider &&
    !!selectedModel &&
    !isGenerating &&
    providerModelGroups.length > 0

  const canOptimizePrompt = !!prompt.trim() && !isGenerating && !isOptimizingPrompt

  const selectedOptionValue =
    selectedProvider && selectedModel
      ? toOptionValue(selectedProvider.id, selectedModel.id)
      : undefined

  const dialogGroup =
    providerModelGroups.find((group) => group.provider.id === dialogProviderId) ??
    selectedGroup ??
    providerModelGroups[0] ??
    null

  if (providerModelGroups.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <div className="flex items-center gap-3 border-b px-4 py-2.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={closeDrawPage}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <ArrowLeft className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t('drawPage.back')}</TooltipContent>
          </Tooltip>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{t('drawPage.title')}</h1>
            <p className="truncate text-xs text-muted-foreground">{t('drawPage.subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-dashed border-border/70 bg-card/40 p-6 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <ImageIcon className="size-6" />
            </div>
            <h2 className="mt-4 text-base font-semibold">{t('drawPage.noModels')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('drawPage.noModelsDesc')}</p>
            <Button className="mt-4 gap-2" onClick={() => openSettingsPage('provider')}>
              <Settings className="size-4" />
              {t('drawPage.openProviderSettings')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-3 border-b px-4 py-2.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={closeDrawPage}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('drawPage.back')}</TooltipContent>
        </Tooltip>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{t('drawPage.title')}</h1>
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {t('drawPage.modelsLoaded', { count: imageModelCount })}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">{t('drawPage.subtitle')}</p>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => openSettingsPage('provider')}
        >
          <Settings className="size-3.5" />
          {t('drawPage.openProviderSettings')}
        </Button>
      </div>

      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4 md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-col gap-4 md:w-[500px] md:shrink-0 md:overflow-hidden lg:w-[560px]">
          <div className="flex min-h-0 flex-col rounded-2xl border bg-card/50 p-4 shadow-sm md:flex-1 md:overflow-hidden">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">{t('drawPage.promptSection')}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('drawPage.promptSectionDesc')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {prompt.trim().length}
                </Badge>
                <Button
                  variant="outline"
                  size="icon-xs"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label={t('drawPage.addImage')}
                  title={t('drawPage.addImage')}
                >
                  <ImagePlus className="size-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => void handleOptimizePrompt()}
                  disabled={!canOptimizePrompt}
                >
                  {isOptimizingPrompt ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  {t('drawPage.optimizePrompt')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 max-w-[190px] gap-1 px-2 text-xs"
                  onClick={() => setModelDialogOpen(true)}
                >
                  {selectedModel && <ModelIcon icon={selectedModel.icon} size={12} />}
                  <span className="truncate text-[11px]">{selectedModel?.name}</span>
                </Button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              {selectedProvider && (
                <ProviderIcon builtinId={selectedProvider.builtinId} size={14} />
              )}
              <span className="truncate">{selectedProvider?.name}</span>
              <span className="text-muted-foreground/40">/</span>
              {selectedModel && <ModelIcon icon={selectedModel.icon} size={14} />}
              <span className="truncate">{selectedModel?.name}</span>
            </div>

            {attachedImages.length > 0 && (
              <div className="mt-4 flex shrink-0 flex-wrap gap-2">
                {attachedImages.map((image) => (
                  <div
                    key={image.id}
                    className="group relative size-16 overflow-hidden rounded-lg border bg-background/60"
                  >
                    <img src={image.dataUrl} alt="" className="size-full object-cover" />
                    <Button
                      variant="secondary"
                      size="icon-xs"
                      className="absolute top-1 right-1 opacity-100 shadow-sm md:opacity-0 md:transition-opacity md:group-hover:opacity-100"
                      onClick={() => handleRemoveAttachedImage(image.id)}
                      aria-label={t('drawPage.removeImage')}
                      title={t('drawPage.removeImage')}
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('Files')) {
                  event.preventDefault()
                }
              }}
              placeholder={t('drawPage.promptPlaceholder')}
              className="mt-4 min-h-[260px] resize-none overflow-y-auto [field-sizing:fixed] md:min-h-0 md:flex-1"
            />

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              className="hidden"
              onChange={handleFileInputChange}
            />

            <p className="mt-3 shrink-0 text-xs leading-relaxed text-muted-foreground">
              {t('drawPage.promptHint')}
            </p>
            <p className="mt-1 shrink-0 text-xs leading-relaxed text-muted-foreground">
              {t('drawPage.pasteImageHint')}
            </p>

            <div className="mt-4 flex shrink-0 items-center gap-2">
              <Button
                onClick={() => void handleGenerate()}
                disabled={!canGenerate}
                className="flex-1 gap-2"
              >
                {isGenerating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {isGenerating ? t('drawPage.generating') : t('drawPage.generate')}
              </Button>
              <Button
                variant="outline"
                onClick={isGenerating ? handleStop : () => setPrompt('')}
                className="gap-2"
              >
                {isGenerating ? <Square className="size-4" /> : <Trash2 className="size-4" />}
                {isGenerating ? t('drawPage.stop') : t('drawPage.clearPrompt')}
              </Button>
            </div>
          </div>

          <Dialog open={optimizationDialogOpen} onOpenChange={handleOptimizationDialogChange}>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle className="text-sm">{t('drawPage.optimizePrompt')}</DialogTitle>
                <DialogDescription className="text-xs">
                  {t('drawPage.optimizePromptDesc')}
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[50vh] overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm leading-6 whitespace-pre-wrap">
                {optimizedPrompt}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => handleOptimizationDialogChange(false)}>
                  {t('drawPage.cancelOptimize')}
                </Button>
                <Button onClick={handleUseOptimizedPrompt} disabled={!optimizedPrompt.trim()}>
                  {t('drawPage.useOptimizedPrompt')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
            <DialogContent className="h-[min(85vh,720px)] max-h-[85vh] grid-rows-[auto,minmax(0,1fr)] overflow-hidden p-4 sm:max-w-2xl">
              <DialogHeader className="pr-8">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <DialogTitle className="text-sm">{t('drawPage.modelSection')}</DialogTitle>
                    <DialogDescription className="mt-1 text-xs">
                      {t('drawPage.modelSectionDesc')}
                    </DialogDescription>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    {t('drawPage.modelsLoaded', { count: imageModelCount })}
                  </Badge>
                </div>
              </DialogHeader>

              <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-background/50 p-3">
                <div className="shrink-0 border-b pb-3">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    {t('drawPage.providerSection')}
                  </div>
                  <div className="flex items-center gap-2">
                    {dialogGroup && (
                      <ProviderIcon builtinId={dialogGroup.provider.builtinId} size={16} />
                    )}
                    <Select
                      value={dialogGroup?.provider.id ?? ''}
                      onValueChange={(value) => setDialogProviderId(value)}
                    >
                      <SelectTrigger className="w-full min-w-0 text-sm">
                        <SelectValue placeholder={t('drawPage.selectProvider')} />
                      </SelectTrigger>
                      <SelectContent align="start" className="max-h-80">
                        {providerModelGroups.map((group) => (
                          <SelectItem key={group.provider.id} value={group.provider.id}>
                            <span className="flex min-w-0 items-center gap-2">
                              <ProviderIcon builtinId={group.provider.builtinId} size={16} />
                              <span className="truncate">{group.provider.name}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Badge
                      variant={dialogGroup?.provider.enabled ? 'secondary' : 'outline'}
                      className="text-[10px]"
                    >
                      {dialogGroup?.provider.enabled
                        ? t('drawPage.providerEnabled')
                        : t('drawPage.providerDisabledBadge')}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {dialogGroup?.models.length ?? 0}
                    </Badge>
                  </div>
                </div>

                <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-xs font-medium text-muted-foreground">
                      {t('drawPage.selectModel')}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {dialogGroup?.provider.name}
                    </span>
                  </div>

                  <div className="flex-1 min-h-0 space-y-2 overflow-y-auto pr-1">
                    {dialogGroup?.models.map((model) => {
                      const optionValue = toOptionValue(dialogGroup.provider.id, model.id)
                      const isSelected = optionValue === selectedOptionValue

                      return (
                        <button
                          key={optionValue}
                          type="button"
                          onClick={() => handleSelectModel(optionValue)}
                          className={cn(
                            'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                            isSelected
                              ? 'border-primary bg-primary/5'
                              : 'border-transparent hover:border-border hover:bg-muted/50'
                          )}
                        >
                          <div className="min-w-0 flex items-center gap-2">
                            <ModelIcon icon={model.icon} size={16} />
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{model.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {model.type || dialogGroup.provider.type}
                              </div>
                            </div>
                          </div>
                          <Badge
                            variant={model.enabled ? 'secondary' : 'outline'}
                            className="text-[10px]"
                          >
                            {model.enabled
                              ? t('drawPage.modelEnabled')
                              : t('drawPage.modelDisabledBadge')}
                          </Badge>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <div className="flex min-h-[420px] min-w-0 flex-1 flex-col rounded-2xl border bg-card/50 shadow-sm md:min-h-0">
          <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
            <div>
              <h2 className="text-sm font-semibold">{t('drawPage.resultSection')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('drawPage.resultSectionDesc')}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={handleClearHistory}
              disabled={runs.length === 0 || isGenerating}
            >
              <Trash2 className="size-3.5" />
              {t('drawPage.clearHistory')}
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {runs.length === 0 ? (
              <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border/70 bg-background/40 p-8 text-center">
                <div className="max-w-sm">
                  <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <ImageIcon className="size-6" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold">{t('drawPage.emptyTitle')}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{t('drawPage.emptyDesc')}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {runs.map((run) => (
                  <div key={run.id} className="rounded-2xl border bg-background/70 p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-relaxed">{run.prompt}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <Badge variant="secondary" className="text-[10px] font-normal">
                            {run.providerName}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] font-normal">
                            {run.modelName}
                          </Badge>
                          <span>{formatTime(run.createdAt)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div
                          className={cn(
                            'flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium',
                            run.isGenerating
                              ? 'bg-primary/10 text-primary'
                              : run.error
                                ? 'bg-destructive/10 text-destructive'
                                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          )}
                        >
                          {run.isGenerating ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : run.error ? (
                            <Square className="size-3.5" />
                          ) : (
                            <Sparkles className="size-3.5" />
                          )}
                          {run.isGenerating
                            ? t('drawPage.generating')
                            : run.error
                              ? t('drawPage.failed')
                              : t('drawPage.completed')}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleDeleteRun(run.id)}
                          disabled={run.isGenerating}
                          aria-label={t('drawPage.deleteRecord')}
                          title={t('drawPage.deleteRecord')}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    {run.error && (
                      <div className="mt-4">
                        <ImageGenerationErrorCard
                          code={run.error.code}
                          message={run.error.message}
                        />
                      </div>
                    )}

                    {run.images.length > 0 && (
                      <div className="mt-4 grid gap-3 lg:grid-cols-2">
                        {run.images.map((image) => (
                          <ImagePreview key={image.id} src={image.src} alt={run.prompt} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
