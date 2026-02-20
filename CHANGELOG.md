# Changelog

All notable changes to **OpenCowork** will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.9] - 2026-02-20

### Fixed
- **Fixed Windows build crash** — removed `nanoid` from the `electron-builder.yml` exclude list. The `nanoid` module is required by the main process (cron handlers, plugin handlers, auto-reply) and was incorrectly excluded from the packaged app, causing "Cannot find module 'nanoid'" errors on startup.

## [0.1.8] - 2026-02-20

### Added
- **Multi-platform messaging plugins** — new Discord, Telegram, WeCom (企业微信), and WhatsApp provider implementations, each with WebSocket message parsing, API wrappers, and service classes. All providers extend a shared `BasePluginService` + `WebSocketTransport` abstraction for consistent lifecycle management and auto-reconnect.
- **Plugin auto-reply pipeline** — `auto-reply.ts` routes incoming plugin messages to per-user/per-group sessions and triggers the Agent Loop for autonomous replies; renderer-side `use-plugin-auto-reply` hook manages the full approval + execution flow. Includes `forceApproval` mode that gates all tool calls through user permission when running on behalf of plugin messages.
- **Per-session provider binding** — sessions can now bind a specific `providerId` + `modelId`, allowing plugin auto-reply sessions to use a dedicated model instead of the global active provider. DB schema extended with `provider_id`, `model_id`, and `external_chat_id` columns.
- **Cron scheduling system** — persistent `node-cron` scheduler (`cron-scheduler.ts`) with SQLite-backed job storage, IPC handlers, and renderer tools (`CronAdd`/`CronUpdate`/`CronDelete`/`CronList`). Supports one-shot (`at`), fixed-interval (`every`), and cron-expression schedules. Dedicated `CronAgent` sub-agent runs tasks autonomously on trigger. Cron jobs support plugin routing via `plugin_id`/`plugin_chat_id` for delivering results to messaging platforms.
- **Cron management UI** — full `CronPanel` in the cowork sidebar with job list, status badges, run history, and inline editing controls.
- **Notify tool & toast system** — `Notify` tool sends desktop toast notifications or injects messages into sessions; `NotifyWindow` renders a standalone overlay with progress bars, auto-dismiss, and pin support.
- **Browser Session Crawler skill** — Playwright-based crawling skill that reuses Chrome/Edge login sessions, with pre-built scripts for Xiaohongshu and Zhihu.
- **Extended file preview viewers** — new DOCX, PDF, image, and Markdown viewers registered alongside the existing spreadsheet viewer.
- **Feishu rich messaging API** — expanded `feishu-api.ts` with group list, message history, user info, reply capabilities, and file/image send tools (`FeishuSendFile`, `FeishuSendImage`).
- **`CLAUDE.md` project guide** — comprehensive architecture reference and development instructions for AI-assisted coding.
- **External `triggerSendMessage` entry point** — allows plugin auto-reply and other non-hook callers to invoke `sendMessage` from outside the React hook lifecycle.

### Changed
- **Plugin architecture refactored** — extracted `BasePluginService` base class and `WebSocketTransport` utility; DingTalk and Feishu services migrated to the shared abstraction with dedicated `WsMessageParser` modules. Plugin store uses window-level flags to prevent HMR duplicate listener registration; enabling a plugin now auto-activates it.
- **Plugin settings UI overhauled** — `PluginPanel` redesigned with per-provider configuration forms, auto-reply toggles, connection status indicators, and group/contact management for all six providers.
- **System prompt major overhaul** — "Think Before Acting" expanded to a 6-step process (Understand → Scope → Plan → Risk check → Act → Verify); added output calibration examples; code safety rules (XSS, injection, secrets); tool anti-pattern guidelines; API and Shell security rules; plugin file-delivery instructions injected when Feishu is active.
- **Agent Teams prompt dynamically trimmed** — full team workflow instructions only injected when a team is active; otherwise a compact summary is used, reducing idle token overhead.
- **Dynamic context injection on every message** — previously only injected on the first user message per session; now injected on every turn. Removed bilingual logic (unified to English). Added timestamp to context header.
- **Session switching loads per-session tasks** — `setActiveSession` now triggers `loadTasksForSession` and `switchToolCallSession` so the task list and tool call panel reflect the active session immediately.
- **Queued message priority** — at `iteration_end`, if queued user messages exist the agent loop is aborted early so the next queued message is dispatched immediately instead of waiting for another LLM round-trip.
- **`<system-remind>` → `<system-reminder>`** — tag name unified across dynamic context, queued message reminders, and system prompt references.
- **Spreadsheet viewer improved** — richer rendering and interaction in `spreadsheet-viewer.tsx`.
- Locales (EN + ZH) updated with cron, notify, and new plugin strings.

### Fixed
- **Feishu WebSocket stability** — message parsing extracted to dedicated `parse-ws-message.ts`, improving reconnect reliability and error isolation.
- **DingTalk message parsing** — separated into standalone parser module for cleaner error handling.
- **Plugin-created sessions not found** — when a session created by the main process (e.g. plugin auto-reply) was not yet in the renderer store, `sendMessage` now reloads sessions from DB before aborting, preventing silent message drops.
- **Context compression respects session-bound provider** — compression now uses the session's bound `providerId`/`modelId` instead of always falling back to the global active provider.

---

## [0.1.7] - 2026-02-19

### Added
- **Queued message workflow** — per-session FIFO queue with edit/save/delete controls in the composer so you can line up multiple drafts while a run is in progress.
- **Pending message IPC hooks** — renderer now subscribes to queue updates via `subscribePendingSessionMessages`/`getPendingSessionMessages`, keeping UI state and persisted drafts in sync across restarts.

### Changed
- **Composer history navigation** — arrow-key history now integrates with the queued drafts, restoring text, attachments, and metadata exactly as saved.
- **Auto-dispatch after runs** — the next queued draft is automatically sent as soon as the active agent loop finishes, reducing manual resend steps in multi-stage workflows.

### Fixed
- **Draft/attachment desync** — queue + history state now share a single source of truth, preventing stale attachments or mismatched drafts when editing/sending messages rapidly.

---

## [0.1.6] - 2026-02-19

### Added
- **Crash logging pipeline** — new `src/main/crash-logger.ts` persists structured JSONL crash events to `~/.open-cowork/logs/crash-YYYY-MM-DD.log`, including process/runtime metadata and normalized payload snapshots.
- **Main-process crash/lifecycle hooks** — `uncaughtException`, `unhandledRejection`, `child-process-gone`, `render-process-gone`, `unresponsive`, and failed main-frame loads are now captured and written to crash logs.
- **Background command sessions** — bash commands can run as managed background processes with session/tool metadata, live output streaming, and stdin write support (`process:write`).
- **Interactive terminal controls in UI** — TopBar badges + DetailPanel terminal view + ToolCallCard actions now support opening, stopping, sending Ctrl+C, and sending stdin to running background commands.
- **Composer input history** — Input area now supports per-session up/down history recall (text + image attachments + draft restoration).

### Changed
- Bash tool now auto-detects long-running commands and runs them in background by default, with `run_in_background` and `force_foreground` controls.
- Provider resolution now supports per-model protocol override (`model.type`), base URL normalization by protocol, and builtin model merging that preserves user-enabled flags while syncing preset metadata.
- Builtin provider lineup expanded with coding-oriented presets (Moonshot/Qwen/Baidu/MiniMax) and refreshed model catalogs in presets (including GPT-5.* / Codex variants and updated thinking configs).
- Agent/tool observability improved with foreground shell exec tracking, richer process state in store, and clearer status surfacing in panel components.

### Fixed
- **OpenAI Responses tools schema** now uses the correct Responses format (`type/name/description/parameters/strict`) instead of Chat-style nested `function`, fixing `Missing required parameter: 'tools[0].name'`.
- OpenAI-compatible chat streaming now exits safely for providers that do not terminate SSE after `tool_calls`/`stop`, preventing hangs in tool argument streaming.
- Agent loop now handles partial/malformed tool argument streams more robustly and finalizes dangling tool calls defensively when providers miss explicit `tool_call_end`.
- `Write` tool now performs explicit input validation and surfaces IPC write failures as tool errors instead of silently returning ambiguous success payloads.
- Session cleanup now tears down session-bound background processes to avoid orphaned runtime state.

---

## [0.1.5] - 2026-02-15

### Added
- **Plan Mode pipeline** — new Plan panel, Zustand store, and Enter/ExitPlanMode tools enforce plan-first workflows, write plans to session `.plan/*.md` files, and surface status inside the cowork panel.
- **AskUserQuestion tool & card** — reactive chat card that collects single/multi-select answers (with "Other" free text) and streams results back to the tool call without blocking the UI.
- **Dynamic context injection** — first user turn in Cowork/Code modes automatically includes task/plan/file context, reducing repeated instructions for the agent loop.
- **Persistent plans & tasks tables** — SQLite schema, DAO modules, and IPC handlers store plans/tasks per session for reliable restarts.
- **Shell execution upgrades** — UTF-8 normalization on Windows, binary-output detection, truncation safeguards, and live `shell:output` streaming via exec IDs.
- **Provider preset refresh** — latest OpenRouter/Xiaomi models with thinking configs and pricing metadata plus lazy Monaco-powered fallback viewer for file previews.

### Changed
- Agent loop and chat actions honor plan-mode tool allowlists, auto-register MCP/plugin tools per session, and inject richer debug metadata.
- Right panel layout (Steps, Plan, Artifacts, preview) updated for plan awareness; Command Palette/AppSidebar and localization strings synced with the new workflow.
- Settings pages and provider labels expanded for AskUser/Plan terminology, with improved animated transitions and syntax highlighting lazily loaded as needed.

### Fixed
- Session teardown now clears running-state flags, AskUser pending questions, auto-triggered teammate queues, and plan-mode toggles to avoid leaking into future runs.
- SQLite racing conditions in sessions/tasks/plans DAO layers resolved, ensuring foreign-key safe inserts/updates and consistent IPC responses.
- Shell tool no longer crashes on binary output or garbled encoding; chat tool cards correctly render long tool inputs/outputs with truncation markers.

---

## [0.1.4] - 2026-02-14

### Added
- **MCP (Model Context Protocol) full pipeline** — main-process multi-connection manager supporting stdio, SSE, and streamable HTTP transports; IPC endpoints for lifecycle control; renderer-side tool bridge that injects MCP tools into the agent loop.
- **Settings → MCP panel** — create, edit, and manage MCP server configs with transport-aware forms, live capability refresh, and connection status controls.
- **Chat composer MCP awareness** — MCP servers appear in the Skills menu and as inline badges; users can toggle MCP capabilities per session before sending a message.
- **Gitee AI provider preset refresh** — curated DeepSeek, Qwen, GLM, Kimi, MiniMax, ERNIE, and Hunyuan models with accurate token limits and thinking support flags.
- **System prompt language injection** — agent system prompt now includes the user's selected language so AI responses match the UI locale.
- **Animated transitions component** (`animate-ui/transitions.tsx`) for smoother UI state changes.
- **Confirm dialog component** (`ui/confirm-dialog.tsx`) for destructive action confirmations.

### Changed
- README repositioned as the open-source Claude Cowork alternative; added provider comparison table, download links, and streamlined quick-start guide.
- Locales (EN + ZH) gained MCP-related strings, ensuring consistent translations across chat and settings screens.
- Settings page restructured with tabbed layout and expanded provider configuration.
- `AssistantMessage`, `ThinkingBlock`, `ToolCallCard`, and `FileChangeCard` components refactored for cleaner rendering and better streaming display.
- Layout simplified — `Layout.tsx` reduced by ~400 lines; panel logic extracted into dedicated components.
- Chat store enhanced with improved session management and message persistence.

### Fixed
- Chat input warnings and badges now reliably reflect active providers, MCP servers, and context window usage before running agent tasks.

---

## [0.1.3] - 2026-02-13

### Changed
- Removed macOS build target from GitHub Actions workflow due to code signing constraints.

---

## [0.1.2] - 2026-02-13

### Fixed
- Simplified GitHub Actions release handling — removed `release_id` output and streamlined release creation logic.
- Disabled electron-builder auto-publish to prevent premature artifact uploads.
- Fixed macOS code signing auto-discovery configuration.
- Removed snap target from Linux builds to reduce CI complexity.

---

## [0.1.1] - 2026-02-13

### Added
- Linux (AppImage / deb) build support in GitHub Actions workflow.

---

## [0.1.0] - 2026-02-13

First public release of OpenCowork.

### Added
- **Agentic Loop** — AsyncGenerator-based agent loop with streaming text, thinking, and tool-call events; abort control via `AbortSignal`; partial-JSON tool argument parsing for real-time UI rendering.
- **Tool System** — pluggable `ToolRegistry` with built-in tools: `Read`, `Write`, `Edit`, `LS`, `Glob`, `Grep`, `Bash`, `TodoWrite`, `TodoRead`, `Skill`, `Preview`.
- **SubAgent architecture** — `CodeSearch`, `CodeReview`, and `Planner` sub-agents loaded from Markdown definitions (`resources/agents/*.md`); dynamic user-defined agents from `~/.open-cowork/agents/`.
- **Agent Teams** — parallel multi-agent collaboration with `TeamCreate`, `SendMessage`, `TeamStatus`, `TeamDelete`; automatic task dispatch, dependency tracking, and teammate completion reporting.
- **Multi-provider AI support** — Anthropic, OpenAI (Chat + Responses API), and 15+ preset providers with SSE streaming proxy in the main process.
- **Skills system** — PDF analysis skills (academic, data-extract, legal) with Python extraction scripts; web-scraper skill; skill loading from `~/.open-cowork/skills/`.
- **SQLite persistence** — `better-sqlite3` in WAL mode for session and message storage with full DAO layer.
- **System prompt engine** — comprehensive prompt builder with environment detection, communication guidelines, tool-calling rules, code-change policies, task management, and workflow support.
- **Desktop UI** — Electron + React 19 + Tailwind CSS 4 + shadcn/ui (new-york); Monaco editor integration; Markdown rendering with syntax highlighting; motion animations.
- **Task management** — `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList` tools with Zustand-backed task store.
- **File preview system** — viewer registry with HTML, Spreadsheet, DevServer, and Markdown viewers.
- **Token estimation** — client-side token counting via `gpt-tokenizer` for context window awareness.
- **Streaming shell output** — `spawn`-based shell execution with real-time stdout/stderr via IPC events.
- **Tool call UX** — execution timing display, output truncation (4 K chars), auto-expand for mutation tools, grep pattern highlighting.
- **Bilingual documentation** — `README.md` (EN) and `README.zh-CN.md` (ZH) with feature descriptions, architecture overview, and keyboard shortcuts.
- **`AGENTS.md`** — repository guidelines and architecture reference for AI-assisted development.
- **GitHub Actions CI** — automated Windows build and release workflow with version extraction from git tags.
