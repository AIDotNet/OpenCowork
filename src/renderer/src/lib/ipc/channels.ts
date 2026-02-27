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
  PLUGIN_STREAM_FINISH: 'plugin:stream:finish',

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
  CRON_FIRED: 'cron:fired',
  CRON_JOB_REMOVED: 'cron:job-removed',
  CRON_RUN_FINISHED: 'cron:run-finished',

  // Notify
  NOTIFY_DESKTOP: 'notify:desktop',
  NOTIFY_SESSION: 'notify:session',

  // App Updates
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_DOWNLOAD: 'update:download',

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

  // Clipboard
  CLIPBOARD_WRITE_IMAGE: 'clipboard:write-image',

  // Web Search
  WEB_SEARCH: 'web:search',
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

  // SSH Remote Exec
  SSH_EXEC: 'ssh:exec',
} as const

export type IPCChannel = (typeof IPC)[keyof typeof IPC]
