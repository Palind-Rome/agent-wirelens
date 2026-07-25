import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function previewRecord(record) {
  return {
    id: record.id,
    sequence: record.sequence,
    state: record.state,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    method: record.request.method,
    path: record.request.path,
    upstreamUrl: record.request.upstreamUrl,
    model: record.request.json?.model,
    messageCount: record.request.json?.messages?.length,
    toolCount: record.request.json?.tools?.length,
    statusCode: record.response?.statusCode,
    durationMs: record.metrics.durationMs,
    ttfbMs: record.metrics.ttfbMs,
    ttftMs: record.metrics.ttftMs,
    firstEventMs: record.metrics.firstEventMs,
    requestBytes: record.request.byteLength,
    responseBytes: record.response?.byteLength,
    inputTokens:
      record.response?.summary?.usage?.input_tokens ??
      record.response?.summary?.usage?.inputTokens,
    outputTokens:
      record.response?.summary?.usage?.output_tokens ??
      record.response?.summary?.usage?.outputTokens,
    stopReason: record.response?.summary?.stopReason,
    error: record.error,
  }
}

function estimatedRecordBytes(record) {
  let serializedBytes = 0
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(record), 'utf8') * 2
  } catch {
    serializedBytes = 0
  }
  return (
    serializedBytes +
    (record._rawRequest?.byteLength || 0) +
    (record._rawResponse?.byteLength || 0)
  )
}

export class CaptureStore {
  constructor({ maxRecords, maxMemoryBytes, captureDir, eventHub }) {
    this.maxRecords = maxRecords
    this.maxMemoryBytes = maxMemoryBytes || 256 * 1024 * 1024
    this.captureDir = captureDir
    this.eventHub = eventHub
    this.records = new Map()
    this.order = []
    this.sequence = 0
    this.persistenceTail = Promise.resolve()
  }

  create(request) {
    this.sequence += 1
    const id = `${Date.now().toString(36)}-${this.sequence.toString(36)}-${crypto
      .randomBytes(3)
      .toString('hex')}`
    const record = {
      id,
      sequence: this.sequence,
      state: 'in_flight',
      startedAt: new Date().toISOString(),
      request,
      response: undefined,
      metrics: {},
      error: undefined,
    }
    this.records.set(id, record)
    this.order.unshift(id)
    this.#trim()
    this.eventHub.publish('capture-created', previewRecord(record))
    return record
  }

  update(record, eventType = 'capture-updated') {
    this.eventHub.publish(eventType, previewRecord(record))
  }

  async complete(record) {
    record.state = record.error ? 'failed' : 'completed'
    record.completedAt = new Date().toISOString()
    record.metrics.durationMs =
      Date.parse(record.completedAt) - Date.parse(record.startedAt)
    this.update(record, 'capture-completed')
    if (this.captureDir) {
      try {
        await this.#queuePersist(record)
      } catch (error) {
        record.persistenceError =
          error instanceof Error ? error.message : String(error)
        this.update(record, 'capture-persistence-error')
      }
    }
    Object.defineProperty(record, '_estimatedBytes', {
      value: estimatedRecordBytes(record),
      enumerable: false,
      configurable: true,
      writable: true,
    })
    this.#trim()
  }

  list() {
    return this.order
      .map(id => this.records.get(id))
      .filter(Boolean)
      .map(previewRecord)
  }

  get(id) {
    return this.records.get(id)
  }

  summary() {
    const records = [...this.records.values()]
    return {
      total: records.length,
      inFlight: records.filter(record => record.state === 'in_flight').length,
      failed: records.filter(record => record.state === 'failed').length,
      completed: records.filter(record => record.state === 'completed').length,
      requestBytes: records.reduce(
        (sum, record) => sum + (record.request.byteLength || 0),
        0,
      ),
      responseBytes: records.reduce(
        (sum, record) => sum + (record.response?.byteLength || 0),
        0,
      ),
      estimatedMemoryBytes: records.reduce(
        (sum, record) => sum + (record._estimatedBytes || estimatedRecordBytes(record)),
        0,
      ),
    }
  }

  #trim() {
    const memoryUsage = () =>
      this.order.reduce((sum, id) => {
        const record = this.records.get(id)
        return (
          sum +
          (record?._estimatedBytes ||
            (record ? estimatedRecordBytes(record) : 0))
        )
      }, 0)
    while (
      this.order.length > this.maxRecords ||
      (this.order.length > 1 && memoryUsage() > this.maxMemoryBytes)
    ) {
      const removableIndex = this.order.findLastIndex(id => {
        const record = this.records.get(id)
        return record && record.state !== 'in_flight'
      })
      if (removableIndex === -1) break
      const [id] = this.order.splice(removableIndex, 1)
      if (id) {
        this.records.delete(id)
        this.eventHub.publish('capture-evicted', { id })
      }
    }
  }

  async #persist(record) {
    await fs.mkdir(this.captureDir, { recursive: true })
    const day = record.startedAt.slice(0, 10)
    const outputPath = path.join(this.captureDir, `wirelens-${day}.ndjson`)
    await fs.appendFile(outputPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  #queuePersist(record) {
    const operation = this.persistenceTail.then(() => this.#persist(record))
    this.persistenceTail = operation.catch(() => undefined)
    return operation
  }
}
