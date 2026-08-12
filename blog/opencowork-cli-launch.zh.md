# OpenCowork CLI 发布：把完整 Agent 装进终端，附 15 美元 grok-4.5 额度

我们团队里有几个人，做着桌面端，自己却不怎么用桌面端——大部分时间人在 tmux 里，ssh 连着测试机，而那种机器根本跑不了 Electron。

所以有了 `cowork`。npm 上叫 `@aidotnet/opencowork`，v0.1.0，MIT。

它不是桌面端的精简版，也不是又一个"包了层壳的 API 聊天框"。CLI 进程里没有 HTTP client，没有工具实现，没有 Agent loop——这些全在 Native Worker 里，和桌面端用的是同一个二进制。下面分安装和架构两块讲。

顺带说个实在的：配合这次发布，通过 CLI 接入 Routin AI 渠道可以领 **15 美元免费额度**，直接拿来跑 **grok-4.5**。装完配一下就能用，怎么领在下面「首次配置」那节。

## 安装

```bash
npm install -g @aidotnet/opencowork
cowork
```

要求 Node.js ≥ 18。`opencowork` 和 `cowork` 两个命令都能启动，我们自己一直敲后面那个。

安装过程不联外网拉二进制。各平台的 Native Worker 已经打进 npm 包，`postinstall` 脚本认一下系统和 CPU 架构，把对应的那个复制到本地。支持六个目标：

```
macOS    osx-arm64    osx-x64
Windows  win-arm64    win-x64
Linux    linux-arm64  linux-x64
```

之前有一版是安装时现从 GitHub Release 下载的，国内装一次要等好几分钟还经常超时，后来干脆全塞包里了，体积大一点但省心。

### 命令找不到

macOS 和 Linux 上装完如果 shell 找不到 `cowork`，是 npm 全局 bin 目录不在 PATH 里：

```bash
export PATH="$(npm bin -g):$PATH"
```

写进 shell 配置后重开终端。

### 首次配置

不需要先装桌面端。第一次启动如果检测不到可用模型，CLI 会自动打开配置向导；也可以提前跑：

```bash
cowork config
```

向导里有 Routin AI、OpenAI、Anthropic、DeepSeek、Google Gemini、OpenRouter、SiliconFlow、Ollama 的快捷入口，另外支持四种协议的自定义端点——OpenAI Chat、OpenAI Responses、Anthropic、Gemini Interactions，自建的兼容网关基本都能接。

API Key 输入全程掩码，保存时原子写入 `~/.open-cowork/ai-provider/`，目录权限 0700、文件 0600。这是桌面端那份存储，不是 CLI 另起炉灶。OAuth 类的渠道仍然要在桌面端登录，向导不会把它们降级成 API-key provider。

进了交互界面之后，`/provider` 也能开同一个向导，`/model` 换模型。

### 领 15 美元跑 grok-4.5

向导里第一个就是 Routin AI（`https://api.routin.ai/v1`，OpenAI 兼容协议）。选它、填上 Key，就能拿到 **15 美元的免费额度**，可以直接用来跑 **grok-4.5**。

配完之后按 `Alt/Option+P` 或者敲 `/model`，在列表里选 grok-4.5。选中模型还有第二步配置，会把这个模型的协议、context / output limit 和 token 价格摆出来，确认后才生效。

额度花得怎么样不用猜：底部状态栏常驻当前上下文占用、cache 命中率和按模型价格估的花费，想看细账敲 `/cost`。

> 领取入口和活动细则见 [Routin AI](https://routin.ai)。

### 更新和卸载

每次交互式启动会非阻塞地查一下 npm 上的最新版本（结果缓存 24 小时），有新版会提示。手动更新：

```bash
cowork update
# 失败的话
npm install -g @aidotnet/opencowork@latest
```

卸载 `npm uninstall -g @aidotnet/opencowork`。

### 内网和自定义 Worker

如果用的是不含内置 Worker 的旧包或内部构建，可以指定 Worker 压缩包地址：

```bash
OPEN_COWORK_NATIVE_WORKER_URL=https://mirror.example.com/OpenCowork-native-worker-linux-arm64.tgz \
  npm install -g @aidotnet/opencowork
```

Worker 已经由内部部署提供的话，跳过下载、运行时指定路径：

```bash
OPEN_COWORK_SKIP_NATIVE_DOWNLOAD=1 npm install -g @aidotnet/opencowork
OPEN_COWORK_NATIVE_WORKER_PATH=/absolute/path/OpenCowork.Native.Worker cowork
```

### 装完先做什么

```bash
cowork --doctor
```

这个命令检查 Worker 能不能拉起来、IPC 通不通、provider 配置对不对，但一个模型请求都不发，排障和 CI 里都好用。交互界面里敲 `/doctor` 是同样的只读诊断。

然后就正常 `cowork` 进去，敲 `?` 看快捷键，敲 `/` 翻命令菜单。

## 技术架构

### 整体分层

```
┌──────────────── OpenCowork CLI ─────────────────┐
│  Ink + React 18 TUI                             │
│  输入框 · 对话流 · 浮层栈 · 状态栏               │
│  ─────────────────────────────────────────────  │
│  Runtime 投影层                                  │
│  UiEvent 队列 · Host Adapters · MCP Host        │
└────── Control IPC ─────────────── Event IPC ────┘
                       ↕
              OpenCowork.Native.Worker
   Agent loop · Provider 传输 · 工具执行 · 权限
   上下文压缩 · 子 Agent · SQLite · CodeGraph
```

CLI 启动时拉起一个 Native Worker 子进程，之后所有事情都通过 IPC 请求它。这个边界是硬的：CLI 不实现工具，不发模型请求，不做上下文压缩。

### IPC 传输

macOS 和 Linux 上是 Unix domain socket（建在 `/tmp` 下），Windows 上是命名管道。启动参数长这样：

```
OpenCowork.Native.Worker --control-ipc <path> --event-ipc <path> --host-id <uuid>
```

两条通道分开：control 走请求/响应，event 走 Worker 单向推流。

帧格式是 4 字节大端长度前缀加 MessagePack 载荷，单帧上限 256 MiB。选 MessagePack 而不是 JSON，主要是流式 delta 的量大，二进制图片也走同一条管道。

握手四步走完才算就绪：`worker/hello` 拿版本，`worker/routes` 拿路由表，`initialize` 建会话，`events/subscribe` 订阅事件流。之后每 15 秒一次 `worker/ping` 心跳。

Worker 二进制的查找顺序是：`--worker` 参数 → `OPEN_COWORK_NATIVE_WORKER_PATH` 环境变量 → npm 包里 `native-workers/<rid>/` → 仓库开发路径。

### Capability Snapshot v2

这是 Worker 侧的授权门。CLI 发起 run 之前要提交一份能力快照，每个工具带这些字段：

```
toolId           稳定标识
definitionHash   定义哈希，变了 Worker 能察觉
sideEffectClass  副作用等级
parallelClass    可并行等级
approvalMode     审批模式
recoveryMode     恢复模式
```

不带 v2 快照的 run 会被直接拒掉。MCP 工具在快照里标 `source: 'mcp'`、`executorRoute: 'mcp/execute'`，`approvalMode` 硬编码成 `always`——第三方 server 能干什么没法预判，每次都问一遍比较踏实。

这套东西是桌面端先跑通的，CLI 接的时候挺费劲，但接完就意味着两端的工具语义严格一致，不会出现"桌面端能改的文件 CLI 改不动"。

### 一轮对话发生了什么

`send()` 的完整流程：

1. 组装用户消息。图片作为结构化 content block，文件引用放在 `meta.promptReferences` 里，不拼进 prompt 文本。
2. 动态加载工具。CodeGraph 开了就读 `codegraph/tools-list`，Skills 读 `skills/list`，MCP 读已连接 server 的工具表。
3. `buildWorkerRunRequest()` 生成请求，走 `agent/run` 提交。请求用 Agent Runtime protocol v2，`rolloutMode: 'v2'`，`sessionPromptMode: 'code'`。
4. 消费 `agent/stream` 推过来的 envelope，转成 `UiEvent` 进队列，React 那边订阅渲染。
5. 处理 Worker 发回来的 reverse request（下一节说）。
6. 收到 `loop_end` 后，把 canonical messages 通过 `db/messages-replace` 落库。
7. 如果是首轮，额外发一次 provider-only turn 给会话生成标题，`db/sessions-update` 写回。

Worker 声明的核心工具集：`Read`、`Write`、`Edit`、`NotebookEdit`、`LS`、`Glob`、`Grep`、`Bash`、`Task`、`TaskCreate/Get/Update/List`、`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`，另外按配置追加 `WebSearch`/`WebFetch`、`Skill`、CodeGraph 和 MCP 工具。

权限模式的映射：`auto` 对应 Worker 的 `fullAccess`，开了白名单策略是 `whitelist`，其余走 `default`。Plan mode 下工具集收窄到只读和计划相关的那批。

### Host Adapter：Worker 反过来叫 CLI

有些事 Worker 干不了，得让终端出面——弹审批框、问用户问题、调 MCP。这类通过 reverse request 实现，CLI 侧注册了六个 adapter：

```
ask-user    ask-user/request                   多题问答界面
plan        plan/ui-update                     Plan 起草与评审界面
approval    approval/request                   审批浮层
codegraph   codegraph:tool                     转发到 Worker 的 codegraph 路由
skills      —                                  Skill 目录投影
mcp         mcp:call-tool / mcp:read-resource  转发给 MCP server
```

以审批为例：Worker 执行到需要授权的工具，发 `approval/request`，CLI 弹浮层，用户选完之后通过 `agent/reverse-response` 把结果回传，Worker 继续原来那一轮。整轮对话不中断，也不需要 CLI 自己判断这个工具该不该放行。

### MCP Host

MCP 的 client host 之前一直是 Electron 主进程，纯终端安装的用户用不了。这一版 CLI 自己接管了这个角色（`cli/src/runtime/mcp-host.ts`）。

配置从 Worker 的 `mcp/config-list` 读，落盘在 `~/.open-cowork/mcp-servers.json`，和桌面端同一份。目前只连全局启用、且没有绑定到特定项目的 server。三种传输都支持：`stdio`、`sse`、`streamable-http`，最后这个连不上会自动回退 SSE。stdio 类 server 用的是隔离的 `~/.open-cowork/npm-cache/`。

工具以 `mcp__{serverId}__{toolName}` 的名字进能力快照。Worker 要调用时发 reverse request，CLI 转给 `@modelcontextprotocol/sdk` 的 `Client`。开关用 `/mcp enable|disable <id>`，改动通过 `mcp/config-update` 写回。

### UI 层为什么是 React

Ink 加 React 18。命令行用 React 听着怪，但这个界面的复杂度早就过了 `console.log` 的线：流式输出要一边收 delta 一边重排，思考段落要折叠展开，审批要弹浮层，Plan 评审要滚动，还有模型选择器、任务列表、底部实时指标。用光标控制硬写，两周之后就没人敢碰那个文件。

组件树大致这几块：

```
Transcript      对话流
TurnStatusLine  本轮活动：动词动画 + 实时 token 计数
TaskList        任务面板
Overlay Stack   同一时刻只有一个：输入 / 审批 / Plan / 模型 / 配置 / Agent
StatusLine      模型、权限模式、上下文占用、成本
```

整个 CLI 本质是台状态机：订阅 `UiEvent` 队列，投影成终端画面。

渲染有两种模式。默认 `--tui classic`，完成的消息进 Ink 的 `<Static>`，保留终端原生滚动历史，往上翻、复制、被 tmux 捕获都正常。`--tui fullscreen` 走 alternate screen buffer，固定高度、输入框钉底，好看但退出后屏幕不留东西。

### 数据都在哪

CLI 和桌面端读写同一份数据，配一次两边通用。

```
~/.open-cowork/                  数据根目录（OPEN_COWORK_DATA_DIR 可覆盖）
├── data.db                      SQLite：会话、消息、用量
├── settings.json                共享设置
├── ai-provider/                 provider 凭据与模型目录（0700 / 0600）
├── mcp-servers.json             MCP 服务器配置
├── agents/                      自定义子 Agent
├── npm-cache/                   MCP stdio server 的隔离 npm 缓存
└── cli-update-check.json        更新检查缓存

~/.agents/skills/                Skill 目录
```

工作区规则从 `.agents/AGENTS.md` 或 `AGENTS.md` 注入系统提示词。

数据库不由 CLI 直接读写，全部走 Worker 的 DB 路由。`/resume` 会通过这些路由加载并复核当前工作目录下 CLI 创建的已完成会话，`/clear` 清上下文，`/new` 开新 session 但不删旧的。

### 界面语言

解析优先级：

```
--language/-l → OPEN_COWORK_LANGUAGE → settings.json → 系统语言 → en
```

系统语言依次看 `LC_ALL`、`LC_MESSAGES`、`LANG`、`LANGUAGE`，最后兜底 `Intl.DateTimeFormat`。16 个语言代码都认，目前完整翻译的是英文和简体中文，其余安全回退英文。

## 命令速查

22 个斜杠命令，全部在 CLI 内部处理，不会偷偷变成 prompt 发给模型：

```
/agents  /clear  /codegraph  /compact  /config  /context  /cost  /doctor
/effort  /exit  /help  /mcp  /model  /new  /permissions  /plan
/rewind  /resume  /skills  /status  /tasks  /tui
```

命令行参数：

```text
cowork [prompt]
  -l, --language <language>
  --doctor
  --worker <absolute-path>
  --provider <provider-id>
  --model <model-id>
  --permission-mode manual|acceptEdits|plan|auto   默认 manual
  --tui classic|fullscreen                         默认 classic

cowork update              全局更新
cowork config | configure  配置向导，不启动 worker
```

权限四档用 `Shift+Tab` 循环：`manual → accept edits → plan → auto`。Plan 挤在中间是故意的，进出都是同一个键。

## 当前的边界

Browser、Desktop 自动化、Extension、Team UI 还没有各自的终端 host adapter，CLI 现在不宣告这些能力。

`add-dir`、`background`、`branch`、`btw`、`diff`、`init`、`memory` 在菜单里看不到。它们需要正经的 Worker session 或 host-adapter 协议，在协议到位之前，我们不打算用隐藏 prompt 或让 CLI 偷偷执行工具凑一个"能跑"的版本。菜单里出现的都是真接完线的。

`/resume` 只恢复最后一次完整落盘的对话快照，接管不了别的进程还在跑的 run，也恢复不了未落盘的流式内容和各种内存态。`@` 文件搜索目前只覆盖当前 workspace。

完整的能力清单和路线图在 [`cli/ARCHITECTURE.md`](https://github.com/AIDotNet/OpenCowork/blob/main/cli/ARCHITECTURE.md)。

---

- npm：[`@aidotnet/opencowork`](https://www.npmjs.com/package/@aidotnet/opencowork)
- 源码：[AIDotNet/OpenCowork](https://github.com/AIDotNet/OpenCowork/tree/main/cli)
- 有问题、有想法，来 [Issues](https://github.com/AIDotNet/OpenCowork/issues) 说

v0.1.0 这个版本号是认真的，肯定还有毛病。用着觉得哪儿别扭，直接开 issue。
