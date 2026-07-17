import { ipcMain, webContents } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getNativeWorker } from '../lib/native-worker'

/**
 * Background video generation. All work — submitting the task, polling
 * for completion, downloading and persisting the mp4 — runs here in the main
 * process, decoupled from the renderer. The renderer starts a job, then only
 * receives `seedance-video:job-update` status events (and can query status on
 * reconnect). Generation therefore survives page navigation in the renderer.
 */

interface VideoJob {
  jobId: string
  taskId?: string
  status: string
  filePath?: string
  mediaType?: string
  prompt?: string
  error?: string
  done: boolean
}

const POLL_INTERVAL_MS = 4000
const MAX_WAIT_MS = 10 * 60 * 1000
const jobs = new Map<string, VideoJob>()

type VideoOperation = 'generate' | 'status' | 'download'

function getWorkerMethod(provider: unknown, operation: VideoOperation): string {
  const type =
    provider && typeof provider === 'object' && 'type' in provider
      ? (provider as { type?: unknown }).type
      : undefined
  return `${type === 'xai-video' ? 'xai-video' : 'seedance-video'}/${operation}`
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

async function pollJob(job: VideoJob, provider: unknown): Promise<void> {
  const worker = getNativeWorker()
  const startedAt = Date.now()
  while (!job.done) {
    await sleep(POLL_INTERVAL_MS)
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      job.status = 'failed'
      job.error = 'Video generation timed out.'
      job.done = true
      broadcast(job)
      return
    }
    try {
      const st = (await getNativeWorker().request(
        getWorkerMethod(provider, 'status'),
        { provider, taskId: job.taskId },
        60_000
      )) as { status?: string; videoUrl?: string; error?: string }
      job.status = st?.status ?? 'unknown'

      if (job.status === 'succeeded') {
        if (!st.videoUrl) {
          job.status = 'failed'
          job.error = 'Succeeded but no video URL.'
          job.done = true
          broadcast(job)
          return
        }
        const dl = (await worker.request(
          getWorkerMethod(provider, 'download'),
          { videoUrl: st.videoUrl },
          120_000
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
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.done = true
      broadcast(job)
      return
    }
  }
}

export function registerSeedanceVideoHandlers(): void {
  ipcMain.handle(
    'seedance-video:start',
    async (
      _event,
      args: {
        provider: unknown
        prompt: string
        images?: unknown[]
        video?: { duration?: number; aspectRatio?: string; resolution?: string }
      }
    ): Promise<{ jobId?: string; status?: string; error?: string }> => {
      try {
        const created = (await getNativeWorker().request(
          getWorkerMethod(args.provider, 'generate'),
          {
            provider: args.provider,
            prompt: args.prompt,
            images: args.images ?? [],
            video: args.video
          },
          300_000
        )) as { id?: string }
        if (!created?.id) return { error: 'Video provider returned no task id.' }
        const jobId = randomUUID()
        const job: VideoJob = {
          jobId,
          taskId: created.id,
          status: 'queued',
          prompt: args.prompt,
          done: false
        }
        jobs.set(jobId, job)
        void pollJob(job, args.provider)
        return { jobId, status: 'queued' }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
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
      broadcast(job)
    }
    return { ok: true }
  })
}
