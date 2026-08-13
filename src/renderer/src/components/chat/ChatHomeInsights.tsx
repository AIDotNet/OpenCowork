import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { cn } from '@renderer/lib/utils'

const COPY_SET_COUNT = 3
const easeOut = [0.16, 1, 0.3, 1] as const

const FALLBACK_PROJECT_SETS = [
  ['{{name}} is still here', 'So is the problem', 'One specific sentence beats a blank input'],
  [
    "Don't try to finish the whole thing",
    'The smallest cut is usually the real one',
    "You start, I'll follow"
  ],
  [
    'A quiet repo is not a healthy repo',
    "Today you can fix just the thing that's been buzzing",
    'Start below'
  ]
]

const FALLBACK_CHAT_SETS = [
  [
    'Say the sentence you actually have',
    'Incomplete questions are still questions',
    'I can help finish asking it'
  ],
  ["This doesn't have to sound like a ticket", 'A messy draft is enough to start', 'Drop it in'],
  [
    "You don't need a clever opening",
    'One thing you actually want to understand is enough',
    "We'll fill the rest as we go"
  ]
]

type HomeCopyVariant = 'chat' | 'project'

interface ChatHomeInsightsProps {
  projectName?: string | null
  variant: HomeCopyVariant
}

function readCopySets(value: unknown, fallback: string[][]): string[][] {
  if (!Array.isArray(value) || value.length === 0) return fallback
  const sets = value
    .map((set) =>
      Array.isArray(set) ? set.filter((line): line is string => typeof line === 'string') : []
    )
    .filter((set) => set.length > 0)
  return sets.length > 0 ? sets : fallback
}

function applyProjectName(line: string, projectName: string): string {
  return line.replaceAll('{{name}}', projectName)
}

export function ChatHomeInsights({
  projectName,
  variant
}: ChatHomeInsightsProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const animationsEnabled = useSettingsStore((state) => state.animationsEnabled)
  const reduceMotion = useReducedMotion()
  const motionOn = animationsEnabled && reduceMotion !== true
  const displayName =
    projectName?.trim() || t('messageList.thisWorkspace', { defaultValue: 'this workspace' })
  const [setIndex] = React.useState(() => Math.floor(Math.random() * COPY_SET_COUNT))

  const lines = React.useMemo(() => {
    const fallback = variant === 'chat' ? FALLBACK_CHAT_SETS : FALLBACK_PROJECT_SETS
    const sets = readCopySets(
      t(`messageList.homeCopy.${variant}`, { returnObjects: true }),
      fallback
    )
    const chosen = sets[setIndex % sets.length] ?? fallback[0]
    return chosen.map((line) => applyProjectName(line, displayName))
  }, [displayName, setIndex, t, variant])

  return (
    <div className="mb-6 flex flex-col items-center text-center sm:mb-7">
      {lines.map((line, index) => {
        const featured = index === 0
        return (
          <p
            key={`${variant}:${setIndex}:${index}`}
            className={cn(
              'max-w-[640px] overflow-hidden',
              featured
                ? 'text-[28px] font-semibold tracking-tight text-foreground/92 sm:text-[36px]'
                : 'mt-2.5 text-sm leading-6 text-muted-foreground/72'
            )}
          >
            <motion.span
              className="block"
              initial={motionOn ? { y: '112%', opacity: featured ? 1 : 0 } : false}
              animate={{ y: '0%', opacity: 1 }}
              transition={
                motionOn
                  ? {
                      duration: featured ? 0.52 : 0.36,
                      delay: 0.16 + index * 0.26,
                      ease: easeOut
                    }
                  : { duration: 0 }
              }
            >
              {line}
            </motion.span>
          </p>
        )
      })}
    </div>
  )
}
