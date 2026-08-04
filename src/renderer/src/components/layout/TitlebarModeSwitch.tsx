import { Briefcase, Check, ChevronDown, CircleHelp, Code2, Send, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import type { AppMode } from '@renderer/stores/ui-store'

export interface TitlebarModeOption {
  value: AppMode
  label: string
  description: string
  icon: React.JSX.Element
}

export function getTitlebarModeOptions(
  tCommon: (key: string) => string
): Array<TitlebarModeOption> {
  return [
    {
      value: 'chat',
      label: tCommon('mode.chat'),
      description: tCommon('mode.descriptions.chat'),
      icon: <Send className="size-3.5 text-inherit" />
    },
    {
      value: 'clarify',
      label: tCommon('mode.clarify'),
      description: tCommon('mode.descriptions.clarify'),
      icon: <CircleHelp className="size-3.5 text-inherit" />
    },
    {
      value: 'cowork',
      label: tCommon('mode.cowork'),
      description: tCommon('mode.descriptions.cowork'),
      icon: <Briefcase className="size-3.5 text-inherit" />
    },
    {
      value: 'code',
      label: tCommon('mode.code'),
      description: tCommon('mode.descriptions.code'),
      icon: <Code2 className="size-3.5 text-inherit" />
    },
    {
      value: 'acp',
      label: tCommon('mode.acp'),
      description: tCommon('mode.descriptions.acp'),
      icon: <ShieldCheck className="size-3.5 text-inherit" />
    }
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
  const { t: tCommon } = useTranslation('common')
  const allModeOptions = getTitlebarModeOptions(tCommon)
  const availableModeOptions = getAvailableModeOptions(allModeOptions, projectScoped)

  if (availableModeOptions.length <= 1) return null

  const defaultProjectModeOption =
    allModeOptions.find((option) => option.value === 'cowork') ?? allModeOptions[0]!
  const activeMode =
    availableModeOptions.find((option) => option.value === mode) ??
    (projectScoped ? defaultProjectModeOption : undefined) ??
    availableModeOptions[0] ??
    allModeOptions[0]!

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-tour="mode-switch"
          className="workspace-titlebar-action titlebar-no-drag group h-7 gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          disabled={disabled}
        >
          <span className="text-primary">{activeMode.icon}</span>
          <span className="font-medium">{activeMode.label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-1.5">
        {availableModeOptions.map((option) => {
          const active = mode === option.value
          return (
            <DropdownMenuItem
              key={option.value}
              className={cn(
                'group items-start gap-2.5 rounded-lg px-2 py-2',
                active && 'bg-accent/50 focus:bg-accent'
              )}
              onSelect={() => onSelect(option.value)}
            >
              <span
                className={cn(
                  'mt-px flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors',
                  active
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border/60 bg-muted/40 text-muted-foreground group-focus:text-foreground'
                )}
              >
                {option.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-[13px] font-medium leading-none text-foreground">
                  {option.label}
                  {active ? <Check className="size-3.5 text-primary" strokeWidth={2.5} /> : null}
                </span>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
