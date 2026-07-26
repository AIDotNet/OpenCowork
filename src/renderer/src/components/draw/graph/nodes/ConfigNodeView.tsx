import { useEffect, useMemo, useState } from 'react'
import { ImagePlus, MessageSquareText, Play, Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ModelIcon } from '@renderer/components/settings/provider-icons'
import { useProviderStore } from '@renderer/stores/provider-store'
import { isSeedanceStructuredModel } from '@renderer/lib/api/seedance-video-provider'
import { cn } from '@renderer/lib/utils'
import type { ConfigNode, ImageNode } from '../graph-types'
import { downstreamNodeIds, upstreamNodeIds, useGraphStore } from '../graph-store'
import { useGraphActions } from '../graph-actions'

interface Props {
  node: ConfigNode
}

const ASPECTS = ['1:1', '3:2', '2:3', '16:9', '9:16']
const COUNTS = [1, 2, 3, 4]
const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high']
const IMAGE_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024']
const SORA_VIDEO_SIZES = [
  { value: '1280x720', aspect: '16:9', resolution: '720p' },
  { value: '720x1280', aspect: '9:16', resolution: '720p' },
  { value: '1792x1024', aspect: '16:9', resolution: '1024p' },
  { value: '1024x1792', aspect: '9:16', resolution: '1024p' }
] as const

// Seedance 2.x accepts any whole 4-15s; these are the chips that fit the node width.
const SEEDANCE2_DURATIONS = [4, 5, 6, 8, 10, 12, 15]
const SEEDANCE2_ASPECTS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']

function videoDurations(modelType?: string, structuredSeedance?: boolean): number[] {
  if (modelType === 'openai-video') return [4, 8, 12]
  if (structuredSeedance) return SEEDANCE2_DURATIONS
  return modelType === 'xai-video' ? [5, 10, 15] : [5, 10, 15, 30]
}

/** Seedance 2.0 fast/mini cap out at 720p; the standard model goes to 1080p. */
function isSeedance2Capped720p(modelId?: string): boolean {
  return /-(fast|mini)-/i.test(modelId ?? '')
}

function optionValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

function findUpstreamImages(
  nodes: ReturnType<typeof useGraphStore.getState>['nodes'],
  edges: ReturnType<typeof useGraphStore.getState>['edges'],
  nodeId: string
): ImageNode[] {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  const seen = new Set<string>([nodeId])
  const images: ImageNode[] = []
  const visit = (id: string): void => {
    for (const upstreamId of upstreamNodeIds(edges, id)) {
      if (seen.has(upstreamId)) continue
      seen.add(upstreamId)
      const upstream = byId.get(upstreamId)
      if (!upstream) continue
      if (upstream.kind === 'image' && upstream.data.src) images.push(upstream)
      if (upstream.kind === 'config') {
        visit(upstream.id)
      }
    }
  }
  visit(nodeId)
  return images
}

export function ConfigNodeView({ node }: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const updateNode = useGraphStore((s) => s.updateNode)
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const actions = useGraphActions()

  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeImageProviderId)
  const activeModelId = useProviderStore((s) => s.activeImageModelId)
  const activeChatProviderId = useProviderStore((s) => s.activeProviderId)
  const activeChatModelId = useProviderStore((s) => s.activeModelId)

  const data = node.data
  const header =
    data.mode === 'video'
      ? {
          icon: Video,
          label: t('drawPage.nodeVideoGeneration', { defaultValue: 'Video generation' })
        }
      : data.mode === 'text'
        ? {
            icon: MessageSquareText,
            label: t('drawPage.nodeTextGeneration', { defaultValue: 'Text generation' })
          }
        : {
            icon: ImagePlus,
            label: t('drawPage.nodeImageGeneration', { defaultValue: 'Image generation' })
          }
  const HeaderIcon = header.icon
  const wantCategory = data.mode === 'video' ? 'video' : data.mode === 'text' ? 'chat' : 'image'

  const modelGroups = useMemo(
    () =>
      providers
        .map((provider) => ({
          provider,
          models: provider.models.filter((m) => (m.category ?? 'chat') === wantCategory)
        }))
        .filter((g) => g.models.length > 0),
    [providers, wantCategory]
  )

  const upstream = upstreamNodeIds(edges, node.id).length
  const downstream = downstreamNodeIds(edges, node.id).length

  const selectedValue =
    data.providerId && data.modelId
      ? optionValue(data.providerId, data.modelId)
      : data.mode === 'text' && activeChatProviderId && activeChatModelId
        ? optionValue(activeChatProviderId, activeChatModelId)
        : data.mode === 'image' && activeProviderId && activeModelId
          ? optionValue(activeProviderId, activeModelId)
          : undefined

  const selectedModel = useMemo(() => {
    if (!selectedValue) return undefined
    const [providerId, modelId] = selectedValue.split('::')
    return providers
      .find((provider) => provider.id === providerId)
      ?.models.find((model) => model.id === modelId)
  }, [providers, selectedValue])
  const isXaiVideo = data.mode === 'video' && selectedModel?.type === 'xai-video'
  const isOpenAIVideo = data.mode === 'video' && selectedModel?.type === 'openai-video'
  const isSeedance2 =
    data.mode === 'video' &&
    selectedModel?.type === 'seedance-video' &&
    isSeedanceStructuredModel(selectedModel?.id)
  const seedance2Capped720p = isSeedance2 && isSeedance2Capped720p(selectedModel?.id)
  const durations = videoDurations(selectedModel?.type, isSeedance2)
  const aspects = isOpenAIVideo ? ['16:9', '9:16'] : isSeedance2 ? SEEDANCE2_ASPECTS : ASPECTS
  const selectedAspect =
    isOpenAIVideo && !['16:9', '9:16'].includes(data.aspect ?? '') ? '16:9' : (data.aspect ?? '1:1')
  const selectedDuration =
    isOpenAIVideo && ![4, 8, 12].includes(data.duration ?? 4)
      ? 4
      : isSeedance2 && !SEEDANCE2_DURATIONS.includes(data.duration ?? 5)
        ? 5
        : (data.duration ?? (isOpenAIVideo ? 4 : 5))
  const videoResolutions = isOpenAIVideo
    ? ['720p', '1024p']
    : isXaiVideo || seedance2Capped720p
      ? ['480p', '720p']
      : ['480p', '720p', '1080p']
  const selectedResolution = isOpenAIVideo
    ? ['720p', '1024p'].includes(data.resolution ?? '')
      ? (data.resolution ?? '720p')
      : '720p'
    : (isXaiVideo || seedance2Capped720p) && data.resolution === '1080p'
      ? '720p'
      : (data.resolution ?? (isXaiVideo ? '720p' : '1080p'))
  const selectedSoraSize = SORA_VIDEO_SIZES.find(
    (size) => size.aspect === selectedAspect && size.resolution === selectedResolution
  )?.value
  // Shared by the Sora size check and the Seedance first/last-frame toggle. Keyed on
  // data.mode rather than the per-protocol flags so the React Compiler can verify the
  // dependencies (isSeedance2 calls an imported predicate it can't prove pure).
  const videoReferences = useMemo(
    () => (data.mode === 'video' ? findUpstreamImages(nodes, edges, node.id) : []),
    [data.mode, edges, node.id, nodes]
  )
  const soraReferences = isOpenAIVideo ? videoReferences : []
  const soraReference = soraReferences[0]
  const [soraReferenceSize, setSoraReferenceSize] = useState<string>()
  // Seedance 2.x can treat exactly two connected images as first/last keyframes.
  // With any other count the roles are meaningless, so the toggle stays hidden.
  const showFrameRole = isSeedance2 && videoReferences.length === 2
  const frameRole = data.frameRole ?? 'auto'

  useEffect(() => {
    setSoraReferenceSize(undefined)
    const src = soraReference?.data.src
    if (!src) return

    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled) setSoraReferenceSize(`${image.naturalWidth}x${image.naturalHeight}`)
    }
    image.onerror = () => {
      if (!cancelled) setSoraReferenceSize('invalid')
    }
    image.src = src
    return () => {
      cancelled = true
      image.src = ''
    }
  }, [soraReference?.data.src])

  const hasSoraReference = !!soraReference
  const selectedSoraSizeSupported =
    !hasSoraReference || (!!soraReferenceSize && soraReferenceSize === selectedSoraSize)
  const soraReferenceMatchesKnownSize = SORA_VIDEO_SIZES.some(
    (size) => size.value === soraReferenceSize
  )

  const patch = (partial: Partial<ConfigNode['data']>): void =>
    updateNode(node.id, (n) =>
      n.kind === 'config' ? { ...n, data: { ...n.data, ...partial } } : n
    )

  return (
    <>
      <div className="flex items-center gap-1.5 border-b bg-muted/40 px-2.5 py-1.5">
        <HeaderIcon className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground">{header.label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          {t('drawPage.nodeUpstream', { defaultValue: 'in' })} {upstream} ·{' '}
          {t('drawPage.nodeDownstream', { defaultValue: 'out' })} {downstream}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-2.5" data-nodrag>
        <Select
          value={selectedValue}
          onValueChange={(value) => {
            const [providerId, modelId] = value.split('::')
            if (providerId && modelId) {
              const model = providers
                .find((provider) => provider.id === providerId)
                ?.models.find((candidate) => candidate.id === modelId)
              const nextIsSeedance2 =
                model?.type === 'seedance-video' && isSeedanceStructuredModel(model.id)
              patch({
                providerId,
                modelId,
                ...(model?.type === 'openai-video'
                  ? { aspect: '16:9', resolution: '720p', duration: 4 }
                  : {}),
                ...(model?.type === 'xai-video' && data.resolution === '1080p'
                  ? { resolution: '720p' }
                  : {}),
                ...(model?.type === 'xai-video' && data.duration === 30 ? { duration: 15 } : {}),
                // Seedance 2.x: 4-15s only, and fast/mini stop at 720p.
                ...(nextIsSeedance2
                  ? {
                      ...(!SEEDANCE2_DURATIONS.includes(data.duration ?? 5) ? { duration: 5 } : {}),
                      ...(isSeedance2Capped720p(model.id) && data.resolution === '1080p'
                        ? { resolution: '720p' }
                        : {})
                    }
                  : {}),
                // `adaptive` is a Seedance 2.x-only ratio. Letting it leak into a 1.x
                // `--ratio` flag or an xAI aspect_ratio produces an opaque API error.
                ...(data.aspect === 'adaptive' && !nextIsSeedance2 ? { aspect: '16:9' } : {})
              })
            }
          }}
        >
          <SelectTrigger className="h-7 w-full text-[11px]">
            <SelectValue
              placeholder={t('drawPage.selectModel', { defaultValue: 'Select model' })}
            />
          </SelectTrigger>
          <SelectContent>
            {modelGroups.map((group) => (
              <SelectGroup key={group.provider.id}>
                <SelectLabel className="text-[10px]">{group.provider.name}</SelectLabel>
                {group.models.map((model) => (
                  <SelectItem
                    key={model.id}
                    value={optionValue(group.provider.id, model.id)}
                    className="text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ModelIcon icon={model.icon} size={12} />
                      <span className="truncate">{model.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        {(data.mode === 'image' || (data.mode === 'video' && !isOpenAIVideo)) && (
          <div className="flex flex-wrap gap-1">
            {aspects.map((aspect) => (
              <button
                key={aspect}
                type="button"
                onClick={() => patch({ aspect })}
                className={cn(
                  'rounded-md border px-1.5 py-0.5 text-[10px]',
                  selectedAspect === aspect
                    ? 'border-primary text-primary'
                    : 'border-border text-muted-foreground'
                )}
              >
                {aspect}
              </button>
            ))}
          </div>
        )}

        {data.mode === 'video' && (
          <div className="flex flex-col gap-1.5">
            {isOpenAIVideo && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-12 text-[10px] text-muted-foreground">
                  {t('drawPage.imageSize', { defaultValue: 'Size' })}
                </span>
                {SORA_VIDEO_SIZES.map((size) => (
                  <button
                    key={size.value}
                    type="button"
                    disabled={hasSoraReference && soraReferenceSize !== size.value}
                    onClick={() => patch({ aspect: size.aspect, resolution: size.resolution })}
                    className={cn(
                      'rounded-md border px-1.5 py-0.5 text-[10px] disabled:cursor-not-allowed disabled:opacity-35',
                      selectedSoraSize === size.value
                        ? 'border-primary text-primary'
                        : 'border-border text-muted-foreground'
                    )}
                  >
                    {size.value}
                  </button>
                ))}
              </div>
            )}
            {isOpenAIVideo && hasSoraReference && soraReferenceSize && (
              <p
                className={cn(
                  'text-[10px]',
                  selectedSoraSizeSupported ? 'text-muted-foreground' : 'text-destructive'
                )}
              >
                {soraReferenceMatchesKnownSize
                  ? t('drawPage.soraReferenceExactSize', {
                      defaultValue: 'Reference image: {{size}}. Sora requires an exact size match.',
                      size: soraReferenceSize
                    })
                  : t('drawPage.soraReferenceUnsupportedSize', {
                      defaultValue:
                        'Reference image {{size}} does not match a supported Sora size. Resize or crop it first.',
                      size: soraReferenceSize === 'invalid' ? '?' : soraReferenceSize
                    })}
              </p>
            )}
            {isOpenAIVideo && soraReferences.length > 1 && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400">
                {t('drawPage.soraSingleReference', {
                  defaultValue:
                    'Sora accepts one input reference. Only the first connected image will be uploaded.'
                })}
              </p>
            )}
            {!isOpenAIVideo && (
              <div className="flex items-center gap-1">
                <span className="w-12 text-[10px] text-muted-foreground">
                  {t('drawPage.resolution', { defaultValue: 'Res' })}
                </span>
                {videoResolutions.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => patch({ resolution: r })}
                    className={cn(
                      'rounded-md border px-1.5 py-0.5 text-[10px]',
                      selectedResolution === r
                        ? 'border-primary text-primary'
                        : 'border-border text-muted-foreground'
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
            {showFrameRole && (
              <>
                <div className="flex items-center gap-1">
                  <span className="w-12 text-[10px] text-muted-foreground">
                    {t('drawPage.frameRole', { defaultValue: 'Frames' })}
                  </span>
                  {(
                    [
                      ['auto', t('drawPage.frameRoleAuto', { defaultValue: 'Reference' })],
                      [
                        'first-last',
                        t('drawPage.frameRoleFirstLast', { defaultValue: 'First → Last' })
                      ]
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => patch({ frameRole: value })}
                      className={cn(
                        'rounded-md border px-1.5 py-0.5 text-[10px]',
                        frameRole === value
                          ? 'border-primary text-primary'
                          : 'border-border text-muted-foreground'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {frameRole === 'first-last' && (
                  <p className="text-[10px] text-muted-foreground">
                    {t('drawPage.frameRoleHint', {
                      defaultValue: 'Frame order follows connection order.'
                    })}
                  </p>
                )}
              </>
            )}
            <div className="flex items-center gap-1">
              <span className="w-12 text-[10px] text-muted-foreground">
                {t('drawPage.duration', { defaultValue: 'Dur' })}
              </span>
              {durations.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => patch({ duration: d })}
                  className={cn(
                    'rounded-md border px-1.5 py-0.5 text-[10px]',
                    selectedDuration === d
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground'
                  )}
                >
                  {d}s
                </button>
              ))}
            </div>
            {/* Seedance 2.x output is fixed at 24fps and rejects the field. */}
            {!isOpenAIVideo && !isSeedance2 && (
              <div className="flex items-center gap-1">
                <span className="w-12 text-[10px] text-muted-foreground">FPS</span>
                {[24, 30, 60].map((fps) => (
                  <button
                    key={fps}
                    type="button"
                    onClick={() => patch({ fps })}
                    className={cn(
                      'rounded-md border px-1.5 py-0.5 text-[10px]',
                      (data.fps ?? 24) === fps
                        ? 'border-primary text-primary'
                        : 'border-border text-muted-foreground'
                    )}
                  >
                    {fps}
                  </button>
                ))}
              </div>
            )}
            {!isXaiVideo && !isOpenAIVideo && (
              <>
                <div className="flex items-center gap-1">
                  <span className="w-12 text-[10px] text-muted-foreground">
                    {t('drawPage.seed', { defaultValue: 'Seed' })}
                  </span>
                  <input
                    type="number"
                    min={-1}
                    max={2147483647}
                    value={data.seed ?? -1}
                    onChange={(event) => patch({ seed: Number(event.target.value) })}
                    className="h-6 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-[10px] outline-none focus:border-primary"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {[
                    ['watermark', 'Watermark', data.watermark ?? false],
                    // 2.x dropped camera_fixed (camera motion goes in the prompt) and
                    // added generate_audio, whose server-side default is on.
                    ...(isSeedance2
                      ? [['generateAudio', 'Audio', data.generateAudio ?? true] as const]
                      : [['cameraFixed', 'Fixed camera', data.cameraFixed ?? false] as const])
                  ].map(([key, label, enabled]) => (
                    <button
                      key={key as string}
                      type="button"
                      onClick={() => patch({ [key as string]: !enabled })}
                      className={cn(
                        'rounded-md border px-1.5 py-0.5 text-[10px]',
                        enabled
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground'
                      )}
                    >
                      {t(`drawPage.${key}`, { defaultValue: label as string })}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {data.mode === 'image' && (
          <div className="flex flex-col gap-1.5">
            {[
              ['drawPage.imageQuality', 'Quality', IMAGE_QUALITIES, data.quality ?? 'auto'],
              ['drawPage.imageSize', 'Size', IMAGE_SIZES, data.size ?? 'auto']
            ].map(([labelKey, fallback, options, value]) => (
              <div key={labelKey as string} className="flex items-center gap-1">
                <span className="w-12 text-[10px] text-muted-foreground">
                  {t(labelKey as string, { defaultValue: fallback as string })}
                </span>
                {(options as string[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() =>
                      patch(
                        labelKey === 'drawPage.imageQuality'
                          ? { quality: option }
                          : { size: option }
                      )
                    }
                    className={cn(
                      'rounded-md border px-1.5 py-0.5 text-[10px]',
                      value === option
                        ? 'border-primary text-primary'
                        : 'border-border text-muted-foreground'
                    )}
                  >
                    {option === 'auto' ? 'Auto' : option}
                  </button>
                ))}
              </div>
            ))}
            <div className="flex items-center gap-1">
              <span className="w-12 text-[10px] text-muted-foreground">
                {t('drawPage.nodeCount', { defaultValue: 'Count' })}
              </span>
              {COUNTS.map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => patch({ count })}
                  className={cn(
                    'grid size-5 place-items-center rounded-md border text-[10px]',
                    (data.count ?? 1) === count
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground'
                  )}
                >
                  {count}
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          disabled={isOpenAIVideo && !selectedSoraSizeSupported}
          onClick={() => actions.runConfigNode(node.id)}
          className="mt-auto flex items-center justify-center gap-1.5 rounded-lg bg-primary py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play className="size-3.5" />
          {t('drawPage.generate')}
        </button>
      </div>
    </>
  )
}
