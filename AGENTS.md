# AGENTS.md

## Project Overview

OpenCowork is an open-source desktop platform for multi-agent AI collaboration. It provides local tools (file I/O, shell, code search), parallel sub-agent orchestration, and workplace messaging integration. Built with Electron + React + Node.js.

**Target users:** Developers who want AI agents to work directly in their local codebase with tool access, context awareness, and human-in-the-loop approvals.

**Agent working style:** Be autonomous, read the surrounding code before editing, and prefer the local project patterns over inventing a new approach. When a task touches renderer UI, the safest first pass is usually `WorkspaceSidebar.tsx`, `SessionConversationPane.tsx`, `InputArea.tsx`, and `chat-store.ts` because many chat behaviors hang off those files.

## Tech Stack

| Layer     | Technology                       | Version |
| --------- | -------------------------------- | ------- |
| Runtime   | Electron                         | 36.9.5  |
| Frontend  | React                            | 19.2.4  |
| Language  | TypeScript                       | strict  |
| State     | Zustand                          | -       |
| Styling   | Tailwind CSS v4                  | -       |
| Animation | motion (react)                   | -       |
| Editor    | Monaco Editor                    | -       |
| Terminal  | xterm.js                         | 6.x     |
| Database  | better-sqlite3                   | -       |
| i18n      | react-i18next                    | en/zh   |
| Build     | electron-vite + electron-builder | -       |
| Node.js   | >= 18                            | -       |

## Project Structure

```
src/
├── main/                    # Electron main process (system layer)
│   ├── index.ts             # App bootstrap, window lifecycle, zoom support
│   ├── channels/            # 8 messaging platform plugins
│   │   ├── providers/       # dingtalk, discord, feishu, qq, telegram, wecom, weixin, whatsapp
│   │   ├── base-plugin-service.ts  # Abstract plugin contract
│   │   ├── channel-manager.ts      # Plugin lifecycle
│   │   └── plugin-commands.ts      # /help, /new, /status, /compress, /stats
│   ├── cron/                # Scheduled task agent runtime
│   ├── db/                  # SQLite DAOs (11 tables)
│   ├── ipc/                 # IPC handlers (34 files)
│   ├── mcp/                 # Model Context Protocol client
│   ├── ssh/                 # SSH/terminal support
│   └── migration/           # OpenCode migration tool
├── preload/                 # Secure bridge (contextBridge only)
├── renderer/src/            # React 19 UI
│   ├── components/          # UI components
│   │   ├── icons/           # Animated icons (Hover.css + motion/react)
│   │   ├── chat/            # Chat interface, input, messages, tool calls
│   │   ├── cowork/          # Collaboration panels (ACP, cron, files, teams)
│   │   ├── layout/          # Sidebar, session list, detail panels
│   │   ├── settings/        # Provider config, plugins, MCP, migration
│   │   ├── ssh/             # SSH connections, keys, terminal
│   │   ├── tasks/           # Cron tasks, calendar view
│   │   └── terminal/        # Terminal panels
│   ├── hooks/               # React hooks
│   ├── lib/                 # Core logic
│   │   ├── agent/           # Agent loop, sub-agents, teams, context compression
│   │   ├── tools/           # 20+ built-in tools
│   │   ├── api/             # LLM API clients
│   │   ├── mcp/             # MCP tool integration
│   │   └── ipc/             # Renderer-side IPC client
│   ├── locales/             # i18n JSON files (en/zh, 7 namespaces)
│   └── stores/              # 26 Zustand stores
└── shared/                  # Cross-process TypeScript contracts
```

**Entry points:** `src/main/index.ts` (main), `src/renderer/src/App.tsx` (renderer)

## Architecture

### Process Model

```
Main Process (Node.js)
├── Window lifecycle
├── SQLite database
├── Agent runtime (js-agent-runtime.ts)
├── Cron scheduler
├── Channel plugins
├── SSH/terminal
└── IPC handlers ←→ Preload (contextBridge) ←→ Renderer (React UI)
```

### Data Flow

```
User Input → InputArea.tsx → chat-store.ts → ipcClient.invoke('agent:run')
→ js-agent-runtime.ts (main process) → LLM API → Stream events
→ agent-store.ts → MessageItem.tsx → User sees response
```

### Key Patterns

**Session Modes:** `chat`, `clarify`, `cowork`, `code`, `acp` — each configures different system prompts, tool sets, and UI behavior. Mode stored in `SessionPromptSnapshot` (chat-store.ts).

**Ephemeral (Incognito) Sessions:** Sessions with `ephemeral: true` on the `Session` interface are never persisted to SQLite. All DB write helpers (`dbCreateSession`, `dbAddMessage`, `dbUpdateMessage`, `dbFlushMessage`, `startStreamingPeriodicFlush`, etc.) check for ephemeral status and skip IPC calls. Ephemeral message IDs are tracked in `_ephemeralMessageIds` Set for O(1) lookup in `dbUpdateMessage`. The `incognitoSessionIds` Record on `ChatStore` tracks which sessions are incognito. Users can "Save" an incognito session (persists to DB, flips `ephemeral: false`) or "Close" it (deletes from store, no DB trace). Incognito sessions appear in a dedicated "Incognito" section in the sidebar, filtered from normal project groups and standalone chats.

**Tool System:** Tools registered in phases via `registerAllTools()` in `src/renderer/src/lib/tools/index.ts`:

1. Core tools (bash, fs, search, browser, etc.)
2. Skills (async loaded from `resources/skills/`)
3. Sub-agents (specialized agents)
4. Teams (parallel agent orchestration)

Each tool: `ToolHandler` interface, receives `ToolContext` with session info, working folder, abort signal, IPC client.

**Channel Plugins:** 8 messaging platforms. Extend `base-plugin-service.ts`. Contract: `onStart()`, `onStop()`, `sendMessage()`, `replyMessage()`, `getGroupMessages()`, `listGroups()`.

**Agent Runtime:** Runs in main process (`js-agent-runtime.ts`). Provider-agnostic — accepts generic provider object. Handles retry, circuit breaking, tool execution routing, approval hand-off, event streaming.

**Context Compression:** Auto-compresses when token count exceeds threshold. Manual trigger via button. System prompt in `agent.json` namespace.

## Zustand Stores

| Store                         | Purpose                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `chat-store.ts`               | Sessions, messages, active project, streaming state, incognito/ephemeral sessions |
| `agent-store.ts`              | Tool calls, approvals, sub-agent results                                          |
| `settings-store.ts`           | App settings, language, theme                                                     |
| `provider-store.ts`           | LLM provider configs, API keys                                                    |
| `ui-store.ts`                 | View state, sidebar, panels                                                       |
| `cron-store.ts`               | Scheduled tasks, execution history                                                |
| `ssh-store.ts`                | SSH connections, keys, host fingerprints                                          |
| `task-store.ts`               | Task definitions, calendar data                                                   |
| `plan-store.ts`               | Plan review state                                                                 |
| `channel-store.ts`            | Messaging channel configs                                                         |
| `mcp-store.ts`                | MCP server connections                                                            |
| `terminal-store.ts`           | Terminal instances                                                                |
| `skills-store.ts`             | Installed skills                                                                  |
| `git-store.ts`                | Git repos, status, history                                                        |
| `team-store.ts`               | Team/multi-agent collaboration                                                    |
| `goal-store.ts`               | Goal tracking state                                                               |
| `draw-store.ts`               | Image generation state                                                            |
| `translate-store.ts`          | Translation state                                                                 |
| `image-edit-store.ts`         | Image editing state                                                               |
| `notify-store.ts`             | Desktop notification state                                                        |
| `resources-store.ts`          | Resource management                                                               |
| `quota-store.ts`              | Usage quota tracking                                                              |
| `background-session-store.ts` | Background session state                                                          |
| `input-draft-store.ts`        | Input draft persistence                                                           |
| `app-plugin-store.ts`         | App plugin state                                                                  |

## Built-in Tools

| Tool                 | Description                     |
| -------------------- | ------------------------------- |
| `bash-tool.ts`       | Execute shell commands          |
| `fs-tool.ts`         | Read/write/list files           |
| `search-tool.ts`     | Search files by pattern/content |
| `browser-tool.ts`    | Open URLs in system browser     |
| `web-search-tool.ts` | Search the web                  |
| `cron-tool.ts`       | Schedule recurring tasks        |
| `skill-tool.ts`      | Run installed skills            |
| `todo-tool.ts`       | Manage task lists               |
| `plan-tool.ts`       | Create/edit plans               |
| `notify-tool.ts`     | Send desktop notifications      |
| `wiki-tool.ts`       | Generate project documentation  |
| `widget-tool.ts`     | Render UI widgets               |
| `ask-user-tool.ts`   | Ask user questions              |

## Built-in Skills (11)

`csv-pipeline`, `docx`, `email-drafter`, `excel-processor`, `frontend-skill`, `image-ocr`, `pdf`, `post-to-x`, `web-scraper`, `wechat-ui-sender`, `xlsx`

Skills live in `resources/skills/` as folders with `SKILL.md` + `scripts/`. Users can add custom skills in `~/.open-cowork/skills/`.

## Built-in Agents (15)

`api-designer`, `architect-reviewer`, `code-reviewer`, `copywriter`, `cron-agent`, `data-analyst`, `debugger`, `frontend-developer`, `fullstack-developer`, `meeting-summarizer`, `performance-engineer`, `refactor-expert`, `security-auditor`, `test-automator`, `translator`

Agents live in `resources/agents/` as Markdown files with frontmatter. Users can add custom agents in `~/.open-cowork/agents/`.

## Database (SQLite)

11 DAOs under `src/main/db/`:

| DAO                   | Table        | Purpose                                |
| --------------------- | ------------ | -------------------------------------- |
| `messages-dao.ts`     | messages     | Chat messages with metadata            |
| `sessions-dao.ts`     | sessions     | Session configs, mode, project binding |
| `projects-dao.ts`     | projects     | Project definitions, working folders   |
| `tasks-dao.ts`        | tasks        | Cron task definitions                  |
| `plans-dao.ts`        | plans        | Plan review data                       |
| `usage-events-dao.ts` | usage_events | Token usage tracking                   |
| `wiki-dao.ts`         | wiki         | Generated documentation                |
| `ssh-dao.ts`          | ssh          | SSH connections, keys, hosts           |
| `draw-runs-dao.ts`    | draw_runs    | Drawing/image generation runs          |
| `goals-dao.ts`        | goals        | Goal tracking data                     |

Schema evolves via additive `ensureColumn` calls — no migration files.

## IPC Channels

Renderer calls main via `ipcClient.invoke(channel, ...args)`. Main handlers in `src/main/ipc/*-handlers.ts` (34 files). Key channels:

- `agent:*` — Agent runtime, streaming, approvals
- `session:*` — Session CRUD
- `git:*` — Git operations
- `ssh:*` — SSH connections, file transfer
- `cron:*` — Task scheduling
- `mcp:*` — MCP server management
- `settings:*` — Settings read/write
- `fs:*` — File system operations
- `shell:*` — Shell command execution

## Coding Rules

- **Formatting:** Prettier — single quotes, no semicolons, 100-col width, no trailing commas
- **EditorConfig:** UTF-8, LF, 2 spaces, final newline
- **Naming:** React components = PascalCase (`Layout.tsx`), stores/helpers = kebab-case (`chat-store.ts`)
- **Commits:** Conventional — `feat(scope):`, `fix(scope):`, `chore(scope):`
- **Path aliases:** `@renderer/*` → `src/renderer/src/*`
- **i18n:** Use `t('key', { defaultValue: 'English text' })` — never hardcode Chinese in UI
- **No tests:** Validate with `npm run typecheck` and `npm run lint`

## Key Commands

```bash
npm run dev          # Start Electron + Vite with hot reload
npm run build        # Typecheck then build
npm run build:win    # Full Windows installer
npm run lint         # ESLint with cache
npm run typecheck    # TypeScript check (both main and renderer)
npm run format       # Prettier
```

## Adding New Features

| What               | Where                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| New UI component   | `src/renderer/src/components/<feature>/`                                |
| New Zustand store  | `src/renderer/src/stores/<name>-store.ts`                               |
| New tool           | `src/renderer/src/lib/tools/<name>-tool.ts` + register in `index.ts`    |
| New IPC channel    | `src/main/ipc/<name>-handlers.ts` + expose in `src/preload/index.ts`    |
| New skill          | `resources/skills/<name>/SKILL.md` + `scripts/`                         |
| New agent          | `resources/agents/<name>.md`                                            |
| New channel plugin | `src/main/channels/providers/<name>/` + extend `base-plugin-service.ts` |
| New i18n key       | Add to both `src/renderer/src/locales/en/*.json` and `zh/*.json`        |
| New DB column      | Add `ensureColumn` call in `src/main/db/database.ts`                    |

## Recent Enhancements & UI Patterns

- **Bulk-Select Sidebar:** `selectionMode` + `selectedSessionIds` Set, toggled by `ListChecks` icon
- **Hover-to-Reveal Header:** `max-w-0 opacity-0 group-hover:max-w-[200px]` CSS transition
- **Magic Prompt Enhancer:** AI-powered prompt refinement with Ctrl+Z undo
- **Web Search Toggle:** Globe button with `rounded-full` active state
- **Floating Header:** Absolute-positioned overlays for max chat visibility
- **Animated Icons (Hover.css):** Motion-based animated icons from itshover.com in `src/renderer/src/components/icons/`. Each icon uses `motion/react` with `useAnimate`, `onHoverStart`/`onHoverEnd`. Shared types in `types.ts` (`AnimatedIconProps`, `AnimatedIconHandle` with optional `clickAnimation`). Icons: `GearIcon` (rotates on hover), `PenIcon` (writes with slash), `WorldIcon` (meridian path animation), `WifiOffIcon` (slash line + wave pulse), `GhostIcon` (floating + wiggle + eye blink, used for incognito feature), `SlidersHorizontalIcon` (CSS spin via `hvr-icon-spin` class), `BulbIcon` (rays flash in on hover, rays flash + body glows on click — used for optimize prompt button in InputArea). **Sidebar nav icons:** `NewChatIcon` (pencil writes on hover, spark on click), `SearchIcon` (magnifying glass swings + lens glint on hover, zoom-burst + ring pulse on click), `PlugConnectedIcon` (plug parts separate on hover, snap-reconnect with bounce on click — used for Plugins), `CalendarIcon` (page flip on hover, rapid flip + bounce on click). Sidebar nav items use a `navIconRefs` Map to call `clickAnimation()` on click via imperative handle.
- **Generic AnimatedIcon wrapper:** `AnimatedIcon` component in `icons/AnimatedIcon.tsx` wraps any lucide icon with `whileHover`/`whileTap` motion animations. Standard types: scale, rotate, spin, bounce, shake, pulse, wiggle, swing, flip, pop, jello, rubber. Heavy types (0.5-0.8s): heavyWiggle, heavyBounce, heavySpin, heavyJello, heavyRubber, heavyPop, heavySwing, heavyShake. `hovered` prop enables externally controlled hover (for parent-driven row hover). Icon-to-animation mapping in `icons/icon-animation-map.ts`. Used in `CommandPalette.tsx` via a local `anim()` helper. Also used in `WorkspaceSidebar.tsx` for Extensions section icons. Used in `AssistantMessage.tsx` for dropdown menu icons via `AnimatedMenuItem` helper — hover on the entire row triggers icon animation: Copy=heavyPop, Fork=heavySwing, Translate=heavySpin, ReadAloud=heavyWiggle, Share=heavyBounce, Collapse=heavyRubber, Continue=heavyPop, Regenerate=heavySpin, Delete=heavyShake. Used in `SettingsPage.tsx` for settings sidebar navigation icons (Settings=rotate, BookOpen=swing, BarChart3=bounce, ArrowRightLeft=spin, Server=pulse, Layers=scale, BrainCircuit=jello, Puzzle=pop, Cable=bounce, Globe=spin, Wand2=rotate, Info=wiggle). Used in `AppPluginPanel.tsx` for plugin card icons (pop on list, bounce on detail header).
- **Resizable Panels:** Drag-to-resize dividers between panels (e.g., TasksPage left/right columns). Uses `mousedown`/`mousemove`/`mouseup` on document, `cursor-col-resize`, `select-none` during drag, full-screen overlay to capture events. Pattern: `containerRef` + `leftWidth` state + `MIN_LEFT_WIDTH`/`MAX_LEFT_WIDTH` constants.

## Agent Handoff Notes

- Start by understanding the chat flow before changing UI behavior: `chat-store.ts` owns session state, `InputArea.tsx` owns composer behavior, `AssistantMessage.tsx` renders assistant content, and `WorkspaceSidebar.tsx` owns session list interactions.
- Incognito sessions are truly ephemeral. The source of truth is `Session.ephemeral === true`, and those sessions must not hit SQLite. Any new write path should check ephemeral state before persisting.
- Incognito styling is intentionally scoped to the chat area, not the sidebar. Keep theme changes local to the chat container so the sidebar remains consistent with normal app chrome.
- The chat-only AMOLED theme currently uses a dedicated class on the conversation pane. If you need to adjust it, keep the black surface variables and animation inside that chat wrapper rather than changing global app tokens.
- Sidebar chat rows have a right-click context menu with animated icons. If you add or reorder menu items, keep icon hover animation behavior aligned with the existing motion/CSS pattern so the menu still feels alive without extra code paths.
- The sidebar header includes a bookmark filter button above the chat history section. Keep its size compact and visually balanced with the other header controls.
- Text selection from assistant messages can be referenced into the next user prompt. The flow is: select text in `AssistantMessage.tsx`, show the floating add-to-chat bubble, store the selection in `selection-reference-store.ts`, then surface it in `InputArea.tsx`.
- The selection-reference store must use stable snapshots. Avoid returning freshly created arrays from Zustand selectors, or React may treat them as changing on every render.
- If you touch hover animations, reuse the project’s existing icon animation approach instead of adding a new animation library. The repo already mixes motion-based icons and CSS-based hover spin, and that split should stay consistent.
- When adding features that affect both the chat pane and sidebar, verify whether the effect should be scoped to the current session only or to the whole workspace. Several recent changes are intentionally session-scoped.
- For UI work, check the visual result in the Electron app, not just in a raw browser tab. Some renderer behaviors depend on Electron preload APIs and won’t show correctly in plain browser mode.
- Favor small, local edits over broad refactors. This codebase already has a lot of moving parts, and the easiest way to avoid regressions is to keep the surface area tight and the behavior explicit.

## Gotchas

- **Native modules:** `better-sqlite3`, `@jitsi/robotjs`, `ssh2`, `node-pty` require rebuild via `npm run postinstall`. On Windows, `node-pty` is skipped.
- **Data directory:** `~/.open-cowork/` — SQLite DB, config, agents, commands, prompts. Never commit.
- **SQLite schema:** Additive `ensureColumn` only — columns added if absent, never dropped.
- **i18n:** Language detected from OS locale on first launch. Chinese systems default to Chinese.
- **Dev server:** First launch ~30s (compiles 98+ modules). Cached after.
- **Zoom:** Ctrl/Cmd +/- (75%-200%), trackpad pinch (1x-5x). In `src/main/index.ts`.
- **Session runtime router:** `session-runtime-router.ts` buffers message state for background sessions, flushes on foreground.
- **Agent runtime:** Runs in main process, not renderer. Provider-agnostic.
- **Context compression:** Auto-triggers at token threshold. Manual button in UI.
- **Security:** Never commit secrets, `.env`, or `~/.open-cowork/` data.
- **Animated icons:** Use exact code from Hover.css (itshover.com). Two approaches: (1) Motion-based — `motion/react` with `useAnimate`, `onHoverStart`/`onHoverEnd` for complex animations (PenIcon, GearIcon, WorldIcon, WifiOffIcon). (2) CSS-based — `hvr-icon-spin` class on parent + `hvr-icon` on child for simple spin animations (SlidersHorizontalIcon). Icons must use `forwardRef` + `useImperativeHandle` to expose `startAnimation`/`stopAnimation` (and optionally `clickAnimation`) via `AnimatedIconHandle`. Use plain `<button>` elements (not `<Button>` component) as parent containers to ensure hover events reach `motion.svg`. Sidebar nav icons (NewChatIcon, SearchIcon, WandIcon, CalendarIcon) add `clickAnimation` for press feedback — triggered via a `navIconRefs` Map in WorkspaceSidebar.
- **Resizable panels:** Use `mousedown` on divider → `mousemove`/`mouseup` on `document`. Set `document.body.style.cursor = 'col-resize'` and `userSelect = 'none'` during drag. Add a full-screen invisible overlay (`fixed inset-0 z-50 cursor-col-resize`) to capture mouse events. Store width in React state, clamp between `MIN_LEFT_WIDTH` and `MAX_LEFT_WIDTH` (typically 80% of container).
- **Immer + Sets:** Zustand stores use Immer middleware. Immer does NOT support `Set` or `Map` by default — using them causes `"The plugin for 'MapSet' has not been loaded into Immer"` error. Use plain `Record<string, boolean>` instead of `Set<string>` for trackable state (see `incognitoSessionIds` in chat-store.ts).
- **Ephemeral sessions:** Sessions with `ephemeral: true` skip all DB writes. The check is in the standalone DB helper functions (`dbCreateSession`, `dbAddMessage`, etc.) at the top of each function. When adding new DB write paths, always check `incognitoSessionIds` or `ephemeral` before persisting. Ephemeral message IDs are tracked in `_ephemeralMessageIds` Set (module-level, not in Zustand) for O(1) lookup.
- **Validation habit:** Prefer `npm run typecheck` and targeted `npm run lint` over guesswork. Full lint can still surface unrelated repo-wide issues, so if a broad lint run fails, isolate the files you actually changed and re-check those first.
- **File discovery:** Use `rg` / `rg --files` first when looking for symbols or files. It is the fastest way to orient in this repo and avoids wandering through unrelated folders.
- **No surprise rewrites:** When an existing component already has a local convention, follow it. This repo has a lot of recently added UI patterns, and most regressions come from changing a shared surface more broadly than the feature needs.

## Active Handoff

Current focus: chat auto-title generation for the sidebar.

What has already been built:

- Sidebar bookmark feature is implemented and persisted.
- `Session.bookmarked` is stored in SQLite and exposed through `chat-store.ts`.
- Bookmark toggle/button is present in `WorkspaceSidebar.tsx`.
- Bookmarked-chat filter is present in the sidebar header.
- The visible blocker now is auto-naming new chats from the first prompt.

What the current debugging learned:

- The active selected provider is `openai-chat` with a custom model (`mimo-v2.5`) and a custom OpenAI-compatible base URL.
- Direct API testing showed that the title request is sensitive to prompt framing and token budget.
- Very small title requests can return empty content.
- Wrapping the prompt as data, not as an instruction, matters a lot for this provider.
- For this provider, a non-streaming `/chat/completions` request was the most reliable shape in direct tests.

Relevant files:

- [src/renderer/src/hooks/use-chat-actions.ts](</C:/Users/Satyam/Desktop/codex projects/Project 7/src/renderer/src/hooks/use-chat-actions.ts>)
- [src/renderer/src/lib/api/generate-title.ts](</C:/Users/Satyam/Desktop/codex projects/Project 7/src/renderer/src/lib/api/generate-title.ts>)
- [src/renderer/src/lib/api/openai-responses.ts](</C:/Users/Satyam/Desktop/codex projects/Project 7/src/renderer/src/lib/api/openai-responses.ts>)
- [src/renderer/src/lib/ipc/agent-bridge.ts](</C:/Users/Satyam/Desktop/codex projects/Project 7/src/renderer/src/lib/ipc/agent-bridge.ts>)
- [src/renderer/src/stores/chat-store.ts](</C:/Users/Satyam/Desktop/codex projects/Project 7/src/renderer/src/stores/chat-store.ts>)

What to do next:

1. Verify the auto-title trigger is reached for a fresh first user message.
2. Verify `generateSessionTitle(...)` returns a parsed title for the selected provider.
3. Verify `updateSessionTitle(...)` is called on the exact active session id.
4. If the title is returned but not visible, trace store/session reload behavior in the sidebar.
5. Keep any fix small and scoped to the current chat flow.

Validation notes:

- `npm run typecheck:web` is still blocked by an unrelated existing error in `ChatHomePage.tsx` (`id` declared but unused).
- Focused lint on the touched files has been passing.
- The workspace is very dirty; do not revert unrelated user edits.
