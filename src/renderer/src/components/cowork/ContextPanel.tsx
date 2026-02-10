import { useState } from 'react'
import { Database, FolderOpen, FolderPlus, RefreshCw, MessageSquare, Clock, Cpu, Zap, ExternalLink, Copy, Check, Wrench, Brain, ShieldCheck } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export function ContextPanel(): React.JSX.Element {
  const [copiedPath, setCopiedPath] = useState(false)
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const workingFolder = activeSession?.workingFolder
  const provider = useSettingsStore((s) => s.provider)
  const model = useSettingsStore((s) => s.model)

  const handleSelectFolder = async (): Promise<void> => {
    const result = (await ipcClient.invoke('fs:select-folder')) as {
      canceled?: boolean
      path?: string
    }
    if (!result.canceled && result.path && activeSessionId) {
      useChatStore.getState().setWorkingFolder(activeSessionId, result.path)
    }
  }

  return (
    <div className="space-y-4">
      {/* Working Folder */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Working Folder
        </h4>
        {workingFolder ? (
          <div className="space-y-1.5">
            <button
              className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm text-left hover:bg-muted/50 transition-colors group"
              onClick={() => { navigator.clipboard.writeText(workingFolder!); setCopiedPath(true); setTimeout(() => setCopiedPath(false), 1500) }}
              title="Click to copy path"
            >
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate flex-1">{workingFolder}</span>
              {copiedPath ? <Check className="size-3 shrink-0 text-green-500" /> : <Copy className="size-3 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors" />}
            </button>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 text-[10px] text-muted-foreground"
                onClick={handleSelectFolder}
              >
                <RefreshCw className="size-3" />
                Change Folder
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 text-[10px] text-muted-foreground"
                onClick={() => window.electron.ipcRenderer.invoke('shell:openPath', workingFolder)}
              >
                <ExternalLink className="size-3" />
                Open
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2 text-xs"
            onClick={handleSelectFolder}
          >
            <FolderPlus className="size-3.5" />
            Select Working Folder
          </Button>
        )}
      </div>

      {/* Session Info */}
      {activeSession && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Session Info
            </h4>
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <MessageSquare className="size-3 shrink-0" />
                <span>
                  {activeSession.messages.filter((m) => m.role !== 'system').length} messages
                  <span className="text-muted-foreground/50"> ({activeSession.messages.filter((m) => m.role === 'user').length} turns)</span>
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="size-3 shrink-0" />
                <span>
                  Created {new Date(activeSession.createdAt).toLocaleDateString()}
                  {' · '}
                  {(() => {
                    const mins = Math.floor((Date.now() - activeSession.createdAt) / 60000)
                    if (mins < 1) return 'just now'
                    if (mins < 60) return `${mins}m ago`
                    const hrs = Math.floor(mins / 60)
                    if (hrs < 24) return `${hrs}h ago`
                    return `${Math.floor(hrs / 24)}d ago`
                  })()}
                  {activeSession.messages.length >= 2 && (() => {
                    const first = activeSession.messages[0]?.createdAt
                    const last = activeSession.messages[activeSession.messages.length - 1]?.createdAt
                    if (!first || !last || last <= first) return null
                    const secs = Math.floor((last - first) / 1000)
                    if (secs < 60) return ` · ${secs}s session`
                    const mins = Math.floor(secs / 60)
                    if (mins < 60) return ` · ${mins}m session`
                    return ` · ${Math.floor(mins / 60)}h${mins % 60}m session`
                  })()}
                </span>
              </div>
              {(() => {
                const subAgentNames = new Set(['CodeSearch', 'CodeReview', 'Planner'])
                let toolUseCount = 0
                let subAgentCount = 0
                for (const m of activeSession.messages) {
                  if (Array.isArray(m.content)) {
                    for (const b of m.content) {
                      if (b.type === 'tool_use') {
                        toolUseCount++
                        if (subAgentNames.has(b.name)) subAgentCount++
                      }
                    }
                  }
                }
                return toolUseCount > 0 ? (
                  <>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Wrench className="size-3 shrink-0" />
                      <span>{toolUseCount} tool calls</span>
                    </div>
                    {subAgentCount > 0 && (
                      <div className="flex items-center gap-2 text-violet-500/70">
                        <Brain className="size-3 shrink-0" />
                        <span>{subAgentCount} SubAgent runs</span>
                      </div>
                    )}
                  </>
                ) : null
              })()}
              {(() => {
                const approved = useAgentStore.getState().approvedToolNames
                return approved.length > 0 ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <ShieldCheck className="size-3 shrink-0 text-green-500/60" />
                    <span className="text-muted-foreground/60">
                      Auto-approved: {approved.join(', ')}
                    </span>
                  </div>
                ) : null
              })()}
              <div className="flex items-center gap-2 text-muted-foreground">
                <Cpu className="size-3 shrink-0" />
                <span className="truncate">{model} ({provider})</span>
              </div>
              {(() => {
                const totals = activeSession.messages.reduce(
                  (acc, m) => {
                    if (m.usage) {
                      acc.input += m.usage.inputTokens
                      acc.output += m.usage.outputTokens
                      if (m.usage.cacheCreationTokens) acc.cacheCreation += m.usage.cacheCreationTokens
                      if (m.usage.cacheReadTokens) acc.cacheRead += m.usage.cacheReadTokens
                      if (m.usage.reasoningTokens) acc.reasoning += m.usage.reasoningTokens
                    }
                    return acc
                  },
                  { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, reasoning: 0 }
                )
                if (totals.input + totals.output === 0) return null
                // Pricing per million tokens (USD)
                const pricing: Record<string, { input: number; output: number }> = {
                  'claude-sonnet-4': { input: 3, output: 15 },
                  'claude-opus-4': { input: 15, output: 75 },
                  'claude-3-5-sonnet': { input: 3, output: 15 },
                  'claude-3-5-haiku': { input: 0.8, output: 4 },
                  'gpt-4.1': { input: 2, output: 8 },
                  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
                  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
                  'gpt-4o': { input: 2.5, output: 10 },
                  'gpt-4o-mini': { input: 0.15, output: 0.6 },
                  'o3-mini': { input: 1.1, output: 4.4 },
                  'o3': { input: 2, output: 8 },
                  'o4-mini': { input: 1.1, output: 4.4 },
                }
                // Context window limits (tokens)
                const contextLimits: Record<string, number> = {
                  'claude-sonnet-4': 200000, 'claude-opus-4': 200000,
                  'claude-3-5-sonnet': 200000, 'claude-3-5-haiku': 200000,
                  'gpt-4.1': 1047576, 'gpt-4.1-mini': 1047576, 'gpt-4.1-nano': 1047576,
                  'gpt-4o': 128000, 'gpt-4o-mini': 128000,
                  'o3-mini': 200000, 'o3': 200000, 'o4-mini': 200000,
                }
                const priceKey = Object.keys(pricing).find((k) => model.includes(k))
                const price = priceKey ? pricing[priceKey] : null
                // Anthropic cache pricing: cache_read = 10% of input price, cache_creation = 25% extra
                const hasCache = totals.cacheCreation > 0 || totals.cacheRead > 0
                const cost = price
                  ? hasCache
                    ? ((totals.input - totals.cacheRead) * price.input + totals.cacheRead * price.input * 0.1 + totals.cacheCreation * price.input * 1.25 + totals.output * price.output) / 1_000_000
                    : (totals.input * price.input + totals.output * price.output) / 1_000_000
                  : null
                const ctxKey = Object.keys(contextLimits).find((k) => model.includes(k))
                const ctxLimit = ctxKey ? contextLimits[ctxKey] : null
                const totalTokens = totals.input + totals.output
                const pct = ctxLimit ? Math.min((totalTokens / ctxLimit) * 100, 100) : null
                const barColor = pct === null ? '' : pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-green-500'
                return (
                  <>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Zap className="size-3 shrink-0" />
                      <span>
                        {totalTokens.toLocaleString()} tokens
                        <span className="text-muted-foreground/50"> ({totals.input.toLocaleString()}↓ {totals.output.toLocaleString()}↑)</span>
                        {cost !== null && <span className="text-muted-foreground/50"> · ~${cost < 0.01 ? '<0.01' : cost.toFixed(2)}</span>}
                        {totals.cacheRead > 0 && <span className="text-green-500/60"> · {totals.cacheRead.toLocaleString()} cached</span>}
                        {totals.reasoning > 0 && <span className="text-blue-500/60"> · {totals.reasoning.toLocaleString()} reasoning</span>}
                      </span>
                    </div>
                    {pct !== null && (
                      <div className="mt-1 space-y-0.5">
                        <div className="flex items-center justify-between text-[9px] text-muted-foreground/40">
                          <span>Context window</span>
                          <span>{pct.toFixed(0)}% of {(ctxLimit! / 1000).toFixed(0)}k</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>
        </>
      )}

      {!workingFolder && !activeSession && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Database className="mb-3 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No context loaded</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Select a working folder to give the assistant access to your project
          </p>
        </div>
      )}
    </div>
  )
}
