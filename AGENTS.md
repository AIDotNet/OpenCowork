# Repository Guidelines

## Project Structure & Module Organization
- `src/main/` hosts the Electron main process (app lifecycle, window creation) and should remain dependency-light.
- `src/preload/` bridges secure IPC between renderer and main.
- `src/renderer/` contains the React/TypeScript UI; notable sub-folders include `src/lib/agent/` for tool/loop logic, `src/components/` for shadcn-inspired UI blocks, and `src/stores/` for Zustand state.
- Build artifacts land in `build/`, while distributable assets (icons, updater config) live under `resources/` and the repo root.

## Build, Test, and Development Commands
- `npm run dev` — launches electron-vite with hot reload for renderer and main.
- `npm run start` — previews the production build locally.
- `npm run build` — runs both TypeScript targets (`typecheck:node`, `typecheck:web`) then produces packaged bundles.
- `npm run lint` / `npm run format` — enforce ESLint + Prettier baselines; run before commits.
- Platform builds use `npm run build:win|mac|linux`; CI should prefer the platform-specific script.

## Coding Style & Naming Conventions
- Follow `.editorconfig`: UTF-8, LF endings, 2-space indentation.
- TypeScript everywhere; keep strict typing (no `any`) unless unavoidable. React components in PascalCase (`SessionPanel`), hooks prefixed with `use` (`useChatActions`), stores in camelCase suffixed with `Store` (`chatStore`).
- Keep agent/tool modules colocated under `src/renderer/src/lib/agent/**`; export types from `tool-types.ts` to avoid duplication.
- Run Prettier and ESLint before pushing; they are the source of truth for formatting.

## Testing Guidelines
- The project currently relies on TypeScript checks (`npm run typecheck`) and manual electron-vite previewing. When adding automated tests, place renderer tests under `src/renderer/src/__tests__/` and name files `ComponentName.test.tsx`.
- Cover new agent logic with integration-style tests that mock IPC boundaries; aim for meaningful coverage over percentages.

## Commit & Pull Request Guidelines
- Follow the existing imperative, present-tense style (`Add timing display`, `Fix IPC routing`). Keep subjects ≤72 characters and detail reasoning in the body when needed.
- Each PR should: describe the change, link relevant issues/tasks, include screenshots or recordings for UI work, and note any new scripts or config migrations.
- Rebase on `main` before requesting review, ensure `lint`, `typecheck`, and platform build (when affected) pass locally.

## Agent-Specific Notes
- Register new tools via `src/renderer/src/lib/agent/tool-registry.ts` and expose IPC handles from the main process before invoking them.
- Keep tool inputs serializable and document expected side effects inside the tool definition block comments.

## Request Format
- 必须使用中文
- 在做任何复杂的需求之前必须先收集足够的背景资料，然后深刻思考，再进行下一步
