import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createWireLensServer } from '../src/server.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

test('dashboard favicon is served locally and never captured or proxied', async t => {
  let upstreamRequests = 0
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1
    response.writeHead(500)
    response.end()
  })
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolve => upstream.close(resolve)))

  const wirelens = createWireLensServer({
    host: '127.0.0.1',
    port: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    claudeConfigDir: path.join(os.tmpdir(), 'wirelens-nonexistent'),
    captureDir: undefined,
    maxCaptureBytes: 1024,
    maxRecords: 2,
    unsafeShowSecrets: false,
    allowRemote: false,
  })
  await wirelens.listen()
  t.after(() => wirelens.close())
  const port = wirelens.server.address().port

  const favicon = await fetch(`http://127.0.0.1:${port}/favicon.ico`)
  assert.equal(favicon.status, 200)
  assert.equal(favicon.headers.get('content-type'), 'image/svg+xml')
  assert.match(await favicon.text(), /<svg/u)
  assert.equal(upstreamRequests, 0)
  assert.equal(wirelens.store.list().length, 0)
})

test('proxy preserves the Messages payload and stream while storing a redacted view', async t => {
  let observed
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    observed = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'x-upstream-test': 'yes',
    })
    response.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","model":"deepseek-test","role":"assistant","usage":{"input_tokens":11}}}\n\n',
    )
    await new Promise(resolve => setTimeout(resolve, 15))
    response.write(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    )
    response.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"observed"}}\n\n',
    )
    response.end(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    )
  })
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolve => upstream.close(resolve)))

  const config = {
    host: '127.0.0.1',
    port: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}/anthropic`),
    claudeConfigDir: path.join(os.tmpdir(), 'wirelens-nonexistent'),
    captureDir: undefined,
    maxCaptureBytes: 1024 * 1024,
    maxRecords: 20,
    unsafeShowSecrets: false,
  }
  const wirelens = createWireLensServer(config)
  await wirelens.listen()
  t.after(() => wirelens.close())
  const port = wirelens.server.address().port
  const payload = {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'show me' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    stream: true,
  }

  const response = await fetch(
    `http://127.0.0.1:${port}/v1/messages?beta=true`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'top-secret',
      },
      body: JSON.stringify(payload),
    },
  )
  const responseText = await response.text()
  assert.match(responseText, /observed/)
  assert.equal(response.headers.get('x-upstream-test'), 'yes')
  assert.equal(observed.url, '/anthropic/v1/messages?beta=true')
  assert.equal(observed.headers['x-api-key'], 'top-secret')
  assert.deepEqual(JSON.parse(observed.body), payload)

  await new Promise(resolve => setImmediate(resolve))
  const captures = await (
    await fetch(`http://127.0.0.1:${port}/_wirelens/api/captures`)
  ).json()
  assert.equal(captures.length, 1)
  const detail = await (
    await fetch(
      `http://127.0.0.1:${port}/_wirelens/api/captures/${captures[0].id}`,
    )
  ).json()
  assert.equal(detail.request.headers['x-api-key'], '[REDACTED]')
  assert.deepEqual(detail.request.json, payload)
  assert.equal(detail.response.summary.content[0].text, 'observed')
  assert.equal(detail.response.summary.usage.output_tokens, 3)
  assert.ok(detail.metrics.firstEventMs < detail.metrics.ttftMs)

  const hookPayload = {
    session_id: 'session-1',
    transcript_path: 'transcript.jsonl',
    cwd: 'workspace',
    hook_event_name: 'SubagentStart',
    agent_id: 'a1234567890abcdef',
    agent_type: 'Explore',
  }
  const hookResponse = await fetch(
    `http://127.0.0.1:${port}/_wirelens/api/hook`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hookPayload),
    },
  )
  assert.equal(hookResponse.status, 202)
  const state = await (
    await fetch(`http://127.0.0.1:${port}/_wirelens/api/state`)
  ).json()
  assert.equal(state.hooks.subagents[0].state, 'running')
})

test('proxy retains partial bytes when the upstream aborts mid-stream', async t => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain request before producing the intentionally broken response.
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"partial"}}\n\n',
    )
    setTimeout(() => response.socket.destroy(), 10)
  })
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolve => upstream.close(resolve)))

  const wirelens = createWireLensServer({
    host: '127.0.0.1',
    port: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    claudeConfigDir: path.join(os.tmpdir(), 'wirelens-nonexistent'),
    captureDir: undefined,
    maxCaptureBytes: 1024 * 1024,
    maxRecords: 20,
    unsafeShowSecrets: false,
  })
  await wirelens.listen()
  t.after(() => wirelens.close())
  const port = wirelens.server.address().port

  await assert.rejects(() =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      body: '{}',
    }).then(response => response.text()),
  )

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (wirelens.store.list()[0]?.state !== 'in_flight') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const preview = wirelens.store.list()[0]
  const detail = wirelens.store.get(preview.id)
  assert.equal(detail.state, 'failed')
  assert.equal(detail.response.partial, true)
  assert.ok(detail.response.byteLength > 0)
  assert.match(detail.response.body, /message_start/)
  assert.ok(detail._rawResponse.length > 0)
})

test('capture does not complete before a slow client finishes its request body', async t => {
  const upstream = http.createServer((request, response) => {
    request.once('data', () => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"early"}')
    })
  })
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolve => upstream.close(resolve)))

  const wirelens = createWireLensServer({
    host: '127.0.0.1',
    port: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    claudeConfigDir: path.join(os.tmpdir(), 'wirelens-nonexistent'),
    captureDir: undefined,
    maxCaptureBytes: 1024 * 1024,
    maxRecords: 20,
    unsafeShowSecrets: false,
  })
  await wirelens.listen()
  t.after(() => wirelens.close())
  const port = wirelens.server.address().port

  let responseFinished
  const responseDone = new Promise(resolve => {
    responseFinished = resolve
  })
  const clientRequest = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    },
    response => {
      response.resume()
      response.on('end', responseFinished)
    },
  )
  clientRequest.write('{"first":')
  await responseDone

  assert.equal(wirelens.store.list()[0].state, 'in_flight')
  assert.equal(wirelens.store.get(wirelens.store.list()[0].id)._rawRequest, undefined)

  clientRequest.end('"second"}')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (wirelens.store.list()[0]?.state !== 'in_flight') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const detail = wirelens.store.get(wirelens.store.list()[0].id)
  assert.equal(detail.state, 'completed')
  assert.equal(detail.request.body, '{"first":"second"}')
  assert.equal(detail._rawRequest.toString('utf8'), '{"first":"second"}')
})

test('local mode rejects non-loopback Host headers to prevent DNS rebinding', async t => {
  const upstream = http.createServer((_request, response) => response.end())
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const wirelens = createWireLensServer({
    host: '127.0.0.1',
    port: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    claudeConfigDir: path.join(os.tmpdir(), 'wirelens-nonexistent'),
    captureDir: undefined,
    maxCaptureBytes: 1024,
    maxRecords: 2,
    unsafeShowSecrets: false,
    allowRemote: false,
  })
  await wirelens.listen()
  t.after(() => wirelens.close())
  const port = wirelens.server.address().port

  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/_wirelens/api/captures',
        headers: { host: 'attacker.example' },
      },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    request.end()
  })

  assert.equal(result.status, 421)
  assert.match(result.body, /untrusted_host/)
  assert.equal(wirelens.store.list().length, 0)
})

test('compressed semantic decoding is bounded while raw forwarding remains intact', async t => {
  const plainText = JSON.stringify('x'.repeat(10_000))
  const { gzipSync } = await import('node:zlib')
  const compressed = gzipSync(plainText)
  assert.ok(compressed.length < 512)
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': compressed.length,
    })
    response.end(compressed)
  })
  const upstreamPort = await listen(upstream)
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  const wirelens = createWireLensServer({
    host: '127.0.0.1',
    port: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    claudeConfigDir: path.join(os.tmpdir(), 'wirelens-nonexistent'),
    captureDir: undefined,
    maxCaptureBytes: 512,
    maxRecords: 2,
    unsafeShowSecrets: false,
    allowRemote: false,
  })
  await wirelens.listen()
  t.after(() => wirelens.close())
  const port = wirelens.server.address().port

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(await response.text(), plainText)
  await new Promise(resolve => setImmediate(resolve))
  const detail = wirelens.store.get(wirelens.store.list()[0].id)
  assert.equal(detail.response.byteLength, compressed.length)
  assert.match(detail.response.decodeError, /larger|maxOutputLength|buffer/i)
  assert.deepEqual(detail._rawResponse, compressed)
})
