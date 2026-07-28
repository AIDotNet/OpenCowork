import { ipcMain, webContents } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getNativeWorker, NATIVE_WORKER_NO_TIMEOUT } from '../lib/native-worker'

/**
 * Background video generation. All work — submitting the task, polling
 * for completion, downloading and persisting the mp4 — runs here in the main
 * process, decoupled from the renderer. The renderer starts a job, then only
 * receives `seedance-video:job-update` status events (and can query status on
 * reconnect). Generation therefore survives page navigation in the renderer.
 */

interface VideoJob {
  jobId: string
  projectId?: string
  nodeId?: string
  runId?: string
  taskId?: string
  status: string
  filePath?: string
  mediaType?: string
  prompt?: string
  progress?: number
  error?: string
  done: boolean
}

const POLL_INTERVAL_MS = 4000
const MAX_POLL_ERRORS = 6
const jobs = new Map<string, VideoJob>()
const jobControllers = new Map<string, AbortController>()

type VideoOperation = 'generate' | 'status' | 'download'

function getWorkerMethod(provider: unknown, operation: VideoOperation): string {
  const type =
    provider && typeof provider === 'object' && 'type' in provider
      ? (provider as { type?: unknown }).type
      : undefined
  const module =
    type === 'xai-video' ? 'xai-video' : type === 'openai-video' ? 'openai-video' : 'seedance-video'
  return `${module}/${operation}`
}

function publicJob(job: VideoJob): Omit<VideoJob, 'taskId'> {
  const { taskId: _taskId, ...rest } = job
  return rest
}

function broadcast(job: VideoJob): void {
  const payload = publicJob(job)
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('seedance-video:job-update', payload)
  }
}

function getVideosDir(): string {
  const dir = join(homedir(), 'open-cowork', 'video')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollJob(job: VideoJob, provider: unknown, signal: AbortSignal): Promise<void> {
  const worker = getNativeWorker()
  let consecutiveErrors = 0
  while (!job.done) {
    await sleep(POLL_INTERVAL_MS)
    if (job.done || signal.aborted) return
    try {
      const st = (await getNativeWorker().request(
        getWorkerMethod(provider, 'status'),
        { provider, taskId: job.taskId },
        NATIVE_WORKER_NO_TIMEOUT,
        signal
      )) as { status?: string; videoUrl?: string; progress?: number; error?: string }
      // Some compatible gateways omit status for an intermediate poll. Keep a
      // useful running state instead of exposing the protocol detail as "unknown".
      job.status = st?.status && st.status !== 'unknown' ? st.status : 'processing'
      if (typeof st.progress === 'number') {
        job.progress = Math.max(0, Math.min(100, st.progress))
      }

      if (job.status === 'succeeded') {
        job.progress = 100
        if (!st.videoUrl) {
          job.status = 'failed'
          job.error = 'Succeeded but no video URL.'
          job.done = true
          broadcast(job)
          return
        }
        const dl = (await worker.request(
          getWorkerMethod(provider, 'download'),
          { provider, videoUrl: st.videoUrl },
          NATIVE_WORKER_NO_TIMEOUT,
          signal
        )) as { filePath?: string; data?: string; mediaType?: string }
        if (dl?.filePath) {
          job.filePath = dl.filePath
          job.mediaType = dl.mediaType || 'video/mp4'
        } else if (dl?.data) {
          const mediaType = dl.mediaType || 'video/mp4'
          const ext = mediaType.includes('webm') ? '.webm' : '.mp4'
          const filePath = join(getVideosDir(), `${Date.now()}-${randomUUID()}${ext}`)
          writeFileSync(filePath, Buffer.from(dl.data, 'base64'))
          job.filePath = filePath
          job.mediaType = mediaType
        } else {
          job.status = 'failed'
          job.error = 'Failed to download the generated video.'
        }
        job.done = true
        broadcast(job)
        return
      }

      if (job.status === 'failed' || job.status === 'cancelled') {
        job.error = st.error || `Video task ${job.status}.`
        job.done = true
        broadcast(job)
        return
      }

      broadcast(job)
    } catch (error) {
      consecutiveErrors += 1
      if (consecutiveErrors < MAX_POLL_ERRORS) {
        // Transient network error — keep polling
        broadcast(job)
        continue
      }
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.done = true
      broadcast(job)
      return
    }
    consecutiveErrors = 0
  }
}

async function runVideoJob(
  job: VideoJob,
  provider: unknown,
  prompt: string,
  images: unknown[],
  video: unknown,
  signal: AbortSignal
): Promise<void> {
  try {
    const created = (await getNativeWorker().request(
      getWorkerMethod(provider, 'generate'),
      { provider, prompt, images, video },
      NATIVE_WORKER_NO_TIMEOUT,
      signal
    )) as { id?: string; error?: string; message?: string }
    if (job.done || signal.aborted) return
    if (!created?.id) {
      throw new Error(
        created?.error ||
          created?.message ||
          `Video provider returned no task id (${getWorkerMethod(provider, 'generate')}).`
      )
    }

    job.taskId = created.id
    job.status = 'queued'
    broadcast(job)
    await pollJob(job, provider, signal)
  } catch (error) {
    if (job.done || signal.aborted) return
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
    job.done = true
    broadcast(job)
  } finally {
    jobControllers.delete(job.jobId)
  }
}

export function registerSeedanceVideoHandlers(): void {
  ipcMain.handle(
    'seedance-video:start',
    async (
      _event,
      args: {
        projectId?: string
        nodeId?: string
        runId?: string
        provider: unknown
        prompt: string
        images?: unknown[]
        // Forwarded verbatim to the worker module. Each protocol reads the subset it
        // understands: xAI/Sora take duration/aspectRatio/resolution, Seedance 2.x also
        // takes watermark/seed/generateAudio as structured task params.
        video?: {
          duration?: number
          aspectRatio?: string
          resolution?: string
          watermark?: boolean
          seed?: number
          generateAudio?: boolean
        }
      }
    ): Promise<{ jobId?: string; status?: string; error?: string }> => {
      const jobId = randomUUID()
      const job: VideoJob = {
        jobId,
        projectId: args.projectId,
        nodeId: args.nodeId,
        runId: args.runId,
        status: 'submitting',
        progress: 0,
        prompt: args.prompt,
        done: false
      }
      const controller = new AbortController()
      jobs.set(jobId, job)
      jobControllers.set(jobId, controller)
      // Let the IPC response deliver the job id before a very fast provider error
      // can broadcast a terminal update that the renderer has not attached yet.
      setImmediate(() => {
        void runVideoJob(
          job,
          args.provider,
          args.prompt,
          args.images ?? [],
          args.video,
          controller.signal
        )
      })
      return { jobId, status: 'submitting' }
    }
  )

  ipcMain.handle(
    'seedance-video:status',
    async (
      _event,
      args: { jobId: string }
    ): Promise<Omit<VideoJob, 'taskId'> | { error: string }> => {
      const job = jobs.get(args.jobId)
      return job ? publicJob(job) : { error: 'unknown job' }
    }
  )

  // Stop polling a job locally. The Ark task may keep running server-side, but we
  // stop tracking it and mark the node idle.
  ipcMain.handle('seedance-video:cancel', async (_event, args: { jobId: string }) => {
    const job = jobs.get(args.jobId)
    if (job && !job.done) {
      job.done = true
      job.status = 'cancelled'
      jobControllers.get(job.jobId)?.abort()
      jobControllers.delete(job.jobId)
      broadcast(job)
    }
    return { ok: true }
  })
}
