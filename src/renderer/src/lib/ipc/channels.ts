// IPC Channel Constants

export const IPC = {
  // App
  APP_HOMEDIR: 'app:homedir',

  // API Streaming
  API_STREAM_REQUEST: 'api:stream-request',
  API_STREAM_CHUNK: 'api:stream-chunk',
  API_STREAM_END: 'api:stream-end',
  API_STREAM_ERROR: 'api:stream-error',
  API_QUOTA_UPDATE: 'api:quota-update',
  API_ABORT: 'api:abort',

  // File System
  FS_SELECT_FILE: 'fs:select-file',
  FS_SELECT_SAVE_FILE: 'fs:select-save-file',
  FS_READ_DOCUMENT: 'fs:read-document',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_LIST_DIR: 'fs:list-dir',
  FS_MKDIR: 'fs:mkdir',
  FS_DELETE: 'fs:delete',
  FS_MOVE: 'fs:move',
  FS_SELECT_FOLDER: 'fs:select-folder',
  FS_GLOB: 'fs:glob',
  FS_GREP: 'fs:grep',

  // File Watching
  FS_WATCH_FILE: 'fs:watch-file',
  FS_UNWATCH_FILE: 'fs:unwatch-file',
  FS_FILE_CHANGED: 'fs:file-changed',
  FS_READ_FILE_BINARY: 'fs:read-file-binary',
  FS_WRITE_FILE_BINARY: 'fs:write-file-binary',

  // Shell
  SHELL_EXEC: 'shell:exec',
  SHELL_ABORT: 'shell:abort',
  SHELL_OPEN_PATH: 'shell:openPath',
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',

  // Local Terminal
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_LIST: 'terminal:list',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',

  // Agent Changes
  AGENT_CHANGES_LIST: 'agent:changes:list',
  AGENT_CHANGES_ACCEPT: 'agent:changes:accept',
  AGENT_CHANGES_ACCEPT_FILE: 'agent:changes:accept-file',
  AGENT_CHANGES_ROLLBACK: 'agent:changes:rollback',
  AGENT_CHANGES_ROLLBACK_FILE: 'agent:changes:rollback-file',

  // Process Management
  PROCESS_SPAWN: 'process:spawn',
  PROCESS_KILL: 'process:kill',
  PROCESS_WRITE: 'process:write',
  PROCESS_STATUS: 'process:status',
  PROCESS_LIST: 'process:list',
  PROCESS_OUTPUT: 'process:output',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Migration
  MIGRATION_PREVIEW: 'migration:preview',
  MIGRATION_APPLY: 'migration:apply',

  // Usage Analytics
  USAGE_EVENTS_ADD: 'usage-events:add',
  USAGE_EVENTS_OVERVIEW: 'usage-events:overview',
  USAGE_EVENTS_DAILY: 'usage-events:daily',
  USAGE_EVENTS_TIMELINE: 'usage-events:timeline',
  USAGE_EVENTS_BY_MODEL: 'usage-events:by-model',
  USAGE_EVENTS_BY_PROVIDER: 'usage-events:by-provider',
  USAGE_EVENTS_LIST: 'usage-events:list',

  // Plugins
  PLUGIN_LIST_PROVIDERS: 'plugin:list-providers',
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_ADD: 'plugin:add',
  PLUGIN_UPDATE: 'plugin:update',
  PLUGIN_REMOVE: 'plugin:remove',
  PLUGIN_START: 'plugin:start',
  PLUGIN_STOP: 'plugin:stop',
  PLUGIN_STATUS: 'plugin:status',
  PLUGIN_EXEC: 'plugin:exec',
  PLUGIN_SESSIONS_LIST: 'plugin:sessions:list',
  PLUGIN_SESSIONS_LIST_ALL: 'plugin:sessions:list-all',
  PLUGIN_SESSIONS_MESSAGES: 'plugin:sessions:messages',
  PLUGIN_SESSIONS_CREATE: 'plugin:sessions:create',
  PLUGIN_SESSIONS_CLEAR: 'plugin:sessions:clear',
  PLUGIN_SESSIONS_DELETE: 'plugin:sessions:delete',
  PLUGIN_SESSIONS_RENAME: 'plugin:sessions:rename',
  PLUGIN_INCOMING_MESSAGE: 'plugin:incoming-message',
  PLUGIN_SESSION_TASK: 'plugin:session-task',
  PLUGIN_SESSIONS_FIND_BY_CHAT: 'plugin:sessions:find-by-chat',
  PLUGIN_STREAM_START: 'plugin:stream:start',
  PLUGIN_STREAM_UPDATE: 'plugin:stream:update',
  PLUGIN_STREAM_APPEND: 'plugin:stream:append',
  PLUGIN_STREAM_FINISH: 'plugin:stream:finish',

  // Weixin-specific
  PLUGIN_WEIXIN_LOGIN_START: 'plugin:weixin:login-start',
  PLUGIN_WEIXIN_LOGIN_WAIT: 'plugin:weixin:login-wait',
  PLUGIN_WEIXIN_SEND_IMAGE: 'plugin:weixin:send-image',
  PLUGIN_WEIXIN_SEND_FILE: 'plugin:weixin:send-file',

  // Feishu-specific
  PLUGIN_FEISHU_SEND_IMAGE: 'plugin:feishu:send-image',
  PLUGIN_FEISHU_SEND_FILE: 'plugin:feishu:send-file',
  PLUGIN_FEISHU_SEND_MENTION: 'plugin:feishu:send-mention',
  PLUGIN_FEISHU_LIST_MEMBERS: 'plugin:feishu:list-members',
  PLUGIN_FEISHU_SEND_URGENT: 'plugin:feishu:send-urgent',
  PLUGIN_FEISHU_DOWNLOAD_RESOURCE: 'plugin:feishu:download-resource',
  PLUGIN_FEISHU_BITABLE_LIST_APPS: 'plugin:feishu:bitable:list-apps',
  PLUGIN_FEISHU_BITABLE_LIST_TABLES: 'plugin:feishu:bitable:list-tables',
  PLUGIN_FEISHU_BITABLE_LIST_FIELDS: 'plugin:feishu:bitable:list-fields',
  PLUGIN_FEISHU_BITABLE_GET_RECORDS: 'plugin:feishu:bitable:get-records',
  PLUGIN_FEISHU_BITABLE_CREATE_RECORDS: 'plugin:feishu:bitable:create-records',
  PLUGIN_FEISHU_BITABLE_UPDATE_RECORDS: 'plugin:feishu:bitable:update-records',
  PLUGIN_FEISHU_BITABLE_DELETE_RECORDS: 'plugin:feishu:bitable:delete-records',

  // MCP
  MCP_LIST: 'mcp:list',
  MCP_ADD: 'mcp:add',
  MCP_UPDATE: 'mcp:update',
  MCP_REMOVE: 'mcp:remove',
  MCP_CONNECT: 'mcp:connect',
  MCP_DISCONNECT: 'mcp:disconnect',
  MCP_STATUS: 'mcp:status',
  MCP_SERVER_INFO: 'mcp:server-info',
  MCP_ALL_SERVERS_INFO: 'mcp:all-servers-info',
  MCP_LIST_TOOLS: 'mcp:list-tools',
  MCP_CALL_TOOL: 'mcp:call-tool',
  MCP_LIST_RESOURCES: 'mcp:list-resources',
  MCP_READ_RESOURCE: 'mcp:read-resource',
  MCP_LIST_PROMPTS: 'mcp:list-prompts',
  MCP_GET_PROMPT: 'mcp:get-prompt',
  MCP_REFRESH_CAPABILITIES: 'mcp:refresh-capabilities',

  // Cron Scheduler (v2)
  CRON_ADD: 'cron:add',
  CRON_UPDATE: 'cron:update',
  CRON_REMOVE: 'cron:remove',
  CRON_LIST: 'cron:list',
  CRON_TOGGLE: 'cron:toggle',
  CRON_RUN_NOW: 'cron:run-now',
  CRON_RUNS: 'cron:runs',
  CRON_RUN_CREATE: 'cron:run:create',
  CRON_RUN_UPDATE: 'cron:run:update',
  CRON_RUN_DETAIL: 'cron:run-detail',
  CRON_RUN_MESSAGES_REPLACE: 'cron:run-messages:replace',
  CRON_RUN_LOG_APPEND: 'cron:run-log:append',
  CRON_FIRED: 'cron:fired',
  CRON_JOB_REMOVED: 'cron:job-removed',
  CRON_RUN_FINISHED: 'cron:run-finished',
  CRON_ABORT_RUN: 'cron:abort-run',
  CRON_RUN_STARTED: 'cron:run-started',
  CRON_RUN_PROGRESS: 'cron:run-progress',
  CRON_RUN_LOG_APPENDED: 'cron:run-log-appended',

  // Notify
  NOTIFY_DESKTOP: 'notify:desktop',
  NOTIFY_SESSION: 'notify:session',

  // App Updates
  UPDATE_AVAILABLE: 'update:available',

  // Wiki
  DB_WIKI_LIST_DOCUMENTS: 'db:wiki:list-documents',
  DB_WIKI_GET_DOCUMENT: 'db:wiki:get-document',
  DB_WIKI_GET_DOCUMENT_BY_NAME: 'db:wiki:get-document-by-name',
  DB_WIKI_SAVE_DOCUMENT: 'db:wiki:save-document',
  DB_WIKI_LIST_SECTIONS: 'db:wiki:list-sections',
  DB_WIKI_SAVE_SECTIONS: 'db:wiki:save-sections',
  DB_WIKI_LIST_SECTION_SOURCES: 'db:wiki:list-section-sources',
  DB_WIKI_SAVE_SECTION_SOURCES: 'db:wiki:save-section-sources',
  DB_WIKI_GET_PROJECT_STATE: 'db:wiki:get-project-state',
  DB_WIKI_SAVE_PROJECT_STATE: 'db:wiki:save-project-state',
  DB_WIKI_CLEAR_PROJECT: 'db:wiki:clear-project',
  DB_WIKI_GET_DOCUMENT_DETAIL: 'db:wiki:get-document-detail',
  DB_WIKI_LIST_RUNS: 'db:wiki:list-runs',
  DB_WIKI_CREATE_RUN: 'db:wiki:create-run',
  DB_WIKI_UPDATE_RUN: 'db:wiki:update-run',
  GIT_GET_HEAD: 'git:get-head',
  GIT_GET_RANGE_COMMITS: 'git:get-range-commits',
  GIT_GET_CHANGED_FILES: 'git:get-changed-files',
  GIT_GET_STATUS: 'git:get-status',
  GIT_SCAN_REPOSITORIES: 'git:scan-repositories',
  GIT_GET_REPO_SUMMARY: 'git:get-repo-summary',
  GIT_GET_STATUS_DETAILED: 'git:get-status-detailed',
  GIT_GET_FILE_DIFF: 'git:get-file-diff',
  GIT_GET_FILE_DIFF_AT_COMMIT: 'git:get-file-diff-at-commit',
  GIT_GET_STAGED_DIFF_BUNDLE: 'git:get-staged-diff-bundle',
  GIT_GET_COMMIT_HISTORY: 'git:get-commit-history',
  GIT_LIST_BRANCHES: 'git:list-branches',
  GIT_FETCH: 'git:fetch',
  GIT_PULL_REBASE: 'git:pull-rebase',
  GIT_PUSH: 'git:push',
  GIT_GET_FILE_HISTORY: 'git:get-file-history',
  GIT_CREATE_BRANCH: 'git:create-branch',
  GIT_CHECKOUT_BRANCH: 'git:checkout-branch',
  GIT_MERGE_BRANCH: 'git:merge-branch',
  GIT_REBASE_BRANCH: 'git:rebase-branch',
  GIT_DELETE_LOCAL_BRANCH: 'git:delete-local-branch',
  GIT_DELETE_REMOTE_BRANCH: 'git:delete-remote-branch',
  GIT_RENAME_BRANCH: 'git:rename-branch',
  GIT_STAGE_FILES: 'git:stage-files',
  GIT_UNSTAGE_FILES: 'git:unstage-files',
  GIT_STAGE_ALL: 'git:stage-all',
  GIT_UNSTAGE_ALL: 'git:unstage-all',
  GIT_DISCARD_FILES: 'git:discard-files',
  GIT_COMMIT: 'git:commit',
  WIKI_GENERATE_FULL: 'wiki:generate-full',
  WIKI_REGENERATE: 'wiki:regenerate',
  WIKI_GENERATE_INCREMENTAL: 'wiki:generate-incremental',
  WIKI_GET_HEAD_COMMIT: 'wiki:get-head-commit',
  WIKI_GET_CHANGED_FILES: 'wiki:get-changed-files',
  WIKI_EXPORT_PROJECT: 'wiki:export-project',
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_DOWNLOAD_PROGRESS: 'update:download-progress',
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_ERROR: 'update:error',

  // Skills
  SKILLS_LIST: 'skills:list',
  SKILLS_LOAD: 'skills:load',
  SKILLS_DELETE: 'skills:delete',
  SKILLS_OPEN_FOLDER: 'skills:open-folder',
  SKILLS_ADD_FROM_FOLDER: 'skills:add-from-folder',
  SKILLS_READ: 'skills:read',
  SKILLS_LIST_FILES: 'skills:list-files',
  SKILLS_SAVE: 'skills:save',
  SKILLS_SCAN: 'skills:scan',
  SKILLS_MARKET_LIST: 'skills:market-list',
  SKILLS_DOWNLOAD_REMOTE: 'skills:download-remote',
  SKILLS_CLEANUP_TEMP: 'skills:cleanup-temp',

  // Prompts
  PROMPTS_LIST: 'prompts:list',
  PROMPTS_LOAD: 'prompts:load',

  // Agents
  AGENTS_MANAGE_LIST: 'agents:manage-list',
  AGENTS_MANAGE_READ: 'agents:manage-read',
  AGENTS_MANAGE_SAVE: 'agents:manage-save',

  // Commands
  COMMANDS_LIST: 'commands:list',
  COMMANDS_LOAD: 'commands:load',
  COMMANDS_MANAGE_LIST: 'commands:manage-list',
  COMMANDS_MANAGE_READ: 'commands:manage-read',
  COMMANDS_MANAGE_CREATE: 'commands:manage-create',
  COMMANDS_MANAGE_SAVE: 'commands:manage-save',

  // Clipboard
  CLIPBOARD_WRITE_IMAGE: 'clipboard:write-image',

  // Images
  IMAGE_PERSIST_GENERATED: 'image:persist-generated',
  IMAGE_CREATE_GIF_FROM_GRID: 'image:create-gif-from-grid',

  // Desktop Control
  DESKTOP_SCREENSHOT_CAPTURE: 'desktop:screenshot:capture',
  DESKTOP_INPUT_CLICK: 'desktop:input:click',
  DESKTOP_INPUT_TYPE: 'desktop:input:type',
  DESKTOP_INPUT_SCROLL: 'desktop:input:scroll',

  // Web Search
  WEB_SEARCH: 'web:search',
  WEB_FETCH: 'web:fetch',
  WEB_SEARCH_CONFIG: 'web:search-config',
  WEB_SEARCH_PROVIDERS: 'web:search-providers',

  // OAuth
  OAUTH_START: 'oauth:start',
  OAUTH_STOP: 'oauth:stop',
  OAUTH_CALLBACK: 'oauth:callback',

  // SSH Management
  SSH_GROUP_LIST: 'ssh:group:list',
  SSH_GROUP_CREATE: 'ssh:group:create',
  SSH_GROUP_UPDATE: 'ssh:group:update',
  SSH_GROUP_DELETE: 'ssh:group:delete',
  SSH_CONNECTION_LIST: 'ssh:connection:list',
  SSH_CONNECTION_CREATE: 'ssh:connection:create',
  SSH_CONNECTION_UPDATE: 'ssh:connection:update',
  SSH_CONNECTION_DELETE: 'ssh:connection:delete',
  SSH_CONNECTION_TEST: 'ssh:connection:test',

  // SSH Terminal Sessions
  SSH_CONNECT: 'ssh:connect',
  SSH_DISCONNECT: 'ssh:disconnect',
  SSH_DATA: 'ssh:data',
  SSH_OUTPUT: 'ssh:output',
  SSH_OUTPUT_BUFFER: 'ssh:output:buffer',
  SSH_RESIZE: 'ssh:resize',
  SSH_STATUS: 'ssh:status',
  SSH_SESSION_LIST: 'ssh:session:list',

  // SSH File Operations (SFTP)
  SSH_FS_READ_FILE: 'ssh:fs:read-file',
  SSH_FS_WRITE_FILE: 'ssh:fs:write-file',
  SSH_FS_READ_FILE_BINARY: 'ssh:fs:read-file-binary',
  SSH_FS_WRITE_FILE_BINARY: 'ssh:fs:write-file-binary',
  SSH_FS_LIST_DIR: 'ssh:fs:list-dir',
  SSH_FS_MKDIR: 'ssh:fs:mkdir',
  SSH_FS_DELETE: 'ssh:fs:delete',
  SSH_FS_MOVE: 'ssh:fs:move',
  SSH_FS_GLOB: 'ssh:fs:glob',
  SSH_FS_GREP: 'ssh:fs:grep',
  SSH_FS_HOME_DIR: 'ssh:fs:home-dir',
  SSH_FS_ZIP_DIR: 'ssh:fs:zip-dir',
  SSH_FS_DOWNLOAD: 'ssh:fs:download',
  SSH_FS_UPLOAD_START: 'ssh:fs:upload:start',
  SSH_FS_UPLOAD_CANCEL: 'ssh:fs:upload:cancel',
  SSH_FS_UPLOAD_EVENTS: 'ssh:fs:upload:events',

  // SSH Auth
  SSH_AUTH_INSTALL_PUBLIC_KEY: 'ssh:auth:install-public-key',

  // SSH Import / Export
  SSH_EXPORT: 'ssh:export',
  SSH_IMPORT_PREVIEW: 'ssh:import:preview',
  SSH_IMPORT_APPLY: 'ssh:import:apply',

  // SSH Remote Exec
  SSH_EXEC: 'ssh:exec'
} as const

export type IPCChannel = (typeof IPC)[keyof typeof IPC]
