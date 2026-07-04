import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { animate, motion, useMotionValue, type AnimationPlaybackControls } from 'motion/react'
import { useTranslation } from 'react-i18next'
import {
  Bath,
  Briefcase,
  Coins,
  EyeOff,
  Gamepad2,
  GraduationCap,
  ImagePlus,
  Loader2,
  Lock,
  MessageCircle,
  Mic,
  Moon,
  SendHorizonal,
  Square,
  Sparkles,
  Sun,
  Utensils,
  Wand2,
  Waves,
  X
} from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  BATHE_COST,
  FEED_COST,
  PET_TICK_MS,
  SOAK_COST,
  SOAK_MIN_LEVEL,
  STUDY_COST,
  STUDY_MIN_LEVEL,
  WORK_MIN_LEVEL,
  getLevelProgress,
  getPetLevel,
  usePetStore,
  type PetActionResult,
  type PetAwayReward
} from '@renderer/stores/pet-store'
import { usePetExpStore } from '@renderer/stores/pet-exp-store'
import { usePetAgentStore } from '@renderer/stores/pet-agent-store'
import { modelSupportsVision, useProviderStore } from '@renderer/stores/provider-store'
import { buildPetSystemPrompt, runPetChat, type PetChatImage } from '@renderer/lib/pet/pet-agent'
import {
  petEvents,
  runPetEventRemark,
  runTimedProactiveChat
} from '@renderer/lib/pet/pet-proactive'
import {
  appendPetMemories,
  buildMemorySection,
  extractMemoryDirectives,
  loadPetMemories,
  stripMemoryDirectives
} from '@renderer/lib/pet/pet-memory'
import {
  createPetSpeechSession,
  isVoiceInputConfigured,
  speakPetText,
  transcribeVoiceInput
} from '@renderer/lib/pet/pet-voice'
import { nanoid } from 'nanoid'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import { CapybaraSprite, type PetActivity } from './CapybaraSprite'

const PET_WIDTH = 132
const SPRITE_HEIGHT = 120
const GROUND_PADDING = 12
const EDGE_MARGIN = 28
const WALK_SPEED = 55
const MENU_WIDTH = 236
const CHAT_WIDTH = 292
const BUBBLE_MS = 3800
const REPLY_BUBBLE_MIN_MS = 12_000
const REPLY_BUBBLE_MAX_MS = 32_000

// AI replies stay up long enough to actually be read: a floor for short
// answers, plus reading time that grows with the text length.
function replyBubbleMs(text: string): number {
  return Math.min(REPLY_BUBBLE_MAX_MS, REPLY_BUBBLE_MIN_MS + text.length * 60)
}

type ViewActivity = PetActivity | 'away'

interface BubbleState {
  id: number
  text: string
  /** Clickable bubble: clicking opens the chat input to continue the topic. */
  interactive?: boolean
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      const comma = dataUrl.indexOf(',')
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('failed to read audio'))
    reader.readAsDataURL(blob)
  })
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function StatBar({
  label,
  value,
  barClass
}: {
  label: string
  value: number
  barClass: string
}): React.JSX.Element {
  const pct = Math.round(value)
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${pct < 30 ? 'bg-red-400' : barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {pct}
      </span>
    </div>
  )
}

export function PetView(): React.JSX.Element | null {
  const { t } = useTranslation('pet')
  const [hydrated, setHydrated] = useState(usePetStore.persist.hasHydrated())
  const [activity, setActivity] = useState<ViewActivity>('idle')
  const [facing, setFacing] = useState<'left' | 'right'>('right')
  const [bubble, setBubble] = useState<BubbleState | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuLeft, setMenuLeft] = useState(0)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatLeft, setChatLeft] = useState(0)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatImage, setChatImage] = useState<(PetChatImage & { preview: string }) | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [hoveringPet, setHoveringPet] = useState(false)
  const [hoveringUi, setHoveringUi] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [squashing, setSquashing] = useState(false)
  const [awayRemaining, setAwayRemaining] = useState(0)
  const [dozing, setDozing] = useState(false)

  const hunger = usePetStore((s) => s.hunger)
  const cleanliness = usePetStore((s) => s.cleanliness)
  const mood = usePetStore((s) => s.mood)
  const growth = usePetStore((s) => s.growth)
  const coins = usePetStore((s) => s.coins)
  const sleeping = usePetStore((s) => s.sleeping)
  const awayTask = usePetStore((s) => s.awayTask)
  const petName = usePetStore((s) => s.name)
  const totalExp = usePetExpStore((s) => s.totalExp)
  const expLog = usePetExpStore((s) => s.log)

  const combinedGrowth = growth + totalExp
  const level = getPetLevel(combinedGrowth)

  const x = useMotionValue(Math.max(EDGE_MARGIN, window.innerWidth / 2 - PET_WIDTH / 2))
  const lift = useMotionValue(0)

  const walkAnimRef = useRef<AnimationPlaybackControls | null>(null)
  const chatInputRef = useRef<HTMLInputElement | null>(null)
  const chatFileRef = useRef<HTMLInputElement | null>(null)
  const chatHistoryRef = useRef<UnifiedMessage[]>([])
  const transientTokenRef = useRef(0)
  const bubbleTimerRef = useRef<number | null>(null)
  const menuCloseTimerRef = useRef<number | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    petX: number
    moved: boolean
  } | null>(null)
  const activityRef = useRef<ViewActivity>('idle')
  activityRef.current = activity
  const dozingRef = useRef(false)
  dozingRef.current = dozing
  const chatOpenRef = useRef(false)
  chatOpenRef.current = chatOpen
  const menuOpenRef = useRef(false)
  menuOpenRef.current = menuOpen
  const lastLateNightAtRef = useRef(0)
  const prevLevelRef = useRef<number | null>(null)
  const lastExpLogIdRef = useRef<string | null>(null)
  const lastCoinPickupAtRef = useRef(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordChunksRef = useRef<Blob[]>([])

  const pickBubble = useCallback(
    (key: string, options?: Record<string, unknown>): string => {
      const value = t(`bubbles.${key}`, { returnObjects: true, ...options })
      if (Array.isArray(value) && value.length > 0) {
        return String(value[Math.floor(Math.random() * value.length)])
      }
      return typeof value === 'string' ? value : ''
    },
    [t]
  )

  const showBubble = useCallback((text: string, duration = BUBBLE_MS, interactive = false) => {
    if (!text) return
    if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current)
    // Keep the id stable while a bubble is visible: the bubble node is keyed
    // by it, so a fresh id remounts the node and replays the pop-in animation
    // on every streamed delta.
    setBubble((prev) =>
      prev ? { ...prev, text, interactive } : { id: Date.now(), text, interactive }
    )
    bubbleTimerRef.current = window.setTimeout(() => setBubble(null), duration)
  }, [])

  // A proactive remark becomes a clickable bubble seeded into the rolling
  // chat history, so clicking it opens the input mid-conversation.
  const showProactiveBubble = useCallback(
    (text: string) => {
      if (!text) return
      const turn: UnifiedMessage = {
        id: nanoid(),
        role: 'assistant',
        content: text,
        createdAt: Date.now()
      }
      chatHistoryRef.current = [...chatHistoryRef.current, turn].slice(-12)
      showBubble(text, replyBubbleMs(text) + 8000, true)
      void speakPetText(text)
    },
    [showBubble]
  )

  // The OS-level click-through state is derived from React state, so it can
  // never get stuck when hovered elements unmount (away tasks, menu close).
  // Deliberately hover-only: even with the menu open, the window must stay
  // click-through wherever the pointer is not on an interactive element —
  // forwarded mousemove events re-enable interception just in time.
  const interactive = hoveringPet || hoveringUi || dragging
  useEffect(() => {
    void ipcClient.invoke('pet-window:set-ignore-mouse', { ignore: !interactive })
  }, [interactive])

  // Safety net: if the cursor leaves the window without a mouseleave firing
  // on the hovered element, drop back to click-through.
  useEffect(() => {
    const onDocMouseOut = (e: MouseEvent): void => {
      if (!e.relatedTarget) {
        setHoveringPet(false)
        setHoveringUi(false)
      }
    }
    document.addEventListener('mouseout', onDocMouseOut)
    return () => document.removeEventListener('mouseout', onDocMouseOut)
  }, [])

  const stopWalk = useCallback(() => {
    walkAnimRef.current?.stop()
    walkAnimRef.current = null
  }, [])

  const playTransient = useCallback((next: PetActivity, duration: number) => {
    const token = ++transientTokenRef.current
    setActivity(next)
    window.setTimeout(() => {
      if (transientTokenRef.current === token) setActivity('idle')
    }, duration)
  }, [])

  // For auto-triggered celebrations (level-up, big meal, check-in…): never
  // interrupt a sleeping/away/dozing pet — the pose would end on 'idle' and
  // desync from the stored state. Bubbles are still fine to show.
  const celebrate = useCallback(
    (pose: PetActivity, duration: number) => {
      const store = usePetStore.getState()
      if (store.sleeping || store.awayTask || dozingRef.current) return
      playTransient(pose, duration)
    },
    [playTransient]
  )

  const startWalk = useCallback(
    (swim = false) => {
      const minX = EDGE_MARGIN
      const maxX = Math.max(minX, window.innerWidth - EDGE_MARGIN - PET_WIDTH)
      const target = minX + Math.random() * (maxX - minX)
      const from = x.get()
      if (Math.abs(target - from) < 48) return
      setFacing(target > from ? 'right' : 'left')
      setActivity(swim ? 'swim' : 'walk')
      walkAnimRef.current = animate(x, target, {
        duration: Math.abs(target - from) / (swim ? 38 : WALK_SPEED),
        ease: 'linear',
        onComplete: () => {
          walkAnimRef.current = null
          setActivity((current) => (current === 'walk' || current === 'swim' ? 'idle' : current))
        }
      })
    },
    [x]
  )

  // A sudden burst of zoomies: the same walk cycle, much faster.
  const startDash = useCallback(() => {
    const minX = EDGE_MARGIN
    const maxX = Math.max(minX, window.innerWidth - EDGE_MARGIN - PET_WIDTH)
    const target = minX + Math.random() * (maxX - minX)
    const from = x.get()
    if (Math.abs(target - from) < 160) {
      startWalk()
      return
    }
    setFacing(target > from ? 'right' : 'left')
    setActivity('walk')
    walkAnimRef.current = animate(x, target, {
      duration: Math.abs(target - from) / 170,
      ease: 'easeOut',
      onComplete: () => {
        walkAnimRef.current = null
        setActivity((current) => (current === 'walk' ? 'idle' : current))
      }
    })
  }, [startWalk, x])

  // Face the cursor when it wanders past nearby — a small "alive" detail.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (dozingRef.current) return
      if (activityRef.current !== 'idle' && activityRef.current !== 'zen') return
      const center = x.get() + PET_WIDTH / 2
      const dx = e.clientX - center
      if (Math.abs(dx) > 60 && Math.abs(dx) < 280) setFacing(dx > 0 ? 'right' : 'left')
    }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [x])

  // Tokens feed the wallet too: new XP converts into coins 1:1, so the coin
  // economy works long before the work task unlocks at Lv.4.
  useEffect(() => {
    if (!hydrated || !usePetExpStore.persist.hasHydrated()) return
    usePetStore.getState().creditExpCoins()
  }, [hydrated, totalExp])

  // One huge usage event = a feast: munch happily and comment on it.
  useEffect(() => {
    if (!hydrated) return
    const latest = expLog[0]
    if (!latest) return
    if (lastExpLogIdRef.current === null) {
      lastExpLogIdRef.current = latest.id
      return
    }
    if (latest.id === lastExpLogIdRef.current) return
    lastExpLogIdRef.current = latest.id
    if (latest.tokens < 80_000) return
    celebrate('eat', 3000)
    void runPetEventRemark(petEvents.bigMeal(latest.tokens)).then((remark) => {
      if (remark) showProactiveBubble(remark)
      else showBubble(t('bubbles.bigMeal', { tokens: latest.tokens.toLocaleString() }))
    })
  }, [hydrated, expLog, celebrate, showBubble, showProactiveBubble, t])

  const agentProviderId = usePetAgentStore((s) => s.providerId)
  const agentModelId = usePetAgentStore((s) => s.modelId)
  const chatVisionSupported = useMemo(() => {
    const provider = useProviderStore
      .getState()
      .providers.find((item) => item.id === agentProviderId)
    const model = provider?.models.find((item) => item.id === agentModelId)
    return modelSupportsVision(model, provider?.type)
  }, [agentProviderId, agentModelId])

  const attachChatImageFile = useCallback((file: File | null | undefined) => {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return
      setChatImage({
        data: dataUrl.slice(comma + 1),
        mediaType: file.type || 'image/png',
        preview: dataUrl
      })
    }
    reader.readAsDataURL(file)
  }, [])

  const notifyAwayReward = useCallback(
    (reward: PetAwayReward) => {
      const text =
        reward.kind === 'work'
          ? t('bubbles.workDone', { coins: reward.coins })
          : t('bubbles.studyDone', { growth: reward.growth })
      showBubble(text)
      void ipcClient.invoke('notify:desktop', { title: t('title'), body: text, type: 'success' })
      // With proactive speech on, follow up with a fresh in-character remark.
      void runPetEventRemark(
        reward.kind === 'work'
          ? petEvents.workDone(reward.coins)
          : petEvents.studyDone(reward.growth)
      ).then((remark) => {
        if (remark) showProactiveBubble(remark)
      })
    },
    [showBubble, showProactiveBubble, t]
  )

  // Hydration gate + offline catch-up + greeting
  useEffect(() => {
    if (usePetStore.persist.hasHydrated()) {
      setHydrated(true)
      return
    }
    return usePetStore.persist.onFinishHydration(() => setHydrated(true))
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const store = usePetStore.getState()
    store.tick()
    const reward = store.resolveAwayTask()
    if (reward) {
      notifyAwayReward(reward)
    } else if (!store.awayTask) {
      const hour = new Date().getHours()
      const bucket =
        hour >= 5 && hour < 11
          ? 'morningGreet'
          : hour >= 18 && hour < 23
            ? 'eveningGreet'
            : hour >= 23 || hour < 5
              ? 'lateNightGreet'
              : 'greet'
      showBubble(pickBubble(bucket))
    }
    // First visit of the day: check-in coins (shown after the greeting).
    const bonus = store.claimDailyBonus()
    if (bonus) {
      window.setTimeout(() => {
        celebrate('play', 2200)
        showBubble(t('bubbles.dailyBonus', { coins: bonus }), 6000)
      }, 4200)
    }
    // Companionship milestones, celebrated once each (after the greeting).
    const days = Math.floor((Date.now() - store.adoptedAt) / 86_400_000)
    const milestone = [730, 365, 100, 30, 7].find((m) => days >= m && store.lastMilestoneDays < m)
    if (milestone) {
      store.markMilestone(milestone)
      window.setTimeout(
        () => {
          celebrate('play', 2600)
          showBubble(t('bubbles.milestone', { days: milestone }), 8000)
        },
        bonus ? 11_000 : 6000
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])

  // Stat decay tick
  useEffect(() => {
    if (!hydrated) return
    const timer = window.setInterval(() => usePetStore.getState().tick(), PET_TICK_MS)
    return () => window.clearInterval(timer)
  }, [hydrated])

  // Doze off when the user has been away from the computer for a while, and
  // wake with a little hop and a welcome when they come back.
  useEffect(() => {
    if (!hydrated) return
    const timer = window.setInterval(() => {
      void ipcClient.invoke('pet-window:idle-seconds').then((value) => {
        const idleSeconds = typeof value === 'number' ? value : 0
        const store = usePetStore.getState()
        if (dozingRef.current) {
          if (idleSeconds < 5) {
            setDozing(false)
            if (!store.awayTask) {
              playTransient('play', 1400)
              showBubble(pickBubble('welcomeBack'))
            }
          }
          return
        }
        if (
          idleSeconds >= 300 &&
          !store.sleeping &&
          !store.awayTask &&
          !chatOpenRef.current &&
          !menuOpenRef.current &&
          !dragRef.current
        ) {
          stopWalk()
          transientTokenRef.current += 1
          setDozing(true)
          setActivity('sleep')
        }
      })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [hydrated, pickBubble, playTransient, showBubble, stopWalk])

  // Level-up celebration: a hop plus, when proactive speech is on, a fresh
  // in-character remark generated by the pet's model.
  useEffect(() => {
    if (!hydrated) return
    if (prevLevelRef.current === null) {
      // Wait for the exp mirror to hydrate so the first real level doesn't
      // register as a jump from the pre-hydration default.
      if (usePetExpStore.persist.hasHydrated()) prevLevelRef.current = level
      return
    }
    if (level <= prevLevelRef.current) {
      prevLevelRef.current = level
      return
    }
    prevLevelRef.current = level
    celebrate('play', 3000)
    showBubble(t('bubbles.levelUp', { level }), 9000)
    void runPetEventRemark(petEvents.levelUp(level)).then((remark) => {
      if (remark) showProactiveBubble(remark)
    })
    // totalExp is a dep so the baseline gets established on the first XP
    // change after mount, not silently swallowed by a real level-up.
  }, [hydrated, level, totalExp, celebrate, showBubble, showProactiveBubble, t])

  // Timed small talk: quota/quiet-hours/cooldowns live in pet-proactive; the
  // random gate here just spreads initiations organically across the day.
  useEffect(() => {
    if (!hydrated) return
    const timer = window.setInterval(() => {
      if (dozingRef.current || chatOpenRef.current || menuOpenRef.current) return
      const store = usePetStore.getState()
      if (store.sleeping || store.awayTask) return
      if (Math.random() > 0.12) return
      void runTimedProactiveChat().then((remark) => {
        if (remark) showProactiveBubble(remark)
      })
    }, 10 * 60_000)
    return () => window.clearInterval(timer)
  }, [hydrated, showProactiveBubble])

  // Away task countdown + resolution
  useEffect(() => {
    if (!hydrated) return
    if (!awayTask) return
    stopWalk()
    transientTokenRef.current += 1
    setActivity('away')
    // The pet element unmounts while away; clear any hover/drag state that
    // would otherwise keep the window intercepting mouse events.
    setHoveringPet(false)
    setDragging(false)
    dragRef.current = null
    setMenuOpen(false)
    setChatOpen(false)
    void ipcClient.invoke('pet-window:set-focusable', { focusable: false })
    setAwayRemaining(awayTask.endsAt - Date.now())
    const timer = window.setInterval(() => {
      const remaining = awayTask.endsAt - Date.now()
      setAwayRemaining(remaining)
      if (remaining <= 0) {
        const reward = usePetStore.getState().resolveAwayTask()
        if (reward) {
          setActivity('idle')
          notifyAwayReward(reward)
        }
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [hydrated, awayTask, stopWalk, notifyAwayReward])

  useEffect(() => {
    if (!hydrated || awayTask) return
    if (sleeping) {
      stopWalk()
      transientTokenRef.current += 1
      setActivity('sleep')
    } else if (
      !dozingRef.current &&
      (activityRef.current === 'sleep' || activityRef.current === 'away')
    ) {
      setActivity('idle')
    }
  }, [hydrated, sleeping, awayTask, stopWalk])

  // Idle behavior scheduler: needs first (beg when hungry/dirty, rest nudge
  // late at night, gloom when sad), then capybara pastimes.
  useEffect(() => {
    if (!hydrated || activity !== 'idle' || sleeping || awayTask || menuOpen || dozing) return
    const delay = 2500 + Math.random() * 4000
    const timer = window.setTimeout(() => {
      const store = usePetStore.getState()
      const hour = new Date().getHours()
      if (store.hunger < 30 && Math.random() < (store.hunger < 15 ? 0.75 : 0.55)) {
        playTransient('beg', 3000)
        showBubble(pickBubble('hungry'))
      } else if (store.cleanliness < 30 && Math.random() < 0.45) {
        playTransient('beg', 3000)
        showBubble(pickBubble('dirty'))
      } else if (
        (hour >= 23 || hour < 5) &&
        Date.now() - lastLateNightAtRef.current > 30 * 60_000 &&
        Math.random() < 0.35
      ) {
        // Late-night nudge: nod off for a moment and remind the owner to rest.
        lastLateNightAtRef.current = Date.now()
        playTransient('sleep', 6000)
        showBubble(pickBubble('lateNight'))
      } else if (store.mood < 20 && Math.random() < 0.3) {
        playTransient('zen', 6000)
        showBubble(pickBubble('gloomy'))
      } else if (Date.now() - lastCoinPickupAtRef.current > 45 * 60_000 && Math.random() < 0.08) {
        // Lucky find: a few coins on the ground while pottering about.
        lastCoinPickupAtRef.current = Date.now()
        const amount = 1 + Math.floor(Math.random() * 5)
        store.addCoins(amount)
        playTransient('play', 2200)
        showBubble(t('bubbles.foundCoins', { coins: amount }))
      } else {
        // Capybara pastimes: mostly wandering, sometimes a leisurely swim, a
        // spontaneous snack, a happy hop, sudden zoomies, or sitting
        // perfectly still with its bird friend.
        const roll = Math.random()
        if (roll < 0.16) {
          playTransient('zen', 8000)
          if (Math.random() < 0.5) showBubble(pickBubble('zen'))
        } else if (roll < 0.26) {
          playTransient('eat', 2600)
          if (Math.random() < 0.6) showBubble(pickBubble('snack'))
        } else if (roll < 0.34 && store.mood > 80) {
          playTransient('play', 2200)
          if (Math.random() < 0.4) showBubble(pickBubble('happyIdle'))
        } else if (roll < 0.42) {
          startDash()
        } else {
          startWalk(roll < 0.6)
        }
      }
    }, delay)
    return () => window.clearTimeout(timer)
  }, [
    hydrated,
    activity,
    sleeping,
    awayTask,
    menuOpen,
    dozing,
    playTransient,
    showBubble,
    pickBubble,
    startWalk,
    startDash,
    t
  ])

  const openMenu = useCallback(() => {
    stopWalk()
    transientTokenRef.current += 1
    if (activityRef.current === 'walk' || activityRef.current === 'swim') setActivity('idle')
    // Place the menu beside the pet, anchored to the ground, so it always
    // fits inside the short pet window instead of clipping at the top.
    const petLeft = x.get()
    const preferRight = petLeft + PET_WIDTH + 16 + MENU_WIDTH <= window.innerWidth
    const left = preferRight ? petLeft + PET_WIDTH + 12 : petLeft - MENU_WIDTH - 12
    setMenuLeft(Math.min(Math.max(left, 8), window.innerWidth - MENU_WIDTH - 8))
    setMenuOpen(true)
  }, [stopWalk, x])

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setHoveringUi(false)
  }, [])

  const openChat = useCallback(() => {
    stopWalk()
    transientTokenRef.current += 1
    if (activityRef.current === 'walk' || activityRef.current === 'swim') setActivity('idle')
    const petLeft = x.get()
    const preferRight = petLeft + PET_WIDTH + 16 + CHAT_WIDTH <= window.innerWidth
    const left = preferRight ? petLeft + PET_WIDTH + 12 : petLeft - CHAT_WIDTH - 12
    setChatLeft(Math.min(Math.max(left, 8), window.innerWidth - CHAT_WIDTH - 8))
    setMenuOpen(false)
    setChatError(null)
    setChatOpen(true)
    void ipcClient.invoke('pet-window:set-focusable', { focusable: true }).then(() => {
      // Re-apply DOM focus once the window can actually take keyboard focus.
      window.setTimeout(() => chatInputRef.current?.focus(), 80)
    })
  }, [stopWalk, x])

  const closeChat = useCallback(() => {
    // Release the microphone; the recorder's onstop discards the take
    // because chatOpen is already false by the time it fires.
    recorderRef.current?.stop()
    setRecording(false)
    setChatOpen(false)
    setChatError(null)
    setChatImage(null)
    setHoveringUi(false)
    void ipcClient.invoke('pet-window:set-focusable', { focusable: false })
  }, [])

  const sendChat = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? chatInput).trim()
      if (!text || chatBusy) return
      const agentConfig = usePetAgentStore.getState()
      if (!agentConfig.providerId || !agentConfig.modelId) {
        setChatError(t('chat.notConfigured'))
        return
      }
      const image = chatImage
      setChatBusy(true)
      setChatError(null)
      setChatInput('')
      setChatImage(null)
      showBubble(t('chat.thinking'), 60_000)
      // Sentence-streaming voice: each finished sentence is synthesized
      // while the rest is still generating, so speech starts with the text
      // instead of one full synthesis round-trip after it.
      const speech = createPetSpeechSession()
      try {
        const store = usePetStore.getState()
        const memorySection = buildMemorySection(await loadPetMemories())
        const persona = buildPetSystemPrompt(agentConfig.systemPrompt, {
          petName: store.name,
          hunger: store.hunger,
          cleanliness: store.cleanliness,
          mood: store.mood,
          level: getPetLevel(store.growth + usePetExpStore.getState().totalExp),
          projectName: agentConfig.projectName,
          projectFolder: agentConfig.projectFolder,
          memorySection
        })
        const rawReply = await runPetChat({
          providerId: agentConfig.providerId,
          modelId: agentConfig.modelId,
          persona,
          userText: text,
          image: image ? { data: image.data, mediaType: image.mediaType } : null,
          history: chatHistoryRef.current,
          workingFolder: agentConfig.projectFolder,
          onDelta: (partial) => {
            const clean = stripMemoryDirectives(partial)
            if (clean) {
              showBubble(clean, replyBubbleMs(clean))
              speech?.feed(clean)
            }
          },
          onToolUse: (name) => showBubble(t('chat.usingTool', { name }), 60_000)
        })
        // The model may end its reply with hidden [[记住: ...]] directives —
        // persist those to MEMORY.md and never show them.
        const newMemories = extractMemoryDirectives(rawReply)
        if (newMemories.length > 0) void appendPetMemories(newMemories)
        const reply = stripMemoryDirectives(rawReply)
        showBubble(reply || t('chat.thinking'), replyBubbleMs(reply))
        speech?.finish(reply)
        // Rolling text-only memory of the last few turns.
        const userTurn: UnifiedMessage = {
          id: nanoid(),
          role: 'user',
          content: text,
          createdAt: Date.now()
        }
        const assistantTurn: UnifiedMessage = {
          id: nanoid(),
          role: 'assistant',
          content: reply,
          createdAt: Date.now()
        }
        chatHistoryRef.current = [...chatHistoryRef.current, userTurn, assistantTurn].slice(-12)
        store.petted()
      } catch (error) {
        speech?.cancel()
        setBubble(null)
        setChatError(error instanceof Error ? error.message : String(error))
      } finally {
        setChatBusy(false)
      }
    },
    [chatBusy, chatImage, chatInput, showBubble, t]
  )

  // Voice input: record → transcribe with the app's speech recognition
  // model → auto-send, closing the loop with the spoken reply.
  const finishVoiceInput = useCallback(
    async (blob: Blob) => {
      setTranscribing(true)
      setChatError(null)
      try {
        const base64 = await blobToBase64(blob)
        const text = (await transcribeVoiceInput(base64, 'audio/webm')).trim()
        if (!text) return
        setChatInput(text)
        await sendChat(text)
      } catch (error) {
        setChatError(error instanceof Error ? error.message : String(error))
      } finally {
        setTranscribing(false)
      }
    },
    [sendChat]
  )

  const toggleRecording = useCallback(async () => {
    if (chatBusy || transcribing) return
    if (recorderRef.current) {
      recorderRef.current.stop()
      return
    }
    if (!isVoiceInputConfigured()) {
      setChatError(t('chat.voiceNotConfigured'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      recordChunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordChunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        recorderRef.current = null
        setRecording(false)
        const blob = new Blob(recordChunksRef.current, { type: 'audio/webm' })
        recordChunksRef.current = []
        // Discard when the chat was closed mid-recording or the take is a
        // fraction of a second of silence.
        if (!chatOpenRef.current || blob.size < 1000) return
        void finishVoiceInput(blob)
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
      setChatError(null)
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error))
    }
  }, [chatBusy, transcribing, finishVoiceInput, t])

  const scheduleMenuClose = useCallback(() => {
    if (menuCloseTimerRef.current) window.clearTimeout(menuCloseTimerRef.current)
    menuCloseTimerRef.current = window.setTimeout(closeMenu, 500)
  }, [closeMenu])

  const cancelMenuClose = useCallback(() => {
    if (menuCloseTimerRef.current) window.clearTimeout(menuCloseTimerRef.current)
    menuCloseTimerRef.current = null
  }, [])

  const handleActionResult = useCallback(
    (result: PetActionResult, onOk: () => void) => {
      if (result.ok) {
        onOk()
        return
      }
      const reasonKey: Record<string, string> = {
        coins: 'refuseCoins',
        full: 'refuseFull',
        clean: 'refuseClean',
        hungry: 'refuseHungry',
        busy: 'refuseBusy',
        sleeping: 'refuseSleeping',
        level: 'refuseLevel'
      }
      showBubble(pickBubble(reasonKey[result.reason] ?? 'refuseBusy'))
    },
    [showBubble, pickBubble]
  )

  const runMenuAction = useCallback(
    (kind: 'feed' | 'bathe' | 'soak' | 'play' | 'sleep' | 'work' | 'study' | 'hide') => {
      const store = usePetStore.getState()
      closeMenu()
      switch (kind) {
        case 'feed':
          handleActionResult(store.feed(), () => {
            playTransient('eat', 2800)
            showBubble(pickBubble('fed'))
          })
          break
        case 'bathe':
          handleActionResult(store.bathe(), () => {
            playTransient('bathe', 2800)
            showBubble(pickBubble('bathed'))
          })
          break
        case 'soak':
          handleActionResult(store.soak(), () => {
            playTransient('soak', 6000)
            showBubble(pickBubble('soaked'))
          })
          break
        case 'play':
          handleActionResult(store.play(), () => {
            playTransient('play', 2600)
            showBubble(pickBubble('played'))
          })
          break
        case 'sleep':
          store.toggleSleep()
          showBubble(pickBubble(store.sleeping ? 'wake' : 'sleepy'))
          break
        case 'work':
          handleActionResult(store.startWork(), () => showBubble(pickBubble('workStart')))
          break
        case 'study':
          handleActionResult(store.startStudy(), () => showBubble(pickBubble('studyStart')))
          break
        case 'hide':
          void ipcClient.invoke('pet-window:close')
          break
      }
    },
    [closeMenu, handleActionResult, playTransient, showBubble, pickBubble]
  )

  // Drag / click handling on the pet hitbox
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      // Touching a dozing pet wakes it immediately.
      if (dozingRef.current) {
        setDozing(false)
        setActivity('idle')
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        petX: x.get(),
        moved: false
      }
      setDragging(true)
    },
    [x]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.pointerId) return
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) {
        drag.moved = true
        stopWalk()
        transientTokenRef.current += 1
        setActivity('drag')
      }
      if (!drag.moved) return
      const minX = 0
      const maxX = window.innerWidth - PET_WIDTH
      x.set(Math.min(maxX, Math.max(minX, drag.petX + dx)))
      const minLift = -(window.innerHeight - GROUND_PADDING - SPRITE_HEIGHT)
      lift.set(Math.min(0, Math.max(minLift, dy)))
    },
    [lift, stopWalk, x]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.pointerId) return
      dragRef.current = null
      setDragging(false)

      if (!drag.moved) {
        // simple click: a little affection — doubly effective mid-zen
        const store = usePetStore.getState()
        store.petted()
        setSquashing(true)
        window.setTimeout(() => setSquashing(false), 450)
        if (activityRef.current === 'zen') {
          store.petted()
          showBubble(pickBubble('zenPet'))
        } else if (!bubble) {
          showBubble(pickBubble('happy'))
        }
        return
      }

      // dropped: fall back to the ground with a bounce
      animate(lift, 0, {
        type: 'spring',
        stiffness: 320,
        damping: 15,
        onComplete: () => {
          setActivity((current) => (current === 'drag' ? 'idle' : current))
        }
      })
    },
    [bubble, lift, pickBubble, showBubble]
  )

  useEffect(() => {
    return () => {
      stopWalk()
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current)
      if (menuCloseTimerRef.current) window.clearTimeout(menuCloseTimerRef.current)
    }
  }, [stopWalk])

  if (!hydrated) return null

  const away = !!awayTask
  const spriteActivity: PetActivity = activity === 'away' ? 'idle' : activity
  const menuBottom = GROUND_PADDING

  const menuItems: Array<{
    kind: 'feed' | 'bathe' | 'soak' | 'play' | 'sleep' | 'work' | 'study'
    icon: React.ReactNode
    label: string
    cost?: number
    lockedLevel?: number
  }> = [
    {
      kind: 'feed',
      icon: <Utensils className="size-3.5" />,
      label: t('menu.feed'),
      cost: FEED_COST
    },
    {
      kind: 'bathe',
      icon: <Bath className="size-3.5" />,
      label: t('menu.bathe'),
      cost: BATHE_COST
    },
    {
      kind: 'soak',
      icon: <Waves className="size-3.5" />,
      label: t('menu.soak'),
      cost: SOAK_COST,
      lockedLevel: level < SOAK_MIN_LEVEL ? SOAK_MIN_LEVEL : undefined
    },
    { kind: 'play', icon: <Gamepad2 className="size-3.5" />, label: t('menu.play') },
    {
      kind: 'sleep',
      icon: sleeping ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />,
      label: sleeping ? t('menu.wake') : t('menu.sleep')
    },
    {
      kind: 'work',
      icon: <Briefcase className="size-3.5" />,
      label: t('menu.work'),
      lockedLevel: level < WORK_MIN_LEVEL ? WORK_MIN_LEVEL : undefined
    },
    {
      kind: 'study',
      icon: <GraduationCap className="size-3.5" />,
      label: t('menu.study'),
      cost: STUDY_COST,
      lockedLevel: level < STUDY_MIN_LEVEL ? STUDY_MIN_LEVEL : undefined
    }
  ]

  return (
    <div className="pointer-events-none relative h-screen w-screen select-none overflow-hidden bg-transparent">
      {away ? (
        <div
          onMouseEnter={() => setHoveringUi(true)}
          onMouseLeave={() => setHoveringUi(false)}
          className="pointer-events-auto absolute bottom-4 right-5 flex items-center gap-2 rounded-full border border-border bg-popover/95 px-3.5 py-2 text-xs text-popover-foreground shadow-lg backdrop-blur"
        >
          {awayTask?.kind === 'work' ? (
            <Briefcase className="size-3.5 text-amber-500" />
          ) : (
            <GraduationCap className="size-3.5 text-sky-500" />
          )}
          <span>
            {t(awayTask?.kind === 'work' ? 'away.working' : 'away.studying', {
              time: formatCountdown(awayRemaining)
            })}
          </span>
        </div>
      ) : (
        <motion.div
          className="absolute left-0"
          style={{ x, y: lift, bottom: GROUND_PADDING, width: PET_WIDTH }}
        >
          {bubble ? (
            <motion.div
              key={bubble.id}
              initial={{ opacity: 0, y: 8, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              onMouseEnter={bubble.interactive ? () => setHoveringUi(true) : undefined}
              onMouseLeave={bubble.interactive ? () => setHoveringUi(false) : undefined}
              onClick={
                bubble.interactive
                  ? () => {
                      setHoveringUi(false)
                      openChat()
                    }
                  : undefined
              }
              className={`absolute bottom-full left-1/2 mb-2 w-max max-w-52 -translate-x-1/2 rounded-2xl border border-border bg-popover/95 px-3 py-1.5 text-center text-xs text-popover-foreground shadow-lg backdrop-blur ${
                bubble.interactive
                  ? 'pointer-events-auto cursor-pointer hover:border-primary/60'
                  : 'pointer-events-none'
              }`}
            >
              {bubble.text}
            </motion.div>
          ) : hoveringPet && !menuOpen ? (
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 w-40 -translate-x-1/2 space-y-1 rounded-xl border border-border bg-popover/95 p-2 shadow-lg backdrop-blur">
              <div className="flex items-center justify-between text-[11px] font-medium text-popover-foreground">
                <span>
                  {petName} · {t('hud.level', { level })}
                </span>
                <span className="flex items-center gap-0.5 text-amber-500">
                  <Coins className="size-3" />
                  {Math.floor(coins)}
                </span>
              </div>
              <StatBar label={t('hud.hunger')} value={hunger} barClass="bg-amber-400" />
              <StatBar label={t('hud.clean')} value={cleanliness} barClass="bg-sky-400" />
              <StatBar label={t('hud.mood')} value={mood} barClass="bg-pink-400" />
            </div>
          ) : null}

          <motion.div
            animate={squashing ? { scale: [1, 0.84, 1.06, 1] } : { scale: 1 }}
            transition={{ duration: 0.42 }}
            style={{ transformOrigin: 'center bottom' }}
          >
            <div
              onMouseEnter={() => setHoveringPet(true)}
              onMouseLeave={() => setHoveringPet(false)}
              className="pointer-events-auto cursor-grab active:cursor-grabbing"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={() => {
                if (chatOpen) closeChat()
                else openChat()
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                if (menuOpen) closeMenu()
                else openMenu()
              }}
            >
              <CapybaraSprite
                activity={spriteActivity}
                facing={facing}
                mood={mood}
                cleanliness={cleanliness}
                width={PET_WIDTH}
              />
            </div>
          </motion.div>
        </motion.div>
      )}

      {menuOpen && !away ? (
        <div
          className="pointer-events-auto absolute rounded-xl border border-border bg-popover/95 p-2 text-popover-foreground shadow-xl backdrop-blur"
          style={{ left: menuLeft, bottom: menuBottom, width: MENU_WIDTH }}
          onMouseEnter={() => {
            cancelMenuClose()
            setHoveringUi(true)
          }}
          onMouseLeave={() => {
            setHoveringUi(false)
            scheduleMenuClose()
          }}
        >
          <div className="flex items-center justify-between px-1.5 pb-1">
            <span className="text-xs font-semibold">
              {petName} · {t('hud.level', { level })}
            </span>
            <span className="flex items-center gap-1 text-xs text-amber-500">
              <Coins className="size-3" />
              {Math.floor(coins)}
            </span>
          </div>
          <div className="space-y-1 px-1.5 pb-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-3 shrink-0 text-violet-400" />
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-violet-400 transition-all"
                  style={{ width: `${Math.round(getLevelProgress(combinedGrowth) * 100)}%` }}
                />
              </div>
            </div>
            <StatBar label={t('hud.hunger')} value={hunger} barClass="bg-amber-400" />
            <StatBar label={t('hud.clean')} value={cleanliness} barClass="bg-sky-400" />
            <StatBar label={t('hud.mood')} value={mood} barClass="bg-pink-400" />
          </div>
          <div className="grid grid-cols-2 gap-1 border-t border-border/60 pt-2">
            {menuItems.map((item) => (
              <button
                key={item.kind}
                disabled={!!item.lockedLevel}
                onClick={() => runMenuAction(item.kind)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="shrink-0 text-muted-foreground">{item.icon}</span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.lockedLevel ? (
                  <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                    <Lock className="size-2.5" />
                    {t('menu.requiresLevel', { level: item.lockedLevel })}
                  </span>
                ) : item.cost ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">-{item.cost}</span>
                ) : null}
              </button>
            ))}
            <button
              onClick={() => {
                closeMenu()
                openChat()
              }}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <MessageCircle className="size-3.5 shrink-0 text-muted-foreground" />
              <span>{t('menu.chat')}</span>
            </button>
            <button
              onClick={() => {
                closeMenu()
                void ipcClient.invoke('pet:open-studio')
              }}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Wand2 className="size-3.5 shrink-0" />
              <span>{t('menu.studio')}</span>
            </button>
            <button
              onClick={() => runMenuAction('hide')}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <EyeOff className="size-3.5 shrink-0" />
              <span>{t('menu.hide')}</span>
            </button>
          </div>
        </div>
      ) : null}

      {chatOpen && !away ? (
        <div
          className="pointer-events-auto absolute rounded-xl border border-border bg-popover/95 p-2.5 text-popover-foreground shadow-xl backdrop-blur"
          style={{ left: chatLeft, bottom: GROUND_PADDING, width: CHAT_WIDTH }}
          onMouseEnter={() => setHoveringUi(true)}
          onMouseLeave={() => setHoveringUi(false)}
        >
          {chatError ? (
            <p className="mb-1.5 rounded-md bg-red-400/10 px-2 py-1 text-[11px] leading-snug text-red-400">
              {chatError}
            </p>
          ) : null}
          {chatImage ? (
            <div className="mb-1.5 flex items-center gap-1.5">
              <img
                src={chatImage.preview}
                alt=""
                className="size-9 rounded-md border border-border object-cover"
              />
              <button
                onClick={() => setChatImage(null)}
                className="rounded-md p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
          ) : null}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              void sendChat()
            }}
          >
            {chatVisionSupported ? (
              <>
                <input
                  ref={chatFileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    attachChatImageFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  title={t('chat.attachImage')}
                  disabled={chatBusy}
                  onClick={() => chatFileRef.current?.click()}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                >
                  <ImagePlus className="size-3.5" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              title={t(
                recording
                  ? 'chat.voiceStop'
                  : transcribing
                    ? 'chat.transcribing'
                    : 'chat.voiceInput'
              )}
              disabled={chatBusy || transcribing}
              onClick={() => void toggleRecording()}
              className={`flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-40 ${
                recording
                  ? 'border-red-400/60 bg-red-400/15 text-red-400'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {transcribing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : recording ? (
                <Square className="size-3 animate-pulse fill-current" />
              ) : (
                <Mic className="size-3.5" />
              )}
            </button>
            <input
              ref={chatInputRef}
              autoFocus
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') closeChat()
              }}
              onPaste={(e) => {
                if (!chatVisionSupported) return
                const item = Array.from(e.clipboardData.items).find((entry) =>
                  entry.type.startsWith('image/')
                )
                if (item) {
                  e.preventDefault()
                  attachChatImageFile(item.getAsFile())
                }
              }}
              placeholder={t('chat.placeholder')}
              disabled={chatBusy}
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/50"
            />
            <button
              type="submit"
              disabled={chatBusy || !chatInput.trim()}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {chatBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <SendHorizonal className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={closeChat}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </form>
        </div>
      ) : null}
    </div>
  )
}
