import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../src/config.mjs'

test('parseConfig requires an upstream and parses explicit options', () => {
  assert.throws(() => parseConfig([], {}), /upstream/)
  const config = parseConfig(
    [
      '--upstream',
      'https://example.test/anthropic',
      '--port',
      '9000',
      '--max-records',
      '12',
      '--unsafe-show-secrets',
    ],
    {},
  )
  assert.equal(config.upstream.toString(), 'https://example.test/anthropic')
  assert.equal(config.port, 9000)
  assert.equal(config.maxRecords, 12)
  assert.equal(config.unsafeShowSecrets, true)
})

test('parseConfig rejects an accidental proxy loop', () => {
  assert.throws(
    () =>
      parseConfig(
        ['--upstream', 'http://127.0.0.1:8788', '--port', '8788'],
        {},
      ),
    /points back/,
  )
  assert.throws(
    () =>
      parseConfig(
        [
          '--host',
          '::1',
          '--port',
          '8788',
          '--upstream',
          'http://[::1]:8788',
        ],
        {},
      ),
    /points back/,
  )
  assert.throws(
    () =>
      parseConfig(
        [
          '--host',
          '0.0.0.0',
          '--allow-remote',
          '--port',
          '8788',
          '--upstream',
          'http://127.0.0.1:8788',
        ],
        {},
      ),
    /points back/,
  )
})

test('parseConfig requires explicit consent for remote listening', () => {
  assert.throws(
    () =>
      parseConfig(
        [
          '--upstream',
          'https://example.test',
          '--host',
          '0.0.0.0',
        ],
        {},
      ),
    /allow-remote/,
  )
  assert.equal(
    parseConfig(
      [
        '--upstream',
        'https://example.test',
        '--host',
        '0.0.0.0',
        '--allow-remote',
      ],
      {},
    ).allowRemote,
    true,
  )
})

test('parseConfig rejects cleartext remote upstreams by default', () => {
  assert.throws(
    () => parseConfig(['--upstream', 'http://api.example.test'], {}),
    /allow-insecure-upstream/,
  )
  assert.equal(
    parseConfig(
      [
        '--upstream',
        'http://api.example.test',
        '--allow-insecure-upstream',
      ],
      {},
    ).allowInsecureUpstream,
    true,
  )
  assert.throws(
    () => parseConfig(['--upstream', 'http://127.attacker.example'], {}),
    /allow-insecure-upstream/,
  )
})

test('parseConfig rejects URL-embedded upstream credentials', () => {
  assert.throws(
    () =>
      parseConfig(
        ['--upstream', 'https://user:secret@api.example.test/base'],
        {},
      ),
    /must not contain URL credentials/,
  )
})
