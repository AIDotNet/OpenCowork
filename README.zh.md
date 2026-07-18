<p align="center">
  <a href="https://github.com/AIDotNet/OpenCowork">
    <img src="resources/icon.png" alt="OpenCowork" width="120" height="120">
  </a>
  <h1 align="center">OpenCowork</h1>
  <p align="center">
    <strong>开源桌面多智能体 AI 协作平台</strong><br>
    让 AI 智能体直接访问你的文件系统、执行 Shell 命令、使用丰富工具箱 —— 一切都在你的机器上运行。
  </p>
</p>

<p align="center">
  <img src="images/image.png" alt="OpenCowork 界面预览" width="800">
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="#为什么选择-opencowork">为什么选择</a> •
  <a href="#核心特性">核心特性</a> •
  <a href="#架构">架构</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="https://open-cowork.dev">文档</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-Apache_2.0-green" alt="License">
  <img src="https://img.shields.io/badge/Version-1.2.1-orange" alt="Version">
  <img src="https://img.shields.io/github/stars/AIDotNet/OpenCoWork?style=social" alt="Stars">
  <img src="https://img.shields.io/github/forks/AIDotNet/OpenCoWork?style=social" alt="Forks">
</p>

---

## 🚀 为什么选择 OpenCowork？

大多数 AI 聊天界面与你的实际工作环境是隔离的。你一半的时间花在窗口之间复制粘贴代码、文件内容和终端输出。

**OpenCowork 把智能体放进你的机器：**

- **直接文件系统访问** — 智能体在你的许可下读写、编辑项目文件。
- **Shell 执行** — 无需离开对话即可运行命令、查看日志、管理开发服务器。
- **完整的上下文感知** — 智能体自主探索你的代码库，无需手动喂数据。
- **人在回路** — 透明的工具调用审批系统让你始终拥有最终控制权。

## ✨ 核心特性

### ⚙️ 运行时

- **Electron + 原生 Worker 架构** — 渲染进程（React 19）、Preload 安全桥接、主进程，加上一个按平台编译的 **.NET 10 Native AOT** Worker 子进程，承载 Agent 运行循环并拥有数据库。
- **TypeScript + C# 端到端** — 渲染进程/主进程使用 TypeScript；性能敏感的 Worker（LLM 流式循环、SQLite、CodeGraph 索引）是 AOT 编译的 C#，通过分帧的 MessagePack IPC 协议连接。
- **SSH 远程支持** — 智能体通过 SSH 透明操作远程主机，集成 xterm.js 终端。

### 🔄 5 种 Agent 模式

每次对话选择最合适的模式：

| 模式      | 用途 |
| --------- | ---- |
| `chat`    | 快速对话，不使用文件系统或 Shell 工具。 |
| `clarify` | 提出有据可查的问题，解决歧义，在任何代码编写前产出可审阅的计划。 |
| `cowork`  | 完整 Agent：代码搜索、文件 I/O、Shell、浏览器、子智能体委派等。 |
| `code`    | 结对编程 — 聚焦代码生成和精准编辑，集成 Monaco Editor。 |
| `acp`     | 架构管控：澄清需求、设计方案、分解任务并委派给子智能体执行。 |

### 🧰 工具体系

- **文件与 Shell** — Read、Write、Edit、Glob、Grep、Bash（支持本地和 SSH）。
- **浏览器** — 内置 webview，支持导航、截图、点击、输入和内容提取。
- **任务与团队** — 通过 TaskCreate/TaskUpdate 分解和跟踪工作，通过 Task 派生并行子智能体，通过 TeamCreate/SendMessage/TeamStatus 编排 Agent 团队。
- **Plan Mode** — EnterPlanMode → 编写计划 → ExitPlanMode，产出结构化、可审阅的实现计划。
- **目标追踪** — 创建、跟踪和完成会话级目标，支持 Token 预算。
- **记忆系统** — 分层记忆：全局 SOUL.md / USER.md / MEMORY.md，项目级 .agents/ 覆盖。
- **Cron 智能体** — 调度周期性或一次性后台智能体任务，支持多渠道交付。
- **MCP 客户端** — 连接 Model Context Protocol 服务器（stdio、SSE、streamable-HTTP），并将启用的 MCP 工具直接暴露给 Agent。
- **技能系统** — 从技能市场安装领域特定技能；运行时动态加载并呈现给智能体。
- **自定义扩展** — 通过声明式 HTTP 工具、沙箱 JS 处理器和自定义 HTML 渲染器构建插件。
- **CodeGraph** — 按需构建仓库代码图谱索引（tree-sitter，运行在原生 Worker 内），提供可视化图谱浏览界面，并向智能体暴露结构化工具（`codegraph_explore`、搜索、调用方/被调用方、影响面分析）。

### 🎨 不止聊天

- **绘图（Draw）** — 节点图画布（文本/图片/配置节点 + 连线），用于编排图片和视频生成流程，包含 Seedance 视频生成。
- **桌面宠物** — 可选的桌面陪伴角色，支持经验值、皮肤和工作/学习离开状态追踪。
- **Hooks** — 生命周期自动化钩子，支持按钩子设置信任和启停。

### 💬 8 大通讯平台集成

| 平台             | 支持 |
| ---------------- | ---- |
| 飞书 / Lark      | ✅   |
| 钉钉             | ✅   |
| Discord          | ✅   |
| QQ               | ✅   |
| Telegram         | ✅   |
| 企业微信         | ✅   |
| 微信公众号       | ✅   |
| WhatsApp         | ✅   |

### ⏰ 持久化

- **SQLite** — 消息、会话、项目、任务和计划重启不丢失。数据库运行在原生 Worker 内部（内置 `e_sqlite3`），渲染进程/主进程通过 IPC 访问 — 数据链路里已不再有直接的 Node SQLite 绑定。
- **增量 Schema** — 仅在列不存在时添加，无迁移文件，无数据丢失。

### 🌐 国际化

支持 16 种语言 — 中文、英文、阿拉伯语、德语、西班牙语、法语、印尼语、意大利语、日语、韩语、荷兰语、葡萄牙语、俄语、泰语、土耳其语、越南语 — 全部通过 i18next 实现。

## 🏗️ 架构

```
渲染进程 (React 19)  ←→  Preload (contextBridge)  ←→  主进程  ←→  原生 Worker (.NET 10 AOT)
     │                                                      │                    │
  工具执行、UI、审批、                              IPC 处理器，              Agent 运行循环
  子智能体 & 团队                                Shell/SSH、通讯插件、        （模型流式调用）
                                                  MCP 客户端、Cron 调度器     SQLite (原生 e_sqlite3)
                                                                            CodeGraph 索引
```

- **渲染进程** — React 19 + Tailwind CSS + Zustand 状态管理。负责 UI 与工具调用审批，并执行需要 Electron/Node API 的工具（文件 I/O、Shell、浏览器）。
- **Preload** — 精简的 `contextBridge` API，安全的主↔渲染通信。
- **主进程** — 系统访问：文件系统、Shell、SSH、通讯插件、Cron、MCP 客户端；通过分帧的 MessagePack socket 协议启动并监管原生 Worker。
- **原生 Worker**（`sidecars/OpenCowork.Native.Worker`） — 按平台编译的 .NET 10 Native AOT 二进制程序，拥有 SQLite、驱动 LLM 流式调用循环、运行 CodeGraph 的 tree-sitter 索引。它需要执行渲染进程能力（文件 I/O、Shell、浏览器）的工具时，通过反向 RPC 回调渲染进程。

## 🛠️ 快速开始

**环境要求：** Node.js ≥ 18，npm ≥ 9，以及 [.NET SDK 10](https://dotnet.microsoft.com/download)（含 Native AOT 工作负载）— `npm run dev`/`build` 首次运行会发布原生 Worker 子进程，需要 `dotnet` 在 `PATH` 中。

```bash
git clone https://github.com/AIDotNet/OpenCowork.git
cd OpenCowork
npm install
npm run dev
```

### 常用命令

| 命令                | 说明                                |
| ------------------- | ----------------------------------- |
| `npm run dev`       | 启动 Electron + Vite 热重载开发     |
| `npm run build`     | 类型检查并构建生产版本              |
| `npm run build:win` | 构建 Windows 安装包                 |
| `npm run build:win:green` | 构建 Windows 免安装 zip      |
| `npm run build:mac` | 构建 macOS .dmg/zip                |
| `npm run build:linux` | 构建 Linux .AppImage/.deb        |
| `npm run lint`      | ESLint 检查（带缓存）               |
| `npm run typecheck` | TypeScript 类型检查（主 + 渲染进程）|
| `npm run format`    | Prettier 自动格式化                 |

> **数据目录：** `~/.open-cowork/` — 包含 SQLite 数据库、配置、智能体、技能、命令和提示词。

## 🌟 使用场景

- **自主编程** — 智能体直接在工作区重构代码、调试 Bug、编写代码。
- **定时运维** — Cron 智能体监控日志或系统状态并汇报至飞书/钉钉/Slack。
- **数据调研** — 抓取网页、处理 CSV、生成带图表的报告。
- **远程管理** — 通过 SSH 操作远程服务器，无需离开应用。

## 📖 文档

完整文档请访问 **[open-cowork.dev](https://open-cowork.dev)** — 基于 Fumadocs + Next.js 构建。

## 🤝 参与贡献

欢迎任何形式的贡献！请参阅 [AGENTS.md](AGENTS.md) 了解开发指南、编码规范和提交消息格式。

### 特别感谢

<a href="https://routin.ai/"><img width="154" height="151" src="./resources/images/readme/RoutinAI.png" alt="RoutinAI"></a>

**[RoutinAI](https://routin.ai/)** — 企业级统一大语言模型 API 网关，通过单一的、类型安全的接口访问 GPT、Claude 和 Gemini 系列的 100+ 模型。

<a href="https://github.com/GeneralLibrary/GeneralUpdate"><img width="154" height="151" src="./imgs/LOGO白2.png" alt="GeneralUpdate"></a>

**[GeneralUpdate](https://github.com/GeneralLibrary/GeneralUpdate)** — 跨平台 .NET 应用自动升级组件。

## 💝 赞助商

- [lchlfe@hotmail.com](mailto:lchlfe@hotmail.com)
- [caomaohanfengZT](https://github.com/caomaohanfengZT)
- [struggle3](https://github.com/struggle3)

## 📜 许可证

[Apache License 2.0](LICENSE)

---

<div align="center">

⭐ 如果这个项目对你有帮助，请点亮一颗 Star。

由 **AIDotNet** 团队倾情打造 ❤️

</div>
