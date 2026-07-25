import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CaptureStore } from '../src/capture-store.mjs'

test('capture persistence failure is recorded without rejecting completion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wirelens-persist-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const notDirectory = path.join(root, 'plain-file')
  await fs.writeFile(notDirectory, 'not a directory')
  const events = []
  const store = new CaptureStore({
    maxRecords: 2,
    captureDir: notDirectory,
    eventHub: {
      publish(type) {
        events.push(type)
      },
    },
  })
  const record = store.create({
    method: 'POST',
    path: '/v1/messages',
    byteLength: 0,
  })

  await assert.doesNotReject(() => store.complete(record))
  assert.match(record.persistenceError, /EEXIST|not a directory/i)
  assert.ok(events.includes('capture-persistence-error'))
})

test('capture store evicts old completed records to honor the memory budget', async () => {
  const events = []
  const store = new CaptureStore({
    maxRecords: 100,
    maxMemoryBytes: 256,
    eventHub: {
      publish(type, payload) {
        events.push({ type, payload })
      },
    },
  })
  const first = store.create({
    method: 'POST',
    path: '/first',
    body: 'x'.repeat(1000),
    byteLength: 1000,
  })
  await store.complete(first)
  const second = store.create({
    method: 'POST',
    path: '/second',
    body: 'y'.repeat(1000),
    byteLength: 1000,
  })
  await store.complete(second)

  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].id, second.id)
  assert.ok(
    events.some(
      event => event.type === 'capture-evicted' && event.payload.id === first.id,
    ),
  )
})

test('concurrent completions serialize NDJSON writes without interleaving', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wirelens-ndjson-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = new CaptureStore({
    maxRecords: 20,
    maxMemoryBytes: 64 * 1024 * 1024,
    captureDir: root,
    eventHub: { publish() {} },
  })
  const records = Array.from({ length: 12 }, (_, index) =>
    store.create({
      method: 'POST',
      path: `/request-${index}`,
      body: String(index).repeat(256 * 1024),
      byteLength: 256 * 1024,
    }),
  )

  await Promise.all(records.map(record => store.complete(record)))
  const files = await fs.readdir(root)
  assert.equal(files.length, 1)
  const lines = (await fs.readFile(path.join(root, files[0]), 'utf8'))
    .trim()
    .split('\n')
  const parsed = lines.map(line => JSON.parse(line))
  assert.equal(parsed.length, records.length)
  assert.deepEqual(
    new Set(parsed.map(record => record.id)),
    new Set(records.map(record => record.id)),
  )
})
