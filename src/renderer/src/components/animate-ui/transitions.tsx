import { AnimatePresence, motion, HTMLMotionProps } from 'motion/react'
import { ReactNode, ElementType, forwardRef, type JSX } from 'react'
import { cn } from '@renderer/lib/utils'

// ─── Types ───

type TransitionDirection = 'up' | 'down' | 'left' | 'right'

interface BaseTransitionProps extends HTMLMotionProps<'div'> {
  children: ReactNode
  className?: string
  as?: ElementType
  delay?: number
  duration?: number
}

interface SlideProps extends BaseTransitionProps {
  direction?: TransitionDirection
  offset?: number
}

// ─── Spring Configs ───

const spring = {
  stiff: { type: 'spring', stiffness: 400, damping: 30 },
  smooth: { type: 'spring', stiffness: 300, damping: 30, mass: 0.8 },
  slow: { type: 'spring', stiffness: 200, damping: 40 },
} as const

const ease = {
  out: [0.22, 1, 0.36, 1],
  inOut: [0.4, 0, 0.2, 1],
} as const

// ─── Components ───

/**
 * FadeIn - Simple opacity transition
 */
export const FadeIn = forwardRef<HTMLDivElement, BaseTransitionProps>(
  ({ children, className, delay = 0, duration = 0.2, as: Component = motion.div, ...props }, ref) => {
    return (
      <Component
        ref={ref}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration, delay, ease: ease.out }}
        className={className}
        {...props}
      >
        {children}
      </Component>
    )
  }
)
FadeIn.displayName = 'FadeIn'

/**
 * SlideIn - Slide and fade from a direction
 */
export const SlideIn = forwardRef<HTMLDivElement, SlideProps>(
  ({ children, className, direction = 'up', offset = 10, delay = 0, as: Component = motion.div, ...props }, ref) => {
    const getInitial = (): { opacity: number; x?: number; y?: number } => {
      switch (direction) {
        case 'up': return { opacity: 0, y: offset }
        case 'down': return { opacity: 0, y: -offset }
        case 'left': return { opacity: 0, x: offset }
        case 'right': return { opacity: 0, x: -offset }
      }
    }

    return (
      <Component
        ref={ref}
        initial={getInitial()}
        animate={{ opacity: 1, x: 0, y: 0 }}
        exit={getInitial()}
        transition={{ type: 'spring', stiffness: 400, damping: 30, delay }}
        className={className}
        {...props}
      >
        {children}
      </Component>
    )
  }
)
SlideIn.displayName = 'SlideIn'

/**
 * ScaleIn - Scale up from center
 */
export const ScaleIn = forwardRef<HTMLDivElement, BaseTransitionProps>(
  ({ children, className, delay = 0, as: Component = motion.div, ...props }, ref) => {
    return (
      <Component
        ref={ref}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ ...spring.smooth, delay }}
        className={className}
        {...props}
      >
        {children}
      </Component>
    )
  }
)
ScaleIn.displayName = 'ScaleIn'

/**
 * PageTransition - Full page/panel replacement transition
 */
export const PageTransition = forwardRef<HTMLDivElement, BaseTransitionProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 20, filter: 'blur(5px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={{ opacity: 0, y: -20, filter: 'blur(5px)' }}
        transition={{
          type: 'spring',
          stiffness: 260,
          damping: 20,
          mass: 0.8
        }}
        className={cn('size-full', className)}
        {...props}
      >
        {children}
      </motion.div>
    )
  }
)
PageTransition.displayName = 'PageTransition'

/**
 * StaggerContainer - Orchestrate children animations
 */
export const StaggerContainer = ({
  children,
  className,
  delay = 0.05
}: {
  children: ReactNode
  className?: string
  delay?: number
}): JSX.Element => {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      exit="hidden"
      variants={{
        hidden: { opacity: 0 },
        show: {
          opacity: 1,
          transition: {
            staggerChildren: delay,
          },
        },
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/**
 * StaggerItem - Child of StaggerContainer
 */
export const StaggerItem = ({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element => {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 10 },
        show: { opacity: 1, y: 0, transition: spring.smooth },
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/**
 * PanelTransition - Smooth width and opacity transition for side panels
 * Ensures siblings resize smoothly
 */
export const PanelTransition = forwardRef<
  HTMLDivElement,
  BaseTransitionProps & { side?: 'left' | 'right'; disabled?: boolean }
>(
  ({
    children,
    className,
    side = 'right',
    disabled = false,
    delay = 0,
    as: Component = motion.div,
    ...props
  }, ref) => {
    const xInitial = side === 'right' ? 20 : -20

    if (disabled) {
      return (
        <Component ref={ref} className={cn('overflow-hidden', className)} {...props}>
          <div className="h-full w-max">
            {children}
          </div>
        </Component>
      )
    }

    return (
      <Component
        ref={ref}
        initial={{ width: 0, opacity: 0, x: xInitial }}
        animate={{ width: 'auto', opacity: 1, x: 0 }}
        exit={{ width: 0, opacity: 0, x: xInitial }}
        transition={{ 
          type: 'spring', 
          stiffness: 350, 
          damping: 30,
          delay,
          opacity: { duration: 0.2 }
        }}
        className={cn('overflow-hidden', className)}
        {...props}
      >
        <div className="h-full w-max">
          {children}
        </div>
      </Component>
    )
  }
)
PanelTransition.displayName = 'PanelTransition'

// Re-export AnimatePresence for convenience
export { AnimatePresence }
