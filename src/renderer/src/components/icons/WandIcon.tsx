import { forwardRef, useImperativeHandle, useCallback } from 'react'
import type { AnimatedIconHandle, AnimatedIconProps } from './types'
import { motion, useAnimate } from 'motion/react'

const WandIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = 'currentColor', strokeWidth = 2, className = '' }, ref) => {
    const [scope, animate] = useAnimate()

    const start = useCallback(async () => {
      // Wand wiggles and sparkles twinkle
      animate(
        '.wand-stick',
        {
          rotate: [0, -8, 6, -4, 2, 0],
          y: [0, -1, 1, -1, 0]
        },
        { duration: 0.6, ease: 'easeInOut' }
      )
      // Sparkles pulse outward
      animate(
        '.wand-sparkle-1',
        { scale: [0.6, 1.3, 0.8, 1.1, 1], opacity: [0.4, 1, 0.6, 0.9, 0.7] },
        { duration: 0.8, ease: 'easeInOut' }
      )
      animate(
        '.wand-sparkle-2',
        { scale: [1, 0.5, 1.2, 0.7, 1], opacity: [0.6, 0.3, 0.9, 0.5, 0.8] },
        { duration: 0.7, ease: 'easeInOut', delay: 0.1 }
      )
      await animate(
        '.wand-sparkle-3',
        { scale: [0.8, 1.4, 0.6, 1], opacity: [0.5, 1, 0.4, 0.7] },
        { duration: 0.6, ease: 'easeInOut', delay: 0.15 }
      )
    }, [animate])

    const stop = useCallback(() => {
      animate('.wand-stick', { rotate: 0, y: 0 }, { duration: 0.2, ease: 'easeInOut' })
      animate('.wand-sparkle-1', { scale: 1, opacity: 0.7 }, { duration: 0.2 })
      animate('.wand-sparkle-2', { scale: 1, opacity: 0.8 }, { duration: 0.2 })
      animate('.wand-sparkle-3', { scale: 1, opacity: 0.7 }, { duration: 0.2 })
    }, [animate])

    const clickAnim = useCallback(async () => {
      // Magic burst on click
      animate(
        '.wand-stick',
        { rotate: [0, -15, 20, -10, 5, 0], scale: [1, 1.1, 0.95, 1.05, 1] },
        { duration: 0.4, ease: 'easeOut' }
      )
      // All sparkles flash bright then settle
      animate(
        '.wand-sparkle-1, .wand-sparkle-2, .wand-sparkle-3',
        { scale: [1, 2, 0.8, 1.1, 1], opacity: [0.7, 1, 0.3, 0.9, 0.7] },
        { duration: 0.5, ease: 'easeOut' }
      )
      // Burst ring
      await animate(
        '.wand-burst',
        { scale: [0.3, 1.8], opacity: [0.7, 0] },
        { duration: 0.45, ease: 'easeOut' }
      )
    }, [animate])

    useImperativeHandle(ref, () => ({
      startAnimation: start,
      stopAnimation: stop,
      clickAnimation: clickAnim
    }))

    return (
      <motion.svg
        ref={scope}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`cursor-pointer ${className}`}
        style={{ overflow: 'visible' }}
        onHoverStart={start}
        onHoverEnd={stop}
      >
        {/* Burst ring (invisible until click) */}
        <motion.circle
          className="wand-burst"
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke={color}
          strokeWidth={1}
          initial={{ scale: 0.3, opacity: 0 }}
          style={{ transformOrigin: '12px 12px' }}
        />
        {/* Wand stick */}
        <motion.g
          className="wand-stick"
          style={{ transformOrigin: '12px 12px', transformBox: 'fill-box' }}
        >
          <motion.path d="m21.64,3.64l-1.28-1.28a1.21,1.21,0,0,0-1.72,0L13.12,7.88" />
          <motion.path d="m18.4,6.88l-13.28,13.28a1.21,1.21,0,0,0,0,1.72l1.28,1.28a1.2,1.2,0,0,0,1.72,0L21.36,11.64a1.21,1.21,0,0,0,0-1.72Z" />
          <motion.path d="m8.44,12L12,15.56" />
        </motion.g>
        {/* Sparkles */}
        <motion.circle
          className="wand-sparkle-1"
          cx="7"
          cy="4"
          r="1"
          fill={color}
          stroke="none"
          initial={{ opacity: 0.7 }}
          style={{ transformOrigin: '7px 4px' }}
        />
        <motion.circle
          className="wand-sparkle-2"
          cx="18"
          cy="5"
          r="0.8"
          fill={color}
          stroke="none"
          initial={{ opacity: 0.8 }}
          style={{ transformOrigin: '18px 5px' }}
        />
        <motion.circle
          className="wand-sparkle-3"
          cx="15"
          cy="2"
          r="0.6"
          fill={color}
          stroke="none"
          initial={{ opacity: 0.7 }}
          style={{ transformOrigin: '15px 2px' }}
        />
      </motion.svg>
    )
  }
)

WandIcon.displayName = 'WandIcon'
export default WandIcon
