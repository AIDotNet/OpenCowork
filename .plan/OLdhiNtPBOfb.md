# CLI 架构优化实施计划

## 目标

在不改变 Native Worker 协议、Agent Runtime 权威边界和现有终端交互语义的前提下，先完成 CLI 第一阶段架构治理：把 `CliApp` 中最容易继续膨胀的 UI 状态和 Worker `UiEvent` 投影抽成可测试的状态层，并把 Overlay 优先级从多个布尔值收敛为显式状态。

本阶段重点解决：

- `cli/src/app.tsx` 同时承担状态模型、事件 reducer、命令编排和 JSX 渲染的问题；
- 流式事件更新散落在组件闭包内，难以独立测试；
- `askUserRequest`、`plan`、`permissionRequest`、model/config/provider 等多个 overlay 状态依靠 JSX 顺序隐式决定优先级；
- 未来新增交互能力时容易出现状态组合冲突。

## 保持不变的架构约束

- Native Worker 仍是唯一 Agent Loop、Provider、Tool、Permission、MCP、Plan 和持久化权威。
- 不修改 Worker HTTP/SSE/Job 协议，不新增第二套 Agent Runtime。
- `AgentStreamEnvelope` 仍是 canonical runtime protocol；`UiEvent` 仍是 CLI 专用投影协议。
- Classic 和 fullscreen 的终端行为保持不变。
- 不改变既有命令、快捷键、审批选项、AskUser 流程、Plan 流程和 session 行为。
- 不修改 `src/vendor/*` 生成文件。

## 实施步骤

### 1. 建立当前行为基线

先在 CLI 包内执行并记录：

- `npm run typecheck`
- `npm run build`
- `node --test "test/**/*.test.mjs"`

重点保留现有 PTY golden、markdown layout、长流式回复、fullscreen resize/scroll、bracketed paste 和 `/init` 审批测试，作为重构后的回归基线。

### 2. 新增纯状态模块

新增 `cli/src/state/cli-state.ts`，承载与 React/Ink 无关的终端状态类型和纯函数：

- `CliState`：transcript、tasks、runtime activity、turn status、metrics、permission、AskUser、Plan、model/config/provider 面板数据、scroll state、notice 等状态；
- `ActiveOverlay` discriminated union，明确 overlay 类型和载荷；
- 初始状态构造函数，兼容 `initialResume`；
- `updateMessageById`、assistant segment 更新、tool/sub-agent 更新等现有纯更新逻辑；
- overlay 打开/关闭和状态清理 helper；
- 保持消息顺序、streaming 状态、canonical transcript 和局部 UI notice 的现有语义。

状态类型会区分：

- canonical/session projection；
- 当前 turn 的 transient projection；
- terminal-only UI state；
- modal/overlay state。

这样后续可以单独测试状态转移，而不需要启动 Ink。

### 3. 把 `UiEvent` 投影改为纯 reducer

新增 `cli/src/state/cli-reducer.ts`，将 `CliApp` 中 `applyRuntimeEvent` 的状态修改逻辑迁移为：

```ts
reduceCliState(state: CliState, event: UiEvent): CliState
```

覆盖当前所有事件：

- assistant start/delta/thinking/image/done；
- tool start/update/done；
- permission request/cancel；
- AskUser request/cancel；
- Plan update；
- tasks update；
- runtime activity/usage/retry；
- context compression start/delta/done；
- system；
- turn done。

reducer 保持以下不变量：

- 只通过消息 ID 更新对应 streaming/tool 行；
- assistant thinking/text segment 按 Worker 顺序保留；
- interactive event 不会被流式 batching 破坏顺序；
- 连续重复 system notice 仍然合并；
- turn 完成只释放 transient 状态，不擅自生成 canonical history；
- overlay 请求的 request ID 取消时不会误清理新的请求。

`readRuntimeMetrics`、时间格式化和终端绘制相关逻辑不放入 reducer；它们继续作为 controller/view helper 存在。

### 4. 用 `useReducer` 接入 `CliApp`

在 `cli/src/app.tsx` 中：

- 用 `useReducer(cliReducer, initialState)` 替换消息、任务、activity、turn status、permission、AskUser、Plan 等高频事件状态的分散 setter；
- 保留 prompt 草稿、模型选择、配置面板异步保存状态等真正属于组件交互生命周期的局部 state；
- 将 `applyRuntimeEvent` 收敛为 dispatch wrapper；
- 保留当前 33ms stream batching，仅把最终事件交给 reducer；
- 保留当前 `committedCountRef`、terminal resize、scroll window 和 Ink Static/mutable split 行为；
- 保持现有 callbacks 对 runtime 的调用方式，避免本阶段同时改动 Worker adapter。

完成后，`CliApp` 主要负责：

```text
terminal measurements
runtime side effects
command callbacks
component composition
```

而不再直接实现完整的 Worker event state transition。

### 5. 收敛 Overlay 状态

在状态层引入显式的 overlay 表达：

```ts
export type ActiveOverlay =
  | { type: 'askUser'; request: AskUserRequest }
  | { type: 'plan'; plan: PlanSnapshot }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'resume' }
  | { type: 'providerSetup'; catalog: ProviderSetupCatalog }
  | { type: 'effort'; configuration: ModelConfiguration }
  | { type: 'modelConfig'; configuration: ModelConfiguration }
  | { type: 'modelPicker'; purpose: 'session' | 'compression' }
  | { type: 'config'; catalog: ConfigCatalog }
  | { type: 'agents' }
  | null
```

第一阶段不改变面板组件 API，而是先让 `CliApp` 从显式 overlay 派生 `inputActive` 和渲染优先级。对需要返回上一级的配置流程保留已有 return-to-config 标记，避免一次性重写所有异步面板导航。

渲染优先级固定为：

1. AskUser；
2. Plan；
3. Permission；
4. Resume / Provider / Model / Config / Agent 等 idle overlay；
5. PromptInput。

如果同时收到旧 overlay 和新 overlay 请求，以 request ID 和 reducer 的显式优先级决定最终状态，不再依赖 JSX 嵌套偶然产生的优先级。

### 6. 补充纯 reducer 和 overlay 测试

新增 CLI Node 测试文件，直接加载构建后的 state modules，覆盖：

- assistant text/thinking segment 顺序；
- tool start/update/done 合并；
- streaming message 不存在时的安全行为；
- permission/AskUser request 与 cancel 的 request ID 匹配；
- Plan update 不会覆盖新的 Plan 请求；
- turn done 清理 transient state；
- duplicate system message 合并；
- overlay 优先级和 input lock；
- assistant/tool 事件与 transcript window 所需字段保持兼容。

不改写 golden snapshot；只有在行为变化且经过确认时才更新 golden。

### 7. 文档同步

更新 `cli/ARCHITECTURE.md`：

- 补充 `AgentStreamEnvelope → UiEvent → CliState → Ink` 的状态层；
- 明确 `CliApp` 是 terminal controller/view composition，而不是 canonical runtime reducer；
- 明确 overlay priority 是状态模型的一部分；
- 将“当前已实现”与后续 `Session Bootstrap` 统一重构分开记录。

如用户可见行为没有变化，不修改 `cli/README.md` 的命令和快捷键说明。

### 8. 验证

从 `cli/` 执行：

- `npm run typecheck`
- `npm run build`
- `node --test "test/**/*.test.mjs"`

必要时再执行根目录：

- `npm run typecheck:cli`
- `npm run cli:test`

验收标准：

- 所有现有 54 个 CLI 测试继续通过；
- 新增 reducer/overlay 测试通过；
- classic/fullscreen golden 无非预期变化；
- Worker runtime 文件未引入第二套 Agent Loop 或直接工具执行；
- `UiEvent` 和 Worker vendor contract 没有漂移；
- overlay 只允许一个明确的 active layer 消费键盘。

## 后续阶段（本次不实施）

1. 把 `AgentRuntime` 的大而全可选接口拆为 Turn、Session、Configuration、Host capability ports。
2. 把 CLI 和 Electron 的 Session Bootstrap 收敛为 Worker/host-neutral `agent/session-open/send/close` 合同。
3. 增加真实 Native Worker HTTP/SSE/Job/replay/reverse-request 集成测试。
4. 拆分 `OpenCoworkWorkerRuntime`：transport projection、session persistence、host adapters、catalog/configuration。
5. 完善 fullscreen 的滚动条、历史选择、unread marker、终端能力协商和可访问性。
