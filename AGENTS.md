# Repository Guidelines

## Project Structure & Module Organization

- `src/main/` contains the Electron main process: app lifecycle, windows, IPC, SQLite, cron, plugins, MCP, SSH, updates, and crash handling.
- `src/preload/` exposes secure `contextBridge` APIs only. Keep business logic out of preload.
- `src/renderer/src/` hosts the React 19 UI, including `components/`, `stores/`, `hooks/`, `lib/`, `locales/`, and `assets/`.
- `src/shared/` stores TypeScript types and constants shared across processes.
- `src/dotnet/OpenCowork.Agent/` is the .NET sidecar for isolated or high-performance agent execution.
- Runtime assets live under `resources/agents`, `resources/skills`, `resources/prompts`, `resources/commands`, and `resources/sidecar`.
- `docs/` contains the documentation site. Do not edit generated outputs in `dist/`, `out/`, `build/`, or `node_modules/`.

## Build, Test, and Development Commands

- `npm install` installs root dependencies.
- `npm run dev` starts Electron + Vite for local development.
- `npm run start` previews the packaged app output.
- `npm run lint` runs ESLint checks.
- `npm run typecheck` validates both Node and renderer TypeScript.
- `npm run format` applies Prettier formatting.
- `npm run build` typechecks and builds the main and renderer bundles.
- `npm run build:sidecar` or `npm run build:sidecar:win|mac|linux` builds the .NET sidecar.
- `npm run build:unpack` validates a local unpacked package.

## Coding Style & Naming Conventions

Use UTF-8, LF line endings, 2-space indentation, single quotes, no semicolons, and a 100-character line width. TypeScript runs in strict mode. Use PascalCase for React components such as `Layout.tsx`, and kebab-case for non-component modules such as `settings-store.ts`. Renderer imports may use the `@renderer/*` alias.

## Testing Guidelines

No dedicated automated test suite is configured. For any code change, run `npm run lint` and `npm run typecheck`. For IPC, main-process, or renderer interaction changes, also run `npm run dev` and perform a smoke test. For sidecar or packaging work, build the relevant sidecar target before packaging.

## Commit & Pull Request Guidelines

Recent history mainly uses Conventional Commit prefixes such as `feat(ui)`, `feat(chat)`, `feat(sidebar)`, and `refactor`. Prefer the fuller `type(scope): summary` form, for example `feat(main): add cron validation`; use clear release or chore commits for version bumps. Keep pull requests focused on one goal and include scope, verification steps, commands run, linked issues, and screenshots or recordings for UI changes.

## Security & Configuration Tips

Never commit secrets, private keys, `.env` files, local runtime data, or download caches. Pass sensitive values through configuration or parameters. Double-check packaging entries and sidecar assets before release.
