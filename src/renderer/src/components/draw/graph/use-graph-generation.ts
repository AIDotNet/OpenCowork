import { useMemo } from 'react'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { streamNativeOpenAIImages } from '@renderer/lib/api/openai-images-provider'
import type {
  AIModelConfig,
  AIProvider,
  ContentBlock,
  ImageBlock,
  ProviderConfig,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { optimizeDrawPrompt } from '@renderer/lib/draw-prompt-optimizer'
import {
  buildSeedanceCommands,
  type SeedanceVideoParams
} from '@renderer/lib/api/seedance-video-provider'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { filePathToMediaUrl } from '@renderer/lib/local-media-url'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { ImageAttachment } from '@renderer/lib/image-attachments'
import { downstreamNodeIds, upstreamNodeIds, useGraphStore } from './graph-store'
import type { CanvasNode, ImageNode } from './graph-types'
import { NODE_DEFAULT_SIZE } from './graph-types'
import type { GraphActions, GraphEditParams } from './graph-actions'

interface Target {
  provider: AIProvider
  model: AIModelConfig
  config: ProviderConfig
}

const ASPECT_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '16:9': '1536x1024',
  '9:16': '1024x1536'
}

function srcFromImageBlock(block: ImageBlock): {
  src: string
  filePath?: string
  mediaType?: string
} {
  if (block.source.type === 'base64') {
    const filePath = block.source.filePath
    return {
      // Prefer the oc-media:// stream URL once the file is on disk — keeping
      // the multi-MB data URL would pin the base64 payload in the graph store
      // (and in every history snapshot). Byte readers go through filePath.
      src: filePath
        ? filePathToMediaUrl(filePath)
        : `data:${block.source.mediaType || 'image/png'};base64,${block.source.data}`,
      filePath,
      mediaType: block.source.mediaType
    }
  }
  return { src: block.source.url ?? '' }
}

export function useGraphGeneration(): GraphActions {
  const { t } = useTranslation('layout')

  return useMemo<GraphActions>(() => {
    const resolveTarget = (providerId?: string, modelId?: string): Target | null => {
      const ps = useProviderStore.getState()
      const pid = providerId ?? ps.activeImageProviderId ?? undefined
      const provider = pid ? (ps.providers.find((p) => p.id === pid) ?? null) : null
      if (!provider) return null
      const mid = modelId ?? ps.activeImageModelId
      const model =
        provider.models.find((m) => m.id === mid) ??
        provider.models.find((m) => (m.category ?? 'chat') === 'image') ??
        null
      if (!model) return null
      const config = ps.getProviderConfigById(provider.id, model.id)
      if (!config) return null
      return { provider, model, config }
    }

    // Collect prompt text from upstream text nodes. Config nodes are prompt
    // pass-throughs: a text → config → image/video chain still resolves the
    // text when generating from the downstream node directly.
    const collectUpstreamText = (nodeId: string): string => {
      const { nodes, edges } = useGraphStore.getState()
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const texts: string[] = []
      const seen = new Set<string>([nodeId])
      const visit = (id: string): void => {
        for (const upId of upstreamNodeIds(edges, id)) {
          if (seen.has(upId)) continue
          seen.add(upId)
          const up = byId.get(upId)
          if (!up) continue
          if (up.kind === 'text') {
            const text = up.data.text.trim()
            if (text) texts.push(text)
          } else if (up.kind === 'config') {
            visit(upId)
          }
        }
      }
      visit(nodeId)
      return texts.join('\n\n')
    }

    // Fallback prompt for image→image chains: the prompt the upstream image
    // was generated with, so pure image-to-image nodes work without a text node.
    const upstreamImagePrompt = (nodeId: string): string => {
      const { nodes, edges } = useGraphStore.getState()
      const ids = new Set(upstreamNodeIds(edges, nodeId))
      return (
        nodes.find(
          (n): n is ImageNode => n.kind === 'image' && ids.has(n.id) && !!n.data.prompt?.trim()
        )?.data.prompt ?? ''
      )
    }

    const VARIATION_PROMPT =
      'Generate a new variation of the reference image, keeping its subject, composition and style.'

    // Resolve a node image to a data URL for API upload. Rehydrated nodes carry
    // an oc-media:// display URL instead of inline base64, so read the original
    // bytes back from disk in that case.
    const resolveImageDataUrl = async (data: {
      src?: string
      filePath?: string
      mediaType?: string
    }): Promise<{ src: string; mediaType?: string } | null> => {
      const src = data.src ?? ''
      if (src.startsWith('data:')) return { src, mediaType: data.mediaType }
      if (data.filePath) {
        try {
          const read = (await ipcClient.invoke(IPC.FS_READ_FILE_BINARY, {
            path: data.filePath
          })) as { data?: string; error?: string }
          if (read?.data) {
            return {
              src: `data:${data.mediaType || 'image/png'};base64,${read.data}`,
              mediaType: data.mediaType
            }
          }
        } catch {
          /* fall through */
        }
        return null
      }
      return src ? { src, mediaType: data.mediaType } : null
    }

    const collectUpstreamImages = async (
      nodeId: string
    ): Promise<Array<{ src: string; mediaType?: string }>> => {
      const { nodes, edges } = useGraphStore.getState()
      const ids = new Set(upstreamNodeIds(edges, nodeId))
      const candidates = nodes.filter(
        (n): n is ImageNode =>
          n.kind === 'image' && ids.has(n.id) && !!(n.data.src || n.data.filePath)
      )
      const resolved = await Promise.all(candidates.map((n) => resolveImageDataUrl(n.data)))
      return resolved.filter((r): r is { src: string; mediaType?: string } => !!r)
    }

    const buildMessages = (
      prompt: string,
      references: Array<{ src: string; mediaType?: string }>
    ): UnifiedMessage[] => {
      const content: string | ContentBlock[] =
        references.length > 0
          ? [
              ...references.map((ref) => {
                const comma = ref.src.indexOf(',')
                const data = comma >= 0 ? ref.src.slice(comma + 1) : ref.src
                return {
                  type: 'image',
                  source: { type: 'base64', mediaType: ref.mediaType || 'image/png', data }
                } as ContentBlock
              }),
              { type: 'text', text: prompt } as ContentBlock
            ]
          : prompt
      return [{ id: nanoid(), role: 'user', content, createdAt: Date.now() }]
    }

    const applySize = (config: ProviderConfig, aspect?: string): ProviderConfig => {
      const size = aspect ? ASPECT_TO_SIZE[aspect] : undefined
      if (!size) return config
      const overrides = config.requestOverrides ?? {}
      return {
        ...config,
        requestOverrides: { ...overrides, body: { ...(overrides.body ?? {}), size } }
      }
    }

    // Generate `count` images and return their persisted blocks.
    const runImages = async (args: {
      prompt: string
      references: Array<{ src: string; mediaType?: string }>
      config: ProviderConfig
      count: number
      edit?: { maskDataUrl: string; maskMediaType?: string }
    }): Promise<Array<ReturnType<typeof srcFromImageBlock>>> => {
      const out: Array<ReturnType<typeof srcFromImageBlock>> = []
      for (let i = 0; i < Math.max(1, args.count); i += 1) {
        for await (const event of streamNativeOpenAIImages({
          messages: buildMessages(args.prompt, args.references),
          config: args.config,
          edit: args.edit
        })) {
          if (event.type === 'image_generated' && event.imageBlock) {
            out.push(srcFromImageBlock(event.imageBlock as ImageBlock))
          } else if (event.type === 'image_error') {
            throw new Error(event.imageError?.message || 'Image generation failed')
          } else if (event.type === 'error') {
            throw new Error(event.error?.message || 'Image generation failed')
          }
        }
      }
      return out
    }

    // Fill `targetNodeId` with the first result; fan the rest into new connected nodes.
    const distributeResults = (
      targetNodeId: string,
      results: Array<ReturnType<typeof srcFromImageBlock>>,
      prompt: string,
      target: Target
    ): void => {
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === targetNodeId)
      if (!node) return
      const [first, ...rest] = results
      graph.updateNode(targetNodeId, (n) =>
        n.kind === 'image'
          ? {
              ...n,
              data: {
                ...n.data,
                src: first?.src,
                filePath: first?.filePath,
                mediaType: first?.mediaType,
                prompt,
                providerId: target.provider.id,
                modelId: target.model.id,
                generating: false,
                error: undefined,
                interrupted: undefined,
                groupSrcs: rest.length ? [first, ...rest] : undefined
              }
            }
          : n
      )
      rest.forEach((res, index) => {
        const child: CanvasNode = {
          id: nanoid(),
          kind: 'image',
          x: node.x,
          y: node.y + (node.h + 40) * (index + 1),
          w: node.w,
          h: node.h,
          data: {
            src: res.src,
            filePath: res.filePath,
            mediaType: res.mediaType,
            prompt,
            providerId: target.provider.id,
            modelId: target.model.id
          }
        }
        graph.addNode(child, { history: false })
        graph.addEdge(targetNodeId, child.id, { history: false })
      })
    }

    const DEFAULT_VIDEO_PARAMS: SeedanceVideoParams = {
      ratio: '16:9',
      resolution: '1080p',
      duration: 5,
      fps: 24,
      watermark: false
    }

    const resolveVideoTarget = (providerId?: string, modelId?: string): Target | null => {
      const ps = useProviderStore.getState()
      const isVideo = (m: AIModelConfig): boolean => (m.category ?? 'chat') === 'video'
      let provider = providerId ? (ps.providers.find((p) => p.id === providerId) ?? null) : null
      let model =
        provider?.models.find((m) => m.id === modelId && isVideo(m)) ??
        provider?.models.find(isVideo) ??
        null
      if (!provider || !model) {
        for (const p of ps.providers) {
          const m = p.models.find(isVideo)
          if (m) {
            provider = p
            model = m
            break
          }
        }
      }
      if (!provider || !model) return null
      const config = ps.getProviderConfigById(provider.id, model.id)
      if (!config) return null
      return { provider, model, config }
    }

    // Start a BACKGROUND video job in the main process. The renderer only kicks it
    // off and stores the jobId; status/result arrive via seedance-video:job-update
    // events (see use-video-jobs.ts), so generation survives page navigation.
    const runVideoInto = async (
      targetNodeId: string,
      prompt: string,
      references: Array<{ src: string; mediaType?: string }>,
      params: SeedanceVideoParams,
      target: Target
    ): Promise<void> => {
      const isXaiVideo = target.config.type === 'xai-video'
      const text = isXaiVideo ? prompt.trim() : `${prompt.trim()}${buildSeedanceCommands(params)}`
      const images = references.map((r) => ({ dataUrl: r.src, mediaType: r.mediaType }))
      try {
        const res = (await ipcClient.invoke(IPC.SEEDANCE_VIDEO_START, {
          provider: target.config,
          prompt: text,
          images,
          video: {
            duration: params.duration,
            aspectRatio: params.ratio,
            // The xAI Videos endpoint currently accepts 480p and 720p only.
            resolution: isXaiVideo && params.resolution === '1080p' ? '720p' : params.resolution
          }
        })) as { jobId?: string; error?: string }
        if (res.error || !res.jobId) throw new Error(res.error || 'Failed to start video job')
        useGraphStore.getState().updateNode(targetNodeId, (n) =>
          n.kind === 'video'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: true,
                  status: 'queued',
                  error: undefined,
                  interrupted: undefined,
                  jobId: res.jobId,
                  prompt,
                  providerId: target.provider.id,
                  modelId: target.model.id
                }
              }
            : n
        )
      } catch (error) {
        useGraphStore.getState().updateNode(targetNodeId, (n) =>
          n.kind === 'video'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: false,
                  status: undefined,
                  interrupted: undefined,
                  error: error instanceof Error ? error.message : String(error)
                }
              }
            : n
        )
      }
    }

    const generateVideoNode: GraphActions['generateVideoNode'] = async (nodeId) => {
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (!node || node.kind !== 'video') return
      const target = resolveVideoTarget(node.data.providerId, node.data.modelId)
      if (!target) {
        toast.error(t('drawPage.noVideoModel', { defaultValue: 'No video model configured' }))
        return
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        return
      }
      const references = await collectUpstreamImages(nodeId)
      let prompt =
        [collectUpstreamText(nodeId), node.data.prompt].filter(Boolean).join('\n') ||
        node.data.prompt ||
        ''
      // Image-to-video without any text: reuse the upstream image's prompt.
      if (!prompt.trim() && references.length > 0) prompt = upstreamImagePrompt(nodeId)
      if (!prompt.trim()) {
        toast.error(t('drawPage.promptRequired', { defaultValue: 'Connect a text node' }))
        return
      }
      graph.pushHistory()
      graph.updateNode(nodeId, (n) =>
        n.kind === 'video'
          ? {
              ...n,
              data: {
                ...n.data,
                generating: true,
                status: 'queued',
                error: undefined,
                interrupted: undefined
              }
            }
          : n
      )
      await runVideoInto(nodeId, prompt, references, DEFAULT_VIDEO_PARAMS, target)
    }

    const generateImageNode: GraphActions['generateImageNode'] = async (nodeId) => {
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (!node || node.kind !== 'image') return
      const target = resolveTarget(node.data.providerId, node.data.modelId)
      if (!target) {
        toast.error(t('drawPage.noModel'))
        return
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        return
      }
      const references = await collectUpstreamImages(nodeId)
      if (node.data.src || node.data.filePath) {
        const own = await resolveImageDataUrl(node.data)
        if (own) references.push(own)
      }
      let prompt =
        [collectUpstreamText(nodeId), node.data.prompt].filter(Boolean).join('\n') ||
        node.data.prompt ||
        ''
      // Image-to-image without any text: reuse the upstream image's prompt,
      // or fall back to a generic variation instruction.
      if (!prompt.trim() && references.length > 0) {
        prompt = upstreamImagePrompt(nodeId) || VARIATION_PROMPT
      }
      if (!prompt.trim()) {
        toast.error(
          t('drawPage.promptRequired', { defaultValue: 'Add a prompt or connect a text node' })
        )
        return
      }

      graph.pushHistory()
      graph.updateNode(nodeId, (n) =>
        n.kind === 'image'
          ? {
              ...n,
              data: { ...n.data, generating: true, error: undefined, interrupted: undefined }
            }
          : n
      )
      try {
        const results = await runImages({ prompt, references, config: target.config, count: 1 })
        distributeResults(nodeId, results, prompt, target)
      } catch (error) {
        useGraphStore.getState().updateNode(nodeId, (n) =>
          n.kind === 'image'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: false,
                  interrupted: undefined,
                  error: error instanceof Error ? error.message : String(error)
                }
              }
            : n
        )
      }
    }

    const runVideoConfigNode = async (config: CanvasNode & { kind: 'config' }): Promise<void> => {
      const graph = useGraphStore.getState()
      const target = resolveVideoTarget(config.data.providerId, config.data.modelId)
      if (!target) {
        toast.error(t('drawPage.noVideoModel', { defaultValue: 'No video model configured' }))
        return
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        return
      }
      const prompt = collectUpstreamText(config.id)
      if (!prompt.trim()) {
        toast.error(t('drawPage.promptRequired', { defaultValue: 'Connect a text node' }))
        return
      }
      const references = await collectUpstreamImages(config.id)
      const size = NODE_DEFAULT_SIZE.video
      const targetNode: CanvasNode = {
        id: nanoid(),
        kind: 'video',
        x: config.x + config.w + 60,
        y: config.y,
        w: size.w,
        h: size.h,
        data: {
          generating: true,
          status: 'queued',
          providerId: target.provider.id,
          modelId: target.model.id
        }
      }
      graph.addNode(targetNode, { history: true })
      graph.addEdge(config.id, targetNode.id, { history: false })
      const params: SeedanceVideoParams = {
        ratio: config.data.aspect ?? DEFAULT_VIDEO_PARAMS.ratio,
        resolution: config.data.resolution ?? DEFAULT_VIDEO_PARAMS.resolution,
        duration: config.data.duration ?? DEFAULT_VIDEO_PARAMS.duration,
        fps: config.data.fps ?? DEFAULT_VIDEO_PARAMS.fps,
        watermark: config.data.watermark ?? DEFAULT_VIDEO_PARAMS.watermark
      }
      await runVideoInto(targetNode.id, prompt, references, params, target)
    }

    const runConfigNode: GraphActions['runConfigNode'] = async (configId) => {
      const graph = useGraphStore.getState()
      const config = graph.nodes.find((n) => n.id === configId)
      if (!config || config.kind !== 'config') return
      if (config.data.mode === 'video') {
        await runVideoConfigNode(config)
        return
      }
      const target = resolveTarget(config.data.providerId, config.data.modelId)
      if (!target) {
        toast.error(t('drawPage.noModel'))
        return
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        return
      }
      const prompt = collectUpstreamText(configId)
      if (!prompt.trim()) {
        toast.error(t('drawPage.promptRequired', { defaultValue: 'Connect a text node' }))
        return
      }
      const references = await collectUpstreamImages(configId)
      const count = config.data.count ?? 1

      // Create a target image node to the right and fan results into it.
      const size = NODE_DEFAULT_SIZE.image
      const targetNode: CanvasNode = {
        id: nanoid(),
        kind: 'image',
        x: config.x + config.w + 60,
        y: config.y,
        w: size.w,
        h: size.h,
        data: { generating: true }
      }
      graph.addNode(targetNode, { history: true })
      graph.addEdge(configId, targetNode.id, { history: false })
      try {
        const results = await runImages({
          prompt,
          references,
          config: applySize(target.config, config.data.aspect),
          count
        })
        distributeResults(targetNode.id, results, prompt, target)
      } catch (error) {
        useGraphStore.getState().updateNode(targetNode.id, (n) =>
          n.kind === 'image'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: false,
                  interrupted: undefined,
                  error: error instanceof Error ? error.message : String(error)
                }
              }
            : n
        )
      }
    }

    const generateFromText: GraphActions['generateFromText'] = (textId) => {
      const graph = useGraphStore.getState()
      const text = graph.nodes.find((n) => n.id === textId)
      if (!text || text.kind !== 'text') return
      const size = NODE_DEFAULT_SIZE.config
      const configNode: CanvasNode = {
        id: nanoid(),
        kind: 'config',
        x: text.x + text.w + 60,
        y: text.y,
        w: size.w,
        h: size.h,
        data: { mode: 'image', aspect: '1:1', count: 1 }
      }
      graph.addNode(configNode, { history: true })
      graph.addEdge(textId, configNode.id, { history: false })
      void runConfigNode(configNode.id)
    }

    // Context the optimized prompt will actually be used with: reference images
    // feeding the same downstream generation target(s), and the target aspect
    // ratio from a downstream config node.
    const REWRITE_MAX_REFERENCE_IMAGES = 4
    const rewriteContext = async (
      textId: string
    ): Promise<{ images: ImageAttachment[]; aspect?: string }> => {
      const { nodes, edges } = useGraphStore.getState()
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const candidates: ImageNode[] = []
      let aspect: string | undefined
      const seen = new Set<string>([textId])
      const pushImage = (node: CanvasNode): void => {
        if (node.kind !== 'image' || seen.has(node.id)) return
        if (!node.data.src && !node.data.filePath) return
        seen.add(node.id)
        candidates.push(node)
      }
      for (const targetId of downstreamNodeIds(edges, textId)) {
        const target = byId.get(targetId)
        if (!target) continue
        if (target.kind === 'config' && !aspect) aspect = target.data.aspect
        // the generation target itself (image-to-image), plus sibling references
        pushImage(target)
        for (const upId of upstreamNodeIds(edges, targetId)) {
          const up = byId.get(upId)
          if (up) pushImage(up)
        }
      }
      const resolved = await Promise.all(
        candidates.slice(0, REWRITE_MAX_REFERENCE_IMAGES).map(async (node) => {
          const ref = await resolveImageDataUrl(node.data)
          return ref
            ? { id: node.id, dataUrl: ref.src, mediaType: ref.mediaType || 'image/png' }
            : null
        })
      )
      return { images: resolved.filter((r): r is ImageAttachment => !!r), aspect }
    }

    const rewriteText: GraphActions['rewriteText'] = async (textId) => {
      const graph = useGraphStore.getState()
      const text = graph.nodes.find((n) => n.id === textId)
      if (!text || text.kind !== 'text' || !text.data.text.trim()) return
      // Optimize with the fast chat model — image-model endpoints generally
      // can't serve text requests. Fall back to the image target's config.
      const config = useProviderStore.getState().getFastProviderConfig() ?? resolveTarget()?.config
      if (!config) {
        toast.error(t('drawPage.optimizeUnavailable'))
        return
      }
      if (config.providerId && !(await ensureProviderAuthReady(config.providerId))) {
        toast.error(t('drawPage.authRequired'))
        return
      }
      const context = await rewriteContext(textId)
      const optimizerModel = useProviderStore
        .getState()
        .providers.find((p) => p.id === config.providerId)
        ?.models.find((m) => m.id === config.model)
      const images = optimizerModel?.supportsVision === false ? [] : context.images
      try {
        let result: Awaited<ReturnType<typeof optimizeDrawPrompt>>
        try {
          result = await optimizeDrawPrompt(text.data.text.trim(), config, images, {
            aspect: context.aspect
          })
        } catch (error) {
          // The optimizer model may not accept image input — retry text-only.
          if (images.length === 0) throw error
          result = await optimizeDrawPrompt(text.data.text.trim(), config, [], {
            aspect: context.aspect
          })
        }
        const child: CanvasNode = {
          id: nanoid(),
          kind: 'text',
          x: text.x + text.w + 60,
          y: text.y,
          w: text.w,
          h: text.h,
          data: { text: result.prompt }
        }
        graph.addNode(child, { history: true, select: true })
        graph.addEdge(textId, child.id, { history: false })
      } catch (error) {
        toast.error(t('drawPage.optimizeFailed'), {
          description: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const applyEdit = async (imageNodeId: string, params: GraphEditParams): Promise<void> => {
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === imageNodeId)
      if (!node || node.kind !== 'image') return
      const base = params.baseImageDataUrl ?? (await resolveImageDataUrl(node.data))?.src
      if (!base) return
      const target = resolveTarget(
        params.providerId ?? node.data.providerId,
        params.modelId ?? node.data.modelId
      )
      if (!target) {
        toast.error(t('drawPage.noModel'))
        return
      }
      const size = NODE_DEFAULT_SIZE.image
      const child: CanvasNode = {
        id: nanoid(),
        kind: 'image',
        x: node.x + node.w + 60,
        y: node.y,
        w: size.w,
        h: size.h,
        data: { generating: true, prompt: params.prompt }
      }
      graph.addNode(child, { history: true })
      graph.addEdge(imageNodeId, child.id, { history: false })
      try {
        const results = await runImages({
          prompt: params.prompt,
          references: [{ src: base, mediaType: 'image/png' }],
          config: target.config,
          count: 1,
          edit: { maskDataUrl: params.maskDataUrl, maskMediaType: 'image/png' }
        })
        distributeResults(child.id, results, params.prompt, target)
      } catch (error) {
        useGraphStore.getState().updateNode(child.id, (n) =>
          n.kind === 'image'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: false,
                  interrupted: undefined,
                  error: error instanceof Error ? error.message : String(error)
                }
              }
            : n
        )
      }
    }

    const addDerivedImage: GraphActions['addDerivedImage'] = async (sourceId, dataUrl, opts) => {
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === sourceId)
      if (!node || node.kind !== 'image') return
      const comma = dataUrl.indexOf(',')
      const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
      const mediaType = /data:(.*?);/.exec(dataUrl)?.[1] || 'image/png'

      let src = dataUrl
      let filePath: string | undefined
      try {
        const result = (await ipcClient.invoke(IPC.IMAGE_PERSIST_GENERATED, {
          data,
          mediaType
        })) as { filePath?: string; mediaType?: string; data?: string; error?: string }
        if (result?.filePath && !result.error) {
          filePath = result.filePath
          src = filePathToMediaUrl(result.filePath)
        }
      } catch (error) {
        console.warn('[Draw graph] Failed to persist derived image:', error)
      }

      const child: CanvasNode = {
        id: nanoid(),
        kind: 'image',
        x: node.x + node.w + 60,
        y: node.y,
        w: node.w,
        h: node.h,
        data: {
          src,
          filePath,
          mediaType,
          prompt: opts?.prompt ?? node.data.prompt,
          providerId: node.data.providerId,
          modelId: node.data.modelId
        }
      }
      graph.addNode(child, { history: true, select: opts?.select })
      graph.addEdge(sourceId, child.id, { history: false })
    }

    const downloadImage: GraphActions['downloadImage'] = async (nodeId) => {
      const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
      if (!node || node.kind !== 'image' || !node.data.filePath) return
      try {
        const result = (await ipcClient.invoke(IPC.FS_DOWNLOAD_FILE_COPY, {
          sourcePath: node.data.filePath,
          defaultName: 'image.png',
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        })) as { success?: boolean; canceled?: boolean; error?: string }
        if (result.canceled) return
        if (!result.success) throw new Error(result.error || 'copy failed')
        toast.success(t('drawPage.downloadSuccess'))
      } catch (error) {
        toast.error(t('drawPage.downloadFailed'), {
          description: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return {
      runConfigNode: (id) => void runConfigNode(id),
      generateFromText,
      rewriteText,
      generateImageNode: (id) => void generateImageNode(id),
      generateVideoNode: (id) => void generateVideoNode(id),
      applyEdit: (id, params) => void applyEdit(id, params),
      addDerivedImage: (id, dataUrl, opts) => void addDerivedImage(id, dataUrl, opts),
      downloadImage: (id) => void downloadImage(id)
    }
  }, [t])
}
