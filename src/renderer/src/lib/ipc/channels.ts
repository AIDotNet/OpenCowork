// IPC Channel Constants

export const IPC = {
  // API Streaming
  API_STREAM_REQUEST: 'api:stream-request',
  API_STREAM_CHUNK: 'api:stream-chunk',
  API_STREAM_END: 'api:stream-end',
  API_STREAM_ERROR: 'api:stream-error',
  API_ABORT: 'api:abort',

  // File System
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

  // Shell
  SHELL_EXEC: 'shell:exec',

  // Process Management
  PROCESS_SPAWN: 'process:spawn',
  PROCESS_KILL: 'process:kill',
  PROCESS_STATUS: 'process:status',
  PROCESS_LIST: 'process:list',
  PROCESS_OUTPUT: 'process:output',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
} as const

export type IPCChannel = (typeof IPC)[keyof typeof IPC]
