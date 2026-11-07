/**
 * The token guard's settings, kept apart from Paperclip's budgets.
 *
 * Paperclip's budgets count billed dollars, and a subscription run bills none, so they never stop
 * anything on a subscription. The owner sets a token limit here, and a small script on this machine
 * pauses the Claude bots past it and resumes them once usage falls back. The door only reads and
 * writes these settings. It pauses nothing itself.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_LIMIT = 1e11

export const guardFolder = (env = process.env) => env.AGENT_ATRIUM_GUARD_DIR || path.join(os.homedir(), '.config', 'agent-atrium')

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export function readGuard(folder) {
  const settings = readJson(path.join(folder, 'guard.json'))
  const state = readJson(path.join(folder, 'guard-state.json'))
  return { enabled: Boolean(settings.enabled), limit: Number(settings.limit) || 0, tripped: Boolean(state.tripped), used: Number(state.used) || 0 }
}

export function writeGuard(folder, { enabled, limit }) {
  const clean = { enabled: Boolean(enabled), limit: Math.min(MAX_LIMIT, Math.max(0, Math.round(Number(limit) || 0))) }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(folder, 'guard.json'), JSON.stringify(clean), { mode: 0o600 })
  return readGuard(folder)
}
