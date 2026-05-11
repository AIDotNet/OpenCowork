# Changelog

All notable changes to this project will be documented in this file.

## [0.9.91] - 2026-06-18

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
