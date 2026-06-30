import { decode, encode } from '@msgpack/msgpack'

export const SIDECAR_APPROVAL_REQUEST_MSGPACK_CHANNEL = 'sidecar:approval-request:msgpack'
export const SIDECAR_APPROVAL_RESPONSE_MSGPACK_CHANNEL = 'sidecar:approval-response:msgpack'
export const SIDECAR_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL = 'sidecar:renderer-tool-request:msgpack'
export const SIDECAR_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL =
  'sidecar:renderer-tool-response:msgpack'

export const DB_MESSAGES_UPSERT_MSGPACK_CHANNEL = 'db:messages:upsert:msgpack'
export const DB_MESSAGES_ADD_BATCH_MSGPACK_CHANNEL = 'db:messages:add-batch:msgpack'
export const DB_MESSAGES_LIST_MSGPACK_CHANNEL = 'db:messages:list:msgpack'
export const DB_MESSAGES_LIST_USER_MSGPACK_CHANNEL = 'db:messages:list-user:msgpack'
export const DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL = 'db:messages:list-page:msgpack'
export const DB_MESSAGES_SEARCH_CONTENT_MSGPACK_CHANNEL = 'db:messages:search-content:msgpack'
export const DB_MESSAGES_UPDATE_MSGPACK_CHANNEL = 'db:messages:update:msgpack'
export const DB_MESSAGES_CLEAR_MSGPACK_CHANNEL = 'db:messages:clear:msgpack'
export const DB_MESSAGES_DELETE_MSGPACK_CHANNEL = 'db:messages:delete:msgpack'
export const DB_MESSAGES_REPLACE_MSGPACK_CHANNEL = 'db:messages:replace:msgpack'
export const DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL = 'db:messages:truncate-from:msgpack'
export const DB_MESSAGES_COUNT_MSGPACK_CHANNEL = 'db:messages:count:msgpack'

export const DB_PROJECTS_LIST_MSGPACK_CHANNEL = 'db:projects:list:msgpack'
export const DB_PROJECTS_GET_MSGPACK_CHANNEL = 'db:projects:get:msgpack'
export const DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL = 'db:projects:ensure-default:msgpack'
export const DB_PROJECTS_CREATE_MSGPACK_CHANNEL = 'db:projects:create:msgpack'
export const DB_PROJECTS_UPDATE_MSGPACK_CHANNEL = 'db:projects:update:msgpack'
export const DB_PROJECTS_DELETE_MSGPACK_CHANNEL = 'db:projects:delete:msgpack'

export const DB_SESSIONS_LIST_MSGPACK_CHANNEL = 'db:sessions:list:msgpack'
export const DB_SESSIONS_GET_MSGPACK_CHANNEL = 'db:sessions:get:msgpack'
export const DB_SESSIONS_CREATE_MSGPACK_CHANNEL = 'db:sessions:create:msgpack'
export const DB_SESSIONS_UPDATE_MSGPACK_CHANNEL = 'db:sessions:update:msgpack'
export const DB_SESSIONS_DELETE_MSGPACK_CHANNEL = 'db:sessions:delete:msgpack'
export const DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL = 'db:sessions:clear-all:msgpack'

export const DB_GOALS_LIST_MSGPACK_CHANNEL = 'db:goals:list:msgpack'
export const DB_GOALS_GET_MSGPACK_CHANNEL = 'db:goals:get:msgpack'
export const DB_GOALS_CREATE_MSGPACK_CHANNEL = 'db:goals:create:msgpack'
export const DB_GOALS_SET_MSGPACK_CHANNEL = 'db:goals:set:msgpack'
export const DB_GOALS_UPDATE_MSGPACK_CHANNEL = 'db:goals:update:msgpack'
export const DB_GOALS_CLEAR_MSGPACK_CHANNEL = 'db:goals:clear:msgpack'
export const DB_GOALS_ACCOUNT_MSGPACK_CHANNEL = 'db:goals:account:msgpack'
export const DB_GOAL_EVENTS_LIST_MSGPACK_CHANNEL = 'db:goal-events:list:msgpack'
export const DB_GOAL_EVENTS_ADD_MSGPACK_CHANNEL = 'db:goal-events:add:msgpack'

export const DB_DRAW_RUNS_LIST_MSGPACK_CHANNEL = 'db:draw-runs:list:msgpack'
export const DB_DRAW_RUNS_SAVE_MSGPACK_CHANNEL = 'db:draw-runs:save:msgpack'
export const DB_DRAW_RUNS_DELETE_MSGPACK_CHANNEL = 'db:draw-runs:delete:msgpack'
export const DB_DRAW_RUNS_CLEAR_MSGPACK_CHANNEL = 'db:draw-runs:clear:msgpack'

export const DB_PLANS_LIST_MSGPACK_CHANNEL = 'db:plans:list:msgpack'
export const DB_PLANS_GET_MSGPACK_CHANNEL = 'db:plans:get:msgpack'
export const DB_PLANS_GET_BY_SESSION_MSGPACK_CHANNEL = 'db:plans:get-by-session:msgpack'
export const DB_PLANS_CREATE_MSGPACK_CHANNEL = 'db:plans:create:msgpack'
export const DB_PLANS_UPDATE_MSGPACK_CHANNEL = 'db:plans:update:msgpack'
export const DB_PLANS_DELETE_MSGPACK_CHANNEL = 'db:plans:delete:msgpack'

export const DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL = 'db:tasks:list-by-session:msgpack'
export const DB_TASKS_GET_MSGPACK_CHANNEL = 'db:tasks:get:msgpack'
export const DB_TASKS_CREATE_MSGPACK_CHANNEL = 'db:tasks:create:msgpack'
export const DB_TASKS_UPDATE_MSGPACK_CHANNEL = 'db:tasks:update:msgpack'
export const DB_TASKS_DELETE_MSGPACK_CHANNEL = 'db:tasks:delete:msgpack'
export const DB_TASKS_DELETE_BY_SESSION_MSGPACK_CHANNEL = 'db:tasks:delete-by-session:msgpack'

export const USAGE_EVENTS_ADD_MSGPACK_CHANNEL = 'usage-events:add:msgpack'
export const USAGE_EVENTS_OVERVIEW_MSGPACK_CHANNEL = 'usage-events:overview:msgpack'
export const USAGE_EVENTS_DAILY_MSGPACK_CHANNEL = 'usage-events:daily:msgpack'
export const USAGE_EVENTS_TIMELINE_MSGPACK_CHANNEL = 'usage-events:timeline:msgpack'
export const USAGE_EVENTS_BY_MODEL_MSGPACK_CHANNEL = 'usage-events:by-model:msgpack'
export const USAGE_EVENTS_BY_PROVIDER_MSGPACK_CHANNEL = 'usage-events:by-provider:msgpack'
export const USAGE_EVENTS_LIST_MSGPACK_CHANNEL = 'usage-events:list:msgpack'
export const USAGE_EVENTS_CLEAR_MSGPACK_CHANNEL = 'usage-events:clear:msgpack'
export const USAGE_ACTIVITY_OVERVIEW_MSGPACK_CHANNEL = 'usage-activity:overview:msgpack'
export const USAGE_ACTIVITY_DAILY_MSGPACK_CHANNEL = 'usage-activity:daily:msgpack'
export const USAGE_ACTIVITY_BY_MODEL_MSGPACK_CHANNEL = 'usage-activity:by-model:msgpack'
export const USAGE_ACTIVITY_BY_PROVIDER_MSGPACK_CHANNEL = 'usage-activity:by-provider:msgpack'

export function toMessagePackChannel(channel: string): string {
  return channel.endsWith(':msgpack') ? channel : `${channel}:msgpack`
}

export function encodeMessagePackPayload(value: unknown): Uint8Array {
  return encode(value)
}

export function decodeMessagePackPayload<T = unknown>(bytes: ArrayBuffer | ArrayBufferView): T {
  return decode(toUint8Array(bytes)) as T
}

export function toUint8Array(bytes: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
