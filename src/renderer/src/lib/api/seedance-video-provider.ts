/**
 * Seedance (Volcengine Ark) video generation helpers for the renderer.
 *
 * The actual submit → poll → download → persist pipeline runs in the MAIN process
 * (see src/main/ipc/seedance-video-handlers.ts) so generation is fully backgrounded;
 * the renderer only starts a job (IPC.SEEDANCE_VIDEO_START) and receives status
 * events. This module just holds the shared param shape + command formatting.
 */

export interface SeedanceVideoParams {
  ratio?: string
  resolution?: string
  duration?: number
  /** 1.x only — 2.x output is fixed at 24fps and rejects the field. */
  fps?: number
  watermark?: boolean
  seed?: number
  /** 1.x only — 2.x dropped it; camera motion moves into the prompt text. */
  cameraFixed?: boolean
  /** 2.x only: native audio track. Server default is on, so leave undefined to inherit it. */
  generateAudio?: boolean
  /** 2.x only: how upstream images map to `role` in the task content array. */
  frameRole?: 'auto' | 'first-last'
}

/**
 * Seedance 2.x takes structured top-level task params (ratio/resolution/duration/
 * watermark/seed/generate_audio); 1.x takes the `--flag` suffixes built below.
 * Detected from the model id so user-added custom models work without extra config.
 * Mirrored by UsesStructuredParams() in the C# module
 * (sidecars/OpenCowork.Native.Worker/Modules/Seedance/SeedanceVideoTools.cs) — the two
 * must agree, or a request carries both the flags and the structured fields.
 * Unrecognized ids (e.g. Ark `ep-...` endpoint ids) fall back to 1.x.
 */
const SEEDANCE_VERSION = /seedance[-_. ]?v?(\d+)/i

export function isSeedanceStructuredModel(modelId?: string): boolean {
  const major = SEEDANCE_VERSION.exec(modelId ?? '')?.[1]
  return major !== undefined && Number(major) >= 2
}

/** Build the Seedance 1.x `--command` suffix appended to the prompt text. */
export function buildSeedanceCommands(params: SeedanceVideoParams): string {
  const parts: string[] = []
  if (params.ratio) parts.push(`--ratio ${params.ratio}`)
  if (params.resolution) parts.push(`--resolution ${params.resolution}`)
  if (params.duration) parts.push(`--dur ${params.duration}`)
  if (params.fps) parts.push(`--fps ${params.fps}`)
  if (typeof params.watermark === 'boolean') parts.push(`--watermark ${params.watermark}`)
  if (typeof params.cameraFixed === 'boolean') parts.push(`--camerafixed ${params.cameraFixed}`)
  if (typeof params.seed === 'number') parts.push(`--seed ${params.seed}`)
  return parts.length ? ` ${parts.join(' ')}` : ''
}
