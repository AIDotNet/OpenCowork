# AGENTS.md

## Project Overview

OpenCowork is an open-source desktop platform for multi-agent AI collaboration. It provides local tools (file I/O, shell, code search), parallel sub-agent orchestration, and workplace messaging integration. Built with Electron + React + Node.js.

**Target users:** Developers who want AI agents to work directly in their local codebase with tool access, context awareness, and human-in-the-loop approvals.

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Electron | 36.9.5 |
| Frontend | React | 19.2.4 |
| Language | TypeScript | strict |
| State | Zustand | - |
| Styling | Tailwind CSS v4 | - |
| Editor | Monaco Editor | - |
| Terminal | xterm.js | 6.x |
| Database | better-sqlite3 | - |
| i18n | react-i18next | en/zh |
| Build | electron-vite + electron-builder | - |
| Node.js | >= 18 | - |

## Project Structure

```
src/
├── main/                    # Electron main process (system layer)
│   ├── index.ts             # App bootstrap, window lifecycle, zoom support
│   ├── channels/            # 8 messaging platform plugins
│   │   ├── providers/       # dingtalk, discord, feishu, qq, telegram, wecom, weixin, whatsapp
│   │   ├── base-plugin-service.ts  # Abstract plugin contract
│   │   ├── channel-manager.ts      # Plugin lifecycle
│   │   └── plugin-commands.ts      # /help, /new, /status, /compress, /stats
│   ├── cron/                # Scheduled task agent runtime
│   ├── db/                  # SQLite DAOs (10 tables)
│   ├── ipc/                 # IPC handlers (~35 files)
│   ├── mcp/                 # Model Context Protocol client
│   ├── ssh/                 # SSH/terminal support
│   └── migration/           # OpenCode migration tool
├── preload/                 # Secure bridge (contextBridge only)
├── renderer/src/            # React 19 UI
│   ├── components/          # UI components
│   │   ├── chat/            # Chat interface, input, messages, tool calls
│   │   ├── cowork/          # Collaboration panels (ACP, cron, files, teams)
│   │   ├── layout/          # Sidebar, session list, detail panels
│   │   ├── settings/        # Provider config, plugins, MCP, migration
│   │   ├── ssh/             # SSH connections, keys, terminal
│   │   ├── tasks/           # Cron tasks, calendar view
│   │   └── terminal/        # Terminal panels
│   ├── hooks/               # React hooks
│   ├── lib/                 # Core logic
│   │   ├── agent/           # Agent loop, sub-agents, teams, context compression
│   │   ├── tools/           # 20+ built-in tools
│   │   ├── api/             # LLM API clients
│   │   ├── mcp/             # MCP tool integration
│   │   └── ipc/             # Renderer-side IPC client
│   ├── locales/             # i18n JSON files (en/zh, 7 namespaces)
│   └── stores/              # 24 Zustand stores
└── shared/                  # Cross-process TypeScript contracts
```

**Entry points:** `src/main/index.ts` (main), `src/renderer/src/App.tsx` (renderer)

## Architecture

### Process Model
```
Main Process (Node.js)
├── Window lifecycle
├── SQLite database
├── Agent runtime (js-agent-runtime.ts)
├── Cron scheduler
├── Channel plugins
├── SSH/terminal
└── IPC handlers ←→ Preload (contextBridge) ←→ Renderer (React UI)
```

### Data Flow
```
User Input → InputArea.tsx → chat-store.ts → ipcClient.invoke('agent:run')
→ js-agent-runtime.ts (main process) → LLM API → Stream events
→ agent-store.ts → MessageItem.tsx → User sees response
```

### Key Patterns

**Session Modes:** `chat`, `clarify`, `cowork`, `code`, `acp` — each configures different system prompts, tool sets, and UI behavior. Mode stored in `SessionPromptSnapshot` (chat-store.ts).

**Tool System:** Tools registered in phases via `registerAllTools()` in `src/renderer/src/lib/tools/index.ts`:
1. Core tools (bash, fs, search, browser, etc.)
2. Skills (async loaded from `resources/skills/`)
3. Sub-agents (specialized agents)
4. Teams (parallel agent orchestration)

Each tool: `ToolHandler` interface, receives `ToolContext` with session info, working folder, abort signal, IPC client.

**Channel Plugins:** 8 messaging platforms. Extend `base-plugin-service.ts`. Contract: `onStart()`, `onStop()`, `sendMessage()`, `replyMessage()`, `getGroupMessages()`, `listGroups()`.

**Agent Runtime:** Runs in main process (`js-agent-runtime.ts`). Provider-agnostic — accepts generic provider object. Handles retry, circuit breaking, tool execution routing, approval hand-off, event streaming.

**Context Compression:** Auto-compresses when token count exceeds threshold. Manual trigger via button. System prompt in `agent.json` namespace.

## Zustand Stores

| Store | Purpose |
|-------|---------|
| `chat-store.ts` | Sessions, messages, active project, streaming state |
| `agent-store.ts` | Tool calls, approvals, sub-agent results |
| `settings-store.ts` | App settings, language, theme |
| `provider-store.ts` | LLM provider configs, API keys |
| `ui-store.ts` | View state, sidebar, panels |
| `cron-store.ts` | Scheduled tasks, execution history |
| `ssh-store.ts` | SSH connections, keys, host fingerprints |
| `task-store.ts` | Task definitions, calendar data |
| `plan-store.ts` | Plan review state |
| `channel-store.ts` | Messaging channel configs |
| `mcp-store.ts` | MCP server connections |
| `terminal-store.ts` | Terminal instances |
| `skills-store.ts` | Installed skills |
| `git-store.ts` | Git repos, status, history |

## Built-in Tools

| Tool | Description |
|------|-------------|
| `bash-tool.ts` | Execute shell commands |
| `fs-tool.ts` | Read/write/list files |
| `search-tool.ts` | Search files by pattern/content |
| `browser-tool.ts` | Open URLs in system browser |
| `web-search-tool.ts` | Search the web |
| `cron-tool.ts` | Schedule recurring tasks |
| `skill-tool.ts` | Run installed skills |
| `todo-tool.ts` | Manage task lists |
| `plan-tool.ts` | Create/edit plans |
| `notify-tool.ts` | Send desktop notifications |
| `wiki-tool.ts` | Generate project documentation |
| `widget-tool.ts` | Render UI widgets |
| `ask-user-tool.ts` | Ask user questions |

## Built-in Skills (11)

`csv-pipeline`, `docx`, `email-drafter`, `excel-processor`, `frontend-skill`, `image-ocr`, `pdf`, `post-to-x`, `web-scraper`, `wechat-ui-sender`, `xlsx`

Skills live in `resources/skills/` as folders with `SKILL.md` + `scripts/`. Users can add custom skills in `~/.open-cowork/skills/`.

## Built-in Agents (15)

`api-designer`, `architect-reviewer`, `code-reviewer`, `copywriter`, `cron-agent`, `data-analyst`, `debugger`, `frontend-developer`, `fullstack-developer`, `meeting-summarizer`, `performance-engineer`, `refactor-expert`, `security-auditor`, `test-automator`, `translator`

Agents live in `resources/agents/` as Markdown files with frontmatter. Users can add custom agents in `~/.open-cowork/agents/`.

## Database (SQLite)

10 DAOs under `src/main/db/`:

| DAO | Table | Purpose |
|-----|-------|---------|
| `messages-dao.ts` | messages | Chat messages with metadata |
| `sessions-dao.ts` | sessions | Session configs, mode, project binding |
| `projects-dao.ts` | projects | Project definitions, working folders |
| `tasks-dao.ts` | tasks | Cron task definitions |
| `plans-dao.ts` | plans | Plan review data |
| `usage-events-dao.ts` | usage_events | Token usage tracking |
| `wiki-dao.ts` | wiki | Generated documentation |
| `ssh-dao.ts` | ssh | SSH connections, keys, hosts |
| `draw-runs-dao.ts` | draw_runs | Drawing/image generation runs |

Schema evolves via additive `ensureColumn` calls — no migration files.

## IPC Channels

Renderer calls main via `ipcClient.invoke(channel, ...args)`. Main handlers in `src/main/ipc/*-handlers.ts` (35+ files). Key channels:

- `agent:*` — Agent runtime, streaming, approvals
- `session:*` — Session CRUD
- `git:*` — Git operations
- `ssh:*` — SSH connections, file transfer
- `cron:*` — Task scheduling
- `mcp:*` — MCP server management
- `settings:*` — Settings read/write
- `fs:*` — File system operations
- `shell:*` — Shell command execution

## Coding Rules

- **Formatting:** Prettier — single quotes, no semicolons, 100-col width, no trailing commas
- **EditorConfig:** UTF-8, LF, 2 spaces, final newline
- **Naming:** React components = PascalCase (`Layout.tsx`), stores/helpers = kebab-case (`chat-store.ts`)
- **Commits:** Conventional — `feat(scope):`, `fix(scope):`, `chore(scope):`
- **Path aliases:** `@renderer/*` → `src/renderer/src/*`
- **i18n:** Use `t('key', { defaultValue: 'English text' })` — never hardcode Chinese in UI
- **No tests:** Validate with `npm run typecheck` and `npm run lint`

## Key Commands

```bash
npm run dev          # Start Electron + Vite with hot reload
npm run build        # Typecheck then build
npm run build:win    # Full Windows installer
npm run lint         # ESLint with cache
npm run typecheck    # TypeScript check (both main and renderer)
npm run format       # Prettier
```

## Adding New Features

| What | Where |
|------|-------|
| New UI component | `src/renderer/src/components/<feature>/` |
| New Zustand store | `src/renderer/src/stores/<name>-store.ts` |
| New tool | `src/renderer/src/lib/tools/<name>-tool.ts` + register in `index.ts` |
| New IPC channel | `src/main/ipc/<name>-handlers.ts` + expose in `src/preload/index.ts` |
| New skill | `resources/skills/<name>/SKILL.md` + `scripts/` |
| New agent | `resources/agents/<name>.md` |
| New channel plugin | `src/main/channels/providers/<name>/` + extend `base-plugin-service.ts` |
| New i18n key | Add to both `src/renderer/src/locales/en/*.json` and `zh/*.json` |
| New DB column | Add `ensureColumn` call in `src/main/db/database.ts` |

## Recent Enhancements & UI Patterns

- **Bulk-Select Sidebar:** `selectionMode` + `selectedSessionIds` Set, toggled by `ListChecks` icon
- **Hover-to-Reveal Header:** `max-w-0 opacity-0 group-hover:max-w-[200px]` CSS transition
- **Magic Prompt Enhancer:** AI-powered prompt refinement with Ctrl+Z undo
- **Web Search Toggle:** Globe button with `rounded-full` active state
- **Floating Header:** Absolute-positioned overlays for max chat visibility

## Gotchas

- **Native modules:** `better-sqlite3`, `@jitsi/robotjs`, `ssh2`, `node-pty` require rebuild via `npm run postinstall`. On Windows, `node-pty` is skipped.
- **Data directory:** `~/.open-cowork/` — SQLite DB, config, agents, commands, prompts. Never commit.
- **SQLite schema:** Additive `ensureColumn` only — columns added if absent, never dropped.
- **i18n:** Language detected from OS locale on first launch. Chinese systems default to Chinese.
- **Dev server:** First launch ~30s (compiles 98+ modules). Cached after.
- **Zoom:** Ctrl/Cmd +/- (75%-200%), trackpad pinch (1x-5x). In `src/main/index.ts`.
- **Session runtime router:** `session-runtime-router.ts` buffers message state for background sessions, flushes on foreground.
- **Agent runtime:** Runs in main process, not renderer. Provider-agnostic.
- **Context compression:** Auto-triggers at token threshold. Manual button in UI.
- **Security:** Never commit secrets, `.env`, or `~/.open-cowork/` data.
