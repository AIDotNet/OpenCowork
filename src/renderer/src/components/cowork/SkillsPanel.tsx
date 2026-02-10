import { Sparkles, FolderOpen, Search, Terminal, ListChecks, Brain } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Separator } from '@renderer/components/ui/separator'
import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'
import type { ToolDefinition } from '@renderer/lib/api/types'

const categoryMap: Record<string, { label: string; icon: React.ReactNode }> = {
  filesystem: { label: 'File System', icon: <FolderOpen className="size-3.5" /> },
  search: { label: 'Search', icon: <Search className="size-3.5" /> },
  shell: { label: 'Shell', icon: <Terminal className="size-3.5" /> },
  task: { label: 'Task Management', icon: <ListChecks className="size-3.5" /> },
}

const SUB_AGENT_NAMES = new Set<string>()

function getCategory(name: string): string {
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'LS', 'Delete'].includes(name)) return 'filesystem'
  if (['Glob', 'Grep'].includes(name)) return 'search'
  if (['Bash'].includes(name)) return 'shell'
  if (['TodoRead', 'TodoWrite'].includes(name)) return 'task'
  if (SUB_AGENT_NAMES.has(name)) return 'subagent'
  return 'other'
}

function groupTools(tools: ToolDefinition[]): { key: string; label: string; icon: React.ReactNode; tools: ToolDefinition[] }[] {
  const groups = new Map<string, ToolDefinition[]>()
  for (const t of tools) {
    const cat = getCategory(t.name)
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(t)
  }
  return Array.from(groups.entries()).map(([key, items]) => ({
    key,
    label: categoryMap[key]?.label ?? 'Other',
    icon: categoryMap[key]?.icon ?? <Sparkles className="size-3.5" />,
    tools: items,
  }))
}

export function SkillsPanel(): React.JSX.Element {
  const allTools = toolRegistry.getDefinitions()
  const subAgents = subAgentRegistry.getAll()

  // Update the set so getCategory can filter SubAgents out of regular groups
  SUB_AGENT_NAMES.clear()
  for (const sa of subAgents) SUB_AGENT_NAMES.add(sa.name)

  // Regular tools only (exclude SubAgent tools from the main list)
  const tools = allTools.filter((t) => !SUB_AGENT_NAMES.has(t.name))

  if (tools.length === 0 && subAgents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Sparkles className="mb-3 size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No skills loaded</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Installed plugin skills will appear here
        </p>
      </div>
    )
  }

  const groups = groupTools(tools)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Built-in Tools
        </h4>
        <Badge variant="secondary" className="text-[10px]">
          {tools.length}
        </Badge>
      </div>
      {groups.map((group) => (
        <div key={group.key} className="space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider px-2">
            {group.icon}
            <span>{group.label}</span>
            <span className="text-muted-foreground/40">({group.tools.length})</span>
          </div>
          <ul className="space-y-0.5">
            {group.tools.map((tool) => (
              <li
                key={tool.name}
                className="rounded-md px-2 py-1.5 hover:bg-muted/50"
              >
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-medium">{tool.name}</p>
                  {['Bash'].includes(tool.name) && <span className="rounded bg-red-500/10 px-1 py-px text-[8px] text-red-500">approval</span>}
                  {['Write', 'Edit', 'MultiEdit', 'Delete'].includes(tool.name) && <span className="rounded bg-amber-500/10 px-1 py-px text-[8px] text-amber-500">approval</span>}
                </div>
                <p className="text-[10px] text-muted-foreground line-clamp-2">
                  {tool.description}
                </p>
                {tool.inputSchema.required && tool.inputSchema.required.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-0.5">
                    {tool.inputSchema.required.map((p) => (
                      <span key={p} className="rounded bg-muted px-1 py-px text-[9px] font-mono text-muted-foreground/50">{p}</span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {subAgents.length > 0 && (
        <>
          <Separator />
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-violet-500 uppercase tracking-wider flex items-center gap-1.5">
              <Brain className="size-3.5" />
              SubAgents
            </h4>
            <Badge variant="secondary" className="text-[10px]">
              {subAgents.length}
            </Badge>
          </div>
          <ul className="space-y-1">
            {subAgents.map((sa) => (
              <li key={sa.name} className="rounded-md px-2 py-1.5 hover:bg-muted/50">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-medium text-violet-500">{sa.name}</p>
                  <span className="rounded bg-violet-500/10 px-1 py-px text-[8px] text-violet-500">agent</span>
                  <span className="ml-auto text-[9px] text-muted-foreground/40">max {sa.maxIterations} iter</span>
                </div>
                <p className="text-[10px] text-muted-foreground line-clamp-2">
                  {sa.description}
                </p>
                <div className="mt-0.5 flex flex-wrap gap-0.5">
                  {sa.allowedTools.map((t) => (
                    <span key={t} className="rounded bg-violet-500/5 px-1 py-px text-[9px] font-mono text-violet-400/60">{t}</span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
