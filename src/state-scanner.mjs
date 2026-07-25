import fs from 'node:fs/promises'
import path from 'node:path'

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    return {
      __wirelensError: error instanceof Error ? error.message : String(error),
      __wirelensPath: filePath,
    }
  }
}

async function directories(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function jsonFiles(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export class ClaudeStateScanner {
  constructor(configDir) {
    this.configDir = configDir
  }

  async snapshot() {
    const started = Date.now()
    const [teams, taskLists] = await Promise.all([
      this.#readTeams(),
      this.#readTaskLists(),
    ])
    return {
      scannedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - started,
      configDir: this.configDir,
      teams,
      taskLists,
    }
  }

  async #readTeams() {
    const teamsRoot = path.join(this.configDir, 'teams')
    const names = await directories(teamsRoot)
    return Promise.all(
      names.map(async directoryName => {
        const teamRoot = path.join(teamsRoot, directoryName)
        const config = await readJson(path.join(teamRoot, 'config.json'))
        const inboxRoot = path.join(teamRoot, 'inboxes')
        const inboxNames = await jsonFiles(inboxRoot)
        const inboxes = await Promise.all(
          inboxNames.map(async fileName => {
            const messages = await readJson(path.join(inboxRoot, fileName))
            const list = Array.isArray(messages) ? messages : []
            return {
              agentName: fileName.replace(/\.json$/u, ''),
              total: list.length,
              unread: list.filter(message => !message.read).length,
              messages,
              error: Array.isArray(messages)
                ? undefined
                : messages.__wirelensError,
            }
          }),
        )
        return {
          directoryName,
          config,
          inboxes,
        }
      }),
    )
  }

  async #readTaskLists() {
    const tasksRoot = path.join(this.configDir, 'tasks')
    const names = await directories(tasksRoot)
    const lists = await Promise.all(
      names.map(async listId => {
        const root = path.join(tasksRoot, listId)
        const names = await jsonFiles(root)
        const tasks = await Promise.all(
          names
            .filter(name => name !== '.highwatermark.json')
            .map(name => readJson(path.join(root, name))),
        )
        return {
          listId,
          tasks,
          counts: {
            pending: tasks.filter(task => task.status === 'pending').length,
            inProgress: tasks.filter(task => task.status === 'in_progress').length,
            completed: tasks.filter(task => task.status === 'completed').length,
          },
        }
      }),
    )
    return lists.filter(
      list =>
        list.tasks.length > 0 &&
        (list.counts.pending > 0 || list.counts.inProgress > 0),
    )
  }
}
