import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ImageGeneratingLoaderProps {
  previewSrc?: string
}

const DOT_PATTERN_STYLE = {
  backgroundImage:
    'radial-gradient(circle at center, rgba(255, 255, 255, 0.16) 0 1.1px, transparent 1.3px)',
  backgroundSize: '16px 16px'
}

const DIAGONAL_MASK =
  'linear-gradient(150deg, transparent 6%, rgba(0, 0, 0, 0.42) 28%, rgba(0, 0, 0, 0.95) 72%, transparent 100%)'

const SPOTLIGHT_MASK =
  'radial-gradient(circle at 76% 72%, rgba(0, 0, 0, 0.92) 0%, rgba(0, 0, 0, 0.58) 24%, transparent 58%)'

export function ImageGeneratingLoader({
  previewSrc
}: ImageGeneratingLoaderProps): React.JSX.Element {
  const { t } = useTranslation('chat')

  return (
    <motion.div
      layout
      role="status"
      aria-live="polite"
      className="w-full max-w-[560px]"
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
    >
      <motion.div className="relative overflow-hidden rounded-[32px] bg-[#3a3a3a] p-6 shadow-[0_28px_72px_rgba(0,0,0,0.28)]">
        <motion.div
          className="absolute -top-10 right-6 h-36 w-36 rounded-full bg-white/[0.04] blur-3xl"
          animate={{
            x: [-8, 14, -8],
            y: [0, 8, 0],
            opacity: [0.2, 0.36, 0.2],
            scale: [0.96, 1.06, 0.96]
          }}
          transition={{
            duration: 7,
            repeat: Infinity,
            ease: 'easeInOut'
          }}
        />

        <motion.div
          className="absolute inset-x-[-12%] top-14 h-20 bg-gradient-to-r from-transparent via-white/[0.05] to-transparent blur-2xl"
          animate={{
            x: ['-8%', '10%', '-8%'],
            opacity: [0.2, 0.4, 0.2]
          }}
          transition={{
            duration: 4.5,
            repeat: Infinity,
            ease: 'easeInOut'
          }}
        />

        <div className="relative flex min-h-[360px] flex-col">
          <div className="flex items-start justify-between gap-4">
            <p className="max-w-[72%] text-base font-semibold text-white/92 sm:text-lg">
              {t('toolCall.imagePlugin.generating')}
            </p>

            <motion.div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-black/10 text-white/70"
              animate={{
                y: [0, -3, 0],
                opacity: [0.72, 1, 0.72]
              }}
              transition={{
                duration: 2.4,
                repeat: Infinity,
                ease: 'easeInOut'
              }}
            >
              <Loader2 className="size-4 animate-spin" />
            </motion.div>
          </div>

          <div className="relative mt-6 flex-1 overflow-hidden rounded-[28px]">
            {previewSrc ? (
              <>
                <motion.img
                  src={previewSrc}
                  alt="Generating image preview"
                  className="absolute inset-0 h-full w-full scale-105 object-cover opacity-28"
                  animate={{
                    scale: [1.05, 1.08, 1.05],
                    opacity: [0.2, 0.32, 0.2]
                  }}
                  transition={{
                    duration: 6,
                    repeat: Infinity,
                    ease: 'easeInOut'
                  }}
                  style={{
                    WebkitMaskImage:
                      'radial-gradient(circle at 68% 62%, black 0%, rgba(0,0,0,0.92) 32%, transparent 78%)',
                    maskImage:
                      'radial-gradient(circle at 68% 62%, black 0%, rgba(0,0,0,0.92) 32%, transparent 78%)'
                  }}
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(58,58,58,0.1),rgba(58,58,58,0.45)_44%,rgba(58,58,58,0.92))]" />
              </>
            ) : (
              <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(0,0,0,0.08))]" />
            )}

            <motion.div
              className="absolute inset-0"
              style={DOT_PATTERN_STYLE}
              animate={{ opacity: [0.16, 0.26, 0.16] }}
              transition={{
                duration: 3.2,
                repeat: Infinity,
                ease: 'easeInOut'
              }}
            />

            <motion.div
              className="absolute inset-0"
              style={{
                ...DOT_PATTERN_STYLE,
                backgroundSize: '18px 18px',
                WebkitMaskImage: DIAGONAL_MASK,
                maskImage: DIAGONAL_MASK
              }}
              animate={{
                opacity: [0.08, 0.22, 0.08],
                scale: [1, 1.018, 1]
              }}
              transition={{
                duration: 4.4,
                repeat: Infinity,
                ease: 'easeInOut'
              }}
            />

            <motion.div
              className="absolute inset-0"
              style={{
                ...DOT_PATTERN_STYLE,
                backgroundSize: '14px 14px',
                WebkitMaskImage: SPOTLIGHT_MASK,
                maskImage: SPOTLIGHT_MASK
              }}
              animate={{
                opacity: [0.18, 0.38, 0.18],
                scale: [0.98, 1.03, 0.98]
              }}
              transition={{
                duration: 3.6,
                repeat: Infinity,
                ease: 'easeInOut'
              }}
            />

            <motion.div
              className="absolute -bottom-12 right-8 h-44 w-44 rounded-full bg-white/[0.05] blur-3xl"
              animate={{
                opacity: [0.16, 0.28, 0.16],
                scale: [0.94, 1.08, 0.94]
              }}
              transition={{
                duration: 4.8,
                repeat: Infinity,
                ease: 'easeInOut'
              }}
            />

            <div className="absolute inset-x-0 bottom-0 h-40 bg-[linear-gradient(180deg,rgba(58,58,58,0)_0%,rgba(58,58,58,0.75)_70%,rgba(58,58,58,0.94)_100%)]" />
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
