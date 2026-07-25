export class EventHub {
  constructor() {
    this.clients = new Set()
    this.sequence = 0
  }

  attach(response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(`event: hello\ndata: ${JSON.stringify({ sequence: this.sequence })}\n\n`)
    this.clients.add(response)
    response.on('close', () => this.clients.delete(response))
  }

  publish(type, data) {
    this.sequence += 1
    const frame = `id: ${this.sequence}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.clients) {
      client.write(frame)
    }
  }

  close() {
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}
