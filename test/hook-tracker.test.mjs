import test from 'node:test'
import assert from 'node:assert/strict'
import { HookTracker } from '../src/hook-tracker.mjs'

function payload(sessionId, event, extra = {}) {
  return {
    session_id: sessionId,
    transcript_path: `${sessionId}.jsonl`,
    cwd: 'workspace',
    hook_event_name: event,
    ...extra,
  }
}

test('hook tracker models Stop as turn idle rather than session termination', () => {
  const tracker = new HookTracker({ publish() {} })
  tracker.accept(payload('s1', 'SessionStart', { source: 'startup' }))
  assert.equal(tracker.snapshot().sessions[0].state, 'idle')
  tracker.accept(payload('s1', 'UserPromptSubmit', { prompt: 'next' }))
  assert.equal(tracker.snapshot().sessions[0].state, 'active')
  tracker.accept(payload('s1', 'Stop', { stop_hook_active: false }))
  assert.equal(tracker.snapshot().sessions[0].state, 'idle')
  tracker.accept(payload('s1', 'UserPromptSubmit', { prompt: 'again' }))
  assert.equal(tracker.snapshot().sessions[0].state, 'active')
  tracker.accept(payload('s1', 'SessionEnd', { reason: 'other' }))
  assert.equal(tracker.snapshot().sessions[0].state, 'ended')
})

test('hook tracker keeps same-numbered tasks from different sessions separate', () => {
  const tracker = new HookTracker({ publish() {} })
  tracker.accept(
    payload('s1', 'TaskCreated', {
      task_id: '1',
      task_subject: 'one',
      team_name: 'alpha',
    }),
  )
  tracker.accept(
    payload('s2', 'TaskCreated', {
      task_id: '1',
      task_subject: 'two',
      team_name: 'beta',
    }),
  )
  tracker.accept(
    payload('s1', 'TaskCompleted', {
      task_id: '1',
      task_subject: 'one',
      team_name: 'alpha',
    }),
  )
  const tasks = tracker.snapshot().tasks
  assert.equal(tasks.length, 2)
  assert.equal(tasks.find(task => task.sessionId === 's1').state, 'completed')
  assert.equal(tasks.find(task => task.sessionId === 's2').state, 'created')
})

test('team task completion from a teammate session updates the lead-created task', () => {
  const tracker = new HookTracker({ publish() {} })
  tracker.accept(
    payload('lead-session', 'TaskCreated', {
      task_id: '7',
      task_subject: 'shared work',
      team_name: 'alpha',
      teammate_name: 'team-lead',
    }),
  )
  tracker.accept(
    payload('worker-session', 'TaskCompleted', {
      task_id: '7',
      task_subject: 'shared work',
      team_name: 'alpha',
      teammate_name: 'worker',
    }),
  )

  const tasks = tracker.snapshot().tasks
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].state, 'completed')
  assert.equal(tasks[0].key, 'team:alpha:7')
})
