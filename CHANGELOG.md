# Changelog

All notable changes to this project will be documented in this file.

## [0.9.73] - 2026-04-24

### Added

- Added interaction tooling to extend the built-in browser with automation-oriented workflow support.

### Changed

- Updated package metadata for the new patch release.

### Fixed

- Synchronized lockfile root metadata version with the package manifest version.

## [0.9.72] - 2026-04-22

### Added

- Added stronger image-generation response handling so cron and related runtime flows can surface generated image results more consistently.

### Changed

- Improved team runtime synchronization and in-session question flows for smoother multi-agent collaboration.
- Streamlined renderer tooling, workspace surfaces, browser panel interactions, and tool preview presentation.
- Refactored agent runtime event bridging and shared loop protocol types to keep streaming and tool state updates more consistent.
- Reduced chat persistence and rendering overhead through batching and related performance optimizations.
- Refreshed project architecture and documentation content to reflect the latest runtime and UI changes.

### Fixed

- Fixed streaming tool preview and persistence edge cases so live tool input and state stay aligned during message updates.
- Fixed settings disk-write behavior with debounced persistence and safer quit-time flushing.

## [0.9.71] - 2026-04-22

### Changed

- Tightened the title-bar project action group styling and switched to a lighter-weight layout.
- Unified the workspace panel and image preview flow, added context statistics, and avoided loading full message history unnecessarily.

## [0.9.7] - 2026-04-22

### Added

- Added Responses image generation support and connected it to the streaming preview/config flow.
- Added richer SSH workstation capabilities, including cross-host transport, split-window sync, and theme synchronization.

### Changed

- Refactored the SSH and terminal systems to support more unified workspace behavior across local and remote sessions.
- Improved SSH connection inspection, file browsing, SFTP workspace flows, terminal status panels, and related i18n coverage.
- Updated theme presets and runtime theme sync so UI appearance stays consistent across layout and settings surfaces.
- Reworked provider, settings, and chat-side flows to align with the new image-generation and SSH experience.

### Fixed

- Fixed several SSH, terminal, and session-store edge cases during navigation, switching, and remote workspace usage.
- Fixed response-stream integration details so image-generation and related protocol changes remain compatible.

## [0.9.6] - 2026-04-21

### Added

- Added background task scheduling support across the main process, IPC layer, and cowork UI.
- Added Responses WebSocket protocol support for provider routing and chat streaming flows.
- Added richer chat streaming error cards with localized coverage for transport, auth, rate-limit, timeout, cancellation, and parameter failures.

### Changed

- Synchronized session runtime state across windows so streaming progress, tool activity, and detached-session focus stay consistent.
- Refactored the working-folder browser into a dedicated drawer, persisted its width, and improved remote workspace navigation behavior.
- Optimized right-panel, message-list, and layout performance to reduce unnecessary rendering and keep panel interactions smoother.
- Refined chat components and tool rendering for WebSocket streaming, including preserving visualize widget tool inputs for downstream rendering.

### Fixed

- Fixed background and provider streaming retries to better handle upstream transport failures, early disconnects, and short-lived error bursts.
- Fixed session creation and persistence ordering so initial messages do not race ahead of newly created sessions.
- Fixed database migration behavior to skip remapping `chat` sessions into project-scoped records.

## [0.9.5] - 2026-04-20

### Added

- Added session isolation improvements to keep conversation-scoped tool sessions separated across windows.
- Added default project/workspace recovery behavior for unbound sessions when an existing project is available.

### Changed

- Updated chat session and sidebar flows to better align with multi-window interactions.
- Refined websocket and streaming handling to improve turn consistency and context delivery.
- Continued improving context compression, message metadata, and related data-flow paths.
- Improved SSH remote search handling and error resilience.
- Kept analytics overview loading lazy for better settings performance.
- Updated README and documentation with clearer usage guidance.

### Fixed

- Fixed stream delta flushing behavior to avoid redundant animation-frame scheduling.
- Fixed queued websocket runs to honor turn boundaries more reliably.
- Fixed remote search to skip ignored directories consistently.

## [0.9.4] - 2026-04-20

### Added

- Added websocket timeout handling improvements with better context-token-aware streaming behavior.
- Added plan execution gating and persisted context compaction metadata to prevent state drift in planned workflows.

### Changed

- Improved sidecar runtime resiliency by adding circuit-break behavior for repeated streaming transport failures.
- Refactored context compression and added message metadata support, including database schema and data-access updates.
- Improved chat assistant message summarization to categorize file-change results more precisely.
- Refactored chat and sidebar interactions to isolate tool sessions by conversation scope and redesigned home input handling.
- Optimized SSH handler behavior with better search error handling.
- Updated README and project documentation to include special thanks and better usage guidance.
- Improved settings performance by lazily loading analytics overview data.
- Improved chat tool activity and diff presentation in review tooling.

### Fixed

- Fixed SSH remote search behavior to skip ignored directories.
- Fixed queued websocket runs to correctly honor turn boundaries.
- Fixed tool behavior around skipped directories and search edge cases in remote SSH sessions.

## [0.9.3] - 2026-04-18

### Changed

- Replaced the direct `electron-builder install-app-deps` postinstall step with `scripts/postinstall.mjs` to rebuild native Electron dependencies with version detection and platform-aware module skipping.

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
