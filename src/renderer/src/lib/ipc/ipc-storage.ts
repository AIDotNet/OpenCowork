import { createIpcStateStorage } from './ipc-state-storage'

/**
 * Custom Zustand StateStorage that delegates to main process settings.json
 * via IPC, replacing localStorage.
 */
export const ipcStorage = createIpcStateStorage({
  getChannel: 'settings:get',
  setChannel: 'settings:set'
})
