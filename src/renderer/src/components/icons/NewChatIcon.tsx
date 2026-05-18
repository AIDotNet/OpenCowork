import { forwardRef, useImperativeHandle, useCallback } from 'react'
import type { AnimatedIconHandle, AnimatedIconProps } from './types'
import { motion, useAnimate } from 'motion/react'

const NewChatIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = 'currentColor', strokeWidth = 2, className = '' }, ref) => {
    const [scope, animate] = useAnimate()

    const start = useCallback(async () => {
      // Pen writes a stroke then lifts
      animate(
        '.newchat-pen',
        {
          x: [0, 1, -1, 1, -0.5, 0],
          y: [0, -2, -3, -5, -3, 0],
          rotate: [0, -5, -3, -5, -2, 0]
        },
        { duration: 0.7, ease: 'easeInOut' }
      )
      // Writing stroke appears
      animate(
        '.newchat-stroke',
        { pathLength: [0, 1], opacity: [0, 0.8, 0] },
        { duration: 0.6, ease: 'easeInOut' }
      )
      await animate(
        '.newchat-spark',
        { scale: [0, 1.2, 0], opacity: [0, 0.9, 0] },
        { duration: 0.4, ease: 'easeOut', delay: 0.2 }
      )
    }, [animate])

    const stop = useCallback(() => {
      animate('.newchat-pen', { x: 0, y: 0, rotate: 0 }, { duration: 0.2, ease: 'easeInOut' })
      animate('.newchat-stroke', { pathLength: 0, opacity: 0 }, { duration: 0.15 })
    }, [animate])

    const clickAnim = useCallback(async () => {
      // Pen dashes forward
      await animate(
        '.newchat-pen',
        { x: [0, 3, -1, 0], y: [0, -1, -2, 0], rotate: [0, -8, 4, 0] },
        { duration: 0.35, ease: 'easeOut' }
      )
      // Spark burst
      animate(
        '.newchat-spark',
        { scale: [0, 1.5, 0], opacity: [0, 1, 0] },
        { duration: 0.3, ease: 'easeOut' }
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
        {/* Spark (hidden until animated) */}
        <motion.circle
          className="newchat-spark"
          cx="18"
          cy="5"
          r="1.5"
          fill={color}
          stroke="none"
          initial={{ scale: 0, opacity: 0 }}
          style={{ transformOrigin: '18px 5px' }}
        />
        <motion.g
          className="newchat-pen"
          style={{ transformOrigin: '12px 12px', transformBox: 'fill-box' }}
        >
          {/* Pencil body */}
          <motion.path d="m16.5,3.5l4,4L7,21H3v-4L16.5,3.5Z" />
          {/* Writing stroke (hidden, animated on hover) */}
          <motion.path
            className="newchat-stroke"
            d="M15 5 L20 10"
            strokeWidth={strokeWidth * 0.5}
            strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0 }}
          />
        </motion.g>
      </motion.svg>
    )
  }
)

NewChatIcon.displayName = 'NewChatIcon'
export default NewChatIcon
