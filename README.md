<p align="center">
  <a href="https://github.com/AIDotNet/OpenCowork">
    <img src="resources/icon.png" alt="OpenCowork" width="120" height="120">
  </a>
  <h1 align="center">OpenCowork</h1>
  <p align="center">
    <strong>Open-source desktop platform for multi-agent AI collaboration</strong><br>
    Give AI agents local filesystem access, shell execution, and a rich toolbox — all on your machine.
  </p>
</p>

<p align="center">
  <img src="images/image.png" alt="OpenCowork Screenshot" width="800">
</p>

<p align="center">
  <a href="README.zh.md">中文文档</a> •
  <a href="#why-opencowork">Why</a> •
  <a href="#key-features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="https://open-cowork.dev">Docs</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-Apache_2.0-green" alt="License">
  <img src="https://img.shields.io/badge/Version-1.2.1-orange" alt="Version">
  <img src="https://img.shields.io/github/stars/AIDotNet/OpenCoWork?style=social" alt="Stars">
  <img src="https://img.shields.io/github/forks/AIDotNet/OpenCoWork?style=social" alt="Forks">
</p>

---

## 🚀 Why OpenCowork?

Most AI chat interfaces are isolated from your actual work environment. You spend half the time copy-pasting code, file contents, and terminal output between windows.

**OpenCowork puts the agent on your machine:**

- **Direct filesystem access** — Agents read, write, and edit files in your project with your approval.
- **Shell execution** — Run commands, check logs, and manage dev servers without leaving the conversation.
- **Full context awareness** — Agents explore your codebase on their own. No manual context feeding.
- **Human-in-the-loop** — Transparent tool-call approval keeps you in control at every step.

## ✨ Key Features

### ⚙️ Runtime

- **Electron + native worker architecture** — Renderer (React 19), Preload bridge, Main process, and a per-platform **.NET 10 Native AOT** worker sidecar that drives the agent run loop and owns the database.
- **TypeScript + C# end-to-end** — Renderer/main are TypeScript; the performance-critical worker (LLM streaming loop, SQLite, CodeGraph indexing) is AOT-compiled C#, connected over a framed MessagePack IPC protocol.
- **SSH remote support** — Agents operate on remote hosts transparently via SSH with xterm.js terminal integration.

### 🔄 5 Agent Modes

Every conversation picks the right mode:

| Mode      | Purpose |
| --------- | ------- |
| `chat`    | Quick, tool-free conversation — no filesystem or shell access. |
| `clarify` | Ask grounded questions, resolve ambiguity, produce a reviewable plan before any code is written. |
| `cowork`  | Full agent: code search, file I/O, shell, browser, sub-agent delegation, and more. |
| `code`    | Pair programming — focused code generation and surgical editing with Monaco Editor integration. |
| `acp`     | Architecture-control lead: clarify, design, decompose, and delegate implementation to sub-agents. |

### 🧰 Tool System

- **File & Shell** — Read, Write, Edit, Glob, Grep, Bash (local and SSH).
- **Browser** — Built-in webview with navigate, snapshot, click, type, and content extraction.
- **Task & Team** — Decompose work with TaskCreate/TaskUpdate, spawn parallel sub-agents via Task, and orchestrate Agent Teams with TeamCreate/SendMessage/TeamStatus.
- **Plan Mode** — EnterPlanMode → write plan → ExitPlanMode for structured, reviewable implementation plans.
- **Goal Tracking** — Create, track, and complete session-level goals with token budgets.
- **Memory System** — Layered memory: global SOUL.md / USER.md / MEMORY.md and per-project .agents/ overrides.
- **Cron Agent** — Schedule recurring or one-shot background agent tasks with multi-channel delivery.
- **MCP Client** — Connect to Model Context Protocol servers (stdio, SSE, streamable-HTTP) and expose active MCP tools directly to the agent.
- **Skill System** — Install domain-specific skills from the Skills Market; loaded dynamically and surfaced to the agent at runtime.
- **Custom Extensions** — Build plugins with declarative HTTP tools, sandboxed JS handlers, and custom HTML renderers.
- **CodeGraph** — On-demand repository indexing (tree-sitter, in the native worker) with a visual code graph explorer and structural tools (`codegraph_explore`, search, callers/callees, impact) surfaced to the agent.

### 🎨 Beyond Chat

- **Draw** — A node-graph canvas (text/image/config nodes + connections) for wiring up image and video generation pipelines, including Seedance video.
- **Desktop Pet** — An optional on-screen companion with XP, skins, and work/study away-tracking.
- **Hooks** — Lifecycle automation hooks with per-hook trust and enable/disable controls.

### 💬 8 Messaging Plugins

| Platform          | Support |
| ----------------- | ------- |
| Feishu / Lark     | ✅      |
| DingTalk          | ✅      |
| Discord           | ✅      |
| QQ                | ✅      |
| Telegram          | ✅      |
| WeCom (WeChat Work) | ✅   |
| WeChat Official   | ✅      |
| WhatsApp          | ✅      |

### ⏰ Persistence

- **SQLite** — Messages, sessions, projects, tasks, and plans survive restarts. The database lives inside the native worker (bundled `e_sqlite3`), reached from the renderer/main over IPC — there's no direct Node SQLite binding in the data path anymore.
- **Additive schema** — Columns are added when absent; no migration files, no data loss.

### 🌐 Internationalization

16 languages — English, Chinese, Arabic, German, Spanish, French, Indonesian, Italian, Japanese, Korean, Dutch, Portuguese, Russian, Thai, Turkish, and Vietnamese — all via i18next.

## 🏗️ Architecture

```
Renderer (React 19)  ←→  Preload (contextBridge)  ←→  Main Process  ←→  Native Worker (.NET 10 AOT)
     │                                                      │                    │
  Tool execution, UI,                              IPC Handlers,          Agent run loop
  approvals, sub-agents                          Shell/SSH, Messaging     (provider streaming)
  & teams                                        Plugins, MCP Client,     SQLite (native e_sqlite3)
                                                    Cron Scheduler         CodeGraph indexing
```

- **Renderer** — React 19 + Tailwind CSS + Zustand stores. Owns UI and tool-call approval, and executes the tools that need Electron/Node APIs (file I/O, shell, browser).
- **Preload** — Narrow `contextBridge` API for secure main↔renderer communication.
- **Main Process** — System access: filesystem, shell, SSH, messaging plugins, cron, MCP client; spawns and supervises the native worker over a length-prefixed MessagePack socket protocol.
- **Native Worker** (`sidecars/OpenCowork.Native.Worker`) — A per-platform .NET 10 Native AOT binary that owns SQLite, drives the LLM provider streaming loop, and runs CodeGraph's tree-sitter indexing. It calls back into the renderer via reverse-RPC for tool execution it can't do itself.

## 🛠️ Quick Start

**Prerequisites:** Node.js ≥ 18, npm ≥ 9, and the [.NET SDK 10](https://dotnet.microsoft.com/download) with the Native AOT workload — `npm run dev`/`build` publish the native worker sidecar on first run and need `dotnet` on `PATH`.

```bash
git clone https://github.com/AIDotNet/OpenCowork.git
cd OpenCowork
npm install
npm run dev
```

### Key Commands

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Start Electron + Vite with hot reload |
| `npm run build`     | Typecheck then build for production   |
| `npm run build:win` | Build Windows installer               |
| `npm run build:win:green` | Build Windows no-install zip      |
| `npm run build:mac` | Build macOS .dmg/zip                  |
| `npm run build:linux` | Build Linux .AppImage/.deb         |
| `npm run lint`      | ESLint with cache                     |
| `npm run typecheck` | TypeScript check (main + renderer)    |
| `npm run format`    | Prettier auto-format                  |

> **Data directory:** `~/.open-cowork/` — SQLite database, config, agents, skills, commands, and prompts.

## 🌟 Use Cases

- **Autonomous coding** — Agents refactor, debug, and write code directly in your workspace.
- **Scheduled ops** — Cron agents monitor logs or system health and report to Feishu / DingTalk / Slack.
- **Data research** — Scrape web pages, process CSVs, generate reports with charts.
- **Remote management** — Operate on remote servers via SSH without leaving the app.

## 📖 Documentation

Full documentation at **[open-cowork.dev](https://open-cowork.dev)** — built with Fumadocs + Next.js.

## 🤝 Contributing

We welcome contributions! See [AGENTS.md](AGENTS.md) for the development guide, coding conventions, and commit message format.

### Special Thanks

<a href="https://routin.ai/"><img width="154" height="151" src="./resources/images/readme/RoutinAI.png" alt="RoutinAI"></a>

**[RoutinAI](https://routin.ai/)** — Enterprise-grade unified LLM API gateway providing a single, type-safe interface to 100+ models across GPT, Claude, and Gemini families.

<a href="https://github.com/GeneralLibrary/GeneralUpdate"><img width="154" height="151" src="./imgs/LOGO白2.png" alt="GeneralUpdate"></a>

**[GeneralUpdate](https://github.com/GeneralLibrary/GeneralUpdate)** — Cross-platform auto-update component for .NET applications.

## 💝 Sponsors

- [lchlfe@hotmail.com](mailto:lchlfe@hotmail.com)
- [caomaohanfengZT](https://github.com/caomaohanfengZT)
- [struggle3](https://github.com/struggle3)

## 📜 License

[Apache License 2.0](LICENSE)

---

<div align="center">

⭐ If this project helps you, please give it a star.

Made with ❤️ by the **AIDotNet** Team

</div>
