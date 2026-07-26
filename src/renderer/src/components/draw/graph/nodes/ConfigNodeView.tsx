import { useMemo } from 'react'
import { Play, Settings2 } from 'lucide-react'
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
import { cn } from '@renderer/lib/utils'
import type { ConfigNode } from '../graph-types'
import { downstreamNodeIds, upstreamNodeIds, useGraphStore } from '../graph-store'
import { useGraphActions } from '../graph-actions'

interface Props {
  node: ConfigNode
}

const ASPECTS = ['1:1', '3:2', '2:3', '16:9', '9:16']
const COUNTS = [1, 2, 3, 4]
const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high']
const IMAGE_SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024']

function videoDurations(modelType?: string): number[] {
  if (modelType === 'openai-video') return [4, 8, 12]
  return modelType === 'xai-video' ? [5, 10, 15] : [5, 10, 15, 30]
}

function optionValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

export function ConfigNodeView({ node }: Props): React.JSX.Element {
  const { t } = useTranslation('layout')
  const updateNode = useGraphStore((s) => s.updateNode)
  const edges = useGraphStore((s) => s.edges)
  const actions = useGraphActions()

  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeImageProviderId)
  const activeModelId = useProviderStore((s) => s.activeImageModelId)
  const activeChatProviderId = useProviderStore((s) => s.activeProviderId)
  const activeChatModelId = useProviderStore((s) => s.activeModelId)

  const data = node.data
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
  const durations = videoDurations(selectedModel?.type)
  const videoResolutions = isOpenAIVideo
    ? ['720p']
    : isXaiVideo
      ? ['480p', '720p']
      : ['480p', '720p', '1080p']
  const selectedResolution =
    isOpenAIVideo
      ? '720p'
      : isXaiVideo && data.resolution === '1080p'
      ? '720p'
      : (data.resolution ?? (isXaiVideo ? '720p' : '1080p'))

  const patch = (partial: Partial<ConfigNode['data']>): void =>
    updateNode(node.id, (n) =>
      n.kind === 'config' ? { ...n, data: { ...n.data, ...partial } } : n
    )

  return (
    <>
      <div className="flex items-center gap-1.5 border-b bg-muted/40 px-2.5 py-1.5">
        <Settings2 className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('drawPage.nodeConfig', { defaultValue: 'Generate' })}
        </span>
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
              patch({
                providerId,
                modelId,
                ...(model?.type === 'openai-video' ? { resolution: '720p', duration: 4 } : {}),
                ...(model?.type === 'xai-video' && data.resolution === '1080p'
                  ? { resolution: '720p' }
                  : {}),
                ...(model?.type === 'xai-video' && data.duration === 30 ? { duration: 15 } : {})
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

        <div className="flex items-center gap-1">
          {(['image', 'video', 'text'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => patch({ mode, providerId: undefined, modelId: undefined })}
              className={cn(
                'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                data.mode === mode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              )}
            >
              {mode === 'image'
                ? t('drawPage.modeImage')
                : mode === 'video'
                  ? t('drawPage.modeVideo', { defaultValue: 'Video' })
                  : t('drawPage.modeText', { defaultValue: 'Text' })}
            </button>
          ))}
        </div>

        {(data.mode === 'image' || data.mode === 'video') && (
          <div className="flex flex-wrap gap-1">
            {ASPECTS.map((aspect) => (
              <button
                key={aspect}
                type="button"
                onClick={() => patch({ aspect })}
                className={cn(
                  'rounded-md border px-1.5 py-0.5 text-[10px]',
                  (data.aspect ?? '1:1') === aspect
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
                    (data.duration ?? 5) === d
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground'
                  )}
                >
                  {d}s
                </button>
              ))}
            </div>
            {!isOpenAIVideo && (
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
                    ['cameraFixed', 'Fixed camera', data.cameraFixed ?? false]
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
          onClick={() => actions.runConfigNode(node.id)}
          className="mt-auto flex items-center justify-center gap-1.5 rounded-lg bg-primary py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Play className="size-3.5" />
          {t('drawPage.generate')}
        </button>
      </div>
    </>
  )
}
