export class HookTracker {
  constructor(eventHub, maxEvents = 1000) {
    this.eventHub = eventHub
    this.maxEvents = maxEvents
    this.events = []
    this.sessions = new Map()
    this.subagents = new Map()
    this.tasks = new Map()
    this.sequence = 0
  }

  accept(payload) {
    this.sequence += 1
    const event = {
      sequence: this.sequence,
      receivedAt: new Date().toISOString(),
      event: payload.hook_event_name || 'Unknown',
      payload,
    }
    this.events.unshift(event)
    if (this.events.length > this.maxEvents) this.events.length = this.maxEvents
    this.#reduce(event)
    this.eventHub.publish('hook-event', {
      sequence: event.sequence,
      receivedAt: event.receivedAt,
      event: event.event,
      sessionId: payload.session_id,
      agentId: payload.agent_id,
    })
    return event
  }

  snapshot() {
    return {
      events: this.events,
      sessions: [...this.sessions.values()],
      subagents: [...this.subagents.values()],
      tasks: [...this.tasks.values()],
    }
  }

  #reduce(event) {
    const payload = event.payload
    const sessionId = payload.session_id
    if (sessionId) {
      const session = this.sessions.get(sessionId) || {
        sessionId,
        startedAt: event.receivedAt,
      }
      session.lastEvent = event.event
      session.lastSeenAt = event.receivedAt
      session.cwd = payload.cwd || session.cwd
      session.transcriptPath = payload.transcript_path || session.transcriptPath
      session.permissionMode = payload.permission_mode || session.permissionMode
      if (event.event === 'SessionStart') {
        session.state = 'idle'
        session.model = payload.model
        session.source = payload.source
      } else if (event.event === 'SessionEnd') {
        session.state = 'ended'
        session.endedAt = event.receivedAt
        session.reason = payload.reason
      } else if (event.event === 'Stop') {
        session.state = 'idle'
        session.lastTurnStatus = 'completed'
      } else if (event.event === 'StopFailure') {
        session.state = 'idle'
        session.lastTurnStatus = 'failed'
        session.lastError = payload.error_details || payload.error
      } else if (
        [
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'PostToolUseFailure',
          'SubagentStart',
        ].includes(event.event) &&
        session.state !== 'ended'
      ) {
        session.state = 'active'
      } else if (!session.state) {
        session.state = 'observed'
      }
      this.sessions.set(sessionId, session)
    }

    if (event.event === 'SubagentStart' && payload.agent_id) {
      this.subagents.set(payload.agent_id, {
        agentId: payload.agent_id,
        agentType: payload.agent_type,
        sessionId,
        state: 'running',
        startedAt: event.receivedAt,
        transcriptPath: payload.transcript_path,
      })
    } else if (event.event === 'SubagentStop' && payload.agent_id) {
      const agent = this.subagents.get(payload.agent_id) || {
        agentId: payload.agent_id,
        sessionId,
      }
      Object.assign(agent, {
        agentType: payload.agent_type || agent.agentType,
        state: 'stopped',
        stoppedAt: event.receivedAt,
        transcriptPath:
          payload.agent_transcript_path || agent.transcriptPath,
        lastAssistantMessage: payload.last_assistant_message,
      })
      this.subagents.set(payload.agent_id, agent)
    }

    if (event.event === 'TaskCreated' && payload.task_id) {
      const key = this.#taskKey(payload)
      this.tasks.set(key, {
        key,
        taskId: payload.task_id,
        sessionId,
        subject: payload.task_subject,
        description: payload.task_description,
        teammateName: payload.teammate_name,
        teamName: payload.team_name,
        state: 'created',
        createdAt: event.receivedAt,
      })
    } else if (event.event === 'TaskCompleted' && payload.task_id) {
      const exactKey = this.#taskKey(payload)
      const existingEntry = [...this.tasks.entries()].find(([, task]) => {
        return task.sessionId === sessionId && task.taskId === payload.task_id
      })
      const key = this.tasks.has(exactKey)
        ? exactKey
        : existingEntry?.[0] || exactKey
      const task = this.tasks.get(key) || {
        key,
        taskId: payload.task_id,
        sessionId,
      }
      Object.assign(task, {
        subject: payload.task_subject || task.subject,
        state: 'completed',
        completedAt: event.receivedAt,
      })
      this.tasks.set(key, task)
    }
  }

  #taskKey(payload) {
    if (payload.team_name) {
      return `team:${payload.team_name}:${payload.task_id}`
    }
    return `session:${payload.session_id || 'unknown-session'}:${payload.task_id}`
  }
}
