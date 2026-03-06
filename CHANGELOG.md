# Changelog

All notable changes to **OpenCowork** will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com).

## [0.4.3] - 2026-03-06

### Fixed
- **Tool schema definitions** — added `additionalProperties` support to tool parameter schema for better OpenAI API compatibility.
- **WebFetch tool schema** — simplified URL parameter schema by removing complex `oneOf`/`anyOf` patterns, improving reliability with various LLM providers.

### Removed
- **qqbot submodule** — removed git submodule to simplify repository structure.

## [0.4.2] - 2026-03-06

### Added
- **QQ Channel Plugin** — new QQ bot integration with WebSocket message parsing and bidirectional messaging support for QQ channels.
- **App Plugin System** — introduced extensible app plugin architecture enabling tool capability extensions; first plugin is the image generation plugin.
- **Image Plugin** — integrated image generation capabilities with support for multiple models (Doubao SeedDream, etc.), inline image generation in chat, and attachment handling.

### Changed
- **Settings Panel Enhancements** — added dedicated App Plugin configuration panel with improved plugin management UI and clearer layout.
- **Documentation Updates** — added comprehensive guides for QQ plugin setup and app plugin system usage.
- **Localization Improvements** — updated English and Chinese translation files with new feature strings and refined UI text.
- **Web Search Refinements** — optimized web search tool implementation and provider configuration flow.

## [0.4.1] - 2026-03-06

### Added
- **Project selector** — introduced project switching UI and improved provider configuration flows.
- **Routin AI GPT 5.4 model** — added preset support for the new model tier.

### Changed
- **Chat home page** — redesigned layout and UI components for a refreshed landing experience.
- **Channel naming** — renamed the plugin system to the channel system across the app.
- **Xiaohongshu search skill** — simplified to search-only functionality.
- **README** — updated documentation content.
- **Version** — bumped to 0.4.1.

## [0.4.0] - 2026-03-04

### Added
- **Qwen 3.5 model catalog** — bundled `qwen_models.json` plus provider store wiring so Qwen3.5-35B-A3B, 27B, 122B-A10B, 397B-A17B, and Qwen3-32B variants ship with accurate pricing, context, and capability metadata.
- **Image generation workflow** — OpenAI Images provider bridge, prompt optimizer, and renderer UX (model switcher, streaming loader, assistant message previews) enabling inline image creation, zoom, download, and clipboard copy during chats.
- **Enhanced localization** — added i18n strings for the new image features, provider selectors, SSH terminal states, and layout chrome in both English and Chinese locales.

### Changed
- **Model switcher & input area** — redesigned selector with tiered grouping, descriptive badges, and better validation for multimodal/image choices; composer now handles image prompts, result hydration, and pause/resume behavior more gracefully.
- **Provider + plugin settings** — refreshed panels with new icons, toggles, and default options to surface Qwen image support alongside existing providers.
- **Plan panel & tools** — streamlined layout plus prompt optimizer hooks for richer summaries before dispatching autonomous plans.

### Fixed
- **General lint issues** — cleaned up unused imports and narrow type assertions uncovered while integrating the new UIs.

## [0.3.7] - 2026-03-04

### Added
- **Manual OAuth JSON input for provider configuration** — new interface allowing users to manually input OAuth JSON data for custom provider setups, enhancing flexibility for advanced authentication scenarios.
- **Manual OAuth token input UI for Codex provider settings** — dedicated UI components for entering OAuth tokens directly in the Codex provider configuration panel, simplifying authentication setup.
- **Background color, font family and size customization settings** — comprehensive UI customization options in settings panel allowing users to personalize the application's visual appearance with custom background colors, font families, and font sizes.

### Changed
- **UI panels cleanup** — refined and streamlined various UI panels for improved consistency, removing clutter and enhancing overall user experience.

### Fixed
- **SSH authentication error handling and validation** — improved robustness in SSH connection workflows with better error messages, validation checks, and handling of authentication failures to provide clearer feedback to users.

## [0.3.6] - 2026-03-03

### Changed
- **Routin AI MiniMax models** — Updated MiniMax M2.1, M2.1 Lightning, M2.5, and M2.5 Highspeed configurations with enhanced pricing structures, caching support (cache creation and hit prices), increased context lengths (up to 204,800 tokens), expanded output token limits (up to 131,072), and Anthropic protocol compatibility for improved performance and cost efficiency.

## [0.3.5] - 2026-03-03

### Added
- **Animated token counter** — new `TokenCounter` component with smooth requestAnimationFrame-based counting animation for real-time token usage feedback during message send/receive.
- **Loading indicator with state awareness** — `LoadingIndicator` component showing ↑/↓ arrows with state-aware token display (sending/waiting/receiving states).
- **Token formatting helper** — `formatTokensDecimal()` function providing consistent 2-decimal formatting for animated token counts (e.g., "1.23K", "12.50K").

### Changed
- **Stop button styling** — improved stop button visual design with amber theme instead of destructive red, providing better visual hierarchy and less alarming appearance.

## [0.3.4] - 2026-03-03

### Added
- **Docx Creator skill TOC workflow** — documented a dedicated table-of-contents workflow, Markdown guidelines, and troubleshooting steps so agents know exactly how to deliver refreshable TOCs and when to fall back to COM automation.
- **Docx tool TOC flags** — `docx_tool.py create` now supports `--toc`, `--toc-title`, and `--toc-depth` so generated Word documents include a pre-populated TOC field that users can refresh in Word/LibreOffice.
- **Tool preview detail panel** — tool cards expose a “view details” action wired into the Detail Panel so long outputs (diffs, shell logs, etc.) can be opened in a focused modal.
- **Provider fallback metadata** — Azure OpenAI and Routin AI stores inject richer defaults (model families, quota hints, protocol types) enabling provider forms to load even when remote metadata fails.

### Changed
- **ToolCallCard visual hierarchy** — reworked status badges, typography, and spacing, introduced inline token/line counters, collapsed contexts for diffs, and refreshed per-tool icons to keep long chains scannable.
- **SubAgent tool list** — SubAgentCard now streams live tool calls using the revamped ToolCallCard layout, keeping iteration stats, elapsed time chips, and copy buttons consistent across live/historical runs.
- **Filesystem tool UX** — LS/Glob/Grep blocks now expose click-to-insert paths, highlight matches directly in output, and show structured counts so agents can navigate large listings without scrolling dumps.
- **Skill docs clarity** — docx-creator guide gained a generated table of contents, formatting tips, and explicit dependency recovery instructions to align with the new CLI switches.
- **ProviderStore hydration** — provider presets merge strategy now keeps custom overrides while ensuring built-in protocols, default models, and thinking configs stay current after app upgrades.

### Fixed
- **Tool diff folding** — Large inline diffs now fold untouched context with expandable sections, preventing the chat thread from ballooning when applying multi-file patches.
- **Bash console controls** — background shell cards keep scroll position synced while streaming, expose exit codes reliably, and disable stop/send-input buttons once processes complete.
- **Detail panel regressions** — resolved missing open/close state in `useUIStore` so clicking any SubAgent/Tool detail button consistently opens the right-side panel.
- **Docx tool dependency errors** — add explicit python-docx import guard (with install instructions) so missing dependencies surface immediately instead of crashing mid-run.

## [0.3.3] - 2026-03-02

### Fixed
- **Plugin auto-reply helper functions** — added missing utility functions (`getProviderConfig`, `resolveModelSupportsVision`, `resolveOpenAiProviderConfig`, `transcribeFeishuAudio`, `hasQueuedPluginTasks`, `handlePluginAutoReply`) to fix runtime errors in plugin auto-reply workflow.
- **Feishu audio transcription** — implemented OpenAI-compatible speech-to-text API integration for processing voice messages in Feishu plugin conversations.

### Changed
- **Error message improvements** — refined user-facing error messages in plugin auto-reply flow with clearer Chinese text and better formatting.

## [0.3.2] - 2026-03-01

### Changed
- **Skill bootstrap path** — bundled skills are now copied into `~/agents/skills/` on startup (without overwriting user changes), aligning the renderer Skill tool with the main-process directory layout.
- **File mutation UI** — Right Panel, Tool cards, file change cards, and Translate timeline icons now focus on the Write/Edit/Delete tools that actually exist, so MultiEdit-only affordances are removed and stats stay accurate.
- **Provider test requests** — the Provider panel’s “Test connection” button selects the proper endpoint based on each model’s protocol (OpenAI Chat vs Responses vs Anthropic), enabling realistic health checks even with custom base URLs.
- **Clipboard export** — chat-to-image export now writes PNG data through the main-process clipboard IPC, fixing large-image copy failures on Windows caused by browser-side base64 conversions.

### Fixed
- **Translate agent buffer safety** — defensive Write handling prevents late completion/status strings from overwriting the translation buffer; agents now end with `TRANSLATION_DONE` without clobbering content.
- **Context menu alignment** — the mode-switch context menu spacing is restored (`gap-2`), keeping icons aligned with labels.

### Removed
- **Offline Skills Market cache** — the 1,800-line `resources/skills-market/skills.json` bundle and related downloader script were removed; Skills Market always queries the live API so the app footprint stays small.

## [0.3.1] - 2026-02-28

### Added
- **SFTP folder uploads** — the SSH file explorer can now select a local directory, compress it automatically, upload with progress updates, and unzip it on the remote server so large projects arrive intact.
- **Remote zip helper** — any remote directory can be compressed in-place from the explorer’s context menu, making it easier to download or archive server snapshots.
- **Public key bootstrap** — the SSH connection form can auto-detect local `~/.ssh` keys, copy the public key to the clipboard, and install it on the target host for passwordless auth in a couple of clicks.

### Changed
- **SSH upload pipeline** — uploads stream through a reusable session pool with richer progress reporting, cancellation, and automatic cleanup of temporary archives.
- **SSH UI polish** — file explorer menus surface the new folder upload/zip actions, and the connection form highlights public-key helper buttons directly next to auth inputs.

### Fixed
- **SFTP reliability** — remote folder creation, retries, and cursor pagination were hardened to keep large directory trees in sync even on slower servers.

## [0.3.0] - 2026-02-27

### Added
- **SSH workspace** — full SSH connection & group management with secure credential storage, per-connection terminals (xterm.js), file explorer/editor with diff-aware saves, remote preview panes, and the ability to bind a remote working directory to any chat session so the agent operates against server files natively.
- **Codex OAuth provider** — end-to-end PKCE OAuth flow with a local callback server, status indicators, quota extraction from response headers, and automatic registration of the bundled `codex-instructions.md` prompt, making Codex usable via a single toggle in the Provider panel.
- **Feishu member list tool** — new plugin tool + IPC wiring that lets agent automations fetch group member rosters on demand, exposing the capability in the Feishu plugin catalog for downstream skills.

### Changed
- **Provider / Plugin settings panels** — redesigned Provider panel shows OAuth status, quota usage, and dynamic field rendering, while the Plugin panel gains clearer permission warnings and reorganized toggles.
- **Planning & permission workflow** — Cowork PermissionDialog, PlanPanel, dynamic context, and Plan Store adjustments reinforce the "plan before execution" UX and surface explicit permission prompts inside auto-reply/plugin scenarios.

## [0.2.6] - 2026-02-26

### Added
- **Global memory workspace** — new renderer + settings flows to load, edit, and persist `~/.open-cowork/MEMORY.md`, with automatic injection into system prompts for every chat/agent run.
- **Translation center** — dedicated Translate page offering Simple and Agent modes, file picker support (.docx/text), agent timeline sidebar, and provider/model overrides for high-quality bilingual workflows.
- **Offline Skills Market data** — bundled `resources/skills-market/skills.json` plus renderer/main wiring so the skills panel can browse 180+ curated local entries without hitting the network.
- **Encrypted thinking capture** — OpenAI/Anthropic providers now request, persist, and replay encrypted reasoning blocks end-to-end, keeping telemetry secure while enabling richer debug info.

### Changed
- **Windows installer** — NSIS config now ships with customizable install directory (oneClick off + change-directory allowed) to match enterprise deployment expectations.
- **Primary layout & homepage** — macOS-style title bar, new Chat home screen, refined nav rail/right panel, and updated translate/settings surfaces for a more focused UX.
- **Provider & store plumbing** — refreshed provider presets (Gitee, Qwen, Routin, etc.), centralized translation store, and new IPC helpers for memory/files so advanced tools behave consistently.

### Fixed
- **Image preview safety** — clicking pasted/base64 images now opens an in-app dialog instead of spawning failing external windows on Windows systems.
- **Translation agent overwrites** — late-stage status strings (e.g. `TRANSLATION_DONE`) no longer clobber the final translated buffer after tool runs.
- **Working folder picker** — folder path appears only inside the selection dialog (home + session views), removing stray chrome above the input area.

## [0.2.5] - 2026-02-25

### Added
- **Web Search integration** — new web search tool with multi-provider support (Anthropic, OpenAI, local search engines) and browser fallback mechanism. Includes dedicated settings panel for configuring search providers and API keys.
- **Skill review system** — automated skill validation and security review via `skill-reviewer.ts` to ensure downloaded skills meet safety standards before installation.
- **Download tracking for Skills Market** — SQLite-based tracking system for skill downloads with statistics API endpoint and local file serving capabilities.

### Changed
- **Provider preset enhancements** — added `defaultModel` configuration support to provider presets, allowing users to set preferred models per provider. Updated Moonshot and other provider configurations with improved model selection.
- **Skills Market improvements** — fixed skill download temporary directory structure for more reliable installation. Updated Bigmodel API endpoint to latest version.
- **UI refinements** — improved input area interactions, layout adjustments for better user experience, and streamlined right panel toggle behavior during streaming responses.

### Fixed
- **Right panel toggle during streaming** — resolved issue where right panel would not toggle correctly while agent responses were streaming.
- **Skill installation reliability** — improved error handling and path resolution for skill downloads from GitHub repositories.

## [0.2.4] - 2026-02-25

### Added
- **Skills Marketplace** — new skills discovery and installation platform with GitHub-based skill registry, search functionality, and one-click installation. Features pagination, filtering by owner, and direct download from GitHub repositories with multiple path fallback strategies.
- **Skill installation dialog** — dedicated UI component for browsing and installing community skills with preview and metadata display.
- **DingTalk streaming cards** — enhanced DingTalk integration with rich card templates, streaming response support, and comprehensive setup documentation with visual guides.
- **Enhanced plugin documentation** — detailed setup guides for Feishu and DingTalk with step-by-step instructions, screenshots, and configuration examples.

### Changed
- **License migration** — switched from MIT License to Apache License 2.0 across the entire project, including the LICENSE file, README badges, documentation homepage, and all related references to provide more comprehensive patent protection and clearer contribution terms.
- **Skills store overhaul** — expanded skills management with GitHub integration, improved state management, and better error handling for skill downloads.
- **UI layout refinements** — minor adjustments to layout components and navigation for better user experience.
- **Mermaid theme improvements** — enhanced diagram rendering with better theme support and visual consistency.

### Fixed
- **Plugin auto-reply stability** — improved message handling and state synchronization for plugin-based auto-reply workflows.
- **Image and markdown preview** — enhanced preview viewers with better rendering and interaction capabilities.

## [0.2.3] - 2026-02-24

### Added
- **CronAgent profile** — dedicated agent preset for autonomous cron job execution with tailored system prompt.
- **X.com posting skill** — new skill enabling the agent to compose and publish posts to X.com (Twitter).
- **Cron system improvements** — global job management with concurrency tracking, preventing overlapping runs and improving scheduler reliability.

### Changed
- **macOS-native layout overhaul** — refactored window chrome to use a native title bar on macOS, replaced the horizontal top bar with a vertical navigation rail, and introduced a unified toolbar housing the mode switcher (Cowork/Code) and export actions for a cleaner, more platform-consistent UI.
- **English-first documentation** — rewrote README with comprehensive English documentation covering multi-agent architecture, 15+ SubAgents, messaging platform integrations, and technical deep-dive; added detailed English repository guidelines (`CLAUDE.md`) covering project structure, build commands, coding style, and development workflow.

### Fixed
- **OpenAI-compatible provider stream termination** — streaming now waits for the usage chunk when it is not included in the `finish_reason` event, preventing premature stream closure and missing token usage data with OpenAI-compatible providers.

## [0.2.2] - 2026-02-23

### Added
- **Specialized agent presets** — introduced eight curated agent profiles (API design, architecture review, code review, copywriting, data analysis, debugging, DevOps, and documentation) with tailored system prompts so teams can spin up the right expert quicker.
- **Public documentation site** — launched an accompanying Next.js documentation hub (built with Fumadocs + Docker support) that mirrors the in-app architecture references and provides a polished onboarding path.

### Changed
- Updated marketing homepage hero badge to highlight the new v0.2.2 release.

## [0.2.1] - 2026-02-22

### Added
- **Auto-updater for Windows/Linux** — new `setupAutoUpdater` wiring in the main process with postpone logic, localized dialogs, release-note display, download progress indicators, and crash-log instrumentation so packaged builds can fetch binary updates directly from GitHub Releases.
- **Mermaid diagram rendering in chat** — assistant messages now render ` ```mermaid ` code blocks as themed SVG diagrams with one-click copy for source or rendered image output, plus dark/light theme sync via `mermaid-theme.ts`.

### Changed
- **Build & release pipeline** — `electron-builder.yml`, `dev-app-update.yml`, and the GitHub Actions workflow now publish release artifacts (including `latest.yml`, `.AppImage.zsync`, etc.) to GitHub Releases so the auto-updater has consistent feeds across platforms.

## [0.2.0] - 2026-02-21

### Fixed
- **Feishu DM title mismatch** — added `getUserProfile` and cached user display names inside the Feishu service so P2P sessions fall back to the sender's real name whenever `chatName` is missing, keeping private chat titles aligned with Feishu.

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
