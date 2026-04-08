# Changelog

All notable changes to **OpenCowork** will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com).

## [0.7.16] - 2026-04-08

### Added

- Added a dedicated local terminal panel in the right sidebar and unified local plus SSH terminal tabs into a consistent terminal workspace.
- Added a running agent session popover and mini window with richer session details, recent message previews, and AI-powered session auto-rename support.
- Added structured agent runtime error surfacing so execution failures are easier to inspect and diagnose.
- Added per-session chat input draft persistence to preserve unfinished prompts across session switches.
- Added sidecar-backed `grep` routing to improve file search handling through the backend runtime.

### Changed

- Enhanced the Electron process model and database schema to better support the evolving multi-process runtime architecture.
- Exposed a shared preview editor handle and persisted Plan Mode content in guarded plan files for safer editor and planning workflows.
- Removed `PatchEdit` tool support as part of the tool surface simplification.
- Synced workspace lockfiles with the current repository state.
- Bumped the app version to `v0.7.16`.
- Updated the docs homepage release badge from `v0.7.15` to `v0.7.16`.

### Fixed

- Handled invalid timing values and queued image paste flow more safely in chat interactions.
- Prevented title bar controls from crowding and stabilized mini session dialog sizing.
- Loaded recent messages for running session previews more reliably.

### Notes

- This release focuses on workspace execution ergonomics: terminal integration is more complete, active agent sessions are easier to inspect, and plan/search flows have been hardened for ongoing multi-agent development.

## [0.7.15] - 2026-04-08

### Added

- Added **LongCat AI** built-in provider preset with 6 models including vision capabilities (Flash Chat, Flash Thinking series, Flash Lite, Flash Omni with image support).
- Added **Claude Code CLI** source code analysis project for learning and research purposes with TypeScript implementation and MCP protocol support.

### Changed

- Bumped the app version to `v0.7.15`.
- Updated the docs homepage release badge from `v0.7.14` to `v0.7.15`.

### Fixed

- No fixes in this release.

### Notes

- This release enhances the platform's AI provider ecosystem and adds valuable learning resources for developers interested in high-quality CLI tool implementations.

## [0.7.13] - 2026-04-06

### Added

- Added support for the latest application update to include additional runtime safety checks before release checks.
- Added improvements to updater behavior under mixed network conditions.

### Changed

- Bumped the app version to `v0.7.13`.
- Updated the docs homepage release badge from `v0.7.12` to `v0.7.13`.

### Fixed

- Kept existing agent and message handling stable while refining update-related flows.
- Improved update package delivery fallback behavior.

### Notes

- This release focuses on update pipeline stability and minor UX/behavior consistency updates around release checks.

## [0.7.10] - 2026-03-30

### Added

- Expanded the `.NET` sidecar role so more provider and message-processing work now runs outside the Electron layer.
- Added shared normalization and replay handling in the provider pipeline to support continued runs and backend-side message shaping.
- Added a reusable code diff viewer in the renderer so file change cards and tool call cards share the same diff presentation.

### Changed

- Moved provider formatting, tool output shaping, and stream replay responsibilities into the `.NET` backend path.
- Consolidated renderer diff rendering around the new shared viewer to reduce duplication between chat cards.
- Bumped the app version to `v0.7.10`.
- Updated the docs homepage release badge from `v0.7.9` to `v0.7.10`.

### Fixed

- Improved OpenAI streaming replay so continued runs preserve tool calls, assistant messages, and formatting more reliably.
- Tightened provider message formatting for tool results and multimodal payloads to reduce replay mismatches and compatibility issues.
- Reduced divergence between the renderer and backend by normalizing more of the message shape in the `.NET` provider layer.

### Notes

- This release continues the backend migration work: more logic has moved from the renderer-facing path into the `.NET` sidecar to make provider handling more consistent and easier to evolve.

## [0.7.9] - 2026-03-30


### Added

- Added a long-running mode for autonomous sessions so the agent can persist this preference per session, auto-answer `AskUserQuestion`, and continue iterating until the work is verified complete.

### Fixed

- Forwarded refs in the shared `Select` primitives to improve Radix integration reliability across renderer UI surfaces.
- Improved the app plugin settings panel so unconfigured plugins resolve state safely instead of failing on missing setup data.
- Preserved nested preview panel height constraints to avoid layout regressions in the renderer preview area.
- Sent `Chatgpt-Account-Id` for OpenAI Responses account-backed requests and included `account_id` in exported provider account JSON.

### Changed

- Bumped the app version to `v0.7.8`.
- Updated the docs homepage release badge from `v0.7.7` to `v0.7.8`.

## [0.7.7] - 2026-03-29

### Changed

- Bumped the app version to `v0.7.7`.
- Updated the docs homepage release badge from `v0.7.6` to `v0.7.7`.

## [0.7.6] - 2026-03-29

### Added

- Added `MiMo V2 Omni` and `MiMo V2 Pro` built-in Xiaomi model presets.

### Changed

- Remembered `reasoning effort` per model so chat and wiki generation can reuse the selected thinking level for each model.
- Updated the docs homepage release badge from `v0.7.5` to `v0.7.6`.

### Fixed

- Stopped filtering legacy built-in models globally so provider presets can control deprecated model visibility explicitly.

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
