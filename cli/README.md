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
opencowork
```

安装脚本会显示 OpenCowork 品牌化的安装面板，自动识别当前平台和 CPU 架构，从对应的
GitHub Release 下载 Native Worker，并在校验文件可用时验证 SHA-256。支持 macOS
(`osx-arm64` / `osx-x64`)、Windows (`win-arm64` / `win-x64`) 和 Linux
(`linux-arm64` / `linux-x64`)。

如果网络环境需要镜像，可以指定完整的 Worker 压缩包地址：

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

npm uninstall -g @aidotnet/opencowork
常用入口：

```bash
npm run dev:classic                 # classic + 原生 terminal scrollback
npm run dev -- --tui fullscreen     # alternate-screen fullscreen
npm run dev -- --doctor             # 验证 worker/IPC/provider，不发模型请求
```

如果 worker 不在仓库标准路径：

```bash
OPEN_COWORK_NATIVE_WORKER_PATH=/absolute/path/OpenCowork.Native.Worker npm run dev
# 或
npm run dev -- --worker /absolute/path/OpenCowork.Native.Worker
```

provider、模型、permission policy 和普通设置从 `~/.open-cowork/` 读取，与 Electron 应用
共用。`/model` 每次打开都会重新读取渠道：只显示已启用、已完成认证并启用了 chat model
的 provider，按 provider 分组，支持搜索 provider 名、模型名和 model ID。确认选择后会将当前
provider/model 写回共享配置，下一次 CLI 或桌面端启动时都会使用该选择；凭据仍由桌面端的
Settings → Models 管理，不会复制到 CLI 配置。

## 命令参数

```text
opencowork [prompt]
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
- assistant/thinking/tool/retry/compression/error/loop-end 等主要事件。
- Native Worker approval overlay，支持 allow once/session/deny。
- worker 原生代码工具与 persistent Task 工具的 v2 manifest/catalog。
- Native Worker `Task` sub-agent：读取同一份 `~/.open-cowork/agents/`，子 Agent 继承父级
  工具（不含 `Task`），thinking/text/tool/report 进度投影到终端任务块。
- `loop_end.messages` 会成为下一轮的 canonical conversation history。
- 与桌面端共用 provider/channel/model store；`/model` 支持渠道分组、实时刷新和搜索。
- `AskUserQuestion` 由 Worker 发起 reverse request，CLI 提供多题、单选/多选、Other、备注和安全纯文本预览；答案以结构化 payload 返回，Worker 再继续原 turn。
- `EnterPlanMode` / `ExitPlanMode` 由 Worker 创建、读取并持久化 `.plan/{planId}.md`；CLI 提供 drafting、review、滚动、批准和带反馈修订界面。批准后的实现仍由 Worker 执行。
- CodeGraph 设置与桌面端共享；启用后动态读取 Worker 的 `codegraph/tools-list`，查询通过同一 Worker 的 `codegraph/*` 路由转发，CLI 不索引、不解析项目。

MCP、Browser、Desktop、Extension、Team UI 等仍需要各自的终端 host adapter，当前不会被 CLI
宣告。完整能力边界和路线图见架构文档。

## 键位

- `/`：命令菜单。
- `?`：快捷键面板。
- 空输入时 `←` 或 `/agents`：打开 Native Worker sub-agent 搜索面板。
- `Shift+Tab`：切换权限模式。
- `Alt/Option+P`：模型选择。
- `Ctrl+O`：工具/思考详情。
- `Ctrl+T`：任务面板。
- `Ctrl+S`：stash/restore prompt。
- `Ctrl+A/E/K/U/W/Y/_`：常见 Emacs 编辑操作。
- `Alt+B/F`：按单词移动。
- `Shift+Enter` 或 `\` + Enter：多行输入。
- `Esc`：关闭菜单；运行中取消；double Esc 清理/rewind 提示。
- `Ctrl+C`：运行中取消、清空输入、空输入时二次退出。

## 验证

```bash
npm run typecheck
npm run build
npm run dev -- --doctor
```

这是独立 Node/TypeScript 包，不属于根目录 npm dependency tree。用户保留的历史入口
`src/index 2.ts` 不参与当前 TypeScript 构建，也不会被 CLI 运行时加载。
