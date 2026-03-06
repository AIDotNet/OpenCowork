# Repository Guidelines

## Project Structure & Module Organization

- `src/main`: Electron main process code (IPC handlers, database, plugins, cron, updater).
- `src/preload`: secure bridge APIs exposed to the renderer.
- `src/renderer/src`: React UI and app logic (`components/`, `stores/`, `hooks/`, `lib/`).
- `resources/agents` and `resources/skills`: bundled agent/skill definitions.
- `docs/`: Next.js documentation site with its own `package.json`.
- Generated output directories are `out/` and `dist/`; do not edit them manually.

## Build, Test, and Development Commands

Use `npm` for consistency with CI (`.github/workflows/build.yml` uses `npm ci`).

- `npm install`: install dependencies.
- `npm run dev`: run Electron + Vite in development with hot reload.
- `npm run start`: preview the built app.
- `npm run lint`: run ESLint.
- `npm run typecheck`: run TypeScript checks for node and web configs.
- `npm run format`: format files with Prettier.
- `npm run build`: typecheck then build.
- `npm run build:win`, `npm run build:mac`, `npm run build:linux`: package per platform.

Docs workspace commands:

- `npm --prefix docs run dev`
- `npm --prefix docs run build`
- `npm --prefix docs run types:check`

## Coding Style & Naming Conventions

- `.editorconfig`: UTF-8, LF, 2-space indentation, trim trailing whitespace.
- `.prettierrc.yaml`: single quotes, no semicolons, width 100, no trailing commas.
- Follow ESLint rules in `eslint.config.mjs` (TypeScript + React + hooks).
- Naming patterns in current codebase:
  - React component files: PascalCase (for example, `Layout.tsx`).
  - Most non-component modules: kebab-case (for example, `settings-store.ts`).

## Testing Guidelines

- No root `npm test` script or dedicated `*.test.ts` suite is currently defined.
- Minimum pre-PR checks: `npm run lint` and `npm run typecheck`.
- Run manual smoke tests in `npm run dev` for changed areas.
- For packaging or runtime changes, validate with the relevant `npm run build:<platform>` command.

## Commit & Pull Request Guidelines

- Match existing commit style: concise, imperative subjects (`Add ...`, `Fix ...`, `Bump version ...`).
- Keep each commit focused; avoid mixing unrelated refactors and features.
- PRs should include:
  - Summary of what changed and why
  - Linked issue(s)
  - Verification steps/commands you ran
  - Screenshots/recordings for UI updates
  - Platform impact notes when packaging behavior changes

## Release & Publishing Guidelines

- When bumping the application version or publishing a new release, you MUST update the documentation site accordingly:
  - Update the version number displayed on the documentation homepage (`docs/src/app/(home)/page.tsx`).
  - Ensure the local download links and references match the newly built release assets.

## Security & Configuration Tips

- Do not commit secrets, API keys, or local user data.
- Local runtime config is stored under `~/.open-cowork/` (for example `config.json`, `settings.json`, `data.db`) and should stay out of version control.

<extended_thinking_protocol>
You MUST use extended thinking for complex tasks. This is REQUIRED, not optional.

## CRITICAL FORMAT RULES
1. Wrap ALL reasoning in <think> and </think> tags (EXACTLY as shown, no variations)
2. Start response with <think> immediately for non-trivial questions
3. NEVER output broken tags like "<thi", "nk>", "< think>"

## ADAPTIVE DEPTH (Match thinking to complexity)
- **Simple** (facts, definitions, single-step): Brief analysis, 2-3 sentences in <think>
- **Medium** (explanations, comparisons, small code): Structured analysis, cover key aspects
- **Complex** (architecture, debugging, multi-step logic): Full deep analysis with all steps below

## THINKING PROCESS
<think>
1. Understand - Rephrase problem, identify knowns/unknowns, note ambiguities
2. Hypothesize - Consider multiple interpretations BEFORE committing, avoid premature lock-in
3. Analyze - Surface observations → patterns → question assumptions → deeper insights
4. Verify - Test against evidence, check logic, consider edge cases and counter-examples
5. Correct - On finding flaws: "Wait, that's wrong because..." → integrate correction
6. Synthesize - Connect pieces, identify principles, reach supported conclusion

Natural phrases: "Hmm...", "Actually...", "Wait...", "connects to...", "On deeper look..."
</think>

## THINKING TRAPS TO AVOID
- **Confirmation bias**: Actively seek evidence your initial hypothesis
- **Overconfidence**: Say "I'm not certain" when you'not; don't fabricate
- **Scope creep**: Stay focused on what's asked, don'over-engineer
- **Assumption blindness**: Explicitly state and your assumptions
- **First-solution fixation**: Always consider at least alternative approach

## PRE-OUTPUT CHECKLIST (Verify before responding)
□ Directly answers the question asked?
□ Assumptions stated and justified?
□ Edge cases considered?
□ No hallucinated facts or code?
□ Appropriate detail level (not over/under-explained)?

## CODE OUTPUT STANDARDS
When writing code:
- **Dependencies first**: Analyze imports, file relationships before implementation
- **Match existing style**: Follow codebase conventions (naming, formatting, patterns)
- **Error handling**: Handle likely failures, don't swallow exceptions silently
- **No over-engineering**: Solve the actual problem, avoid premature abstraction
- **Security aware**: Validate inputs, avoid injection vulnerabilities, no hardcoded secrets
- **Testable**: Write code that can be verified; consider edge cases in implementation

## WHEN TO USE <think>
ALWAYS for: code tasks, architecture, debugging, multi-step problems, math, complex explanations
SKIP for: greetings, simple factual lookups, yes/no questions
</extended_thinking_protocol>
