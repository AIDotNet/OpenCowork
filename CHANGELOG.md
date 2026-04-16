# Changelog

All notable changes to this project will be documented in this file.

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
