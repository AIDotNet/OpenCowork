import { type ReactNode } from 'react'
import { motion, type TargetAndTransition } from 'motion/react'

export type AnimationType =
  | 'scale'
  | 'rotate'
  | 'spin'
  | 'bounce'
  | 'shake'
  | 'pulse'
  | 'wiggle'
  | 'swing'
  | 'flip'
  | 'pop'
  | 'jello'
  | 'rubber'
  | 'none'

interface AnimatedIconProps {
  children: ReactNode
  animation?: AnimationType
  className?: string
  disabled?: boolean
}

interface AnimConfig {
  hover: TargetAndTransition
  tap: TargetAndTransition
}

const animations: Record<AnimationType, AnimConfig> = {
  scale: {
    hover: { scale: 1.25, transition: { type: 'spring', stiffness: 400, damping: 15 } },
    tap: { scale: 0.85 }
  },
  rotate: {
    hover: { rotate: 90, scale: 1.1, transition: { type: 'spring', stiffness: 300, damping: 15 } },
    tap: { rotate: -15, scale: 0.9 }
  },
  spin: {
    hover: { rotate: 360, scale: 1.1, transition: { duration: 0.5, ease: 'easeInOut' } },
    tap: { scale: 0.9 }
  },
  bounce: {
    hover: { y: -4, scale: 1.1, transition: { type: 'spring', stiffness: 500, damping: 12 } },
    tap: { y: 2, scale: 0.95 }
  },
  shake: {
    hover: {
      x: [0, -3, 3, -2, 2, 0],
      transition: { duration: 0.4, ease: 'easeInOut' }
    },
    tap: { scale: 0.9 }
  },
  pulse: {
    hover: {
      scale: [1, 1.2, 1],
      transition: { duration: 0.4, ease: 'easeInOut' }
    },
    tap: { scale: 0.85 }
  },
  wiggle: {
    hover: {
      rotate: [0, -8, 8, -5, 5, 0],
      transition: { duration: 0.5, ease: 'easeInOut' }
    },
    tap: { scale: 0.9 }
  },
  swing: {
    hover: {
      rotate: [0, 15, -10, 5, -3, 0],
      transition: { duration: 0.5, ease: 'easeInOut' }
    },
    tap: { scale: 0.9 }
  },
  flip: {
    hover: {
      rotateY: 180,
      scale: 1.1,
      transition: { duration: 0.4, ease: 'easeInOut' }
    },
    tap: { scale: 0.9 }
  },
  pop: {
    hover: {
      scale: [1, 1.3, 0.9, 1.1, 1],
      transition: { duration: 0.4, ease: 'easeOut' }
    },
    tap: { scale: 0.8 }
  },
  jello: {
    hover: {
      skewX: [0, -8, 6, -4, 2, 0],
      skewY: [0, -3, 2, -1, 0],
      transition: { duration: 0.5, ease: 'easeInOut' }
    },
    tap: { scale: 0.9 }
  },
  rubber: {
    hover: {
      scaleX: [1, 1.25, 0.75, 1.15, 0.95, 1.05, 1],
      scaleY: [1, 0.75, 1.25, 0.85, 1.05, 0.95, 1],
      transition: { duration: 0.6, ease: 'easeInOut' }
    },
    tap: { scale: 0.9 }
  },
  none: {
    hover: {},
    tap: {}
  }
}

export function AnimatedIcon({
  children,
  animation = 'scale',
  className = '',
  disabled = false
}: AnimatedIconProps): React.JSX.Element {
  const anim = animations[animation] || animations.scale

  if (disabled) {
    return <span className={className}>{children}</span>
  }

  return (
    <motion.span
      className={`inline-flex items-center justify-center ${className}`}
      initial={false}
      whileHover={anim.hover}
      whileTap={anim.tap}
      style={{ transformOrigin: 'center center' }}
    >
      {children}
    </motion.span>
  )
}
