/** Stats cover scanned local sessions. Provider allowances are snapshots, never sums. */
const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
const n = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const totals = () => Object.fromEntries(fields.map(k => [k, 0]))
const sum = (into, from) => { for (const key of fields) into[key] += n(from?.[key]); return into }
export const formatTokens = value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n(value))
export const exactTokens = value => new Intl.NumberFormat().format(n(value))

export function usageStats(threads) {
  const report = { ...totals(), sessions: 0, measured: 0, partial: 0, assistants: [], models: [], repos: [], limits: [] }
  const assistants = new Map(), models = new Map(), repos = new Map(), limits = new Map(), seen = new Set()
  const group = (map, id, label) => {
    if (!map.has(id)) map.set(id, { id, label, ...totals(), sessions: 0, measured: 0 })
    return map.get(id)
  }
  for (const thread of threads) {
    // An errand is part of its parent's session, not a session of its own.
    if (seen.has(thread.id) || thread.parentId) continue
    seen.add(thread.id)
    report.sessions++
    const u = thread.usage
    const assistant = group(assistants, thread.harness || 'unknown', thread.harnessName || 'Other agents')
    const repo = group(repos, thread.project || 'Unknown repo', thread.project || 'Unknown repo')
    assistant.sessions++; repo.sessions++
    if (u?.known) {
      report.measured++; assistant.measured++; repo.measured++
      if (u.coverage === 'partial') report.partial++
      sum(report, u); sum(assistant, u); sum(repo, u)
      for (const row of u.byModel || []) {
        const model = group(models, `${thread.harness}:${row.model}`, row.model)
        model.assistant = assistant.label; model.sessions++; model.measured++
        sum(model, row)
      }
    }
    for (const limit of u?.limits || []) {
      const key = `${thread.harness}:${limit.id}`
      if (!limits.has(key) || limits.get(key).observedAt < limit.observedAt) {
        limits.set(key, { ...limit, assistant: assistant.label })
      }
    }
  }
  const sorted = map => [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label))
  report.assistants = sorted(assistants); report.models = sorted(models); report.repos = sorted(repos)
  report.limits = [...limits.values()]
  return report
}

/** Expired windows cannot be treated as refilled; only a fresh provider report can tell us. */
export function allowanceWindow(window, observedAt, now = Date.now()) {
  const expired = !window.resetsAt || window.resetsAt <= now
  const stale = now - observedAt > 15 * 60 * 1000
  return { expired, stale, remainingPercent: expired ? null : Math.max(0, Math.min(100, 100 - window.usedPercent)) }
}

export function contextRemaining(context) {
  if (!context || n(context.windowTokens) <= 0) return null
  return { remaining: Math.max(0, context.windowTokens - n(context.usedTokens)),
    percent: Math.max(0, Math.min(100, 100 * (1 - n(context.usedTokens) / context.windowTokens))) }
}
