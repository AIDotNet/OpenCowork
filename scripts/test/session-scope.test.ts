import assert from 'node:assert/strict'
import test from 'node:test'
import { isProjectSession, workspaceContextAvailable } from '../../src/renderer/src/lib/session-scope.ts'

test('home with a selected project is project-scoped before a session exists', () => {
  assert.equal(
    isProjectSession({
      chatView: 'home',
      activeProjectId: 'proj-1'
    }),
    true
  )
  assert.equal(
    workspaceContextAvailable({
      chatView: 'home',
      activeProjectId: 'proj-1',
      workingFolder: '/repo'
    }),
    true
  )
})

test('home without a project stays a global chat composer', () => {
  assert.equal(
    isProjectSession({
      chatView: 'home',
      activeProjectId: null
    }),
    false
  )
})

test('an existing session is scoped by its own projectId', () => {
  assert.equal(
    isProjectSession({
      chatView: 'session',
      session: { projectId: 'proj-1' },
      activeProjectId: 'proj-1'
    }),
    true
  )
  assert.equal(
    isProjectSession({
      chatView: 'session',
      session: { projectId: null },
      activeProjectId: 'proj-1'
    }),
    false
  )
})
