# Changelog

All notable changes to this project will be documented in this file.

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
