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
  ChevronDown,
  Download,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  RefreshCcw,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { AnimatePresence, FadeIn, ScaleIn } from '@renderer/components/animate-ui/transitions'
import { ImageGenerationErrorCard } from '@renderer/components/chat/ImageGenerationErrorCard'
import { ImagePreview } from '@renderer/components/chat/ImagePreview'
import { ModelIcon, ProviderIcon } from '@renderer/components/settings/provider-icons'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { streamNativeOpenAIImages } from '@renderer/lib/api/openai-images-provider'
import type {
  AIModelConfig,
  AIProvider,
  ContentBlock,
  ProviderConfig,
  ResponsesImageGenerationQuality,
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
  type DrawGifInputMode,
  type DrawGifInputSnapshot,
  type DrawRun,
  type DrawRunImage,
  type DrawRunMode
} from '@renderer/lib/draw-history'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { recordUsageEvent } from '@renderer/lib/usage-analytics'
import { cn } from '@renderer/lib/utils'
import {
  isProviderAvailableForModelSelection,
  modelSupportsVision,
  useProviderStore
} from '@renderer/stores/provider-store'
import {
  abortActiveDrawRuns,
  getActiveDrawRunIds,
  registerDrawRunController,
  unregisterDrawRunController,
  useDrawStore
} from '@renderer/stores/draw-store'
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
    mediaType: imageBlock.source.mediaType,
    filePath: imageBlock.source.filePath
  }
}

function appendPreviewImageFallback(run: DrawRun): DrawRunImage[] {
  if (!run.previewImage) {
    return run.images
  }

  if (run.images.some((image) => image.src === run.previewImage?.src)) {
    return run.images
  }

  return [
    ...run.images,
    {
      ...run.previewImage,
      id: nanoid(),
      kind: run.previewImage.kind ?? 'generated'
    }
  ]
}

function pickFastTextModel(
  providers: AIProvider[]
): { provider: AIProvider; model: AIModelConfig; config: ProviderConfig } | null {
  const enabledProviders = providers.filter(
    (provider) =>
      isProviderAvailableForModelSelection(provider) &&
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

function formatElapsedSeconds(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000
  return seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()
}

const GIF_GRID_SIZE = 768
const GIF_FRAME_DURATION_MS = 120
const DRAW_STREAM_STORAGE_KEY = 'open-cowork.draw.stream-preview-enabled'
const DRAW_STREAM_PARTIAL_IMAGES = 2
const DRAW_IMAGE_QUALITY_OPTIONS: ResponsesImageGenerationQuality[] = [
  'auto',
  'low',
  'medium',
  'high'
]
const DRAW_PROMPT_STYLE_OPTIONS = [
  {
    id: 'photoreal',
    description: 'photorealistic photography, natural lens proportions, real materials and texture'
  },
  {
    id: 'cinematic',
    description:
      'cinematic shot design, clear depth layers, motivated lighting, dramatic composition'
  },
  {
    id: 'editorial',
    description:
      'editorial art direction, refined layout, premium color palette, magazine-ready polish'
  },
  {
    id: 'product',
    description:
      'commercial product photography, precise material finish, controlled reflections and shadows'
  },
  {
    id: 'minimalist',
    description:
      'minimal composition, ample negative space, restrained palette, clean visual hierarchy'
  },
  {
    id: 'anime',
    description:
      'anime-inspired character design, expressive silhouette, clean linework, vivid color accents'
  },
  {
    id: 'conceptArt',
    description:
      'concept art mood frame, strong silhouette, environment storytelling, painterly atmosphere'
  },
  {
    id: 'threeD',
    description:
      'stylized 3D render, tactile forms, controlled studio lighting, polished material shaders'
  },
  {
    id: 'watercolor',
    description: 'watercolor illustration, soft pigment edges, paper texture, gentle color bleeding'
  },
  {
    id: 'ink',
    description: 'ink illustration, confident line weight, high-contrast shapes, graphic detail'
  },
  {
    id: 'cyberpunk',
    description: 'cyberpunk atmosphere, neon lighting, dense urban detail, wet reflective surfaces'
  },
  {
    id: 'pixelArt',
    description:
      'pixel art style, crisp low-resolution shapes, deliberate limited palette, readable silhouette'
  }
] as const

type DrawPromptStyleId = (typeof DRAW_PROMPT_STYLE_OPTIONS)[number]['id']

type GenerateTarget = {
  provider: AIProvider
  model: AIModelConfig
  config: ProviderConfig
}

interface PersistedImageAsset {
  filePath: string
  data: string
  mediaType: string
}

interface GifPostprocessResult {
  success: boolean
  error?: string
  grid?: PersistedImageAsset
  frames?: PersistedImageAsset[]
  gif?: PersistedImageAsset
}

function isOpenAiTransparentProvider(config: ProviderConfig): boolean {
  return (
    config.type === 'openai-images' ||
    (config.type === 'openai-responses' && config.responsesImageGeneration?.enabled !== false)
  )
}

function supportsImageStreamPreview(config?: ProviderConfig | null): boolean {
  if (!config) return false
  return (
    config.type === 'openai-images' ||
    (config.type === 'openai-responses' && config.responsesImageGeneration?.enabled !== false)
  )
}

function withImageStreamPreviewConfig(config: ProviderConfig, enabled: boolean): ProviderConfig {
  if (!supportsImageStreamPreview(config)) return config

  const imageGenerationStream = {
    enabled,
    partialImages: enabled ? DRAW_STREAM_PARTIAL_IMAGES : 0
  }

  if (config.type === 'openai-responses') {
    return {
      ...config,
      imageGenerationStream,
      responsesImageGeneration: {
        ...(config.responsesImageGeneration ?? {}),
        partialImages: imageGenerationStream.partialImages
      }
    }
  }

  return {
    ...config,
    imageGenerationStream
  }
}

function supportsImageQuality(config?: ProviderConfig | null): boolean {
  if (!config) return false
  return (
    config.type === 'openai-images' ||
    (config.type === 'openai-responses' && config.responsesImageGeneration?.enabled !== false)
  )
}

function withImageQualityConfig(
  config: ProviderConfig,
  quality: ResponsesImageGenerationQuality
): ProviderConfig {
  if (!supportsImageQuality(config) || quality === 'auto') return config

  if (config.type === 'openai-responses') {
    return {
      ...config,
      responsesImageGeneration: {
        ...(config.responsesImageGeneration ?? {}),
        quality
      }
    }
  }

  const requestOverrides = config.requestOverrides
  return {
    ...config,
    requestOverrides: {
      headers: requestOverrides?.headers,
      omitBodyKeys: requestOverrides?.omitBodyKeys,
      body: {
        ...(requestOverrides?.body ?? {}),
        quality
      }
    }
  }
}

function buildGifProviderConfig(config: ProviderConfig): ProviderConfig {
  if (!isOpenAiTransparentProvider(config)) {
    return config
  }

  const requestOverrides = config.requestOverrides
  return {
    ...config,
    requestOverrides: {
      headers: requestOverrides?.headers,
      omitBodyKeys: requestOverrides?.omitBodyKeys,
      body: {
        ...(requestOverrides?.body ?? {}),
        output_format: 'png'
      }
    }
  }
}

function toDataUrl(data: string, mediaType: string): string {
  return `data:${mediaType};base64,${data}`
}

function attachmentToPersistableReference(image: ImageAttachment | null): {
  dataUrl: string
  mediaType: string
} | null {
  if (!image) return null
  return {
    dataUrl: image.dataUrl,
    mediaType: image.mediaType
  }
}

function readStoredStreamPreviewEnabled(): boolean {
  try {
    return window.localStorage.getItem(DRAW_STREAM_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeStoredStreamPreviewEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(DRAW_STREAM_STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // Storage can be unavailable in unusual embedded contexts; the switch still works in memory.
  }
}

function buildGifPrompt(
  input: DrawGifInputSnapshot,
  options?: { transparentBackgroundRequested?: boolean }
): string {
  const referenceInstruction =
    input.inputMode === 'reference'
      ? `Use the attached reference image as the primary character reference. Preserve identity, silhouette, clothing, colors, and facial traits across all nine panels. Additional character notes: ${input.characterPrompt || 'none'}.`
      : `Character design: ${input.characterPrompt}.`

  return [
    'Create one single square 3x3 animation sprite sheet for a GIF workflow.',
    'Exactly 9 panels arranged in 3 columns and 3 rows.',
    'One character only, full body visible in every panel.',
    ...(options?.transparentBackgroundRequested
      ? [
          'The output must be a real PNG sprite sheet with a true alpha channel and a fully transparent background.',
          'Do not draw checkerboards, transparency grids, matte patterns, colored backdrops, shadows on a floor, or any fake transparency indicator.',
          'This is a hard requirement: output a true transparent PNG asset with alpha pixels, not a simulated transparent background.'
        ]
      : ['Use a plain, clean, uniform background with no texture or distracting pattern.']),
    'No borders, no gutters, no spacing, no captions, no text, no speech bubbles, no watermarks.',
    'Do not place panel numbers, frame markers, labels, badges, corner tags, or any text such as P1, P2, 1, 2, frame1, frame 01 in any corner or panel.',
    'Keep the same camera angle, framing, lighting, composition, character size, center position, and foot baseline across all 9 panels.',
    'The action must be a single simple continuous motion only.',
    'Do not combine multiple actions, do not switch to a second action, and do not create complex choreography.',
    'Interpret the user action as one simple motion arc and spread it across 9 consecutive frames.',
    'Each adjacent panel must differ only slightly from the previous one.',
    'Use micro-movements only: very small pose changes, very small limb displacement, very small head movement.',
    'Avoid large pose changes, big swings, jumps, squash and stretch, dramatic anticipation, or abrupt transitions.',
    'Prioritize maximum continuity and smoothness over dramatic expression.',
    'Each panel must be equal-sized and perfectly aligned for precise slicing.',
    referenceInstruction,
    `Style direction: ${input.stylePrompt}.`,
    `Single simple action to animate continuously: ${input.actionPrompt}.`,
    `The final output must be a single square image designed for exact ${GIF_GRID_SIZE}x${GIF_GRID_SIZE} normalization and left-to-right, top-to-bottom playback.`
  ].join(' ')
}

function buildGifRunSummary(input: DrawGifInputSnapshot): string {
  const parts = [
    input.inputMode === 'reference'
      ? 'Reference image mode'
      : `Character: ${input.characterPrompt}`,
    input.inputMode === 'reference' && input.characterPrompt
      ? `Character notes: ${input.characterPrompt}`
      : null,
    `Style: ${input.stylePrompt}`,
    `Action: ${input.actionPrompt}`
  ].filter(Boolean)

  return parts.join('｜')
}

function drawRunImageFromAsset(
  asset: PersistedImageAsset,
  kind: DrawRunImage['kind'],
  label: string,
  frameIndex?: number
): DrawRunImage {
  return {
    id: nanoid(),
    src: toDataUrl(asset.data, asset.mediaType),
    mediaType: asset.mediaType,
    filePath: asset.filePath,
    kind,
    label,
    frameIndex
  }
}

function getGifAssets(run: DrawRun): {
  grid: DrawRunImage | null
  gif: DrawRunImage | null
  frames: DrawRunImage[]
} {
  return {
    grid: run.images.find((image) => image.kind === 'gif-grid') ?? null,
    gif: run.images.find((image) => image.kind === 'gif-output') ?? null,
    frames: run.images.filter((image) => image.kind === 'gif-frame')
  }
}

function getRunStatusLabel(
  run: DrawRun,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (!run.isGenerating) {
    return run.error ? t('drawPage.failed') : t('drawPage.completed')
  }

  if (run.mode === 'gif' && run.meta?.gif?.stage === 'processing') {
    return t('drawPage.processingGif')
  }

  if (run.previewImage) {
    return t('drawPage.streamingPreviewStatus')
  }

  return t('drawPage.generating')
}

function buildNoImageOutputDetails(
  run: DrawRun,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const providerIdSuffix = run.meta?.providerId ? ` (${run.meta.providerId})` : ''
  const modelIdSuffix = run.meta?.modelId ? ` (${run.meta.modelId})` : ''

  return t('drawPage.noImageOutputDetails', {
    providerName: run.providerName,
    providerIdSuffix,
    modelName: run.modelName,
    modelIdSuffix,
    requestType: run.meta?.requestType?.trim() || 'unknown',
    baseUrl: run.meta?.baseUrl?.trim() || 'default'
  })
}

function isNoImageOutputErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  return (
    normalized.includes('no image output') ||
    normalized.includes('no image block') ||
    normalized.includes('image output') ||
    normalized.includes('模型未返回任何图片内容') ||
    normalized.includes('未返回任何图片内容') ||
    normalized.includes('没有收到可识别的图片块')
  )
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

  const [drawMode, setDrawMode] = useState<DrawRunMode>('image')
  const [prompt, setPrompt] = useState('')
  const [promptCoreSuggestion, setPromptCoreSuggestion] = useState('')
  const [selectedPromptStyleIds, setSelectedPromptStyleIds] = useState<DrawPromptStyleId[]>([])
  const [drawImageQuality, setDrawImageQuality] = useState<ResponsesImageGenerationQuality>('auto')
  const [drawResultTab, setDrawResultTab] = useState<'current' | 'history'>('current')
  const [gifInputMode, setGifInputMode] = useState<DrawGifInputMode>('text')
  const [gifCharacterPrompt, setGifCharacterPrompt] = useState('')
  const [gifStylePrompt, setGifStylePrompt] = useState('')
  const [gifActionPrompt, setGifActionPrompt] = useState('')
  const [streamPreviewEnabled, setStreamPreviewEnabled] = useState(readStoredStreamPreviewEnabled)
  const runs = useDrawStore((state) => state.runs)
  const commitRuns = useDrawStore((state) => state.commitRuns)
  const updateStoredRun = useDrawStore((state) => state.updateRun)
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([])
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false)
  const [optimizedPrompt, setOptimizedPrompt] = useState('')
  const [optimizationStartedAt, setOptimizationStartedAt] = useState<number | null>(null)
  const [optimizationElapsedMs, setOptimizationElapsedMs] = useState<number | null>(null)
  const [optimizationDialogOpen, setOptimizationDialogOpen] = useState(false)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [dialogProviderId, setDialogProviderId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const isGenerating = runs.some((run) => run.isGenerating)

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

  useEffect(() => {
    if (!isOptimizingPrompt || optimizationStartedAt === null) return

    const updateElapsed = (): void => {
      setOptimizationElapsedMs(Date.now() - optimizationStartedAt)
    }

    updateElapsed()
    const timer = window.setInterval(updateElapsed, 200)
    return () => window.clearInterval(timer)
  }, [isOptimizingPrompt, optimizationStartedAt])

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
    writeStoredStreamPreviewEnabled(streamPreviewEnabled)
  }, [streamPreviewEnabled])

  useEffect(() => {
    let cancelled = false

    void listPersistedDrawRuns(t('drawPage.interrupted'), {
      activeRunIds: getActiveDrawRunIds()
    })
      .then((persistedRuns) => {
        if (!cancelled) {
          commitRuns((current) => {
            const currentActiveRunIds = getActiveDrawRunIds()
            if (currentActiveRunIds.size === 0) return persistedRuns

            const activeRunsById = new Map(
              current.filter((run) => currentActiveRunIds.has(run.id)).map((run) => [run.id, run])
            )
            const mergedRunIds = new Set<string>()
            const mergedRuns = persistedRuns.map((run) => {
              mergedRunIds.add(run.id)
              return activeRunsById.get(run.id) ?? run
            })

            for (const activeRun of activeRunsById.values()) {
              if (!mergedRunIds.has(activeRun.id)) {
                mergedRuns.push(activeRun)
              }
            }

            return mergedRuns.sort((a, b) => b.createdAt - a.createdAt)
          })
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [commitRuns, t])

  useEffect(() => {
    if (!modelDialogOpen) return
    setDialogProviderId(selectedProvider?.id ?? providerModelGroups[0]?.provider.id ?? null)
  }, [modelDialogOpen, providerModelGroups, selectedProvider])

  const resolveGenerationTarget = useCallback(
    (providerId?: string, modelId?: string): GenerateTarget | null => {
      const resolvedProvider = providerId
        ? (providers.find((provider) => provider.id === providerId) ?? null)
        : selectedProvider
      if (!resolvedProvider) return null

      const resolvedModel = modelId
        ? (resolvedProvider.models.find((model) => model.id === modelId) ?? null)
        : (resolvedProvider.models.find((model) => model.id === selectedModel?.id) ?? selectedModel)
      if (!resolvedModel) return null

      const config = useProviderStore
        .getState()
        .getProviderConfigById(resolvedProvider.id, resolvedModel.id)
      if (!config) return null

      return {
        provider: resolvedProvider,
        model: resolvedModel,
        config
      }
    },
    [providers, selectedModel, selectedProvider]
  )

  const selectedGenerationTarget = useMemo(
    () => resolveGenerationTarget(),
    [resolveGenerationTarget]
  )
  const streamPreviewSupported = supportsImageStreamPreview(selectedGenerationTarget?.config)
  const streamPreviewActive = streamPreviewEnabled && streamPreviewSupported
  const imageQualitySupported = supportsImageQuality(selectedGenerationTarget?.config)

  const resetGifForm = useCallback((): void => {
    setGifInputMode('text')
    setGifCharacterPrompt('')
    setGifStylePrompt('')
    setGifActionPrompt('')
    setAttachedImages([])
  }, [])

  const buildCurrentGifSnapshot = useCallback((): DrawGifInputSnapshot => {
    return {
      inputMode: gifInputMode,
      characterPrompt: gifCharacterPrompt.trim(),
      stylePrompt: gifStylePrompt.trim(),
      actionPrompt: gifActionPrompt.trim(),
      referenceImage: attachmentToPersistableReference(attachedImages[0] ?? null),
      frameDurationMs: GIF_FRAME_DURATION_MS,
      gridSize: GIF_GRID_SIZE,
      stage: 'requesting'
    }
  }, [attachedImages, gifActionPrompt, gifCharacterPrompt, gifInputMode, gifStylePrompt])

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
    (runId: string, updater: (run: DrawRun) => DrawRun, options?: { persist?: boolean }): void => {
      const nextRun = updateStoredRun(runId, updater)

      if (nextRun && options?.persist !== false) {
        persistRun(nextRun)
      }
    },
    [persistRun, updateStoredRun]
  )

  const finishRun = useCallback(
    (runId: string): void => {
      updateRun(runId, (run) => {
        const images = appendPreviewImageFallback(run)
        const noImageOutputDetails =
          !run.error && run.images.length === 0 ? buildNoImageOutputDetails(run, t) : undefined

        return {
          ...run,
          isGenerating: false,
          images,
          previewImage: undefined,
          previewImageIndex: undefined,
          error:
            run.error || run.images.length > 0
              ? run.error
              : {
                  code: 'unknown',
                  message: t('drawPage.noImageOutput'),
                  details: noImageOutputDetails
                }
        }
      })
    },
    [t, updateRun]
  )

  const handleStop = useCallback((): void => {
    abortActiveDrawRuns()
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

  const handleDeleteRun = useCallback(
    (runId: string): void => {
      commitRuns((current) => current.filter((run) => run.id !== runId))
      void deletePersistedDrawRun(runId)
    },
    [commitRuns]
  )

  const handleClearHistory = useCallback((): void => {
    commitRuns([])
    void clearPersistedDrawRuns()
  }, [commitRuns])

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

  const handleTogglePromptStyle = useCallback((styleId: DrawPromptStyleId): void => {
    setSelectedPromptStyleIds((current) =>
      current.includes(styleId) ? current.filter((id) => id !== styleId) : [...current, styleId]
    )
  }, [])

  const handleOptimizePrompt = useCallback(async (): Promise<void> => {
    const trimmedPrompt = prompt.trim()
    if (drawMode === 'gif' || !trimmedPrompt || isGenerating || isOptimizingPrompt) return

    const fastTarget = pickFastTextModel(providers)
    if (!fastTarget) {
      toast.error(t('drawPage.optimizeUnavailable'))
      return
    }

    const startedAt = Date.now()
    setOptimizationStartedAt(startedAt)
    setOptimizationElapsedMs(0)
    setIsOptimizingPrompt(true)
    setOptimizedPrompt('')

    try {
      const optimizeImages = modelSupportsVision(fastTarget.model, fastTarget.provider.type)
        ? attachedImages
        : []
      const selectedStyleDirections = DRAW_PROMPT_STYLE_OPTIONS.filter((option) =>
        selectedPromptStyleIds.includes(option.id)
      ).map((option) => `${t(`drawPage.promptStyleOptions.${option.id}`)} - ${option.description}`)
      const result = await optimizeDrawPrompt(trimmedPrompt, fastTarget.config, optimizeImages, {
        userCoreSuggestion: promptCoreSuggestion.trim() || undefined,
        selectedStyleDirections
      })
      setOptimizedPrompt(result.prompt)
      setOptimizationDialogOpen(true)
    } catch (error) {
      toast.error(t('drawPage.optimizeFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setOptimizationElapsedMs(Date.now() - startedAt)
      setOptimizationStartedAt(null)
      setIsOptimizingPrompt(false)
    }
  }, [
    attachedImages,
    drawMode,
    isGenerating,
    isOptimizingPrompt,
    prompt,
    promptCoreSuggestion,
    providers,
    selectedPromptStyleIds,
    t
  ])

  const handleOpenOptimizationDialog = useCallback((): void => {
    if (drawMode === 'gif' || !prompt.trim() || isGenerating) return
    setOptimizedPrompt('')
    setOptimizationStartedAt(null)
    setOptimizationElapsedMs(null)
    setOptimizationDialogOpen(true)
  }, [drawMode, isGenerating, prompt])

  const handleUseOptimizedPrompt = useCallback((): void => {
    if (!optimizedPrompt.trim()) return
    setPrompt(optimizedPrompt)
    setOptimizationDialogOpen(false)
  }, [optimizedPrompt])

  const handleOptimizationDialogChange = useCallback((open: boolean): void => {
    setOptimizationDialogOpen(open)
    if (!open) {
      setOptimizedPrompt('')
      setOptimizationStartedAt(null)
      setOptimizationElapsedMs(null)
    }
  }, [])

  const handleDownloadAsset = useCallback(
    async (image: DrawRunImage | null, fallbackName: string): Promise<void> => {
      if (!image?.filePath) return

      try {
        const readResult = (await ipcClient.invoke(IPC.FS_READ_FILE_BINARY, {
          path: image.filePath
        })) as { data?: string; error?: string }

        if (readResult.error || !readResult.data) {
          throw new Error(readResult.error || 'Failed to read generated asset.')
        }

        const saveResult = (await ipcClient.invoke(IPC.FS_SELECT_SAVE_FILE, {
          defaultPath: fallbackName,
          filters: [
            {
              name: 'Images',
              extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']
            }
          ]
        })) as { path?: string; canceled?: boolean }

        if (saveResult.canceled || !saveResult.path) return

        const writeResult = (await ipcClient.invoke(IPC.FS_WRITE_FILE_BINARY, {
          path: saveResult.path,
          data: readResult.data
        })) as { success?: boolean; error?: string }

        if (writeResult.error) {
          throw new Error(writeResult.error)
        }

        toast.success(t('drawPage.downloadSuccess'))
      } catch (error) {
        toast.error(t('drawPage.downloadFailed'), {
          description: error instanceof Error ? error.message : String(error)
        })
      }
    },
    [t]
  )

  const postprocessGifGrid = useCallback(
    async (runId: string, image: DrawRunImage): Promise<DrawRunImage[]> => {
      const base64Data = image.src.startsWith('data:') ? image.src.split(',', 2)[1] || '' : ''
      const result = (await ipcClient.invoke(IPC.IMAGE_CREATE_GIF_FROM_GRID, {
        runId,
        filePath: image.filePath,
        data: base64Data,
        mediaType: image.mediaType,
        frameDurationMs: GIF_FRAME_DURATION_MS
      })) as GifPostprocessResult

      if (!result.success || !result.grid || !result.gif || !result.frames?.length) {
        throw new Error(result.error || t('drawPage.gifProcessFailed'))
      }

      return [
        drawRunImageFromAsset(result.grid, 'gif-grid', t('drawPage.gifGridLabel')),
        ...result.frames.map((frame, index) =>
          drawRunImageFromAsset(
            frame,
            'gif-frame',
            t('drawPage.gifFrameLabel', { index: index + 1 }),
            index + 1
          )
        ),
        drawRunImageFromAsset(result.gif, 'gif-output', t('drawPage.gifOutputLabel'))
      ]
    },
    [t]
  )

  const generateStandardRun = useCallback(async (): Promise<void> => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) return

    const target = resolveGenerationTarget()
    if (!target) {
      toast.error(t('drawPage.noModel'))
      return
    }

    if (!target.provider.enabled) {
      toast.error(t('drawPage.providerDisabled'))
      return
    }

    if (!target.model.enabled) {
      toast.error(t('drawPage.modelDisabled'))
      return
    }

    const ready = await ensureProviderAuthReady(target.provider.id)
    if (!ready) {
      toast.error(t('drawPage.authRequired'), {
        action: {
          label: t('drawPage.openProviderSettings'),
          onClick: () => openSettingsPage('provider')
        }
      })
      return
    }

    const runId = nanoid()
    const createdAt = Date.now()
    const controller = new AbortController()
    const newRun: DrawRun = {
      id: runId,
      prompt: trimmedPrompt,
      providerName: target.provider.name,
      modelName: target.model.name,
      mode: 'image',
      meta: {
        providerId: target.provider.id,
        modelId: target.model.id,
        requestType: target.config.type,
        baseUrl: target.config.baseUrl
      },
      createdAt,
      isGenerating: true,
      images: [],
      error: null
    }

    registerDrawRunController(runId, controller)
    commitRuns((current) => [newRun, ...current])
    persistRun(newRun)

    const baseProviderConfig = withImageQualityConfig(target.config, drawImageQuality)
    const streamPreviewEnabledForRun =
      streamPreviewEnabled && supportsImageStreamPreview(baseProviderConfig)
    const providerConfig = withImageStreamPreviewConfig(
      baseProviderConfig,
      streamPreviewEnabledForRun
    )
    const requestStartedAt = Date.now()
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
      for await (const event of streamNativeOpenAIImages({
        messages,
        config: providerConfig,
        signal: controller.signal
      })) {
        switch (event.type) {
          case 'image_generation_partial': {
            const image = normalizeImageSrc(event)
            if (!image) break
            updateRun(
              runId,
              (run) => ({
                ...run,
                previewImage: image,
                previewImageIndex: event.partialImageIndex
              }),
              { persist: false }
            )
            break
          }
          case 'image_generated': {
            const image = normalizeImageSrc(event)
            if (!image) break
            updateRun(runId, (run) => ({
              ...run,
              images: [...run.images, image],
              previewImage: undefined,
              previewImageIndex: undefined,
              error: null
            }))
            break
          }
          case 'image_error': {
            if (controller.signal.aborted) break
            const imageError = event.imageError
            if (!imageError) break
            updateRun(runId, (run) => {
              const images = appendPreviewImageFallback(run)

              return {
                ...run,
                images,
                previewImage: undefined,
                previewImageIndex: undefined,
                error: {
                  code: imageError.code,
                  message: imageError.message
                }
              }
            })
            break
          }
          case 'error': {
            if (controller.signal.aborted) break
            updateRun(runId, (run) => {
              const images = appendPreviewImageFallback(run)

              return {
                ...run,
                images,
                previewImage: undefined,
                previewImageIndex: undefined,
                error: {
                  code: 'unknown',
                  message: event.error?.message || t('drawPage.unknownError')
                }
              }
            })
            break
          }
          case 'message_end': {
            void recordUsageEvent({
              sourceKind: 'draw',
              providerId: target.provider.id,
              modelId: target.model.id,
              usage: event.usage,
              timing: event.timing ?? {
                totalMs: Date.now() - requestStartedAt,
                ttftMs: Date.now() - requestStartedAt
              },
              providerResponseId: event.providerResponseId,
              createdAt: Date.now(),
              meta: { drawRunId: runId, mode: 'image' }
            })
            finishRun(runId)
            break
          }
          default:
            break
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        updateRun(runId, (run) => {
          const images = appendPreviewImageFallback(run)

          return {
            ...run,
            images,
            previewImage: undefined,
            previewImageIndex: undefined,
            error: {
              code: 'unknown',
              message: error instanceof Error ? error.message : String(error)
            }
          }
        })
      }
    } finally {
      if (controller.signal.aborted) {
        updateRun(runId, (run) => ({
          ...run,
          previewImage: undefined,
          previewImageIndex: undefined,
          error:
            run.error || run.images.length > 0
              ? run.error
              : {
                  code: 'request_aborted',
                  message: t('drawPage.interrupted')
                }
        }))
      }
      finishRun(runId)
      unregisterDrawRunController(runId, controller)
    }
  }, [
    attachedImages,
    finishRun,
    openSettingsPage,
    persistRun,
    prompt,
    resolveGenerationTarget,
    drawImageQuality,
    streamPreviewEnabled,
    t,
    updateRun,
    commitRuns
  ])

  const generateGifRun = useCallback(
    async (
      snapshot: DrawGifInputSnapshot,
      providerId?: string,
      modelId?: string
    ): Promise<void> => {
      if (snapshot.inputMode === 'text' && !snapshot.characterPrompt.trim()) {
        toast.error(t('drawPage.gifCharacterRequired'))
        return
      }
      if (!snapshot.stylePrompt.trim()) {
        toast.error(t('drawPage.gifStyleRequired'))
        return
      }
      if (!snapshot.actionPrompt.trim()) {
        toast.error(t('drawPage.gifActionRequired'))
        return
      }
      if (snapshot.inputMode === 'reference' && !snapshot.referenceImage) {
        toast.error(t('drawPage.gifReferenceRequired'))
        return
      }

      const target = resolveGenerationTarget(providerId, modelId)
      if (!target) {
        toast.error(t('drawPage.noModel'))
        return
      }

      if (!target.provider.enabled) {
        toast.error(t('drawPage.providerDisabled'))
        return
      }

      if (!target.model.enabled) {
        toast.error(t('drawPage.modelDisabled'))
        return
      }

      const ready = await ensureProviderAuthReady(target.provider.id)
      if (!ready) {
        toast.error(t('drawPage.authRequired'), {
          action: {
            label: t('drawPage.openProviderSettings'),
            onClick: () => openSettingsPage('provider')
          }
        })
        return
      }

      const runId = nanoid()
      const createdAt = Date.now()
      const controller = new AbortController()
      const runMeta: DrawRun['meta'] = {
        providerId: target.provider.id,
        modelId: target.model.id,
        requestType: target.config.type,
        baseUrl: target.config.baseUrl,
        gif: snapshot
      }
      const newRun: DrawRun = {
        id: runId,
        prompt: buildGifRunSummary(snapshot),
        providerName: target.provider.name,
        modelName: target.model.name,
        mode: 'gif',
        meta: runMeta,
        createdAt,
        isGenerating: true,
        images: [],
        error: null
      }

      registerDrawRunController(runId, controller)
      commitRuns((current) => [newRun, ...current])
      persistRun(newRun)

      const baseProviderConfig = buildGifProviderConfig(
        withImageQualityConfig(target.config, drawImageQuality)
      )
      const streamPreviewEnabledForRun =
        streamPreviewEnabled && supportsImageStreamPreview(baseProviderConfig)
      const providerConfig = withImageStreamPreviewConfig(
        baseProviderConfig,
        streamPreviewEnabledForRun
      )
      const createMessages = (): UnifiedMessage[] => {
        const promptText = buildGifPrompt(snapshot, {
          transparentBackgroundRequested: isOpenAiTransparentProvider(baseProviderConfig)
        })
        const content: string | ContentBlock[] =
          snapshot.inputMode === 'reference' && snapshot.referenceImage
            ? [
                imageAttachmentToContentBlock({
                  id: nanoid(),
                  dataUrl: snapshot.referenceImage.dataUrl,
                  mediaType: snapshot.referenceImage.mediaType
                }),
                {
                  type: 'text',
                  text: promptText
                }
              ]
            : promptText

        return [
          {
            id: nanoid(),
            role: 'user',
            content,
            createdAt: Date.now()
          }
        ]
      }

      const messages = createMessages()
      const requestStartedAt = Date.now()
      let processed = false

      try {
        for await (const event of streamNativeOpenAIImages({
          messages,
          config: providerConfig,
          signal: controller.signal
        })) {
          switch (event.type) {
            case 'image_generation_partial': {
              const image = normalizeImageSrc(event)
              if (!image) break
              updateRun(
                runId,
                (run) => ({
                  ...run,
                  previewImage: image,
                  previewImageIndex: event.partialImageIndex
                }),
                { persist: false }
              )
              break
            }
            case 'image_generated': {
              if (processed) break
              const image = normalizeImageSrc(event)
              if (!image) break
              processed = true
              updateRun(runId, (run) => ({
                ...run,
                error: null,
                previewImage: undefined,
                previewImageIndex: undefined,
                meta: run.meta?.gif
                  ? {
                      ...run.meta,
                      gif: {
                        ...run.meta.gif,
                        stage: 'processing'
                      }
                    }
                  : run.meta
              }))
              try {
                const processedImages = await postprocessGifGrid(runId, image)
                updateRun(runId, (run) => ({
                  ...run,
                  images: processedImages,
                  error: null,
                  meta: run.meta?.gif
                    ? {
                        ...run.meta,
                        gif: {
                          ...run.meta.gif,
                          stage: 'completed'
                        }
                      }
                    : run.meta
                }))
                return
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                updateRun(runId, (run) => ({
                  ...run,
                  error: {
                    code: 'unknown',
                    message
                  }
                }))
                break
              }
            }
            case 'image_error': {
              if (controller.signal.aborted) break
              const imageError = event.imageError
              if (!imageError) break
              updateRun(runId, (run) => {
                const images = appendPreviewImageFallback(run)

                return {
                  ...run,
                  images,
                  previewImage: undefined,
                  previewImageIndex: undefined,
                  error: {
                    code: imageError.code,
                    message: imageError.message
                  }
                }
              })
              break
            }
            case 'error': {
              if (controller.signal.aborted) break
              updateRun(runId, (run) => {
                const images = appendPreviewImageFallback(run)

                return {
                  ...run,
                  images,
                  previewImage: undefined,
                  previewImageIndex: undefined,
                  error: {
                    code: 'unknown',
                    message: event.error?.message || t('drawPage.unknownError')
                  }
                }
              })
              break
            }
            case 'message_end': {
              void recordUsageEvent({
                sourceKind: 'draw',
                providerId: target.provider.id,
                modelId: target.model.id,
                usage: event.usage,
                timing: event.timing ?? {
                  totalMs: Date.now() - requestStartedAt,
                  ttftMs: Date.now() - requestStartedAt
                },
                providerResponseId: event.providerResponseId,
                createdAt: Date.now(),
                meta: { drawRunId: runId, mode: 'gif' }
              })
              break
            }
            default:
              break
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          updateRun(runId, (run) => {
            const images = appendPreviewImageFallback(run)

            return {
              ...run,
              images,
              previewImage: undefined,
              previewImageIndex: undefined,
              error: {
                code: 'unknown',
                message: error instanceof Error ? error.message : String(error)
              }
            }
          })
        }
      } finally {
        if (controller.signal.aborted) {
          updateRun(runId, (run) => ({
            ...run,
            previewImage: undefined,
            previewImageIndex: undefined,
            error:
              run.error || run.images.length > 0
                ? run.error
                : {
                    code: 'request_aborted',
                    message: t('drawPage.interrupted')
                  }
          }))
        }
        finishRun(runId)
        unregisterDrawRunController(runId, controller)
      }
    },
    [
      finishRun,
      openSettingsPage,
      persistRun,
      postprocessGifGrid,
      resolveGenerationTarget,
      drawImageQuality,
      streamPreviewEnabled,
      t,
      updateRun,
      commitRuns
    ]
  )

  const handleRetryGifRun = useCallback(
    async (run: DrawRun): Promise<void> => {
      if (run.mode !== 'gif' || !run.meta?.gif) return
      setDrawMode('gif')
      setGifInputMode(run.meta.gif.inputMode)
      setGifCharacterPrompt(run.meta.gif.characterPrompt)
      setGifStylePrompt(run.meta.gif.stylePrompt)
      setGifActionPrompt(run.meta.gif.actionPrompt)
      setAttachedImages(
        run.meta.gif.referenceImage
          ? [
              {
                id: nanoid(),
                dataUrl: run.meta.gif.referenceImage.dataUrl,
                mediaType: run.meta.gif.referenceImage.mediaType
              }
            ]
          : []
      )
      if (run.meta.providerId) {
        setActiveImageProvider(run.meta.providerId)
      }
      if (run.meta.modelId) {
        setActiveImageModel(run.meta.modelId)
      }
      await generateGifRun(
        {
          ...run.meta.gif,
          stage: 'requesting'
        },
        run.meta.providerId,
        run.meta.modelId
      )
    },
    [generateGifRun, setActiveImageModel, setActiveImageProvider]
  )

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (drawMode === 'gif') {
      await generateGifRun(buildCurrentGifSnapshot())
      return
    }

    await generateStandardRun()
  }, [buildCurrentGifSnapshot, drawMode, generateGifRun, generateStandardRun])

  const gifFormValid =
    !!gifStylePrompt.trim() &&
    !!gifActionPrompt.trim() &&
    (gifInputMode === 'reference' ? attachedImages.length > 0 : !!gifCharacterPrompt.trim())

  const canGenerate =
    (drawMode === 'gif' ? gifFormValid : !!prompt.trim()) &&
    !!selectedProvider &&
    !!selectedModel &&
    !isGenerating &&
    providerModelGroups.length > 0

  const canOptimizePrompt =
    drawMode === 'image' && !!prompt.trim() && !isGenerating && !isOptimizingPrompt

  const currentRun = runs.find((run) => run.isGenerating) ?? runs[0] ?? null
  const currentRuns = currentRun ? [currentRun] : []
  const currentRunIds = new Set(currentRuns.map((run) => run.id))
  const historyRuns = runs.filter((run) => !currentRunIds.has(run.id))

  const selectedOptionValue =
    selectedProvider && selectedModel
      ? toOptionValue(selectedProvider.id, selectedModel.id)
      : undefined

  const dialogGroup =
    providerModelGroups.find((group) => group.provider.id === dialogProviderId) ??
    selectedGroup ??
    providerModelGroups[0] ??
    null

  const renderRunCard = (run: DrawRun): React.JSX.Element => {
    const gifAssets = run.mode === 'gif' ? getGifAssets(run) : { grid: null, gif: null, frames: [] }
    const gifFallbackImages =
      run.mode === 'gif'
        ? run.images.filter((image) => !image.kind || image.kind === 'generated')
        : []
    const errorDetails =
      run.error?.details ??
      (run.error && isNoImageOutputErrorMessage(run.error.message)
        ? buildNoImageOutputDetails(run, t)
        : undefined)

    return (
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
              <Badge variant="outline" className="text-[10px] font-normal">
                {run.mode === 'gif' ? t('drawPage.modeGif') : t('drawPage.modeImage')}
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
              {getRunStatusLabel(run, t)}
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

        {run.mode === 'gif' && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void handleRetryGifRun(run)}
              disabled={run.isGenerating || !run.meta?.gif}
            >
              <RefreshCcw className="size-3.5" />
              {t('drawPage.retryGif')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void handleDownloadAsset(gifAssets.gif, 'animation.gif')}
              disabled={!gifAssets.gif}
            >
              <Download className="size-3.5" />
              {t('drawPage.downloadGif')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void handleDownloadAsset(gifAssets.grid, 'grid.png')}
              disabled={!gifAssets.grid}
            >
              <Download className="size-3.5" />
              {t('drawPage.downloadGrid')}
            </Button>
          </div>
        )}

        {run.isGenerating && run.previewImage && (
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t('drawPage.realtimePreview')}
              </span>
              {typeof run.previewImageIndex === 'number' && (
                <Badge variant="outline" className="text-[10px] font-normal">
                  {t('drawPage.previewIndex', { index: run.previewImageIndex + 1 })}
                </Badge>
              )}
            </div>
            <ImagePreview
              src={run.previewImage.src}
              alt={run.prompt}
              filePath={run.previewImage.filePath}
            />
          </div>
        )}

        {run.error && (
          <div className="mt-4">
            <ImageGenerationErrorCard
              code={run.error.code}
              message={run.error.message}
              details={errorDetails}
            />
          </div>
        )}

        {run.mode === 'gif' ? (
          <>
            {(gifAssets.gif || gifAssets.grid) && (
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {gifAssets.gif && (
                  <ScaleIn key={`${run.id}-gif`}>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      {t('drawPage.gifOutputLabel')}
                    </p>
                    <ImagePreview
                      src={gifAssets.gif.src}
                      alt={run.prompt}
                      filePath={gifAssets.gif.filePath}
                    />
                  </ScaleIn>
                )}
                {gifAssets.grid && (
                  <ScaleIn key={`${run.id}-grid`} delay={0.05}>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      {t('drawPage.gifGridLabel')}
                    </p>
                    <ImagePreview
                      src={gifAssets.grid.src}
                      alt={run.prompt}
                      filePath={gifAssets.grid.filePath}
                    />
                  </ScaleIn>
                )}
              </div>
            )}

            {gifAssets.frames.length > 0 && (
              <Collapsible className="mt-4 rounded-xl border bg-muted/10 px-3 py-2">
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-foreground">
                  <span>
                    {t('drawPage.framesSectionTitle', { count: gifAssets.frames.length })}
                  </span>
                  <ChevronDown className="size-4 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {gifAssets.frames.map((image, index) => (
                      <ScaleIn key={image.id} delay={index * 0.05}>
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          {t('drawPage.gifFrameLabel', { index: index + 1 })}
                        </p>
                        <ImagePreview src={image.src} alt={run.prompt} filePath={image.filePath} />
                      </ScaleIn>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {gifFallbackImages.length > 0 &&
              !gifAssets.gif &&
              !gifAssets.grid &&
              gifAssets.frames.length === 0 && (
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  {gifFallbackImages.map((image, index) => (
                    <ScaleIn key={image.id} delay={index * 0.05}>
                      <ImagePreview src={image.src} alt={run.prompt} filePath={image.filePath} />
                    </ScaleIn>
                  ))}
                </div>
              )}
          </>
        ) : (
          run.images.length > 0 && (
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {run.images.map((image, index) => (
                <ScaleIn key={image.id} delay={index * 0.05}>
                  <ImagePreview src={image.src} alt={run.prompt} filePath={image.filePath} />
                </ScaleIn>
              ))}
            </div>
          )
        )}
      </div>
    )
  }

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
                  {drawMode === 'gif'
                    ? t('drawPage.gifPromptSectionDesc')
                    : t('drawPage.promptSectionDesc')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {drawMode === 'gif'
                    ? gifCharacterPrompt.trim().length +
                      gifStylePrompt.trim().length +
                      gifActionPrompt.trim().length
                    : prompt.trim().length}
                </Badge>
                {(drawMode === 'image' || gifInputMode === 'reference') && (
                  <Button
                    variant="outline"
                    size="icon-xs"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label={t('drawPage.addImage')}
                    title={t('drawPage.addImage')}
                  >
                    <ImagePlus className="size-3.5" />
                  </Button>
                )}
                {drawMode === 'image' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={handleOpenOptimizationDialog}
                    disabled={!canOptimizePrompt}
                  >
                    <Sparkles className="size-3.5" />
                    {t('drawPage.optimizePrompt')}
                  </Button>
                )}
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

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant={drawMode === 'image' ? 'default' : 'outline'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => setDrawMode('image')}
                disabled={isGenerating}
              >
                {t('drawPage.modeImage')}
              </Button>
              <Button
                variant={drawMode === 'gif' ? 'default' : 'outline'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => setDrawMode('gif')}
                disabled={isGenerating}
              >
                {t('drawPage.modeGif')}
              </Button>
              {drawMode === 'gif' && (
                <Badge variant="secondary" className="text-[10px] font-normal">
                  {t('drawPage.gifModelWarning')}
                </Badge>
              )}
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

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 px-3 py-2">
              <div className="flex items-center gap-2">
                <Switch
                  size="sm"
                  checked={streamPreviewActive}
                  disabled={isGenerating || !streamPreviewSupported}
                  onCheckedChange={setStreamPreviewEnabled}
                  aria-label={t('drawPage.streamMode')}
                />
                <span className="text-xs font-medium text-foreground">
                  {t('drawPage.streamMode')}
                </span>
              </div>
              <span
                className={cn(
                  'text-xs',
                  streamPreviewSupported ? 'text-muted-foreground' : 'text-amber-600'
                )}
              >
                {streamPreviewSupported
                  ? t('drawPage.streamModeHint', { count: DRAW_STREAM_PARTIAL_IMAGES })
                  : t('drawPage.streamUnsupported')}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">{t('drawPage.imageQuality')}</p>
                <p
                  className={cn(
                    'mt-0.5 text-xs',
                    imageQualitySupported ? 'text-muted-foreground' : 'text-amber-600'
                  )}
                >
                  {imageQualitySupported
                    ? t('drawPage.imageQualityHint')
                    : t('drawPage.imageQualityUnsupported')}
                </p>
              </div>
              <Select
                value={drawImageQuality}
                onValueChange={(value) =>
                  setDrawImageQuality(value as ResponsesImageGenerationQuality)
                }
                disabled={isGenerating || !imageQualitySupported}
              >
                <SelectTrigger className="h-8 w-[130px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DRAW_IMAGE_QUALITY_OPTIONS.map((quality) => (
                    <SelectItem key={quality} value={quality}>
                      {t(`drawPage.imageQualityOption.${quality}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {drawMode === 'gif' && (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border bg-muted/20 p-2">
                <Button
                  variant={gifInputMode === 'text' ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 px-3 text-xs"
                  onClick={() => setGifInputMode('text')}
                  disabled={isGenerating}
                >
                  {t('drawPage.gifTextMode')}
                </Button>
                <Button
                  variant={gifInputMode === 'reference' ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 px-3 text-xs"
                  onClick={() => setGifInputMode('reference')}
                  disabled={isGenerating}
                >
                  {t('drawPage.gifReferenceMode')}
                </Button>
              </div>
            )}

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

            {drawMode === 'gif' ? (
              <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                {gifInputMode === 'text' ? (
                  <div>
                    <p className="mb-1 text-xs font-medium text-foreground">
                      {t('drawPage.gifCharacterLabel')}
                    </p>
                    <Input
                      value={gifCharacterPrompt}
                      onChange={(event) => setGifCharacterPrompt(event.target.value)}
                      placeholder={t('drawPage.gifCharacterPlaceholder')}
                    />
                  </div>
                ) : (
                  <div>
                    <p className="mb-1 text-xs font-medium text-foreground">
                      {t('drawPage.gifReferenceLabel')}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('drawPage.gifReferenceHint')}
                    </p>
                  </div>
                )}

                {gifInputMode === 'reference' && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-foreground">
                      {t('drawPage.gifCharacterOptionalLabel')}
                    </p>
                    <Input
                      value={gifCharacterPrompt}
                      onChange={(event) => setGifCharacterPrompt(event.target.value)}
                      placeholder={t('drawPage.gifCharacterOptionalPlaceholder')}
                    />
                  </div>
                )}

                <div>
                  <p className="mb-1 text-xs font-medium text-foreground">
                    {t('drawPage.gifStyleLabel')}
                  </p>
                  <Input
                    value={gifStylePrompt}
                    onChange={(event) => setGifStylePrompt(event.target.value)}
                    placeholder={t('drawPage.gifStylePlaceholder')}
                  />
                </div>

                <div className="min-h-0 flex-1">
                  <p className="mb-1 text-xs font-medium text-foreground">
                    {t('drawPage.gifActionLabel')}
                  </p>
                  <Textarea
                    value={gifActionPrompt}
                    onChange={(event) => setGifActionPrompt(event.target.value)}
                    placeholder={t('drawPage.gifActionPlaceholder')}
                    className="min-h-[180px] resize-none overflow-y-auto [field-sizing:fixed]"
                  />
                </div>

                <div className="rounded-xl border border-dashed bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                  <p>{t('drawPage.gifRulesHint')}</p>
                  <p className="mt-1">{t('drawPage.gifTransparentProviderHint')}</p>
                  <p className="mt-1">{t('drawPage.gifOptimizeDisabledHint')}</p>
                </div>
              </div>
            ) : (
              <>
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

                <p className="mt-3 shrink-0 text-xs leading-relaxed text-muted-foreground">
                  {t('drawPage.promptHint')}
                </p>
                <p className="mt-1 shrink-0 text-xs leading-relaxed text-muted-foreground">
                  {t('drawPage.pasteImageHint')}
                </p>
              </>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              className="hidden"
              onChange={handleFileInputChange}
            />

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
                {isGenerating
                  ? drawMode === 'gif'
                    ? t('drawPage.generatingGif')
                    : t('drawPage.generating')
                  : drawMode === 'gif'
                    ? t('drawPage.generateGif')
                    : t('drawPage.generate')}
              </Button>
              <Button
                variant="outline"
                onClick={
                  isGenerating
                    ? handleStop
                    : () => {
                        if (drawMode === 'gif') {
                          resetGifForm()
                        } else {
                          setPrompt('')
                          setPromptCoreSuggestion('')
                          setSelectedPromptStyleIds([])
                        }
                      }
                }
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
                {optimizationElapsedMs !== null && (
                  <div className="mt-2 flex items-center gap-2">
                    <Badge variant="secondary" className="gap-1 text-[10px] font-normal">
                      {isOptimizingPrompt && <Loader2 className="size-3 animate-spin" />}
                      {t(
                        isOptimizingPrompt
                          ? 'drawPage.optimizeElapsedRunning'
                          : 'drawPage.optimizeElapsed',
                        { seconds: formatElapsedSeconds(optimizationElapsedMs) }
                      )}
                    </Badge>
                  </div>
                )}
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-foreground">
                    {t('drawPage.promptCoreSuggestionLabel')}
                  </p>
                  <Input
                    value={promptCoreSuggestion}
                    onChange={(event) => setPromptCoreSuggestion(event.target.value)}
                    placeholder={t('drawPage.promptCoreSuggestionPlaceholder')}
                    disabled={isOptimizingPrompt}
                  />
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t('drawPage.promptCoreSuggestionHint')}
                  </p>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-foreground">
                      {t('drawPage.promptStyleLabel')}
                    </p>
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      {t('drawPage.promptStyleSelectedCount', {
                        count: selectedPromptStyleIds.length
                      })}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {DRAW_PROMPT_STYLE_OPTIONS.map((style) => {
                      const selected = selectedPromptStyleIds.includes(style.id)
                      return (
                        <Button
                          key={style.id}
                          type="button"
                          variant={selected ? 'default' : 'outline'}
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => handleTogglePromptStyle(style.id)}
                          disabled={isOptimizingPrompt}
                        >
                          {t(`drawPage.promptStyleOptions.${style.id}`)}
                        </Button>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t('drawPage.promptStyleHint')}
                  </p>
                </div>
                {optimizedPrompt.trim() ? (
                  <div className="max-h-[42vh] overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm leading-6 whitespace-pre-wrap">
                    {optimizedPrompt}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                    {t('drawPage.optimizeDialogHint')}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => handleOptimizationDialogChange(false)}>
                  {t('drawPage.cancelOptimize')}
                </Button>
                <Button
                  variant={optimizedPrompt.trim() ? 'outline' : 'default'}
                  onClick={() => void handleOptimizePrompt()}
                  disabled={isOptimizingPrompt || !prompt.trim()}
                >
                  {isOptimizingPrompt && <Loader2 className="size-4 animate-spin" />}
                  {optimizedPrompt.trim()
                    ? t('drawPage.reOptimizePrompt')
                    : t('drawPage.startOptimizePrompt')}
                </Button>
                {optimizedPrompt.trim() && (
                  <Button onClick={handleUseOptimizedPrompt} disabled={isOptimizingPrompt}>
                    {t('drawPage.useOptimizedPrompt')}
                  </Button>
                )}
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

        <div className="flex min-h-[420px] min-w-0 flex-1 flex-col md:min-h-0">
          <div className="flex min-h-0 flex-1 flex-col rounded-2xl border bg-card/50 shadow-sm">
            <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
              <div>
                <h2 className="text-sm font-semibold">
                  {drawResultTab === 'history'
                    ? t('drawPage.historySection')
                    : t('drawPage.currentResultSection')}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {drawResultTab === 'history'
                    ? t('drawPage.historySectionDesc')
                    : t('drawPage.currentResultSectionDesc')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border bg-muted/20 p-0.5">
                  <Button
                    variant={drawResultTab === 'current' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setDrawResultTab('current')}
                  >
                    {t('drawPage.currentResultTab')}
                  </Button>
                  <Button
                    variant={drawResultTab === 'history' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => setDrawResultTab('history')}
                  >
                    {t('drawPage.historyTab')}
                    <Badge variant="outline" className="ml-0.5 text-[10px] font-normal">
                      {historyRuns.length}
                    </Badge>
                  </Button>
                </div>
                {drawResultTab === 'history' && (
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
                )}
              </div>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <FadeIn key={drawResultTab} duration={0.15} className="flex-1 overflow-y-auto p-4">
                {drawResultTab === 'history' ? (
                  historyRuns.length === 0 ? (
                    <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border/70 bg-background/40 p-8 text-center">
                      <div className="max-w-sm">
                        <h3 className="text-sm font-semibold">{t('drawPage.historyEmptyTitle')}</h3>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {t('drawPage.historyEmptyDesc')}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">{historyRuns.map(renderRunCard)}</div>
                  )
                ) : currentRuns.length === 0 ? (
                  <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border/70 bg-background/40 p-8 text-center">
                    <div className="max-w-sm">
                      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                        <ImageIcon className="size-6" />
                      </div>
                      <h3 className="mt-4 text-base font-semibold">{t('drawPage.emptyTitle')}</h3>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('drawPage.emptyDesc')}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {currentRuns.map((run) => {
                      const gifAssets =
                        run.mode === 'gif'
                          ? getGifAssets(run)
                          : { grid: null, gif: null, frames: [] as DrawRunImage[] }
                      const gifFallbackImages =
                        run.mode === 'gif'
                          ? run.images.filter((image) => !image.kind || image.kind === 'generated')
                          : []
                      const errorDetails =
                        run.error?.details ??
                        (run.error && isNoImageOutputErrorMessage(run.error.message)
                          ? buildNoImageOutputDetails(run, t)
                          : undefined)

                      return (
                        <div
                          key={run.id}
                          className="rounded-2xl border bg-background/70 p-4 shadow-sm"
                        >
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
                                <Badge variant="outline" className="text-[10px] font-normal">
                                  {run.mode === 'gif'
                                    ? t('drawPage.modeGif')
                                    : t('drawPage.modeImage')}
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
                                {getRunStatusLabel(run, t)}
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

                          {run.mode === 'gif' && (
                            <div className="mt-4 flex flex-wrap items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => void handleRetryGifRun(run)}
                                disabled={run.isGenerating || !run.meta?.gif}
                              >
                                <RefreshCcw className="size-3.5" />
                                {t('drawPage.retryGif')}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() =>
                                  void handleDownloadAsset(gifAssets.gif, 'animation.gif')
                                }
                                disabled={!gifAssets.gif}
                              >
                                <Download className="size-3.5" />
                                {t('drawPage.downloadGif')}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 text-xs"
                                onClick={() => void handleDownloadAsset(gifAssets.grid, 'grid.png')}
                                disabled={!gifAssets.grid}
                              >
                                <Download className="size-3.5" />
                                {t('drawPage.downloadGrid')}
                              </Button>
                            </div>
                          )}

                          {run.isGenerating && run.previewImage && (
                            <div className="mt-4">
                              <div className="mb-2 flex items-center gap-2">
                                <span className="text-xs font-medium text-muted-foreground">
                                  {t('drawPage.realtimePreview')}
                                </span>
                                {typeof run.previewImageIndex === 'number' && (
                                  <Badge variant="outline" className="text-[10px] font-normal">
                                    {t('drawPage.previewIndex', {
                                      index: run.previewImageIndex + 1
                                    })}
                                  </Badge>
                                )}
                              </div>
                              <ImagePreview
                                src={run.previewImage.src}
                                alt={run.prompt}
                                filePath={run.previewImage.filePath}
                              />
                            </div>
                          )}

                          {run.error && (
                            <div className="mt-4">
                              <ImageGenerationErrorCard
                                code={run.error.code}
                                message={run.error.message}
                                details={errorDetails}
                              />
                            </div>
                          )}

                          {run.mode === 'gif' ? (
                            <>
                              {(gifAssets.gif || gifAssets.grid) && (
                                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                  {gifAssets.gif && (
                                    <ScaleIn key={`${run.id}-gif`}>
                                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                                        {t('drawPage.gifOutputLabel')}
                                      </p>
                                      <ImagePreview
                                        src={gifAssets.gif.src}
                                        alt={run.prompt}
                                        filePath={gifAssets.gif.filePath}
                                      />
                                    </ScaleIn>
                                  )}
                                  {gifAssets.grid && (
                                    <ScaleIn key={`${run.id}-grid`} delay={0.05}>
                                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                                        {t('drawPage.gifGridLabel')}
                                      </p>
                                      <ImagePreview
                                        src={gifAssets.grid.src}
                                        alt={run.prompt}
                                        filePath={gifAssets.grid.filePath}
                                      />
                                    </ScaleIn>
                                  )}
                                </div>
                              )}

                              {gifAssets.frames.length > 0 && (
                                <Collapsible className="mt-4 rounded-xl border bg-muted/10 px-3 py-2">
                                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-foreground">
                                    <span>
                                      {t('drawPage.framesSectionTitle', {
                                        count: gifAssets.frames.length
                                      })}
                                    </span>
                                    <ChevronDown className="size-4 text-muted-foreground" />
                                  </CollapsibleTrigger>
                                  <CollapsibleContent className="pt-3">
                                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                      {gifAssets.frames.map((image, index) => (
                                        <ScaleIn key={image.id} delay={index * 0.05}>
                                          <p className="mb-2 text-xs font-medium text-muted-foreground">
                                            {t('drawPage.gifFrameLabel', { index: index + 1 })}
                                          </p>
                                          <ImagePreview
                                            src={image.src}
                                            alt={run.prompt}
                                            filePath={image.filePath}
                                          />
                                        </ScaleIn>
                                      ))}
                                    </div>
                                  </CollapsibleContent>
                                </Collapsible>
                              )}

                              {gifFallbackImages.length > 0 &&
                                !gifAssets.gif &&
                                !gifAssets.grid &&
                                gifAssets.frames.length === 0 && (
                                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                    {gifFallbackImages.map((image, index) => (
                                      <ScaleIn key={image.id} delay={index * 0.05}>
                                        <ImagePreview
                                          src={image.src}
                                          alt={run.prompt}
                                          filePath={image.filePath}
                                        />
                                      </ScaleIn>
                                    ))}
                                  </div>
                                )}
                            </>
                          ) : (
                            run.images.length > 0 && (
                              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                {run.images.map((image, index) => (
                                  <ScaleIn key={image.id} delay={index * 0.05}>
                                    <ImagePreview
                                      src={image.src}
                                      alt={run.prompt}
                                      filePath={image.filePath}
                                    />
                                  </ScaleIn>
                                ))}
                              </div>
                            )
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </FadeIn>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  )
}
