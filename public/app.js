const API_ROOT = '/_wirelens/api'

const appState = {
  config: {},
  summary: {},
  captures: [],
  captureDetails: new Map(),
  selectedCaptureId: null,
  captureFilter: 'all',
  captureSearch: '',
  detailTab: 'request',
  hooks: { events: [], sessions: [], subagents: [], tasks: [] },
  diskState: { teams: [], taskLists: [] },
  selectedHookSequence: null,
  hookSearch: '',
  view: 'overview',
  eventSource: null,
  refreshTimer: null,
  loading: false,
}

const $ = id => document.getElementById(id)

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function append(parent, ...children) {
  for (const child of children.flat()) {
    if (child !== undefined && child !== null) parent.append(child)
  }
  return parent
}

function button(className, text, onClick) {
  const node = element('button', className, text)
  node.type = 'button'
  if (onClick) node.addEventListener('click', onClick)
  return node
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null)
}

function toNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(toNumber(value))
}

function formatBytes(value) {
  const bytes = toNumber(value)
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
    units.length - 1,
  )
  const display = bytes / 1024 ** unitIndex
  return `${display >= 10 || unitIndex === 0 ? display.toFixed(0) : display.toFixed(1)} ${units[unitIndex]}`
}

function formatDuration(value) {
  if (value === undefined || value === null || value === '') return '—'
  const ms = toNumber(value)
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
}

function parseDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatClock(value, includeDate = false) {
  const date = parseDate(value)
  if (!date) return '—'
  const options = includeDate
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }
  return new Intl.DateTimeFormat('zh-CN', options).format(date)
}

function relativeTime(value) {
  const date = parseDate(value)
  if (!date) return '未知时间'
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return formatClock(value, true)
}

function shortId(value, length = 13) {
  const text = String(value || '—')
  return text.length > length ? `${text.slice(0, length)}…` : text
}

function initials(value) {
  const parts = String(value || '?')
    .split(/[\s@/_-]+/u)
    .filter(Boolean)
  return (parts.slice(0, 2).map(part => part[0]).join('') || '?').toUpperCase()
}

function stateLabel(value) {
  const labels = {
    in_flight: '进行中',
    running: '运行中',
    active: '活跃',
    completed: '已完成',
    stopped: '已停止',
    ended: '已结束',
    observed: '已观测',
    failed: '失败',
    error: '错误',
    pending: '待处理',
    in_progress: '处理中',
    inactive: '非活跃',
    created: '已创建',
  }
  return labels[value] || value || '未知'
}

function stateBadge(state, overrideText) {
  return element('span', `state-badge ${String(state || 'unknown')}`, overrideText || stateLabel(state))
}

function statusDot(state) {
  return element('span', `status-dot ${String(state || 'unknown')}`)
}

function emptyInline(message) {
  return element('div', 'empty-inline', message)
}

function jsonString(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    return `[无法序列化：${error instanceof Error ? error.message : String(error)}]`
  }
}

function jsonCode(value, className = '') {
  const pre = element('pre', `json-code ${className}`.trim())
  const source = typeof value === 'string' ? value : jsonString(value)
  const tokenPattern =
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(?=\s*:)|("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/gu
  let cursor = 0
  let match
  while ((match = tokenPattern.exec(source)) !== null) {
    if (match.index > cursor) pre.append(document.createTextNode(source.slice(cursor, match.index)))
    const classNames = match[1]
      ? 'json-key'
      : match[2]
        ? 'json-string'
        : match[3]
          ? 'json-number'
          : match[4]
            ? 'json-boolean'
            : 'json-null'
    pre.append(element('span', classNames, match[0]))
    cursor = tokenPattern.lastIndex
  }
  if (cursor < source.length) pre.append(document.createTextNode(source.slice(cursor)))
  return pre
}

function keyValueTable(value) {
  const table = element('dl', 'kv-table')
  const entries = Object.entries(isObject(value) ? value : {})
  if (!entries.length) return emptyInline('没有可显示的字段')
  for (const [key, rawValue] of entries) {
    const keyNode = element('dt', 'kv-key', key)
    const display =
      typeof rawValue === 'string'
        ? rawValue
        : rawValue === undefined
          ? 'undefined'
          : jsonString(rawValue)
    const valueNode = element('dd', 'kv-value', display)
    append(table, keyNode, valueNode)
  }
  return table
}

function section(title, body, meta) {
  const wrapper = element('section', 'detail-section')
  const heading = element('div', 'detail-section-heading')
  append(heading, element('h3', '', title))
  if (meta !== undefined) append(heading, element('span', 'section-count', meta))
  append(wrapper, heading, body)
  return wrapper
}

function copyButton(getValue, label = '复制') {
  const node = button('copy-button', label, async () => {
    const value = String(getValue() || '')
    try {
      await navigator.clipboard.writeText(value)
      showToast('已复制到剪贴板')
    } catch {
      showToast('浏览器拒绝了剪贴板访问', 'error')
    }
  })
  node.setAttribute('aria-label', label)
  return node
}

function showToast(message, type = '') {
  const toast = element('div', `toast ${type}`.trim(), message)
  $('toast-region').append(toast)
  window.setTimeout(() => toast.remove(), 2600)
}

async function fetchJson(path) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      // The HTTP status is sufficient when the response body is unavailable.
    }
    throw new Error(`${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 180)}` : ''}`)
  }
  return response.json()
}

function unpack(value, key) {
  return isObject(value) && key in value ? value[key] : value
}

async function refreshAll({ quiet = false } = {}) {
  if (appState.loading) return
  appState.loading = true
  $('refresh-button').classList.add('is-spinning')
  const operations = [
    fetchJson('/config').then(value => {
      appState.config = unpack(value, 'config') || {}
    }),
    fetchJson('/summary').then(value => {
      appState.summary = unpack(value, 'summary') || {}
    }),
    fetchJson('/captures').then(value => {
      appState.captures = asArray(unpack(value, 'captures'))
    }),
    fetchJson('/state').then(value => {
      appState.diskState =
        value?.disk || unpack(value, 'state') || value || { teams: [], taskLists: [] }
    }),
    fetchJson('/hooks').then(value => {
      appState.hooks = unpack(value, 'hooks') || value || {
        events: [],
        sessions: [],
        subagents: [],
        tasks: [],
      }
    }),
  ]
  const results = await Promise.allSettled(operations)
  const failures = results.filter(result => result.status === 'rejected')
  appState.loading = false
  $('refresh-button').classList.remove('is-spinning')

  if (failures.length) {
    setLiveState('offline')
    if (!quiet) {
      const reason = failures[0].reason
      showToast(`刷新失败：${reason instanceof Error ? reason.message : String(reason)}`, 'error')
    }
  }

  const latestId = appState.captures[0]?.id
  if (latestId && !appState.captureDetails.has(latestId)) {
    try {
      const detail = await loadCapture(latestId, { select: false, quiet: true })
      if (detail) appState.captureDetails.set(latestId, detail)
    } catch {
      // List data remains useful even if the oldest detail has already been evicted.
    }
  }

  renderAll()
  $('last-updated').textContent = `同步于 ${formatClock(new Date())}`
}

async function loadCapture(id, { select = true, quiet = false } = {}) {
  if (!id) return null
  if (select) {
    appState.selectedCaptureId = id
    renderCaptureList()
    renderCaptureDetailLoading()
  }
  try {
    const response = await fetchJson(`/captures/${encodeURIComponent(id)}`)
    const capture = unpack(response, 'capture') || response
    appState.captureDetails.set(id, capture)
    if (select && appState.selectedCaptureId === id) renderCaptureDetail()
    return capture
  } catch (error) {
    if (select && appState.selectedCaptureId === id) renderCaptureDetailError(error)
    if (!quiet) showToast(`无法读取请求：${error.message}`, 'error')
    throw error
  }
}

function scheduleRefresh(kind, payload) {
  if (
    payload?.id &&
    payload.id === appState.selectedCaptureId &&
    ['capture-updated', 'capture-completed', 'sse-event'].includes(kind)
  ) {
    loadCapture(payload.id, { select: false, quiet: true })
      .then(() => renderCaptureDetail())
      .catch(() => {})
  }
  window.clearTimeout(appState.refreshTimer)
  appState.refreshTimer = window.setTimeout(() => refreshAll({ quiet: true }), 180)
}

function connectEvents() {
  appState.eventSource?.close()
  const source = new EventSource(`${API_ROOT}/events`)
  appState.eventSource = source
  source.addEventListener('open', () => setLiveState('online'))
  source.addEventListener('error', () => setLiveState('offline'))
  source.addEventListener('hello', () => setLiveState('online'))
  for (const type of [
    'capture-created',
    'capture-updated',
    'capture-completed',
    'sse-event',
    'hook-event',
  ]) {
    source.addEventListener(type, event => {
      let payload = {}
      try {
        payload = JSON.parse(event.data)
      } catch {
        // A refresh still reconciles state when an event payload is malformed.
      }
      scheduleRefresh(type, payload)
    })
  }
}

function setLiveState(state) {
  const wrapper = $('live-state')
  wrapper.classList.toggle('is-online', state === 'online')
  wrapper.classList.toggle('is-offline', state === 'offline')
  $('live-label').textContent =
    state === 'online' ? '实时连接' : state === 'offline' ? '正在重连' : '连接中'
}

function selectView(view) {
  if (!['overview', 'traffic', 'agents', 'teams', 'hooks'].includes(view)) return
  appState.view = view
  document.querySelectorAll('.nav-item').forEach(node => {
    node.classList.toggle('is-active', node.dataset.view === view)
  })
  document.querySelectorAll('[data-view-panel]').forEach(node => {
    node.classList.toggle('is-active', node.dataset.viewPanel === view)
  })
  history.replaceState(null, '', `#${view}`)
  $('main-content').scrollTop = 0
}

function renderAll() {
  renderChrome()
  renderSummary()
  renderOverview()
  renderCaptureList()
  renderCaptureDetail()
  renderAgentRuntime()
  renderTeams()
  renderHooks()
}

function renderChrome() {
  const config = appState.config || {}
  $('upstream-value').textContent = config.upstream || '未配置上游'
  $('upstream-value').title = config.upstream || ''
  $('listen-value').textContent = `${config.host || '127.0.0.1'}:${config.port || '—'}`
  $('config-dir-value').textContent = config.claudeConfigDir || '—'
  $('config-dir-value').title = config.claudeConfigDir || ''
  const privacy = $('privacy-note')
  privacy.classList.toggle('is-unsafe', Boolean(config.unsafeShowSecrets))
  privacy.querySelector('span').textContent = config.unsafeShowSecrets
    ? '警告：认证信息未脱敏'
    : '认证信息默认脱敏'

  const hooks = appState.hooks || {}
  const liveAgents = asArray(hooks.subagents).filter(item => item.state === 'running').length
  $('traffic-nav-count').textContent = String(appState.captures.length)
  $('agents-nav-count').textContent = String(liveAgents)
  $('teams-nav-count').textContent = String(asArray(appState.diskState?.teams).length)
  $('hooks-nav-count').textContent = String(asArray(hooks.events).length)
}

function renderSummary() {
  const summary = appState.summary || {}
  const captures = appState.captures
  const total = firstDefined(summary.total, captures.length, 0)
  const inFlight = firstDefined(
    summary.inFlight,
    captures.filter(item => item.state === 'in_flight').length,
    0,
  )
  const failed = firstDefined(
    summary.failed,
    captures.filter(item => item.state === 'failed').length,
    0,
  )
  const inputTokens = captures.reduce((sum, item) => sum + toNumber(item.inputTokens), 0)
  const outputTokens = captures.reduce((sum, item) => sum + toNumber(item.outputTokens), 0)
  const totalDuration = captures.reduce((sum, item) => sum + toNumber(item.durationMs), 0)
  const completedDurations = captures.filter(item => toNumber(item.durationMs) > 0)
  const averageDuration = completedDurations.length ? totalDuration / completedDurations.length : 0
  const metrics = [
    {
      label: '已观测请求',
      value: formatNumber(total),
      foot: `${formatNumber(firstDefined(summary.completed, total - inFlight - failed, 0))} 条已完成`,
      color: 'var(--cyan)',
    },
    {
      label: '正在流式传输',
      value: formatNumber(inFlight),
      foot: inFlight ? 'SSE 连接活跃' : '当前无在途请求',
      color: 'var(--violet)',
    },
    {
      label: '请求 / 响应体积',
      value: formatBytes(toNumber(summary.requestBytes) + toNumber(summary.responseBytes)),
      foot: `${formatBytes(summary.requestBytes)} ↑  ${formatBytes(summary.responseBytes)} ↓`,
      color: 'var(--blue)',
    },
    {
      label: '累计 Token',
      value: formatNumber(inputTokens + outputTokens),
      foot: `${formatNumber(inputTokens)} 输入 · ${formatNumber(outputTokens)} 输出`,
      color: 'var(--green)',
    },
    {
      label: '平均耗时',
      value: averageDuration ? formatDuration(averageDuration) : '—',
      foot: failed ? `${formatNumber(failed)} 条失败` : '无失败请求',
      color: failed ? 'var(--red)' : 'var(--amber)',
    },
  ]

  const grid = $('summary-metrics')
  grid.replaceChildren()
  for (const metric of metrics) {
    const card = element('article', 'metric-card')
    card.style.setProperty('--metric-color', metric.color)
    append(
      card,
      element('div', 'metric-label', metric.label),
      element('div', 'metric-value', metric.value),
      append(
        element('div', 'metric-foot'),
        element('span', 'metric-accent'),
        element('span', '', metric.foot),
      ),
    )
    grid.append(card)
  }
  $('overview-status-label').textContent = inFlight
    ? `${inFlight} 条请求正在接收模型输出`
    : total
      ? `已捕获 ${total} 条应用层请求`
      : '等待第一条请求'
}

function renderOverview() {
  renderOverviewCaptures()
  renderOverviewAgents()
  renderRequestComposition()
  renderOverviewTeams()
}

function renderOverviewCaptures() {
  const wrapper = $('overview-captures')
  wrapper.replaceChildren()
  if (!appState.captures.length) {
    wrapper.append(emptyInline('尚未捕获请求。启动 Claude Code 后，Messages 流量会实时出现。'))
    return
  }
  for (const capture of appState.captures.slice(0, 6)) {
    const row = button('compact-capture', null, () => {
      selectView('traffic')
      loadCapture(capture.id)
    })
    const main = element('span', 'compact-main')
    append(
      main,
      element('span', 'compact-title', capture.model || capture.path || capture.id),
      element(
        'span',
        'compact-subtitle',
        `${capture.method || 'POST'} · ${formatClock(capture.startedAt)} · ${capture.messageCount ?? '—'} messages`,
      ),
    )
    const code = element(
      'span',
      `http-code ${toNumber(capture.statusCode) >= 400 ? 'is-error' : ''}`.trim(),
      capture.statusCode || (capture.state === 'in_flight' ? 'SSE' : '—'),
    )
    append(row, statusDot(capture.state), main, element('span', 'compact-metric', formatDuration(capture.durationMs)), code)
    wrapper.append(row)
  }
}

function renderOverviewAgents() {
  const wrapper = $('overview-agents')
  wrapper.replaceChildren()
  const sessions = asArray(appState.hooks?.sessions)
  const subagents = asArray(appState.hooks?.subagents)
  const activeEntities = [
    ...sessions.map(item => ({
      id: item.sessionId,
      kind: 'session',
      state: item.state,
      detail: item.model || item.lastEvent || 'Claude Code session',
      time: item.lastSeenAt,
    })),
    ...subagents.map(item => ({
      id: item.agentId,
      kind: item.agentType || 'subagent',
      state: item.state,
      detail: `所属 ${shortId(item.sessionId)}`,
      time: item.stoppedAt || item.startedAt,
    })),
  ].slice(0, 5)
  if (!activeEntities.length) {
    wrapper.append(emptyInline('尚未收到 SessionStart 或 SubagentStart Hook。'))
    return
  }
  for (const entity of activeEntities) {
    const row = element('div', 'activity-row')
    const info = element('div')
    append(
      info,
      element('div', 'activity-name', entity.id),
      element('div', 'activity-detail', `${entity.kind} · ${entity.detail} · ${relativeTime(entity.time)}`),
    )
    append(row, element('div', 'agent-avatar', initials(entity.kind)), info, stateBadge(entity.state))
    wrapper.append(row)
  }
}

function latestFullCapture() {
  const latestId = appState.captures[0]?.id
  return (
    appState.captureDetails.get(latestId) ||
    appState.captureDetails.get(appState.selectedCaptureId) ||
    null
  )
}

function requestJson(capture) {
  return capture?.request?.json || capture?.request?.bodyJson || capture?.requestJson || null
}

function renderRequestComposition() {
  const wrapper = $('request-composition')
  wrapper.replaceChildren()
  const capture = latestFullCapture()
  const body = requestJson(capture)
  if (!body) {
    wrapper.append(emptyInline('捕获一条完整请求后，这里会显示上下文与工具定义的构成。'))
    return
  }
  const messages = asArray(body.messages)
  const tools = asArray(body.tools)
  const system = Array.isArray(body.system) ? body.system : body.system ? [body.system] : []
  const modelRow = element('div', 'composition-model')
  append(
    modelRow,
    element('span', 'composition-model-name', body.model || '未声明模型'),
    element('span', 'composition-model-meta', `${formatNumber(body.max_tokens || 0)} max tokens`),
  )
  const counts = [
    ['System blocks', system.length, 'var(--amber)'],
    ['Messages', messages.length, 'var(--cyan)'],
    ['Tool schemas', tools.length, 'var(--violet)'],
  ]
  const max = Math.max(...counts.map(([, count]) => count), 1)
  const bars = element('div', 'composition-bars')
  for (const [label, count, color] of counts) {
    const row = element('div', 'composition-row')
    const track = element('div', 'bar-track')
    const fill = element('div', 'bar-fill')
    fill.style.width = `${Math.max(count ? 4 : 0, (count / max) * 100)}%`
    fill.style.setProperty('--bar-color', color)
    track.append(fill)
    append(row, element('span', '', label), track, element('span', 'bar-value', formatNumber(count)))
    bars.append(row)
  }
  append(wrapper, modelRow, bars)
}

function renderOverviewTeams() {
  const wrapper = $('overview-teams')
  wrapper.replaceChildren()
  const teams = asArray(appState.diskState?.teams)
  const taskLists = asArray(appState.diskState?.taskLists)
  if (!teams.length && !taskLists.length) {
    wrapper.append(emptyInline('配置目录中没有活跃 team 或 task list。'))
    return
  }
  for (const team of teams.slice(0, 4)) {
    const config = isObject(team.config) ? team.config : {}
    const members = asArray(config.members)
    const inboxes = asArray(team.inboxes)
    const unread = inboxes.reduce((sum, inbox) => sum + toNumber(inbox.unread), 0)
    const row = element('div', 'team-summary-row')
    const info = element('div')
    append(
      info,
      element('div', 'team-summary-name', config.name || team.directoryName),
      element('div', 'team-summary-meta', `${members.length} 位成员 · ${unread} 条未读 mailbox 消息`),
    )
    append(row, info, element('div', 'team-summary-count', members.length))
    wrapper.append(row)
  }
  if (taskLists.length) {
    const openTasks = taskLists.reduce(
      (sum, list) => sum + toNumber(list.counts?.pending) + toNumber(list.counts?.inProgress),
      0,
    )
    const row = element('div', 'team-summary-row')
    const info = element('div')
    append(
      info,
      element('div', 'team-summary-name', '共享任务存储'),
      element('div', 'team-summary-meta', `${taskLists.length} 个活跃 task list`),
    )
    append(row, info, element('div', 'team-summary-count', `${openTasks} open`))
    wrapper.append(row)
  }
}

function filteredCaptures() {
  const query = appState.captureSearch.trim().toLowerCase()
  return appState.captures.filter(capture => {
    if (appState.captureFilter !== 'all' && capture.state !== appState.captureFilter) return false
    if (!query) return true
    return [capture.id, capture.model, capture.path, capture.upstreamUrl, capture.method]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(query))
  })
}

function renderCaptureList() {
  const wrapper = $('capture-list')
  wrapper.replaceChildren()
  const captures = filteredCaptures()
  if (!captures.length) {
    wrapper.append(emptyInline(appState.captures.length ? '没有匹配当前筛选条件的请求。' : '等待 Claude Code 发出请求…'))
    return
  }
  for (const capture of captures) {
    const row = button(
      `capture-item ${capture.id === appState.selectedCaptureId ? 'is-selected' : ''}`.trim(),
      null,
      () => loadCapture(capture.id),
    )
    const top = element('div', 'capture-item-top')
    const method = element('div', 'capture-method')
    append(
      method,
      statusDot(capture.state),
      element('span', 'method-badge', capture.method || 'POST'),
      element('span', 'capture-model', capture.model || 'unknown model'),
    )
    append(top, method, element('span', 'capture-time', formatClock(capture.startedAt)))
    const bottom = element('div', 'capture-item-bottom')
    append(
      bottom,
      element('span', '', `${capture.messageCount ?? '—'} msg`),
      element('span', '', `${capture.toolCount ?? '—'} tools`),
      element('span', '', formatDuration(capture.durationMs)),
      stateBadge(capture.state, capture.statusCode || stateLabel(capture.state)),
    )
    append(row, top, element('div', 'capture-path', capture.path || capture.upstreamUrl || capture.id), bottom)
    wrapper.append(row)
  }
}

function renderCaptureDetailLoading() {
  const wrapper = $('capture-detail')
  const template = $('loading-template')
  wrapper.replaceChildren(template.content.cloneNode(true))
}

function renderCaptureDetailError(error) {
  const wrapper = $('capture-detail')
  const state = element('div', 'empty-state')
  append(
    state,
    element('h2', '', '无法读取请求详情'),
    element('p', '', error instanceof Error ? error.message : String(error)),
  )
  wrapper.replaceChildren(state)
}

function capturePreview(id) {
  return appState.captures.find(item => item.id === id) || {}
}

function renderCaptureDetail() {
  if (!appState.selectedCaptureId) return
  const capture = appState.captureDetails.get(appState.selectedCaptureId)
  if (!capture) return
  const preview = capturePreview(appState.selectedCaptureId)
  const merged = { ...preview, ...capture }
  const request = merged.request || {}
  const response = merged.response || {}
  const metrics = merged.metrics || {}
  const body = requestJson(merged)
  const wrapper = $('capture-detail')
  wrapper.replaceChildren()

  const header = element('header', 'detail-header')
  const headerTop = element('div', 'detail-header-top')
  const titleGroup = element('div')
  const titleLine = element('div', 'detail-title-line')
  append(
    titleLine,
    statusDot(merged.state),
    element('span', 'method-badge', request.method || merged.method || 'POST'),
    element('h2', '', body?.model || merged.model || request.path || merged.id),
    stateBadge(merged.state),
  )
  append(
    titleGroup,
    titleLine,
    element(
      'div',
      'detail-id',
      `${merged.id} · ${request.path || merged.path || request.upstreamUrl || ''}`,
    ),
  )
  append(headerTop, titleGroup, copyButton(() => merged.id, '复制 ID'))

  const metricsRow = element('div', 'detail-metrics')
  const metricEntries = [
    ['HTTP', response.statusCode || merged.statusCode || '—'],
    ['TTFB', formatDuration(firstDefined(metrics.ttfbMs, merged.ttfbMs))],
    ['TTFT', formatDuration(firstDefined(metrics.ttftMs, merged.ttftMs))],
    ['总耗时', formatDuration(firstDefined(metrics.durationMs, merged.durationMs))],
    ['请求体', formatBytes(firstDefined(request.byteLength, merged.requestBytes))],
    ['响应体', formatBytes(firstDefined(response.byteLength, merged.responseBytes))],
  ]
  for (const [label, value] of metricEntries) {
    const metric = element('span', 'detail-metric')
    append(metric, element('span', 'detail-metric-label', label), element('span', 'detail-metric-value', value))
    metricsRow.append(metric)
  }

  const tabs = element('div', 'detail-tabs')
  const tabEntries = [
    ['request', '发送请求'],
    ['response', '重建响应'],
    ['timeline', `SSE 时间线 · ${getResponseEvents(merged).length}`],
    ['raw', '原始数据'],
  ]
  for (const [id, label] of tabEntries) {
    tabs.append(
      button(`detail-tab ${appState.detailTab === id ? 'is-active' : ''}`.trim(), label, () => {
        appState.detailTab = id
        renderCaptureDetail()
      }),
    )
  }
  append(header, headerTop, metricsRow, tabs)
  const content = element('div', 'detail-body')
  if (appState.detailTab === 'request') renderRequestTab(content, merged)
  else if (appState.detailTab === 'response') renderResponseTab(content, merged)
  else if (appState.detailTab === 'timeline') renderSseTimeline(content, merged)
  else renderRawTab(content, merged)
  append(wrapper, header, content)
}

function renderRequestTab(content, capture) {
  const request = capture.request || {}
  const body = requestJson(capture)
  if (capture.error && !body) {
    const banner = element('div', 'error-banner')
    append(banner, element('div', '', String(capture.error)))
    content.append(banner)
  }
  const meta = element('div', 'request-meta-grid')
  const values = [
    ['Method', request.method || capture.method || 'POST'],
    ['Path', request.path || capture.path || '—'],
    ['Incoming URL', request.incomingUrl || '—'],
    ['Upstream URL', request.upstreamUrl || capture.upstreamUrl || '—'],
    ['Received', request.receivedAt || capture.startedAt || '—'],
  ]
  for (const [label, value] of values) {
    const item = element('div', 'request-meta-item')
    append(item, element('div', 'request-meta-label', label), element('div', 'request-meta-value', value))
    item.querySelector('.request-meta-value').title = String(value)
    meta.append(item)
  }
  content.append(section('请求路由', meta))
  const upstreamHeaders = request.forwardedHeaders || request.headers
  content.append(
    section(
      '发往上游的 HTTP Headers',
      keyValueTable(upstreamHeaders),
      `${Object.keys(upstreamHeaders || {}).length} headers`,
    ),
  )
  if (request.forwardedHeaders && request.headers) {
    content.append(
      section(
        'Claude Code → WireLens 的入站 Headers',
        keyValueTable(request.headers),
        `${Object.keys(request.headers).length} headers`,
      ),
    )
  }

  if (!body) {
    const raw = firstDefined(request.rawText, request.rawBody, request.body, capture.requestBody)
    content.append(section('请求体', raw ? jsonCode(raw) : emptyInline('请求体未被保留或无法解析')))
    return
  }

  content.append(renderSystemSection(body.system))
  content.append(renderMessagesSection(body.messages))
  content.append(renderToolsSection(body.tools))
  const other = { ...body }
  delete other.system
  delete other.messages
  delete other.tools
  content.append(section('其他 Messages 参数', jsonCode(other), `${Object.keys(other).length} fields`))
}

function normalizeContent(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

function readableBlock(block) {
  if (typeof block === 'string') return block
  if (!isObject(block)) return jsonString(block)
  if (typeof block.text === 'string') return block.text
  if (typeof block.thinking === 'string') return block.thinking
  return jsonString(block)
}

function renderSystemSection(value) {
  const blocks = normalizeContent(value)
  const body = element('div', 'prompt-blocks')
  if (!blocks.length) body.append(emptyInline('该请求未包含 system blocks'))
  blocks.forEach((block, index) => {
    const card = element('article', 'prompt-block')
    const head = element('div', 'prompt-block-head')
    append(
      head,
      element('span', 'role-badge system', 'system'),
      element('span', 'prompt-block-index', `#${index}`),
      element('span', 'prompt-block-kind', block?.type || typeof block),
    )
    append(card, head, element('div', 'prompt-block-text', readableBlock(block)))
    body.append(card)
  })
  return section('System Prompt', body, `${blocks.length} blocks`)
}

function renderMessagesSection(value) {
  const messages = asArray(value)
  const body = element('div', 'prompt-blocks')
  if (!messages.length) body.append(emptyInline('该请求没有 messages'))
  messages.forEach((message, index) => {
    const card = element('article', 'prompt-block')
    const head = element('div', 'prompt-block-head')
    const role = message?.role || 'unknown'
    const blocks = normalizeContent(message?.content)
    append(
      head,
      element('span', `role-badge ${role}`, role),
      element('span', 'prompt-block-index', `message #${index}`),
      element('span', 'prompt-block-kind', `${blocks.length} content blocks`),
    )
    card.append(head)
    blocks.forEach((block, blockIndex) => {
      const text = element('div', 'prompt-block-text', readableBlock(block))
      if (blocks.length > 1) text.dataset.block = String(blockIndex)
      card.append(text)
    })
    body.append(card)
  })
  return section('Messages', body, `${messages.length} messages`)
}

function renderToolsSection(value) {
  const tools = asArray(value)
  const body = element('div', 'tool-list')
  if (!tools.length) body.append(emptyInline('该请求没有发送工具定义'))
  tools.forEach(tool => {
    const details = element('details', 'tool-card')
    const summary = element('summary')
    append(
      summary,
      element('span', '', tool?.name || 'unnamed_tool'),
      element('span', 'tool-description', String(tool?.description || '').replace(/\s+/gu, ' ').slice(0, 100)),
    )
    append(details, summary, jsonCode(tool))
    body.append(details)
  })
  return section('Tool Schemas', body, `${tools.length} tools`)
}

function responseSummary(capture) {
  return capture?.response?.summary || capture?.summary || {}
}

function renderResponseTab(content, capture) {
  const response = capture.response || {}
  const summary = responseSummary(capture)
  if (capture.error || summary.error) {
    const banner = element('div', 'error-banner')
    const body = element('div')
    append(
      body,
      element('strong', '', '请求或上游返回错误'),
      element('span', '', typeof (capture.error || summary.error) === 'string' ? capture.error || summary.error : jsonString(capture.error || summary.error)),
    )
    append(banner, body)
    content.append(banner)
  }

  const hero = element('div', 'response-hero')
  const identity = element('div')
  append(
    identity,
    element('div', 'response-model', summary.model || '响应模型未声明'),
    element('div', 'response-id', summary.id || `HTTP ${response.statusCode || capture.statusCode || '—'}`),
  )
  const usage = summary.usage || {}
  const pills = element('div', 'token-pills')
  const tokenEntries = [
    ['input', firstDefined(usage.input_tokens, usage.inputTokens, capture.inputTokens)],
    ['output', firstDefined(usage.output_tokens, usage.outputTokens, capture.outputTokens)],
    ['cache read', firstDefined(usage.cache_read_input_tokens, usage.cacheReadInputTokens)],
    ['stop', firstDefined(summary.stopReason, summary.stop_reason, capture.stopReason)],
  ]
  for (const [label, value] of tokenEntries) {
    if (value !== undefined && value !== null) pills.append(element('span', 'token-pill', `${label}: ${value}`))
  }
  append(hero, identity, pills)
  content.append(section('响应摘要', hero))

  const blocks = asArray(summary.content)
  const blocksWrapper = element('div', 'response-blocks')
  if (!blocks.length) blocksWrapper.append(emptyInline('尚未从 SSE 事件中重建出内容块'))
  blocks.forEach((block, index) => {
    const card = element('article', 'response-block')
    const type = block?.type || 'unknown'
    const head = element('div', 'response-block-head')
    append(head, element('span', '', type), element('span', 'block-index', `#${index}`))
    card.append(head)
    if (type === 'text') {
      card.append(element('div', 'response-text', block.text || ''))
    } else if (type === 'thinking') {
      card.append(element('div', 'response-text thinking-text', block.thinking || block.text || ''))
    } else {
      card.append(jsonCode(block))
    }
    blocksWrapper.append(card)
  })
  content.append(section('Content Blocks', blocksWrapper, `${blocks.length} blocks`))
  if (!blocks.length && response.json) {
    content.append(section('JSON 响应体', jsonCode(response.json)))
  }
  content.append(section('响应 Headers', keyValueTable(response.headers), `${Object.keys(response.headers || {}).length} headers`))
}

function getResponseEvents(capture) {
  return asArray(
    firstDefined(
      capture?.response?.events,
      capture?.response?.sseEvents,
      capture?.response?.parsedEvents,
      capture?.sseEvents,
      capture?.events,
    ),
  )
}

function eventName(entry) {
  return entry?.event || entry?.type || entry?.json?.type || 'message'
}

function eventColor(name) {
  if (name === 'message_start') return 'var(--cyan)'
  if (name === 'message_stop') return 'var(--green)'
  if (name === 'error') return 'var(--red)'
  if (name.includes('delta')) return 'var(--violet)'
  if (name.includes('content_block')) return 'var(--amber)'
  return 'var(--faint)'
}

function eventSummary(entry) {
  const data = entry?.json || entry?.data
  if (!isObject(data)) return typeof data === 'string' ? data.slice(0, 160) : ''
  if (data.type === 'message_start') {
    return `${data.message?.model || 'unknown model'} · ${data.message?.id || ''}`
  }
  if (data.type === 'content_block_start') {
    return `index ${data.index} · ${data.content_block?.type || 'unknown block'}`
  }
  if (data.type === 'content_block_delta') {
    const delta = data.delta || {}
    const fragment = firstDefined(delta.text, delta.thinking, delta.partial_json, delta.signature)
    return `${delta.type || 'delta'}${fragment ? ` · ${String(fragment).replace(/\s+/gu, ' ').slice(0, 140)}` : ''}`
  }
  if (data.type === 'message_delta') {
    return `${data.delta?.stop_reason || 'message update'} · output ${data.usage?.output_tokens ?? '—'} tokens`
  }
  if (data.type === 'error') return data.error?.message || jsonString(data.error || data)
  return jsonString(data).replace(/\s+/gu, ' ').slice(0, 160)
}

function renderSseTimeline(content, capture) {
  const events = getResponseEvents(capture)
  if (!events.length) {
    content.append(emptyInline('该响应没有已解析的 SSE 事件；可能尚在连接，或上游未返回 event-stream。'))
    return
  }
  const timeline = element('div', 'timeline')
  const limit = 1500
  events.slice(0, limit).forEach((entry, index) => {
    const name = eventName(entry)
    const row = element('article', 'timeline-event')
    row.style.setProperty('--event-color', eventColor(name))
    const top = element('div', 'timeline-top')
    const offset = firstDefined(entry.offsetMs, entry.elapsedMs, entry.receivedAfterMs)
    append(
      top,
      element('span', 'timeline-name', name),
      element('span', 'timeline-time', offset !== undefined ? `+${formatDuration(offset)}` : `#${index}`),
    )
    const details = element('details')
    details.append(element('summary', '', '展开事件 payload'))
    details.append(jsonCode(entry.json ?? entry.data ?? entry))
    append(
      row,
      element('span', 'timeline-node'),
      top,
      element('div', 'timeline-summary', eventSummary(entry)),
      details,
    )
    timeline.append(row)
  })
  if (events.length > limit) {
    timeline.append(element('div', 'empty-inline', `事件共 ${events.length} 条；为保持页面流畅，此处仅显示前 ${limit} 条。原始数据页仍可查看完整记录。`))
  }
  content.append(section('Server-Sent Events', timeline, `${events.length} events`))
}

function rawResponse(capture) {
  const response = capture.response || {}
  const raw = firstDefined(
    response.rawText,
    response.rawBody,
    response.body,
    response.raw,
    capture.responseBody,
  )
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'string') return raw
    if (ArrayBuffer.isView(raw)) return `[${raw.byteLength} bytes]`
    return jsonString(raw)
  }
  const events = getResponseEvents(capture)
  if (events.length) {
    return events
      .map(entry => {
        const type = eventName(entry)
        const data =
          typeof entry.data === 'string'
            ? entry.data
            : jsonString(entry.json ?? entry.data ?? entry)
        return `event: ${type}\ndata: ${data}\n`
      })
      .join('\n')
  }
  return ''
}

function renderRawTab(content, capture) {
  const request = capture.request || {}
  const requestRaw = firstDefined(request.rawText, request.rawBody, request.body, capture.requestBody)
  const responseRaw = rawResponse(capture)
  content.append(
    element(
      'p',
      'raw-note',
      '这里展示 WireLens 保存的原始应用层内容。HTTP 客户端可能已完成传输解压；认证类请求头默认已脱敏。',
    ),
  )
  content.append(section('原始请求体', element('pre', 'raw-frame', requestRaw || jsonString(requestJson(capture) || '未保留'))))
  content.append(section('原始响应 / SSE', element('pre', 'raw-frame', responseRaw || '未保留原始响应内容')))
}

function renderAgentRuntime() {
  const wrapper = $('agent-runtime')
  wrapper.replaceChildren()
  const hooks = appState.hooks || {}
  const sessions = asArray(hooks.sessions)
  const subagents = asArray(hooks.subagents)
  const tasks = asArray(hooks.tasks)
  const metrics = element('div', 'runtime-metrics')
  const metricData = [
    ['Sessions', sessions.length],
    ['活跃 Subagents', subagents.filter(item => item.state === 'running').length],
    ['观测到的 Tasks', tasks.length],
    ['Hook Events', asArray(hooks.events).length],
  ]
  for (const [label, value] of metricData) {
    const card = element('div', 'runtime-metric')
    append(card, element('div', 'runtime-metric-value', formatNumber(value)), element('div', 'runtime-metric-label', label))
    metrics.append(card)
  }
  wrapper.append(metrics)

  const grid = element('div', 'runtime-grid')
  grid.append(renderRuntimeGraph(sessions, subagents))
  grid.append(renderEntityPanel('Sessions', sessions, 'session'))
  grid.append(renderEntityPanel('Subagents', subagents, 'subagent'))
  grid.append(renderEntityPanel('Hook Tasks', tasks, 'task'))
  wrapper.append(grid)
}

function renderRuntimeGraph(sessions, subagents) {
  const panel = element('section', 'panel full')
  const heading = element('div', 'panel-heading')
  append(heading, append(element('div'), element('span', 'section-kicker', 'OBSERVED TOPOLOGY'), element('h2', '', '当前观测关系')))
  const graph = element('div', 'agent-graph')
  const session = sessions.find(item => ['active', 'observed', 'stopped'].includes(item.state)) || sessions[0]
  if (!session && !subagents.length) {
    graph.append(emptyInline('Hook 数据到达后，这里会连接 session 与它启动的 subagent。'))
  } else {
    const lead = element('div', 'graph-node lead')
    append(
      lead,
      statusDot(session?.state || 'observed'),
      element('div', 'graph-node-name', shortId(session?.sessionId || 'Claude Code')),
      element('div', 'graph-node-kind', session?.model || 'coordinator session'),
    )
    graph.append(lead)
    for (const agent of subagents.slice(0, 6)) {
      const node = element('div', 'graph-node')
      append(
        node,
        statusDot(agent.state),
        element('div', 'graph-node-name', shortId(agent.agentId)),
        element('div', 'graph-node-kind', agent.agentType || 'subagent'),
      )
      graph.append(node)
    }
    if (subagents.length > 6) {
      const overflow = element('div', 'graph-node')
      append(overflow, element('div', 'graph-node-name', `+${subagents.length - 6}`), element('div', 'graph-node-kind', 'more agents'))
      graph.append(overflow)
    }
  }
  append(panel, heading, graph)
  return panel
}

function renderEntityPanel(title, entities, kind) {
  const panel = element('section', `panel ${kind === 'task' ? 'full' : ''}`.trim())
  const heading = element('div', 'panel-heading')
  append(
    heading,
    append(element('div'), element('span', 'section-kicker', kind.toUpperCase()), element('h2', '', title)),
    element('span', 'source-pill', `${entities.length} observed`),
  )
  const list = element('div', 'entity-list')
  if (!entities.length) {
    list.append(emptyInline(`尚未收到 ${title} 相关 Hook。`))
  } else {
    for (const entity of entities.slice(0, 30)) {
      const row = element('div', 'entity-row')
      const id = firstDefined(entity.sessionId, entity.agentId, entity.taskId, 'unknown')
      const info = element('div')
      const subtitle =
        kind === 'session'
          ? `${entity.model || 'unknown model'} · ${entity.lastEvent || 'observed'}`
          : kind === 'subagent'
            ? `${entity.agentType || 'unknown type'} · session ${shortId(entity.sessionId)}`
            : `${entity.subject || entity.description || 'unnamed task'}${entity.teammateName ? ` · ${entity.teammateName}` : ''}`
      const time = firstDefined(
        entity.lastSeenAt,
        entity.stoppedAt,
        entity.completedAt,
        entity.startedAt,
        entity.createdAt,
      )
      append(
        info,
        element('div', 'entity-title', id),
        element('div', 'entity-subtitle', subtitle),
        element('div', 'entity-time', relativeTime(time)),
      )
      append(row, element('div', `entity-icon ${kind}`, initials(kind)), info, stateBadge(entity.state))
      list.append(row)
    }
  }
  append(panel, heading, list)
  return panel
}

function renderTeams() {
  const wrapper = $('teams-runtime')
  wrapper.replaceChildren()
  const disk = appState.diskState || {}
  const teams = asArray(disk.teams)
  const taskLists = asArray(disk.taskLists)
  $('scan-status').textContent = disk.scannedAt
    ? `扫描于 ${formatClock(disk.scannedAt)} · ${formatDuration(disk.scanDurationMs)}`
    : '尚未扫描'
  if (!teams.length && !taskLists.length) {
    wrapper.append(emptyInline(`在 ${disk.configDir || appState.config.claudeConfigDir || 'Claude 配置目录'} 中没有发现活跃团队或任务。`))
    return
  }
  const stack = element('div', 'teams-stack')
  for (const team of teams) stack.append(renderTeamCard(team, taskLists))

  const matchedIds = new Set()
  for (const team of teams) {
    const config = team.config || {}
    matchedIds.add(String(config.name || team.directoryName || ''))
    matchedIds.add(String(team.directoryName || ''))
  }
  for (const list of taskLists.filter(item => !matchedIds.has(String(item.listId)))) {
    stack.append(renderTaskListOnly(list))
  }
  wrapper.append(stack)
}

function renderTeamCard(team, taskLists) {
  const config = isObject(team.config) ? team.config : {}
  const teamName = config.name || team.directoryName || 'unnamed team'
  const members = asArray(config.members)
  const inboxes = asArray(team.inboxes)
  const taskList =
    taskLists.find(list => list.listId === team.directoryName) ||
    taskLists.find(list => list.listId === teamName)
  const card = element('article', 'team-card')
  const head = element('header', 'team-card-head')
  const identity = element('div')
  append(
    identity,
    element('div', 'team-card-name', teamName),
    element('div', 'team-card-description', config.description || `磁盘目录 ${team.directoryName}`),
  )
  const meta = element('div', 'team-head-meta')
  append(
    meta,
    element('span', 'source-pill', `${members.length} members`),
    element('span', 'source-pill', `${inboxes.reduce((sum, inbox) => sum + toNumber(inbox.unread), 0)} unread`),
  )
  append(head, identity, meta)
  const body = element('div', 'team-card-body')
  const rosterColumn = element('div', 'team-column')
  const rosterHeading = element('h3', 'subheading')
  append(rosterHeading, element('span', '', 'Roster'), element('span', '', config.leadAgentId ? `lead ${shortId(config.leadAgentId)}` : ''))
  const roster = element('div', 'roster-grid')
  if (!members.length) roster.append(emptyInline('config.json 中没有 members'))
  members.forEach((member, index) => {
    const memberName = member.name || member.agentName || member.agentId || `member-${index + 1}`
    const row = element('div', 'member-card')
    const avatar = element('div', 'member-avatar', initials(memberName))
    avatar.style.setProperty('--member-color', paletteColor(memberName))
    const info = element('div')
    append(
      info,
      element('div', 'member-name', memberName),
      element(
        'div',
        'member-meta',
        `${member.agentType || member.type || 'agent'} · ${member.model || 'inherit'} · ${member.isActive === false ? 'inactive' : 'active'}`,
      ),
    )
    append(row, avatar, info)
    roster.append(row)
  })
  append(rosterColumn, rosterHeading, roster)

  const inboxColumn = element('div', 'team-column')
  const inboxHeading = element('h3', 'subheading')
  append(inboxHeading, element('span', '', 'Mailboxes'), element('span', '', `${inboxes.length} inboxes`))
  const inboxList = element('div', 'inbox-list')
  if (!inboxes.length) inboxList.append(emptyInline('未发现 inbox 文件'))
  inboxes.forEach(inbox => {
    const row = element('div', 'inbox-row')
    const info = element('div')
    append(
      info,
      element('div', 'inbox-name', inbox.agentName || 'unknown'),
      element('div', 'inbox-meta', `${toNumber(inbox.total)} 条消息${inbox.error ? ` · ${inbox.error}` : ''}`),
    )
    append(
      row,
      info,
      element('span', `unread-count ${toNumber(inbox.unread) ? '' : 'is-zero'}`.trim(), `${toNumber(inbox.unread)} 未读`),
    )
    inboxList.append(row)
  })
  append(inboxColumn, inboxHeading, inboxList)
  append(body, rosterColumn, inboxColumn)
  append(card, head, body)
  if (taskList) card.append(renderTaskBoard(taskList))
  return card
}

function renderTaskListOnly(list) {
  const card = element('article', 'team-card')
  const head = element('header', 'team-card-head')
  const identity = element('div')
  append(
    identity,
    element('div', 'team-card-name', `Task list · ${list.listId}`),
    element('div', 'team-card-description', '任务目录仍有未完成项，但没有匹配的 team config。'),
  )
  append(head, identity, element('span', 'source-pill', `${asArray(list.tasks).length} tasks`))
  append(card, head, renderTaskBoard(list))
  return card
}

function renderTaskBoard(list) {
  const board = element('div', 'task-board')
  const tasks = asArray(list.tasks)
  const columns = [
    ['pending', '待处理'],
    ['in_progress', '处理中'],
    ['completed', '已完成'],
  ]
  for (const [status, label] of columns) {
    const column = element('section', 'task-column')
    const columnTasks = tasks.filter(task => task.status === status)
    const head = element('div', 'task-column-head')
    append(head, element('span', '', label), element('span', 'task-column-count', columnTasks.length))
    column.append(head)
    if (!columnTasks.length) {
      column.append(element('div', 'empty-inline', '无'))
    } else {
      for (const task of columnTasks.slice(0, 20)) {
        const row = element('article', 'task-card')
        const owner = task.owner || 'unassigned'
        append(
          row,
          element('div', 'task-card-subject', task.subject || task.description || `Task ${task.id || '?'}`),
          append(
            element('div', 'task-card-meta'),
            element('span', '', `#${task.id || '?'}`),
            element('span', '', owner),
          ),
        )
        column.append(row)
      }
    }
    board.append(column)
  }
  return board
}

function paletteColor(value) {
  const palette = ['#5bd9ee', '#a893ff', '#68dda9', '#f1b96a', '#78a9ff', '#e58fc7']
  let hash = 0
  for (const character of String(value || '')) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}

function renderHooks() {
  const wrapper = $('hook-timeline')
  wrapper.replaceChildren()
  const query = appState.hookSearch.trim().toLowerCase()
  const events = asArray(appState.hooks?.events).filter(entry => {
    if (!query) return true
    return [
      entry.event,
      entry.sequence,
      entry.payload?.session_id,
      entry.payload?.agent_id,
      entry.payload?.task_id,
      entry.payload?.tool_name,
    ]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(query))
  })
  if (!events.length) {
    wrapper.append(emptyInline(query ? '没有匹配的 Hook 事件。' : 'Hook receiver 尚未收到事件。'))
    renderHookInspector()
    return
  }
  for (const entry of events.slice(0, 500)) {
    const row = element(
      'article',
      `hook-event ${entry.sequence === appState.selectedHookSequence ? 'is-selected' : ''}`.trim(),
    )
    row.tabIndex = 0
    row.role = 'button'
    row.style.setProperty('--hook-color', hookColor(entry.event))
    const select = () => {
      appState.selectedHookSequence = entry.sequence
      renderHooks()
    }
    row.addEventListener('click', select)
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        select()
      }
    })
    const summary = element('div')
    append(
      summary,
      element('div', 'hook-summary-title', hookTitle(entry)),
      element('div', 'hook-summary-meta', hookMeta(entry)),
    )
    append(
      row,
      element('span', 'hook-type', entry.event || 'Unknown'),
      summary,
      element('time', 'hook-clock', formatClock(entry.receivedAt)),
    )
    wrapper.append(row)
  }
  if (events.length > 500) wrapper.append(emptyInline(`当前筛选有 ${events.length} 条事件，仅渲染最新 500 条。`))
  renderHookInspector()
}

function hookColor(event) {
  if (String(event).includes('Start')) return 'var(--cyan)'
  if (String(event).includes('Stop') || String(event).includes('Completed')) return 'var(--green)'
  if (String(event).includes('Failure') || String(event).includes('Error')) return 'var(--red)'
  if (String(event).includes('Tool')) return 'var(--violet)'
  if (String(event).includes('Task')) return 'var(--amber)'
  return 'var(--blue)'
}

function hookTitle(entry) {
  const payload = entry.payload || {}
  return firstDefined(
    payload.task_subject,
    payload.tool_name,
    payload.agent_type,
    payload.source,
    payload.reason,
    payload.prompt,
    entry.event,
  )
}

function hookMeta(entry) {
  const payload = entry.payload || {}
  const ids = []
  if (payload.session_id) ids.push(`session ${shortId(payload.session_id)}`)
  if (payload.agent_id) ids.push(`agent ${shortId(payload.agent_id)}`)
  if (payload.task_id) ids.push(`task ${payload.task_id}`)
  return ids.length ? ids.join(' · ') : `sequence ${entry.sequence}`
}

function renderHookInspector() {
  const wrapper = $('hook-inspector')
  const entry = asArray(appState.hooks?.events).find(
    item => item.sequence === appState.selectedHookSequence,
  )
  if (!entry) {
    wrapper.replaceChildren(emptyInline('选择事件后查看完整 payload'))
    return
  }
  const heading = element('div', 'inspector-heading')
  append(
    heading,
    element('span', 'inspector-title', `${entry.event} · #${entry.sequence}`),
    copyButton(() => jsonString(entry.payload), '复制 JSON'),
  )
  const body = element('div', 'inspector-body')
  body.append(jsonCode(entry.payload))
  wrapper.replaceChildren(heading, body)
}

function installInteractions() {
  document.querySelectorAll('.nav-item').forEach(node => {
    node.addEventListener('click', () => selectView(node.dataset.view))
  })
  document.querySelectorAll('[data-go-view]').forEach(node => {
    node.addEventListener('click', () => selectView(node.dataset.goView))
  })
  document.querySelectorAll('[data-capture-filter]').forEach(node => {
    node.addEventListener('click', () => {
      appState.captureFilter = node.dataset.captureFilter
      document.querySelectorAll('[data-capture-filter]').forEach(filter => {
        filter.classList.toggle('is-active', filter === node)
      })
      renderCaptureList()
    })
  })
  $('capture-search-input').addEventListener('input', event => {
    appState.captureSearch = event.target.value
    renderCaptureList()
  })
  $('hook-search-input').addEventListener('input', event => {
    appState.hookSearch = event.target.value
    renderHooks()
  })
  $('refresh-button').addEventListener('click', () => refreshAll())
  $('config-dir-value').addEventListener('click', async () => {
    const value = appState.config.claudeConfigDir
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      showToast('配置目录已复制')
    } catch {
      showToast('浏览器拒绝了剪贴板访问', 'error')
    }
  })
  window.addEventListener('hashchange', () => selectView(location.hash.slice(1) || 'overview'))
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll({ quiet: true })
  })
}

async function boot() {
  installInteractions()
  const initialView = location.hash.slice(1)
  selectView(initialView || 'overview')
  setLiveState('connecting')
  await refreshAll()
  connectEvents()
  window.setInterval(() => refreshAll({ quiet: true }), 12_000)
}

boot().catch(error => {
  setLiveState('offline')
  showToast(`启动失败：${error instanceof Error ? error.message : String(error)}`, 'error')
})
