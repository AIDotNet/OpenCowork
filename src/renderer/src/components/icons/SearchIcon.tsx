import { forwardRef, useImperativeHandle, useCallback } from 'react'
import type { AnimatedIconHandle, AnimatedIconProps } from './types'
import { motion, useAnimate } from 'motion/react'

const SearchIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = 'currentColor', strokeWidth = 2, className = '' }, ref) => {
    const [scope, animate] = useAnimate()

    const start = useCallback(async () => {
      // Magnifying glass swings like a pendulum
      animate(
        '.search-glass',
        {
          rotate: [0, -12, 10, -8, 5, 0],
          scale: [1, 1.08, 1.04, 1.06, 1.02, 1]
        },
        { duration: 0.7, ease: 'easeInOut' }
      )
      // Lens glint
      await animate(
        '.search-glint',
        { opacity: [0, 0.8, 0], scale: [0.5, 1.2, 0.5] },
        { duration: 0.5, ease: 'easeOut' }
      )
    }, [animate])

    const stop = useCallback(() => {
      animate('.search-glass', { rotate: 0, scale: 1 }, { duration: 0.25, ease: 'easeInOut' })
      animate('.search-glint', { opacity: 0, scale: 0.5 }, { duration: 0.15 })
    }, [animate])

    const clickAnim = useCallback(async () => {
      // Quick zoom-burst on click
      await animate(
        '.search-glass',
        { scale: [1, 0.85, 1.15, 1] },
        { duration: 0.35, ease: 'easeOut' }
      )
      // Ring pulse
      animate(
        '.search-ring',
        { scale: [0.8, 1.6], opacity: [0.6, 0] },
        { duration: 0.4, ease: 'easeOut' }
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
        {/* Pulse ring (invisible until click) */}
        <motion.circle
          className="search-ring"
          cx="11"
          cy="11"
          r="8"
          fill="none"
          stroke={color}
          strokeWidth={1}
          initial={{ scale: 0.8, opacity: 0 }}
          style={{ transformOrigin: '11px 11px' }}
        />
        <motion.g
          className="search-glass"
          style={{ transformOrigin: '11px 11px', transformBox: 'fill-box' }}
        >
          {/* Lens */}
          <motion.circle cx="11" cy="11" r="8" />
          {/* Handle */}
          <motion.path d="m21 21-4.35-4.35" />
          {/* Lens glint */}
          <motion.path
            className="search-glint"
            d="M8 8 L9.5 9.5"
            strokeWidth={strokeWidth * 0.6}
            strokeLinecap="round"
            initial={{ opacity: 0 }}
          />
        </motion.g>
      </motion.svg>
    )
  }
)

SearchIcon.displayName = 'SearchIcon'
export default SearchIcon
