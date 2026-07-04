import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import { usePetExpStore } from '@renderer/stores/pet-exp-store'

export type PetAwayKind = 'work' | 'study'

export interface PetAwayTask {
  kind: PetAwayKind
  startedAt: number
  endsAt: number
}

export type PetActionResult =
  | { ok: true }
  | { ok: false; reason: 'coins' | 'full' | 'clean' | 'hungry' | 'level' | 'busy' | 'sleeping' }

export interface PetAwayReward {
  kind: PetAwayKind
  coins: number
  growth: number
}

interface PetData {
  name: string
  hunger: number
  cleanliness: number
  mood: number
  growth: number
  coins: number
  sleeping: boolean
  awayTask: PetAwayTask | null
  lastTickAt: number
  adoptedAt: number
  /** Largest companionship milestone (in days) already celebrated. */
  lastMilestoneDays: number
  /** Local date (YYYY-MM-DD) the proactive counter belongs to. */
  proactiveDate: string
  /** Timed proactive chats fired on proactiveDate. */
  proactiveCount: number
  lastProactiveAt: number
  /** How much of totalExp has already been converted into coins. */
  coinCreditedExp: number
  /** Local date (YYYY-MM-DD) the daily check-in bonus was last claimed. */
  lastDailyBonusDate: string
}

interface PetStore extends PetData {
  tick: (now?: number) => void
  feed: () => PetActionResult
  bathe: () => PetActionResult
  soak: () => PetActionResult
  play: () => PetActionResult
  toggleSleep: () => void
  startWork: () => PetActionResult
  startStudy: () => PetActionResult
  resolveAwayTask: (now?: number) => PetAwayReward | null
  petted: () => void
  markMilestone: (days: number) => void
  /** Count one timed proactive chat against today's quota. */
  recordProactive: (now?: number) => void
  /** Convert newly earned XP into coins (1 XP = 1 coin); returns the credit. */
  creditExpCoins: () => number
  /** First visit of the day: +DAILY_BONUS_COINS. Returns the bonus or null. */
  claimDailyBonus: () => number | null
  addCoins: (amount: number) => void
}

export function localDateKey(now = Date.now()): string {
  const d = new Date(now)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Timed proactive chats already fired today (rolls over at local midnight). */
export function getProactiveCountToday(state: {
  proactiveDate: string
  proactiveCount: number
}): number {
  return state.proactiveDate === localDateKey() ? state.proactiveCount : 0
}

export const PET_TICK_MS = 30_000

export const WORK_MIN_LEVEL = 4
export const STUDY_MIN_LEVEL = 6
export const SOAK_MIN_LEVEL = 2
export const WORK_DURATION_MS = 30 * 60_000
export const STUDY_DURATION_MS = 20 * 60_000
export const WORK_REWARD_COINS = 60
export const WORK_REWARD_GROWTH = 30
export const STUDY_REWARD_GROWTH = 240
export const FEED_COST = 10
export const BATHE_COST = 6
export const SOAK_COST = 15
export const STUDY_COST = 20
export const DAILY_BONUS_COINS = 20
/** Cap for the one-time retroactive coin grant when upgrading mid-progress. */
const RETRO_COIN_CAP = 200

// Cumulative growth required to reach a level: 5000 * (level - 1)^2.
// Deliberately steep — XP comes from token usage (1 XP ≈ 1k base-model
// tokens), so Lv.2 ≈ 5M tokens and levels are a long-term progression.
const LEVEL_GROWTH_COEFFICIENT = 5000

export function getPetLevel(growth: number): number {
  return Math.floor(Math.sqrt(Math.max(0, growth) / LEVEL_GROWTH_COEFFICIENT)) + 1
}

export function getGrowthForLevel(level: number): number {
  return LEVEL_GROWTH_COEFFICIENT * Math.max(0, level - 1) ** 2
}

export function getLevelProgress(growth: number): number {
  const level = getPetLevel(growth)
  const current = getGrowthForLevel(level)
  const next = getGrowthForLevel(level + 1)
  return Math.min(1, Math.max(0, (growth - current) / (next - current)))
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value))
}

// Per-minute rates. Offline time is settled with the same formula on rehydrate.
// Growth is NOT time-based: experience comes from token usage (pet-exp-store)
// plus work/study rewards.
function applyDecay(data: PetData, elapsedMs: number): Partial<PetData> {
  const minutes = Math.min(elapsedMs, 24 * 60 * 60_000) / 60_000
  if (minutes <= 0) return {}

  const restFactor = data.sleeping ? 0.4 : data.awayTask ? 0.5 : 1
  const hunger = clamp(data.hunger - 0.8 * restFactor * minutes)
  const cleanliness = clamp(data.cleanliness - 0.5 * restFactor * minutes)

  const uncomfortable = hunger < 30 || cleanliness < 30
  const moodDelta = uncomfortable ? -1.2 * minutes : 0.6 * minutes
  const mood = clamp(data.mood + moodDelta)

  return { hunger, cleanliness, mood }
}

/** Reward growth (work/study) + token experience — the value levels derive from. */
export function getCombinedGrowth(rewardGrowth: number): number {
  return rewardGrowth + usePetExpStore.getState().totalExp
}

const initialData = (): PetData => ({
  name: 'Kapi',
  hunger: 80,
  cleanliness: 80,
  mood: 70,
  growth: 0,
  coins: 120,
  sleeping: false,
  awayTask: null,
  lastTickAt: Date.now(),
  adoptedAt: Date.now(),
  lastMilestoneDays: 0,
  proactiveDate: '',
  proactiveCount: 0,
  lastProactiveAt: 0,
  coinCreditedExp: 0,
  lastDailyBonusDate: ''
})

export const usePetStore = create<PetStore>()(
  persist(
    (set, get) => ({
      ...initialData(),

      tick: (now = Date.now()) => {
        const state = get()
        const elapsed = now - state.lastTickAt
        if (elapsed < 1000) return
        set({ ...applyDecay(state, elapsed), lastTickAt: now })
      },

      feed: () => {
        const state = get()
        if (state.awayTask) return { ok: false, reason: 'busy' }
        if (state.sleeping) return { ok: false, reason: 'sleeping' }
        if (state.hunger >= 95) return { ok: false, reason: 'full' }
        if (state.coins < FEED_COST) return { ok: false, reason: 'coins' }
        set({
          coins: state.coins - FEED_COST,
          hunger: clamp(state.hunger + 35),
          mood: clamp(state.mood + 2)
        })
        return { ok: true }
      },

      bathe: () => {
        const state = get()
        if (state.awayTask) return { ok: false, reason: 'busy' }
        if (state.sleeping) return { ok: false, reason: 'sleeping' }
        if (state.cleanliness >= 95) return { ok: false, reason: 'clean' }
        if (state.coins < BATHE_COST) return { ok: false, reason: 'coins' }
        set({
          coins: state.coins - BATHE_COST,
          cleanliness: clamp(state.cleanliness + 45),
          mood: clamp(state.mood + 1)
        })
        return { ok: true }
      },

      // The capybara signature: a hot-spring soak restores mood like nothing else.
      soak: () => {
        const state = get()
        if (state.awayTask) return { ok: false, reason: 'busy' }
        if (state.sleeping) return { ok: false, reason: 'sleeping' }
        if (getPetLevel(getCombinedGrowth(state.growth)) < SOAK_MIN_LEVEL)
          return { ok: false, reason: 'level' }
        if (state.coins < SOAK_COST) return { ok: false, reason: 'coins' }
        set({
          coins: state.coins - SOAK_COST,
          cleanliness: clamp(state.cleanliness + 30),
          mood: clamp(state.mood + 28)
        })
        return { ok: true }
      },

      play: () => {
        const state = get()
        if (state.awayTask) return { ok: false, reason: 'busy' }
        if (state.sleeping) return { ok: false, reason: 'sleeping' }
        if (state.hunger < 10) return { ok: false, reason: 'hungry' }
        set({
          mood: clamp(state.mood + 18),
          hunger: clamp(state.hunger - 6),
          cleanliness: clamp(state.cleanliness - 4)
        })
        return { ok: true }
      },

      toggleSleep: () => {
        const state = get()
        if (state.awayTask) return
        state.tick()
        set({ sleeping: !get().sleeping })
      },

      startWork: () => {
        const state = get()
        if (state.awayTask) return { ok: false, reason: 'busy' }
        if (getPetLevel(getCombinedGrowth(state.growth)) < WORK_MIN_LEVEL)
          return { ok: false, reason: 'level' }
        if (state.hunger < 20) return { ok: false, reason: 'hungry' }
        const now = Date.now()
        set({
          sleeping: false,
          awayTask: { kind: 'work', startedAt: now, endsAt: now + WORK_DURATION_MS }
        })
        return { ok: true }
      },

      startStudy: () => {
        const state = get()
        if (state.awayTask) return { ok: false, reason: 'busy' }
        if (getPetLevel(getCombinedGrowth(state.growth)) < STUDY_MIN_LEVEL)
          return { ok: false, reason: 'level' }
        if (state.coins < STUDY_COST) return { ok: false, reason: 'coins' }
        if (state.hunger < 20) return { ok: false, reason: 'hungry' }
        const now = Date.now()
        set({
          sleeping: false,
          coins: state.coins - STUDY_COST,
          awayTask: { kind: 'study', startedAt: now, endsAt: now + STUDY_DURATION_MS }
        })
        return { ok: true }
      },

      resolveAwayTask: (now = Date.now()) => {
        const state = get()
        const task = state.awayTask
        if (!task || now < task.endsAt) return null

        const reward: PetAwayReward =
          task.kind === 'work'
            ? { kind: 'work', coins: WORK_REWARD_COINS, growth: WORK_REWARD_GROWTH }
            : { kind: 'study', coins: 0, growth: STUDY_REWARD_GROWTH }

        set({
          awayTask: null,
          coins: state.coins + reward.coins,
          growth: state.growth + reward.growth,
          hunger: clamp(state.hunger - 10),
          cleanliness: clamp(state.cleanliness - 8)
        })
        return reward
      },

      petted: () => {
        const state = get()
        if (state.sleeping || state.awayTask) return
        set({ mood: clamp(state.mood + 3) })
      },

      markMilestone: (days) => {
        if (days > get().lastMilestoneDays) set({ lastMilestoneDays: days })
      },

      recordProactive: (now = Date.now()) => {
        const today = localDateKey(now)
        const state = get()
        set({
          proactiveDate: today,
          proactiveCount: state.proactiveDate === today ? state.proactiveCount + 1 : 1,
          lastProactiveAt: now
        })
      },

      creditExpCoins: () => {
        const totalExp = usePetExpStore.getState().totalExp
        const state = get()
        if (totalExp <= state.coinCreditedExp) return 0
        const delta = totalExp - state.coinCreditedExp
        // First conversion grandfathers pre-existing XP with a capped grant,
        // so long-time users don't get a coin fortune that kills the economy.
        const credit = state.coinCreditedExp === 0 ? Math.min(delta, RETRO_COIN_CAP) : delta
        set({ coins: state.coins + credit, coinCreditedExp: totalExp })
        return credit
      },

      claimDailyBonus: () => {
        const today = localDateKey()
        const state = get()
        if (state.lastDailyBonusDate === today) return null
        set({ lastDailyBonusDate: today, coins: state.coins + DAILY_BONUS_COINS })
        return DAILY_BONUS_COINS
      },

      addCoins: (amount) => {
        if (amount <= 0) return
        set({ coins: get().coins + amount })
      }
    }),
    {
      name: 'opencowork-pet',
      storage: createJSONStorage(() => ipcStorage),
      partialize: (state) => ({
        name: state.name,
        hunger: state.hunger,
        cleanliness: state.cleanliness,
        mood: state.mood,
        growth: state.growth,
        coins: state.coins,
        sleeping: state.sleeping,
        awayTask: state.awayTask,
        lastTickAt: state.lastTickAt,
        adoptedAt: state.adoptedAt,
        lastMilestoneDays: state.lastMilestoneDays,
        proactiveDate: state.proactiveDate,
        proactiveCount: state.proactiveCount,
        lastProactiveAt: state.lastProactiveAt,
        coinCreditedExp: state.coinCreditedExp,
        lastDailyBonusDate: state.lastDailyBonusDate
      })
    }
  )
)
