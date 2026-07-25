#!/usr/bin/env node

import { HELP, parseConfig } from '../src/config.mjs'
import { createWireLensServer } from '../src/server.mjs'
import { sanitizeUrl } from '../src/redaction.mjs'

let config
try {
  config = parseConfig()
} catch (error) {
  console.error(`Agent WireLens: ${error.message}\n\n${HELP}`)
  process.exitCode = 1
}

if (config?.help) {
  console.log(HELP)
} else if (config) {
  const wirelens = createWireLensServer(config)
  try {
    await wirelens.listen()
  } catch (error) {
    console.error(`Agent WireLens failed to listen: ${error.message}`)
    process.exitCode = 1
  }

  if (!process.exitCode) {
    const displayHost = config.host.includes(':')
      ? `[${config.host}]`
      : config.host
    const localBase = `http://${displayHost}:${config.port}`
    console.log('Agent WireLens is ready.')
    console.log(`Dashboard: ${localBase}/_wirelens/`)
    console.log(`Claude base URL: ${localBase}`)
    console.log(`Upstream: ${sanitizeUrl(config.upstream)}`)
    console.log(`Claude state root: ${config.claudeConfigDir}`)
    console.log(
      config.unsafeShowSecrets
        ? 'WARNING: authentication headers are visible and may be persisted.'
        : 'Authentication headers are redacted in captures.',
    )
    if (config.allowRemote) {
      console.log(
        'WARNING: remote access is enabled; captured prompts may contain source code and secrets.',
      )
    }
    if (config.allowInsecureUpstream) {
      console.log(
        'WARNING: the remote upstream uses cleartext HTTP; prompts and credentials are not encrypted in transit.',
      )
    }

    let closing = false
    const shutdown = async signal => {
      if (closing) return
      closing = true
      console.log(`\n${signal}: closing Agent WireLens...`)
      try {
        await wirelens.close()
      } catch (error) {
        console.error(error)
        process.exitCode = 1
      }
    }
    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
  }
}
