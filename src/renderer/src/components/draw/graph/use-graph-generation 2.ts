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
import { runSidecarTextRequest } from '@renderer/lib/ipc/agent-bridge'
import { filePathToMediaUrl } from '@renderer/lib/local-media-url'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { ImageAttachment } from '@renderer/lib/image-attachments'
import { useProjectsStore } from './draw-projects-store'
import { patchPersistedProjectGraph } from './graph-persistence'
import { downstreamNodeIds, upstreamNodeIds, useGraphStore } from './graph-store'
import type { CanvasNode, ImageNode } from './graph-types'
import { NODE_DEFAULT_SIZE } from './graph-types'
import type { CanvasRunResult, GraphActions } from './graph-actions'
import { getNodeExecution, startNodeExecution, updateNodeExecution } from './canvas-events'

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
    const failedResult = (
      nodeId?: string,
      error?: string,
      runId?: string,
      outputNodeIds: string[] = []
    ): CanvasRunResult => ({
      ok: false,
      ...(runId ? { runId } : {}),
      nodeId,
      outputNodeIds,
      status: 'failed',
      error
    })
    const cancelledResult = (
      nodeId: string,
      runId: string,
      outputNodeIds: string[] = [nodeId]
    ): CanvasRunResult => ({
      ok: false,
      runId,
      nodeId,
      outputNodeIds,
      status: 'cancelled',
      error: 'Generation cancelled'
    })

    const currentProjectId = (): string => useProjectsStore.getState().activeProjectId ?? 'default'
    const cancelledRunIds = new Set<string>()
    const rememberCancelledRun = (runId: string): void => {
      cancelledRunIds.add(runId)
      if (cancelledRunIds.size > 500) {
        const oldest = cancelledRunIds.values().next().value
        if (oldest) cancelledRunIds.delete(oldest)
      }
    }
    const isRunCancelled = (nodeId: string, runId: string, projectId: string): boolean =>
      cancelledRunIds.has(runId) || getNodeExecution(nodeId, projectId)?.status === 'cancelled'
    const interruptIfProjectChanged = (
      projectId: string,
      nodeId: string,
      runId: string
    ): CanvasRunResult | null => {
      if (currentProjectId() === projectId) return null
      const error = 'Canvas changed before generation started'
      updateNodeExecution(nodeId, 'interrupted', { projectId, runId, error })
      return {
        ok: false,
        runId,
        nodeId,
        outputNodeIds: [],
        status: 'interrupted',
        error
      }
    }

    const resolveTarget = (providerId?: string, modelId?: string): Target | null => {
      const ps = useProviderStore.getState()
      const pid = providerId ?? ps.activeImageProviderId ?? undefined
      const provider = pid
        ? (ps.providers.find((p) => p.id === pid) ?? null)
        : (ps.providers.find((candidate) =>
            candidate.models.some((model) => (model.category ?? 'chat') === 'image')
          ) ?? null)
      if (!provider) return null
      const mid = modelId ?? ps.activeImageModelId
      const model =
        provider.models.find((m) => m.id === mid && (m.category ?? 'chat') === 'image') ??
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
      const byId = new Map(nodes.map((node) => [node.id, node]))
      const candidates: ImageNode[] = []
      const seen = new Set<string>([nodeId])
      const visit = (id: string): void => {
        for (const upstreamId of upstreamNodeIds(edges, id)) {
          if (seen.has(upstreamId)) continue
          seen.add(upstreamId)
          const upstream = byId.get(upstreamId)
          if (!upstream) continue
          if (upstream.kind === 'image' && (upstream.data.src || upstream.data.filePath)) {
            candidates.push(upstream)
          } else if (upstream.kind === 'config') {
            visit(upstream.id)
          }
        }
      }
      visit(nodeId)
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

    const applyImageOptions = (
      config: ProviderConfig,
      aspect?: string,
      quality: string = 'auto',
      imageSize: string = 'auto'
    ): ProviderConfig => {
      const size = imageSize === 'auto' ? (aspect ? ASPECT_TO_SIZE[aspect] : undefined) : imageSize
      const overrides = config.requestOverrides ?? {}
      const body: Record<string, unknown> = { ...(overrides.body ?? {}), quality }
      if (size) body.size = size
      else delete body.size
      return {
        ...config,
        requestOverrides: { ...overrides, body }
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
      if (out.length < Math.max(1, args.count)) {
        throw new Error('Image provider returned no result')
      }
      return out
    }

    // Fill `targetNodeId` with the first result; fan the rest into new connected nodes.
    const distributeResults = (
      targetNodeId: string,
      results: Array<ReturnType<typeof srcFromImageBlock>>,
      prompt: string,
      target: Target,
      runId: string,
      projectId: string
    ): string[] => {
      const graph = useGraphStore.getState()
      const [first, ...rest] = results
      if (currentProjectId() !== projectId) {
        const childIds = rest.map(() => nanoid())
        const outputNodeIds = [targetNodeId, ...childIds]
        patchPersistedProjectGraph(projectId, (stored) => {
          const targetNode = stored.nodes.find((candidate) => candidate.id === targetNodeId)
          if (!targetNode || targetNode.kind !== 'image') return stored
          const updatedTarget: CanvasNode = {
            ...targetNode,
            data: {
              ...targetNode.data,
              src: first?.filePath ? undefined : first?.src,
              filePath: first?.filePath,
              mediaType: first?.mediaType,
              prompt,
              providerId: target.provider.id,
              modelId: target.model.id,
              generating: false,
              error: undefined,
              interrupted: undefined,
              groupSrcs: undefined
            }
          }
          const children: CanvasNode[] = rest.map((result, index) => ({
            id: childIds[index],
            kind: 'image',
            x: targetNode.x,
            y: targetNode.y + (targetNode.h + 40) * (index + 1),
            w: targetNode.w,
            h: targetNode.h,
            execution: {
              runId,
              status: 'succeeded',
              startedAt: Date.now(),
              finishedAt: Date.now()
            },
            data: {
              src: result.filePath ? undefined : result.src,
              filePath: result.filePath,
              mediaType: result.mediaType,
              prompt,
              providerId: target.provider.id,
              modelId: target.model.id
            }
          }))
          return {
            ...stored,
            nodes: [
              ...stored.nodes.map((candidate) =>
                candidate.id === targetNodeId ? updatedTarget : candidate
              ),
              ...children
            ],
            edges: [
              ...stored.edges,
              ...childIds.map((id) => ({ id: nanoid(), source: targetNodeId, target: id }))
            ]
          }
        })
        updateNodeExecution(targetNodeId, 'succeeded', {
          projectId,
          runId,
          outputNodeIds
        })
        return outputNodeIds
      }
      const node = graph.nodes.find((n) => n.id === targetNodeId)
      if (!node) return []
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
      const outputNodeIds = [targetNodeId]
      rest.forEach((res, index) => {
        const child: CanvasNode = {
          id: nanoid(),
          kind: 'image',
          x: node.x,
          y: node.y + (node.h + 40) * (index + 1),
          w: node.w,
          h: node.h,
          execution: {
            runId,
            status: 'succeeded',
            startedAt: Date.now(),
            finishedAt: Date.now()
          },
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
        outputNodeIds.push(child.id)
      })
      updateNodeExecution(targetNodeId, 'succeeded', { runId, outputNodeIds, projectId })
      return outputNodeIds
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

    const resolveTextTarget = (providerId?: string, modelId?: string): Target | null => {
      const ps = useProviderStore.getState()
      const provider = providerId
        ? (ps.providers.find((candidate) => candidate.id === providerId) ?? null)
        : ps.activeProviderId
          ? (ps.providers.find((candidate) => candidate.id === ps.activeProviderId) ?? null)
          : (ps.providers.find((candidate) =>
              candidate.models.some((model) => (model.category ?? 'chat') === 'chat')
            ) ?? null)
      const model = provider
        ? (provider.models.find(
            (candidate) => candidate.id === modelId && (candidate.category ?? 'chat') === 'chat'
          ) ??
          provider.models.find((candidate) => (candidate.category ?? 'chat') === 'chat') ??
          null)
        : null
      if (!provider || !model) return null
      const config = ps.getProviderConfigById(provider.id, model.id)
      return config ? { provider, model, config } : null
    }

    // Start a BACKGROUND video job in the main process. The renderer only kicks it
    // off and stores the jobId; status/result arrive via seedance-video:job-update
    // events (see use-video-jobs.ts), so generation survives page navigation.
    const runVideoInto = async (
      targetNodeId: string,
      prompt: string,
      references: Array<{ src: string; mediaType?: string }>,
      params: SeedanceVideoParams,
      target: Target,
      runId: string,
      projectId: string
    ): Promise<CanvasRunResult> => {
      const isXaiVideo = target.config.type === 'xai-video'
      const text = isXaiVideo ? prompt.trim() : `${prompt.trim()}${buildSeedanceCommands(params)}`
      const images = references.map((r) => ({ dataUrl: r.src, mediaType: r.mediaType }))
      try {
        const res = (await ipcClient.invoke(IPC.SEEDANCE_VIDEO_START, {
          projectId,
          nodeId: targetNodeId,
          runId,
          provider: target.config,
          prompt: text,
          images,
          video: {
            duration: params.duration,
            aspectRatio: params.ratio,
            // The xAI Videos endpoint currently accepts 480p and 720p only.
            resolution: isXaiVideo && params.resolution === '1080p' ? '720p' : params.resolution
          }
        })) as { jobId?: string; status?: string; error?: string }
        if (res.error || !res.jobId) throw new Error(res.error || 'Failed to start video job')
        if (isRunCancelled(targetNodeId, runId, projectId)) {
          await ipcClient.invoke(IPC.SEEDANCE_VIDEO_CANCEL, { jobId: res.jobId })
          return cancelledResult(targetNodeId, runId)
        }
        const patchVideoNode = (n: CanvasNode): CanvasNode =>
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
        if (currentProjectId() === projectId) {
          useGraphStore.getState().updateNode(targetNodeId, patchVideoNode)
        } else {
          patchPersistedProjectGraph(projectId, (stored) => ({
            ...stored,
            nodes: stored.nodes.map((node) =>
              node.id === targetNodeId ? patchVideoNode(node) : node
            )
          }))
        }
        updateNodeExecution(targetNodeId, 'running', { runId, projectId })
        return {
          ok: true,
          runId,
          nodeId: targetNodeId,
          outputNodeIds: [targetNodeId],
          status: 'running'
        }
      } catch (error) {
        if (isRunCancelled(targetNodeId, runId, projectId)) {
          return cancelledResult(targetNodeId, runId)
        }
        const message = error instanceof Error ? error.message : String(error)
        const patchFailedVideo = (n: CanvasNode): CanvasNode =>
          n.kind === 'video'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: false,
                  status: undefined,
                  interrupted: undefined,
                  error: message
                }
              }
            : n
        if (currentProjectId() === projectId) {
          useGraphStore.getState().updateNode(targetNodeId, patchFailedVideo)
        } else {
          patchPersistedProjectGraph(projectId, (stored) => ({
            ...stored,
            nodes: stored.nodes.map((node) =>
              node.id === targetNodeId ? patchFailedVideo(node) : node
            )
          }))
        }
        updateNodeExecution(targetNodeId, 'failed', { runId, projectId, error: message })
        return failedResult(targetNodeId, message, runId, [targetNodeId])
      }
    }

    const generateVideoNode: GraphActions['generateVideoNode'] = async (nodeId) => {
      const projectId = currentProjectId()
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (!node || node.kind !== 'video') return failedResult(nodeId, 'Video node not found')
      if (node.execution && ['queued', 'running'].includes(node.execution.status)) {
        return failedResult(nodeId, 'Node is already running')
      }
      const target = resolveVideoTarget(node.data.providerId, node.data.modelId)
      if (!target) {
        toast.error(t('drawPage.noVideoModel', { defaultValue: 'No video model configured' }))
        return failedResult(nodeId, 'No video model configured')
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        return failedResult(nodeId, 'Provider authentication required')
      }
      if (currentProjectId() !== projectId) {
        return failedResult(nodeId, 'Canvas changed before generation started')
      }
      const references = await collectUpstreamImages(nodeId)
      if (currentProjectId() !== projectId) {
        return failedResult(nodeId, 'Canvas changed before generation started')
      }
      let prompt =
        [collectUpstreamText(nodeId), node.data.prompt].filter(Boolean).join('\n') ||
        node.data.prompt ||
        ''
      // Image-to-video without any text: reuse the upstream image's prompt.
      if (!prompt.trim() && references.length > 0) prompt = upstreamImagePrompt(nodeId)
      if (!prompt.trim()) {
        toast.error(t('drawPage.promptRequired', { defaultValue: 'Connect a text node' }))
        return failedResult(nodeId, 'Prompt required')
      }
      graph.pushHistory()
      const execution = startNodeExecution(nodeId, { projectId })
      if (!execution) return failedResult(nodeId, 'Unable to start node')
      return await runVideoInto(
        nodeId,
        prompt,
        references,
        DEFAULT_VIDEO_PARAMS,
        target,
        execution.runId,
        projectId
      )
    }

    const generateImageNode: GraphActions['generateImageNode'] = async (nodeId) => {
      const projectId = currentProjectId()
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (!node || node.kind !== 'image') return failedResult(nodeId, 'Image node not found')
      if (node.execution && ['queued', 'running'].includes(node.execution.status)) {
        return failedResult(nodeId, 'Node is already running')
      }
      const target = resolveTarget(node.data.providerId, node.data.modelId)
      if (!target) {
        toast.error(t('drawPage.noModel'))
        return failedResult(nodeId, 'No image model configured')
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        return failedResult(nodeId, 'Provider authentication required')
      }
      if (currentProjectId() !== projectId) {
        return failedResult(nodeId, 'Canvas changed before generation started')
      }
      const references = await collectUpstreamImages(nodeId)
      if (node.data.src || node.data.filePath) {
        const own = await resolveImageDataUrl(node.data)
        if (own) references.push(own)
      }
      if (currentProjectId() !== projectId) {
        return failedResult(nodeId, 'Canvas changed before generation started')
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
        return failedResult(nodeId, 'Prompt required')
      }

      graph.pushHistory()
      const execution = startNodeExecution(nodeId, { projectId })
      if (!execution) return failedResult(nodeId, 'Unable to start node')
      updateNodeExecution(nodeId, 'running', { runId: execution.runId, projectId })
      try {
        const results = await runImages({ prompt, references, config: target.config, count: 1 })
        if (isRunCancelled(nodeId, execution.runId, projectId)) {
          return cancelledResult(nodeId, execution.runId)
        }
        const outputNodeIds = distributeResults(
          nodeId,
          results,
          prompt,
          target,
          execution.runId,
          projectId
        )
        return {
          ok: true,
          runId: execution.runId,
          nodeId,
          outputNodeIds,
          status: 'succeeded'
        }
      } catch (error) {
        if (isRunCancelled(nodeId, execution.runId, projectId)) {
          return cancelledResult(nodeId, execution.runId)
        }
        const message = error instanceof Error ? error.message : String(error)
        const patchFailedImage = (n: CanvasNode): CanvasNode =>
          n.kind === 'image'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: false,
                  interrupted: undefined,
                  error: message
                }
              }
            : n
        if (currentProjectId() === projectId) {
          useGraphStore.getState().updateNode(nodeId, patchFailedImage)
        } else {
          patchPersistedProjectGraph(projectId, (stored) => ({
            ...stored,
            nodes: stored.nodes.map((candidate) =>
              candidate.id === nodeId ? patchFailedImage(candidate) : candidate
            )
          }))
        }
        updateNodeExecution(nodeId, 'failed', {
          runId: execution.runId,
          projectId,
          error: message
        })
        return failedResult(nodeId, message, execution.runId, [nodeId])
      }
    }

    const runVideoConfigNode = async (
      config: CanvasNode & { kind: 'config' },
      configRunId: string,
      projectId: string
    ): Promise<CanvasRunResult> => {
      const graph = useGraphStore.getState()
      const target = resolveVideoTarget(config.data.providerId, config.data.modelId)
      if (!target) {
        toast.error(t('drawPage.noVideoModel', { defaultValue: 'No video model configured' }))
        updateNodeExecution(config.id, 'failed', {
          runId: configRunId,
          projectId,
          error: 'No video model configured'
        })
        return failedResult(config.id, 'No video model configured', configRunId)
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        updateNodeExecution(config.id, 'failed', {
          runId: configRunId,
          projectId,
          error: 'Provider authentication required'
        })
        return failedResult(config.id, 'Provider authentication required', configRunId)
      }
      const projectChange = interruptIfProjectChanged(projectId, config.id, configRunId)
      if (projectChange) return projectChange
      if (isRunCancelled(config.id, configRunId, projectId)) {
        return cancelledResult(config.id, configRunId, [])
      }
      const prompt = collectUpstreamText(config.id)
      if (!prompt.trim()) {
        toast.error(t('drawPage.promptRequired', { defaultValue: 'Connect a text node' }))
        updateNodeExecution(config.id, 'failed', {
          runId: configRunId,
          projectId,
          error: 'Prompt required'
        })
        return failedResult(config.id, 'Prompt required', configRunId)
      }
      const references = await collectUpstreamImages(config.id)
      const changedAfterReferences = interruptIfProjectChanged(projectId, config.id, configRunId)
      if (changedAfterReferences) return changedAfterReferences
      if (isRunCancelled(config.id, configRunId, projectId)) {
        return cancelledResult(config.id, configRunId, [])
      }
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
      const targetExecution = startNodeExecution(targetNode.id, { projectId })
      updateNodeExecution(config.id, 'running', {
        runId: configRunId,
        projectId,
        outputNodeIds: [targetNode.id]
      })
      const params: SeedanceVideoParams = {
        ratio: config.data.aspect ?? DEFAULT_VIDEO_PARAMS.ratio,
        resolution: config.data.resolution ?? DEFAULT_VIDEO_PARAMS.resolution,
        duration:
          target.config.type === 'openai-video'
            ? [4, 8, 12].includes(config.data.duration ?? 4)
              ? (config.data.duration ?? 4)
              : 4
            : (config.data.duration ?? DEFAULT_VIDEO_PARAMS.duration),
        fps: config.data.fps ?? DEFAULT_VIDEO_PARAMS.fps,
        watermark: config.data.watermark ?? DEFAULT_VIDEO_PARAMS.watermark,
        seed: config.data.seed,
        cameraFixed: config.data.cameraFixed
      }
      if (!targetExecution) {
        updateNodeExecution(config.id, 'failed', {
          runId: configRunId,
          projectId,
          error: 'Unable to create video output node'
        })
        return failedResult(config.id, 'Unable to create video output node', configRunId, [
          targetNode.id
        ])
      }
      const result = await runVideoInto(
        targetNode.id,
        prompt,
        references,
        params,
        target,
        targetExecution.runId,
        projectId
      )
      if (!['queued', 'running'].includes(result.status)) {
        updateNodeExecution(config.id, result.status, {
          runId: configRunId,
          projectId,
          error: result.error,
          outputNodeIds: [targetNode.id]
        })
      }
      return {
        ...result,
        runId: configRunId,
        nodeId: config.id,
        outputNodeIds: [targetNode.id]
      }
    }

    const runTextConfigNode = async (
      config: CanvasNode & { kind: 'config' },
      configRunId: string,
      projectId: string
    ): Promise<CanvasRunResult> => {
      const graph = useGraphStore.getState()
      const target = resolveTextTarget(config.data.providerId, config.data.modelId)
      const prompt = collectUpstreamText(config.id)
      if (!target || !prompt.trim()) {
        const error = !target ? 'No text model configured' : 'Prompt required'
        updateNodeExecution(config.id, 'failed', { runId: configRunId, projectId, error })
        return failedResult(config.id, error, configRunId)
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        const error = 'Provider authentication required'
        updateNodeExecution(config.id, 'failed', { runId: configRunId, projectId, error })
        return failedResult(config.id, error, configRunId)
      }
      const projectChange = interruptIfProjectChanged(projectId, config.id, configRunId)
      if (projectChange) return projectChange
      if (isRunCancelled(config.id, configRunId, projectId)) {
        return cancelledResult(config.id, configRunId, [])
      }
      const size = NODE_DEFAULT_SIZE.text
      const output: CanvasNode = {
        id: nanoid(),
        kind: 'text',
        x: config.x + config.w + 60,
        y: config.y,
        w: size.w,
        h: size.h,
        data: { text: '' }
      }
      graph.addNode(output, { history: true })
      graph.addEdge(config.id, output.id, { history: false })
      const outputRun = startNodeExecution(output.id, { projectId })
      updateNodeExecution(config.id, 'running', {
        runId: configRunId,
        projectId,
        outputNodeIds: [output.id]
      })
      if (!outputRun) {
        updateNodeExecution(config.id, 'failed', {
          runId: configRunId,
          projectId,
          error: 'Unable to create text output node',
          outputNodeIds: [output.id]
        })
        return failedResult(config.id, 'Unable to create text output node', configRunId, [
          output.id
        ])
      }
      updateNodeExecution(output.id, 'running', { runId: outputRun.runId, projectId })
      try {
        const text = await runSidecarTextRequest({
          provider: target.config,
          messages: [{ id: nanoid(), role: 'user', content: prompt, createdAt: Date.now() }]
        })
        if (isRunCancelled(output.id, outputRun.runId, projectId)) {
          updateNodeExecution(config.id, 'cancelled', {
            runId: configRunId,
            projectId,
            outputNodeIds: [output.id]
          })
          return cancelledResult(config.id, configRunId, [output.id])
        }
        if (currentProjectId() === projectId) {
          graph.updateNode(output.id, (node) =>
            node.kind === 'text' ? { ...node, data: { ...node.data, text } } : node
          )
        } else {
          patchPersistedProjectGraph(projectId, (stored) => ({
            ...stored,
            nodes: stored.nodes.map((node) =>
              node.id === output.id && node.kind === 'text'
                ? { ...node, data: { ...node.data, text } }
                : node
            )
          }))
        }
        updateNodeExecution(output.id, 'succeeded', { runId: outputRun.runId, projectId })
        updateNodeExecution(config.id, 'succeeded', {
          runId: configRunId,
          projectId,
          outputNodeIds: [output.id]
        })
        return {
          ok: true,
          runId: configRunId,
          nodeId: config.id,
          outputNodeIds: [output.id],
          status: 'succeeded'
        }
      } catch (error) {
        if (isRunCancelled(output.id, outputRun.runId, projectId)) {
          updateNodeExecution(config.id, 'cancelled', {
            runId: configRunId,
            projectId,
            outputNodeIds: [output.id]
          })
          return cancelledResult(config.id, configRunId, [output.id])
        }
        const message = error instanceof Error ? error.message : String(error)
        updateNodeExecution(output.id, 'failed', {
          runId: outputRun.runId,
          projectId,
          error: message
        })
        updateNodeExecution(config.id, 'failed', { runId: configRunId, projectId, error: message })
        return failedResult(config.id, message, configRunId, [output.id])
      }
    }

    const runConfigNode: GraphActions['runConfigNode'] = async (configId) => {
      const projectId = currentProjectId()
      const graph = useGraphStore.getState()
      const config = graph.nodes.find((n) => n.id === configId)
      if (!config || config.kind !== 'config')
        return failedResult(configId, 'Generate node not found')
      if (config.execution && ['queued', 'running'].includes(config.execution.status)) {
        return failedResult(configId, 'Node is already running')
      }
      const configExecution = startNodeExecution(configId, { projectId })
      if (!configExecution) return failedResult(configId, 'Unable to start generate node')
      if (config.data.mode === 'video') {
        return await runVideoConfigNode(config, configExecution.runId, projectId)
      }
      if (config.data.mode === 'text') {
        return await runTextConfigNode(config, configExecution.runId, projectId)
      }
      const target = resolveTarget(config.data.providerId, config.data.modelId)
      if (!target) {
        toast.error(t('drawPage.noModel'))
        updateNodeExecution(configId, 'failed', {
          runId: configExecution.runId,
          projectId,
          error: 'No image model configured'
        })
        return failedResult(configId, 'No image model configured', configExecution.runId)
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        updateNodeExecution(configId, 'failed', {
          runId: configExecution.runId,
          projectId,
          error: 'Provider authentication required'
        })
        return failedResult(configId, 'Provider authentication required', configExecution.runId)
      }
      const projectChange = interruptIfProjectChanged(projectId, configId, configExecution.runId)
      if (projectChange) return projectChange
      if (isRunCancelled(configId, configExecution.runId, projectId)) {
        return cancelledResult(configId, configExecution.runId, [])
      }
      const prompt = collectUpstreamText(configId)
      if (!prompt.trim()) {
        toast.error(t('drawPage.promptRequired', { defaultValue: 'Connect a text node' }))
        updateNodeExecution(configId, 'failed', {
          runId: configExecution.runId,
          projectId,
          error: 'Prompt required'
        })
        return failedResult(configId, 'Prompt required', configExecution.runId)
      }
      const references = await collectUpstreamImages(configId)
      const changedAfterReferences = interruptIfProjectChanged(
        projectId,
        configId,
        configExecution.runId
      )
      if (changedAfterReferences) return changedAfterReferences
      if (isRunCancelled(configId, configExecution.runId, projectId)) {
        return cancelledResult(configId, configExecution.runId, [])
      }
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
      const targetExecution = startNodeExecution(targetNode.id, { projectId })
      updateNodeExecution(configId, 'running', {
        runId: configExecution.runId,
        projectId,
        outputNodeIds: [targetNode.id]
      })
      if (!targetExecution) {
        updateNodeExecution(configId, 'failed', {
          runId: configExecution.runId,
          projectId,
          error: 'Unable to create image output node'
        })
        return failedResult(configId, 'Unable to create image output node', configExecution.runId, [
          targetNode.id
        ])
      }
      updateNodeExecution(targetNode.id, 'running', {
        runId: targetExecution.runId,
        projectId
      })
      try {
        const results = await runImages({
          prompt,
          references,
          config: applyImageOptions(
            target.config,
            config.data.aspect,
            config.data.quality,
            config.data.size
          ),
          count
        })
        if (isRunCancelled(targetNode.id, targetExecution.runId, projectId)) {
          updateNodeExecution(configId, 'cancelled', {
            runId: configExecution.runId,
            projectId,
            outputNodeIds: [targetNode.id]
          })
          return cancelledResult(configId, configExecution.runId, [targetNode.id])
        }
        const outputNodeIds = distributeResults(
          targetNode.id,
          results,
          prompt,
          target,
          targetExecution.runId,
          projectId
        )
        updateNodeExecution(configId, 'succeeded', {
          runId: configExecution.runId,
          projectId,
          outputNodeIds
        })
        return {
          ok: true,
          runId: configExecution.runId,
          nodeId: configId,
          outputNodeIds,
          status: 'succeeded'
        }
      } catch (error) {
        if (isRunCancelled(targetNode.id, targetExecution.runId, projectId)) {
          updateNodeExecution(configId, 'cancelled', {
            runId: configExecution.runId,
            projectId,
            outputNodeIds: [targetNode.id]
          })
          return cancelledResult(configId, configExecution.runId, [targetNode.id])
        }
        const message = error instanceof Error ? error.message : String(error)
        const patchFailedImage = (n: CanvasNode): CanvasNode =>
          n.kind === 'image'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: false,
                  interrupted: undefined,
                  error: message
                }
              }
            : n
        if (currentProjectId() === projectId) {
          useGraphStore.getState().updateNode(targetNode.id, patchFailedImage)
        } else {
          patchPersistedProjectGraph(projectId, (stored) => ({
            ...stored,
            nodes: stored.nodes.map((candidate) =>
              candidate.id === targetNode.id ? patchFailedImage(candidate) : candidate
            )
          }))
        }
        updateNodeExecution(targetNode.id, 'failed', {
          runId: targetExecution.runId,
          projectId,
          error: message
        })
        updateNodeExecution(configId, 'failed', {
          runId: configExecution.runId,
          projectId,
          error: message,
          outputNodeIds: [targetNode.id]
        })
        return failedResult(configId, message, configExecution.runId, [targetNode.id])
      }
    }

    const generateFromText: GraphActions['generateFromText'] = async (textId) => {
      const graph = useGraphStore.getState()
      const text = graph.nodes.find((n) => n.id === textId)
      if (!text || text.kind !== 'text') return failedResult(textId, 'Text node not found')
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
      return await runConfigNode(configNode.id)
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

    const applyEdit: GraphActions['applyEdit'] = async (imageNodeId, params) => {
      const projectId = currentProjectId()
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === imageNodeId)
      if (!node || node.kind !== 'image') return failedResult(imageNodeId, 'Image node not found')
      const base = params.baseImageDataUrl ?? (await resolveImageDataUrl(node.data))?.src
      if (!base) return failedResult(imageNodeId, 'Image data unavailable')
      if (currentProjectId() !== projectId) {
        return failedResult(imageNodeId, 'Canvas changed before image edit started')
      }
      const target = resolveTarget(
        params.providerId ?? node.data.providerId,
        params.modelId ?? node.data.modelId
      )
      if (!target) {
        toast.error(t('drawPage.noModel'))
        return failedResult(imageNodeId, 'No image model configured')
      }
      if (!(await ensureProviderAuthReady(target.provider.id))) {
        toast.error(t('drawPage.authRequired'))
        return failedResult(imageNodeId, 'Provider authentication required')
      }
      if (currentProjectId() !== projectId) {
        return failedResult(imageNodeId, 'Canvas changed before image edit started')
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
      const execution = startNodeExecution(child.id, { projectId })
      if (!execution) return failedResult(child.id, 'Unable to start image edit')
      updateNodeExecution(child.id, 'running', { runId: execution.runId, projectId })
      try {
        const results = await runImages({
          prompt: params.prompt,
          references: [{ src: base, mediaType: 'image/png' }],
          config: target.config,
          count: 1,
          edit: params.maskDataUrl
            ? { maskDataUrl: params.maskDataUrl, maskMediaType: 'image/png' }
            : undefined
        })
        if (isRunCancelled(child.id, execution.runId, projectId)) {
          return cancelledResult(child.id, execution.runId)
        }
        const outputNodeIds = distributeResults(
          child.id,
          results,
          params.prompt,
          target,
          execution.runId,
          projectId
        )
        return {
          ok: true,
          runId: execution.runId,
          nodeId: child.id,
          outputNodeIds,
          status: 'succeeded'
        }
      } catch (error) {
        if (isRunCancelled(child.id, execution.runId, projectId)) {
          return cancelledResult(child.id, execution.runId)
        }
        const message = error instanceof Error ? error.message : String(error)
        const patchFailedImage = (n: CanvasNode): CanvasNode =>
          n.kind === 'image'
            ? {
                ...n,
                data: {
                  ...n.data,
                  generating: false,
                  interrupted: undefined,
                  error: message
                }
              }
            : n
        if (currentProjectId() === projectId) {
          useGraphStore.getState().updateNode(child.id, patchFailedImage)
        } else {
          patchPersistedProjectGraph(projectId, (stored) => ({
            ...stored,
            nodes: stored.nodes.map((candidate) =>
              candidate.id === child.id ? patchFailedImage(candidate) : candidate
            )
          }))
        }
        updateNodeExecution(child.id, 'failed', {
          runId: execution.runId,
          projectId,
          error: message
        })
        return failedResult(child.id, message, execution.runId, [child.id])
      }
    }

    const addDerivedImage: GraphActions['addDerivedImage'] = async (sourceId, dataUrl, opts) => {
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((n) => n.id === sourceId)
      if (!node || node.kind !== 'image') return null
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
      return child.id
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

    const runNode: GraphActions['runNode'] = async (nodeId) => {
      const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return failedResult(nodeId, 'Node not found')
      if (node.kind === 'config') return await runConfigNode(nodeId)
      if (node.kind === 'image') return await generateImageNode(nodeId)
      if (node.kind === 'video') return await generateVideoNode(nodeId)
      return await generateFromText(nodeId)
    }

    const cancelNode: GraphActions['cancelNode'] = async (nodeId) => {
      const projectId = currentProjectId()
      const graph = useGraphStore.getState()
      const node = graph.nodes.find((candidate) => candidate.id === nodeId)
      if (!node?.execution || !['queued', 'running'].includes(node.execution.status)) return false
      rememberCancelledRun(node.execution.runId)
      if (node.kind === 'video' && node.data.jobId) {
        await ipcClient
          .invoke(IPC.SEEDANCE_VIDEO_CANCEL, { jobId: node.data.jobId })
          .catch(() => undefined)
      }
      updateNodeExecution(nodeId, 'cancelled', { runId: node.execution.runId, projectId })
      for (const outputId of node.execution.outputNodeIds ?? []) {
        const output = useGraphStore.getState().nodes.find((candidate) => candidate.id === outputId)
        if (output?.execution && ['queued', 'running'].includes(output.execution.status)) {
          rememberCancelledRun(output.execution.runId)
          if (output.kind === 'video' && output.data.jobId) {
            await ipcClient
              .invoke(IPC.SEEDANCE_VIDEO_CANCEL, { jobId: output.data.jobId })
              .catch(() => undefined)
          }
          updateNodeExecution(outputId, 'cancelled', {
            runId: output.execution.runId,
            projectId
          })
        }
      }
      for (const sourceId of upstreamNodeIds(graph.edges, nodeId)) {
        const source = useGraphStore.getState().nodes.find((candidate) => candidate.id === sourceId)
        if (
          source?.kind === 'config' &&
          source.execution &&
          ['queued', 'running'].includes(source.execution.status)
        ) {
          rememberCancelledRun(source.execution.runId)
          updateNodeExecution(source.id, 'cancelled', {
            runId: source.execution.runId,
            projectId,
            outputNodeIds: source.execution.outputNodeIds
          })
        }
      }
      return true
    }

    const retryNode: GraphActions['retryNode'] = async (nodeId) => await runNode(nodeId)

    return {
      runConfigNode,
      generateFromText,
      rewriteText,
      generateImageNode,
      generateVideoNode,
      runNode,
      cancelNode,
      retryNode,
      getNodeStatus: getNodeExecution,
      applyEdit,
      addDerivedImage,
      downloadImage
    }
  }, [t])
}
