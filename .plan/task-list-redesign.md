# TaskList 工具与任务管理提示词改造方案

## 目标

解决 Agent 生成的会话任务列表长期偏简单、粒度粗、建完不再演进的问题。当前现象的成因不在模型侧,而在三处设计约束:

1. 没有批量写入能力,创建 N 个任务需要 N 次串行工具调用,且每次返回全量列表,token 成本约为 O(n²);
2. 任务在存储层只能是一个字符串,`description` 永远为空,工具描述还主动要求模型把细节压进标题;
3. `<task_management>` 提示词只有 6 行、0 示例,没有粒度标准和触发边界。

本阶段目标是移除这三处抑制,并修掉过程中发现的两个真实 bug,使模型在同等能力下能够产出可执行、可演进的任务列表。

不追求重构任务板 UI、不改动 Plan / Goal / 子 Agent 的职责划分。

## 问题诊断(已核实)

| 编号 | 问题 | 位置 |
| --- | --- | --- |
| P1 | 无批量写入工具;Worker 工具调用串行执行,并行分支只对子 Agent `Task` 开放 | `OpenAIChatRuntime.cs:1274-1287` |
| P2 | 每次 `TaskCreate` / `TaskUpdate` 返回全量任务快照,且 `title` 与 `subject` 同值写两遍 | `AgentRuntimeTaskExecutor.cs:502-532` |
| P3 | `Description` 硬编码为空;`description` 入参被 `MergeTaskTitle` 拼进标题 | `AgentRuntimeTaskExecutor.cs:59`、`609-628` |
| P4 | 工具描述要求"标题里带足够细节,不需要单独描述" | `todo-tool.ts:23-24`、`80` |
| P5 | `<task_management>` 仅 6 行指令,无示例、无粒度标准、无"同轮开始执行" | `agent-system-prompt.ts:484-495` |
| P6 | 每轮 `<system-reminder>` 只注入任务计数,不含标题和 in_progress 归属 | `dynamic-context.ts:154-167` |
| B1 | `NormalizeStatus` 只放行 `pending` / `in_progress` / `completed`,`blocked` 与 `in_review` 写入后读回被静默降级为 `pending`,而系统提示词和 schema 都在要求模型使用这两个状态 | `AgentRuntimeTaskExecutor.cs:795-798` vs `agent-system-prompt.ts:491`、`todo-tool.ts:89` |
| B2 | 三份工具定义漂移;hosted 路径的 `TaskCreate` 无属性描述、无 `required`,`TaskUpdate` 缺 `activeForm` / `owner` / `addBlocks` / `addBlockedBy`,该路径下模型无法表达任务依赖 | `session-tool-catalog.ts:173-215` vs `todo-tool.ts` vs `cli/src/runtime/worker-session.ts:293-340` |

### 关键约束:工具返回值不能简单精简

`TodoCard.tsx` 的 `parseTaskSnapshot` 直接解析工具结果 JSON,并且**优先使用工具结果快照,live store 只是回退**:

```171:175:src/renderer/src/components/chat/TodoCard.tsx
  // Prefer the tool-result snapshot; fall back to whichever live store has data.
  const liveTasks: TaskItem[] = liveStandaloneTasks.length > 0 ? liveStandaloneTasks : liveTeamTasks
  const [expanded, setExpanded] = React.useState(false)
  const snapshot = React.useMemo(() => parseTaskSnapshot(output), [output])
  const tasks: TaskItem[] = snapshot?.tasks ?? liveTasks
```

第 188-190 行还专门为"live store 里查不到"的情况做了输入合成回退,说明 Worker 写入的任务并没有可靠地同步进渲染进程的 `useTaskStore`(`task_add` 事件由 `task-store.ts:265` 的渲染进程自身创建路径发出,Worker 侧 C# 代码中不存在 `task_add`)。

因此**不能先精简返回体**,否则聊天流里的任务卡片会退化。这一约束直接决定了方案取批量写入而非精简返回:批量写入把 N 次全量回显降为 1 次,在不动 UI 契约的前提下就消除了 O(n²)。

### 关键决策:扩展 `TaskCreate` 入参,不新增工具名

新增一个 `TaskWrite` 工具名需要同步注册到至少 9 处:

- `src/shared/session-mode-tools.ts`(模式白名单)
- `src/shared/agent-runtime-v2.ts`(`LOCAL_MUTATION_TOOLS`)
- `src/renderer/src/lib/tools/todo-tool.ts`
- `src/main/ipc/agent-runtime/session-tool-catalog.ts`
- `cli/src/runtime/worker-session.ts`
- `AgentRuntimeTaskExecutor.cs` 的 `TaskToolNames`
- `AgentRuntimeTeamExecutor.cs`(团队路由对等)
- UI:`ToolCallCard.tsx`、`tool-call-summary.ts`、`execution-outline.ts`、`TodoCard.tsx`
- i18n:16 个语言的 `chat.json`

代价与收益不匹配。**改为让 `TaskCreate` 同时接受单个对象和数组**:工具名不变,上述 9 处注册全部无需改动,UI 卡片、CLI 展示、审批策略、模式白名单自动继承。

## 保持不变的架构约束

- Native Worker 仍是唯一 Agent Loop、Provider、Tool、Permission 与持久化权威;不在 Main 或 Renderer 侧执行任务工具。
- 不新增运行时协议命令/查询/事件,因此不触发 `src/shared/runtime-contracts/model.ts` 与 `npm run contracts:gen`。
- 不修改 Worker HTTP/SSE/Job 协议。
- `tasks` 表继续走 `ensureColumn` 增量演进,不删列、不加迁移文件。
- 不改变 `TaskGet` / `TaskList` 的既有返回结构,只做增量补充。
- 不改变 Plan(`EnterPlanMode` / `ExitPlanMode`)、Goal、子 Agent `Task` 三者的现有职责边界。
- 不改动 `cli/src/vendor/*` 生成文件。
- 团队模式(`AgentRuntimeTeamExecutor`)与独立会话模式的行为差异保持现状,只做入参对等。

## 实施步骤

### 1. 建立可度量的基线

改造前必须先有判据,否则无法判断提示词改动是否生效。在固定的 3 个提示上分别用两个 Provider 各跑 3 次,记录:

- 单次列表的任务条数;
- 任务标题的平均字符数与是否含动词短语;
- 是否出现 `blocked` / `in_review` 状态;
- 是否使用了 `addBlocks` / `addBlockedBy`;
- 建列表后是否在同一轮开始执行第一项;
- 建列表消耗的工具调用次数与总 token。

三个提示建议覆盖:跨多文件的重构类、需要先调研再动手的排查类、明确列出 5 个以上子需求的实现类。

基线数据落到本方案同目录的 `task-list-baseline.md`,不进版本库正文。

### 2. 修复状态词表(B1)

`NormalizeStatus` 放行全部六个状态:

```csharp
return status is "pending" or "in_progress" or "blocked" or "in_review" or "completed"
    ? status
    : "pending";
```

`deleted` 不进入该函数(删除走 `DeleteTaskAndReferences`),不需要放行。

连带检查读回链路上其它状态收窄点:

- `TaskItem['status']` 的联合类型定义(`src/renderer/src/stores/task-store.ts`);
- `TodoCard.tsx:197-200` 的 `fallbackFocusedTask` 只识别三个状态,需补齐;
- CLI `cli/src/components/task-list.tsx` 的状态渲染;
- 16 个语言 `chat.json` 中任务状态标签是否已有 `blocked` / `in_review` 文案,缺失则补 `t('key', { defaultValue: 'English text' })`。

这一步独立可验证:设 `blocked` 后 `TaskGet` 应返回 `blocked`。

### 3. 收敛三份工具定义(B2)

在 `src/shared/` 新增 `task-tool-definitions.ts`,导出四个工具的单一权威定义(名称、描述、JSON schema),然后:

- `src/renderer/src/lib/tools/todo-tool.ts` 从共享定义构造 `ToolHandler`,`execute` 保留现有 native-only 报错;
- `src/main/ipc/agent-runtime/session-tool-catalog.ts` 直接引用共享定义,删除本地内联的弱化版本;
- `cli/src/runtime/worker-session.ts` 引用 vendored 副本。`cli/scripts/sync-shared.mjs` 的 `SHARED_FILES` 是显式清单而非通配,必须新增一条 entry;该脚本的 `--check` 模式会在副本过期时失败,CLI 构建前会自动执行。

共享定义以现有 `todo-tool.ts` 版本为基准(描述最完整),并补上 hosted 版本独有的 `subject` / `task_id` 别名以保持向后兼容。

此步骤本身不改变桌面交互路径的模型可见内容,但让 hosted 与 CLI 路径立即获得完整 schema——单独这一项就可能显著改善非桌面路径的任务质量。

### 4. `TaskCreate` 支持批量提交(P1、P2)

schema 增加 `tasks` 数组入参,与现有单任务字段互斥:

```ts
tasks: {
  type: 'array',
  description:
    'Create the whole list in one call. Prefer this over repeated single-task calls: ' +
    'one batch call is cheaper and keeps the list ordered as written.',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      activeForm: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'in_progress'] },
      metadata: { type: 'object' }
    },
    required: ['title']
  }
}
```

`AgentRuntimeTaskExecutor.ExecuteCreate` 相应改造:

- 若存在 `tasks` 数组则批量插入,**在同一个事务内**基于一次 `CountSessionTasks` 递增 `SortOrder`,保证写入顺序等于模型给出的顺序;
- 单任务入参走现有路径,行为不变;
- 允许批次内首项带 `status: 'in_progress'`,以支持"建列表并立刻开工";
- 返回体只回显一次全量列表(沿用 `WriteStandaloneSummary`,满足 `TodoCard` 的解析契约),并补 `created_ids` 数组便于模型后续 `TaskUpdate`。

`WriteTaskSnapshot` 中 `title` / `subject` 的重复输出暂不删除:`TodoCard.getTaskTitle` 优先读 `title` 因此安全,但 `cli/src/components/task-list.tsx`、`StepsPanel.tsx`、`TasksPage.tsx` 等消费方需逐个确认后再移除,留到后续阶段。

团队模式的 `AgentRuntimeTeamExecutor` 同步支持 `tasks` 数组,避免两条路径入参不对等。

### 5. 重写 `<task_management>` 提示词(P5)

替换 `agent-system-prompt.ts:484-495` 的整段。新版本必须包含:

- **触发与不触发各 3 条以上具体场景**,而非仅 "3+ steps or multiple files";
- **质量标准**:每条任务是可独立验证的动作,含动词与对象;不写 "分析代码" 这类无完成判据的条目;不把一次工具调用拆成一条任务;
- **批量优先**:一次 `TaskCreate` 提交整份列表,不要循环单条创建;
- **同轮开工**:首项设为 `in_progress` 并在同一轮工具批次中开始执行,不要建完列表就结束回合;
- **单一 in_progress** 约束;
- **完整六状态语义**,含 `blocked` / `in_review` 的使用时机;
- **至少 3 个 worked example**,每个含用户请求、生成的列表、以及一行选择理由。示例是控制输出形态最有效的手段,当前完全缺失。

同时消除 "Use Task tools" 的指代歧义——该措辞同时可指任务清单族与子 Agent `Task` 工具。改为显式列出 `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`。

补充 Cowork 与 ACP 模式的衔接:`agent-system-prompt.ts:244` 现为 "If a task has multiple parts, decompose it and track progress",未提工具名,改为指向具体工具。

注意 `task-store.ts:262` 在创建任务时会调用 `clearSessionPromptSnapshot`,提示词变长会增加 prefix 重建频率,需确认 `canReuseSessionPromptPrefix` 的缓存命中率没有明显下降。

### 6. 每轮提醒注入真实任务内容(P6)

`dynamic-context.ts:154-167` 改为输出紧凑列表而非计数:

```text
- Task List (7):
  1. [completed] 抽出 CliState 纯状态模块
  2. [in_progress] 把 UiEvent 投影迁进 reducer   <- current
  3. [pending] 收敛 Overlay 优先级
  ...
```

要点:

- 明确标出当前 `in_progress` 项,这是模型判断"接着做什么"的唯一依据;
- 已完成项折叠为计数或只保留最近若干条,控制 token;
- 单条标题按字符数截断;
- 总量超过阈值(建议 15 条)时退回摘要 + 提示调用 `TaskList`。

参照紧邻的 plan 提醒(第 171 行已注入 `plan.title`),保持格式一致。

Hosted 路径需确认是否有对等的提醒注入点;若没有,本阶段先只改渲染进程路径,并在方案中记录该差异。

### 7. `description` 字段决策(P3、P4)

两个方向,取其一,不要两者都做:

**方案 A(推荐):让 `description` 成为独立字段。** `ExecuteCreate` 写入真实 `description`,移除 `MergeTaskTitle` 的拼接行为(保留函数用于 `TaskUpdate` 的旧调用兼容),工具描述改为"标题写一句可验证的动作,细节放 description"。`tasks` 表已有 `description` 列,无需 schema 变更。需要同步 `TodoCard` / `StepsPanel` / `TasksPage` / CLI 的展示,决定 description 是否在列表里展开。

**方案 B:承认任务就是一行文本。** 从 `TaskCreate` / `TaskUpdate` schema 中移除 `description`,删掉 "no separate description is needed" 的措辞(该措辞在实现上是自相矛盾的:它要求模型压缩,而压缩后的内容又被拼接成更长的标题)。

方案 A 让任务列表具备承载细节的能力,是解决"列表过于简单"的结构性前提;方案 B 只是消除误导。如果本轮只想低风险验证提示词效果,可先做 B,把 A 留到后续阶段。

### 8. 验证

代码门槛:

- `npm run typecheck`
- `npm run lint`
- `npm run cli:test`(改动 CLI 工具定义后必须先 `build`)
- `npm run verify:architecture`(新增 `src/shared/task-tool-definitions.ts` 会引入新的导入边界)
- 不需要 `npm run contracts:check`,本方案不改运行时协议;若最终仍改动了 `runtime-contracts/model.ts` 则必须补上

Worker 侧需重新发布后再验证:批量创建、`blocked` 状态读回、团队模式入参对等。

行为验收(对照第 1 步基线,同样的 3 个提示 × 2 个 Provider × 3 次):

- 任务条数中位数显著上升,且条目具备可验证的完成判据;
- 建整份列表的工具调用次数从 N 降为 1;
- 建列表的总 token 明显下降(消除 O(n²) 回显);
- 出现 `blocked` / `in_review` 的使用,且 `TaskGet` 读回一致;
- 建列表后同一轮开始执行首项;
- 后续轮次出现对已有任务的细化或拆分(验证第 6 步是否打通了演进路径);
- hosted 与 CLI 路径的列表质量与桌面路径拉平;
- 聊天流任务卡片、Steps 面板、任务板、CLI 任务列表渲染无回归。

## 实施后的实测修正

实施过程中有三处与本方案预判不同,记录在此以免后续误判:

1. **渲染层 i18n 不需要改动。** 方案原写「16 个语言 `chat.json` 状态标签」。实测任务状态在桌面端**只有视觉表达**(`TodoCard.StatusDot`、`StepsPanel.TaskStatusIcon`),`chat.json` 的 `todo` 命名空间只有 `tasksDone` / `moreTasks` / `showEarlierTasks` / `showLess`,没有状态文案。真正需要加文案的只有 CLI 的 `hiddenTaskSummary`,即 `cli/src/i18n.ts` 的两个新键(英文走 `defaultValue`,只需补中文)。

2. **`required` 是强制校验的,别名字段则能透传。** `AgentRuntimeToolSchemaValidator` 会拒绝缺少 `required` 属性的调用;而 `PruneAdditionalProperties` 只在 schema 显式设置 `additionalProperties: false` 时才裁剪未声明属性——任务工具没有设置,所以 `subject` / `task_id` 别名无需出现在 schema 里也能到达 executor。因此共享定义采用**规范单名 + 不设 `required`**:既清理了 schema 噪音,又不会让发送 `task_id` 的调用硬失败(旧的 `required: ['taskId']` 反而会)。

3. **方案 A 的展示层已建好一半,但团队路径也需要同样处理。** `StepsPanel` 的 `getSecondaryDescription` + `TaskDescriptionPreview` 已完整实现;`TaskBoardItem` 也已带 `description` 字段。真正缺的是 Worker 侧不再丢弃、三处 `Encode*Result` 补字段、以及 `TodoCard` / 任务板卡片 / CLI 补渲染。另外团队路径有一份**独立的**同类缺陷:`AgentRuntimeTeamRuntimeStore.CreateTask` 也把 `description` 硬编码为空,且其 `ResolveTaskTitle` 同样拼接标题,已一并修复。

**hosted 路径的已知差异:** hosted session 装配链路(`agent-session-service-host.ts` / `run-context-assembler.ts`)**没有任何对等的任务提醒注入点**,`buildRuntimeReminder` 只存在于渲染进程。因此第 6 步(注入真实任务标题)目前只对桌面交互路径生效;hosted 路径要获得同样的演进能力,需要单独补一个提醒装配点。

**团队任务的状态差异:** 团队任务仍是三态(`TeamRuntimeTaskStatus`),`blocked` / `in_review` 会被**显式拒绝**(此前是静默 no-op),同时系统提示词在团队激活时会告知模型这一约束并引导改用 `SendMessage` 报告阻塞。把团队任务扩展到五态需要同步改 TS 类型、团队文件持久化和 teammate 生命周期判定,不在本次范围。

## 后续阶段(本次不实施)

1. 建立 Worker → UI 的可靠任务同步(Worker 侧发出任务变更事件,或工具完成后触发 DB 重读),之后才能安全精简工具返回体、去掉 `title` / `subject` 重复输出、并移除 `TodoCard` 的输入合成回退。
2. 支持任务层级(父子/子步骤)。当前 `blocks` / `blockedBy` 只能表达依赖,无法表达分解。
3. 打通 Plan 文件与任务清单:`ExitPlanMode` 审批通过后由计划文件的实施步骤直接物化为任务列表,消除两套规划表述各写一遍的重复。
4. 统一 `title` / `subject` 命名(存储列为 `subject`,工具与结果同时暴露两者),需要评估对既有会话数据的兼容处理。
5. 任务清单工具族与子 Agent `Task` 工具的重命名,消除 `Task*` 前缀歧义。属破坏性变更,需要独立评估。
