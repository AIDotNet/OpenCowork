import * as React from 'react'
import { Plus, Sparkles, Loader2, Command } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useSkillsStore } from '@renderer/stores/skills-store'

interface SkillsMenuProps {
  onSelectSkill: (skillName: string) => void
  disabled?: boolean
}

export function SkillsMenu({ onSelectSkill, disabled = false }: SkillsMenuProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const skills = useSkillsStore((s) => s.skills)
  const loading = useSkillsStore((s) => s.loading)
  const loadSkills = useSkillsStore((s) => s.loadSkills)

  // Load skills when menu opens
  React.useEffect(() => {
    if (open) {
      loadSkills()
    }
  }, [open, loadSkills])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-lg"
              disabled={disabled}
            >
              <Plus className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Add actions</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Add to Chat</DropdownMenuLabel>
        <DropdownMenuSeparator />
        
        <DropdownMenuGroup>
          <DropdownMenuItem disabled>
            <Command className="mr-2 size-4" />
            <span>Commands</span>
            <DropdownMenuSeparator className="ml-auto" />
          </DropdownMenuItem>
          {/* Placeholder for future commands */}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sparkles className="mr-2 size-4" />
              <span>Skills</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-64 max-h-80 overflow-y-auto">
                <DropdownMenuLabel>Available Skills</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {loading ? (
                  <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin mr-1.5" />
                    Loading skills...
                  </div>
                ) : skills.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    <p>No skills installed</p>
                    <p className="mt-1 text-[10px] opacity-70">
                      ~/.open-cowork/skills/
                    </p>
                  </div>
                ) : (
                  skills.map((skill) => (
                    <DropdownMenuItem
                      key={skill.name}
                      onClick={() => onSelectSkill(skill.name)}
                      className="flex flex-col items-start gap-1 py-2"
                    >
                      <span className="font-medium">{skill.name}</span>
                      <span className="text-xs text-muted-foreground line-clamp-2">
                        {skill.description}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
