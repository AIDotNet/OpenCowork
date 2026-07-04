# Changelog

All notable changes to this project will be documented in this file.

## [1.0.7] - 2026-07-04

### Added

- Implemented comprehensive capybara pet companion system with personality-driven interaction model
- Added pet experience progression system with level-based milestones and stat tracking
- Implemented pet skin management system with customizable appearance options
- Added pet agent runtime for proactive companion behavior and voice integration
- Implemented pet memory system for contextual awareness and personality persistence
- Added pet pose/animation system with 13 different animation states (idle, sleep, eat, play, swim, bathe, etc.)
- Created pet studio for pose generation, expression customization, and skin preview
- Added native worker OpenAI Audio module with configurable audio processing and streaming support

### Changed

- Removed documentation website from main repository (consolidate in separate docs project)
- Enhanced provider stores (Routin AI, Xiaomi) with new capability management
- Improved IPC messagepack channel routing with additional serialization support
- Refined usage analytics tracking with enhanced provider metrics
- Improved C# native worker OpenAI Audio Models with robust deserialization and error handling

### Technical

- Integrated multi-modal pet agent with adaptive response generation
- Implemented pet persistence layer with Zustand-based state management
- Added pet-specific IPC handlers for lifecycle and data synchronization
- Extended localization system with pet UI and messaging (en/zh)

## [1.0.6] - 2026-07-03

### Added

- Added Anthropic Claude API integration to the native worker with proper message validation and handling for trailing user turns (required by Claude Opus 4.6+, Sonnet 5, and Fable 5).
- Implemented cache creation token tracking split by time windows (5-minute and 1-hour) for improved cache cost analysis and display.

### Changed

- Removed plan executor from native worker runtime; plan execution now handled through the unified agent loop.
- Enhanced token usage metrics display with detailed cache creation breakdown and improved cost calculations.
- Improved SSH workspace connection handling and status monitoring with better error recovery.
- Refined permission dialog presentation and model switcher UX for better clarity.

## [1.0.5] - 2026-07-02

### Fixed

- Ensured first-run global memory directory initialization and onboarding profile writes can create missing `USER.md` without surfacing startup errors.
- Broadened missing-file detection for Windows and native-worker messages such as `Could not find file`, allowing onboarding, settings, and memory fallback paths to create files instead of failing.
- Made local `MemoryRead` create missing memory files from templates before reading them.
- Treated missing OpenAI Responses `previous_response_id` replay errors as recoverable and retried with full sanitized input.

### Security

- Upgraded the native worker SQLitePCLRaw bundle to `3.0.3`, pulling `SourceGear.sqlite3 3.50.4.5` and clearing the `SQLitePCLRaw.lib.e_sqlite3` vulnerability warning.

## [1.0.4] - 2026-07-02

### Fixed

- Removed BOM character from package.json for better compatibility with various tools and parsers.
- Added `pointer-events-none` to user message locator container to prevent it from intercepting clicks on underlying UI elements.

### Changed

- Optimized streaming and debug overhead by implementing on-demand caching and batch refresh instead of full recalculation on every increment, reducing O(n²) complexity in main and sidecar processes.
- Enhanced debug request body handling by upgrading from in-memory truncation to persistent disk storage for better readability of long request bodies.
- Added constraints for sub-agent and plan mode operations: sub-agents can no longer directly create/execute/approve plans, and plan mode tools are disabled by default in sub-agent contexts.
- Implemented context injection for plan mode, plan revision, plan execution, plugin channels, system commands, and slash commands to ensure model input consistency with current runtime state.
- Added prompt cache key truncation and derived sub-agent cache keys for OpenAI Responses API.
- Added duplicate task deduplication during runtime to prevent identical sub-agent prompts from being executed multiple times.

### Fixed

- Fixed sidecar manager initialization and communication flow.
- Improved session image export functionality.
- Updated routing AI provider configuration.

## [1.0.2] - 2026-07-01

### Changed

- Improved native worker development selection and publish flow so ready debug builds are preferred and failed native publishes do not wipe bundled resources.
- Updated Electron Builder metadata by removing invalid and deprecated Windows build version fields.

### Fixed

- Ensured AI API requests always carry a non-empty versioned `User-Agent` header such as `OpenCowork/1.0.2` across renderer, main proxy, cron, sidecar, native worker, image, audio, skills, souls, and WebSocket request paths.
- Normalized legacy default `User-Agent` placeholders like `OpenCowork` to the versioned app header while preserving provider-specific custom values.

## [1.0.1] - 2026-07-01

### Added

- Added native MessagePack sidecar transport and native worker runtime coverage for agent tools, database, file, Git, shell, SSH, terminal, sync, extension, memory, goal, task, cron, and provider execution paths.
- Added request stop support for agent runs, including shared run identifiers and stop-aware provider/runtime models.
- Added message windowing, stable long-context handling, and richer export output for chat transcripts.
- Added Luckin Coffee extension resources and bundled native worker publishing for platform-specific release artifacts.

### Changed

- Improved live tool-call rendering with streaming tool argument updates, foreground/background session synchronization, and session change summaries.
- Updated release CI to publish the native worker per target runtime and include .NET setup in Windows, Linux, and macOS packaging jobs.
- Refined the user-message locator into a compact right-edge marker with hover previews for faster navigation in long conversations.
- Default command-tool live previews to the session working folder when no explicit `cwd` is provided.

### Fixed

- Forwarded native and SSH shell output chunks through `shell:output` so terminal/tool cards update while commands are still running.
- Reduced stale shell-output listener buildup by using a single native worker forwarding listener.

## [1.0.0] - 2026-06-26

### Added

- Added per-session model selection mode (inherit / auto / manual) so a session can follow the global model, route automatically, or pin a specific provider+model independently of the global active model.
- Added `model_selection_mode` column to sessions (additive migration; existing provider+model rows backfilled to 'manual').
- Added centralized session model resolution in `session-model-resolution.ts`.
- Added "Follow global model" option in ModelSwitcher with split setSessionModelManual/Auto/Inherit actions on the chat store.
- Added thinking/reasoning support for MiniMax and Kimi (Moonshot) providers.
- Added live SSH process monitor panel (`SshProcessMonitor`) for inspecting remote host processes.

### Changed

- Stopped mutating the global provider store on session switch/sync; model state is now session-scoped.
- Refactored Anthropic API integration for cleaner cache control and response handling.
- Reworked ModelSwitcher and InputArea to support the new per-session model mode.
- Improved SessionListPanel, PreviewPanel, and SSH terminal status panel layouts.
- Updated multiple provider presets (Baidu, Gitee AI, MiniMax, Moonshot, OpenRouter, Qwen, SiliconFlow, Routin AI) with refreshed model lists, thinking support, and pricing.
- Threaded model selection mode through channel auto-reply, channel handlers, and DAOs.

### Fixed

- Kept the first tool-call id when providers re-emit ids per streaming delta, preventing tool-call matching failures.
- Various UI consistency and component rendering improvements.

### Removed

- Removed the legacy project wiki subsystem (wiki-dao, wiki-handlers, ProjectWikiPage, wiki-tool, wiki-generator) in favor of the memory/AGENTS.md workspace protocol.
- Removed unused architecture diagram SVG assets.

## [0.9.120] - 2026-06-23

### Added

- Added request timing metrics (TTFT, TPS) display in InputArea for real-time performance monitoring.
- Added cache shape debugging information in AssistantMessage showing system hash, tools hash, message prefix hash, tool count, and cache read ratio.
- Added new models to Routin AI provider: Kimi K2.7 Code HighSpeed, MiMo V2.5 Pro, MiMo V2.5 with thinking support.
- Added `getCacheCreationTokens` and `getUsageCacheHitRate` utility functions for improved token usage tracking.
- Added `calculateCacheReadRatio` function for cache analytics and debugging.
- Added `RequestTiming` type support for detailed request performance metrics.

### Changed

- Enhanced chat components (AssistantMessage, ToolCallCard, InputArea) with improved UI and performance.
- Improved settings pages and analytics overview with better data visualization.
- Updated Anthropic API integration with optimized cache control logic and cache target selection.
- Improved MCP tools and agent runtime with better error handling and stability.
- Enhanced internationalization (en/zh) with updated translations.
- Updated Routin AI provider models with new pricing and thinking support configurations.
- Various performance and stability improvements across the application.

### Fixed

- Fixed widget rendering logic in ToolCallCard with simplified state management.
- Fixed cache hit rate calculations and token usage tracking.
- Fixed various UI inconsistencies and improved component rendering.

### Removed

- Removed unused imports and properties (Loader2, Wrench icons) for cleaner codebase.
- Removed redundant model thinking indicator properties for simplified component API.

## [0.9.119] - 2026-06-19

### Added

- Added Volcengine (火山引擎) provider preset with Doubao Seed 2.1 Pro/Turbo models supporting vision, function calling, and thinking.
- Added Doubao Seed Evolving, Seed 2.1 Pro (260628), and Seed 2.1 Turbo (260628) models to Routin AI provider.
- Added sub-agent workspace protocol injection — sub-agents now automatically load project-level AGENTS.md as authoritative workspace context.
- Added parallel tool calls prompt for sub-agents to maximize concurrent independent tool invocations.
- Added sub-agent runtime cache policy with prompt cache key generation for OpenAI Responses WebSocket backend.
- Added `turn-context` injection for plan mode sub-agent runs.
- Added stable tool definition sorting (by name → description → schema) for deterministic cache keys.
- Added `cache-shape` module with stable hash/serialize utilities for prompt cache debugging.
- Added `SmoothTokenNumber` component with animated token counter transitions.
- Added thinking content extraction and model avatar with breathing dots animation for streaming placeholder state.
- Added model info hover card panel in model switcher showing provider, capabilities, and auto-routing target model.
- Added `toolUseOrderById` index for sub-agent inline rendering decisions.
- Added `canRenderInlineSubAgentRun` heuristic for multi-sub-agent message layout decisions.
- Added `resolveSubAgentProviderConfig` with session-scoped provider resolution.

### Changed

- Refactored chat streaming placeholder from static "生成回复" to "Thinking.../正在思考中..." with per-model avatar and animated breathing dots.
- Replaced model switcher plain label with hover card showing model name, provider, and capability tags for auto-routing clarity.
- Deferred large Read tool result text rendering to lazy mount for performance.
- Memoized MCP active tool computation to reduce store selector re-derivation.
- Set pending assistant message timestamp to current time instead of epoch 0 for correct sort order.
- Hidden file diff dialog close button to match interaction design.

### Fixed

- fix(mcp): expose connected MCP tools in chat for MCP-enabled sessions.
- Fixed sub-agent inline rendering: background sub-agents now properly hidden and synchronous sub-agents rendered inline when no visible content sits between them.

### Documentation

- Added comprehensive Repository Guidelines (AGENTS.md) covering project structure, build commands, coding conventions, and commit guidelines.
- Updated README.md and README.zh.md.

## [0.9.118] - 2026-06-17

### Added

- Added Code workspace mode with Explorer and Source Control sidebars, central preview/editor tabs, Monaco diff editing for Git and agent changes, and project terminal docking.
- Added SCM diff plumbing for reading file content at Git refs, editable unstaged/untracked diffs, and split/inline diff mode switching in previews.
- Added configurable concurrent sub-agent limits in Settings plus queued/dequeued stream events and clearer approval/retry status updates for teammates and Task runs.
- Added automatic recent visual artifact reuse for image-to-code and other visual follow-up prompts, including image reference preservation for OpenAI-compatible backends.
- Added the built-in `create-extension` skill and new provider presets for `glm-5.2` and `kimi-k2.7-code`.

### Changed

- Refreshed the chat tool-call rendering stack with inline context-compression summaries, completion metrics, richer compact headers, and improved image/tool cards.
- Replaced the right-panel Context entry with a Review-first workflow and refreshed the Settings navigation layout.
- Updated app-plugin resolution so project settings inherit global plugin defaults more consistently.
- Switched Electron download mirrors to `npmmirror.com` and excluded `html-to-image` from renderer dependency prebundling.

### Fixed

- Fixed context compression so repeated summarizer failures now fall back to local truncation instead of letting context grow unbounded.
- Fixed Git diff preload/cache behavior and preview save refresh flow for edited diffs in the workspace.
- Fixed Windows native rebuild/package flow by skipping prebuilt module rebuilds in `postinstall` and disabling duplicate `electron-builder` rebuilds.

## [0.9.117] - 2026-06-16

### Added

- Added `mimo-v2.5-pro-ultraspeed` model (MiMo V2.5 Pro UltraSpeed) to Routin AI and Xiaomi provider presets with 1M context, 131K max output, tool calling, and deep thinking support.
- Registered `mimo-v2.5-pro-ultraspeed` in the Routin AI plan preset for plan subscribers.

## [0.9.116] - 2026-06-09

### Added

- Added shell environment variable management in Settings with localized labels and IPC support.

### Changed

- Scoped session change summary cards to the current assistant message and its tool calls so earlier assistant messages can show their own file-change summaries.
- Improved terminal environment handling so configured shell variables are applied when launching terminal sessions.

## [0.9.115] - 2026-06-08

### Added

- Added heuristic Auto model routing signals for task type, tool intent, complexity, risk, and routing reasons.
- Added Auto model routing metadata display in the model switcher, including complexity and risk labels.
- Added localized Auto routing fallback, complexity, and risk labels in English and Chinese.

### Changed

- Reworked Auto model selection to combine heuristic signals, sidecar classifier output, low-confidence reuse, and policy overrides before choosing main or fast models.
- Limited sidecar prompt tool context to requests that actually need tools, reducing unnecessary channel and MCP context for simple prompts.
- Simplified page transitions to avoid extra animated wrapper behavior.

### Fixed

- Fixed unsafe fast-model routing for complex, high-risk, tool-required, or workspace-aware requests by forcing main-model routing when policy gates require it.

### Added

- Added Runtime Status Panel with Git integration: branch info, ahead/behind status, changed file count, and diff line summaries for the working directory.
- Added SSH connection context display in the runtime status panel showing connection name and working folder.
- Added source files panel in runtime status showing selected files from input drafts.
- Added model management defaults system: creating provider models auto-applies managed model parameters when the model ID matches.
- Added preset vs custom provider categorization in model management ("预置" / "自定义").
- Added `responsesImageGeneration.partialImages` config option for OpenAI Responses models.
- Added `runtimeStatusPanelOpen` state to UI store with toggle/set and persistence support.
- Added compact request view logic (`applyLatestCompactRequestView`) to filter UI-only messages and show only the latest compaction boundary in sent requests.

### Changed

- Rewrote RuntimeStatusPanel: switched from hover-triggered narrow panel to a toggleable panel with dedicated open/close button in the title bar.
- Redesigned FileChangeCard layout: replaced inline CompactEditDiff with NewFileContent component for new file previews.
- Improved Write/Edit tool live streaming previews: show tail content previews instead of hiding until complete (`content_preview`, `old_string_preview`, `new_string_preview`).
- Enhanced GoalRuntimeService with status change detection (completion/blocked transitions) and more robust lifecycle management.
- Improved model management search placeholder to "搜索模型/服务商..." for broader search scope.
- Updated alert-dialog action/cancel buttons with `min-w-0 max-w-full` for better text overflow handling.

### Fixed

- Fixed goal continuation dispatch to properly fire on goal status transitions in chat actions.
- Fixed pending write preview truncation: no longer appends trailing ellipsis when content already starts with '…'.
- Fixed real-time Write FileChangeCard defaulting to collapsed state.

### Removed

- Removed background session toast warning from ask-user-tool.

## [0.9.113] - 2026-06-04

### Added

- Implemented WebDAV sync functionality with full UI integration for managing sync settings.
- Added SyncPage component for configuring and monitoring WebDAV sync operations.
- Introduced IPC channels for sync configuration, status queries, and conflict resolution.
- Created sync type definitions for managing sync configurations and operations.
- Enhanced SshTerminal to handle terminal resizing and notify remote sessions.
- Added UI store management for opening and closing the sync page.
- Implemented conflict resolution handling in the sync process.

### Changed

- Updated localization files for sync-related strings in both English and Chinese.

## [0.9.112] - 2026-05-29

### Added

- Added context compression status card to surface current compression state more clearly in the UI.
- Improved message merge logic so history is preserved when consolidating messages.

## [0.9.111] - 2026-05-28

### Added

- Enhanced ModelSwitcher component with Popover dropdown for better model selection UX.
- Added workspace directory change detection with automatic refresh and provider-based model grouping.
- Implemented message write tracking and flush mechanism for chat sessions.
- Added browser goal runtime support for agent sessions.

### Fixed

- Fixed sub-agent event handling for background sessions with session-scoped state lookup.
- Improved code structure for better readability and maintainability.

## [0.9.110] - 2026-05-27

### Added

- Unlocked Chat-mode tool selection so models can now use file, terminal, MCP, and other tools when available, while preserving approval flow constraints.
- Added automatic default working directory creation for Chat sessions without a project context, preventing ambiguity in file-based tasks.
- Improved manual context compression with more aggressive shrinking based on actual compressible message count and recent input token estimation.
- Enhanced model switcher to display models grouped by provider for better readability and navigation in long lists.

### Fixed

- Fixed sub-agent event handling for background sessions by removing foreground session checks and using session-scoped state lookup.
- Delegated sub-agent cleanup to session-aware state synchronization for more reliable background session management.

## [0.9.109] - 2026-05-26

### Added

- Added goal runtime service support for blocked and usage-limited goal states so active goals can persist, resume, or pause based on blocker and usage conditions.
- Added dedicated browser tool cards and browser tool name grouping so browser tool calls render consistently in assistant messages.
- Added a Xiaomi coding preset and fast-route model selection support for separate main and fast model workflows.

### Changed

- Reworked goal persistence, schema migration, and event emission to support objective replacement, blocked audits, usage limits, and live elapsed-time tracking.
- Improved browser handling with shared built-in storage cleanup, more resilient webview JSON parsing, and screenshot encoding that preserves the native image format.
- Refined the chat composer, working-folder picker, sidebar and project navigation, and task calendar so project-scoped sessions and queued messages behave more predictably.
- Updated OpenAI Responses websocket session scoping in the cron background runtime so agent runs use distinct connection keys.

### Removed

- Removed placeholder code-compatible `LSP` and worktree tool stubs from the code-compatible tool catalog.

## [0.9.108] - 2026-05-25

### Added

- Added Soul marketplace page for discovering and browsing community souls.
- Finalized marketplace install flow with end-to-end soul installation from marketplace.

### Changed

- Refactored working directory selector dialog with improved UX and streamlined layout.
- Unified file and tool icon styles across chat cards and session panels for visual consistency.

### Fixed

- Added `Stage1BuildResult` wrapper in memory pipeline to preserve filter reasons and original content, ensuring filtered entries are recorded with accurate metadata instead of fallback values.

### Removed

- Removed WeChat UI send skill and its automation scripts.

## [0.9.107] - 2026-05-24

### Added

- Added automatic memory summarization system with backend pipeline, frontend panel, and dynamic context-injection into agent prompts.

## [0.9.106] - 2026-05-24

### Added

- Added automatic `sort_order` normalization before message reads so sessions with dirty sequence data are repaired in place only when anomalies are detected.

### Fixed

- Fixed message query ordering drift caused by gaps, duplicates, or out-of-order `sort_order` values in `messages` rows within the same session.
- Added `created_at ASC` as a secondary ordering key across message queries and stopped `upsertMessage` conflict updates from overwriting recovered `sort_order` values.

## [0.9.105] - 2026-05-24

### Changed

- Reworked the draw page image-generation flow with richer prompt optimization, style blending, and image-quality controls.
- Improved OpenAI image provider routing and Responses compatibility so image requests carry the right generation settings across providers.
- Expanded draw history, error reporting, and chat-mode prompt context so failed runs and optimized prompts surface more useful diagnostics.

### Added

- Added prompt-style presets and a user core suggestion field to help shape image prompts before generation.
- Added richer error details for image-generation failures, including provider and request metadata when no image output is returned.

### Fixed

- Fixed image-generation handling for transparent-background and no-output cases across the draw workflow.

## [0.9.104] - 2026-05-23

### Changed

- **Docs IA restructure:** Reorganized documentation from flat "Getting Started / Core Concepts / Features / Plugins / Providers / Architecture / Development" into task-oriented navigation: Start, Install, Channels, Agents, Capabilities, Skills, Models, Platforms, Ops, Reference, and Help. Added index pages and meta.json for each section, with redirects preserving all legacy URLs.
- Rewrote docs landing page with streamlined layout, new `DocsComponents` and `CopyCommandButton` components, and improved Mermaid diagram rendering.
- Refactored `chat-store` (441 lines changed) with enhanced session management and state flow.
- Expanded `fs-tool` (402 lines changed) and `bash-tool` (128 lines changed) with richer file system and shell execution capabilities.
- Enhanced `fs-handlers` (279 lines), `db-handlers` (102 lines), `ssh-handlers` (81 lines), and `shell-handlers` (28 lines) in the main process for more robust IPC.
- Refactored `messages-dao` data access layer for improved message persistence.
- Redesigned `GoalSessionControls` component with better goal session UX.
- Enhanced `InputArea` with improved input handling and `SkillsMenu` with richer skill browsing.

### Added

- **Code-compatible tool** (`code-compatible-tool.ts`, 321 lines): New tool providing code-agent-compatible aliases for OpenCowork's tool system, enabling seamless interoperability.
- **Tool input sanitizer** (`tool-input-sanitizer.ts`, 72 lines): Input validation and sanitization layer for all tool calls.
- New `channels.ts` IPC channel definitions for extended renderer-main communication.
- Enhanced `cron-tool`, `search-tool`, and `plan-tool` with additional capabilities.
- Expanded `tool-types` with new tool interfaces and type definitions.
- Docs application screenshot added to public assets.

### Fixed

- Updated i18n strings in English and Chinese chat locales for consistency.
- Improved `dynamic-context` and `memory-files` agent runtime modules.
- Enhanced `use-chat-actions` and `use-plugin-auto-reply` hooks for edge cases.

## [0.9.103] - 2026-05-21

### Fixed

- Isolated built-in browser session storage to prevent contamination of the user's native browser profiles.
- fix(cron): replaced string-concatenated output with chunk-based buffer decoding to avoid encoding truncation.
- fix(weixin): added i18n error keys for QR code and login failure scenarios.
- fix(todo): respected `teamToolsEnabled` setting in `hasActiveTeam` guard.

### Added

- feat(images): enhanced GIF fallback when no structured frames are available, with improved error branch handling.
- feat(teams): added filtered task definition and disabled-state filtering for team tools.
- feat(plugin): rewrote auto-reply flow with streaming text append, error tracing, full persistence, and replay support.
- feat(chat): added session deduplication by ID (dedupeSessionsById) and image preview in InputArea.

## [0.9.102] - 2026-05-21

### Fixed

- Protected real Chrome/Edge/Brave/Chromium profiles by keeping Electron's writable browser session data inside OpenCowork's isolated storage.
- Clarified browser settings copy so selected browser profiles are used for identity emulation, not direct writable storage reuse.

## [0.9.101] - 2026-05-21

### Changed

- Improved built-in browser emulation so an Edge data-source selection also reports Edge-like user-agent and client hints.
- Passed the main-process browser emulation status into the webview so the embedded browser uses the resolved runtime browser identity.

### Fixed

- Fixed in-memory Monaco model URIs for absolute local paths so TypeScript diagnostics no longer request decoded double-slash source paths.

## [0.9.100] - 2026-05-21

### Changed

- Bumped the application version for the next release cycle.
- Added browser user-data source settings and profile detection support for built-in browser session reuse.
- Persisted browser user-data source selection through settings migration and storage normalization.

## [0.9.98] - 2026-05-21

### Added

- Added a Gemini 3.5 Flash preset to the RoutiN AI provider list.

### Changed

- Refreshed the tool catalog lifecycle so skills and sub-agents reload from IPC before requests and stay aligned after edits.
- Improved OpenAI chat streaming so tool-call snapshots from either delta or message payloads keep tool-start and tool-delta events consistent.
- Added streaming image-generation support with partial previews for OpenAI image flows and draw page preview state.
- Polished chat tool cards and draw UI so skill calls, file changes, and image previews render more clearly.

### Fixed

- Fixed image-generation partial counts and media type handling so streamed previews and final images stay normalized.

## [0.9.97] - 2026-05-19

### Changed

- Refreshed the SSH and theme settings UI, including SSH connection management, terminal status presentation, and theme preset handling.
- Improved the chat change review flow with a cleaner review card layout and updated transcript rendering.

### Fixed

- Fixed inconsistent code-block styling in SSH support workspaces.

## [0.9.96] - 2026-05-15

### Changed

- Reworked session-scoped agent runtime state so sub-agent panels, orchestration views, tool calls, background processes, and detached session surfaces stay tied to the correct active session.
- Refined the sub-agent execution detail panel and sidebar layout with shared scoped selectors, localized sidebar labels, and cleaner runtime detail routing.
- Improved live sub-agent transcripts with revision-aware rendering and live tool-call state mapping so streaming assistant text and tool results refresh in place.

### Fixed

- Fixed pending assistant placeholders so completed orchestration data does not keep a blank assistant row visible after the primary run has stopped.
- Fixed streaming transcript handling for assistant messages that arrive before static transcript analysis includes them.
- Marked unfinished thinking blocks complete and mirrored live tool-use blocks into sub-agent transcripts when tool-call events arrive.

## [0.9.95] - 2026-05-14

### Added

- Added a runtime status panel in the session view that surfaces sub-agent execution summaries from the title-bar control without occupying the input area.
- Added a standalone runtime todo list with collapse/expand handling and earlier-task indicators for long task histories.

### Changed

- Unified sub-agent run data aggregation for the runtime panel and sub-agent list so both views share filtering, summaries, failure details, and tool-state mapping.
- Moved in-progress todo presentation out of embedded tool-call rendering and replaced the ping animation with a rotating progress indicator for calmer task updates.
- Removed duplicated layout-side session workspace derivation so panel state is computed from the shared runtime data source.

## [0.9.94] - 2026-05-13

### Changed

- Unified Markdown rendering across changelog, preview/detail panels, system command cards, team notifications, plan reviews, context compression summaries, AskUserQuestion previews, sub-agent reports, and thinking blocks by reusing the shared preview Markdown plugin set.
- Moved the session goal bar below the chat input and made it collapsible, with localized show/hide controls to keep the input area calmer while preserving quick goal access.

### Fixed

- Fixed completed team workflows leaving an empty assistant placeholder stuck at the bottom as "thinking" after all team tasks were marked complete.

## [0.9.93] - 2026-05-12

### Added

- Added persistent session goals with database storage, sync events, and goal-aware runtime tools for `get_goal`, `create_goal`, and `update_goal`.
- Added a built-in `/goal` slash command plus context-panel controls to view, edit, pause, resume, and clear the active session goal.
- Added goal usage accounting and auto-continue support so active goals can carry across turns with token/time tracking and budget limits.
- Added task-page controls to abort active runs and render cron plans with second-level precision in the calendar view.

### Changed

- Improved cron schedule validation to use `node-cron`, normalize cron expressions and time zones, and reject invalid schedules before enabling them.
- Reduced task-run loading to the visible calendar window so the task page scales better with larger run histories.
- Hardened OpenAI-compatible chat streaming with a pre-stream OAuth refresh retry for 401/403 failures and better handling for providers that delay terminal SSE chunks.

### Fixed

- Fixed Claude base64 image payloads on the cron Anthropic path to send `media_type` instead of `mediaType`.
- Fixed scheduled-state propagation for cron run completion payloads and broadened OAuth expiry parsing for providers that return nonstandard `expires_at` fields.

## [0.9.92] - 2026-05-12

### Added

- Added assistant-message branching so a new session can be forked directly from a previous reply.
- Added Anthropic tool replay normalization to keep `tool_use` and `tool_result` history aligned when restoring forked or background sessions.

### Changed

- Scoped right-panel, terminal, browser, SSH preview, and related UI state by both session and project to prevent cross-session leakage.
- Hardened the dev startup flow by clearing the Vite cache and pinning the renderer port before launching.
- Refined Codex OAuth header handling to strip `session_id` and `conversation_id` outside supported `chatgpt.com/backend-api/codex` flows.
- Refreshed the packaged desktop icons.

### Fixed

- Prevented stale or misaligned Anthropic tool history when replaying forked sessions.

## [0.9.91] - 2026-05-11

### Added

- Refactored backend tools and frontend panels with full search/grep/cache and rich preview capabilities.
- Added new renderer components for rich content preview caching and search result display.
- Enhanced IPC tool channel to support grep search, tool cache, and content preview.

### Changed

- Restructured backend tool registration and frontend panel layout for better maintainability.
- Improved tool execution pipeline with caching layer and optimized data flow.

### Fixed

- N/A

## [0.9.90] - 2026-05-08

### Added

- Added reasoning mode support for Anthropic/OpenAI with thinking/reasoning parameter passthrough, cache control, and prompt caching markers.
- Added browser plugin capability with IPC for cookie cleanup and tool re-registration on project switch.
- Added new DAO interfaces for querying user messages only and for reverse-lookup run changes by sessionId and toolUseIds.
- Added reasoning effort mapping directly supporting `xhigh` without client-side normalization.

### Changed

- Refactored streaming chat and tool chain to be runtime-state-driven: removed legacy `long_running_mode` field, now driven by current runtime state and configuration.
- Narrowed theme presets to the default only; removed global theme panel, SSH terminal theme panel, and redundant session title display. Settings migration falls back to default theme on old versions.
- Simplified message list to always load all session messages at once; removed "load earlier messages" button, auto-fill, and scroll anchor recovery. Added session-level deduplication to prevent duplicate tail tool restores.
- Completed Anthropic SSE/usage handling: unified `message_start/message_delta/message_stop` and `data.type`, aggregated input/output/cache read/cache creation/reasoning token stats, with cache writes billed per 5m/1h buckets. Tool call end events flush at stream end; `message_end` acts as fallback.
- Rewrote Clarify mode prompt as a strict "clarify first, then plan" flow with enforced `AskUserQuestion`/`EnterPlanMode`/`ExitPlanMode` closure.
- Enhanced file edit tool to preserve original line-ending style (CRLF/LF), avoiding mixed line endings.
- Tool output with structured errors is now recognized as failure instead of success.
- Run change queries expanded from exact runId match to also support sessionId and toolUseIds reverse-lookup.
- Improved stream rendering with new typing render pool, finer-grained animation classes, and progressive Markdown/table/component reveal.
- AssistantMessage now binds run changes precisely via tool_use ids, filtering out failed file tool results.
- Cron recovery marks still-running background runs as aborted on app restart to prevent hanging states.
- Enhanced request header forwarding security to avoid duplicating body-managed headers.

### Fixed

- Fixed multi-line code block and local path recognition in Markdown rendering.
- Stopped duplicate tail tool restoration when resuming sessions.

## [0.9.87] - 2026-05-07

### Added

- Added a new sidebar entry for drawing, with menu highlighting integrated so the feature is discoverable from the main navigation.
- Added streaming markdown incremental rendering support via `markstream-react` so LLM responses render only newly arrived content.
- Added clarify-prompt and AskUserQuestion flow improvements to make interactive follow-up questions more reliable.
- Added guarded session-clearing actions in the sidebar to reduce accidental destructive operations.

### Changed

- Aligned SSH workspace chrome with theme tokens for more consistent visual integration.
- Stabilized provider transport and image persistence in the main process to improve reliability during content handling.
- Improved chat prompt handling and refined the main user-interaction flow.

### Fixed

- Prevented the message list from auto-scrolling while `AskUserQuestion` is pending.

## [0.9.86] - 2026-05-07

### Added

- Added OpenAI image part support utilities and `request_debug` event type for richer streaming observability.
- Added model context length and max output token parsing so discovered model capabilities are reflected in provider settings.
- Added `request_debug` event emission in cron execution, image content filtering, and a 20-result cap on search tool output for consistency across environments.

### Changed

- Improved OpenAI chat provider with structured token usage tracking and image part support for more accurate streaming metadata.
- Normalized search result limits across SSH, local, and cron tool execution paths to cap at 20 results uniformly.

### Fixed

- Stopped auto-scroll when `AskUserQuestion` is pending, preventing the message list from jumping during user input prompts.
