# @aidotnet/opencowork

OpenCowork 的终端 UI。默认模式直接连接 `OpenCowork.Native.Worker`；模型请求、Agent loop、
工具执行、权限策略和上下文压缩仍由 OpenCowork 原生 worker 完成。CLI 不维护第二套 Runtime
或第二份 provider credentials。

详细设计、Claude Code 公开资料/黑盒观察的边界以及当前完成度见
[ARCHITECTURE.md](./ARCHITECTURE.md)。

## 全局安装

从 npm 安装最新版本：

```bash
npm install -g @aidotnet/opencowork
cowork
```

`opencowork` 与 `cowork` 都可启动 CLI；推荐使用较短的 `cowork`。

安装包已内置各平台的 Native Worker。安装脚本会自动识别当前平台和 CPU 架构，并复制对应的
Worker 到本地，无需在安装过程中从 GitHub Release 下载。支持 macOS
(`osx-arm64` / `osx-x64`)、Windows (`win-arm64` / `win-x64`) 和 Linux
(`linux-arm64` / `linux-x64`)。

在 macOS 或 Linux 全局安装完成后，安装器会提示 `cowork` 的使用方式。若 shell 找不到该命令，
将 npm 全局 bin 目录加入 shell 配置后重新打开终端：

```bash
export PATH="$(npm bin -g):$PATH"
```

## 更新

每次交互式启动 `cowork` 时，CLI 会检查 npm 上的最新版本；检测到新版本后可以在提示中选择立即更新。
也可以手动执行：

```bash
cowork update
```

更新失败时，执行：

```bash
npm install -g @aidotnet/opencowork@latest
```

当使用不含内置 Worker 的旧版包或内部构建时，可以指定 Worker 压缩包地址：

```bash
OPEN_COWORK_NATIVE_WORKER_URL=https://mirror.example.com/OpenCowork-native-worker-linux-arm64.tgz \
  npm install -g @aidotnet/opencowork
```

如果 Worker 已经由内部部署提供，也可以跳过下载并在运行时指定路径：

```bash
OPEN_COWORK_SKIP_NATIVE_DOWNLOAD=1 npm install -g @aidotnet/opencowork
OPEN_COWORK_NATIVE_WORKER_PATH=/absolute/path/OpenCowork.Native.Worker opencowork
```

卸载：

```bash
npm uninstall -g @aidotnet/opencowork
```

全局 CLI 要求 Node.js ≥ 18；模型凭据和普通设置仍从 `~/.open-cowork/` 读取，与桌面端共享。

## 开发

```bash
cd cli
npm install
npm run typecheck
npm run build
npm run dev
```

常用入口：

```bash
npm run dev:classic                 # classic + 原生 terminal scrollback
npm run dev -- --tui fullscreen     # alternate-screen fullscreen
npm run dev -- --doctor             # 验证 worker/IPC/provider，不发模型请求
npm run dev -- config               # 在终端配置 provider，不启动 worker
```

如果 worker 不在仓库标准路径：

```bash
OPEN_COWORK_NATIVE_WORKER_PATH=/absolute/path/OpenCowork.Native.Worker npm run dev
# 或
npm run dev -- --worker /absolute/path/OpenCowork.Native.Worker
```

provider、模型、permission policy 和普通设置从 `~/.open-cowork/` 读取，与 Electron 应用
共用。`/model` 每次打开都会重新读取渠道：只显示已启用、已完成认证并启用了 chat model
的 provider，按 provider 分组，支持搜索 provider 名、模型名和 model ID。选择模型后进入
第二步配置，按模型能力显示 Thinking、reasoning effort、Anthropic thinking budget、Fast
mode、内置搜索、Responses WebSocket、图片生成和 cache TTL，并显示协议、context/output
limit 与 token price。确认第二步后才会把模型选择和配置写回桌面端同一份 provider/settings
store。

首次使用无需先启动桌面端：运行 `cowork config`（`cowork configure` 也可）即可打开快捷配置
向导；交互会话内可用 `/provider`，也可从 `/config` 的 Providers 项进入。向导可更新已有的
API-key provider，也提供 Routin AI、OpenAI、Anthropic、DeepSeek、Google Gemini、OpenRouter、
SiliconFlow、Ollama 和自定义兼容端点的入口。API Key 始终掩码显示；保存时原子写入与桌面端相同
的 `~/.open-cowork/ai-provider/`，目录权限为 `0700`、文件权限为 `0600`，不会创建 CLI 专属凭据。
OAuth/channel provider 仍由桌面端完成登录，向导不会把它们降级成 API-key provider。

模型目录同时读取桌面端的 Vision 能力标记。支持图片输入的当前模型可以用 `Ctrl+V` 从系统
剪贴板附加 PNG/JPEG/GIF/WebP 图片；单张上限 20 MB、单次最多 10 张。macOS 使用系统
pasteboard，Windows 使用 STA Clipboard，Linux 使用 `wl-paste` 或 `xclip`。不支持 Vision 的
模型会在读取剪贴板前明确阻止，并提示通过 `Alt/Option+P` 切换模型。图片以结构化
`image/base64` content block 发送给 Native Worker，不会拼入普通 prompt 文本。

在普通输入中键入 `@` 或 `@关键字` 会搜索当前工作目录。用 `↑` / `↓` 选择，按 `Tab` 或
`Enter` 插入，按 `Esc` 关闭结果。选中的文件会以 Desktop 兼容的
`[文件名](workspace/path)` 形式进入可编辑 prompt，并同时保留为结构化引用；引用栏显示本轮
将附带的路径。清空普通文字后按 `Backspace` 可移除最后一个引用。每轮最多 20 个文件，正文
最多读取每个文件前 1000 行，所有引用正文合计最多 256 KiB；二进制、PDF、不可读文件和超限
内容会降级为 path-only。`.env`、私钥、credentials 等敏感文件不会出现在自动搜索结果中，
即使从历史数据恢复也只会传路径，不会自动读取正文。

文件正文只通过 Worker 已支持的 `requestContextTexts` 进入当前请求上下文；canonical 用户消息
保存可见 prompt 和引用元数据，不复制隐藏文件全文。目前搜索范围仅限当前 workspace。历史
消息引用、选区引用、拖放文件路径和 shell 输出引用仍属于后续阶段。

`/config` 提供可搜索的共享配置界面，可修改 CLI 实际消费的桌面端设置，包括 thinking、
自动上下文压缩、压缩阈值、专用压缩模型、请求超时、工具/子 Agent 并发以及 CodeGraph。
设置通过 Native Worker 写回同一份 Zustand 持久化数据。只有打开 provider 向导并录入新 Key
时，凭据才会短暂存在于掩码输入组件状态；它不会出现在 transcript、命令参数、日志或模型目录中。

`/compact [focus]` 直接调用 Native Worker 的 `agent/compress-context`。Worker 负责摘要模型、
重试、超时、circuit breaker、安全 tool 边界与失败回退；成功结果会替换并持久化 canonical
messages。CLI 只显示 `Compressing context…` activity 和结果，不自行生成摘要。

## 命令参数

```text
cowork [prompt]
  config|configure
  update
  --doctor
  --provider <provider-id>
  --model <model-id>
  --permission-mode manual|acceptEdits|plan|auto
  --tui classic|fullscreen
  --worker <absolute-path>
```

普通启动始终连接 `OpenCowork.Native.Worker`。没有独立、回退或模拟 Agent Runtime。

## 已接入的 worker 能力

- Unix domain socket / Windows named pipe。
- 4-byte big-endian length framing + MessagePack。
- `worker/hello`、`worker/routes`、`initialize` 握手与 heartbeat。
- Agent Runtime protocol v2 与 Capability Snapshot v2 安全门。
- `agent/run`、`agent/cancel`、`agent/reverse-response`。
- canonical `AgentStreamEnvelope` 到 terminal UI state 的投影。
- assistant/thinking/tool/retry/compression/error/loop-end 等主要事件；连续 provider retry
  只更新底部唯一的 `Retry attempt/max` activity 行，不会反复追加 transcript 消息。
- Thinking 与正文按 Worker delta 的真实顺序保存为独立 segment；生成时显示 `Thinking…`，
  完成后在原位置折叠为 `Thought for Ns (ctrl+o to expand)`，展开正文为灰色斜体，不会再统一
  移到回答末尾。渠道只返回 reasoning token 时，无 trace 标记会放在正文之前。
- 发送后显示单一的 turn activity 行，不再同时重复 `Thinking…` 与底部 `Working…`。动词使用
  从左到右的文字颜色波动；请求/输出 token 在流式阶段以固定布局平滑递增，并在 provider
  usage 到达时校准。自动或手动压缩期间切换为 `Compressing context…`。
- 底部状态区持续显示 canonical context 占用、provider cache read 命中率和按共享模型价格
  估算的当前用量 USD 成本；指标在窄终端自动收缩，价格不可用时明确显示 `—`。
- Native Worker approval overlay，支持 allow once/session/deny。
- worker 原生代码工具与 persistent Task 工具的 v2 manifest/catalog。
- Native Worker `Task` sub-agent：读取同一份 `~/.open-cowork/agents/`，子 Agent 继承父级
  工具（不含 `Task`），thinking/text/tool/report 进度投影到终端任务块。
- `loop_end.messages` 会成为下一轮的 canonical conversation history，并通过 Worker
  `db/messages-replace` 持久化；`/clear` 清理当前 canonical context，`/new` 创建新的 Worker
  session ID 而不删除旧 session。`/resume` 可搜索并恢复当前工作目录下由 CLI 创建的已完成
  session：它通过 Worker DB routes 原子加载完整 canonical history，后续 turn 继续写入同一
  session；旧 provider/model 不再可用时会保留当前模型并明确提示。
- 与桌面端共用 provider/channel/model store；`/model` 支持渠道分组、实时刷新和搜索。
- `AskUserQuestion` 由 Worker 发起 reverse request，CLI 提供多题、单选/多选、Other、备注和安全纯文本预览；答案以结构化 payload 返回，Worker 再继续原 turn。
- `EnterPlanMode` / `ExitPlanMode` 由 Worker 创建、读取并持久化 `.plan/{planId}.md`；CLI 提供 drafting、review、滚动、批准和带反馈修订界面。批准后的实现仍由 Worker 执行。
- `/plan [on|off|toggle]` 可显式进入或离开 Plan mode。空闲时底部使用与 Claude Code 同语义的
  `⏸ plan mode on (shift+tab to cycle)` 整行提示；Plan review 使用高对比标题、状态、审批边界
  和选中项。`Shift+Tab` 按 `manual → accept edits → plan → auto → manual` 循环，因此既可进入
  Plan，也可在 Plan review 打开时继续切换退出；窄终端会使用紧凑文案并保持审批项单行。
- CodeGraph 设置与桌面端共享；启用后动态读取 Worker 的 `codegraph/tools-list`，查询通过同一 Worker 的 `codegraph/*` 路由转发，CLI 不索引、不解析项目。
- `/context` 显示有效 context window 与准确的自动压缩触发点；`/cost` 汇总 token usage 并在
  模型配置包含价格时估算 USD 成本。底部状态区会同步投影 context 占用、cache read 命中率和
  当前记录用量的成本；`/doctor` 可在交互界面内执行只读 Worker 诊断。
- `/rewind` 或空输入时双击 `Esc` 打开当前会话的历史轮次列表，最多保留 100 个用户 prompt
  checkpoint，并标明距离当前轮次的数量。选择历史轮次后只提供“仅恢复会话”“恢复会话及
  已追踪变更”“取消”三项。恢复会话会 fork 新 Worker session，原会话不被截断；第二项只通过
  Native Worker 恢复 `agent_file_changes` 中可逆的本地文件变更，外部副作用、外部改动冲突和
  符号链接不会被伪装成已恢复，并会安全跳过及明确报告。

`/resume` 只恢复最后一次完整落盘的 canonical conversation snapshot；它不会接管其他进程
仍在运行的 Worker run，也不会恢复未落盘流式 delta、待审批请求、AskUser、tasks 或 plan UI
内存态。当前命令菜单只展示已经完整接线的命令；`add-dir`、`background`、`branch`、`btw`、
`diff`、`init`、`mcp` 和 `memory` 仍需要正式的 Worker session/host-adapter 协议，因此不会通过
隐藏 prompt 或 CLI 自行执行工具来伪实现。

MCP、Browser、Desktop、Extension、Team UI 等仍需要各自的终端 host adapter，当前不会被 CLI
宣告。完整能力边界和路线图见架构文档。

## 键位

- `/`：命令菜单。
- `/provider`：在终端内新增或更新 API-key provider；也可在启动前运行 `cowork config`。
- `@`：搜索当前 workspace 文件；`↑` / `↓` 选择，`Tab` / `Enter` 插入，`Esc` 关闭。
- `?`：快捷键面板。
- 空输入时 `←` 或 `/agents`：打开 Native Worker sub-agent 搜索面板。
- `Shift+Tab`：按 `manual → accept edits → plan → auto → manual` 循环；可进入和退出 Plan mode。
- `Alt/Option+P`：模型选择。
- `Ctrl+O`：工具/思考详情；推理正文默认折叠，渠道只返回推理 token 时会明确标记 trace 未公开。
- `Ctrl+T`：任务面板。
- `Ctrl+S`：stash/restore prompt。
- `Ctrl+V`：从系统剪贴板附加图片；仅当前模型支持 Vision 时可用。空 prompt 上按
  `Backspace` 删除最后一张待发送图片。
- 空 prompt 上按 `Backspace`：先移除最后一个文件引用，再移除最后一张待发送图片。
- `Ctrl+L`：清除旧 frame 并按当前终端宽度完整重绘；resize 自动走相同的重绘路径。
- `Ctrl+A/E/K/U/W/Y/_`：常见 Emacs 编辑操作。
- `Alt+B/F`：按单词移动。
- `Shift+Enter` 或 `\` + Enter：多行输入。
- `Esc`：关闭当前菜单；运行中取消。空输入时连续两次 `Esc` 打开与 Claude Code 同语义的
  Rewind 列表；有 prompt 草稿时第一次提示、第二次清空并写入输入历史，完成 Rewind 后可用
  `↑` 恢复该草稿。
- `Ctrl+C`：运行中取消、清空输入、空输入时二次退出。

## 验证

```bash
npm run typecheck
npm run build
npm run dev -- --doctor
```

这是独立 Node/TypeScript 包，不属于根目录 npm dependency tree。用户保留的历史入口
`src/index 2.ts` 不参与当前 TypeScript 构建，也不会被 CLI 运行时加载。
