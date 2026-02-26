# Plan

1. Add a file-based SSH config store in the main process (`~/.open-cowork.json`), including JSON read/write helpers, in-memory cache, and a watcher that reloads on external edits.
2. Update SSH IPC handlers to use the JSON store instead of SQLite (groups, connections, test, connect, updates to lastConnectedAt), and broadcast a `ssh:config:changed` event on writes and file changes.
3. Listen for `ssh:config:changed` in the renderer root and call `useSshStore.getState().loadAll()` so UI updates live.
4. Keep existing renderer APIs unchanged; no DB migration.
