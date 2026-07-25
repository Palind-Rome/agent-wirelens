const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-goog-api-key',
  'x-amz-security-token',
  'x-azure-api-key',
  'ocp-apim-subscription-key',
  'api-key',
  'cookie',
  'set-cookie',
])

function redactValue(name, value, unsafeShowSecrets) {
  if (unsafeShowSecrets || !SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(() => '[REDACTED]')
  }
  return '[REDACTED]'
}

export function sanitizeHeaders(headers, unsafeShowSecrets = false) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      redactValue(name, value, unsafeShowSecrets),
    ]),
  )
}

export function sanitizeRawHeaders(rawHeaders, unsafeShowSecrets = false) {
  const sanitized = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    sanitized.push(
      name,
      redactValue(name, value, unsafeShowSecrets),
    )
  }
  return sanitized
}

export function forwardingHeaders(headers) {
  const result = {}
  const connectionTokens = new Set(
    String(headers.connection || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  )
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (
      value !== undefined &&
      ![
        'host',
        'connection',
        'proxy-connection',
        'proxy-authenticate',
        'proxy-authorization',
        'keep-alive',
        'transfer-encoding',
        'upgrade',
        'te',
        'trailer',
      ].includes(normalized) &&
      !connectionTokens.has(normalized)
    ) {
      result[name] = value
    }
  }
  return result
}

export function responseHeaders(headers) {
  const result = {}
  const connectionTokens = new Set(
    String(headers.connection || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  )
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (
      value !== undefined &&
      ![
        'connection',
        'proxy-connection',
        'proxy-authenticate',
        'proxy-authorization',
        'keep-alive',
        'transfer-encoding',
        'upgrade',
        'te',
        'trailer',
      ].includes(normalized) &&
      !connectionTokens.has(normalized)
    ) {
      result[name] = value
    }
  }
  return result
}

export function sanitizeUrl(value) {
  const url = new URL(value.toString())
  if (url.username) url.username = '[REDACTED]'
  if (url.password) url.password = '[REDACTED]'
  for (const name of [...url.searchParams.keys()]) {
    if (/(?:^|[-_])(key|token|secret|password|signature|credential|auth)(?:$|[-_])/iu.test(name)) {
      url.searchParams.set(name, '[REDACTED]')
    }
  }
  return url.toString()
}
