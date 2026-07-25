#!/usr/bin/env node

function readOption(argv, name, fallback) {
  const index = argv.indexOf(name)
  if (index === -1) return fallback
  return argv[index + 1] || fallback
}

const url = readOption(
  process.argv.slice(2),
  '--url',
  process.env.WIRELENS_HOOK_URL ||
    'http://127.0.0.1:8788/_wirelens/api/hook',
)
const timeoutMs = Number(
  readOption(process.argv.slice(2), '--timeout', '1500'),
)

try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    process.stderr.write(
      `wirelens-hook: collector returned HTTP ${response.status}\n`,
    )
  }
} catch (error) {
  // Observation must never block Claude Code. A missing dashboard is reported
  // to stderr while the hook still exits successfully.
  process.stderr.write(`wirelens-hook: ${error.message}\n`)
}
