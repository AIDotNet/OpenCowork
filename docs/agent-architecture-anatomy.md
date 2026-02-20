# OpenCowork Agent 架构解剖

> 本文档深度解析 OpenCowork 的三层 Agent 架构：Agent Loop（核心循环）、SubAgent（子代理）、Team（多智能体协作）。
> 基于源码逐层拆解，覆盖数据流、事件模型、并发控制、上下文压缩等关键机制。

---

## 目录

1. [全局架构总览](#1-全局架构总览)
2. [Agent Loop — 核心循环引擎](#2-agent-loop--核心循环引擎)
3. [SubAgent — 子代理系统](#3-subagent--子代理系统)
4. [Team — 多智能体协作系统](#4-team--多智能体协作系统)
5. [上下文压缩机制](#5-上下文压缩机制)
6. [并发控制模型](#6-并发控制模型)
7. [状态管理与编排层](#7-状态管理与编排层)
8. [完整数据流图](#8-完整数据流图)

---

## 1. 全局架构总览

OpenCowork 的 Agent 系统采用三层嵌套架构，每一层都复用同一个核心循环引擎（`runAgentLoop`），但在权限、生命周期、通信方式上各有不同：

```
┌─────────────────────────────────────────────────────┐
│                    用户 (UI Layer)                    │
│  use-chat-actions.ts — 编排入口                      │
└──────────────┬──────────────────────────────────────┘
               │ sendMessage()
               ▼
┌─────────────────────────────────────────────────────┐
│              Agent Loop (主循环)                      │
│  agent-loop.ts — AsyncGenerator<AgentEvent>          │
│  拥有全部工具权限，直接与用户交互                      │
├──────────────┬──────────────────────────────────────┤
│              │ Task tool (同步模式)                   │
│              ▼                                       │
│  ┌───────────────────────────┐                      │
│  │   SubAgent (子代理)        │                      │
│  │   runner.ts — 内嵌循环     │                      │
│  │   受限工具集，结果回传父级   │                      │
│  └───────────────────────────┘                      │
├──────────────┬──────────────────────────────────────┤
│              │ Task tool (run_in_background=true)    │
│              ▼                                       │
│  ┌───────────────────────────────────────────┐      │
│  │   Team (多智能体协作)                       │      │
│  │   teammate-runner.ts — 独立循环             │      │
│  │   并行执行，事件总线通信                     │      │
│  │   ┌─────────┐ ┌─────────┐ ┌─────────┐    │      │
│  │   │Worker-1 │ │Worker-2 │ │Worker-N │    │      │
│  │   └─────────┘ └─────────┘ └─────────┘    │      │
│  └───────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────┘
```

关键设计原则：
- **统一循环引擎**：三层都调用 `runAgentLoop()`，保证行为一致性
- **事件驱动**：所有层级通过 `AgentEvent` / `SubAgentEvent` / `TeamEvent` 解耦
- **权限隔离**：SubAgent 受限工具集，Teammate 排除团队管理工具
- **并发门控**：`ConcurrencyLimiter` 信号量控制并行度（最多 2 个）

---

## 2. Agent Loop — 核心循环引擎

> 源码位置：`src/renderer/src/lib/agent/agent-loop.ts`

### 2.1 核心签名

```typescript
async function* runAgentLoop(
  messages: UnifiedMessage[],
  config: AgentLoopConfig,
  toolCtx: ToolContext,
  onApprovalNeeded?: (tc: ToolCallState) => Promise<boolean>
): AsyncGenerator<AgentEvent>
```

这是一个 **AsyncGenerator**，每次 `yield` 一个 `AgentEvent`，UI 层通过 `for await` 消费事件并更新界面。这种设计让循环引擎与 UI 完全解耦——引擎只管产出事件，UI 只管消费渲染。

### 2.2 执行流程

每一轮迭代（iteration）的完整流程：

```
┌──────────────────────────────────────────────────────┐
│                   迭代开始                             │
│  1. 上下文管理（压缩检查）                              │
│  2. 消息队列排空（注入 teammate 消息）                   │
│  3. 发送到 LLM（带重试，最多 3 次）                     │
│  4. 流式解析响应                                       │
│     ├─ text_delta → 累积文本                           │
│     ├─ thinking_delta → 累积思考                       │
│     ├─ tool_call_start → 开始流式工具参数               │
│     ├─ tool_call_delta → 增量解析参数（partial-json）   │
│     └─ tool_call_end → 完成工具调用块                   │
│  5. 无工具调用 → yield loop_end, return                 │
│  6. 有工具调用 → 逐个执行                               │
│     ├─ 需要审批 → yield approval_needed, 等待用户       │
│     ├─ 用户拒绝 → 记录 "Permission denied"             │
│     └─ 执行工具 → yield tool_call_result               │
│  7. 工具结果作为 user message 追加到对话                 │
│  8. yield iteration_end → 回到步骤 1                   │
└──────────────────────────────────────────────────────┘
```

### 2.3 AgentLoopConfig 配置

```typescript
interface AgentLoopConfig {
  maxIterations: number        // ≤0 表示无限迭代
  provider: ProviderConfig     // API 提供商配置
  tools: ToolDefinition[]      // 可用工具定义
  systemPrompt: string         // 系统提示词
  workingFolder?: string       // 工作目录
  signal: AbortSignal          // 中止信号
  messageQueue?: MessageQueue  // 消息注入队列（Team 用）
  contextCompression?: {       // 上下文压缩配置
    config: CompressionConfig
    compressFn: (messages: UnifiedMessage[]) => Promise<UnifiedMessage[]>
  }
  forceApproval?: boolean      // 强制所有工具需审批（插件自动回复用）
}
```

关键点：
- `messageQueue` 是 Team 系统的核心通信管道，允许在迭代间隙注入外部消息
- `forceApproval` 用于插件自动回复场景，确保安全性
- `maxIterations ≤ 0` 表示无限循环，Teammate 默认使用此模式

### 2.4 AgentEvent 事件体系

Agent Loop 产出的事件是一个判别联合类型（Discriminated Union）：

| 事件类型 | 触发时机 | 携带数据 |
|---------|---------|---------|
| `loop_start` | 循环启动 | — |
| `iteration_start` | 每轮迭代开始 | `iteration` 序号 |
| `text_delta` | LLM 流式输出文本 | `text` 增量文本 |
| `thinking_delta` | LLM 流式输出思考 | `thinking` 增量思考 |
| `tool_use_streaming_start` | 工具调用开始流式 | `toolCallId`, `toolName` |
| `tool_use_args_delta` | 工具参数增量 | `toolCallId`, `partialInput` |
| `tool_use_generated` | 工具调用完整生成 | `toolUseBlock` |
| `tool_call_start` | 工具开始执行 | `toolCall` (status=running) |
| `tool_call_approval_needed` | 工具需要用户审批 | `toolCall` (status=pending_approval) |
| `tool_call_result` | 工具执行完成 | `toolCall` (含 output/error) |
| `iteration_end` | 迭代结束 | `stopReason`, `toolResults` |
| `message_end` | LLM 响应结束 | `usage` (token 用量), `timing` |
| `loop_end` | 循环结束 | `reason`: completed/max_iterations/aborted/error |
| `context_compression_start` | 开始压缩上下文 | — |
| `context_compressed` | 压缩完成 | `originalCount`, `newCount` |
| `request_debug` | 调试信息 | `debugInfo` |
| `error` | 错误 | `error` |

### 2.5 工具调用状态机

每个工具调用经历以下状态流转：

```
streaming → pending_approval → running → completed
                │                          │
                └──── (用户拒绝) ──→ error ←┘
```

```typescript
type ToolCallStatus = 'streaming' | 'pending_approval' | 'running' | 'completed' | 'error'

interface ToolCallState {
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolCallStatus
  output?: ToolResultContent
  error?: string
  requiresApproval: boolean
  startedAt?: number
  completedAt?: number
}
```

### 2.6 重试与容错

LLM 请求失败时的重试策略：

- **最多 3 次重试**（`MAX_PROVIDER_RETRIES = 3`）
- **指数退避**：基础延迟 1.5s，`delay = 1500ms × 2^attempt`
- **429 (Rate Limit)**：更激进的退避 `1500ms × 2^(attempt+1)`
- **4xx 客户端错误**：不重试（返回 null）
- **5xx 服务端错误**：标准指数退避
- **部分流式后失败**：固定 1.5s 延迟
- 所有延迟都支持 `AbortSignal` 中断

### 2.7 流式工具参数解析

Agent Loop 使用 `partial-json` 库实时解析不完整的 JSON 参数，让 UI 能在工具参数还在流式传输时就开始渲染预览。对 `Write` 工具还有专门的宽松解析器（`parseWriteInputLoosely`），能从不完整 JSON 中提取 `file_path` 和 `content` 字段。

### 2.8 MessageQueue — 迭代间消息注入

```typescript
class MessageQueue {
  private pending: UnifiedMessage[] = []
  push(msg: UnifiedMessage): void    // 外部推入消息
  drain(): UnifiedMessage[]           // 循环排空所有待处理消息
  get size(): number
}
```

这是 Team 系统的关键基础设施。Teammate 之间的消息通过 `teamEvents` 事件总线路由到目标 Teammate 的 `MessageQueue`，在下一次迭代开始前被注入到对话历史中。这实现了 **迭代边界消息注入** —— 消息不会打断正在进行的 LLM 调用，而是在两轮迭代之间自然地融入对话。

---

## 3. SubAgent — 子代理系统

> 源码位置：`src/renderer/src/lib/agent/sub-agents/`

SubAgent 是 Agent Loop 的轻量级派生——主循环通过 `Task` 工具同步调用一个受限的内嵌循环，等待其完成后将结果作为工具输出返回。

### 3.1 系统组成

```
sub-agents/
├── registry.ts      # SubAgent 注册表（名称 → 定义）
├── runner.ts        # SubAgent 执行器（内嵌 agent loop）
├── create-tool.ts   # 创建统一的 Task 工具
├── types.ts         # SubAgentEvent / SubAgentDefinition / SubAgentResult
├── events.ts        # SubAgent 事件发射器
└── builtin/
    └── index.ts     # 注册内置 SubAgent（从 .md 文件加载）
```

### 3.2 SubAgent 定义

每个 SubAgent 由一个 `.md` 文件定义（位于 `resources/agents/`），解析后生成 `SubAgentDefinition`：

```typescript
interface SubAgentDefinition {
  name: string              // 如 "CodeSearch", "CodeReview"
  description: string       // 描述（嵌入到 Task 工具说明中）
  systemPrompt: string      // 专属系统提示词
  allowedTools: string[]    // 允许使用的工具白名单
  maxIterations: number     // 最大迭代次数
  model?: string            // 可选模型覆盖
  temperature?: number      // 可选温度覆盖
  formatOutput?: (result: SubAgentResult) => string  // 可选输出格式化
}
```

内置 SubAgent：

| 名称 | 用途 | 允许工具 | 最大迭代 |
|------|------|---------|---------|
| `CodeSearch` | 代码搜索与探索 | Read, Glob, Grep, LS | 受限 |
| `CodeReview` | 代码审查 | Read, Glob, Grep, LS | 受限 |
| `Planner` | 复杂任务规划 | Read, Glob, Grep, LS | 受限 |
| `CronAgent` | 定时任务管理 | Cron 相关工具 | 受限 |

### 3.3 注册表模式

```typescript
// registry.ts — 全局单例
class SubAgentRegistry {
  private agents = new Map<string, SubAgentDefinition>()

  register(def: SubAgentDefinition): void
  get(name: string): SubAgentDefinition | undefined
  getAll(): SubAgentDefinition[]
}

export const subAgentRegistry = new SubAgentRegistry()
```

注册发生在应用启动时（`App.tsx` 中调用 `registerBuiltinSubAgents()`），从 `resources/agents/*.md` 加载定义并注册。

### 3.4 Task 工具 — 统一入口

`create-tool.ts` 创建一个名为 `Task` 的统一工具，它是 SubAgent 和 Team Teammate 的共同入口：

```typescript
function createTaskTool(providerGetter: () => ProviderConfig): ToolHandler
```

Task 工具的 `inputSchema` 包含：
- `subagent_type`: SubAgent 类型（枚举，从注册表动态生成）
- `prompt`: 任务描述
- `description`: 简短描述（3-5 词）
- `run_in_background`: 是否后台运行（Team 模式）
- `name`: Teammate 名称（后台模式必填）
- `model`: 可选模型覆盖
- `task_id`: 可选任务 ID（后台模式）

**分发逻辑**：
```
Task tool execute()
  ├─ run_in_background=true → executeBackgroundTeammate()  [Team 模式]
  └─ run_in_background=false → runSubAgent()               [SubAgent 模式]
```

### 3.5 SubAgent Runner — 执行器

> 源码位置：`sub-agents/runner.ts`

```typescript
async function runSubAgent(config: SubAgentRunConfig): Promise<SubAgentResult>
```

执行流程：

1. **创建内部 AbortController**：链接到父级 signal，父级中止时子级立即中止
2. **构建受限工具集**：从全局注册表过滤，只保留 `allowedTools` + `Skill`
3. **构建 Provider 配置**：继承父级配置，可覆盖 model/temperature
4. **格式化输入消息**：将 `input` 转为自然语言 `UnifiedMessage`
5. **调用 `runAgentLoop()`**：使用内嵌配置运行循环
6. **事件转发**：将内部 `AgentEvent` 转换为 `SubAgentEvent` 并发射
7. **返回结果**：`SubAgentResult` 包含 output、toolCallCount、iterations、usage

**工具审批策略**：
- 只读工具（Read, LS, Glob, Grep, TaskList, TaskGet, Skill）→ **自动批准**
- 写入工具 → **冒泡到父级** 的 `onApprovalNeeded` 回调

### 3.6 SubAgent 事件体系

```typescript
type SubAgentEvent =
  | { type: 'sub_agent_start'; subAgentName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'sub_agent_iteration'; subAgentName: string; toolUseId: string; iteration: number }
  | { type: 'sub_agent_tool_call'; subAgentName: string; toolUseId: string; toolCall: ToolCallState }
  | { type: 'sub_agent_text_delta'; subAgentName: string; toolUseId: string; text: string }
  | { type: 'sub_agent_end'; subAgentName: string; toolUseId: string; result: SubAgentResult }
```

事件通过 `subAgentEvents` 全局发射器广播，`agent-store` 订阅这些事件来跟踪 SubAgent 的生命周期状态。

### 3.7 元数据嵌入

SubAgent 的输出会嵌入 HTML 注释格式的元数据，用于历史记录的 UI 渲染：

```
<!--subagent-meta:{"iterations":3,"elapsed":5200,"usage":{...},"toolCalls":[...]}-->
实际输出内容...
```

`parseSubAgentMeta()` 函数可以从输出字符串中提取这些元数据，让 UI 在回顾历史时能展示 SubAgent 的执行统计。

---

## 4. Team — 多智能体协作系统

> 源码位置：`src/renderer/src/lib/agent/teams/`

Team 是 OpenCowork 最复杂也最核心的设计。它实现了一个 **Lead Agent + N Teammate Agents** 的多智能体协作模型，所有 Agent 共享同一个代码库，通过事件总线和消息队列进行通信。

### 4.1 系统组成

```
teams/
├── types.ts              # TeamMember, TeamTask, TeamMessage, TeamEvent
├── events.ts             # teamEvents 全局事件发射器
├── register.ts           # 注册所有 Team 工具 + 事件订阅
├── teammate-runner.ts    # Teammate 独立循环管理
└── tools/
    ├── team-create.ts    # 创建团队
    ├── team-delete.ts    # 解散团队
    ├── team-status.ts    # 查询团队状态
    ├── send-message.ts   # 智能体间通信
    ├── task-create.ts    # 创建任务
    ├── task-update.ts    # 更新任务状态
    └── task-list.ts      # 列出任务
```

### 4.2 角色模型

```
┌─────────────────────────────────────────────────┐
│                  Lead Agent                      │
│  (主循环 Agent Loop，拥有全部工具权限)             │
│                                                  │
│  职责：                                           │
│  · 理解用户需求，拆解为任务                        │
│  · 创建团队 (TeamCreate)                          │
│  · 创建任务 (TaskCreate) 并定义依赖关系            │
│  · 派遣 Teammate (Task + run_in_background)       │
│  · 接收 Teammate 报告，综合汇报给用户              │
│  · 解散团队 (TeamDelete)                          │
└────────┬────────────────────────────────────────┘
         │ 派遣 + 消息
         ▼
┌─────────────────────────────────────────────────┐
│              Teammate Agents (N个)               │
│  (独立 Agent Loop，受限工具集)                    │
│                                                  │
│  职责：                                           │
│  · 执行分配的单个任务                              │
│  · 使用工具完成工作（读写文件、搜索等）             │
│  · 通过 TaskUpdate 提交完成报告                    │
│  · 通过 SendMessage 与 Lead 或其他 Teammate 通信   │
│                                                  │
│  限制：                                           │
│  · 不能使用 TeamCreate / TeamDelete / TaskCreate  │
│  · 只读工具自动批准，写入工具需审批                 │
│  · 完成任务后自动停止                              │
└─────────────────────────────────────────────────┘
```

### 4.3 Team 生命周期

```
1. TeamCreate
   Lead 调用 TeamCreate(name, description)
   → teamEvents.emit({ type: 'team_start' })
   → team-store 创建 activeTeam
   → UI 自动切换到 Team 面板

2. TaskCreate (可多次)
   Lead 调用 TaskCreate(subject, description, dependsOn?)
   → teamEvents.emit({ type: 'team_task_add', task })
   → 任务进入 pending 状态
   → 支持依赖关系：dependsOn 指定前置任务 ID

3. Task(run_in_background=true) — 派遣 Teammate
   Lead 调用 Task(name, prompt, run_in_background=true, task_id?)
   → executeBackgroundTeammate()
   → 创建 TeamMember，emit team_member_add
   → 如有 task_id，立即标记任务为 in_progress
   → 通过 ConcurrencyLimiter 获取并发槽位
   → 启动 runTeammate() — fire-and-forget

4. Teammate 执行
   → runSingleTaskLoop() 运行独立 Agent Loop
   → 迭代间检查 shutdown 请求和任务完成状态
   → 完成后 emit team_member_update(status=stopped)

5. 自动通知 Lead
   → Teammate 完成后 emitCompletionMessage()
   → 通过 teamEvents 发送 team_message(to=lead)
   → Lead 的 drainLeadMessages() 被触发
   → Lead 自动开始新一轮迭代处理报告

6. 框架调度器自动派遣
   → Teammate 完成释放并发槽位后
   → scheduleNextTask() 自动查找下一个可执行任务
   → 自动创建新 Teammate 并派遣

7. TeamDelete
   Lead 调用 TeamDelete()
   → abortAllTeammates() 中止所有运行中的 Teammate
   → clearPendingApprovals() 清理审批队列
   → removeTeamLimiter() 清理并发限制器
   → teamEvents.emit({ type: 'team_end' })
```

### 4.4 数据模型

#### TeamMember

```typescript
interface TeamMember {
  id: string
  name: string                    // 如 "worker-a3x9"
  model: string                   // "default" 或具体模型名
  status: TeamMemberStatus        // 'working' | 'idle' | 'waiting' | 'stopped'
  currentTaskId: string | null    // 当前执行的任务 ID
  iteration: number               // 当前迭代序号
  toolCalls: ToolCallState[]      // 已执行的工具调用
  streamingText: string           // 当前流式输出文本
  startedAt: number
  completedAt: number | null
  usage?: TokenUsage              // 累计 token 用量
}
```

状态流转：`idle` → `waiting`（并发槽满时）→ `working` → `stopped`

#### TeamTask

```typescript
interface TeamTask {
  id: string
  subject: string                 // 任务标题
  description: string             // 详细描述
  status: TeamTaskStatus          // 'pending' | 'in_progress' | 'completed'
  owner: string | null            // 执行者名称
  dependsOn: string[]             // 前置依赖任务 ID 列表
  activeForm?: string             // 进行时描述（UI 展示用）
  report?: string                 // Teammate 提交的完成报告
}
```

任务调度规则：
- `pending` + 无 owner + 所有 `dependsOn` 已 completed → 可被认领
- `findNextClaimableTask()` 按顺序遍历，返回第一个满足条件的任务

#### TeamMessage

```typescript
interface TeamMessage {
  id: string
  from: string                    // 发送者名称
  to: string | 'all'             // 接收者名称或 'all'（广播）
  type: TeamMessageType           // 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response'
  content: string
  summary?: string                // 简短摘要
  timestamp: number
}
```

消息类型：
- `message`：点对点消息
- `broadcast`：广播给所有成员
- `shutdown_request`：请求优雅关闭（完成当前迭代后停止）
- `shutdown_response`：确认关闭

### 4.5 事件总线 — teamEvents

```typescript
// events.ts
type TeamEvent =
  | { type: 'team_start'; teamName: string; description: string }
  | { type: 'team_member_add'; member: TeamMember }
  | { type: 'team_member_update'; memberId: string; patch: Partial<TeamMember> }
  | { type: 'team_member_remove'; memberId: string }
  | { type: 'team_task_add'; task: TeamTask }
  | { type: 'team_task_update'; taskId: string; patch: Partial<TeamTask> }
  | { type: 'team_message'; message: TeamMessage }
  | { type: 'team_end' }
```

`teamEvents` 是一个全局事件发射器单例，所有 Team 相关的状态变更都通过它广播。订阅者包括：
- **team-store**：更新 Zustand 状态
- **Teammate MessageQueue**：接收目标消息并注入到 Agent Loop
- **Lead auto-trigger**：`drainLeadMessages()` 监听发给 lead 的消息

### 4.6 Teammate Runner — 独立循环管理

> 源码位置：`teams/teammate-runner.ts`

#### 生命周期管理

```typescript
// AbortController 注册表 — 每个 Teammate 一个
const teammateAbortControllers = new Map<string, AbortController>()

// 优雅关闭注册表
const teammateShutdownRequested = new Set<string>()

// 公开 API
function abortTeammate(memberId: string): boolean      // 硬停止
function abortAllTeammates(): void                      // 全部硬停止
function requestTeammateShutdown(memberId: string): void // 优雅关闭
function isTeammateRunning(memberId: string): boolean
```

两种停止方式：
- **硬停止**（`abortTeammate`）：立即中止 AbortController，Agent Loop 在下一个 `signal.aborted` 检查点退出
- **优雅关闭**（`requestTeammateShutdown`）：设置标记，Teammate 在当前迭代完成后检查标记并停止

#### runTeammate() 执行流程

```typescript
async function runTeammate(options: RunTeammateOptions): Promise<void>
```

1. 创建 AbortController 并注册
2. 过滤工具集：排除 `TeamCreate`, `TeamDelete`, `TaskCreate`（Lead 专属）
3. 创建 MessageQueue 并订阅 teamEvents（接收发给自己的消息）
4. 如果没有分配任务，尝试 `findNextClaimableTask()` 自动认领
5. 调用 `runSingleTaskLoop()` 执行单个任务
6. 完成后清理资源（AbortController、事件订阅）
7. 如果不是被中止的，发送完成报告给 Lead（`emitCompletionMessage`）

#### Teammate 系统提示词

`buildTeammateSystemPrompt()` 为每个 Teammate 生成专属提示词，包含：
- 身份声明（名称、团队名）
- 分配的任务信息（ID、标题、描述）
- 工作目录
- 协作规则（只修改相关文件、用 TaskUpdate 提交报告、用 SendMessage 通信）
- 报告格式要求（必须通过 TaskUpdate 提交，不要写文件）

#### 流式文本节流

Teammate 的 `text_delta` 事件更新使用 200ms 节流（`STREAM_THROTTLE_MS`），避免高频 store 更新导致 UI 卡顿：

```typescript
// 累积 delta，每 200ms 刷新一次到 team-store
streamingText += event.text
streamDirty = true
if (!streamTimer) {
  streamTimer = setTimeout(flushStreamingText, STREAM_THROTTLE_MS)
}
```

#### 自动完成检测

Teammate 在每次迭代开始时检查当前任务是否已被标记为 `completed`（可能是 Teammate 自己在上一轮通过 TaskUpdate 完成的）。如果已完成，立即停止循环，避免无意义的额外迭代。

### 4.7 框架级任务调度器

> 源码位置：`sub-agents/create-tool.ts` 中的 `scheduleNextTask()`

这是 Team 系统的自动化核心。当一个 Teammate 完成任务释放并发槽位后，调度器自动查找下一个可执行的待处理任务并派遣新的 Teammate：

```typescript
function scheduleNextTask(teamName: string): void {
  // 1. 检查团队是否还存在
  // 2. 检查是否有空闲并发槽位 (activeCount < 2)
  // 3. findNextClaimableTask() 查找可执行任务
  // 4. 创建新 TeamMember
  // 5. 认领任务（同步，防止竞态）
  // 6. limiter.acquire() → runTeammate() → release → 递归调用 scheduleNextTask()
}
```

调用链：`runTeammate().finally(() → limiter.release() → scheduleNextTask())`

这形成了一个 **自驱动的任务消费循环**：只要有待处理任务和空闲槽位，就会持续派遣新 Teammate。

### 4.8 Lead Agent 自动触发机制

> 源码位置：`hooks/use-chat-actions.ts`

当 Teammate 完成任务并发送报告给 Lead 时，Lead 需要自动"醒来"处理这些报告。这通过 `drainLeadMessages()` 实现：

```
Teammate 完成
  → emitCompletionMessage(to='lead')
  → teamEvents.emit({ type: 'team_message', message })
  → ensureTeamLeadListener() 捕获
  → 800ms 防抖（合并多个 Teammate 同时完成的报告）
  → drainLeadMessages()
  → 收集所有发给 lead 的未处理消息
  → 作为 user message 注入主循环
  → 触发 Lead 新一轮 sendMessage()
  → Lead 处理报告，可能派遣更多 Teammate 或汇总给用户
```

安全限制：`MAX_AUTO_TRIGGERS = 10`，防止无限循环。

---

## 5. 上下文压缩机制

> 源码位置：`src/renderer/src/lib/agent/context-compression.ts`

随着 Agent Loop 迭代次数增加，对话历史会不断膨胀。上下文压缩机制在 token 用量接近模型上限时自动触发，分两级处理。

### 5.1 双阈值触发

```typescript
interface CompressionConfig {
  enabled: boolean
  contextLength: number           // 模型最大上下文 token 数
  threshold: number               // 全量压缩阈值（默认 0.8）
  preCompressThreshold?: number   // 预压缩阈值（默认 0.65）
}
```

```
Token 使用率:  0%  ──────── 65% ──────── 80% ──────── 100%
                              │              │
                         预压缩触发       全量压缩触发
                      (无 API 调用)     (调用 LLM 摘要)
```

检查发生在每轮迭代开始时（步骤 1），基于上一轮 LLM 返回的 `inputTokens`。

### 5.2 预压缩（Pre-Compression）

触发条件：`0.65 ≤ token使用率 < 0.8`

**零 API 调用**的轻量级清理：
- 保留最近 6 条消息不动（`TOOL_RESULT_KEEP_RECENT = 6`）
- 对更早的消息：
  - 超过 200 字符的 `tool_result` → 替换为占位符 `[已清理的工具结果]`
  - 所有 `thinking` 块 → 替换为占位符 `[已清理的思考过程]`

效果：大幅减少 token 数，但保留对话结构和最近的完整上下文。

### 5.3 全量压缩（Full Compression）

触发条件：`token使用率 ≥ 0.8`

采用 **三区保护** 策略：

```
┌──────────────────────────────────────────────────┐
│  Zone A: 原始任务消息                              │
│  用户的第一条真实消息，永远保留                      │
│  (跳过纯 tool_result 和 team 来源的消息)           │
├──────────────────────────────────────────────────┤
│  压缩区: 中间历史                                  │
│  序列化为文本 → 调用 LLM 生成结构化摘要             │
│  摘要替换原始消息                                   │
├──────────────────────────────────────────────────┤
│  Zone B: 最近 N 条消息                             │
│  完整保留，N = clamp(总数/5, 4, 10)               │
│  边界调整：确保不切断 tool_use/tool_result 配对     │
└──────────────────────────────────────────────────┘
```

#### 边界清理（findCleanBoundary）

Zone B 的起始位置需要精心选择，不能切断工具调用配对：

```typescript
function findCleanBoundary(messages, initialStart, minStart): number {
  // 1. 收集候选 Zone B 内所有 tool_use ID
  // 2. 检查是否有 tool_result 引用了 Zone B 外的 tool_use
  // 3. 如果有孤立引用，向前扩展 2 条消息（一对 tool_use + tool_result）
  // 4. 最多重试 20 次
}
```

#### 孤立块清理（sanitizeOrphanedToolBlocks）

压缩后可能出现 `tool_use` 没有对应 `tool_result`（或反过来）的情况，API 会拒绝这种不配对的请求。清理器将孤立块转换为普通文本块：

- 孤立 `tool_use` → `[之前的工具调用: {name}({input})]`
- 孤立 `tool_result` → `[之前的工具结果: {content}]`

#### 固定上下文注入

压缩时支持 `pinnedContext`（如 Plan 模式的计划内容），作为不可压缩的固定消息插入在摘要之前，确保关键上下文在多次压缩后依然存活。

---

## 6. 并发控制模型

> 源码位置：`src/renderer/src/lib/agent/concurrency-limiter.ts`

### 6.1 ConcurrencyLimiter — 信号量模式

```typescript
class ConcurrencyLimiter {
  private maxConcurrent: number
  private _activeCount: number = 0
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

  constructor(maxConcurrent: number)

  get activeCount(): number

  async acquire(signal?: AbortSignal): Promise<void>  // 获取槽位，满则排队
  release(): void                                      // 释放槽位，唤醒队首
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>  // 便捷方法
}
```

这是一个经典的异步信号量实现：
- `acquire()` 如果有空闲槽位立即返回，否则创建 Promise 排队等待
- `release()` 释放一个槽位，如果队列非空则唤醒队首的等待者
- 支持 `AbortSignal`：等待中的 acquire 可以被中止

### 6.2 并发限制器的使用场景

系统中有两类并发限制器：

| 限制器 | 位置 | 最大并发 | 用途 |
|--------|------|---------|------|
| `subAgentLimiter` | `create-tool.ts` 全局 | 2 | 控制同步 SubAgent 并发 |
| Per-team limiter | `teamContexts` Map | 2 | 控制每个 Team 的 Teammate 并发 |

```typescript
// 全局 SubAgent 限制器
const subAgentLimiter = new ConcurrencyLimiter(2)

// 每个 Team 独立的限制器
const teamContexts = new Map<string, TeamContext>()
// TeamContext = { limiter: ConcurrencyLimiter(2), workingFolder?: string }
```

为什么限制为 2？这是在并行效率和资源消耗（API 调用、内存、token 成本）之间的平衡点。

### 6.3 Team 并发调度流程

```
Lead 派遣 Teammate-A (task-1)
  → limiter.acquire() [slot 1/2]
  → runTeammate() 开始

Lead 派遣 Teammate-B (task-2)
  → limiter.acquire() [slot 2/2]
  → runTeammate() 开始

Lead 派遣 Teammate-C (task-3)
  → limiter.acquire() [排队等待...]
  → TeamMember.status = 'waiting'

Teammate-A 完成
  → limiter.release() [slot 1/2 释放]
  → 队列中的 Teammate-C 被唤醒
  → scheduleNextTask() 检查更多待处理任务
```

---

## 7. 状态管理与编排层

### 7.1 agent-store — Agent 运行时状态

> 源码位置：`src/renderer/src/stores/agent-store.ts`

使用 Zustand + Immer + Persist，管理所有 Agent 相关的运行时状态：

```typescript
// 核心状态字段
{
  isRunning: boolean                          // 主循环是否运行中
  pendingToolCalls: ToolCallState[]           // 待审批的工具调用
  executedToolCalls: Map<sessionId, ToolCallState[]>  // 已执行的工具调用（按会话）
  runningSessions: Set<string>                // 运行中的会话 ID
  activeSubAgents: Map<id, SubAgentState>     // 活跃的 SubAgent
  completedSubAgents: SubAgentState[]         // 已完成的 SubAgent
  subAgentHistory: Map<toolUseId, SubAgentState>  // SubAgent 历史（用于 UI 回顾）
  backgroundProcesses: Map<id, BackgroundProcess>  // 后台进程
  approvedToolNames: string[]                 // 本会话已批准的工具名称
}
```

#### 审批流程

```typescript
// 请求审批 — 返回 Promise<boolean>，UI 渲染 PermissionDialog
requestApproval(toolCallId: string): Promise<boolean>

// 解决审批 — PermissionDialog 中用户点击允许/拒绝
resolveApproval(toolCallId: string, approved: boolean): void
```

实现原理：`requestApproval` 创建一个 Promise 并将其 `resolve` 函数存入 Map，`resolveApproval` 从 Map 取出 resolve 并调用。这是一个优雅的 **Promise-based 审批门** 模式。

#### 工具批准记忆

用户批准某个工具后，该工具名称被加入 `approvedToolNames`。同一会话内后续调用同名工具时自动批准，避免重复弹窗。

### 7.2 team-store — Team 运行时状态

> 源码位置：`src/renderer/src/stores/team-store.ts`

```typescript
{
  activeTeam: {
    name: string
    description: string
    members: TeamMember[]       // 所有 Teammate
    tasks: TeamTask[]           // 任务板
    messages: TeamMessage[]     // 消息历史
  } | null
}
```

team-store 通过订阅 `teamEvents` 来更新状态（在 `register.ts` 中建立订阅）。所有 Team 工具都通过 `teamEvents.emit()` 间接更新 store，而不是直接操作 store，保证了单向数据流。

### 7.3 use-chat-actions — 编排入口

> 源码位置：`src/renderer/src/hooks/use-chat-actions.ts`

这是连接一切的编排层，`sendMessage()` 函数是整个系统的入口：

```
sendMessage(content, sessionId)
  │
  ├─ 模式判断
  │   ├─ chat 模式 → 简单 API 调用，无工具
  │   └─ cowork/code 模式 → Agent Loop + 工具
  │
  ├─ 构建 Provider 配置
  │   ├─ 从 provider-store 获取活跃配置
  │   ├─ 动态注册插件工具和 MCP 工具
  │   └─ 构建系统提示词
  │
  ├─ 启动 Agent Loop
  │   └─ for await (event of runAgentLoop(...))
  │       ├─ text_delta → 16ms 节流缓冲 → 更新 UI
  │       ├─ tool_call_approval_needed → agent-store.requestApproval()
  │       ├─ tool_call_result → 更新 chat-store
  │       ├─ iteration_end → 持久化到 SQLite
  │       └─ loop_end → 清理状态
  │
  └─ Team Lead 自动触发
      └─ ensureTeamLeadListener()
          → 监听 teamEvents 中发给 lead 的消息
          → 800ms 防抖
          → drainLeadMessages()
          → 递归调用 sendMessage()
```

#### 流式文本缓冲

主循环的 `text_delta` 使用 16ms 缓冲（约一帧），合并高频 delta 为批量更新：

```typescript
const DELTA_BUFFER_INTERVAL = 16  // ms

// 累积 delta 文本
deltaBuffer += event.text

// 16ms 定时器触发时一次性刷新
if (!deltaFlushTimer) {
  deltaFlushTimer = setTimeout(() => {
    // 批量更新到 chat-store
    flushDeltaBuffer()
  }, DELTA_BUFFER_INTERVAL)
}
```

#### Per-Session Abort

每个会话有独立的 AbortController，支持同时运行多个会话的 Agent Loop 并独立中止：

```typescript
const sessionAbortControllers = new Map<string, AbortController>()
```

---

## 8. 完整数据流图

### 8.1 单次 Agent Loop 数据流

```
用户输入
  │
  ▼
use-chat-actions.sendMessage()
  │
  ├─ 构建 messages[], config, toolCtx
  │
  ▼
runAgentLoop(messages, config, toolCtx, onApproval)
  │
  │  ┌─────────── 迭代循环 ───────────┐
  │  │                                 │
  │  │  [上下文压缩检查]                │
  │  │      │                          │
  │  │  [MessageQueue.drain()]         │
  │  │      │                          │
  │  │  [发送到 LLM Provider]           │
  │  │      │                          │
  │  │      ▼                          │
  │  │  Stream Events                  │
  │  │  ├─ text_delta ──→ UI 渲染      │
  │  │  ├─ thinking_delta ──→ UI 渲染  │
  │  │  └─ tool_call_end ──→ 工具执行   │
  │  │      │                          │
  │  │      ▼                          │
  │  │  toolRegistry.execute()         │
  │  │      │                          │
  │  │      ▼                          │
  │  │  tool_result → user message     │
  │  │      │                          │
  │  │      └──────→ 下一轮迭代 ───────┘
  │  │
  │  └─ 无工具调用 → loop_end
  │
  ▼
UI 更新 + SQLite 持久化
```

### 8.2 Team 协作完整数据流

```
用户: "分析这个项目的所有模块"
  │
  ▼
Lead Agent Loop (主循环)
  │
  ├─ 1. TeamCreate("analysis-team", "项目分析团队")
  │     → teamEvents → team-store → UI Team 面板
  │
  ├─ 2. TaskCreate("分析模块A", "...", dependsOn=[])
  │     TaskCreate("分析模块B", "...", dependsOn=[])
  │     TaskCreate("汇总报告", "...", dependsOn=["task-A", "task-B"])
  │     → teamEvents → team-store.tasks[]
  │
  ├─ 3. Task(name="analyst-1", prompt="...", run_in_background=true, task_id="task-A")
  │     Task(name="analyst-2", prompt="...", run_in_background=true, task_id="task-B")
  │     │
  │     ├─→ executeBackgroundTeammate()
  │     │     → teamEvents(team_member_add)
  │     │     → limiter.acquire()
  │     │     → runTeammate() [fire-and-forget]
  │     │
  │     └─→ Lead 输出状态摘要，结束当前 turn
  │
  │  ┌──── 并行执行 ────────────────────────────┐
  │  │                                           │
  │  │  analyst-1 (Agent Loop)                   │
  │  │  ├─ Read, Glob, Grep...                   │
  │  │  ├─ TaskUpdate(task-A, completed, report)  │
  │  │  └─ emitCompletionMessage(to=lead)         │
  │  │       │                                    │
  │  │  analyst-2 (Agent Loop)                    │
  │  │  ├─ Read, Glob, Grep...                    │
  │  │  ├─ TaskUpdate(task-B, completed, report)   │
  │  │  └─ emitCompletionMessage(to=lead)          │
  │  │       │                                     │
  │  └───────┼─────────────────────────────────────┘
  │          │
  │          ▼
  │  teamEvents(team_message, to=lead)
  │          │
  │          ▼
  │  ensureTeamLeadListener() 捕获
  │          │
  │          ▼ (800ms 防抖，合并两个报告)
  │  drainLeadMessages()
  │          │
  │          ▼
  │  sendMessage([analyst-1 报告, analyst-2 报告])
  │          │
  │          ▼
  ├─ 4. Lead 自动醒来，处理两份报告
  │     │
  │     ├─ 检测到 "汇总报告" 任务的依赖已满足
  │     │
  │     ▼
  │  scheduleNextTask() 自动派遣
  │     → 创建 worker-xxxx
  │     → 认领 "汇总报告" 任务
  │     → runTeammate()
  │     │
  │     ▼
  │  worker-xxxx 完成汇总
  │     → emitCompletionMessage(to=lead)
  │     │
  │     ▼
  ├─ 5. Lead 再次醒来，收到汇总报告
  │     → TeamDelete() 解散团队
  │     → 向用户输出最终结果
  │
  ▼
用户看到完整的项目分析报告
```

### 8.3 三层架构对比总结

| 维度 | Agent Loop (主循环) | SubAgent (子代理) | Team Teammate |
|------|-------------------|------------------|---------------|
| 调用方式 | `sendMessage()` 直接启动 | `Task` 工具同步调用 | `Task(run_in_background)` 异步 |
| 生命周期 | 与用户会话绑定 | 单次工具调用内 | 独立，完成任务后停止 |
| 工具权限 | 全部工具 | `allowedTools` 白名单 + Skill | 全部工具 - Lead 专属工具 |
| 迭代限制 | 由配置决定 | `definition.maxIterations` | 无限（`maxIterations=0`） |
| 通信方式 | 直接与用户交互 | 结果回传父级 | MessageQueue + teamEvents |
| 并发控制 | 单线程 | `subAgentLimiter` (max 2) | Per-team limiter (max 2) |
| 上下文压缩 | 支持 | 不支持（生命周期短） | 不支持（独立短对话） |
| 审批策略 | `onApprovalNeeded` 回调 | 只读自动批准，写入冒泡 | 只读自动批准，写入冒泡到 UI |
| 状态存储 | agent-store + chat-store | agent-store.subAgentHistory | team-store |
| 中止方式 | Per-session AbortController | 链接父级 signal | 独立 AbortController + 优雅关闭 |

---

## 附录：关键源码文件索引

| 文件路径 | 职责 |
|---------|------|
| `src/renderer/src/lib/agent/agent-loop.ts` | 核心循环引擎 |
| `src/renderer/src/lib/agent/types.ts` | AgentEvent, ToolCallState, MessageQueue, AgentLoopConfig |
| `src/renderer/src/lib/agent/tool-registry.ts` | 全局工具注册表 |
| `src/renderer/src/lib/agent/system-prompt.ts` | 动态系统提示词构建 |
| `src/renderer/src/lib/agent/context-compression.ts` | 上下文压缩（预压缩 + 全量压缩） |
| `src/renderer/src/lib/agent/concurrency-limiter.ts` | 异步信号量并发控制 |
| `src/renderer/src/lib/agent/sub-agents/registry.ts` | SubAgent 注册表 |
| `src/renderer/src/lib/agent/sub-agents/runner.ts` | SubAgent 执行器 |
| `src/renderer/src/lib/agent/sub-agents/create-tool.ts` | Task 工具创建 + 框架调度器 |
| `src/renderer/src/lib/agent/sub-agents/types.ts` | SubAgent 类型定义 |
| `src/renderer/src/lib/agent/sub-agents/events.ts` | SubAgent 事件发射器 |
| `src/renderer/src/lib/agent/sub-agents/builtin/index.ts` | 内置 SubAgent 注册 |
| `src/renderer/src/lib/agent/teams/types.ts` | Team 类型定义 |
| `src/renderer/src/lib/agent/teams/events.ts` | Team 事件发射器 |
| `src/renderer/src/lib/agent/teams/register.ts` | Team 工具注册 + 事件订阅 |
| `src/renderer/src/lib/agent/teams/teammate-runner.ts` | Teammate 独立循环管理 |
| `src/renderer/src/lib/agent/teams/tools/*.ts` | Team 工具实现 |
| `src/renderer/src/stores/agent-store.ts` | Agent 运行时状态 |
| `src/renderer/src/stores/team-store.ts` | Team 运行时状态 |
| `src/renderer/src/hooks/use-chat-actions.ts` | 编排入口 |
| `src/renderer/src/lib/tools/tool-types.ts` | ToolHandler, ToolContext 接口 |
| `resources/agents/*.md` | 内置 SubAgent 定义文件 |

