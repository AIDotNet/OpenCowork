import { forwardRef, useImperativeHandle, useCallback } from 'react'
import type { AnimatedIconHandle, AnimatedIconProps } from './types'
import { motion, useAnimate } from 'motion/react'

const CalendarIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = 'currentColor', strokeWidth = 2, className = '' }, ref) => {
    const [scope, animate] = useAnimate()

    const start = useCallback(async () => {
      // Page flips up
      animate(
        '.cal-page',
        {
          scaleY: [1, 0.6, 1],
          y: [0, -2, 0],
          rotateX: [0, -15, 0]
        },
        { duration: 0.5, ease: 'easeInOut' }
      )
      // Bounce the body
      await animate('.cal-body', { y: [0, -2, 1, 0] }, { duration: 0.4, ease: 'easeOut' })
    }, [animate])

    const stop = useCallback(() => {
      animate('.cal-page', { scaleY: 1, y: 0, rotateX: 0 }, { duration: 0.2, ease: 'easeInOut' })
      animate('.cal-body', { y: 0 }, { duration: 0.2 })
    }, [animate])

    const clickAnim = useCallback(async () => {
      // Rapid page flip
      await animate(
        '.cal-page',
        { scaleY: [1, 0.3, 1], y: [0, -4, 0], rotateX: [0, -30, 0] },
        { duration: 0.4, ease: 'easeOut' }
      )
      // Bounce
      animate('.cal-body', { scale: [1, 0.9, 1.08, 1] }, { duration: 0.35, ease: 'easeOut' })
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
        <motion.g
          className="cal-body"
          style={{ transformOrigin: '12px 12px', transformBox: 'fill-box' }}
        >
          {/* Top binding hooks */}
          <motion.path d="M8 2v4" />
          <motion.path d="M16 2v4" />
          {/* Calendar body */}
          <motion.rect width="18" height="18" x="3" y="4" rx="2" />
          {/* Page (the date grid area) */}
          <motion.g className="cal-page" style={{ transformOrigin: '12px 14px' }}>
            <motion.path d="M3 10h18" />
            <motion.path d="M10 14h1" />
            <motion.path d="M14 14h1" />
            <motion.path d="M10 18h1" />
            <motion.path d="M14 18h1" />
          </motion.g>
        </motion.g>
      </motion.svg>
    )
  }
)

CalendarIcon.displayName = 'CalendarIcon'
export default CalendarIcon
