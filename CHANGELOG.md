# Changelog

All notable changes to this project will be documented in this file.

## [0.9.2] - 2026-04-17

### Changed

- Removed the sidebar virtual list dependency and unified session cleanup parameters for simpler workspace interactions.
- Updated the chat home, layout, and workspace sidebar components to align with the latest session management flow.
- Refreshed lockfiles to capture the latest dependency graph after the UI and workspace cleanup changes.

## [0.9.1] - 2026-04-16

### Added

- Added dedicated sub-agent limits to cap tool use, read scope, and runtime behavior for safer agent execution.
- Added change review sheet and file-change utility helpers to support richer file diff review flows in the chat UI.

### Changed

- Refined sub-agent creation, resolution, runner, and default prompt flows to better enforce tool availability and execution constraints.
- Updated filesystem and search tool handling for sub-agents and teammate runners to align with the new execution limits.
- Improved skills and steps side panels, plus chat review card interactions, for clearer review workflows.
- Standardized English and Chinese chat locale copy for the updated sub-agent and review experience.

### Fixed

- Fixed sub-agent and runtime protocol behavior in the .NET sidecar to keep agent execution consistent.
- Fixed streaming and review card state handling in the renderer when file changes transition across statuses.

## [0.9.0] - 2026-04-16

### Added

- Added WebSocket session transport support to improve stability and responsiveness for real-time streaming messages.

### Changed

- Updated tool card and thinking block expand/collapse behavior during streaming sessions to keep UI state consistent.
- Improved WebSocket channel status handling with reconnect fallback guidance when connection failures occur.

### Fixed

- Fixed tool call and file-change cards not properly resetting collapsed state when transitioning from streaming to completed status.
- Fixed message list auto-scroll behavior during long streaming output to reduce jitter and false scroll triggers.

## [0.8.7] - 2026-04-16

### Added

- Enhanced `Glob` / `Grep` tool outputs with truncation, timeout, and warning metadata.
- Added workspace and session list improvements, including optional pagination and fast session cleanup actions.

### Changed

- Reworked streaming text block and tool-call rendering behavior to avoid mixed message ordering issues.
- Updated plugin response scheduling and proxy-related API provider settings for improved reliability.

### Fixed

- Fixed stream message cleanup so reasoning/tool-use/tool-result assistant messages are retained correctly.
- Fixed .NET sidecar serialization in streaming metadata to improve compatibility and reduce runtime JSON issues.
- Fixed DingTalk `replyMessage` context replay behavior and webhook reuse for stable group-reply delivery.

## [0.8.5]

- Maintained project version `0.8.5`.
- Documented this patch release.

## [0.8.4]

- Maintained project version `0.8.4`.
- Reserved changelog entry for this minor release.

## [0.8.3]

- Initial project release notes.
