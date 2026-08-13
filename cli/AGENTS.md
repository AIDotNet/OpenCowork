# AGENTS.md

## Package scope
- This is the standalone `cli/` package (`@aidotnet/opencowork`): a Node.js ≥18, TypeScript ESM package. Work from this directory and use npm/package-lock; it is not the repository root npm dependency tree.
- Layout: `src/index.tsx` starts Commander and Ink; `src/app.tsx` owns terminal state; `src/components/` contains UI; `src/runtime/` contains Native Worker adapters; `src/terminal/` controls terminal behavior; `src/lib/` holds shared helpers; `test/` contains Node/PTY tests and committed golden snapshots.

## Runtime boundary
- The CLI is a terminal renderer and host adapter. `OpenCowork.Native.Worker` remains the only agent loop, provider transport, tool dispatcher/executor, permission-policy evaluator, context compressor, sub-agent runtime, and durable data backend.
- Do not add a parallel model/provider client, direct tool execution path, agent loop, duplicate credential store, or simulated production runtime. Use versioned Worker IPC and canonical events instead.
- Do not present OpenCowork UI or documentation as Anthropic or Claude Code.

## Code conventions
- Follow strict TypeScript, ESM relative import specifiers ending in `.js`, React/Ink patterns, 2-space indentation, and the repository’s no-semicolon style.
- Keep non-UI logic in the appropriate `runtime/`, `terminal/`, or `lib/` module; keep components focused on rendering and input state.
- Preserve unrelated user changes. Update `README.md` and `ARCHITECTURE.md` when commands, user-visible behavior, runtime boundaries, or advertised capabilities change.
- `src/vendor/*.ts` is generated from shared repository sources by `scripts/sync-shared.mjs`; do not hand-edit it. In a full-repository task, update the shared source of truth, then sync and review the vendored output.

## Validation
Run from `cli/`:

```bash
npm run typecheck
npm run build
node --test test
```

- Tests load `dist`, so build before running the Node test suite. PTY golden tests use the deterministic fixture runtime and cover terminal-width snapshots.
- Regenerate snapshots only for intentional visual changes with `UPDATE_GOLDEN=1 node --test test`, then review changes under `test/golden/`.
- When a Native Worker and configuration are available, run `npm run dev -- --doctor` for a no-model-request integration check.
