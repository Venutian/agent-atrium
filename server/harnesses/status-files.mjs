import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, listFiles } from '../lib/fsutil.mjs'

const DIR = process.env.AGENT_ATRIUM_STATUS_DIR || path.join(os.homedir(), '.agent-atrium', 'agents')
const STATES = new Set(['working', 'waiting', 'blocked', 'idle', 'done'])
const safeUrl = (value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}

async function scanThreads() {
  const out = []
  for (const file of await listFiles(DIR, (name) => name.endsWith('.json'))) {
    try {
      const stat = await fsp.stat(file)
      if (stat.size > 64 * 1024) continue
      const data = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (!data || typeof data.id !== 'string' || !/^[\w.-]{1,100}$/.test(data.id) || !STATES.has(data.status)) continue
      const cwd = typeof data.cwd === 'string' && path.isAbsolute(data.cwd) ? data.cwd : ''
      const url = safeUrl(data.url)
      const updated = Number.isFinite(data.updatedAt) ? data.updatedAt : stat.mtimeMs
      // A crashed producer must not leave a bot working forever.
      const fresh = Date.now() - updated < 30 * 60 * 1000
      out.push({
        id: `status-files:${data.id}`, title: String(data.title || data.id).slice(0, 120),
        preview: String(data.message || '').slice(0, 240),
        project: String(data.project || (cwd && path.basename(cwd)) || 'Custom agents').slice(0, 120),
        projectPath: cwd, cwd, worktree: '', gitBranch: '', model: String(data.model || ''), effort: '',
        createdAt: Number.isFinite(data.createdAt) ? data.createdAt : stat.birthtimeMs,
        lastActivityAt: updated, lastFocusedAt: 0, running: data.status === 'working' && fresh,
        unread: data.status === 'waiting', hasError: data.status === 'blocked', archived: data.archived === true,
        prState: data.status === 'done' ? 'MERGED' : '', sizeBytes: stat.size,
        canOpen: Boolean(url), source: 'status-file', ref: { url },
      })
    } catch { /* ignore partial writes and malformed files */ }
  }
  return [...new Map(out.map((thread) => [thread.id, thread])).values()]
}

export default {
  id: 'status-files', name: 'Custom agents', detect: () => exists(DIR), scanThreads,
  openThread: (ref) => {
    const url = safeUrl(ref?.url)
    return url ? { ok: true, url } : { ok: false, error: 'This agent has no HTTP link' }
  },
  newSession: () => ({ ok: false, error: 'Start your agent and write its status file to ' + DIR }),
}
