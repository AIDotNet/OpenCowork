import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { usePetSkinImages } from './use-pet-skin-images'
import type { PetPoseKey } from '@renderer/lib/pet/pet-pose-prompts'
import idleImg from '@renderer/assets/pet/capy-idle.png'
import walkImg from '@renderer/assets/pet/capy-walk.png'
import sleepImg from '@renderer/assets/pet/capy-sleep.png'
import begImg from '@renderer/assets/pet/capy-beg.png'
import eatImg from '@renderer/assets/pet/capy-eat.png'
import munchImg from '@renderer/assets/pet/capy-munch.png'
import batheImg from '@renderer/assets/pet/capy-bathe.png'
import soakImg from '@renderer/assets/pet/capy-soak.png'
import swimImg from '@renderer/assets/pet/capy-swim.png'
import zenImg from '@renderer/assets/pet/capy-zen.png'
import playImg from '@renderer/assets/pet/capy-play.png'
import heldImg from '@renderer/assets/pet/capy-held.png'

export type PetActivity =
  | 'idle'
  | 'walk'
  | 'sleep'
  | 'eat'
  | 'bathe'
  | 'soak'
  | 'swim'
  | 'zen'
  | 'play'
  | 'drag'
  | 'beg'

export interface CapybaraSpriteProps {
  activity: PetActivity
  facing: 'left' | 'right'
  mood: number
  cleanliness: number
  width?: number
  /** Always render the bundled capybara, ignoring the active custom skin. */
  disableSkin?: boolean
}

const ACTIVITY_IMAGE: Record<PetActivity, string> = {
  idle: idleImg,
  walk: walkImg,
  sleep: sleepImg,
  eat: eatImg,
  bathe: batheImg,
  soak: soakImg,
  swim: swimImg,
  zen: zenImg,
  play: playImg,
  drag: heldImg,
  beg: begImg
}

// Poses have different aspect ratios; normalize the on-screen body size by
// giving each pose its own display height (px) instead of a shared width.
const POSE_HEIGHT: Record<PetActivity, number> = {
  idle: 100,
  walk: 98,
  sleep: 74,
  eat: 102,
  bathe: 108,
  soak: 110,
  swim: 80,
  zen: 112,
  play: 110,
  drag: 126,
  beg: 118
}

const ALL_IMAGES = Array.from(new Set([...Object.values(ACTIVITY_IMAGE), munchImg]))

// Activity -> generated-skin pose key (activities map 1:1 except drag → held).
const ACTIVITY_POSE: Record<PetActivity, PetPoseKey> = {
  idle: 'idle',
  walk: 'walk',
  sleep: 'sleep',
  eat: 'eat',
  bathe: 'bathe',
  soak: 'soak',
  swim: 'swim',
  zen: 'zen',
  play: 'play',
  drag: 'held',
  beg: 'beg'
}

const mirror = (duration: number) => ({
  duration,
  repeat: Infinity,
  repeatType: 'mirror' as const,
  ease: 'easeInOut' as const
})

const loop = (duration: number, ease: 'easeInOut' | 'easeOut' = 'easeInOut') => ({
  duration,
  repeat: Infinity,
  ease
})

const BODY_MOTION = {
  idle: { animate: { scaleY: [1, 1.02], y: 0, rotate: 0 }, transition: mirror(1.5) },
  walk: { animate: { y: [0, -3, 0], rotate: 0, scaleY: 1 }, transition: loop(0.34) },
  sleep: { animate: { scaleY: [0.97, 1], y: 0, rotate: 0 }, transition: mirror(2) },
  eat: { animate: { rotate: [0, 2.5, 0], y: [0, 1.5, 0], scaleY: 1 }, transition: loop(0.6) },
  bathe: { animate: { y: [0, -2, 0], rotate: 0, scaleY: 1 }, transition: loop(1.2) },
  soak: { animate: { scaleY: [0.99, 1.015], y: 0, rotate: 0 }, transition: mirror(1.9) },
  swim: { animate: { y: [0, -2.5, 0], rotate: [0, 1.5, 0], scaleY: 1 }, transition: loop(1.1) },
  zen: { animate: { scaleY: [1, 1.012], y: 0, rotate: 0 }, transition: mirror(2.6) },
  play: { animate: { y: [0, -16, 0], rotate: 0, scaleY: 1 }, transition: loop(0.55, 'easeOut') },
  drag: { animate: { rotate: [-3, 3], y: 0, scaleY: 1 }, transition: mirror(0.8) },
  beg: { animate: { y: [0, -6, 0], rotate: 0, scaleY: 1 }, transition: loop(0.7) }
} satisfies Record<PetActivity, { animate: object; transition: object }>

/**
 * The OpenCowork capybara (brown fur, red flower on its head — see logo.webp),
 * rendered from generated pose sprites and animated with light transforms.
 */
export function CapybaraSprite({
  activity,
  facing,
  mood,
  cleanliness,
  width = 132,
  disableSkin = false
}: CapybaraSpriteProps): React.JSX.Element {
  const [walkFrame, setWalkFrame] = useState(0)
  const [eatVariant, setEatVariant] = useState(0)
  const activeSkinImages = usePetSkinImages()
  const skinImages = disableSkin ? null : activeSkinImages

  // Preload all poses once so activity switches never flicker.
  useEffect(() => {
    for (const src of ALL_IMAGES) {
      const img = new Image()
      img.src = src
    }
  }, [])

  // Two-frame step cycle: alternate the walk pose with the idle pose.
  useEffect(() => {
    if (activity !== 'walk') return
    const timer = window.setInterval(() => setWalkFrame((frame) => (frame + 1) % 2), 240)
    return () => window.clearInterval(timer)
  }, [activity])

  // Vary the meal: sometimes a leaf, sometimes a watermelon slice.
  useEffect(() => {
    if (activity === 'eat') setEatVariant(Math.random() < 0.5 ? 0 : 1)
  }, [activity])

  // Missing poses fall back to the skin's own idle before the bundled
  // capybara, so a partial skin never switches characters mid-animation.
  const resolve = (pose: PetPoseKey, bundled: string): string =>
    skinImages?.[pose] ?? skinImages?.idle ?? bundled

  const image =
    activity === 'walk'
      ? walkFrame === 0
        ? resolve('walk', walkImg)
        : resolve('idle', idleImg)
      : activity === 'eat'
        ? eatVariant === 0
          ? resolve('eat', eatImg)
          : resolve('munch', munchImg)
        : resolve(ACTIVITY_POSE[activity], ACTIVITY_IMAGE[activity])

  const dirty = cleanliness < 30
  const gloomy = mood < 30
  const filters: string[] = []
  if (dirty) filters.push('saturate(0.65) brightness(0.92)')
  if (gloomy) filters.push('grayscale(0.3)')

  const { animate: bodyAnimation, transition: bodyTransition } = BODY_MOTION[activity]

  return (
    <div
      style={{
        width,
        position: 'relative',
        transform: facing === 'left' ? 'scaleX(-1)' : undefined,
        pointerEvents: 'none'
      }}
    >
      <motion.div
        style={{ transformOrigin: 'center bottom' }}
        animate={bodyAnimation}
        transition={bodyTransition}
      >
        <img
          src={image}
          alt=""
          draggable={false}
          style={{
            display: 'block',
            height: POSE_HEIGHT[activity],
            width: 'auto',
            margin: '0 auto',
            filter: filters.length ? filters.join(' ') : undefined,
            userSelect: 'none'
          }}
        />

        {/* grime spots when a bath is overdue */}
        {dirty && activity !== 'bathe' ? (
          <>
            <span
              style={{
                position: 'absolute',
                left: '30%',
                top: '45%',
                width: 10,
                height: 6,
                borderRadius: '50%',
                background: '#6B4F33',
                opacity: 0.4
              }}
            />
            <span
              style={{
                position: 'absolute',
                left: '52%',
                top: '62%',
                width: 8,
                height: 5,
                borderRadius: '50%',
                background: '#6B4F33',
                opacity: 0.35
              }}
            />
          </>
        ) : null}
      </motion.div>

      {/* steam wisps while soaking in the hot spring */}
      {activity === 'soak' ? (
        <>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              style={{
                position: 'absolute',
                left: `${25 + i * 22}%`,
                bottom: '70%',
                width: 12,
                height: 20,
                borderRadius: '50%',
                background: 'rgba(255, 255, 255, 0.75)',
                filter: 'blur(4px)'
              }}
              animate={{ y: [0, -34], opacity: [0.75, 0], scaleX: [1, 1.6] }}
              transition={{
                duration: 2.2 + i * 0.5,
                repeat: Infinity,
                ease: 'easeOut',
                delay: i * 0.6
              }}
            />
          ))}
        </>
      ) : null}

      {/* rising bubbles while bathing */}
      {activity === 'bathe' ? (
        <>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              style={{
                position: 'absolute',
                left: `${22 + i * 26}%`,
                bottom: '55%',
                width: 8 + (i % 2) * 5,
                height: 8 + (i % 2) * 5,
                borderRadius: '50%',
                border: '1.5px solid rgba(158, 201, 232, 0.9)',
                background: 'rgba(200, 228, 248, 0.4)'
              }}
              animate={{ y: [-4, -46], opacity: [0.9, 0] }}
              transition={{
                duration: 1.7 + i * 0.4,
                repeat: Infinity,
                ease: 'easeOut',
                delay: i * 0.4
              }}
            />
          ))}
        </>
      ) : null}

      {/* floating Zzz while asleep */}
      {activity === 'sleep' ? (
        <motion.span
          style={{
            position: 'absolute',
            right: '12%',
            top: '-18%',
            fontSize: 18,
            fontWeight: 700,
            color: '#8A7358',
            transform: facing === 'left' ? 'scaleX(-1)' : undefined
          }}
          animate={{ y: [0, -14], opacity: [0.75, 0] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeOut' }}
        >
          Zzz
        </motion.span>
      ) : null}
    </div>
  )
}
