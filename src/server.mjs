import fs from 'node:fs/promises'
import http from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CaptureStore } from './capture-store.mjs'
import { EventHub } from './event-hub.mjs'
import { HookTracker } from './hook-tracker.mjs'
import { createProxyHandler, closeProxyAgents } from './proxy.mjs'
import { publicConfig } from './config.mjs'
import { ClaudeStateScanner } from './state-scanner.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(moduleDir, '..', 'public')
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function isTrustedLoopbackHostHeader(hostHeader) {
  if (!hostHeader) return false
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, '')
    if (hostname === 'localhost' || hostname === 'localhost.') return true
    const version = isIP(hostname)
    if (version === 4) return Number(hostname.split('.')[0]) === 127
    if (version === 6) {
      return hostname === '::1' || hostname === '0:0:0:0:0:0:0:1'
    }
    return false
  } catch {
    return false
  }
}

async function readJsonBody(request, limit = 2 * 1024 * 1024) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > limit) {
      const error = new Error(`Request body exceeds ${limit} bytes`)
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text || '{}')
}

function captureForApi(record) {
  if (!record) return undefined
  return {
    id: record.id,
    sequence: record.sequence,
    state: record.state,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    request: record.request,
    response: record.response,
    metrics: record.metrics,
    error: record.error,
    persistenceError: record.persistenceError,
  }
}

async function serveStatic(pathname, response) {
  const relative =
    pathname === '/_wirelens/' || pathname === '/_wirelens'
      ? 'index.html'
      : pathname.slice('/_wirelens/'.length)
  const normalized = path.normalize(relative).replace(/^(\.\.(\\|\/|$))+/u, '')
  const filePath = path.join(publicDir, normalized)
  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { error: 'forbidden' })
    return
  }
  try {
    const stat = await fs.stat(filePath)
    const resolvedPath = stat.isDirectory()
      ? path.join(filePath, 'index.html')
      : filePath
    const body = await fs.readFile(resolvedPath)
    response.writeHead(200, {
      'content-type':
        contentTypes[path.extname(resolvedPath).toLowerCase()] ||
        'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
    })
    response.end(body)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(response, 404, { error: 'not_found' })
      return
    }
    throw error
  }
}

export function createWireLensServer(config) {
  const eventHub = new EventHub()
  const store = new CaptureStore({
    maxRecords: config.maxRecords,
    maxMemoryBytes: config.maxMemoryBytes,
    captureDir: config.captureDir,
    eventHub,
  })
  const hooks = new HookTracker(eventHub)
  const stateScanner = new ClaudeStateScanner(config.claudeConfigDir)
  const proxy = createProxyHandler(config, store)
  const startedAt = new Date().toISOString()

  const server = http.createServer(async (request, response) => {
    try {
      if (
        !config.allowRemote &&
        !isTrustedLoopbackHostHeader(request.headers.host)
      ) {
        sendJson(response, 421, {
          error: 'untrusted_host',
          message:
            'Agent WireLens only accepts loopback Host headers in local mode',
        })
        return
      }
      const url = new URL(
        request.url || '/',
        `http://${request.headers.host || 'localhost'}`,
      )
      const pathname = url.pathname

      if (pathname === '/') {
        response.writeHead(302, { location: '/_wirelens/' })
        response.end()
        return
      }

      // Browsers request this root path implicitly when a page has no cached
      // icon. It is dashboard traffic, not an upstream model request.
      if (pathname === '/favicon.ico' && request.method === 'GET') {
        response.writeHead(302, {
          location: '/_wirelens/favicon.svg',
          'cache-control': 'public, max-age=86400',
        })
        response.end()
        return
      }

      if (!pathname.startsWith('/_wirelens')) {
        proxy(request, response)
        return
      }

      if (pathname === '/_wirelens/api/events' && request.method === 'GET') {
        eventHub.attach(response)
        return
      }
      if (pathname === '/_wirelens/api/config' && request.method === 'GET') {
        sendJson(response, 200, publicConfig(config))
        return
      }
      if (pathname === '/_wirelens/api/summary' && request.method === 'GET') {
        sendJson(response, 200, {
          startedAt,
          uptimeMs: Date.now() - Date.parse(startedAt),
          ...store.summary(),
        })
        return
      }
      if (pathname === '/_wirelens/api/captures' && request.method === 'GET') {
        sendJson(response, 200, store.list())
        return
      }
      if (pathname.startsWith('/_wirelens/api/captures/')) {
        const suffix = pathname.slice('/_wirelens/api/captures/'.length)
        const [encodedId, rawKind] = suffix.split('/')
        const id = decodeURIComponent(encodedId)
        const record = store.get(id)
        if (!record) {
          sendJson(response, 404, { error: 'capture_not_found' })
          return
        }
        if (request.method === 'GET' && rawKind === 'request.raw') {
          const body = record._rawRequest
          if (!body) {
            sendJson(response, 409, { error: 'request_not_complete' })
            return
          }
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': body.length,
            'content-disposition': `attachment; filename="${id}-request.bin"`,
          })
          response.end(body)
          return
        }
        if (request.method === 'GET' && rawKind === 'response.raw') {
          const body = record._rawResponse
          if (!body) {
            sendJson(response, 409, { error: 'response_not_complete' })
            return
          }
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': body.length,
            'content-disposition': `attachment; filename="${id}-response.bin"`,
          })
          response.end(body)
          return
        }
        if (request.method === 'GET' && !rawKind) {
          sendJson(response, 200, captureForApi(record))
          return
        }
      }
      if (pathname === '/_wirelens/api/state' && request.method === 'GET') {
        const disk = await stateScanner.snapshot()
        sendJson(response, 200, { disk, hooks: hooks.snapshot() })
        return
      }
      if (pathname === '/_wirelens/api/hooks' && request.method === 'GET') {
        sendJson(response, 200, hooks.snapshot())
        return
      }
      if (pathname === '/_wirelens/api/hook' && request.method === 'POST') {
        const payload = await readJsonBody(request)
        const event = hooks.accept(payload)
        sendJson(response, 202, { accepted: true, sequence: event.sequence })
        return
      }
      if (pathname === '/_wirelens/api/health' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, startedAt })
        return
      }
      if (
        request.method === 'GET' &&
        !pathname.startsWith('/_wirelens/api/')
      ) {
        await serveStatic(pathname, response)
        return
      }

      sendJson(response, 404, { error: 'not_found' })
    } catch (error) {
      sendJson(response, error?.statusCode || 500, {
        error: 'wirelens_internal_error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  server.on('clientError', (error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    if (process.env.WIRELENS_DEBUG) console.error(error)
  })

  return {
    server,
    store,
    hooks,
    eventHub,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.off('error', reject)
          resolve(server.address())
        })
      })
    },
    close() {
      eventHub.close()
      closeProxyAgents()
      return new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
    },
  }
}
