export function parseSseBlock(block) {
  const result = { event: 'message', data: '', id: undefined, retry: undefined }
  const dataLines = []
  let sawField = false

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') {
      result.event = value
      sawField = true
    } else if (field === 'data') {
      dataLines.push(value)
      sawField = true
    } else if (field === 'id') {
      result.id = value
      sawField = true
    } else if (field === 'retry') {
      result.retry = Number(value)
      sawField = true
    }
  }

  if (!sawField) return undefined
  result.data = dataLines.join('\n')
  if (result.data) {
    try {
      result.json = JSON.parse(result.data)
      if (result.event === 'message' && result.json?.type) {
        result.event = result.json.type
      }
    } catch {
      // Non-JSON SSE data remains available verbatim.
    }
  }
  return result
}

export class SseParser {
  constructor(onEvent) {
    this.onEvent = onEvent
    this.decoder = new TextDecoder()
    this.buffer = ''
  }

  feed(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    this.#drain(false)
  }

  end() {
    this.buffer += this.decoder.decode()
    this.#drain(true)
  }

  #drain(final) {
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (!match) break
      const block = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      if (block.trim()) {
        const event = parseSseBlock(block)
        if (event) this.onEvent(event)
      }
    }
    if (final && this.buffer.trim()) {
      const event = parseSseBlock(this.buffer)
      if (event) this.onEvent(event)
      this.buffer = ''
    }
  }
}

export function summarizeAnthropicEvents(events) {
  const blocks = new Map()
  let message = {}
  let usage = {}
  let stopReason
  let error

  for (const entry of events) {
    const data = entry.json
    if (!data || typeof data !== 'object') continue
    if (data.type === 'message_start') {
      message = data.message || {}
      usage = { ...(data.message?.usage || {}) }
    } else if (data.type === 'content_block_start') {
      blocks.set(data.index, { ...(data.content_block || {}) })
    } else if (data.type === 'content_block_delta') {
      const block = blocks.get(data.index) || { type: 'unknown' }
      const delta = data.delta || {}
      if (typeof delta.text === 'string') {
        block.text = (block.text || '') + delta.text
      }
      if (typeof delta.thinking === 'string') {
        block.thinking = (block.thinking || '') + delta.thinking
      }
      if (typeof delta.partial_json === 'string') {
        block.input_json = (block.input_json || '') + delta.partial_json
      }
      if (typeof delta.signature === 'string') {
        block.signature = (block.signature || '') + delta.signature
      }
      blocks.set(data.index, block)
    } else if (data.type === 'message_delta') {
      stopReason = data.delta?.stop_reason ?? stopReason
      usage = { ...usage, ...(data.usage || {}) }
    } else if (data.type === 'error') {
      error = data.error || data
    }
  }

  return {
    id: message.id,
    model: message.model,
    role: message.role,
    content: [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => {
        if (typeof value.input_json === 'string') {
          try {
            return { ...value, input: JSON.parse(value.input_json) }
          } catch {
            return value
          }
        }
        return value
      }),
    stopReason,
    usage,
    error,
  }
}
