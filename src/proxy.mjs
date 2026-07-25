import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import {
  forwardingHeaders,
  responseHeaders,
  sanitizeHeaders,
  sanitizeRawHeaders,
  sanitizeUrl,
} from './redaction.mjs'
import { SseParser, summarizeAnthropicEvents } from './sse.mjs'

const gunzip = promisify(zlib.gunzip)
const inflate = promisify(zlib.inflate)
const brotliDecompress = promisify(zlib.brotliDecompress)

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })
const MAX_SSE_EVENTS = 20_000
const SSE_PUBLISH_INTERVAL_MS = 50

class ByteCollector {
  constructor(limit) {
    this.limit = limit
    this.parts = []
    this.capturedBytes = 0
    this.totalBytes = 0
    this.hash = crypto.createHash('sha256')
  }

  add(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.totalBytes += buffer.length
    this.hash.update(buffer)
    const available = Math.max(0, this.limit - this.capturedBytes)
    if (available > 0) {
      const part = buffer.subarray(0, available)
      this.parts.push(part)
      this.capturedBytes += part.length
    }
  }

  finish() {
    return {
      buffer: Buffer.concat(this.parts),
      byteLength: this.totalBytes,
      capturedBytes: this.capturedBytes,
      truncated: this.totalBytes > this.capturedBytes,
      sha256: this.hash.digest('hex'),
    }
  }
}

export function buildTargetUrl(upstream, incomingUrl) {
  const incoming = new URL(incomingUrl || '/', 'http://wirelens.invalid')
  const target = new URL(upstream.toString())
  const basePath = target.pathname.replace(/\/+$/u, '')
  const baseSearch = target.search.slice(1)
  const requestPath = incoming.pathname.startsWith('/')
    ? incoming.pathname
    : `/${incoming.pathname}`
  target.pathname = `${basePath}${requestPath}` || '/'
  const incomingSearch = incoming.search.slice(1)
  target.search = [baseSearch, incomingSearch].filter(Boolean).join('&')
  return target
}

function requestBodyDetails(result) {
  const text = result.buffer.toString('utf8')
  let json
  if (!result.truncated && text.trim()) {
    try {
      json = JSON.parse(text)
    } catch {
      // A non-JSON body remains inspectable as text.
    }
  }
  return {
    text,
    json,
    byteLength: result.byteLength,
    capturedBytes: result.capturedBytes,
    truncated: result.truncated,
    sha256: result.sha256,
  }
}

async function decodeResponse(buffer, contentEncoding, maxOutputLength) {
  const encoding = String(contentEncoding || '').toLowerCase().trim()
  if (!encoding || encoding === 'identity') return buffer
  const options = { maxOutputLength }
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return gunzip(buffer, options)
  }
  if (encoding === 'deflate') return inflate(buffer, options)
  if (encoding === 'br') return brotliDecompress(buffer, options)
  throw new Error(`Unsupported content-encoding: ${encoding}`)
}

function parseCompleteSse(buffer, onEvent) {
  const parser = new SseParser(onEvent)
  parser.feed(buffer)
  parser.end()
}

function safeEnd(response, statusCode, body) {
  if (response.headersSent) {
    response.end()
    return
  }
  const text = JSON.stringify(body)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

export function createProxyHandler(config, store) {
  return function proxy(request, response) {
    const target = buildTargetUrl(config.upstream, request.url)
    const transport = target.protocol === 'https:' ? https : http
    const incomingHeaders = sanitizeHeaders(
      request.headers,
      config.unsafeShowSecrets,
    )
    const headersToForward = {
      ...forwardingHeaders(request.headers),
      host: target.host,
    }

    const record = store.create({
      method: request.method || 'GET',
      path: request.url || '/',
      incomingUrl: `http://${request.headers.host || `${config.host}:${config.port}`}${
        request.url || '/'
      }`,
      upstreamUrl: sanitizeUrl(target),
      headers: incomingHeaders,
      rawHeaders: sanitizeRawHeaders(
        request.rawHeaders,
        config.unsafeShowSecrets,
      ),
      forwardedHeaders: sanitizeHeaders(
        headersToForward,
        config.unsafeShowSecrets,
      ),
      body: '',
      json: undefined,
      byteLength: 0,
      capturedBytes: 0,
      truncated: false,
      sha256: undefined,
    })
    const requestCollector = new ByteCollector(config.maxCaptureBytes)
    let requestFinished = false
    let responseFinished = false
    let recordCompleted = false
    let upstreamResponded = false
    let upstreamResponseStream
    let settled = false

    const maybeCompleteRecord = async () => {
      if (
        recordCompleted ||
        !requestFinished ||
        !responseFinished
      ) {
        return
      }
      recordCompleted = true
      await store.complete(record)
    }

    const finalizeRequestCapture = (partial = false) => {
      if (requestFinished) return
      requestFinished = true
      const captured = requestCollector.finish()
      Object.defineProperty(record, '_rawRequest', {
        value: captured.buffer,
        enumerable: false,
      })
      const details = requestBodyDetails(captured)
      Object.assign(record.request, {
        body: details.text,
        json: details.json,
        byteLength: details.byteLength,
        capturedBytes: details.capturedBytes,
        truncated: details.truncated,
        sha256: details.sha256,
        partial,
      })
      store.update(record)
      void maybeCompleteRecord()
    }

    const upstreamRequest = transport.request(
      target,
      {
        method: request.method,
        headers: headersToForward,
        agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
      },
      upstreamResponse => {
        upstreamResponseStream = upstreamResponse
        upstreamResponded = true
        const now = Date.now()
        record.metrics.ttfbMs = now - Date.parse(record.startedAt)
        const responseCollector = new ByteCollector(config.maxCaptureBytes)
        const events = []
        const encoding = upstreamResponse.headers['content-encoding']
        const contentType = String(
          upstreamResponse.headers['content-type'] || '',
        ).toLowerCase()
        const canParseStreaming =
          contentType.includes('text/event-stream') &&
          (!encoding || encoding === 'identity')
        let semanticBytesFed = 0
        let lastSsePublishAt = 0

        record.response = {
          statusCode: upstreamResponse.statusCode,
          statusMessage: upstreamResponse.statusMessage,
          headers: sanitizeHeaders(
            upstreamResponse.headers,
            config.unsafeShowSecrets,
          ),
          rawHeaders: sanitizeRawHeaders(
            upstreamResponse.rawHeaders,
            config.unsafeShowSecrets,
          ),
          contentType,
          contentEncoding: encoding,
          body: '',
          byteLength: 0,
          capturedBytes: 0,
          truncated: false,
          sha256: undefined,
          events,
          summary: undefined,
        }
        store.update(record)

        response.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.statusMessage,
          responseHeaders(upstreamResponse.headers),
        )

        const parser = canParseStreaming
          ? new SseParser(event => {
              event.offsetMs = Date.now() - Date.parse(record.startedAt)
              if (events.length < MAX_SSE_EVENTS) {
                events.push(event)
              } else {
                record.response.eventsTruncated = true
              }
              if (record.metrics.ttftMs === undefined) {
                const delta = event.json?.delta
                if (
                  event.json?.type === 'content_block_delta' &&
                  [delta?.text, delta?.thinking, delta?.partial_json].some(
                    value => typeof value === 'string' && value.length > 0,
                  )
                ) {
                  record.metrics.ttftMs = event.offsetMs
                }
              }
              if (record.metrics.firstEventMs === undefined) {
                record.metrics.firstEventMs = event.offsetMs
              }
              const now = Date.now()
              if (now - lastSsePublishAt >= SSE_PUBLISH_INTERVAL_MS) {
                lastSsePublishAt = now
                store.update(record, 'sse-event')
              }
            })
          : undefined

        upstreamResponse.on('data', chunk => {
          responseCollector.add(chunk)
          if (parser && semanticBytesFed < config.maxCaptureBytes) {
            const allowed = Math.min(
              chunk.length,
              config.maxCaptureBytes - semanticBytesFed,
            )
            if (allowed > 0) {
              parser.feed(chunk.subarray(0, allowed))
              semanticBytesFed += allowed
            }
            if (allowed < chunk.length) {
              record.response.eventsTruncated = true
            }
          } else if (parser) {
            record.response.eventsTruncated = true
          }
          if (!response.write(chunk)) upstreamResponse.pause()
        })

        response.on('drain', () => upstreamResponse.resume())

        const finalizeResponse = async ({ partial = false } = {}) => {
          if (settled) return
          settled = true
          if (
            parser &&
            !partial &&
            !record.response.eventsTruncated
          ) {
            parser.end()
          }
          const captured = responseCollector.finish()
          Object.defineProperty(record, '_rawResponse', {
            value: captured.buffer,
            enumerable: false,
          })
          Object.assign(record.response, {
            body: captured.buffer.toString('utf8'),
            byteLength: captured.byteLength,
            capturedBytes: captured.capturedBytes,
            truncated: captured.truncated,
            sha256: captured.sha256,
            partial,
          })

          if (!partial && !captured.truncated && !canParseStreaming) {
            try {
              const decoded = await decodeResponse(
                captured.buffer,
                encoding,
                config.maxCaptureBytes,
              )
              if (contentType.includes('text/event-stream')) {
                record.response.body = decoded.toString('utf8')
                parseCompleteSse(decoded, event => {
                  if (events.length < MAX_SSE_EVENTS) events.push(event)
                  else record.response.eventsTruncated = true
                })
              } else if (
                contentType.includes('application/json') ||
                contentType.includes('+json')
              ) {
                record.response.body = decoded.toString('utf8')
                record.response.json = JSON.parse(record.response.body)
              }
            } catch (error) {
              record.response.decodeError =
                error instanceof Error ? error.message : String(error)
            }
          }

          record.response.summary = summarizeAnthropicEvents(events)
          responseFinished = true
          await maybeCompleteRecord()
        }

        upstreamResponse.on('end', async () => {
          const completion = finalizeResponse()
          response.end()
          await completion
        })

        upstreamResponse.on('aborted', async () => {
          if (settled) return
          record.error = 'Upstream response was aborted'
          const completion = finalizeResponse({ partial: true })
          response.destroy(new Error('Upstream response was aborted'))
          await completion
        })

        upstreamResponse.on('error', async error => {
          if (settled) return
          record.error = `Upstream response error: ${error.message}`
          const completion = finalizeResponse({ partial: true })
          response.destroy(error)
          await completion
        })
      },
    )

    // getHeaders() reflects the application headers that the upstream request
    // object will serialize. TLS/TCP framing is deliberately outside our scope.
    record.request.forwardedHeaders = sanitizeHeaders(
      upstreamRequest.getHeaders(),
      config.unsafeShowSecrets,
    )

    request.on('data', chunk => {
      requestCollector.add(chunk)
      if (!upstreamRequest.write(chunk)) request.pause()
    })

    upstreamRequest.on('drain', () => request.resume())

    request.on('end', () => {
      finalizeRequestCapture()
      upstreamRequest.end()
    })

    request.on('aborted', () => {
      finalizeRequestCapture(true)
      upstreamRequest.destroy(new Error('Client request aborted'))
    })

    request.on('error', () => {
      finalizeRequestCapture(true)
    })

    response.on('close', () => {
      if (!response.writableEnded && !settled) {
        upstreamResponseStream?.destroy(new Error('Downstream disconnected'))
        upstreamRequest.destroy(new Error('Downstream disconnected'))
      }
    })

    upstreamRequest.on('error', async error => {
      if (settled) return
      settled = true
      record.error = `Upstream connection failed: ${error.message}`
      if (!upstreamResponded) {
        safeEnd(response, 502, {
          error: 'wirelens_upstream_error',
          message: error.message,
          upstream: sanitizeUrl(target),
        })
      } else {
        response.end()
      }
      responseFinished = true
      await maybeCompleteRecord()
    })
  }
}

export function closeProxyAgents() {
  httpAgent.destroy()
  httpsAgent.destroy()
}
