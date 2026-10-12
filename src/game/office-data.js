import { allowanceWindow } from '../ui/usage.js'

/** A thread's office status. Mirrors `phase` in server/office.mjs, which records the chronicle. */
export const phase = t => t.hasError ? 'blocked' : t.running ? 'working' : t.unread ? 'waiting' : t.archived ? 'archived' : 'idle'

export function filterCrew(threads, { query = '', status = '', harness = '', model = '', repo = '' } = {}) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return threads.filter(t => {
    const haystack = [t.title, t.preview, t.project, t.model, t.harnessName, t.gitBranch].join(' ').toLowerCase()
    return words.every(word => haystack.includes(word)) && (!status || phase(t) === status) && (!harness || t.harness === harness) && (!model || t.model === model) && (!repo || t.project === repo)
  })
}

export function morningBriefing(threads, office = {}, now = Date.now()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const current = threads.filter(t => !t.archived && !t.parentId)
  const blocked = current.filter(t => t.hasError), waiting = current.filter(t => !t.hasError && t.unread && !t.running)
  const working = current.filter(t => t.running && !t.hasError)
  const shipped = (office.events || []).filter(e => e.at >= today.getTime() && e.kind === 'mission-done')
  const merged = (office.health || []).filter(r => r.pr?.state === 'MERGED')
  const missions = (office.missions || []).filter(m => !['done', 'cancelled'].includes(m.status))
  return { blocked, waiting, working, shipped, merged, missions, today: today.getTime(),
    suggestion: blocked.length ? 'Clear the red beacons first. Those agents need a decision.' : waiting.length ? 'Your crew is ready for review. Visit the blue beacons.' : working.length ? 'Work is underway. Check the chronicle for the next handoff.' : missions.length ? 'There are mission packets ready to deliver.' : 'The floor is quiet. Start a conversation or prepare the next mission.' }
}

export function dailyUsage(rows, { model = '', days = 14, now = Date.now() } = {}) {
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0)
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(end.getTime() - (days - i - 1) * 86400000).toISOString().slice(0, 10)
    const matching = rows.filter(r => r.day === day && (!model || r.model === model))
    return { day, inputTokens: matching.reduce((n, r) => n + r.inputTokens, 0), outputTokens: matching.reduce((n, r) => n + r.outputTokens, 0),
      cachedInputTokens: matching.reduce((n, r) => n + r.cachedInputTokens, 0), totalTokens: matching.reduce((n, r) => n + r.totalTokens, 0) }
  })
}

/** Energy warnings persist by reset window. An elapsed reset is a reminder, not a refill claim. */
export class EnergyAlerts {
  constructor({ notify, read = () => [], write = () => {} }) {
    this.notify = notify; this.write = write
    try { this.seen = new Set(read()) } catch { this.seen = new Set() }
    this.windows = new Map()
  }
  update(report, { threshold = 20, dailyBudget = 0, now = Date.now() } = {}) {
    const warnings = []
    const send = (id, text) => {
      if (this.seen.has(id)) return
      this.seen.add(id); this.notify(text)
      if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value)
      try { this.write([...this.seen]) } catch { /* storage unavailable */ }
    }
    for (const limit of report.limits || []) for (const w of limit.windows) {
      const key = `${limit.assistant}:${limit.id}:${w.label}:${w.resetsAt}`
      const state = allowanceWindow(w, limit.observedAt, now)
      if (!state.expired && !state.stale && state.remainingPercent <= threshold) {
        const text = `${limit.assistant} energy is low: ${Math.round(state.remainingPercent)}% left in the last provider report.`
        warnings.push({ text, assistant: limit.assistant }); send(`low:${key}`, text)
        this.windows.set(key, { resetsAt: w.resetsAt, assistant: limit.assistant })
      }
      if (state.expired && w.resetsAt && w.usedPercent >= 100 - threshold) this.windows.set(key, { resetsAt: w.resetsAt, assistant: limit.assistant })
    }
    for (const [key, w] of this.windows) if (w.resetsAt <= now) {
      send(`reset:${key}`, `${w.assistant}'s recorded reset time has arrived. Check the provider for a fresh allowance.`)
      this.windows.delete(key)
    }
    const today = dailyUsage(report.byDay || [], { days: 1, now })[0]
    if (dailyBudget > 0 && today.totalTokens >= dailyBudget * (1 - threshold / 100)) {
      const text = `Today's recorded token use is ${Math.round(100 * today.totalTokens / dailyBudget)}% of your daily energy budget (UTC).`
      warnings.push({ text, assistant: 'Office' }); send(`budget:${today.day}:${dailyBudget}`, text)
    }
    return warnings
  }
}
