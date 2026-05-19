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
  | 'heavyWiggle'
  | 'heavyBounce'
  | 'heavySpin'
  | 'heavyJello'
  | 'heavyRubber'
  | 'heavyPop'
  | 'heavySwing'
  | 'heavyShake'
  | 'none'

interface AnimatedIconProps {
  children: ReactNode
  animation?: AnimationType
  className?: string
  disabled?: boolean
  /** Externally controlled hover state — when true, icon animates regardless of cursor position */
  hovered?: boolean
}

interface AnimDef {
  hover: TargetAndTransition
  tap: TargetAndTransition
}

const animations: Record<AnimationType, AnimDef> = {
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
  // --- Heavy animations (shortened: 0.5-0.7s) ---
  heavyWiggle: {
    hover: {
      rotate: [0, -15, 15, -10, 8, -4, 0],
      scale: [1, 1.08, 0.95, 1.04, 0.98, 1],
      transition: { duration: 0.6, ease: 'easeInOut' }
    },
    tap: {
      rotate: [0, -20, 18, -8, 0],
      scale: 0.85,
      transition: { duration: 0.35, ease: 'easeOut' }
    }
  },
  heavyBounce: {
    hover: {
      y: [0, -10, 3, -6, 1, 0],
      scale: [1, 1.12, 0.94, 1.06, 0.98, 1],
      transition: { duration: 0.6, ease: 'easeOut' }
    },
    tap: {
      y: [0, 5, -2, 0],
      scale: [1, 0.88, 1.08, 1],
      transition: { duration: 0.35, ease: 'easeOut' }
    }
  },
  heavySpin: {
    hover: {
      rotate: [0, 180, 360, 540, 720],
      scale: [1, 1.15, 0.92, 1.08, 1],
      transition: { duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94] }
    },
    tap: {
      rotate: [0, -90, 0],
      scale: [1, 0.82, 1.12, 1],
      transition: { duration: 0.4, ease: 'easeOut' }
    }
  },
  heavyJello: {
    hover: {
      skewX: [0, -10, 8, -6, 4, -2, 0],
      skewY: [0, -5, 3, -2, 1, 0],
      scale: [1, 1.04, 0.96, 1.02, 0.99, 1],
      transition: { duration: 0.65, ease: 'easeInOut' }
    },
    tap: {
      skewX: [0, -12, 10, -4, 0],
      scale: [1, 0.88, 1.08, 0.94, 1],
      transition: { duration: 0.4, ease: 'easeOut' }
    }
  },
  heavyRubber: {
    hover: {
      scaleX: [1, 1.3, 0.7, 1.2, 0.82, 1.1, 0.94, 1.03, 1],
      scaleY: [1, 0.7, 1.3, 0.78, 1.18, 0.88, 1.08, 0.96, 1],
      rotate: [0, -3, 3, -2, 2, 0],
      transition: { duration: 0.7, ease: 'easeInOut' }
    },
    tap: {
      scaleX: [1, 0.75, 1.25, 0.88, 1],
      scaleY: [1, 1.25, 0.75, 1.12, 1],
      transition: { duration: 0.4, ease: 'easeOut' }
    }
  },
  heavyPop: {
    hover: {
      scale: [1, 1.4, 0.75, 1.25, 0.88, 1.08, 0.96, 1],
      rotate: [0, -6, 8, -4, 2, 0],
      transition: { duration: 0.6, ease: 'easeOut' }
    },
    tap: {
      scale: [1, 0.65, 1.35, 0.82, 1.08, 1],
      transition: { duration: 0.35, ease: 'easeOut' }
    }
  },
  heavySwing: {
    hover: {
      rotate: [0, 22, -18, 12, -8, 4, -2, 0],
      y: [0, -2, 1, -1, 0],
      scale: [1, 1.04, 0.98, 1.02, 1],
      transition: { duration: 0.7, ease: 'easeInOut' }
    },
    tap: {
      rotate: [0, 28, -22, 8, 0],
      scale: [1, 0.92, 1.08, 0.96, 1],
      transition: { duration: 0.4, ease: 'easeOut' }
    }
  },
  heavyShake: {
    hover: {
      x: [0, -5, 5, -4, 4, -2, 2, 0],
      y: [0, -2, 1, -1, 1, 0],
      rotate: [0, -3, 3, -2, 2, 0],
      transition: { duration: 0.6, ease: 'easeInOut' }
    },
    tap: {
      x: [0, -7, 7, -4, 4, 0],
      scale: [1, 0.92, 1.04, 0.96, 1],
      transition: { duration: 0.35, ease: 'easeOut' }
    }
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
  disabled = false,
  hovered
}: AnimatedIconProps): React.JSX.Element {
  const anim = animations[animation] || animations.scale

  if (disabled) {
    return <span className={className}>{children}</span>
  }

  // Externally controlled hover (for parent-driven row hover)
  if (hovered !== undefined) {
    return (
      <motion.span
        className={`inline-flex items-center justify-center ${className}`}
        initial={false}
        animate={hovered ? anim.hover : {}}
        whileTap={anim.tap}
        style={{ transformOrigin: 'center center' }}
      >
        {children}
      </motion.span>
    )
  }

  // Default: hover on the icon itself
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
