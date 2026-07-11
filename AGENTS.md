# Repository Guidelines

## Project Structure & Module Organization

OpenCowork is a 4-layer Electron desktop app (Main → Preload → Renderer → Agent runtime).

```
src/
├── main/              # Electron main process — system access & IPC handlers
│   ├── index.ts       # App bootstrap, window lifecycle, zoom
│   ├── channels/      # Messaging plugins (Feishu, DingTalk, Discord, QQ, etc.)
│   ├── cron/          # Scheduled task agent runtime
│   ├── db/            # SQLite DAOs (messages, sessions, projects, tasks, plans)
│   ├── ipc/           # IPC handlers (main ↔ renderer bridge)
│   ├── mcp/           # Model Context Protocol client
│   ├── goals/         # Goal/task persistence and lifecycle
│   ├── sync/          # WebDAV sync for cross-device state
│   ├── lib/           # Main-process utilities
│   ├── migration/     # Legacy migration helpers
│   └── ssh/           # SSH/terminal support
├── preload/           # Secure bridge — narrow API surface
├── renderer/src/      # React 19 UI
│   ├── components/    # UI components (chat, cowork, settings, ssh, tasks)
│   ├── hooks/         # React hooks
│   ├── lib/           # Agent loop, tools, API clients, utilities
│   ├── locales/       # i18n JSON files (en/zh plus 11 other languages)
│   └── stores/        # Zustand stores
├── components/        # Shared React components (cross-cutting)
├── hooks/             # Shared React hooks (cross-cutting)
├── lib/               # Shared utilities (cross-cutting)
└── shared/            # Cross-process TypeScript contracts
```

**Entry points:** `src/main/index.ts` (main process), `src/renderer/src/App.tsx` (renderer).

**Key architectural patterns:**
- **IPC:** Renderer calls `ipcClient.invoke(channel)`, main handles in `src/main/ipc/*-handlers.ts`.
- **Agent runtime:** Runs in main process (`js-agent-runtime.ts`), provider-agnostic.
- **Tool system:** Tools in `src/renderer/src/lib/tools/`, registered in phases (core → skills → sub-agents → teams).
- **Session modes:** `chat`, `clarify`, `cowork`, `code`, `acp` — each with distinct prompts/tools/UI.
- **SQLite schema:** Evolves via additive `ensureColumn` — columns added if absent, never dropped. No migration files.
- **Data directory:** `~/.open-cowork/` — never commit its contents.

## Build, Test, and Development Commands

```bash
npm run dev          # Start Electron + Vite with hot reload
npm run build        # Typecheck (main + renderer) then build
npm run build:win    # Full Windows installer (electron-builder)
npm run build:win:green # Windows no-install zip
npm run build:mac    # macOS .dmg/zip
npm run build:linux  # Linux .AppImage/.deb
npm run lint         # ESLint with cache
npm run typecheck    # TypeScript check (tsc --noEmit for both tsconfig.node.json & tsconfig.web.json)
npm run format       # Prettier (single quotes, no semicolons, 100-col width)
npm run postinstall  # Rebuild native modules (better-sqlite3, robotjs, ssh2, node-pty) for Electron
```

**CI:** GitHub Actions (`build.yml`) builds on release publish across Windows (x64, arm64), macOS (arm64, amd64), and Linux (x64, arm64). Artifacts uploaded to the GitHub Release. Manual dispatch also supported for debugging.

## Coding Style & Naming Conventions

| Rule             | Convention                                                    |
| ---------------- | ------------------------------------------------------------- |
| Formatting       | Prettier: single quotes, no semicolons, 100-col width, no trailing commas |
| Indentation      | 2 spaces, LF line endings, UTF-8, final newline (EditorConfig) |
| React components | PascalCase (`Layout.tsx`)                                     |
| Stores/helpers   | kebab-case (`chat-store.ts`)                                  |
| Path aliases     | `@renderer/*` → `src/renderer/src/*`                          |
| i18n             | `t('key', { defaultValue: 'English text' })` — never hardcode Chinese in UI |
| Comments         | Explain intent, invariants, boundaries, or non-obvious behavior. Avoid restating the code. |

**Lint/format on save:** ESLint + Prettier enforce these rules automatically. Run `npm run lint` and `npm run format` before pushing.

## Testing Guidelines

**There is no test suite.** Validation is done through:

- `npm run typecheck` — TypeScript compilation check across both main and renderer
- `npm run lint` — ESLint static analysis
- Manual smoke testing via `npm run dev`

When adding behavioral changes, verify with `npm run typecheck` at minimum.

## Commit & Pull Request Guidelines

**Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): description        # New feature
fix(scope): description         # Bug fix
chore(scope): description       # Maintenance, deps, build
refactor(scope): description    # Code restructuring without behavior change
```

Examples from the history: `feat(app): add code workspace and runtime enhancements`, `fix(mcp): expose connected MCP tools in chat`, `chore(release): bump version to 0.9.118`.

**Pull requests:**
- Link the relevant issue (if any).
- Include a brief description of what changed and why.
- Attach screenshots for UI changes.
- Ensure `npm run typecheck` and `npm run lint` pass.

## Security & Configuration Tips

- **Environment variables:** Store API keys in `~/.open-cowork/.env` (auto-loaded). Never commit `.env` files.
- **Native modules:** `better-sqlite3`, `robotjs`, `ssh2`, `node-pty` require Electron-compatible builds. Run `npm run postinstall` after dependency changes.
- **Data isolation:** Each user's data lives in `~/.open-cowork/`. The app never accesses system-wide credentials or other user directories.
- **IPC security:** All renderer-to-main communication goes through typed IPC channels. Never expose raw Node.js APIs to the renderer.

## Agent-Specific Instructions

When modifying agent behavior:
- **Prompts:** Session prompts live in `src/renderer/src/lib/prompts/`. Each mode (`chat`, `cowork`, `code`, etc.) has its own prompt template.
- **Tools:** New tools must be registered in `src/renderer/src/lib/tools/index.ts` and follow the existing interface pattern.
- **Runtime:** The agent runtime (`js-agent-runtime.ts`) is provider-agnostic. Test with at least two different LLM providers when changing runtime logic.
- **MCP integration:** Model Context Protocol tools are loaded dynamically. Changes to MCP handling require testing with both connected and disconnected MCP servers.
