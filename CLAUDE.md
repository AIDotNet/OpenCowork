# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Clone with `--recurse-submodules` (or run `git submodule update --init --recursive` once). The native worker will not build without it — see [Submodules](#submodules).

- `npm run dev` — start Electron + Vite with hot reload (primary dev loop).
- `npm run start` — preview the packaged app output (run after `build`).
- `npm run lint` — ESLint with cache. Minimum validation before committing.
- `npm run typecheck` — runs both `typecheck:node` (main/preload, `tsconfig.node.json`) and `typecheck:web` (renderer, `tsconfig.web.json`). Strict TS.
- `npm run format` — Prettier.
- `npm run build` — typecheck then `electron-vite build`.
- `npm run build:unpack` — build + unpacked app for packaging checks.
- `npm run build:{win|mac|linux}` — full packaged installer.
- Docs workspace (separate Next.js + Fumadocs project in `docs/`): `npm --prefix docs run dev|build|types:check`.

There is no root test suite. For UI/IPC/workflow changes, smoke test with `npm run dev`. For packaging changes, run the corresponding `build:*` command.

## Architecture

Four-layer Electron + .NET Native Worker app. Keep process boundaries explicit — system access stays in main, UI state stays in renderer, agent loop authority belongs in the Worker, shared types go through `src/shared`.

1. **Electron main (`src/main/`)** — system layer. App bootstrap (`index.ts`), window lifecycle, IPC handlers (`ipc/`), SQLite via `better-sqlite3` (`db/`), cron (`cron/`, `node-cron`), channels/plugins for messaging platforms (`channels/`), MCP clients (`mcp/`), SSH (`ssh/`, `ssh2` + `node-pty`), auto-updates (`updater.ts`), crash logging. Main is the host gateway: it supervises the Native Worker, journals/replays in-flight run frames (`runtime-registry.ts`), and is the sole writer of the Worker durable event cursor (`consumerId: 'desktop'`).
2. **Preload (`src/preload/`)** — secure bridge exposing a narrow API surface to the renderer. All main↔renderer traffic goes through here; do not add `nodeIntegration` shortcuts.
3. **Renderer (`src/renderer/src/`)** — React 19 UI. Zustand stores (`stores/`), i18n (`locales/`, `react-i18next`, `en`/`zh`), Tailwind v4, Monaco, xterm, recharts. The renderer owns message presentation, approvals, and session UX. `session-runtime-router.ts` buffers message state for background (non-visible) sessions and flushes it when those sessions come to the foreground. Interactive runs are still constructed in the renderer today (`SidecarAgentRunRequest` via `agent:run`) and forwarded to the Worker; that orchestration is migrating off the renderer — see the target state below.
4. **.NET Native Worker (`sidecars/OpenCowork.Native.Worker/`)** — the agent loop. It owns provider transport, tool execution, hosted sessions (`agent/session-open|send|close`), approvals, cancellation, and the durable job/event outbox. `src/main/ipc/native-agent-runtime.ts` is only the handshake/subscribe/request/notify/lifecycle shim, not a JavaScript provider runtime.

There is no `src/main/ipc/js-agent-runtime.ts`. Cron/background runs are assembled in Main (`src/main/cron/cron-agent-background.ts`) and also call Worker `agent/run`.

Target layering, authority matrix, and protocol rules: [docs/architecture/agent-runtime-boundaries.md](docs/architecture/agent-runtime-boundaries.md). Decision record: [docs/adr/0001-agent-runtime-authority.md](docs/adr/0001-agent-runtime-authority.md).

### IPC wiring

The renderer calls main via `ipcClient.invoke(channel, ...args)` (wraps `ipcRenderer.invoke`). Main-process handlers live in `src/main/ipc/*-handlers.ts` — each file registers `ipcMain.handle(channel, ...)` calls. To add a new IPC channel: add the handler in the appropriate `*-handlers.ts`, expose it through `src/preload/index.ts` if it needs a typed `window.api` entry, and declare the type in `src/preload/index.d.ts`. The preload `window.api` object is for operations that need a typed contract (currently team-runtime plus generated `window.api.runtime`); most IPC still goes through the generic `window.electron.ipcRenderer.invoke(channel)` path. New runtime code must use the generated runtime API, not the generic bridge.

### Session modes

The app supports multiple session modes: `chat`, `clarify`, `cowork`, `code`, `acp`. Each mode configures different system prompts, tool sets, and UI behavior. Mode is stored per-session in `SessionPromptSnapshot` (see `chat-store.ts`).

### Tool system

Renderer-side tool definitions and handlers live in `src/renderer/src/lib/tools/`. Each tool file exports a handler conforming to `ToolHandler` (see `tool-types.ts`). Tools receive a `ToolContext` with session info, working folder, abort signal, and an IPC client. The Native Worker already executes most tools; remaining renderer handlers are legacy or UI-only. Cron/background runs execute through the Worker as well.

Tools are registered in phases via `registerAllTools()` in `src/renderer/src/lib/tools/index.ts`: core tools first, then skills (async), then sub-agents, then teams. Some tools (WebSearch, Browser, Wiki) are registered/unregistered dynamically based on user settings. `ToolContext` carries cross-tool state: `sharedState` (mutable bag for flags like `deliveryUsed`), `readFileHistory` (tracks file reads per run), `inlineToolHandlers` (per-run tool shadowing), and `channelPermissions` (approval checks).

### Channel / messaging plugins

Eight messaging platform integrations under `src/main/channels/providers/`: Feishu, DingTalk, Discord, QQ, Telegram, WeCom, Weixin, WhatsApp. All extend `base-plugin-service.ts`, which defines the abstract contract: subclasses implement `onStart()`, `onStop()`, and messaging methods (`sendMessage`, `replyMessage`, `getGroupMessages`, `listGroups`). The base class handles WebSocket lifecycle and message freshness filtering (15-minute window). Channel manager (`channel-manager.ts`) handles lifecycle; channel descriptors define capabilities.

### Custom skills and agents

Bundled skills live in `resources/skills/` as folders containing a `SKILL.md` metadata file and a `scripts/` subdirectory (typically Python). Bundled agents live in `resources/agents/` as Markdown files with frontmatter (`name`, `description`, `compatibility`). Users can also add custom skills in `~/.agents/skills/` (the Native Worker skill catalog directory) and custom agents in `~/.open-cowork/agents/` — these are loaded at runtime alongside the bundled ones.

### Agent runtime

Interactive runs: the renderer currently builds a `SidecarAgentRunRequest` and invokes `agent:run`; Main forwards it to Worker `agent/run` and streams `agent/stream` envelopes back. Cron runs: Main builds the request and calls `agent/run` itself. The Worker is the loop authority in both cases. `native-agent-runtime.ts` handles `initialize` / event subscribe / reverse requests / worker recycle — it does not iterate the provider or execute tools.

Do not introduce a new JavaScript agent loop in Main or Renderer. New runtime commands, queries, and events belong in `src/shared/runtime-contracts/model.ts` and must go through the generated protocol.

### Data and runtime assets

- User data directory: `~/.open-cowork/`. Contains `data.db` (SQLite), plus user-customizable `prompts/` and `agents/` directories loaded at runtime.
- SQLite schema evolves via additive `ensureColumn` calls in `src/main/db/database.ts` — no migration files; columns are added if absent, never dropped. DAOs: `messages-dao.ts`, `sessions-dao.ts`, `projects-dao.ts`, `tasks-dao.ts`, `plans-dao.ts`, `usage-events-dao.ts`, `wiki-dao.ts`, `ssh-dao.ts`, `draw-runs-dao.ts`.
- Bundled runtime assets (shipped to users, loaded at runtime — not source): `resources/agents`, `resources/skills`, `resources/prompts`, `resources/commands`.

`src/shared/` holds cross-process TypeScript contracts. `src/components`, `src/hooks`, `src/lib` at the repo root (not under `renderer/`) are additional shared utilities.

Generated/ignored: `dist/`, `out/`, `build/`, `node_modules/`. Do not edit.

### Submodules

`sidecars/codegraph` → [AIDotNet/CodeGraph](https://github.com/AIDotNet/CodeGraph). It holds the CodeGraph engine (`OpenCowork.CodeGraph.{Core,Worker,Tests}`) **and** `OpenCowork.Worker.Runtime`, the single source of truth for the worker IPC/dispatch/host contract. `OpenCowork.Native.Worker` source-links both out of the submodule (`Runtime/`, `Hosting/`, `Contracts/`, `Modules/SystemModule.cs`, plus the whole `CodeGraph.Core` tree), so it cannot build with the submodule uninitialized — `predev.mjs` and `publish-native-worker.mjs` fail early with an explicit message when it is missing, and CI must check out with submodules.

Four runtime files stay in `OpenCowork.Native.Worker` because they are worker-specific and deliberately absent from the shared project: `Hosting/WorkerModuleCatalog.cs` and `Runtime/{AgentStreamMessagePackEmitter,ApiUserAgent,WorkerHttpClientFactory}.cs`. Anything else moved or renamed under the shared paths is a two-repo change: land it in CodeGraph first, then bump the pinned SHA here.

The engine also compiles standalone in the submodule (`dotnet build CodeGraph.slnx`, xUnit suite) for the opt-in CodeGraph sidecar binary.

### Native modules

`better-sqlite3`, `@jitsi/robotjs`, `ssh2`, and `node-pty` are native addons rebuilt by `npm run postinstall` (via `scripts/postinstall.mjs`) for the installed Electron version. On Windows, `node-pty` is skipped during rebuild. They are `asarUnpack`'d in `electron-builder.yml` so they load outside the asar archive. `cpu-features` is overridden to a noop (`package.json` overrides).

### Path aliases

Renderer code uses `@renderer/*` → `src/renderer/src/*` (configured in `tsconfig.web.json` and `electron.vite.config.ts`).

### i18n

`react-i18next` with namespaced JSON files under `src/renderer/src/locales/` (`en`/`zh`, split into: common, layout, chat, settings, cowork, agent, ssh). Language is read from `settingsStore.language` at init time — this is static initialization, not reactive. Language changes require an app restart or explicit i18n reload.

## Conventions

- `.editorconfig`: UTF-8, LF, 2 spaces, final newline, trimmed trailing whitespace.
- `.prettierrc.yaml`: single quotes, **no semicolons**, 100-column width, no trailing commas.
- React component files are PascalCase (`Layout.tsx`); stores/helpers/non-component modules are kebab-case (`settings-store.ts`).
- Commit style from history: conventional commits — `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `refactor(scope): ...`, `style(scope): ...`. Keep commits focused; don't mix refactors with behavior changes.
- When bumping the app version in `package.json`, also update the docs homepage version in `docs/src/app/(home)/page.tsx` and keep download links aligned with release assets.
- Never commit local runtime data from `~/.open-cowork/`.
