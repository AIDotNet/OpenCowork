import { useCallback, useId, useRef } from 'react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { spring } from '@renderer/components/animate-ui/transitions'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { isSelectableMode, renderModeTooltipContent } from '@renderer/lib/mode-tooltips'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'
import type { AppMode } from '@renderer/stores/ui-store'

export interface TitlebarModeOption {
  value: AppMode
  label: string
}

const MODE_SHORTCUT: Partial<Record<AppMode, string>> = {
  clarify: 'Ctrl+1',
  cowork: 'Ctrl+2',
  code: 'Ctrl+3',
  acp: 'Ctrl+4'
}

export function getTitlebarModeOptions(
  tCommon: (key: string) => string
): Array<TitlebarModeOption> {
  return [
    { value: 'chat', label: tCommon('mode.chat') },
    { value: 'clarify', label: tCommon('mode.clarify') },
    { value: 'cowork', label: tCommon('mode.cowork') },
    { value: 'code', label: tCommon('mode.code') },
    { value: 'acp', label: tCommon('mode.acp') }
  ]
}

/**
 * Modes a session can switch between. Project-scoped sessions drop plain chat;
 * standalone chat sessions only ever stay in chat.
 */
export function getAvailableModeOptions(
  options: Array<TitlebarModeOption>,
  projectScoped: boolean
): Array<TitlebarModeOption> {
  return projectScoped
    ? options.filter((option) => option.value !== 'chat')
    : options.filter((option) => option.value === 'chat')
}

interface TitlebarModeSwitchProps {
  mode: AppMode
  projectScoped: boolean
  disabled?: boolean
  onSelect: (mode: AppMode) => void
}

export function TitlebarModeSwitch({
  mode,
  projectScoped,
  disabled = false,
  onSelect
}: TitlebarModeSwitchProps): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const { t: tCommon } = useTranslation('common')
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const layoutId = `titlebar-mode-pill-${useId()}`
  const tabListRef = useRef<HTMLDivElement>(null)
  const allModeOptions = getTitlebarModeOptions(tCommon)
  const availableModeOptions = getAvailableModeOptions(allModeOptions, projectScoped)

  const defaultProjectModeOption =
    allModeOptions.find((option) => option.value === 'cowork') ?? allModeOptions[0]!
  const activeMode =
    availableModeOptions.find((option) => option.value === mode) ??
    (projectScoped ? defaultProjectModeOption : undefined) ??
    availableModeOptions[0] ??
    allModeOptions[0]!

  const focusTab = useCallback((value: AppMode) => {
    const button = tabListRef.current?.querySelector<HTMLButtonElement>(`[data-mode="${value}"]`)
    button?.focus()
  }, [])

  const selectMode = useCallback(
    (nextMode: AppMode) => {
      if (disabled || nextMode === mode) return
      onSelect(nextMode)
    },
    [disabled, mode, onSelect]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return

      const index = availableModeOptions.findIndex((option) => option.value === activeMode.value)
      if (index < 0) return

      let nextIndex = index
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (index + 1) % availableModeOptions.length
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (index - 1 + availableModeOptions.length) % availableModeOptions.length
      } else if (event.key === 'Home') {
        nextIndex = 0
      } else if (event.key === 'End') {
        nextIndex = availableModeOptions.length - 1
      } else {
        return
      }

      event.preventDefault()
      const nextOption = availableModeOptions[nextIndex]
      if (!nextOption) return
      selectMode(nextOption.value)
      focusTab(nextOption.value)
    },
    [activeMode.value, availableModeOptions, disabled, focusTab, selectMode]
  )

  if (availableModeOptions.length <= 1) return null

  return (
    <div
      ref={tabListRef}
      role="tablist"
      aria-label={tCommon('mode.switcher')}
      aria-disabled={disabled || undefined}
      data-tour="mode-switch"
      onKeyDown={handleKeyDown}
      className={cn(
        'workspace-titlebar-mode-tabs titlebar-no-drag relative flex h-7 shrink-0 items-center overflow-hidden rounded-[10px] p-0.5',
        disabled && 'pointer-events-none opacity-55'
      )}
    >
      {availableModeOptions.map((option) => {
        const active = activeMode.value === option.value
        const shortcut = MODE_SHORTCUT[option.value]

        return (
          <HoverCard key={option.value} openDelay={120} closeDelay={160}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                role="tab"
                data-mode={option.value}
                data-tour={`mode-${option.value}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                disabled={disabled}
                onClick={() => selectMode(option.value)}
                className={cn(
                  'titlebar-no-drag relative z-0 inline-flex h-6 items-center whitespace-nowrap rounded-md px-2.5 text-[11px] font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {active ? (
                  animationsEnabled ? (
                    <motion.span
                      layoutId={layoutId}
                      transition={spring.stiff}
                      className="workspace-titlebar-mode-tabs-pill absolute inset-0 rounded-md"
                    />
                  ) : (
                    <span className="workspace-titlebar-mode-tabs-pill absolute inset-0 rounded-md" />
                  )
                ) : null}
                <span className="relative z-10">{option.label}</span>
              </button>
            </HoverCardTrigger>
            <HoverCardContent
              side="bottom"
              align="center"
              sideOffset={8}
              className="titlebar-no-drag w-[320px] max-w-[calc(100vw-1.5rem)] px-3 py-2.5"
            >
              {isSelectableMode(option.value)
                ? renderModeTooltipContent({
                    mode: option.value,
                    label: option.label,
                    shortcut,
                    isActive: active,
                    t
                  })
                : option.label}
            </HoverCardContent>
          </HoverCard>
        )
      })}
    </div>
  )
}
