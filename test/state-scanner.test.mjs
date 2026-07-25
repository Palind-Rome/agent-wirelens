import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ClaudeStateScanner } from '../src/state-scanner.mjs'

test('ClaudeStateScanner reads team roster, inbox and active task lists', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wirelens-state-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const teamRoot = path.join(root, 'teams', 'demo')
  const inboxRoot = path.join(teamRoot, 'inboxes')
  const taskRoot = path.join(root, 'tasks', 'demo')
  await fs.mkdir(inboxRoot, { recursive: true })
  await fs.mkdir(taskRoot, { recursive: true })
  await fs.writeFile(
    path.join(teamRoot, 'config.json'),
    JSON.stringify({
      name: 'demo',
      leadAgentId: 'team-lead@demo',
      members: [{ name: 'worker', agentId: 'worker@demo' }],
    }),
  )
  await fs.writeFile(
    path.join(inboxRoot, 'worker.json'),
    JSON.stringify([
      { from: 'team-lead', text: 'hello', read: false, timestamp: 'now' },
    ]),
  )
  await fs.writeFile(
    path.join(taskRoot, '1.json'),
    JSON.stringify({
      id: '1',
      subject: 'Inspect',
      status: 'in_progress',
      owner: 'worker',
    }),
  )

  const snapshot = await new ClaudeStateScanner(root).snapshot()
  assert.equal(snapshot.teams[0].config.name, 'demo')
  assert.equal(snapshot.teams[0].inboxes[0].unread, 1)
  assert.equal(snapshot.taskLists[0].counts.inProgress, 1)
})
