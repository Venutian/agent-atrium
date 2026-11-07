/**
 * How much of each subscription the studio has used, as the subscriptions themselves report it.
 *
 * Paperclip's token totals count a resumed conversation again on every run, so they read high. This
 * asks the crew's usage script, which reads the weekly shares Claude and Codex report in their own
 * logs, at most once a minute. Missing on a machine without the crew, so the card simply shows less.
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const SCRIPT = path.join(os.homedir(), '.paperclip', 'ngen', 'usage.py')
const FRESH_MS = 60_000
let cached = { at: 0, plans: null }

const read = () => new Promise((resolve) => {
  execFile('python3', ['-I', SCRIPT, '--json'], { timeout: 15_000 }, (err, stdout) => {
    if (err) return resolve(null)
    try {
      const r = JSON.parse(stdout)
      resolve({
        claude: r.claude ? { week: r.claude.week, resets: r.claude.resets } : null,
        codex: r.codex ? { week: r.codex.week, fiveHours: r.codex.shortWindow, resets: r.codex.resets, fiveHoursResets: r.codex.shortResets } : null,
        backup: r.thinking?.on === 'gemini' ? { until: r.thinking.back } : null,
      })
    } catch {
      resolve(null)
    }
  })
})

export async function readPlans(now = Date.now()) {
  if (now - cached.at > FRESH_MS) cached = { at: now, plans: await read() }
  return cached.plans
}
