import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'

export type PetProactiveFreq = 'low' | 'medium' | 'high'

/**
 * TTS transport: 'speech' = OpenAI POST /audio/speech; 'chat' = chat/completions
 * with an audio-capable model (Xiaomi MiMo TTS style); 'auto' guesses from the
 * model id.
 */
export type PetVoiceMode = 'auto' | 'speech' | 'chat'

/** Timed proactive chats per day for each frequency setting. */
export const PET_PROACTIVE_DAILY_CAP: Record<PetProactiveFreq, number> = {
  low: 1,
  medium: 2,
  high: 4
}

export interface PetAgentConfig {
  providerId: string | null
  modelId: string | null
  /** Empty string means the built-in prompt is used. */
  systemPrompt: string
  projectId: string | null
  /** Denormalized so the standalone pet window doesn't need the chat store. */
  projectName: string | null
  projectFolder: string | null
  /** Master switch for all LLM-generated proactive speech. Default off. */
  proactive: boolean
  proactiveFreq: PetProactiveFreq
  /** Quiet hours [start, end) in local hours; equal values disable them. */
  quietStart: number
  quietEnd: number
  /** Voice playback for the pet's AI replies. Default off. */
  voiceEnabled: boolean
  voiceProviderId: string | null
  voiceModelId: string | null
  /** Voice/timbre id; empty means the endpoint's default. */
  voice: string
  voiceMode: PetVoiceMode
  /** Optional style instruction passed to the TTS call. */
  voiceInstruction: string
  /**
   * Optional MiMo audio tag(s) prepended to the spoken text as `(tag)` —
   * dialects/emotions like 粤语、撒娇、耳语. Ignored for non-MiMo models.
   */
  voiceTag: string
}

interface PetAgentStore extends PetAgentConfig {
  setConfig: (config: Partial<PetAgentConfig>) => void
}

export function isInQuietHours(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false
  // Range may wrap midnight, e.g. 22 -> 9.
  return quietStart < quietEnd
    ? hour >= quietStart && hour < quietEnd
    : hour >= quietStart || hour < quietEnd
}

export const usePetAgentStore = create<PetAgentStore>()(
  persist(
    (set) => ({
      providerId: null,
      modelId: null,
      systemPrompt: '',
      projectId: null,
      projectName: null,
      projectFolder: null,
      proactive: false,
      proactiveFreq: 'low' as PetProactiveFreq,
      quietStart: 22,
      quietEnd: 9,
      voiceEnabled: false,
      voiceProviderId: null,
      voiceModelId: null,
      voice: '',
      voiceMode: 'auto' as PetVoiceMode,
      voiceInstruction: '',
      voiceTag: '',

      setConfig: (config) => set(config)
    }),
    {
      name: 'opencowork-pet-agent',
      storage: createJSONStorage(() => ipcStorage),
      partialize: (state) => ({
        providerId: state.providerId,
        modelId: state.modelId,
        systemPrompt: state.systemPrompt,
        projectId: state.projectId,
        projectName: state.projectName,
        projectFolder: state.projectFolder,
        proactive: state.proactive,
        proactiveFreq: state.proactiveFreq,
        quietStart: state.quietStart,
        quietEnd: state.quietEnd,
        voiceEnabled: state.voiceEnabled,
        voiceProviderId: state.voiceProviderId,
        voiceModelId: state.voiceModelId,
        voice: state.voice,
        voiceMode: state.voiceMode,
        voiceInstruction: state.voiceInstruction,
        voiceTag: state.voiceTag
      })
    }
  )
)
