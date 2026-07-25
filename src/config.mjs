import path from 'node:path'
import os from 'node:os'
import { isIP } from 'node:net'
import { sanitizeUrl } from './redaction.mjs'

export const HELP = `
Agent WireLens — inspect Claude Code's Anthropic Messages traffic and agent state

Usage:
  node ./bin/wirelens.mjs --upstream <url> [options]

Options:
  --upstream <url>             Anthropic-compatible upstream base URL (required)
  --host <host>                Listen host (default: 127.0.0.1)
  --port <port>                Listen port (default: 8788)
  --claude-config-dir <path>   Claude config root (default: CLAUDE_CONFIG_DIR or ~/.claude)
  --capture-dir <path>         Persist redacted completed captures as NDJSON
  --max-capture-bytes <bytes>  Per request/response capture limit (default: 16777216)
  --max-records <count>        In-memory capture count (default: 200)
  --max-memory-bytes <bytes>   Approximate global capture budget (default: 268435456)
  --unsafe-show-secrets        Display and persist authentication headers
  --allow-remote               Allow a non-loopback listen host (unsafe without a firewall)
  --allow-insecure-upstream    Allow cleartext HTTP to a non-loopback upstream
  --help                       Show this help

Environment equivalents:
  WIRELENS_UPSTREAM, WIRELENS_HOST, WIRELENS_PORT, WIRELENS_CAPTURE_DIR
`.trim()

function takeValue(argv, index, name) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const result = {
    host: env.WIRELENS_HOST || '127.0.0.1',
    port: parsePositiveInteger(env.WIRELENS_PORT || '8788', 'port'),
    upstream: env.WIRELENS_UPSTREAM,
    claudeConfigDir:
      env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    captureDir: env.WIRELENS_CAPTURE_DIR,
    maxCaptureBytes: 16 * 1024 * 1024,
    maxRecords: 200,
    maxMemoryBytes: 256 * 1024 * 1024,
    unsafeShowSecrets: false,
    allowRemote: false,
    allowInsecureUpstream: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--help':
      case '-h':
        result.help = true
        break
      case '--upstream':
        result.upstream = takeValue(argv, index, arg)
        index += 1
        break
      case '--host':
        result.host = takeValue(argv, index, arg)
        index += 1
        break
      case '--port':
        result.port = parsePositiveInteger(takeValue(argv, index, arg), arg)
        index += 1
        break
      case '--claude-config-dir':
        result.claudeConfigDir = path.resolve(takeValue(argv, index, arg))
        index += 1
        break
      case '--capture-dir':
        result.captureDir = path.resolve(takeValue(argv, index, arg))
        index += 1
        break
      case '--max-capture-bytes':
        result.maxCaptureBytes = parsePositiveInteger(
          takeValue(argv, index, arg),
          arg,
        )
        index += 1
        break
      case '--max-records':
        result.maxRecords = parsePositiveInteger(
          takeValue(argv, index, arg),
          arg,
        )
        index += 1
        break
      case '--max-memory-bytes':
        result.maxMemoryBytes = parsePositiveInteger(
          takeValue(argv, index, arg),
          arg,
        )
        index += 1
        break
      case '--unsafe-show-secrets':
        result.unsafeShowSecrets = true
        break
      case '--allow-remote':
        result.allowRemote = true
        break
      case '--allow-insecure-upstream':
        result.allowInsecureUpstream = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (!result.help) {
    if (!result.upstream) {
      throw new Error('--upstream (or WIRELENS_UPSTREAM) is required')
    }
    const upstream = new URL(result.upstream)
    if (!['http:', 'https:'].includes(upstream.protocol)) {
      throw new Error('--upstream must use http:// or https://')
    }
    if (upstream.username || upstream.password) {
      throw new Error(
        '--upstream must not contain URL credentials; use Claude Code authentication environment variables',
      )
    }
    if (
      listenerCoversUpstream(result.host, upstream.hostname) &&
      Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)) ===
        result.port
    ) {
      throw new Error('The upstream points back to WireLens itself')
    }
    if (!result.allowRemote && !isLoopbackHost(result.host)) {
      throw new Error(
        'A non-loopback --host requires the explicit --allow-remote flag',
      )
    }
    if (
      upstream.protocol === 'http:' &&
      !isLoopbackHost(upstream.hostname) &&
      !result.allowInsecureUpstream
    ) {
      throw new Error(
        'Cleartext HTTP to a non-loopback upstream requires --allow-insecure-upstream',
      )
    }
    result.upstream = upstream
  }

  return result
}

export function publicConfig(config) {
  return {
    host: config.host,
    port: config.port,
    upstream: config.upstream ? sanitizeUrl(config.upstream) : undefined,
    claudeConfigDir: config.claudeConfigDir,
    captureDir: config.captureDir,
    maxCaptureBytes: config.maxCaptureBytes,
    maxRecords: config.maxRecords,
    maxMemoryBytes: config.maxMemoryBytes,
    unsafeShowSecrets: config.unsafeShowSecrets,
    allowRemote: config.allowRemote,
    allowInsecureUpstream: config.allowInsecureUpstream,
  }
}

function normalizeHost(host) {
  return String(host).trim().toLowerCase().replace(/^\[|\]$/gu, '')
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host)
  if (normalized === 'localhost' || normalized === 'localhost.') return true
  const version = isIP(normalized)
  if (version === 4) return Number(normalized.split('.')[0]) === 127
  if (version === 6) {
    return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1'
  }
  return false
}

function listenerCoversUpstream(listenerHost, upstreamHost) {
  const listener = normalizeHost(listenerHost)
  const upstream = normalizeHost(upstreamHost)
  if (listener === upstream) return true
  if (isLoopbackHost(listener) && isLoopbackHost(upstream)) return true
  return (
    (listener === '0.0.0.0' || listener === '::') &&
    isLoopbackHost(upstream)
  )
}
