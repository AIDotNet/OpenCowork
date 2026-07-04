import { nanoid } from 'nanoid'
import { agentBridge } from '@renderer/lib/ipc/agent-bridge'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { ensureProviderAuthReady } from '@renderer/lib/auth/provider-auth'
import { useProviderStore } from '@renderer/stores/provider-store'
import { usePetAgentStore, type PetVoiceMode } from '@renderer/stores/pet-agent-store'

/**
 * Voice playback for the pet's AI speech. Synthesis runs in the native
 * worker ('openai-audio/speech') and supports two transports:
 * - 'speech': classic OpenAI POST /audio/speech (tts-1, gpt-4o-mini-tts…)
 * - 'chat':   chat/completions with an audio-capable model (Xiaomi MiMo
 *             mimo-v2.5-tts, OpenAI gpt-4o-audio…), audio as base64.
 *
 * Streamed replies speak sentence-by-sentence (createPetSpeechSession):
 * each completed sentence is synthesized while the rest is still being
 * generated, so audio starts roughly in sync with the text.
 */

const SPEECH_TIMEOUT_MS = 120_000
const MAX_SPEECH_CHARS = 400
const SENTENCE_BOUNDARY = /[。！？!?；;…~～\n]/
/** Softer pause marks the opening segment may cut at for a faster start. */
const PAUSE_BOUNDARY = /[，,、]/
/** pcm16 sample rate used by MiMo and OpenAI chat-audio streams. */
const PCM_SAMPLE_RATE = 24_000

export const PET_VOICE_PRESETS: Record<'openai' | 'mimo', string[]> = {
  openai: [
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'fable',
    'onyx',
    'nova',
    'sage',
    'shimmer',
    'verse'
  ],
  mimo: ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']
}

export function resolvePetVoiceMode(modelId: string, mode: PetVoiceMode): 'speech' | 'chat' {
  if (mode !== 'auto') return mode
  // Chat-audio models speak through completions; plain TTS models through
  // the dedicated speech endpoint.
  return /mimo|-audio/i.test(modelId) ? 'chat' : 'speech'
}

export interface PetVoiceParams {
  providerId: string
  modelId: string
  voice: string
  mode: PetVoiceMode
  instruction: string
  /** MiMo `(tag)` prefix — dialect/emotion, e.g. 粤语、撒娇. Empty = off. */
  tag: string
}

/**
 * MiMo reads a leading `(tag)` as a style directive (dialect, emotion,
 * singing…). Other models would speak the tag aloud, so it only applies to
 * MiMo model ids. User input may already carry brackets — normalize them.
 */
function applyMimoTag(params: PetVoiceParams, input: string): string {
  if (!/mimo/i.test(params.modelId)) return input
  const tag = params.tag.replace(/^[（(["'\s]+|[）)\]"'\s]+$/g, '').trim()
  return tag ? `(${tag})${input}` : input
}

interface SpeechClip {
  base64: string
  mediaType: string
}

let currentAudio: HTMLAudioElement | null = null
let currentAudioUrl: string | null = null

let audioContext: AudioContext | null = null
let streamSources: AudioBufferSourceNode[] = []
let activeStreamRequestId: string | null = null

function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext()
  if (audioContext.state === 'suspended') void audioContext.resume()
  return audioContext
}

function stopStreamingPlayback(): void {
  for (const source of streamSources) {
    try {
      source.stop()
    } catch {
      // already stopped
    }
  }
  streamSources = []
  if (activeStreamRequestId) {
    void ipcClient.invoke('pet:tts-cancel', { requestId: activeStreamRequestId })
    activeStreamRequestId = null
  }
}

export function stopPetSpeech(): void {
  currentAudio?.pause()
  currentAudio = null
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl)
    currentAudioUrl = null
  }
  stopStreamingPlayback()
}

async function synthesizeClip(params: PetVoiceParams, text: string): Promise<SpeechClip> {
  const normalized = text.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH_CHARS)
  if (!normalized) throw new Error('empty speech text')
  const input = applyMimoTag(params, normalized)

  await ensureProviderAuthReady(params.providerId)
  const provider = useProviderStore
    .getState()
    .getProviderConfigById(params.providerId, params.modelId)
  if (!provider) throw new Error('pet voice model is not configured')
  if (!(await agentBridge.initialize())) {
    throw new Error('native worker unavailable for speech synthesis')
  }

  const mode = resolvePetVoiceMode(params.modelId, params.mode)
  const result = (await agentBridge.request(
    'openai-audio/speech',
    {
      provider,
      input,
      // The OpenAI speech endpoint requires a voice; chat-audio endpoints
      // fall back to their own default when omitted.
      voice: params.voice.trim() || (mode === 'speech' ? 'alloy' : ''),
      instruction: params.instruction.trim(),
      mode,
      // Chat-mode message shape: MiMo speaks the assistant message verbatim;
      // OpenAI audio models need a read-aloud instruction in a user message.
      chatStyle: /mimo/i.test(params.modelId) ? 'assistant' : 'instruct'
    },
    SPEECH_TIMEOUT_MS
  )) as { base64?: string; mediaType?: string; message?: string; error?: string } | null
  if (!result?.base64) {
    // Surface the worker's own error text when present (e.g. an outdated
    // native worker without the speech route, or an upstream API error).
    throw new Error(result?.message || result?.error || 'speech synthesis returned no audio')
  }
  return { base64: result.base64, mediaType: result.mediaType ?? 'audio/mpeg' }
}

/** Play one clip; resolves when playback ends or is interrupted. */
async function playClip(clip: SpeechClip): Promise<void> {
  stopPetSpeech()
  // Blob URL instead of a data: URL — WAV clips are megabytes of base64,
  // and the CSP media-src allows blob: playback.
  const binary = atob(clip.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: clip.mediaType }))
  const audio = new Audio(url)
  currentAudio = audio
  currentAudioUrl = url

  await new Promise<void>((resolve) => {
    const settle = (): void => {
      if (currentAudio === audio) currentAudio = null
      if (currentAudioUrl === url) {
        URL.revokeObjectURL(url)
        currentAudioUrl = null
      }
      resolve()
    }
    // 'pause' also fires when stopPetSpeech interrupts this clip, so a
    // queued session never hangs on an interrupted take.
    audio.addEventListener('ended', settle, { once: true })
    audio.addEventListener('error', settle, { once: true })
    audio.addEventListener('pause', settle, { once: true })
    audio.play().catch(settle)
  })
}

/**
 * Streamed chat-audio synthesis (stream: true, pcm16): the main process
 * forwards SSE audio deltas as they arrive and playback starts on the first
 * chunk instead of after the full clip. Resolves when playback finishes.
 */
async function streamAndPlay(params: PetVoiceParams, text: string): Promise<void> {
  const normalized = text.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH_CHARS)
  if (!normalized) return
  const input = applyMimoTag(params, normalized)

  await ensureProviderAuthReady(params.providerId)
  const provider = useProviderStore
    .getState()
    .getProviderConfigById(params.providerId, params.modelId)
  if (!provider) throw new Error('pet voice model is not configured')

  stopPetSpeech()
  const requestId = nanoid()
  activeStreamRequestId = requestId
  const ctx = getAudioContext()
  const startedAt = performance.now()
  let nextTime = 0
  let received = false

  const scheduleChunk = (base64: string): void => {
    const binary = atob(base64)
    const sampleCount = Math.floor(binary.length / 2)
    if (sampleCount === 0) return
    // pcm16 little-endian mono → float32
    const samples = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      let value = (binary.charCodeAt(i * 2 + 1) << 8) | binary.charCodeAt(i * 2)
      if (value >= 0x8000) value -= 0x10000
      samples[i] = value / 32768
    }
    const buffer = ctx.createBuffer(1, sampleCount, PCM_SAMPLE_RATE)
    buffer.copyToChannel(samples, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime + 0.08, nextTime)
    source.start(startAt)
    nextTime = startAt + buffer.duration
    streamSources.push(source)
    source.onended = () => {
      streamSources = streamSources.filter((item) => item !== source)
    }
  }

  const unsubscribe = ipcClient.on('pet:tts-stream-event', (payload) => {
    const event = payload as { requestId?: string; type?: string; data?: string } | null
    if (!event || event.requestId !== requestId) return
    if (event.type === 'chunk' && event.data && activeStreamRequestId === requestId) {
      if (!received) {
        console.info(
          `[Pet][voice] first stream chunk after ${Math.round(performance.now() - startedAt)}ms`
        )
      }
      received = true
      scheduleChunk(event.data)
    }
  })

  try {
    const mode = resolvePetVoiceMode(params.modelId, params.mode)
    await ipcClient.invoke('pet:tts-stream', {
      requestId,
      provider,
      input,
      voice: params.voice.trim() || (mode === 'speech' ? 'alloy' : ''),
      instruction: params.instruction.trim(),
      chatStyle: /mimo/i.test(params.modelId) ? 'assistant' : 'instruct'
    })
    if (!received) throw new Error('speech stream returned no audio')
    // Wait for the scheduled tail to finish playing.
    const remaining = nextTime - ctx.currentTime
    if (remaining > 0 && activeStreamRequestId === requestId) {
      await new Promise((resolve) => setTimeout(resolve, remaining * 1000 + 120))
    }
  } finally {
    unsubscribe()
    if (activeStreamRequestId === requestId) activeStreamRequestId = null
  }
}

/** Models whose endpoint rejected streaming — skip the doomed attempt. */
const streamUnsupported = new Set<string>()

/**
 * Speak one text and resolve when playback ends. Chat-audio models stream
 * (first sound within ~a second); on stream failure, and for /audio/speech
 * models, fall back to whole-clip synthesis.
 */
async function speakOne(params: PetVoiceParams, text: string): Promise<void> {
  const mode = resolvePetVoiceMode(params.modelId, params.mode)
  const streamKey = `${params.providerId}::${params.modelId}`
  const startedAt = performance.now()
  if (mode === 'chat' && !streamUnsupported.has(streamKey)) {
    try {
      await streamAndPlay(params, text)
      return
    } catch (error) {
      streamUnsupported.add(streamKey)
      console.warn('[Pet][voice] streaming TTS failed, falling back to non-streaming:', error)
    }
  }
  const clip = await synthesizeClip(params, text)
  console.info(
    `[Pet][voice] clip synthesized in ${Math.round(performance.now() - startedAt)}ms (${text.length} chars)`
  )
  await playClip(clip)
}

/** Synthesize and fully play one text; throws on failure (settings test). */
export async function playPetVoice(params: PetVoiceParams, text: string): Promise<void> {
  await speakOne(params, text)
}

function voiceParamsFromConfig(): PetVoiceParams | null {
  const config = usePetAgentStore.getState()
  if (!config.voiceEnabled || !config.voiceProviderId || !config.voiceModelId) return null
  return {
    providerId: config.voiceProviderId,
    modelId: config.voiceModelId,
    voice: config.voice,
    mode: config.voiceMode,
    instruction: config.voiceInstruction,
    tag: config.voiceTag
  }
}

/** Speak a complete text using the saved config; silent on any failure. */
export async function speakPetText(text: string): Promise<void> {
  const params = voiceParamsFromConfig()
  if (!params) return
  try {
    await speakOne(params, text)
  } catch (error) {
    console.error('[Pet] speech synthesis failed:', error)
  }
}

/** Index just past the last sentence boundary in the text, or 0. */
function lastSentenceBoundary(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (SENTENCE_BOUNDARY.test(text[i])) return i + 1
  }
  return 0
}

/**
 * Cut for the OPENING segment: the earliest boundary, and commas count once
 * a few characters exist — the first sound should start as soon as possible,
 * even mid-sentence. Pet replies often end in "~" with no full stop at all.
 */
function firstSegmentCut(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_BOUNDARY.test(text[i])) return i + 1
    if (i >= 5 && PAUSE_BOUNDARY.test(text[i])) return i + 1
  }
  return 0
}

export interface PetSpeechSession {
  /** Feed the cumulative (cleaned) streamed text; speaks finished sentences. */
  feed: (cumulativeText: string) => void
  /** Flush the trailing sentence once the reply is complete. */
  finish: (finalText: string) => void
  cancel: () => void
}

let sessionCounter = 0
let activeSessionId = 0

/**
 * Sentence-streaming speech for a streamed reply: sentences are synthesized
 * as soon as they complete (concurrently with generation) and played back
 * strictly in order. Returns null when voice is disabled/unconfigured.
 */
export function createPetSpeechSession(): PetSpeechSession | null {
  const params = voiceParamsFromConfig()
  if (!params) return null

  const id = ++sessionCounter
  activeSessionId = id
  const queue: string[] = []
  let committed = ''
  let playing = false
  let done = false

  const pump = async (): Promise<void> => {
    if (playing) return
    playing = true
    try {
      while (queue.length > 0) {
        if (activeSessionId !== id) return
        const text = queue.shift()!
        try {
          await speakOne(params, text)
        } catch (error) {
          console.error('[Pet] speech synthesis failed:', error)
        }
      }
    } finally {
      playing = false
    }
  }

  const enqueue = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    queue.push(trimmed)
    void pump()
  }

  const feed = (cumulativeText: string): void => {
    if (done || activeSessionId !== id) return
    // Streamed text should only grow; if it was rewritten (think-tag
    // stripping edge cases), wait for finish() to settle things.
    if (!cumulativeText.startsWith(committed)) return
    const pending = cumulativeText.slice(committed.length)
    // Opening segment cuts aggressively (first pause mark) so speech starts
    // as early as possible; later segments batch whole sentences.
    const cut = committed === '' ? firstSegmentCut(pending) : lastSentenceBoundary(pending)
    if (cut > 0) {
      enqueue(pending.slice(0, cut))
      committed = cumulativeText.slice(0, committed.length + cut)
    }
  }

  const finish = (finalText: string): void => {
    if (done || activeSessionId !== id) return
    done = true
    if (finalText.startsWith(committed)) {
      enqueue(finalText.slice(committed.length))
    } else if (!committed) {
      enqueue(finalText)
    }
    // Mismatch after sentences were already spoken: skip the tail rather
    // than repeating the whole reply.
  }

  const cancel = (): void => {
    done = true
    if (activeSessionId === id) {
      activeSessionId = 0
      stopPetSpeech()
    }
  }

  return { feed, finish, cancel }
}

/** Whether the app-wide speech recognition model is configured. */
export function isVoiceInputConfigured(): boolean {
  const store = useProviderStore.getState()
  return !!store.activeSpeechProviderId && !!store.activeSpeechModelId
}

/**
 * Transcribe recorded voice input with the app's speech recognition model
 * (Settings → Model → Speech recognition) via the native worker.
 */
export async function transcribeVoiceInput(base64: string, mediaType: string): Promise<string> {
  const store = useProviderStore.getState()
  const providerId = store.activeSpeechProviderId
  if (!providerId) throw new Error('speech recognition model is not configured')
  await ensureProviderAuthReady(providerId)
  const config = store.getSpeechProviderConfig()
  if (!config) throw new Error('speech recognition model is not configured')
  if (!(await agentBridge.initialize())) {
    throw new Error('native worker unavailable for transcription')
  }

  const result = (await agentBridge.request(
    'openai-audio/transcribe',
    {
      provider: config,
      file: { base64, mediaType, fileName: 'voice-input.webm' }
    },
    SPEECH_TIMEOUT_MS
  )) as { text?: string } | null
  return result?.text?.trim() ?? ''
}
