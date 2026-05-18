import { forwardRef, useImperativeHandle, useCallback } from 'react'
import type { AnimatedIconHandle, AnimatedIconProps } from './types'
import { motion, useAnimate } from 'motion/react'

const BulbIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = 'currentColor', strokeWidth = 2, className = '' }, ref) => {
    const [scope, animate] = useAnimate()

    const start = useCallback(async () => {
      await Promise.all([
        animate('.ray-left', { opacity: 0 }, { duration: 0.1 }),
        animate('.ray-top', { opacity: 0 }, { duration: 0.1 }),
        animate('.ray-right', { opacity: 0 }, { duration: 0.1 }),
        animate('.ray-top-left', { opacity: 0 }, { duration: 0.1 }),
        animate('.ray-top-right', { opacity: 0 }, { duration: 0.1 })
      ])
      await Promise.all([
        animate('.ray-left', { opacity: 1 }, { duration: 0.4, ease: 'easeOut' }),
        animate('.ray-top', { opacity: 1 }, { duration: 0.4, ease: 'easeOut' }),
        animate('.ray-right', { opacity: 1 }, { duration: 0.4, ease: 'easeOut' }),
        animate('.ray-top-left', { opacity: 1 }, { duration: 0.4, ease: 'easeOut' }),
        animate('.ray-top-right', { opacity: 1 }, { duration: 0.4, ease: 'easeOut' })
      ])
    }, [animate])

    const stop = useCallback(() => {
      animate('.ray-left', { opacity: 1 }, { duration: 0.2 })
      animate('.ray-top', { opacity: 1 }, { duration: 0.2 })
      animate('.ray-right', { opacity: 1 }, { duration: 0.2 })
      animate('.ray-top-left', { opacity: 1 }, { duration: 0.2 })
      animate('.ray-top-right', { opacity: 1 }, { duration: 0.2 })
    }, [animate])

    const clickAnim = useCallback(async () => {
      // Rays flash bright then settle
      await Promise.all([
        animate('.ray-left', { opacity: [1, 0, 1] }, { duration: 0.3 }),
        animate('.ray-top', { opacity: [1, 0, 1] }, { duration: 0.3 }),
        animate('.ray-right', { opacity: [1, 0, 1] }, { duration: 0.3 }),
        animate('.ray-top-left', { opacity: [1, 0, 1] }, { duration: 0.3 }),
        animate('.ray-top-right', { opacity: [1, 0, 1] }, { duration: 0.3 })
      ])
      // Bulb body glows
      animate('.bulb-body', { scale: [1, 1.08, 1] }, { duration: 0.3, ease: 'easeOut' })
    }, [animate])

    useImperativeHandle(ref, () => ({
      startAnimation: start,
      stopAnimation: stop,
      clickAnimation: clickAnim
    }))

    return (
      <motion.div
        ref={scope}
        onHoverStart={start}
        onHoverEnd={stop}
        className={`inline-flex ${className}`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={size}
          height={size}
          viewBox="0 0 24 24"
          strokeWidth={strokeWidth}
          fill={color}
          className="bulb-icon cursor-pointer"
          style={{ overflow: 'visible' }}
        >
          <path stroke="none" d="M0 0h24v24H0z" fill="none" />
          <motion.path
            className="ray-left"
            d="M4 11a1 1 0 0 1 .117 1.993l-.117 .007h-1a1 1 0 0 1 -.117 -1.993l.117 -.007h1z"
          />
          <motion.path
            className="ray-top"
            d="M12 2a1 1 0 0 1 .993 .883l.007 .117v1a1 1 0 0 1 -1.993 .117l-.007 -.117v-1a1 1 0 0 1 1 -1z"
          />
          <motion.path
            className="ray-right"
            d="M21 11a1 1 0 0 1 .117 1.993l-.117 .007h-1a1 1 0 0 1 -.117 -1.993l.117 -.007h1z"
          />
          <motion.path
            className="ray-top-left"
            d="M4.893 4.893a1 1 0 0 1 1.32 -.083l.094 .083l.7 .7a1 1 0 0 1 -1.32 1.497l-.094 -.083l-.7 -.7a1 1 0 0 1 0 -1.414z"
          />
          <motion.path
            className="ray-top-right"
            d="M17.693 4.893a1 1 0 0 1 1.497 1.32l-.083 .094l-.7 .7a1 1 0 0 1 -1.497 -1.32l.083 -.094l.7 -.7z"
          />
          <motion.path
            className="bulb-base"
            d="M14 18a1 1 0 0 1 1 1a3 3 0 0 1 -6 0a1 1 0 0 1 .883 -.993l.117 -.007h4z"
          />
          <motion.path
            className="bulb-body"
            d="M12 6a6 6 0 0 1 3.6 10.8a1 1 0 0 1 -.471 .192l-.129 .008h-6a1 1 0 0 1 -.6 -.2a6 6 0 0 1 3.6 -10.8z"
            style={{ transformOrigin: '12px 12px' }}
          />
        </svg>
      </motion.div>
    )
  }
)

BulbIcon.displayName = 'BulbIcon'
export default BulbIcon
