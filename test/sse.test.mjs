import test from 'node:test'
import assert from 'node:assert/strict'
import { SseParser, summarizeAnthropicEvents } from '../src/sse.mjs'

test('SseParser handles arbitrary chunk boundaries and reconstructs output', () => {
  const events = []
  const parser = new SseParser(event => events.push(event))
  const wire = [
    ': keep-alive\r\n\r\n',
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"m1","model":"demo","usage":{"input_tokens":7}}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  ].join('')
  const buffer = Buffer.from(wire)
  parser.feed(buffer.subarray(0, 13))
  parser.feed(buffer.subarray(13, 111))
  parser.feed(buffer.subarray(111))
  parser.end()

  assert.equal(events.length, 4)
  assert.equal(events[2].event, 'content_block_delta')
  assert.deepEqual(summarizeAnthropicEvents(events), {
    id: 'm1',
    model: 'demo',
    role: undefined,
    content: [{ type: 'text', text: 'hello' }],
    stopReason: 'end_turn',
    usage: { input_tokens: 7, output_tokens: 2 },
    error: undefined,
  })
})
