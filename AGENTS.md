# Repository Guidelines

OpenCowork is an Electron desktop app plus a terminal CLI that share one .NET Native Worker. Keep process boundaries explicit: system access stays in Main, UI state stays in Renderer, the agent loop belongs in the Worker, shared types go through `src/shared`.

This file is the working contract for humans and coding agents. Read it before changing code. Prefer a small, well-placed change over a large, clever one.

## Code Design

Design first. Do not start from a file that happens to be open. Decide ownership, data flow, and the existing seam, then write the smallest change that fits.

### Before you write

Answer these in order. If any answer is fuzzy, stop and look at the surrounding module — do not invent a new shape.

1. **Which layer owns this?** Renderer (presentation), Main (host/OS/desktop persistence), Worker (agent loop/tools/jobs), `src/shared` (contracts). Put the code in that layer, not in the caller that first noticed the need.
2. **Does a seam already exist?** IPC handler, Worker module, runtime contract, Zustand store, CLI reducer action, DAO. Extend it. Do not add a parallel path because the existing one feels awkward.
3. **What is the source of truth?** One owner writes; everyone else reads a projection, event, or query. Do not let two layers mutate the same fact.
4. **What is the smallest honest change?** A focused edit that matches neighbors. Not a framework, helper layer, or “while we are here” rewrite.

### Non-negotiable boundaries

| Concern | Owner | Do not |
| --- | --- | --- |
| Provider loop, tool execution, approvals, cancellation, hosted sessions, durable jobs/events | Native Worker | Iterate a provider or execute a tool from Main, Renderer, or CLI |
| Window, process supervision, credentials, OS capabilities, desktop session/message SQLite | Main | Let Renderer or Worker become the desktop transcript writer |
| Message presentation, drafts, scroll, panels, session UX | Renderer / CLI UI | Push UI-only state into the runtime protocol |
| Cross-process types, runtime commands/queries/events | `src/shared` then generated protocol | Ad-hoc channel strings, duplicated DTOs, hand-edited `*.g.cs` / `cli/src/vendor/*` |

- Desktop and CLI are two clients of one worker and `~/.open-cowork/` data. The CLI must not grow a parallel provider client, tool executor, or credential store.
- New runtime commands, queries, and events belong in `src/shared/runtime-contracts/model.ts`, then `npm run contracts:gen`.
- Shared-runtime changes land in the `sidecars/codegraph` submodule first, then bump the pinned SHA here.
- Boundaries: `docs/architecture/agent-runtime-boundaries.md`. ADR: `docs/adr/0001-agent-runtime-authority.md`.

### Reasonable design

**One mechanism per concern.** If the repo already has a Worker module, DAO, store, or reducer for this job, use it. A second “simpler” path is technical debt from day one.

**Own state where it is authoritative.** Derive UI from events and queries. Do not keep a shadow copy that can drift (duplicate run status, duplicate permission flags, duplicate session lists). Optimistic UI is allowed; it must reconcile against the owner.

**Dependencies point inward to contracts, never sideways into another layer’s internals.** Renderer does not import Main. Worker does not import Electron. Main does not execute tools. Shared code must stay process-agnostic — no `window`, `ipcMain`, or Worker-only types leaking into `src/shared` except through the published contract.

**Name the domain, not the workaround.** `sessionId`, `consumerId`, `lanePolicy`, `projection` mean something here. Do not invent `manager`, `helper`, `util`, `data2`, or `handleStuff` to avoid understanding the existing name.

**Keep change size proportional to the problem.** A one-line bug gets a one-line fix. A new tool gets a Worker executor + contract + registration, not a new abstraction pyramid. Do not refactor adjacent code unless it is required for correctness.

**Make failure explicit.** Return typed errors, `WorkerResponse.Error`, or a discriminated result. Do not swallow, retry forever, or map every failure to `null`. If the user must decide (approval, ask-user), that is a reverse request — not a default.

**Native AOT and generated code are design constraints, not afterthoughts.** Worker JSON goes through `WorkerJsonContext`. HTTP handlers stay `HttpContext` + `Utf8JsonWriter` — no reflective serialization, no parameter binding. Slow routes use `RegisterJob(...)`. Generated files are outputs.

**Schema evolves additively.** SQLite in Main uses `ensureColumn` — never drop columns, never add a migration-file system. Protocol versions move only for incompatible changes.

### Design anti-patterns

- A second agent loop, in-process “mini runtime”, or CLI-only tool runner.
- New `ipcMain.handle('foo:bar')` for runtime work that belongs on the generated runtime API.
- Business rules in React components, Ink views, or IPC glue.
- God files: another thousand lines on a store, executor, or `app.tsx` because “it is already there.” Split along a real concept (`*Models`, `*Tools`, `*-store`, reducer action family).
- Copy-paste a provider/executor “with small diffs.” Extract the shared rule, or write a clearly distinct path with a distinct name.
- Features that need a config flag, a store field, *and* a Worker setting before the simplest version works. Start with one owner and one path.
- Abstraction for a single call site (`IFooManager` wrapping one function).
- Catch-all `any`, `JsonElement` smuggling across layers, or `as` casts to silence the type system.

## Code Elegance

Elegant code here looks inevitable: it matches the module’s existing grain, is easy to delete, and does not require a comment to explain its shape.

### Shape

- **Match neighbors.** Same folder layout, same export style, same error pattern, same naming. A correct change that looks foreign will be rewritten.
- **One job per unit.** A function either computes, persists, renders, or dispatches — not all four. A file is a concept, not a junk drawer.
- **Short paths.** Prefer early return over nested `if`. Prefer a named helper over an 8-level closure. Prefer a switch on a discriminated union over boolean soup.
- **No cleverness.** No bit packing, hidden side effects, or “smart” defaults that surprise callers. Obvious beats dense.
- **Delete as you go.** Unused branches, leftover compatibility, and commented-out experiments do not stay “for later.”

### Naming

| Kind | Convention |
| --- | --- |
| React components | PascalCase files (`Layout.tsx`) |
| Stores, helpers, IPC, DAOs | kebab-case (`chat-store.ts`, `messages-dao.ts`) |
| Worker C# types | `AgentRuntime*`, `Db*Tools`, `*Module` — follow the module prefix already in the folder |
| Generated / vendored | Do not rename to taste; change the source of truth |

Names should say what is true after the call (`openHostedSession`, `checkpointConsumer`), not how it is implemented (`doRpc`, `newFn`). Booleans are assertions (`isVisible`, `hasEndpoint`), not `flag` or `status`.

### Types

- TypeScript is strict. Model the domain with unions, literal types, and narrow interfaces. Do not use `any`. Avoid `unknown` unless you immediately narrow it.
- Public functions should have an obvious input and output type. Inference is fine for locals; it is not an excuse for an untyped module boundary.
- C# DTOs are records / sealed types registered in `WorkerJsonContext`. Do not pass anonymous dictionaries through a new API.
- Do not duplicate a type on both sides of IPC. Share it or generate it.

### Control flow and APIs

- Keep functions small enough to name. If you need a table of contents in a comment, split the file along those headings.
- Extract when a concept has a name and at least one invariant (`clampLeftSidebarWidth`, `RequireString`). Do not extract a one-line wrapper used once.
- Parameters that travel together are a type, not an argument list that grows every week.
- Side effects belong at the edge (handler, module entry, command). Pure helpers stay pure.
- Async functions either await meaningfully or are not async. Do not `void` a promise unless the fire-and-forget is documented and owned.

### Comments

Write comments for intent, invariants, and boundaries — never to restate the next line. Do not narrate the diff (`// fix bug`, `// add feature`). If the code needs a long apology, redesign it.

### Renderer / React

- Functional components. Reusable logic goes in hooks or `lib/`; UI state that is not session-authoritative stays local or in the right Zustand store.
- Do not grow `chat-store` / `ui-store` into a dumping ground. New durable UI concerns get their own store or belong on a Worker/Main query.
- i18n: `t('key', { defaultValue: 'English text' })`. Never hardcode Chinese in UI. Namespaced JSON lives under `src/renderer/src/locales/`. Language is static at init; a language change needs an explicit reload.
- Tailwind v4 utilities in the existing visual language. Do not introduce a new CSS pattern for one screen.

### Main / Electron

- IPC handlers live in `src/main/ipc/*-handlers.ts`. Preload stays a narrow `contextBridge`. No `nodeIntegration` shortcuts, no leaking Node APIs to the renderer.
- New runtime code uses the generated runtime API, not the generic `ipcRenderer.invoke` string path.
- Keep a Main channel only when Main contributes state the renderer does not have (hooks, permission policy, goals, window routing) — not as a transport hop.

### Worker / C#

- Implement `IWorkerModule`, register in `Hosting/WorkerModuleCatalog.cs`, serialize through `Serialization/WorkerJsonContext.cs`.
- Prefer `internal sealed` / `internal static` types. One concept per file; split with a clear suffix when a file grows (`DbMessageTools.Compaction.cs`).
- Tools take `JsonElement` at the boundary, then parse into named values immediately. Do not thread raw JSON through the domain.
- Honor Native AOT: no runtime reflection, no `Newtonsoft`, no unbounded dynamic codegen.

### CLI

- ESM relative imports ending in `.js`. Follow `cli/AGENTS.md`.
- Terminal state goes through the reducer (`cli/src/state`), not ad-hoc mutations in components.
- Do not hand-edit `cli/src/vendor/*` (generated by `cli/scripts/sync-shared.mjs`). Update the shared source, then sync.

## Project Structure

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

**Key wiring (do not re-litigate):**

- **IPC:** Renderer calls `ipcClient.invoke(channel)`; Main handles in `src/main/ipc/*-handlers.ts`. Runtime work uses `src/shared/runtime-contracts/`.
- **Agent runtime:** Worker owns the loop. `src/main/ipc/native-agent-runtime.ts` is handshake/subscribe/lifecycle only. Interactive runs: renderer `agent:run` → Worker `agent/run`. Cron: Main assembles and also calls `agent/run`.
- **Transport:** `getNativeWorker()` → `WorkerRuntimeClient` over loopback HTTP (`--http-token` required; `POST /rpc`, `POST /cancel`, `GET /events?consumerId=…`, `GET /reverse`, `GET /health`). Shared wire: `src/shared/worker-http-channel.ts`. No socket fallback. Renderer talks to `/rpc` and `/events` directly; Main supplies endpoint + token via `sidecar:connection`.
- **Tools:** Worker executes. Renderer `src/renderer/src/lib/tools/` is catalog / legacy / UI-only. Register in phases: core → skills → sub-agents → teams.
- **Session modes:** `chat`, `clarify`, `cowork`, `code`, `acp` — distinct prompts/tools/UI. Mode lives in `SessionPromptSnapshot` (`chat-store.ts`).
- **Data:** `~/.open-cowork/` (`data.db`, user `prompts/`, `agents/`). Never commit it. User skills: `~/.agents/skills/`.

## Submodules

Clone with `--recurse-submodules` (or `git submodule update --init --recursive`). `sidecars/codegraph` is required: Native Worker source-links `OpenCowork.Worker.Runtime` and CodeGraph.Core from it. `predev.mjs` and `publish-native-worker.mjs` fail early if it is missing.

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

## Coding Style & Naming

| Rule | Convention |
| --- | --- |
| Formatting | Prettier: single quotes, no semicolons, 100-col width, no trailing commas |
| Indentation | 2 spaces, LF, UTF-8, final newline (EditorConfig) |
| Path aliases | `@renderer/*` → `src/renderer/src/*` |
| Unused names | Prefix with `_` (ESLint `argsIgnorePattern`) |
| CLI | ESM relative imports ending in `.js`; do not hand-edit `cli/src/vendor/*` |

Run `npm run lint` and `npm run format` before pushing. Format is not design: passing Prettier does not make a misplaced abstraction acceptable.

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
- **When implementing:** preserve unrelated user changes; do not drive-by reformat; do not expand scope into adjacent refactors. If the design is wrong, fix the design — do not paper over it with a helper.
