# SubAgent Architecture Plan

## Overview

SubAgents are specialized mini-agents that the **main agent** can spawn as tools during its agentic loop. Each SubAgent runs its own inner agent loop with a focused system prompt, a restricted tool set, and returns consolidated results back to the parent agent.

This enables the main agent to delegate complex sub-tasks (codebase search, code review, planning) to purpose-built agents, improving quality and reducing context window waste.

## Architecture

### Core Concept

```
User Message → Main Agent Loop
                  ├── text response
                  ├── tool call (Read, Write, Bash, ...)
                  └── tool call: SubAgent("CodeSearch", { query: "..." })
                        ├── Inner Agent Loop (own system prompt + limited tools)
                        │   ├── Glob → results
                        │   ├── Grep → results
                        │   ├── Read → file contents
                        │   └── text: consolidated findings
                        └── Returns summary to parent as tool_result
```

### Key Design Decisions

1. **SubAgents ARE tools** — The main agent invokes them via `tool_use` blocks, just like any other tool. Each registered SubAgent becomes a tool in the main agent's tool list.

2. **Reuse `runAgentLoop`** — SubAgents run the same `runAgentLoop` AsyncGenerator internally, just with different configs (system prompt, tools, max iterations).

3. **Auto-approve safe tools** — SubAgents auto-approve read-only tools (Read, LS, Glob, Grep). Write tools still require user approval (bubbled up to parent).

4. **Streaming events** — SubAgent inner events are wrapped and yielded to the parent as `sub_agent_event` so the UI can show progress.

5. **Token-efficient** — SubAgent results are summarized before returning to the parent. The full inner conversation is NOT appended to the parent's context.

6. **Separate LLM calls** — SubAgents make their own LLM API calls. They can optionally use a cheaper/faster model than the parent.

## File Structure

```
src/renderer/src/lib/agent/
├── agent-loop.ts              (existing — reused by SubAgents)
├── tool-registry.ts           (existing — SubAgent tools registered here)
├── system-prompt.ts           (existing — extended with SubAgent descriptions)
├── types.ts                   (existing — extended with SubAgent events)
├── sub-agents/
│   ├── types.ts               (SubAgentDefinition, SubAgentConfig, SubAgentResult)
│   ├── registry.ts            (SubAgentRegistry — manages available SubAgents)
│   ├── runner.ts              (runSubAgent — executes inner loop, returns result)
│   ├── create-tool.ts         (creates ToolHandler from SubAgentDefinition)
│   └── builtin/
│       ├── index.ts           (registerBuiltinSubAgents)
│       ├── code-search.ts     (CodeSearch — explores codebase)
│       ├── code-review.ts     (CodeReview — analyzes code quality)
│       └── planner.ts         (Planner — creates structured plans)
```

## Type Definitions

### SubAgentDefinition

```typescript
interface SubAgentDefinition {
  name: string                    // e.g. "CodeSearch"
  description: string             // shown in parent's tool list
  icon?: string                   // for UI display
  systemPrompt: string            // focused system prompt
  allowedTools: string[]          // subset of registered tools, e.g. ["Read", "Glob", "Grep", "LS"]
  maxIterations: number           // typically 5-10
  model?: string                  // optional override (e.g. use cheaper model)
  temperature?: number            // optional override
  inputSchema: ToolInputSchema    // what the parent passes to it
  summarize?: (result: SubAgentResult) => string  // custom result formatter
}
```

### SubAgentConfig (runtime)

```typescript
interface SubAgentConfig {
  definition: SubAgentDefinition
  parentProvider: ProviderConfig   // inherit API key, base URL
  toolContext: ToolContext          // inherit working folder, IPC, signal
  input: Record<string, unknown>   // input from parent tool call
  onEvent?: (event: SubAgentEvent) => void  // progress callback
}
```

### SubAgentResult

```typescript
interface SubAgentResult {
  success: boolean
  output: string                   // final text output (summary)
  toolCallCount: number            // how many tool calls were made
  iterations: number               // how many LLM rounds
  usage: { inputTokens: number; outputTokens: number }  // total token usage
  innerMessages?: UnifiedMessage[] // optionally keep full conversation
}
```

### SubAgentEvent (extends AgentEvent)

```typescript
// New event types added to AgentEvent union:
| { type: 'sub_agent_start'; subAgentName: string; input: Record<string, unknown> }
| { type: 'sub_agent_progress'; subAgentName: string; event: AgentEvent }
| { type: 'sub_agent_end'; subAgentName: string; result: SubAgentResult }
```

## Built-in SubAgents

### 1. CodeSearch

**Purpose**: Explore the codebase to find relevant files and code sections.

- **Allowed Tools**: `Read`, `Glob`, `Grep`, `LS`
- **Max Iterations**: 8
- **System Prompt**: Focused on thorough codebase exploration. Instructed to:
  - Start with `Glob` / `LS` to understand structure
  - Use `Grep` to find relevant code patterns
  - Use `Read` to examine key files
  - Synthesize findings into a structured summary
- **Input Schema**: `{ query: string, scope?: string }`
- **Output**: Structured summary of findings with file paths and relevant code snippets

### 2. CodeReview

**Purpose**: Analyze code for bugs, style issues, and improvement opportunities.

- **Allowed Tools**: `Read`, `Glob`, `Grep`
- **Max Iterations**: 6
- **System Prompt**: Focused on code quality analysis. Instructed to:
  - Read the target file(s)
  - Check for common issues (error handling, edge cases, type safety)
  - Suggest improvements with specific line references
- **Input Schema**: `{ target: string, focus?: "bugs" | "style" | "performance" | "security" | "all" }`
- **Output**: Structured review with severity levels and suggestions

### 3. Planner

**Purpose**: Create detailed implementation plans for complex tasks.

- **Allowed Tools**: `Read`, `Glob`, `Grep`, `LS`
- **Max Iterations**: 6
- **System Prompt**: Focused on planning. Instructed to:
  - Explore the project structure
  - Understand existing patterns and conventions
  - Create a step-by-step plan with file paths and code changes
- **Input Schema**: `{ task: string, constraints?: string }`
- **Output**: Numbered plan with specific file changes

## Runner Implementation

```typescript
// sub-agents/runner.ts (pseudo-code)
async function runSubAgent(config: SubAgentConfig): Promise<SubAgentResult> {
  // 1. Build inner tool registry (subset of parent's tools)
  const innerTools = filterTools(config.definition.allowedTools)

  // 2. Build inner system prompt
  const systemPrompt = config.definition.systemPrompt

  // 3. Build initial message from parent's input
  const userMessage = formatSubAgentInput(config.definition, config.input)

  // 4. Build inner loop config
  const loopConfig: AgentLoopConfig = {
    maxIterations: config.definition.maxIterations,
    provider: {
      ...config.parentProvider,
      model: config.definition.model ?? config.parentProvider.model,
      systemPrompt,
    },
    tools: innerTools,
    signal: config.toolContext.signal,
  }

  // 5. Run inner agent loop
  const loop = runAgentLoop([userMessage], loopConfig, config.toolContext,
    // Auto-approve read-only tools, bubble up write tools
    async (tc) => isReadOnlyTool(tc.name) ? true : /* bubble to parent */
  )

  // 6. Collect results
  let output = ''
  let totalUsage = { inputTokens: 0, outputTokens: 0 }
  let toolCallCount = 0

  for await (const event of loop) {
    config.onEvent?.({ type: 'sub_agent_progress', subAgentName: config.definition.name, event })

    if (event.type === 'text_delta') output += event.text
    if (event.type === 'message_end' && event.usage) {
      totalUsage.inputTokens += event.usage.inputTokens
      totalUsage.outputTokens += event.usage.outputTokens
    }
    if (event.type === 'tool_call_result') toolCallCount++
  }

  // 7. Return consolidated result
  return { success: true, output, toolCallCount, iterations, usage: totalUsage }
}
```

## Tool Integration

Each SubAgent is registered as a tool in the parent's tool registry via `createSubAgentTool()`:

```typescript
function createSubAgentTool(def: SubAgentDefinition): ToolHandler {
  return {
    definition: {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    },
    execute: async (input, ctx) => {
      const result = await runSubAgent({
        definition: def,
        parentProvider: getCurrentProvider(),
        toolContext: ctx,
        input,
      })
      return result.output
    },
    requiresApproval: () => false,  // SubAgents handle approval internally
  }
}
```

## UI Integration

### StepsPanel
- SubAgent execution shown as a collapsible group
- Header: SubAgent name + status icon + elapsed time
- Expanded: nested list of inner tool calls

### ToolCallCard
- SubAgent tool calls render with a special "agent" icon (Brain/Sparkles)
- Expandable to show inner steps

### SkillsPanel
- SubAgents listed in a new "SubAgents" category
- Shows name, description, allowed tools, iteration limit

## Implementation Phases

| Phase | Description | Priority | Effort |
|-------|-------------|----------|--------|
| 1 | Type definitions (`sub-agents/types.ts`) | High | S |
| 2 | SubAgent registry + runner | High | M |
| 3 | SubAgent tool handler (`create-tool.ts`) | High | S |
| 4a | CodeSearch SubAgent | High | M |
| 4b | CodeReview SubAgent | Medium | M |
| 4c | Planner SubAgent | Medium | M |
| 5 | Extend AgentEvent + agent-loop integration | High | M |
| 6 | Extend agent-store for SubAgent state | Medium | S |
| 7 | UI: StepsPanel nested display | Medium | M |
| 8 | UI: ToolCallCard SubAgent variant | Medium | S |
| 9 | UI: SkillsPanel SubAgent listing | Low | S |
| 10 | System prompt updates | Medium | S |
| 11 | Build + TS verify | High | S |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Token cost multiplication | Use cheaper model for SubAgents; limit max iterations |
| Infinite recursion | SubAgents CANNOT spawn other SubAgents |
| Context window overflow | SubAgent conversations are isolated; only summary returns to parent |
| Approval UX confusion | Clear UI distinction between parent and SubAgent approval requests |
| Latency | SubAgents add multiple LLM round-trips; mitigate with fast models + low iteration limits |
