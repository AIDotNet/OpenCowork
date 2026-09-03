import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REMOTE_CONTROL_DEFAULT_API_BASE_URL,
  normalizeRemoteControlApiBaseUrl,
  parseRemoteDesktopSessionResponse,
  unwrapRemoteRouteResult
} from '../../src/shared/remote-control.ts'
import { appendAccessTokenQuery } from '../../src/main/remote-control/signalr-access-token-websocket.ts'

test('defaults an empty API address to api.routin.ai', () => {
  assert.equal(normalizeRemoteControlApiBaseUrl(''), REMOTE_CONTROL_DEFAULT_API_BASE_URL)
  assert.equal(normalizeRemoteControlApiBaseUrl('   '), REMOTE_CONTROL_DEFAULT_API_BASE_URL)
  assert.equal(normalizeRemoteControlApiBaseUrl(null), REMOTE_CONTROL_DEFAULT_API_BASE_URL)
})

test('adds https when the host is typed without a scheme', () => {
  assert.equal(normalizeRemoteControlApiBaseUrl('api.routin.ai'), 'https://api.routin.ai')
})

test('keeps an explicit scheme and strips trailing slashes', () => {
  assert.equal(normalizeRemoteControlApiBaseUrl('https://api.routin.ai/'), 'https://api.routin.ai')
  assert.equal(
    normalizeRemoteControlApiBaseUrl('http://localhost:5000/hubs/'),
    'http://localhost:5000/hubs'
  )
})

test('parses a desktop-session payload from the API envelope', () => {
  assert.deepEqual(
    parseRemoteDesktopSessionResponse({
      data: { accessToken: 'hub-jwt', expiresInSeconds: 7200 },
      code: 200
    }),
    { accessToken: 'hub-jwt', expiresInSeconds: 7200 }
  )
})

test('rejects a desktop-session payload without a hub token', () => {
  assert.equal(parseRemoteDesktopSessionResponse({ expiresInSeconds: 7200 }), null)
  assert.equal(parseRemoteDesktopSessionResponse({ accessToken: '', expiresInSeconds: 7200 }), null)
})

test('appends access_token to a SignalR hub URL once', () => {
  assert.equal(
    appendAccessTokenQuery('https://api.routin.ai/hubs/remote-control', 'hub jwt'),
    'https://api.routin.ai/hubs/remote-control?access_token=hub%20jwt'
  )
  assert.equal(
    appendAccessTokenQuery('https://api.routin.ai/hubs/remote-control?id=1', 'tok'),
    'https://api.routin.ai/hubs/remote-control?id=1&access_token=tok'
  )
  assert.equal(
    appendAccessTokenQuery('https://api.routin.ai/hubs/remote-control?access_token=old', 'new'),
    'https://api.routin.ai/hubs/remote-control?access_token=old'
  )
})

test('unwraps renderer remote replies so the phone sees the business payload', () => {
  assert.deepEqual(
    unwrapRemoteRouteResult(
      { id: 'req-1', ok: true, data: { workspaces: [{ id: 'p1' }] } },
      'renderer'
    ),
    { kind: 'res', payload: { workspaces: [{ id: 'p1' }] } }
  )
  assert.deepEqual(
    unwrapRemoteRouteResult(
      { id: 'req-2', ok: false, error: { code: 'timeout', message: 'Renderer request timed out' } },
      'renderer'
    ),
    { kind: 'err', payload: { code: 'timeout', message: 'Renderer request timed out' } }
  )
  assert.deepEqual(unwrapRemoteRouteResult({ terminals: [] }, 'main'), {
    kind: 'res',
    payload: { terminals: [] }
  })
})
