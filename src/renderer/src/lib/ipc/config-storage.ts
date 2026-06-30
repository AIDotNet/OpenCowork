import { createIpcStateStorage } from './ipc-state-storage'

/**
 * Custom Zustand StateStorage that delegates to ~/.open-cowork/config.json
 * via IPC. Used for provider configurations including API keys.
 */
export const configStorage = createIpcStateStorage({
  getChannel: 'config:get',
  setChannel: 'config:set'
})
