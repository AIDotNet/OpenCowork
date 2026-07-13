import * as React from 'react'
import { Bot, icons } from 'lucide-react'
import { subAgentRegistry } from '@renderer/lib/agent/sub-agents/registry'

const ICON_TONES = [
  'text-violet-400',
  'text-emerald-400',
  'text-rose-400',
  'text-sky-400',
  'text-amber-400',
  'text-fuchsia-400'
] as const

export function getAgentIcon(agentName: string): React.ReactNode {
  const definition = subAgentRegistry.get(agentName)
  if (definition?.icon && definition.icon in icons) {
    const Icon = icons[definition.icon as keyof typeof icons]
    return <Icon className="size-4" />
  }
  return <Bot className="size-4" />
}

export function getAgentIconTone(agentName: string): (typeof ICON_TONES)[number] {
  let hash = 0
  for (let index = 0; index < agentName.length; index += 1) {
    hash = (hash * 31 + agentName.charCodeAt(index)) >>> 0
  }
  return ICON_TONES[hash % ICON_TONES.length]
}
