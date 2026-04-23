# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

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

Four-layer Electron + Node.js app. Keep process boundaries explicit — system access stays in main, UI state stays in renderer, shared types go through `src/shared`.

1. **Electron main (`src/main/`)** — system layer. App bootstrap (`index.ts`), window lifecycle, IPC handlers (`ipc/`), SQLite via `better-sqlite3` (`db/`), cron (`cron/`, `node-cron`), channels/plugins for messaging platforms (`channels/`), MCP clients (`mcp/`), SSH (`ssh/`, `ssh2` + `node-pty`), auto-updates (`updater.ts`), crash logging.
2. **Preload (`src/preload/`)** — secure bridge exposing a narrow API surface to the renderer. All main↔renderer traffic goes through here; do not add `nodeIntegration` shortcuts.
3. **Renderer (`src/renderer/src/`)** — React 19 UI. Zustand stores (`stores/`), i18n (`locales/`, `react-i18next`, `en`/`zh`), Tailwind v4, Monaco, xterm, recharts. The renderer owns message presentation, approvals, and session UX. `session-runtime-router.ts` buffers message state for background (non-visible) sessions and flushes it when those sessions come to the foreground.
4. **Main-process agent runtime (`src/main/ipc/js-agent-runtime.ts`, `src/main/cron/cron-agent-background.ts`)** — the unified Node.js agent loop. It owns provider transport, retry/circuit behavior, tool execution routing, approval hand-off, and event streaming back to the renderer over the existing IPC protocol.

Agent execution now runs in the main-process JS runtime. The renderer remains the UI and tool/approval surface; it no longer hosts a separate provider runtime.

### IPC wiring

The renderer calls main via `ipcClient.invoke(channel, ...args)` (wraps `ipcRenderer.invoke`). Main-process handlers live in `src/main/ipc/*-handlers.ts` — each file registers `ipcMain.handle(channel, ...)` calls. To add a new IPC channel: add the handler in the appropriate `*-handlers.ts`, expose it through `src/preload/index.ts` if it needs a typed `window.api` entry, and declare the type in `src/preload/index.d.ts`. The preload `window.api` object is for operations that need a typed contract (currently team-runtime); most IPC goes through the generic `window.electron.ipcRenderer.invoke(channel)` path.

### Session modes

The app supports multiple session modes: `chat`, `clarify`, `cowork`, `code`, `acp`. Each mode configures different system prompts, tool sets, and UI behavior. Mode is stored per-session in `SessionPromptSnapshot` (see `chat-store.ts`).

### Tool system

Renderer-side tool definitions and handlers live in `src/renderer/src/lib/tools/`. Each tool file exports a handler conforming to `ToolHandler` (see `tool-types.ts`). Tools receive a `ToolContext` with session info, working folder, abort signal, and an IPC client. The main-process agent loop in `cron-agent-background.ts` also executes tools directly for cron/background runs.

### Channel / messaging plugins

Eight messaging platform integrations under `src/main/channels/providers/`: Feishu, DingTalk, Discord, QQ, Telegram, WeCom, Weixin, WhatsApp. All extend `base-plugin-service.ts`. Channel manager (`channel-manager.ts`) handles lifecycle; channel descriptors define capabilities.

### Data and runtime assets

- User data directory: `~/.open-cowork/`. Contains `data.db` (SQLite), plus user-customizable `prompts/` and `agents/` directories loaded at runtime.
- SQLite schema evolves via additive `ensureColumn` calls in `src/main/db/database.ts` — no migration files; columns are added if absent, never dropped. DAOs: `messages-dao.ts`, `sessions-dao.ts`, `projects-dao.ts`, `tasks-dao.ts`, `plans-dao.ts`, `usage-events-dao.ts`, `wiki-dao.ts`, `ssh-dao.ts`, `draw-runs-dao.ts`.
- Bundled runtime assets (shipped to users, loaded at runtime — not source): `resources/agents`, `resources/skills`, `resources/prompts`, `resources/commands`.

`src/shared/` holds cross-process TypeScript contracts. `src/components`, `src/hooks`, `src/lib` at the repo root (not under `renderer/`) are additional shared utilities.

Generated/ignored: `dist/`, `out/`, `build/`, `node_modules/`. Do not edit.

### Native modules

`better-sqlite3`, `@jitsi/robotjs`, `ssh2`, and `node-pty` are native addons rebuilt by `npm run postinstall`. They are `asarUnpack`'d in `electron-builder.yml` so they load outside the asar archive. `cpu-features` is overridden to a noop (`package.json` overrides).

### Path aliases

Renderer code uses `@renderer/*` → `src/renderer/src/*` (configured in `tsconfig.web.json` and `electron.vite.config.ts`).

## Conventions

- `.editorconfig`: UTF-8, LF, 2 spaces, final newline, trimmed trailing whitespace.
- `.prettierrc.yaml`: single quotes, **no semicolons**, 100-column width, no trailing commas.
- React component files are PascalCase (`Layout.tsx`); stores/helpers/non-component modules are kebab-case (`settings-store.ts`).
- Commit style from history: conventional commits — `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`, `refactor(scope): ...`, `style(scope): ...`. Keep commits focused; don't mix refactors with behavior changes.
- When bumping the app version in `package.json`, also update the docs homepage version in `docs/src/app/(home)/page.tsx` and keep download links aligned with release assets.
- Never commit local runtime data from `~/.open-cowork/`.
