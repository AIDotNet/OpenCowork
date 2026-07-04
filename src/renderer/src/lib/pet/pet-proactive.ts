import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  PET_PROACTIVE_DAILY_CAP,
  isInQuietHours,
  usePetAgentStore
} from '@renderer/stores/pet-agent-store'
import { getPetLevel, getProactiveCountToday, usePetStore } from '@renderer/stores/pet-store'
import { usePetExpStore } from '@renderer/stores/pet-exp-store'
import { buildPetSystemPrompt, runPetChat } from './pet-agent'
import {
  appendPetMemories,
  buildMemorySection,
  extractMemoryDirectives,
  loadPetMemories,
  stripMemoryDirectives
} from './pet-memory'

/**
 * LLM-generated proactive speech (event remarks + timed small talk). All of
 * it is gated behind the user's proactive switch, quiet hours, and cooldowns
 * so the pet is lively but never spammy. Every failure is silent — proactive
 * speech must never surface an error dialog on the desktop.
 */

/** Minimum gap between any two LLM remarks (events included). */
const REMARK_MIN_GAP_MS = 10 * 60_000
/** Minimum gap between two timed small-talk initiations. */
const TIMED_MIN_GAP_MS = 2 * 60 * 60_000

let lastRemarkAt = 0

/** Event descriptions handed to the model (it replies in the UI language). */
export const petEvents = {
  levelUp: (level: number) => `你刚刚升级到了 Lv.${level}，很开心，想跟主人报喜。`,
  workDone: (coins: number) => `你刚打工回来，赚到了 ${coins} 金币，有点累但很有成就感。`,
  studyDone: (growth: number) => `你刚放学回来，学到了不少东西（成长 +${growth}）。`,
  bigMeal: (tokens: number) =>
    `主人刚刚用 AI 完成了一个大任务，你一口气吃掉了约 ${tokens.toLocaleString()} 个 token，撑得不行。`
}

function proactiveAllowed(now: number): boolean {
  const config = usePetAgentStore.getState()
  if (!config.proactive || !config.providerId || !config.modelId) return false
  if (isInQuietHours(new Date(now).getHours(), config.quietStart, config.quietEnd)) return false
  return true
}

async function runRemark(event: string, allowTools: boolean): Promise<string | null> {
  const config = usePetAgentStore.getState()
  if (!config.providerId || !config.modelId) return null
  try {
    const store = usePetStore.getState()
    const memorySection = buildMemorySection(await loadPetMemories())
    const persona = buildPetSystemPrompt(config.systemPrompt, {
      petName: store.name,
      hunger: store.hunger,
      cleanliness: store.cleanliness,
      mood: store.mood,
      level: getPetLevel(store.growth + usePetExpStore.getState().totalExp),
      projectName: config.projectName,
      projectFolder: config.projectFolder,
      memorySection
    })
    const language = useSettingsStore.getState().language
    const instruction = [
      '<system-remind>',
      '这不是主人发来的消息，而是一次系统事件提醒。',
      `事件：${event}`,
      `请你以宠物的身份主动对主人说一两句话（不超过 40 字），语气自然，不要提到"系统"或"事件"这些词。使用界面语言（${language}）。只输出要说的话本身。`,
      '</system-remind>'
    ].join('\n')

    const reply = await runPetChat({
      providerId: config.providerId,
      modelId: config.modelId,
      persona,
      userText: instruction,
      history: [],
      workingFolder: allowTools ? config.projectFolder : null
    })
    const memories = extractMemoryDirectives(reply)
    if (memories.length > 0) void appendPetMemories(memories)
    return stripMemoryDirectives(reply) || null
  } catch (error) {
    console.error('[Pet] proactive remark failed:', error)
    return null
  }
}

/**
 * Layer 2 — a short in-character remark about something that just happened
 * (level-up, back from work, big token meal). Returns null when disabled,
 * inside quiet hours, cooling down, or on any error.
 */
export async function runPetEventRemark(event: string): Promise<string | null> {
  const now = Date.now()
  if (!proactiveAllowed(now)) return null
  if (now - lastRemarkAt < REMARK_MIN_GAP_MS) return null
  lastRemarkAt = now
  return runRemark(event, false)
}

/**
 * Layer 3 — timed small talk: the pet reaches out on its own, optionally
 * peeking at the bound project with read-only tools for something concrete
 * to say. Counts against the per-day quota chosen in settings.
 */
export async function runTimedProactiveChat(): Promise<string | null> {
  const now = Date.now()
  if (!proactiveAllowed(now)) return null
  const config = usePetAgentStore.getState()
  const store = usePetStore.getState()
  if (getProactiveCountToday(store) >= PET_PROACTIVE_DAILY_CAP[config.proactiveFreq]) return null
  if (now - store.lastProactiveAt < TIMED_MIN_GAP_MS) return null
  if (now - lastRemarkAt < REMARK_MIN_GAP_MS) return null

  store.recordProactive(now)
  lastRemarkAt = now
  const event = config.projectFolder
    ? '你有一阵子没和主人说话了，想主动找主人聊两句。你可以先用只读工具快速看一眼绑定项目（最多 2 次工具调用），结合最近的文件聊点具体的；也可以结合你的状态和记忆，说一句自然的开场白或关心的话。'
    : '你有一阵子没和主人说话了，想主动找主人聊两句。结合你的状态和记忆，说一句自然的开场白或关心的话。'
  return runRemark(event, true)
}
