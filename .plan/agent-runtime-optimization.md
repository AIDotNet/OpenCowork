# Agent Runtime 全链路优化方案

## 目标

修正 Agent Runtime 从用户发消息到运行结束这条链路上的行为缺陷与契约漂移。

核心判断:架构本身是对的——Worker 是唯一 Agent Loop,durable outbox、反向请求、审批这些难做的部分都成立。问题集中在**三层之间的契约漂移**:TypeScript 层向模型和用户承诺的能力(并行工具执行、64K 结果预算、可配并行度、chat 模式工具白名单),Worker 全部没有实现。模型因此在一份与运行时不符的说明书下工作。

本方案按"改动收益 / 耦合度"分五个阶段。阶段 A 全部在 Worker 内部,不动协议,可独立发布验证;阶段 B 到 E 依次向外扩散。每个阶段可单独落地,不要求一次做完。

## 问题诊断(已核实)

| 编号 | 问题 | 位置 |
| --- | --- | --- |
| P1 | `maxParallelTools` 从设置一路传到 Worker,C# 侧从未读取。工具严格串行,唯一例外是相邻子 Agent `Task` 调用 | `session-run-settings.ts:56` → `run-context-assembler.ts:301` → `sidecar-protocol.ts:742`;`OpenAIChatRuntime.cs:1274-1319` |
| P2 | 系统提示词用整节五句话力劝模型并行批量调用,运行时不兑现 | `agent-system-prompt.ts:267-277` |
| P3 | manifest 已为每个工具算好 `parallelClass`(`readParallel`/`resourceSerial`/`globalSerial`/`interactive`)并随 `capabilitySnapshot` 送达 Worker,Worker 只读 `inputSchema` 与 `toolId`,调度元数据全是死的 | `agent-runtime-v2.ts:373-375`;`AgentRuntimeCapabilityPolicy.cs:115-188` |
| P4 | 工具结果统一 16K 字符截断,且 `TruncatePreservingEdges` 保留头 65% + 尾 35%,挖掉中段 | `OpenAIChatRuntime.cs:11-13`、`2610-2631` |
| P5 | `Read` 宣称默认读 2000 行,2000 行代码约 60–80K 字符,实际约 400 行能进上下文;截断标记只报字符总数,不告知丢的是中段,也不给续读指引 | `AgentRuntimeNativeToolExecutor.cs:10`、`642-688` |
| P6 | manifest 三处声明 `resultPolicy: 'bounded-preview-64k'`,实际上限是 16K,4 倍偏差 | `src/shared/agent-runtime-v2.ts:400`、`cli/src/vendor/agent-runtime-v2.ts:403`、`AgentRuntimeSubAgentExecutor.cs:1204` |
| P7 | 交互式运行无迭代上限:两条路径都是 `maxIterations: 0`,Worker 语义下 0 = 无限。cron 是 15,headless 有 30 分钟超时,交互式两者都没有 | `use-chat-actions.ts:2820`、`session-run-settings.ts:63`;`OpenAIChatRuntime.cs:69-70` |
| P8 | 自动压缩 `preserveCount = 0`,摘要替换全部先前上下文,包含模型正在使用的最近工具结果 | `OpenAIChatRuntime.cs:586-601`;`AgentRuntimeContextCompression.cs:118-123` |
| P9 | 上下文溢出识别靠匹配 provider 错误文案字符串,provider 改措辞即静默失效 | `AgentRuntimeContextCompression.cs:227-257` |
| P10 | `filterChatModeToolDefinitions` 与 `CHAT_MODE_CORE_TOOL_NAMES` 已定义并导出,全仓库无调用点。chat 模式实际带完整工具目录,却只有约 367 token 的提示词管着 | `chat-mode-tools.ts:11`、`:86` |
| P11 | chat 模式提示词声称"与其他 agent 模式相同的工具访问权",与实际过滤意图矛盾 | `agent-system-prompt.ts:682` |
| P12 | 核心文件工具有 4 份漂移定义:hosted 目录(最简)、CLI、渲染进程 stub(Grep 有 40+ 参数且 `output_mode`/`outputMode` 并存)、manifest 规范化版本 | `session-tool-catalog.ts:117-158`、`worker-session.ts:196-265`、`search-tool.ts:39-177` |
| P13 | Bash 的 `run_in_background` / `force_foreground` 是假参数:CLI 与渲染进程都暴露,Worker shell 执行器从不读取 | `worker-session.ts:260-261`、`bash-tool.ts:26-37` vs `AgentRuntimeNativeToolExecutor.cs:1035-1041` |
| P14 | `Shell` 是 Worker 认识但任何目录都不暴露的名字;`CronAdd`/`CronCreate`、`CronRemove`/`CronDelete` 两对别名 schema 粗细不同 | `AgentRuntimeNativeToolExecutor.cs:30`;`session-tool-families.ts:137-168` |
| P15 | 渲染进程 `toolRegistry` 的 handler 全是死执行路径,`toolRegistry.execute()` 全仓库零调用点;`codegraph-tool.ts` 注释仍描述已废弃的 bridge 执行方式 | `src/renderer/src/lib/tools/*`;`codegraph-tool.ts:18-23` |
| P16 | Clarify 模式规则重复两到三遍:9 条 bullet 后整段附上 `CLARIFY_CORE_PROMPT`。"提问必须走 AskUserQuestion" 出现 3 次,"必须以 EnterPlanMode→写计划→ExitPlanMode 收尾" 出现 3 次 | `agent-system-prompt.ts:283-295` vs `:140-190` |
| P17 | 跨节矛盾:全局"不清楚就问用户"vs Clarify"禁止在文本里提问";Code"极简输出"vs Cowork"跑命令要解释";用户规则优先级 agent 模式是"高于一切",chat 模式是"除非冲突" | `:503` vs `:158`;`:345` vs `:312`;`:655` vs `:730` |
| P18 | ACP 模式明确"主 Agent 不得写代码改文件",提示词仍带完整 `<making_code_changes>` 与 `<running_commands>` | `:323` vs `:533-550`、`:559-572` |
| P19 | 除任务管理外无任何 worked example。Cowork 的 Plan-Act-Observe、ACP 的委派要求全是抽象描述 | `:41-68` 是唯一有示例的节;`:305-309`、`:324-328` |
| P20 | CLI 另写一份提示词,不 import 共享 builder,硬编码 `sessionPromptMode: 'code'`,桌面端约 3K token 的行为规范一条没有 | `cli/src/runtime/worker-session.ts:988-1024`、`:1133-1134` |
| P21 | 子 Agent `custom` 类型用 C# 里 6 行默认提示词;TS 侧写完整的 `buildDefaultSubAgentSystemPrompt`(2000+ token)从未被 import | `AgentRuntimeSubAgentExecutor.cs:1338-1350`;`default-system-prompt.ts:13-173` |
| P22 | `resources/prompts/` 只有一个 0 字节文件,`loadPrompt()` 无调用点,而 `AGENTS.md` / `CLAUDE.md` 都在描述"每个模式有自己的模板" | `resources/prompts/`;`prompt-loader.ts:6-27` |
| P23 | 提示词前缀缓存在真实 agent 工作中基本不命中:任务与计划的每次变更都清快照,但系统提示词内容不含任务/计划数据(走每轮 `requestContextTexts`),失效是纯空转 | `task-store.ts:262,322,368,432`、`plan-store.ts:278-404`、`use-chat-actions.ts:5989` |
| P24 | `canReuseSessionPromptPrefix` 不比较工具集、`planMode`、`contextCacheKey`,工具集变化时可能复用过期前缀 | `prompt-prefix-pin.ts:4-28` |
| P25 | 协议已备 `contextSource` 让 Worker 自读 DB,只出现在能力探测处,真实请求从不传。Plan 模式 / continue / 图像模型回退到旧路径时每轮重发最多 160 条消息 + 完整工具目录 | `use-chat-actions.ts:3494` vs `:5179`;`hosted-session-run.ts:6-20` |
| P26 | cron 是第三套装配逻辑:自带 `BACKGROUND_TOOL_DEFINITIONS`、自跑 SessionStart hook、在 Main 里自行消费并映射流事件重建 transcript。`headless-auto-reply.ts` 已用共享 `assembleHostedSessionContext`,说明正确做法存在 | `cron-agent-background.ts:846-996`、`:696-714`、`:486-601` |
| P27 | 同一个 run 三份状态追踪,无单一权威,重连靠三处各自 best-effort 对账 | `sidecar-manager.ts:249`、`runtime-registry.ts`、`native-agent-runtime.ts:38` |
| P28 | `sendMessage` 约 2500 行;`:4198` 就把会话标 running,之后仍有 provider 解析、密钥校验、MCP 连接、memory 加载、hook、SSH、工具目录组装等一长串串行 await 才发出请求 | `use-chat-actions.ts:3999` 起 |
| P29 | Worker 崩溃时只有 `jobState === 'running'` 的 run 被注入合成终止事件,停在 `queued` 的 run 不会,UI 永久挂起 | `sidecar-manager.ts:549-554` |
| P30 | `agent:compress-context` 用 `NATIVE_WORKER_NO_TIMEOUT` 无界等待;cron 无整体超时 | `runtime-command-gateway.ts:512`;`cron-agent-background.ts` |
| P31 | `AgentRuntimeCodeGraphExecutor.ExecuteAsync` 完全忽略 `cancellationToken`,长 CodeGraph 操作取消不掉 | `AgentRuntimeCodeGraphExecutor.cs:25-26` |
| P32 | Provider 流中途失败且已输出部分文本时不重试,用户看到截断回复且无自动续接 | `AgentRuntimeProviderRetryPolicy.cs:339-345` |
| P33 | `ReadContextSourceMessages` 在 async 路径上用同步 SQLite,并发下阻塞线程池 | `OpenAIChatRuntime.cs:3388`、`:3412` |
| P34 | WebSearch 无缓存无退避,显式 no-cache,被搜索引擎拦截只能报错;WebFetch 有 4MB 下载上限但 HTML→markdown 后无二次字符上限,只能撞 16K 通用截断 | `AgentRuntimeWebSearchExecutor.cs:115-127`;`AgentRuntimeWebFetchExecutor.cs:12` |

## 保持不变的架构约束

- Native Worker 仍是唯一 Agent Loop、Provider、Tool、Permission、MCP、Plan 与持久化权威。不在 Main / Renderer / CLI 侧迭代 provider 或执行工具。
- 阶段 A 不新增运行时协议命令、查询或事件,因此不触发 `src/shared/runtime-contracts/model.ts` 与 `npm run contracts:gen`。阶段 D 若需新增,按正常流程走生成协议。
- 不修改 Worker HTTP / SSE / Job 协议,不改 `/rpc`、`/events`、`/reverse`、`/cancel` 的语义。
- `AgentStreamEnvelope` 仍是 canonical runtime protocol,`UiEvent` 仍是 CLI 专用投影。
- 不改动 `cli/src/vendor/*` 生成文件,只改共享源再 `cli/scripts/sync-shared.mjs` 同步。
- SQLite 继续走 `ensureColumn` 增量演进,不删列、不加迁移文件。
- Native AOT 约束不变:Worker JSON 走 `WorkerJsonContext`,HTTP handler 保持 `HttpContext` + `Utf8JsonWriter`,不引入运行时反射。
- 不改变审批语义:deny > allow/whitelist > dialog 的优先级、`forceApproval` 的逃生舱、反向请求的 11 分钟超时都保持现状。
- 不合并 hosted 与 legacy 双路径。阶段 D 只是让 legacy 路径停止全量重传,不删除它。

---

## 阶段 A:运行时行为修正

四项全部在 `sidecars/OpenCowork.Native.Worker/` 内部,互不耦合,不动协议。收益最高,应先做。

> **实施状态:A1、A2 已完成**(覆盖 P1–P6)。A3、A4 未开始。
>
> 与本方案原文的两处偏离:
>
> 1. 没有给 `AgentRuntimeToolAuthorization` 增加 `ParallelClass` 字段。只有分组阶段需要这个信息,`ExecuteSingleToolCallAsync` 用不到,为单一调用点扩展类型不划算。改为只新增独立的 `AgentRuntimeCapabilityPolicy.ResolveParallelClass`。
> 2. A2 顺带解决了 P6。`ToolResultMaxChars` 从 16K 提到 64K,与 manifest 声明的 `bounded-preview-64k` 及 Glob/Grep 自己的 64K 预算对齐——原先 16K 的全局上限把这些per-tool 预算全部覆盖掉了。`ToolResultTextBlockMaxChars` 同比例从 12K 提到 48K(保持 75% 占比)。

### A1. 工具并行执行(P1、P2、P3)

调度所需的信息已经在请求里了——`capabilitySnapshot.authorizedTools[].parallelClass`,两条路径都带(hosted 经 `run-context-assembler.ts:268`,legacy 经渲染进程 `buildCapabilitySnapshot`)。缺的只是 Worker 侧的消费。

**第一步:让 authorization 携带并行分类。**

`AgentRuntimeToolAuthorization` 是 record,加两个字段即可:

```csharp
internal sealed record AgentRuntimeToolAuthorization(
    bool Authorized,
    bool Visible,
    JsonElement? InputSchema,
    string? ToolId,
    string? DefinitionHash,
    string? ErrorCode,
    string? ErrorMessage,
    string? ParallelClass = null);
```

`ResolveV2` 从 manifest 读 `parallelClass` 填入(`AgentRuntimeCapabilityPolicy.cs:180-187` 的成功返回处)。`ResolveLegacy` 保持 `null`——没有 manifest 就没有分类,按串行处理,这是安全的降级方向。

**第二步:加一个廉价的分组查询。**

`Resolve` 会做 schema 校验并 `schema.Clone()`,不适合在分组阶段对每个调用跑一遍。新增一个只扫 `wireName` 读 `parallelClass` 的静态方法:

```csharp
public static string? ResolveParallelClass(JsonElement parameters, string toolName)
```

不做 schema 校验、不 clone、不分配。分组用它,`ExecuteSingleToolCallAsync` 内部的 `Resolve` 调用完全不动。

**第三步:泛化 `ExecuteToolCallsAsync` 的分块逻辑。**

`OpenAIChatRuntime.cs:1274-1319` 现在的结构已经是"识别可并行块 → 并行执行 → 否则单个串行",只需把块的判定条件从"相邻 Task 调用"扩展为"相邻同类可并行调用":

- `readParallel` 相邻块 → 并行执行,并发度取 `min(blockLength, maxParallelTools)`,用 `SemaphoreSlim` 限流
- 现有的相邻 `Task` 块 → 保持不变(它有自己的 `AgentRuntimeSubAgentConcurrencyGate`,不受 `maxParallelTools` 管)
- `resourceSerial` / `globalSerial` / `interactive` / 分类未知 → 串行,行为与今天完全一致

`maxParallelTools` 从 `JsonHelpers.GetInt(parameters, "maxParallelTools", 1)` 读取,clamp 到 1–16,与 TS 侧 `session-run-settings.ts:56` 的范围一致。**默认值必须是 1**:参数缺失时退回今天的串行行为,不能让老 host 意外获得并行。

**必须保持的不变量:**

- `toolResults` 的追加顺序必须等于模型给出的 tool_call 顺序,与完成顺序无关。现有 `ExecuteParallelSubAgentTaskBlockAsync` 的 `Task.WhenAll` + `results.Select(...)` 已经满足,直接复用同一形状。
- `ShouldStop` 语义不变:块内任一结果要求停止则跳出循环,块内先完成的结果已提交(与今天 Task 块行为一致)。
- 取消传播:每个并行分支都拿 `state.CancellationToken`,不新建 linked token。

**为什么 `readParallel` 是安全的起点:**

`REPLAY_SAFE_TOOLS`(`agent-runtime-v2.ts:150-165`)共 14 个:`Glob`、`Grep`、`LS`、`MemoryList`、`MemoryRead`、`MemorySearch`、`Read`、`TaskGet`、`TaskList`、`TeamStatus`、`WebFetch`、`WebSearch`、`codegraph_explore`、`get_goal`。

三个已核实的安全性质:

1. **无审批交织。** 这批工具在权限策略里全部不需要审批(`AgentRuntimeNativeToolExecutor.cs:346-351` 等),所以并行块内不会出现多个反向审批请求互相打断。
2. **事件发射线程安全。** `state.NextSeq()` 用 `Interlocked.Increment`(`AgentRuntimeTools.cs:637-640`),且现有 Task 并行块已经在并发调用 `EmitAsync`。
3. **读历史线程安全。** `RecordRead` 在 `lock (ReadSnapshotsByScope)` 内写入(`AgentRuntimeNativeToolExecutor.cs:1893-1902`),并行 Read 不会破坏 read-before-write 校验所依赖的快照表。

`WebFetch` 另有自己的 8 并发闸门(`AgentRuntimeWebFetchExecutor.cs:15`),两层限流叠加无害。

**验证:**

- 提示 "读 X、Y、Z 三个文件",确认三个 `tool_use_generated` 事件后三次执行重叠(看 Worker 日志时间戳),总耗时接近单次而非三次之和。
- 混合批次 `Read + Write + Read`,确认 Write 前后不并行,结果顺序仍与调用顺序一致。
- `maxParallelToolCalls` 设为 1,确认退回全串行。
- 渲染进程与 CLI 的工具卡片在乱序完成下仍正确归位(两侧都按 tool id 索引,应无回归,但需实测)。
- 审批场景:`readParallel` 块中混入需审批工具时不进并行块。

**风险:** 并行块内多个工具同时失败时的错误聚合。现有 `ExecuteSingleToolCallAsync` 已把每个失败转成工具结果而非抛异常,聚合行为自然正确,但需要构造用例确认。

### A2. Read 结果截断改为按行、只截尾(P4、P5、P6)

现在 `ReadAsync` 返回带行号的整串(`AgentRuntimeNativeToolExecutor.cs:674-686`),然后落到通用的 `LimitToolResultContent` 字符串分支,被 `TruncatePreservingEdges` 挖掉中段。这是正确性问题:模型认为完整读过文件,实际拿到头尾拼接版,随后基于它做 Edit。read-before-write 校验比对磁盘内容,拦不住"读残了"。

**改动:**

在 `ReadAsync` 内部就完成预算控制,让通用截断永不触发:

- 累加字符数,超预算时在**行边界**停止,只丢尾部
- 结尾追加明确的续读指引,写清实际读到第几行、文件共几行、如何继续,例如 `[truncated at line 412 of 1893; continue with offset=413]`
- 预算独立于 `ToolResultMaxChars`,单独命名常量(建议 `ReadResultMaxChars`),取值需要与 `resultPolicy` 声明一致

**同时对齐 P6:** 三处 `resultPolicy: 'bounded-preview-64k'` 要么改成与实际常量一致的值,要么把 `ToolResultMaxChars` 提到 64K。倾向后者——16K 对编码 agent 偏紧,Grep/Glob 自己的预算已经是 64K(`AgentRuntimeNativeToolExecutor.cs:15-16`),通用上限比单工具上限还小是反的。三处需同改:`src/shared/agent-runtime-v2.ts:400`、`cli/src/vendor/agent-runtime-v2.ts:403`(经 sync 脚本)、`AgentRuntimeSubAgentExecutor.cs:1204`。

**保留通用截断作为兜底**,只是不再让 Read 依赖它。中段挖空的 `TruncatePreservingEdges` 对 shell 输出仍合理(头是命令回显、尾是错误),对文件内容不合理。

**验证:** 读一个 3000 行文件,确认返回在行边界结束、含续读指引、按 offset 续读能拿到接续内容且无重叠丢失。

### A3. 自动压缩保留最近上下文(P8)

`preserveCount = 0` 是显式设计,但它让压缩发生在最坏时刻:长任务中途,模型手里正攥着刚读的文件和刚跑的测试结果,一次压缩全变成摘要。

**改动:**

- `OpenAIChatRuntime.cs:588` 的 `const int preserveCount = 0` 改为从压缩配置读取,默认保留最近若干轮(建议 4–8 条消息,或按 token 预算保留窗口末段的 10–15%)
- `ReadLoopCompressionConfig`(`:498-524`)增加该字段解析
- 手动压缩(`agent/compress-context`)的默认值单独决定:用户主动压缩时更激进是合理的,但也不应为 0
- `AgentRuntimeContextCompression.CompressMessagesAsync` 的签名已有 `preserveCount` 参数(`:110`),`FindSafeBoundary` 已保证不切开 tool_use/tool_result 对,无需改动内部逻辑
- 更新 `:118-123` 的 "Zero-preserve semantics" 注释,否则注释会与代码矛盾

TS 侧若要暴露为设置项,加在 `src/shared/context-compression-config.ts`(已有 `clampCompressionThreshold`,同处加 clamp helper),并在 `session-run-settings.ts` 读取。本阶段也可以先只在 Worker 内用常量默认值,不动设置面板。

**验证:** 构造超长会话触发自动压缩,确认压缩后最近若干轮仍是原文、tool_use/tool_result 配对完整、模型能继续原任务而不重新摸索。

### A4. 交互式运行迭代上限(P7)

`maxIterations: 0` 在两条交互路径上都是硬编码:`use-chat-actions.ts:2820`(注释明确写 "0 => unlimited")和 `session-run-settings.ts:63`(不读设置)。Worker 侧 `hasIterationLimit = requestedMaxIterations > 0`(`OpenAIChatRuntime.cs:69-70`)。cron 是 15,headless 有 30 分钟超时,交互式两者皆无。

**改动:**

- 给交互式运行一个宽松但存在的上限。200 轮是个合理起点:正常任务远达不到,跑飞能刹住。两处都要改,否则 hosted 与 legacy 行为不一致。
- 子 Agent 默认 1000 轮(`AgentRuntimeSubAgentExecutor.cs:11`)降到同量级。
- 接近上限时(例如剩余 20%)通过 `<system-reminder>` 提示模型收敛并汇报进展,而不是撞到上限硬停。这一条依赖 Worker 侧的每轮上下文注入点(`OpenAIChatRuntime.cs:2864` 附近),不需要经渲染进程。
- `loop_end` 的 `max_iterations` 原因已有 16 语言文案(`chat.json` / `layout.json` 的 `maxIterations` 键),UI 不需要改。

**验证:** 人为构造循环(例如让模型反复 Edit 一个校验总失败的文件),确认在上限处以 `max_iterations` 收尾且 UI 正确展示,而非无限跑。

---

## 阶段 B:契约收敛

目标是让模型看到的说明书与运行时一致。改动分散但每处都小。

### B1. 工具定义单一来源(P12、P15)

现状是同一个工具四份定义,而渲染进程那份的执行路径已经死了(`toolRegistry.execute()` 零调用点)。

`src/shared/task-tool-definitions.ts` 已经证明了模式可行——任务工具族已收敛,`session-tool-catalog.ts:7` 与 `cli/src/runtime/worker-session.ts:8` 都从共享定义构造。按同样方式处理核心文件工具族:

- 在 `src/shared/` 新增核心工具定义模块,以三份中最完整的描述为基准(渲染进程的 Write 描述与 CLI 的 Glob/LS/Grep 参数更全,hosted 目录最简)
- `session-tool-catalog.ts` 引用共享定义,删除内联弱化版本
- `cli/src/runtime/worker-session.ts` 的 `CORE_TOOL_DEFINITIONS` 引用 vendored 副本;`cli/scripts/sync-shared.mjs` 的 `SHARED_FILES` 是显式清单,必须新增 entry,否则 `--check` 会在 CLI 构建前失败
- 渲染进程 stub 只保留 UI 展示所需的元数据,删除定义副本与 `nativeOnlyResult` 执行分支
- 清掉 `codegraph-tool.ts:18-23` 描述已废弃 bridge 执行方式的注释

统一 Grep schema 时注意 `search-tool.ts` 同时有 `output_mode` 和 `outputMode` 两个参数,只保留 Worker 实际读取的那个。

**新增 `src/shared/` 文件会引入新的导入边界**,需跑 `npm run verify:architecture`,且不得为掩盖违规而重新生成 `scripts/architecture-boundary-baseline.json`。

### B2. 假参数与重复工具清理(P13、P14)

- Bash 的 `run_in_background` / `force_foreground`:两个选择——从 CLI 与渲染进程 schema 中删除,或在 Worker shell 执行器实现。倾向删除:`Monitor` 已经承担后台进程职责(`AgentRuntimeCodeCompatibleExecutor.cs:47`),Bash 再加一套是重复。
- `Shell`:Worker 认这个名字但任何目录都不暴露。要么从 `NativeToolNames`(`AgentRuntimeNativeToolExecutor.cs:30`)移除,要么明确它是 `Bash` 的兼容别名并加注释说明为何不进目录。
- Cron 别名:`CronAdd`/`CronCreate` 与 `CronRemove`/`CronDelete` 保留一对,另一对在 Worker 侧作为纯别名接收但不进工具目录,减少模型的无谓选择。schema 粗细差异同时消除(`session-tool-families.ts:137-168`)。
- `AgentRuntimeTranslationExecutor.cs:7-13` 的 `FileRead` 别名不在任何公开目录,确认是内部专用后加注释,避免被当作漂移误删。

### B3. chat 模式工具白名单接线(P10、P11)

`filterChatModeToolDefinitions` 已写好但无人调用,chat 模式实际带完整目录却只有约 367 token 的提示词。必须二选一:

**方案 A(推荐):接线白名单。** 在 `use-chat-actions.ts` 的工具组装处(`:4765-4799` 附近)对 chat 模式应用过滤,同时修正 `agent-system-prompt.ts:682` 那句"与其他 agent 模式相同的工具访问权"。hosted 路径的 `listSessionTools()` 需要对等处理,否则两条路径的 chat 模式工具集不一致。

**方案 B:承认 chat 是全能模式。** 删除 `chat-mode-tools.ts`,给 chat 模式补上文件操作规范、任务管理与并行调用指引。

方案 A 与"chat 是轻量对话模式"的产品定位一致,且改动更小。方案 B 会让 chat 与 cowork 的边界消失,需要产品层面确认。

### B4. Web 工具护栏(P34)

- WebSearch 加短 TTL 结果缓存(同 query 同轮内复用)与被拦截时的退避,而不是直接 `EncodeError` 返回
- WebFetch 在 HTML→markdown 转换后加二次字符上限,主动截断并说明,而不是让通用截断挖掉中段

---

## 阶段 C:提示词

阶段 A 与 B 让运行时兑现承诺之后,提示词才值得改——否则改的是对不上的说明书。

### C1. Clarify 去重(P16)

删掉 `buildModePromptBody`(`agent-system-prompt.ts:283-295`)里的 9 条 bullet,只保留 `## Mode: Clarify` 标题与 `CLARIFY_CORE_PROMPT`。那 9 条全是 core prompt 的摘要,没有新增信息。约 800 token 直接省下,且消除"同一规则三处措辞略有不同"导致的歧义。

### C2. 跨节矛盾消解(P17)

- `:503` 的全局"不清楚就问用户"改为模式中立表述(例如"通过当前模式规定的提问渠道询问"),让 Clarify 的 AskUserQuestion 硬规则不再与它冲突
- `:345`(Code 极简)与 `:312`(Cowork 跑命令要解释)的冲突源于两者共享同一份沟通规范节。把详略要求下沉到各模式 body,全局节只保留真正模式无关的部分
- 用户规则优先级统一:`:655` 与 `:730` 是同一份 `settings.systemPrompt`,必须用同一套语义。同时处理 SOUL 与系统提示词的优先级声明冲突(memory policy 说系统提示词优先,SOUL 块说自己 override everything)

### C3. 模式裁剪(P18)

`<making_code_changes>` 与 `<running_commands>` 对 ACP 主 Agent 是纯噪声且与"不得写代码"直接矛盾。`buildAgentModeSystemPrompt` 按模式决定是否 emit 这两节。ACP 的子 Agent 走 `subAgentToolCatalog`,不受影响。

同理检查 chat 模式:它现在不注入 `buildRuntimeReminder`,任务管理节的存在意义需要确认。

### C4. 补 worked example(P19)

任务管理节的示例是全篇质量最高的部分,源码注释自己写了 "load-bearing"。按同样密度给 Cowork(一次完整 Plan-Act-Observe 循环)、Code(一次最小外科手术式编辑)、ACP(一份子 Agent 委派简报模板)各补至少一个示例。

示例会让提示词变长,因此顺序上应在 C1 之后——先腾出预算再花。

### C5. CLI 与子 Agent 提示词收敛(P20、P21)

- `cli/src/runtime/worker-session.ts:988-1024` 改为 import 共享 builder。CLI 目前硬编码 `code` 模式,可以先只接 code 模式的共享路径,不急于支持全部模式。这一项让 CLI 立刻获得任务管理、并行调用、文件完整性等约 3K token 的行为规范。
- 子 Agent `custom` 类型的 C# 6 行默认提示词与 TS 侧从未被引用的 `buildDefaultSubAgentSystemPrompt`(2000+ token)之间做决断:要么把 TS 那份作为默认值经请求传给 Worker,要么删掉它并把 C# 默认写充实。留着一份写好却没人用的死代码是最差选项。

### C6. 清理 `resources/prompts/`(P22)

目录里只有一个 0 字节文件,`loadPrompt()` 无调用点,而 `AGENTS.md:258` 与 `CLAUDE.md` 都在描述"每个模式有自己的模板"。要么实现该机制,要么删掉目录与 loader 并修正两份文档。倾向后者:提示词在 TypeScript 里组装,类型安全、可测试(已有 `agent-system-prompt.test.ts`),没有理由退回字符串模板。

注意 `UserPromptCatalog.cs:67-87` 会在首次访问时把 bundled `.md` 复制到 `~/.open-cowork/prompts/`,删除前需确认没有用户依赖该目录的其他用途。

---

## 阶段 D:链路结构

### D1. `contextSource` 接线(P25)

协议、Worker 侧读取逻辑(`ReadContextSourceMessages`)、验证脚本(`scripts/verify-message-windowing.mjs`)全都就绪,只差真实请求传参。在 `use-chat-actions.ts:5179` 的 `buildSidecarAgentRunRequest` 调用中传入 `contextSource`,让 legacy 路径也由 Worker 自读 DB。

前置条件:该路径的消息必须已落盘。hosted 路径已经有 `flushSessionMessageWrites` 屏障(`:5287-5288`),legacy 路径需要对等处理。

收益集中在 Plan 模式——它是最常用的 legacy 回退场景,现在每轮重发最多 160 条消息 + 完整工具目录。

### D2. 提示词前缀缓存修正(P23、P24)

两个方向的错误同时存在:失效过度和失效不足。

**失效过度:** 任务与计划的每次变更都清快照(`task-store.ts` 4 处、`plan-store.ts` 8 处、`use-chat-actions.ts:5989`),但系统提示词内容不含任务或计划数据——任务列表走 `dynamic-context.ts` 的每轮注入,plan mode 不进前缀(有测试确认)。这些失效重建出逐字相同的字符串。agentic 会话里几乎每轮都动任务,所以 `canReuseSessionPromptPrefix` 形同虚设,每轮都要重跑提示词与工具目录组装(含 memory / skills / MCP 的异步读取),直接加在首 token 之前。

处理方式:逐处确认这些 `clearSessionPromptSnapshot` 调用是否真的影响系统提示词内容。若不影响则删除。删除前建议加一个测试断言"任务变更不改变系统提示词字符串",把这个不变量固化下来。

**失效不足:** `canReuseSessionPromptPrefix`(`prompt-prefix-pin.ts:4-28`)不比较工具集、`planMode`、`contextCacheKey`。工具集变化(MCP 连上/断开、插件启停、设置开关)时可能复用过期前缀,导致模型看到的工具列表与实际授权不一致。应把工具集指纹纳入比较——`definitionHash` 已经在 manifest 里算好,可以直接聚合。

这两处必须一起改:只删失效会暴露失效不足的问题。

### D3. cron 迁移到共享装配(P26)

`headless-auto-reply.ts` 已经用共享的 `assembleHostedSessionContext`,cron 是唯一还在自己装配的路径。迁移后可删除:

- `BACKGROUND_TOOL_DEFINITIONS`(`cron-agent-background.ts:846-996`)
- 内联的 SessionStart hook 调用(`:696-714`)
- Main 侧的流事件映射与 transcript 重建(`:486-601`),改为复用与 headless 相同的消费路径

cron 特有的部分(假会话 id `cron:${runId}`、`getCompaction: () => null`、`settingsRevision: 'cron'`)作为参数传入共享装配,而不是复制一套装配逻辑。

同时补上 cron 的整体超时(P30),对齐 headless 的 30 分钟。

### D4. run 状态追踪收敛(P27)

`activeRunSessions`(`sidecar-manager.ts:249`)、`runtime-registry.ts`、`activeRunIds`(`native-agent-runtime.ts:38`)三份状态,重连时靠三处 best-effort 对账。选一个作为权威(`runtime-registry` 最接近这个定位),另两处改为从它派生或直接删除。

这一项风险高于前几项:重连与崩溃恢复路径的边界情况多,建议在 E1 之后做,那时终止语义已经收紧。

### D5. `sendMessage` 拆分(P28)

约 2500 行的函数,`:4198` 就把会话标 running,之后仍有一长串串行 await 才发出请求。用户看到"运行中"到第一个 token 之间的空窗全在这里。

按真实概念拆分,不要按行数切:

- 预检(provider 解析、密钥/OAuth 校验、能力探测)
- 上下文装配(memory、skills、MCP、selected files、hook 输出)
- 请求构造(hosted 与 legacy 两条分支)
- 流消费循环
- 收尾(持久化、队列调度、auto-continue)

拆分本身是纯重构,不改行为。拆完之后才有条件优化顺序——把不影响首 token 的工作(例如 MCP 预热)移出关键路径,或并行化互不依赖的装配步骤。

---

## 阶段 E:韧性

### E1. queued run 的终止语义(P29)

`sidecar-manager.ts:549-554` 只对 `jobState === 'running'` 注入合成终止事件。停在 `queued` 的 run 在 Worker 崩溃后永久挂起。扩展到所有非终止状态的 run。

同时重新审视 `injectAgentStreamEnvelope`(`:532-546`)这个机制本身:Main 合成 Worker 本该发出的终止事件,是把 Worker 的职责搬到了 Main。更干净的做法是 Worker 在 job 失败时自己发终止事件,Main 只在 Worker 进程已死无法发声时兜底。这一步可以留到后续阶段。

### E2. 超时补齐(P30)

- `agent:compress-context` 的 `NATIVE_WORKER_NO_TIMEOUT`(`runtime-command-gateway.ts:512`)换成有界超时。压缩本身有 360 秒摘要超时(`AgentRuntimeContextCompression.cs:18`),host 侧给一个略宽于它的上限。
- cron 整体超时(随 D3 一起做)。

### E3. 取消传播(P31)

`AgentRuntimeCodeGraphExecutor.ExecuteAsync` 忽略 `cancellationToken`(`:25-26`)。长 CodeGraph 操作取消不掉,用户点 Stop 后仍在跑。传入并检查 token。顺带审计其他执行器是否有同类遗漏。

### E4. 上下文溢出识别(P9)

`AgentRuntimeContextCompression.cs:227-257` 靠匹配 provider 错误文案字符串。provider 改措辞即静默失效——失效表现是压缩不触发、请求直接失败,用户看到一个原始 provider 错误。

改进方向:优先用结构化信号(HTTP 状态码 + provider 的 error code/type 字段),字符串匹配降级为最后手段,并在只能靠字符串匹配时打 warn 日志,让漂移可观测。

### E5. 流中途失败的可恢复性(P32)

`AgentRuntimeProviderRetryPolicy.cs:339-345`:已输出部分文本后流失败不重试,用户看到截断回复且无自动续接。这是正确的保守选择(重试会重复输出),但用户侧应该有明确的"续接"入口而不是静默截断。属产品决策,本方案只记录。

### E6. 同步 SQLite 阻塞(P33)

`ReadContextSourceMessages` 在 async 路径用同步 SQLite(`OpenAIChatRuntime.cs:3388`、`:3412`)。并发下阻塞线程池。改为异步 API,或至少 `Task.Run` 隔离。优先级低于前几项,但在多会话并发场景下会放大。

---

## 验证

### 代码门槛

```bash
npm run typecheck          # node + web + cli,行为改动必跑
npm run lint
npm run verify:architecture # 阶段 B 新增 src/shared/ 文件后必跑
npm run contracts:check    # 仅在最终改动了 runtime-contracts/model.ts 时需要
npm run cli:test           # 阶段 B/C 改 CLI 工具定义或提示词后,需先 build
npm run verify:message-windowing  # 阶段 D1 之后
npm run verify:worker-http
```

阶段 A 的 Worker 改动需重新发布二进制后才能验证(`scripts/publish-native-worker.mjs`)。

按 AGENTS.md 要求,运行时改动需在至少两个 LLM provider 上测试。

### 行为验收

阶段 A:

- 三文件并行读取的实际重叠执行(日志时间戳),总耗时接近单次
- 混合读写批次的顺序正确性与非并行化
- `maxParallelToolCalls = 1` 退回全串行
- 3000 行文件的按行截断与 offset 续读
- 自动压缩后最近若干轮保持原文、tool 配对完整、任务可继续
- 人为循环在迭代上限处以 `max_iterations` 收尾

阶段 B:

- 桌面端与 CLI 看到的 Grep/Glob/LS/Bash schema 一致
- chat 模式实际工具集与提示词声明一致
- 删除渲染进程 stub 执行路径后无任何调用点回归

阶段 C:

- Clarify 模式提示词 token 数下降且行为不退化(仍走 AskUserQuestion、仍以 ExitPlanMode 收尾)
- ACP 主 Agent 不再收到无关的代码修改指引
- CLI 的任务管理与并行调用行为向桌面端拉平

阶段 D:

- Plan 模式每轮请求体大小显著下降
- 任务变更不再触发系统提示词重建(加断言固化)
- cron 与 headless 走同一装配路径,行为一致

阶段 E:

- Worker 崩溃时 queued run 也被正确终止,UI 不挂起
- 点 Stop 能中断长 CodeGraph 操作

### 回归重点

- 聊天流工具卡片、Steps 面板、任务板、CLI 任务列表在并行乱序完成下的渲染
- 审批流程在并行块存在时的正确性
- 长会话的压缩与续跑
- CLI 的 PTY golden(不因本方案变化;若变化需确认后才更新)

---

## 明确不做的事

- 不合并 hosted 与 legacy 双路径。D1 只让 legacy 停止全量重传。
- 不引入第二个 Agent Loop,不在 CLI 侧加 provider 客户端或工具执行器。
- 不改 Worker HTTP / SSE / Job 协议。
- 不重构任务板 UI,不改 Plan / Goal / 子 Agent 的职责划分(与 `task-list-redesign.md` 的边界一致)。
- 不为掩盖新的导入违规而重新生成架构基线。
- 不动 `cli/src/vendor/*` 与其他生成文件。

## 后续阶段(本方案不实施)

1. Worker → UI 的可靠任务同步(见 `task-list-redesign.md` 后续阶段 1),之后才能安全精简工具返回体。
2. 把终止事件的合成职责从 Main 收回 Worker(E1 的第二半)。
3. 工具并行的第二档:`resourceSerial` 按资源键并行(不同文件的 Edit 可并行),需要真正的资源键实现而非当前的 `tool-default` 占位。
4. 提示词的 token 预算可观测性:当前系统提示词 3–4K + 工具 schema 4.6K + 每轮 memory/selected files 最多 24K,没有任何一处能看到总量。
5. 真实 Native Worker 的 HTTP/SSE/Job/replay/reverse-request 集成测试(与 `OLdhiNtPBOfb.md` 后续阶段 3 同项)。
6. 子 Agent 与任务清单工具的 `Task*` 前缀歧义消解(破坏性变更,需独立评估)。
