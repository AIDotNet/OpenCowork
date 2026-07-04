import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import { Check, ImagePlus, Loader2, PawPrint, RotateCcw, Wand2, X } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { getPetsDir, usePetSkinStore } from '@renderer/stores/pet-skin-store'
import {
  PET_POSE_KEYS,
  buildPetPosePrompt,
  buildPetPosePromptFromReference,
  type PetPoseKey
} from '@renderer/lib/pet/pet-pose-prompts'
import { useProviderStore } from '@renderer/stores/provider-store'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { streamNativeOpenAIImages } from '@renderer/lib/api/openai-images-provider'
import type { ContentBlock, ProviderConfig, UnifiedMessage } from '@renderer/lib/api/types'

interface ReferenceImage {
  data: string
  mediaType: string
  preview: string
}

interface PoseResult {
  filePath?: string
  dataUrl?: string
  ms?: number
}

interface GenerationState {
  running: boolean
  current: PetPoseKey | null
  selected: PetPoseKey[]
  results: Partial<Record<PetPoseKey, PoseResult>>
  errors: Partial<Record<PetPoseKey, string>>
  startedAt: number
}

type ImageQuality = 'auto' | 'high' | 'medium' | 'low'

function toOptionValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

function fromOptionValue(value: string): [string, string] {
  const index = value.indexOf('::')
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 2)]
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function PetStudioTab(): React.JSX.Element {
  const { t } = useTranslation('pet')
  const providers = useProviderStore((s) => s.providers)

  const [selection, setSelection] = useState('')
  const [quality, setQuality] = useState<ImageQuality>('auto')
  const [subject, setSubject] = useState('')
  const [selectedPoses, setSelectedPoses] = useState<Set<PetPoseKey>>(new Set(PET_POSE_KEYS))
  const [skinNameDraft, setSkinNameDraft] = useState('')
  const [savingSkin, setSavingSkin] = useState(false)
  const [refImage, setRefImage] = useState<ReferenceImage | null>(null)
  const [gen, setGen] = useState<GenerationState | null>(null)
  const [, setNowTick] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const refFileRef = useRef<HTMLInputElement | null>(null)
  const poseStartedAtRef = useRef(0)

  const attachReferenceFile = (file: File | null | undefined): void => {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return
      setRefImage({
        data: dataUrl.slice(comma + 1),
        mediaType: file.type || 'image/png',
        preview: dataUrl
      })
    }
    reader.readAsDataURL(file)
  }

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // 1s ticker for live elapsed feedback while generating
  useEffect(() => {
    if (!gen?.running) return
    const timer = window.setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [gen?.running])

  const imageModelGroups = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          models: provider.models.filter(
            (model) => model.enabled && (model.category ?? 'chat') === 'image'
          )
        }))
        .filter((group) => group.models.length > 0),
    [providers]
  )

  const [providerId, modelId] = fromOptionValue(selection)
  const isGptImage = modelId.includes('gpt-image')

  const togglePose = (pose: PetPoseKey): void => {
    if (gen?.running) return
    setSelectedPoses((prev) => {
      const next = new Set(prev)
      if (next.has(pose)) {
        if (next.size <= 1) return prev
        next.delete(pose)
      } else {
        next.add(pose)
      }
      return next
    })
  }

  const buildConfig = (): ProviderConfig | null => {
    const baseConfig = useProviderStore.getState().getProviderConfigById(providerId, modelId)
    if (!baseConfig) return null
    if (!isGptImage) return baseConfig
    // gpt-image models support a real alpha channel + quality control
    const body: Record<string, unknown> = {
      ...baseConfig.requestOverrides?.body,
      background: 'transparent'
    }
    if (quality !== 'auto') body.quality = quality
    return {
      ...baseConfig,
      requestOverrides: { ...baseConfig.requestOverrides, body }
    }
  }

  const generatePoses = async (poses: PetPoseKey[]): Promise<void> => {
    if (!providerId || !modelId) {
      toast.error(t('studio.selectModelFirst'))
      return
    }
    if (!subject.trim() && !refImage) {
      toast.error(t('studio.subjectRequired'))
      return
    }

    try {
      await ensureProviderAuthReady(providerId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return
    }

    const config = buildConfig()
    if (!config) {
      toast.error(t('studio.selectModelFirst'))
      return
    }

    const controller = new AbortController()
    abortRef.current = controller

    setGen((prev) => {
      const keepResults = prev && !prev.running ? prev.results : {}
      const keepErrors = prev && !prev.running ? { ...prev.errors } : {}
      for (const pose of poses) delete keepErrors[pose]
      const selected =
        prev && !prev.running ? Array.from(new Set([...prev.selected, ...poses])) : [...poses]
      return {
        running: true,
        current: poses[0],
        selected,
        results: { ...keepResults },
        errors: keepErrors,
        startedAt: Date.now()
      }
    })

    for (const pose of poses) {
      if (controller.signal.aborted) break
      poseStartedAtRef.current = Date.now()
      setGen((prev) => (prev ? { ...prev, current: pose } : prev))
      try {
        // With a reference image the native worker routes through the image
        // edit endpoint; the prompt then only changes the pose.
        const content: string | ContentBlock[] = refImage
          ? [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  mediaType: refImage.mediaType,
                  data: refImage.data
                }
              },
              { type: 'text', text: buildPetPosePromptFromReference(pose, subject) }
            ]
          : buildPetPosePrompt(pose, subject)
        const messages: UnifiedMessage[] = [
          { id: nanoid(), role: 'user', content, createdAt: Date.now() }
        ]
        let got: PoseResult | null = null
        for await (const event of streamNativeOpenAIImages({
          messages,
          config,
          signal: controller.signal
        })) {
          if (event.type === 'image_generated' && event.imageBlock?.source) {
            const source = event.imageBlock.source
            got = {
              filePath: source.filePath,
              dataUrl: source.data
                ? `data:${source.mediaType ?? 'image/png'};base64,${source.data}`
                : source.url,
              ms: Date.now() - poseStartedAtRef.current
            }
          } else if (event.type === 'image_error') {
            throw new Error(event.imageError?.message ?? t('studio.unknownError'))
          }
        }
        if (got?.filePath) {
          const result = got
          setGen((prev) =>
            prev ? { ...prev, results: { ...prev.results, [pose]: result } } : prev
          )
        } else if (!controller.signal.aborted) {
          setGen((prev) =>
            prev ? { ...prev, errors: { ...prev.errors, [pose]: t('studio.emptyResult') } } : prev
          )
        }
      } catch (error) {
        if (controller.signal.aborted) break
        const message = error instanceof Error ? error.message : String(error)
        setGen((prev) => (prev ? { ...prev, errors: { ...prev.errors, [pose]: message } } : prev))
      }
    }

    abortRef.current = null
    setGen((prev) => (prev ? { ...prev, running: false, current: null } : prev))
  }

  // Persist the generated set as a directory under ~/.open-cowork/pets:
  // one folder per pet, with <pose>.png files plus a pet.json metadata file.
  const saveSkin = async (bind: boolean): Promise<void> => {
    if (!gen || gen.running || savingSkin) return
    const sources: Array<[PetPoseKey, string]> = []
    for (const pose of PET_POSE_KEYS) {
      const filePath = gen.results[pose]?.filePath
      if (filePath) sources.push([pose, filePath])
    }
    if (sources.length === 0) return

    setSavingSkin(true)
    try {
      const name = skinNameDraft.trim() || subject.trim()
      const slug =
        name
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 24) || 'pet'
      const dirName = `${slug}-${Date.now().toString(36)}`
      const dirPath = `${await getPetsDir()}/${dirName}`
      await ipcClient.invoke('fs:mkdir', { path: dirPath })

      for (const [pose, source] of sources) {
        const read = (await ipcClient.invoke('fs:read-file-binary', { path: source })) as {
          data?: string
          error?: string
        } | null
        if (!read?.data) throw new Error(read?.error ?? `failed to read ${source}`)
        const write = (await ipcClient.invoke('fs:write-file-binary', {
          path: `${dirPath}/${pose}.png`,
          data: read.data
        })) as { success?: boolean; error?: string } | null
        if (write?.error) throw new Error(write.error)
      }

      await ipcClient.invoke('fs:write-file', {
        path: `${dirPath}/pet.json`,
        content: JSON.stringify(
          { name, subject: subject.trim(), modelId, createdAt: Date.now() },
          null,
          2
        )
      })

      const skinStore = usePetSkinStore.getState()
      await skinStore.scan()
      if (bind) skinStore.setActiveSkin(dirName)
      void ipcClient.invoke('pet:sync', {
        kind: 'skin',
        payload: { activeSkinId: usePetSkinStore.getState().activeSkinId }
      })
      setGen(null)
      setSkinNameDraft('')
      toast.success(t(bind ? 'studio.savedAndBound' : 'studio.saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingSkin(false)
    }
  }

  const doneCount = gen ? Object.keys(gen.results).length : 0
  const failedPoses = gen ? (Object.keys(gen.errors) as PetPoseKey[]) : []
  const processedCount = doneCount + failedPoses.length
  const totalCount = gen?.selected.length ?? 0
  const progressPct = totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 0

  // The preview mirrors the pose selection until a run starts, then it
  // tracks that run's pose set (in canonical pose order either way).
  const displayPoses = gen
    ? PET_POSE_KEYS.filter((pose) => gen.selected.includes(pose))
    : PET_POSE_KEYS.filter((pose) => selectedPoses.has(pose))

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('studio.desc')}</p>

      {imageModelGroups.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
          {t('studio.noImageModels')}
        </p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {/* Left: generation parameters */}
          <aside className="w-full space-y-3 lg:w-72 lg:shrink-0">
            <section className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-xs font-medium">{t('studio.stepModel')}</p>
              <Select value={selection} onValueChange={setSelection} disabled={gen?.running}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue placeholder={t('studio.modelPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {imageModelGroups.map((group) => (
                    <SelectGroup key={group.provider.id}>
                      <SelectLabel className="text-[11px] font-normal text-muted-foreground">
                        {group.provider.name}
                      </SelectLabel>
                      {group.models.map((model) => (
                        <SelectItem
                          key={toOptionValue(group.provider.id, model.id)}
                          value={toOptionValue(group.provider.id, model.id)}
                          className="pl-6 text-xs"
                        >
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {isGptImage ? (
                <Select
                  value={quality}
                  onValueChange={(v) => setQuality(v as ImageQuality)}
                  disabled={gen?.running}
                >
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['auto', 'high', 'medium', 'low'] as const).map((q) => (
                      <SelectItem key={q} value={q} className="text-xs">
                        {t(`studio.quality.${q}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </section>

            <section className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-xs font-medium">{t('studio.stepSubject')}</p>
              <Textarea
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={t('studio.subjectPlaceholder')}
                disabled={gen?.running}
                rows={3}
                className="resize-none text-sm"
              />
              <input
                ref={refFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  attachReferenceFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              {refImage ? (
                <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 p-1.5">
                  <img
                    src={refImage.preview}
                    alt=""
                    className="size-12 rounded-md object-contain"
                  />
                  <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                    {t('studio.referenceActive')}
                  </span>
                  <button
                    type="button"
                    disabled={gen?.running}
                    onClick={() => setRefImage(null)}
                    className="rounded-md p-1 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={gen?.running}
                  onClick={() => refFileRef.current?.click()}
                >
                  <ImagePlus className="mr-1 size-3" />
                  {t('studio.uploadReference')}
                </Button>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {refImage ? t('studio.referenceHint') : t('studio.subjectHint')}
              </p>
            </section>

            <section className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">{t('studio.stepPoses')}</p>
                <button
                  type="button"
                  disabled={gen?.running}
                  onClick={() => setSelectedPoses(new Set(PET_POSE_KEYS))}
                  className="text-[11px] text-primary hover:underline"
                >
                  {t('studio.selectAll')}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PET_POSE_KEYS.map((pose) => {
                  const active = selectedPoses.has(pose)
                  return (
                    <button
                      key={pose}
                      type="button"
                      disabled={gen?.running}
                      onClick={() => togglePose(pose)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                        active
                          ? 'border-primary/50 bg-primary/15 text-primary'
                          : 'border-border/70 text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {t(`poses.${pose}`)}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('studio.posesSelected', {
                  count: selectedPoses.size,
                  total: PET_POSE_KEYS.length
                })}
              </p>
            </section>

            <div className="space-y-2">
              {gen?.running ? (
                <>
                  <Button size="sm" variant="secondary" className="h-8 w-full" disabled>
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                    {t('studio.generating', { done: processedCount, total: totalCount })}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-full"
                    onClick={() => abortRef.current?.abort()}
                  >
                    {t('studio.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    className="h-8 w-full"
                    onClick={() => void generatePoses(Array.from(selectedPoses))}
                  >
                    <Wand2 className="mr-1 size-3.5" />
                    {t('studio.generate')}
                  </Button>
                  {failedPoses.length > 0 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-8 w-full"
                      onClick={() => void generatePoses(failedPoses)}
                    >
                      <RotateCcw className="mr-1 size-3.5" />
                      {t('studio.retryFailed', { count: failedPoses.length })}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </aside>

          {/* Right: live generation preview */}
          <section className="min-w-0 flex-1 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{t('studio.previewTitle')}</p>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {gen?.running
                  ? `${t('studio.generating', { done: processedCount, total: totalCount })} · ` +
                    t('studio.elapsed', { time: formatElapsed(Date.now() - gen.startedAt) })
                  : gen
                    ? t('studio.previewDone', { done: doneCount, total: totalCount })
                    : t('studio.posesSelected', {
                        count: selectedPoses.size,
                        total: PET_POSE_KEYS.length
                      })}
              </span>
            </div>

            {gen ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">{t('studio.previewEmpty')}</p>
            )}

            {/* The pose grid scrolls on its own so the header, progress bar
                and save controls stay visible. */}
            <div className="max-h-[56vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
                {displayPoses.map((pose) => {
                  const result = gen?.results[pose]
                  const error = gen?.errors[pose]
                  const isCurrent = gen?.running && gen.current === pose
                  return (
                    <div
                      key={pose}
                      className={`group relative flex flex-col rounded-lg border p-2 ${
                        error
                          ? 'border-red-400/40 bg-red-400/5'
                          : 'border-border/60 bg-background/60'
                      }`}
                    >
                      <div className="flex aspect-square w-full items-center justify-center overflow-hidden">
                        {result?.dataUrl ? (
                          <img
                            src={result.dataUrl}
                            alt={pose}
                            className="max-h-full max-w-full object-contain"
                          />
                        ) : isCurrent ? (
                          <div className="flex flex-col items-center gap-1">
                            <Loader2 className="size-5 animate-spin text-muted-foreground" />
                            <span className="text-[10px] tabular-nums text-muted-foreground">
                              {formatElapsed(Date.now() - poseStartedAtRef.current)}
                            </span>
                          </div>
                        ) : error ? (
                          <X className="size-5 text-red-400" />
                        ) : (
                          <PawPrint className="size-5 text-muted-foreground/30" />
                        )}
                      </div>
                      <div className="mt-1 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                        <span>{t(`poses.${pose}`)}</span>
                        {result?.ms ? (
                          <span className="tabular-nums">{Math.round(result.ms / 1000)}s</span>
                        ) : null}
                      </div>
                      {error ? (
                        <span
                          className="line-clamp-2 w-full text-center text-[10px] leading-tight text-red-400"
                          title={error}
                        >
                          {error}
                        </span>
                      ) : null}
                      {gen && !gen.running && (result || error) ? (
                        <button
                          type="button"
                          title={t('studio.retryPose')}
                          onClick={() => void generatePoses([pose])}
                          className="absolute right-1.5 top-1.5 hidden rounded-md bg-background/90 p-1 text-muted-foreground shadow group-hover:block hover:text-foreground"
                        >
                          <RotateCcw className="size-3" />
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>

            {gen && !gen.running ? (
              <div className="space-y-2 border-t border-border/60 pt-3">
                {failedPoses.length > 0 ? (
                  <p className="text-xs text-amber-500">{t('studio.partialWarning')}</p>
                ) : null}
                {doneCount > 0 ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Input
                      value={skinNameDraft}
                      onChange={(e) => setSkinNameDraft(e.target.value)}
                      placeholder={t('studio.skinNamePlaceholder')}
                      maxLength={30}
                      className="h-8 max-w-52 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="h-8"
                        disabled={savingSkin}
                        onClick={() => void saveSkin(true)}
                      >
                        <Check className="mr-1 size-3.5" />
                        {t('studio.saveBind')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-8"
                        disabled={savingSkin}
                        onClick={() => void saveSkin(false)}
                      >
                        {t('studio.saveOnly')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8"
                        onClick={() => setGen(null)}
                      >
                        {t('studio.discard')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setGen(null)}>
                    {t('studio.discard')}
                  </Button>
                )}
              </div>
            ) : null}
          </section>
        </div>
      )}
    </div>
  )
}
