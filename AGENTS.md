# Repository Guidelines

## Project Structure & Module Organization

- `src/main/`: Electron main process for app lifecycle, window management, IPC routing, SQLite, cron scheduling, plugins, MCP, SSH, auto-update, and crash handling.
- `src/preload/`: secure `contextBridge` APIs exposed to the renderer. Do not place business logic here.
- `src/renderer/src/`: React 19 renderer UI and state layer. Key folders include `components/`, `stores/`, `hooks/`, `lib/`, `locales/`, and `assets/`.
- `src/shared/`: TypeScript types and constants shared across processes.
- `src/dotnet/OpenCowork.Agent/`: .NET sidecar used for high-performance or isolated agent execution.
- Runtime assets live in `resources/agents`, `resources/skills`, `resources/prompts`, `resources/commands`, and `resources/sidecar`.
- Documentation site lives in `docs/`. Build outputs such as `out/`, `dist/`, `build/`, and `node_modules/` should not be edited directly.

## Build, Test, and Development Commands

- `npm install`: install root dependencies.
- `npm run dev`: start Electron + Vite in development mode.
- `npm run start`: preview the packaged app output.
- `npm run lint`: run ESLint checks.
- `npm run typecheck`: run both Node and web TypeScript checks.
- `npm run format`: format files with Prettier.
- `npm run build`: typecheck and build main and renderer bundles.
- `npm run build:sidecar:win|mac|linux`: build the .NET sidecar for a target platform.
- `npm run build:unpack`: validate a local unpacked package.

## Coding Style & Naming Conventions

Use UTF-8, LF line endings, 2-space indentation, single quotes, no semicolons, and a 100-character print width. TypeScript is strict. React component files use PascalCase, for example `Layout.tsx`; non-component modules generally use kebab-case, for example `settings-store.ts`. Renderer imports may use the `@renderer/*` alias.

## Testing Guidelines

There is no standalone `npm test` script. For code changes, run at least `npm run lint` and `npm run typecheck`. For main-process, IPC, or renderer interaction changes, also run `npm run dev` and perform a smoke test. For sidecar or packaging changes, run the relevant sidecar build before packaging.

## Commit & Pull Request Guidelines

Use Conventional Commits such as `feat(scope): ...`, `fix(scope): ...`, and `chore(scope): ...`. Keep each PR focused on one goal. Include the change scope, reproduction or verification steps, commands run, linked issues when applicable, and screenshots or recordings for UI changes.

## Security & Configuration Tips

Never commit secrets, local runtime data, private keys, `.env` files, or download caches. Inject sensitive values through parameters or configuration. Verify packaging entries and sidecar assets before release.
