# Changelog

All notable changes to **OpenCowork** will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com).

## [0.7.5] - 2026-03-29

### Fixed

- Stopped excluding `partial-json` from the packaged app so the main process can resolve it at startup; fixes `Cannot find module 'partial-json'` after install on Windows and other platforms.

### Changed

- Updated the docs homepage release badge from `v0.7.4` to `v0.7.5`.

## [0.7.4] - 2026-03-29

### Added

- Added main-process background execution for scheduled agents so cron jobs can run with progress reporting, abort support, and delivery handling outside the active chat view.
- Added direct project creation from selected local folders by reusing the working-folder picker across workspace entry points.

### Changed

- Synced the Bun lockfile with the current dependency set.
- Added a sponsors section to both `README.md` and `README.zh.md`.
- Updated the docs homepage release badge from `v0.7.3` to `v0.7.4`.

### Fixed

- Normalized provider and model selection by category so chat, draw, translate, plugin, and settings pickers prefer enabled providers that are ready for authentication.
- Stabilized chat message list auto-scroll so streaming output stays visible without causing unnecessary jumps while browsing history.
- Fixed Weixin media API requests by forwarding `X-WECHAT-UIN` to upload and download endpoints used by media operations.

## [0.7.3] - 2026-03-27

### Changed

- Improved chat composer and settings layouts with better input height calculation, file editor spacing, provider organization, and clearer SubAgent error presentation.
- Synced the Bun lockfile so virtualization-related dependencies stay aligned with the declared package set.
- Updated the docs homepage release badge from `v0.7.2` to `v0.7.3`.

### Fixed

- Prevented IPC broadcasts from failing when renderer windows or frames are already disposed by centralizing safe window send helpers.
- Recovered Weixin message polling after remote session timeouts by resetting the polling cursor and retry cadence automatically.
- Kept embedded SubAgent execution details in a single-column layout for more stable rendering.

## [0.7.2] - 2026-03-26

### Added

- Added a reusable project working folder selector that supports both local desktop folders and SSH targets from chat home, project home, and the workspace sidebar.
- Added persisted SubAgent history snapshots so detail views can continue to show transcript and report context after execution completes.

### Changed

- Improved the SubAgents experience with richer detail rendering, transcript-specific tool presentation, grouped history display, and clearer report status feedback.
- Updated the docs homepage release badge from `v0.7.1` to `v0.7.2`.

### Fixed

- Fixed usage analytics model and provider resolution by carrying request debug metadata through usage recording and falling back to session context when needed.

### Refactored

- Removed the legacy renderer wiki navigation route and obsolete wiki-related UI state wiring.

## [0.7.1] - 2026-03-26

### Added

- Added a dedicated SubAgents detail panel with transcript rendering, execution progress, task input context, and report states for teammate runs.
- Added ACP-specific empty-state hints and homepage copy so users can understand empty sessions more quickly.
- Added a dedicated `Routin AI（套餐）` built-in provider preset to expose the `https://cn.routin.ai/plan/v1` model lineup.

### Changed

- Expanded the workspace experience with richer side-panel behavior and improved SubAgents panel layout, navigation, and localization copy.
- Updated Anthropic model capability metadata and reasoning effort labels, including support for the `max` effort level where applicable.
- Updated the docs homepage release badge from `v0.6.6` to `v0.7.1`.

### Fixed

- Improved ACP chat empty-state handling so guidance stays consistent across chat home and message list views.
- Improved wiki document access by returning tree metadata and preserving leaf-level source file references for tool and page consumers.

### Refactored

- Removed the legacy OpenAI Responses websocket transport preference across providers, channels, and related settings.
- Refactored project wiki generation toward a tree-based document structure with leaf-node generation flow and sidebar browsing support.

## [0.7.0] - 2026-03-25

### Refactored

- **chat**: Remove virtual scroll from MessageList component, simplify static list rendering and remove `@tanstack/react-virtual` dependency
- **ui**: Replace store method calls with direct state access for channel, MCP, and auto-model selection states
- **cowork**: Optimize ContextPanel provider state access with shallow comparison to reduce unnecessary re-renders

### Changed

- Updated tsconfig.web.tsbuildinfo build artifacts
- Fixed line ending formatting warnings across multiple component files

## [0.6.6] - 2026-03-25

### Added

- Added SSH configuration import support for both OpenCoWork exports and OpenSSH config files, including conflict preview, selective import actions, and automatic connection list refresh.
- Added an application-level auto-update toggle in Settings so automatic update checks can be enabled or disabled persistently.

### Changed

- Improved project memory resolution to prefer workspace-local `.agents` files with fallback to legacy root memory files, and applied project `AGENTS.md` content to prompt recommendations for local sessions.
- Simplified skills market access by allowing users to browse and test marketplace availability without requiring an API key upfront.
- Refined chat and workspace UI behavior across project home/archive pages, sidebar layout, selected-file handling, and session presentation.
- Updated the documentation homepage release badge from `v0.6.5` to `v0.6.6`.

### Fixed

- Kept the chat composer state in sync more reliably after document updates and initialization.
- Cleaned up pending session state more thoroughly when deleting sessions or projects.
- Closed the draw page when entering sessions, opened markdown preview links externally, and preserved terminal/tool state consistency after aborted runs.

## [0.6.5] - 2026-03-24

### Added

- Added project workspace navigation with dedicated project home/archive pages, a workspace sidebar, and project-bound channel settings.
- Added a built-in `/plan` command for entering Plan Mode directly from chat.
- Added personal Weixin media support for sending images/files and downloading inbound image messages for multimodal processing.
- Added an open source agent SDK survey covering Python, TypeScript, C#, and Java options.

### Changed

- Improved the chat composer and message actions with file-aware drafting, queued draft editing, and attachment-aware layout behavior.
- Expanded the onboarding tour with dedicated Clarify, Cowork, and Code mode guidance plus updated English and Chinese copy.
- Updated the docs Docker build and CI workflow to use safer memory settings and Node.js 22.

### Fixed

- Flushed completed tool events before ending aborted agent runs so terminal tool states stay consistent.
- Fixed the home composer sizing when attachments are present.
- Hardened the macOS unsigned build and release signing flow with stronger validation, ad-hoc signing support, and library validation adjustments.

### Refactored

- Simplified the channel settings panel layout by removing redundant project-name prop threading.
- Removed redundant hover tooltip content from the right panel rail tabs.
