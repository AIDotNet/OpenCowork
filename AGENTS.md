# Repository Guidelines

OpenCowork is an Electron desktop app plus a terminal CLI that share one .NET Native Worker. Keep process boundaries explicit: system access stays in Main, UI state stays in Renderer, the agent loop belongs in the Worker, shared types go through `src/shared`.

## Project Structure & Module Organization

```
src/
├── main/              # Electron main — host gateway, IPC, SQLite, channels, cron, MCP, SSH
│   ├── index.ts       # App bootstrap, window lifecycle
│   ├── channels/      # Messaging plugins (Feishu, DingTalk, Discord, QQ, Telegram, WeCom, Weixin, WhatsApp)
│   ├── cron/          # Scheduled-task assembly (calls Worker agent/run)
│   ├── db/            # SQLite DAOs; schema via additive ensureColumn only
│   ├── ipc/           # IPC handlers + native-agent-runtime.ts (handshake/subscribe shim)
│   ├── mcp/           # MCP clients
│   ├── goals/         # Goal persistence
│   ├── sync/          # WebDAV sync
│   └── ssh/           # SSH / node-pty
├── preload/           # Narrow contextBridge; no nodeIntegration shortcuts
├── renderer/src/      # React 19 UI (Zustand, i18n, Tailwind v4)
│   ├── components/    # chat, cowork, settings, ssh, tasks, …
│   ├── lib/           # presentation, tool catalog, runtime clients
│   ├── locales/       # 16 languages, namespaced JSON
│   └── stores/        # Zustand stores
├── components/        # Shared React (cross-cutting)
├── hooks/
├── lib/
└── shared/            # Cross-process contracts (runtime-contracts/, worker protocol)

cli/                   # @aidotnet/opencowork Ink TUI — see cli/AGENTS.md
sidecars/
├── OpenCowork.Native.Worker/  # C# Native AOT worker (agent loop, tools, jobs)
└── codegraph/                 # Git submodule → AIDotNet/CodeGraph (+ shared Worker.Runtime)

resources/             # Bundled runtime assets (not compiled source)
├── agents/            # Bundled agent defs (Markdown + frontmatter)
├── skills/            # Bundled skills (SKILL.md + scripts/)
├── prompts/           # Mode prompt templates
├── commands/
├── extensions/        # Bundled extensions (product-design, creative-production, …)
└── souls/
```

**Entry points:** `src/main/index.ts` (main), `src/renderer/src/App.tsx` (renderer), `cli/src/index.tsx` (CLI), `sidecars/OpenCowork.Native.Worker/Program.cs` (worker).

**Key architectural patterns:**

- **IPC:** Renderer calls `ipcClient.invoke(channel)`; Main handles in `src/main/ipc/*-handlers.ts`. New runtime code must use the generated runtime API (`src/shared/runtime-contracts/`), not ad-hoc channel strings.
- **Agent runtime:** The runtime owns the provider loop, tool execution, approvals, cancellation, hosted sessions, and durable jobs/events. `src/main/ipc/native-agent-runtime.ts` is only the handshake/subscribe/request/lifecycle shim. Interactive runs start from the renderer via `agent:run`; cron assembles them in Main. Both call `agent/run`. Never iterate a provider or execute a tool from Main or Renderer. Boundaries: `docs/architecture/agent-runtime-boundaries.md`. ADR: `docs/adr/0001-agent-runtime-authority.md`.
- **One runtime, HTTP only:** `getNativeWorker()` returns a `WorkerRuntimeClient` (`src/shared/worker-runtime-client.ts`), always the .NET Native Worker child process, reached over a loopback HTTP API (`--http-token`, required; `POST /rpc`, `POST /cancel`, `GET /events?consumerId=…` SSE, `GET /reverse` SSE, `GET /health`, port published on stdout). Shared wire: `src/shared/worker-http-channel.ts`. There is no socket fallback. Reverse RPC has its own stream so a stalled event consumer cannot block an approval; `/events` is per-consumer so the renderer and the host each keep their own durable cursor.
- **Renderer talks to the worker directly:** commands and queries go from the window to `/rpc` (`src/renderer/src/lib/runtime/worker-http-client.ts`), and each window subscribes to `/events` under its own durable consumer id (`src/renderer/src/lib/runtime/worker-event-stream.ts`), checkpointing after it applies. Main supplies the endpoint and token through `sidecar:connection`. Keep a channel in Main only when Main contributes state the renderer does not have (hooks, permission policy, goals, window routing) — not as a transport hop.
- **Desktop vs CLI:** Two clients of one worker and `~/.open-cowork/` data. The CLI must not grow a parallel provider client, tool executor, or credential store.
- **Tool system:** Worker executes tools. Renderer `src/renderer/src/lib/tools/` is a catalog / legacy / UI-only layer (`ToolHandler` in `tool-types.ts`). Register via `registerAllTools()` in phases (core → skills → sub-agents → teams). WebSearch, CodeGraph, and channel plugins register dynamically from settings.
- **Session modes:** `chat`, `clarify`, `cowork`, `code`, `acp` — distinct prompts/tools/UI. Mode lives in `SessionPromptSnapshot` (`chat-store.ts`).
- **SQLite:** Additive `ensureColumn` in `src/main/db/database.ts` — never drop columns; no migration files. Main is the single writer of desktop session/message tables.
- **Data directory:** `~/.open-cowork/` — `data.db`, user `prompts/`, `agents/`. Never commit it. User skills: `~/.agents/skills/` (Worker skill catalog).

## Submodules

Clone with `--recurse-submodules` (or `git submodule update --init --recursive`). `sidecars/codegraph` is required: Native Worker source-links `OpenCowork.Worker.Runtime` and CodeGraph.Core from it. `predev.mjs` and `publish-native-worker.mjs` fail early if it is missing. Shared-runtime changes land in CodeGraph first, then bump the pinned SHA here.

Requires Node.js ≥ 18 and the .NET 11 SDK (see `global.json`) with Native AOT prerequisites.

## Build, Test, and Development Commands

```bash
npm run dev                 # Electron + Vite (predev checks the submodule)
npm run build               # typecheck (node + web + CLI) then electron-vite build
npm run build:win           # Windows installer
npm run build:win:green     # Windows no-install zip
npm run build:mac           # macOS .dmg/zip
npm run build:linux         # Linux .AppImage/.deb
npm run lint                # ESLint with cache
npm run typecheck           # tsc for tsconfig.node.json, tsconfig.web.json, and cli/
npm run format              # Prettier
npm run postinstall         # Rebuild native addons for Electron
npm run contracts:check     # Generated worker/runtime contracts are in sync
npm run verify:architecture # Import-boundary ratchet vs baseline
npm run cli:test            # Build CLI then Node test suite (from repo root)
```

**CI:** `.github/workflows/build.yml` on release publish (and manual dispatch). Compiles then packages Windows (x64, arm64), macOS (arm64, amd64), Linux (x64, arm64). Checkout uses `submodules: recursive`. The compile job also runs `contracts:check`, `verify:runtime-protocol`, `verify:architecture`, `verify:runtime-projection`, `verify:runtime-baseline`, and `typecheck`.

## Coding Style & Naming Conventions

| Rule             | Convention                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formatting       | Prettier: single quotes, no semicolons, 100-col width, no trailing commas                                                                                                                                                                              |
| Indentation      | 2 spaces, LF, UTF-8, final newline (EditorConfig)                                                                                                                                                                                                      |
| React components | PascalCase (`Layout.tsx`)                                                                                                                                                                                                                              |
| Stores/helpers   | kebab-case (`chat-store.ts`)                                                                                                                                                                                                                           |
| Path aliases     | `@renderer/*` → `src/renderer/src/*`                                                                                                                                                                                                                   |
| i18n             | `t('key', { defaultValue: 'English text' })` — never hardcode Chinese in UI. Namespaced JSON under `src/renderer/src/locales/` (common, layout, chat, settings, cowork, agent, ssh, pet, taskboard). Language is static at init; changes need restart. |
| Comments         | Intent, invariants, boundaries — not restating the code.                                                                                                                                                                                               |
| CLI              | ESM relative imports ending in `.js`; do not hand-edit `cli/src/vendor/*` (generated by `cli/scripts/sync-shared.mjs`).                                                                                                                                |

Run `npm run lint` and `npm run format` before pushing.

## Testing Guidelines

There is no root Electron/renderer test suite. Validate with:

- `npm run typecheck` — required for behavioral changes
- `npm run lint`
- `npm run contracts:check` and `npm run verify:architecture` when touching runtime protocol or layer imports
- Manual smoke via `npm run dev`
- CLI: `npm run cli:test` (tests load `cli/dist`; rebuild first). Update PTY goldens only with `UPDATE_GOLDEN=1` from `cli/`
- Runtime changes: test with at least two LLM providers

Do not regenerate `scripts/architecture-boundary-baseline.json` to hide a new import violation.

## Commit & Pull Request Guidelines

Conventional Commits:

```
feat(scope): description
fix(scope): description
chore(scope): description
refactor(scope): description
```

Keep commits focused; don't mix refactors with behavior changes.

PRs: link the issue, say what/why, screenshots for UI, `npm run typecheck` and `npm run lint` green.

When bumping `package.json` version, keep download/release notes aligned with GitHub Release assets.

## Security & Configuration Tips

- API keys live in `~/.open-cowork/.env` (auto-loaded). Never commit `.env`.
- Native addons (`better-sqlite3`, `@jitsi/robotjs`, `ssh2`, `node-pty`) need Electron-compatible builds (`npm run postinstall`). `cpu-features` is overridden to a noop. They are `asarUnpack`'d.
- User data stays in `~/.open-cowork/`. Do not reach system-wide credentials or other users' directories.
- All renderer↔main traffic is typed IPC. Never expose raw Node APIs to the renderer.

## Agent-Specific Instructions

- **Prompts:** Bundled in `resources/prompts/`; user overrides in `~/.open-cowork/prompts/`. Loaded via IPC (`prompt-loader.ts` → `prompts:load`). Each mode has its own template.
- **Tools:** Prefer Worker modules under `sidecars/OpenCowork.Native.Worker/Modules/`. Remaining renderer handlers must implement `ToolHandler` and register in `src/renderer/src/lib/tools/index.ts`. Slow Worker routes use `RegisterJob(...)`.
- **Runtime protocol:** New commands/queries/events belong in `src/shared/runtime-contracts/model.ts`, then `npm run contracts:gen`. Do not add a third agent loop; extend one of the two backends behind `WorkerRuntimeClient`.
- **MCP:** Loaded dynamically. Test connected and disconnected servers.
- **Skills & agents:** Bundled skills `resources/skills/`; bundled agents `resources/agents/`. Custom skills `~/.agents/skills/`; custom agents `~/.open-cowork/agents/`.
- **Extensions:** Bundled under `resources/extensions/`. Use the `create-extension` skill for new ones.
- **Native Worker modules:** Implement `IWorkerModule`, register in `Hosting/WorkerModuleCatalog.cs`, add serialized types to `Serialization/WorkerJsonContext.cs` (Native AOT).
