<p align="center">
  <a href="https://github.com/AIDotNet/OpenCowork">
    <img src="resources/icon.png" alt="OpenCowork" width="120" height="120">
  </a>
</p>

<h1 align="center">OpenCowork</h1>

<p align="center">
  <strong>Open-source desktop platform for multi-agent AI collaboration</strong><br>
  Agents that can read your files, run your shell, and work in your repo — on your machine.
</p>

<p align="center">
  <a href="https://github.com/AIDotNet/OpenCowork/releases/latest"><img src="https://img.shields.io/github/v/release/AIDotNet/OpenCowork?label=Release" alt="Release"></a>
  <img src="https://img.shields.io/badge/License-Apache_2.0-green" alt="License">
  <img src="https://img.shields.io/badge/Version-1.3.23-orange" alt="Version">
  <a href="https://github.com/AIDotNet/OpenCowork/stargazers"><img src="https://img.shields.io/github/stars/AIDotNet/OpenCowork?style=social" alt="Stars"></a>
</p>

<p align="center">
  <a href="README.zh.md">中文文档</a> ·
  <a href="#why-opencowork">Why</a> ·
  <a href="#key-features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="https://github.com/AIDotNet/OpenCowork/releases/latest">Download</a> ·
  <a href="https://open-cowork.dev">Docs</a>
</p>

<p align="center">
  <img src="resources/images/readme/hero.jpg" alt="OpenCowork logo and desktop app" width="920">
</p>

---

## Why OpenCowork?

Most AI chat windows are sealed off from your actual work. You copy files in, paste logs out, and lose context every time you switch tools.

OpenCowork runs the agent **next to the work**:

- **Local filesystem and shell** — read, write, edit, and run commands in the project you already have open.
- **The agent explores** — CodeGraph, search, and tools gather context instead of waiting for you to paste it.
- **You stay in control** — tool calls are visible; approvals stay in the loop.
- **One runtime, two surfaces** — the desktop app and the `cowork` CLI share the same Native Worker, providers, and `~/.open-cowork/` data.

<p align="center">
  <img src="resources/images/readme/cowork.jpg" alt="CoWork — local files and keyboard, agent on your machine" width="920">
</p>

<p align="center">
  <img src="images/image.png" alt="OpenCowork desktop — agent session with tool calls" width="920">
</p>

---

## Key Features

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="resources/images/readme/agents.jpg" alt="Multiple CoWork agents around a shared repository">
      <p><strong>Multi-agent by design.</strong> Sub-agents, Agent Teams, plan mode, and session goals — not a single chat box pretending to be a team.</p>
    </td>
    <td width="50%" valign="top">
      <img src="resources/images/readme/channels.jpg" alt="CoWork hub connected to eight messaging channels">
      <p><strong>Work where the messages are.</strong> Feishu, DingTalk, Discord, QQ, Telegram, WeCom, WeChat Official, and WhatsApp.</p>
    </td>
  </tr>
</table>

### Runtime

- **Electron + .NET Native Worker** — React 19 UI, a narrow Preload bridge, Electron Main as host gateway, and a per-platform **.NET 11 Native AOT** worker that owns the agent loop.
- **Worker-authoritative loop** — provider streaming, tool execution, approvals, cancellation, SQLite, and CodeGraph indexing live in the worker. Main supervises the process; the renderer presents state.
- **SSH** — operate on remote hosts with an integrated xterm.js terminal.

### Five session modes

| Mode      | Purpose |
| --------- | ------- |
| `chat`    | Fast conversation without filesystem or shell tools. |
| `clarify` | Grounded questions and a reviewable plan before any code is written. |
| `cowork`  | Full agent: files, shell, browser, search, sub-agents, teams. |
| `code`    | Pair-programming with focused edits and Monaco. |
| `acp`     | Architecture lead: clarify, design, decompose, and delegate. |

### Toolbox

- **Files & shell** — Read, Write, Edit, Glob, Grep, Bash (local and SSH).
- **Browser** — navigate, snapshot, click, type, extract.
- **Tasks & teams** — TaskCreate / TaskUpdate, parallel `Task` sub-agents, TeamCreate / SendMessage / TeamStatus.
- **Plan mode** — EnterPlanMode → write the plan → ExitPlanMode.
- **Goals & memory** — session goals with token budgets; layered `SOUL.md` / `USER.md` / `MEMORY.md` plus per-project `.agents/` overrides.
- **Cron** — recurring or one-shot background runs, delivered to messaging channels.
- **MCP** — stdio, SSE, and streamable-HTTP servers; enabled tools are exposed to the agent.
- **Skills & extensions** — Skills Market plus bundled extensions (Product Design, Creative Production, HyperFrames, Template Creator, and more).
- **CodeGraph** — on-demand tree-sitter indexing in the worker, with explore / search / callers / impact tools.

### Workspace beyond chat

The nav rail is a workplace, not only a transcript:

| Surface        | What it is |
| -------------- | ---------- |
| Task Board     | Kanban for agent and human work. |
| Tasks / Cron   | Scheduled and one-shot agent jobs. |
| Resources      | Project files and artifacts. |
| Skills / Souls | Domain skills and agent personas. |
| Sync           | WebDAV sync for `~/.open-cowork/` across machines. |
| Draw           | Node-graph canvas for image and video generation pipelines. |
| CodeGraph      | Visual repository graph. |
| SSH            | Dedicated remote terminal window. |

Optional **desktop pet** (XP, skins, away tracking) and **lifecycle hooks** sit beside the same runtime.

### Internationalization

16 languages via i18next: English, Chinese, Japanese, Korean, French, German, Spanish, Portuguese, Russian, Arabic, Italian, Dutch, Turkish, Vietnamese, Thai, and Indonesian.

---

## Architecture

<p align="center">
  <img src="resources/images/readme/architecture.jpg" alt="CoWork on a four-layer runtime stack" width="920">
</p>

```
Renderer (React 19)  ←→  Preload  ←→  Main (host gateway)  ←→  Native Worker (.NET 11 AOT)
     UI, approvals,              windows, IPC,                 agent loop,
     session UX                  channels, MCP, SSH,           tools, SQLite,
                                 cron, worker supervisor       CodeGraph, jobs

CLI (Ink TUI)  ─────────────────────────────────────────────→  same Native Worker
```

| Layer | Owns |
| ----- | ---- |
| **Renderer** | Views, approvals UI, session presentation. Not the agent loop. |
| **Preload** | Narrow `contextBridge` API. No `nodeIntegration` shortcuts. |
| **Main** | Window lifetime, worker process, credentials, OS capabilities, messaging plugins, MCP clients, cron assembly, desktop transcript writer. |
| **Native Worker** | Provider loop, tool catalog and execution, approval policy, cancellation, SQLite, CodeGraph, durable jobs and events. |

Desktop and CLI are two clients of one worker. There is no second JavaScript agent runtime.

Target boundaries: [docs/architecture/agent-runtime-boundaries.md](docs/architecture/agent-runtime-boundaries.md). Decision record: [docs/adr/0001-agent-runtime-authority.md](docs/adr/0001-agent-runtime-authority.md).

---

## Terminal CLI

<p align="center">
  <img src="resources/images/readme/cli.jpg" alt="cowork CLI — install, connect Native Worker, run tools" width="920">
</p>

The CLI is a terminal UI over the same Native Worker. It does not keep a second provider store or a second agent loop.

```bash
npm install -g @aidotnet/opencowork
cowork
```

`opencowork` is an alias for `cowork`. Credentials, models, agents, and settings are shared with the desktop app under `~/.open-cowork/`.

```bash
cowork --doctor
cowork --help
cowork --language zh
```

Requires Node.js ≥ 18. See [cli/README.md](cli/README.md) for keys, `/model`, Plan mode, and worker overrides.

---

## Quick Start

**Desktop from source:** Node.js ≥ 18, npm ≥ 9, and the [.NET 11 SDK](https://dotnet.microsoft.com/download/dotnet/11.0) Preview 7 or newer with the Native AOT prerequisites (`dotnet` on `PATH`). Clone with submodules — the native worker will not build without `sidecars/codegraph`.

```bash
git clone --recurse-submodules https://github.com/AIDotNet/OpenCowork.git
cd OpenCowork
npm install
npm run dev
```

Packaged builds: [GitHub Releases](https://github.com/AIDotNet/OpenCowork/releases/latest) (Windows installer / green zip, macOS 13 or newer, Linux).

| Command                   | Description |
| ------------------------- | ----------- |
| `npm run dev`             | Electron + Vite, hot reload |
| `npm run build`           | Typecheck, then production build |
| `npm run build:win`       | Windows installer |
| `npm run build:win:green` | Windows no-install zip |
| `npm run build:mac`       | macOS .dmg / zip |
| `npm run build:linux`     | Linux .AppImage / .deb |
| `npm run lint`            | ESLint |
| `npm run typecheck`       | TypeScript (main, renderer, CLI) |

Data directory: `~/.open-cowork/` — database, providers, agents, skills, commands, and prompts. Do not commit it.

---

## Use Cases

- **Autonomous coding** — refactor, debug, and land changes in the workspace you already trust.
- **Scheduled ops** — cron agents watch logs or health and report to Feishu / DingTalk / Discord.
- **Research and reports** — browse, scrape, process CSV/Excel, write the document.
- **Remote ops** — SSH into a host without leaving the app.
- **Design and media** — Draw pipelines, Product Design / Creative Production extensions, HyperFrames.

---

## Documentation

Product docs: **[open-cowork.dev](https://open-cowork.dev)**.

In-repo guides: [AGENTS.md](AGENTS.md) (conventions), [cli/README.md](cli/README.md) (terminal client), [docs/architecture/agent-runtime-boundaries.md](docs/architecture/agent-runtime-boundaries.md) (runtime authority).

---

## Contributing

Contributions are welcome. [AGENTS.md](AGENTS.md) covers layout, coding style, and commit messages (`feat(scope): …`).

Please run `npm run typecheck` and `npm run lint` before opening a PR.

### Special Thanks

**[RoutinAI](https://routin.ai/)** — unified LLM API gateway for GPT, Claude, Gemini, and 100+ other models.

**[GeneralUpdate](https://github.com/GeneralLibrary/GeneralUpdate)** — cross-platform auto-update for .NET applications.

## Sponsors

- [lchlfe@hotmail.com](mailto:lchlfe@hotmail.com)
- [caomaohanfengZT](https://github.com/caomaohanfengZT)
- [struggle3](https://github.com/struggle3)

## License

[Apache License 2.0](LICENSE)

---

<p align="center">
  If OpenCowork helps you, star the repo.<br>
  Made by the <strong>AIDotNet</strong> team.
</p>
