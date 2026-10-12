/** Recorded usage only. No credentials, provider requests, pricing guesses or text estimates. */
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'

const cache = new Map()
const pending = new Map()
export const tokenNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const n = value => tokenNumber(value) ?? 0
const modelName = value => typeof value === 'string' && value && !value.startsWith('<') ? value.slice(0, 160) : 'Unknown model'
const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
const empty = () => Object.fromEntries(fields.map(k => [k, 0]))

export function tokenTotals(inputTokens, outputTokens, cachedInputTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0) {
  return { inputTokens: n(inputTokens), outputTokens: n(outputTokens), cachedInputTokens: n(cachedInputTokens),
    cacheWriteTokens: n(cacheWriteTokens), reasoningTokens: n(reasoningTokens), totalTokens: n(inputTokens) + n(outputTokens) }
}

function add(state, model, tokens, at = 0) {
  const key = modelName(model)
  const row = state.models.get(key) || { model: key, ...empty() }
  for (const k of fields) row[k] += tokens[k] || 0
  state.models.set(key, row)
  state.known = true
  if (at > 0) {
    state.days ??= new Map()
    const day = new Date(at).toISOString().slice(0, 10)
    const dayKey = `${day}:${key}`
    const daily = state.days.get(dayKey) || { day, model: key, ...empty() }
    for (const k of fields) daily[k] += tokens[k] || 0
    state.days.set(dayKey, daily)
  }
}

function limitsOf(raw, observedAt) {
  if (!raw || !observedAt) return null
  const windows = []
  for (const key of ['primary', 'secondary']) {
    const w = raw[key]
    if (tokenNumber(w?.used_percent) === null || tokenNumber(w?.window_minutes) === null) continue
    windows.push({ label: key, usedPercent: Math.min(100, w.used_percent), windowMinutes: w.window_minutes,
      resetsAt: tokenNumber(w.resets_at) === null ? null : w.resets_at * 1000 })
  }
  if (!windows.length) return null
  return { id: typeof raw.limit_id === 'string' ? raw.limit_id.slice(0, 100) : 'codex',
    name: typeof raw.limit_name === 'string' ? raw.limit_name.slice(0, 100) : '', observedAt, windows }
}

function consume(state, kind, r) {
  const at = Date.parse(r.timestamp || '') || 0
  if (kind === 'claude') {
    const m = r.type === 'assistant' ? r.message : null
    if (!m?.usage || typeof m.id !== 'string' || m.model?.startsWith('<')) return
    const u = m.usage
    if (tokenNumber(u.input_tokens) === null || tokenNumber(u.output_tokens) === null) return
    const tokens = tokenTotals(u.input_tokens + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens),
      u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens_details?.thinking_tokens)
    // Streaming fragments repeat one message ID. Retain the largest reported count per field.
    const previous = state.messages.get(m.id)
    const combined = { ...tokens }
    if (previous) {
      for (const k of fields) combined[k] = Math.max(combined[k], previous.tokens[k])
      add(state, previous.model, Object.fromEntries(fields.map(k => [k, -previous.tokens[k]])), previous.at)
    }
    const model = modelName(m.model)
    const messageAt = previous?.at || at
    add(state, model, combined, messageAt)
    state.messages.set(m.id, { model, tokens: combined, at: messageAt })
    state.observedAt = Math.max(state.observedAt, at)
  } else {
    const p = r.payload
    if (r.type === 'turn_context') state.model = p?.model || state.model
    if (r.type !== 'event_msg' || p?.type !== 'token_count') return
    const limit = limitsOf(p.rate_limits, at)
    if (limit) state.limits.set(limit.id, limit)
    const total = p.info?.total_token_usage
    if (total && tokenNumber(total.input_tokens) !== null && tokenNumber(total.output_tokens) !== null) {
      const tokens = tokenTotals(total.input_tokens, total.output_tokens, total.cached_input_tokens,
        total.cache_write_input_tokens, total.reasoning_output_tokens)
      const before = state.previous || empty()
      // Cumulative snapshots must never be added together. A reset starts a new segment.
      const reset = tokens.totalTokens < before.totalTokens
      const delta = Object.fromEntries(fields.map(k => [k, reset ? tokens[k] : Math.max(0, tokens[k] - before[k])]))
      add(state, state.model, delta, at)
      state.previous = tokens
      state.observedAt = Math.max(state.observedAt, at)
    }
    const last = p.info?.last_token_usage
    const window = tokenNumber(p.info?.model_context_window)
    if (last && tokenNumber(last.total_tokens) !== null && window > 0) {
      state.context = { usedTokens: last.total_tokens, windowTokens: window, observedAt: at, basis: 'last-call' }
    }
  }
}

function snapshot(state) {
  const totals = empty()
  const byModel = [...state.models.values()].map(row => ({ ...row }))
  for (const row of byModel) for (const key of fields) totals[key] += row[key]
  return { ...totals, known: state.known, byModel, byDay: [...(state.days?.values() || [])].map(row => ({ ...row })), observedAt: state.observedAt,
    coverage: state.partial ? 'partial' : 'recorded', context: state.context || null, limits: [...state.limits.values()] }
}

async function read(file, kind) {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) return null
  const key = `${kind}:${file}`
  let state = cache.get(key)
  if (state && state.mtime === stat.mtimeMs && state.size === stat.size) return snapshot(state)
  // Confirm the previous boundary still exists: truncating then rewriting a larger file
  // must reset the cache just as shrinking it does.
  let matches = true
  if (state?.anchor?.length) {
    const handle = await fsp.open(file, 'r')
    try {
      const bytes = Buffer.alloc(state.anchor.length)
      await handle.read(bytes, 0, bytes.length, state.offset - bytes.length)
      matches = bytes.equals(state.anchor)
    } finally { await handle.close() }
  }
  if (!state || !matches || stat.size < state.size || stat.ino !== state.ino || stat.size === state.size) {
    state = { offset: 0, models: new Map(), messages: new Map(), limits: new Map(), known: false,
      observedAt: 0, previous: null, context: null, model: '', partial: false }
  }
  let tail = Buffer.alloc(0), dropping = false, position = state.offset
  if (stat.size > position) {
    for await (const chunk of createReadStream(file, { start: position, end: stat.size - 1, highWaterMark: 256 * 1024 })) {
      let start = 0
      for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
        const fragment = chunk.subarray(start, i)
        if (!dropping && tail.length + fragment.length <= 16 * 1024 * 1024) {
          const line = Buffer.concat([tail, fragment]).toString('utf8')
          try { consume(state, kind, JSON.parse(line)) } catch { /* malformed or interrupted record */ }
        } else state.partial = true
        position += i - start + 1
        state.offset = position
        start = i + 1
        tail = Buffer.alloc(0); dropping = false
      }
      const fragment = chunk.subarray(start)
      position += fragment.length
      if (!dropping && tail.length + fragment.length <= 16 * 1024 * 1024) tail = Buffer.concat([tail, fragment])
      else { dropping = true; tail = Buffer.alloc(0); state.partial = true }
    }
  }
  // Partial trailing records are reread on the next append, never counted twice.
  const handle = await fsp.open(file, 'r')
  try {
    state.anchor = Buffer.alloc(Math.min(64, state.offset))
    await handle.read(state.anchor, 0, state.anchor.length, state.offset - state.anchor.length)
  } finally { await handle.close() }
  Object.assign(state, { mtime: stat.mtimeMs, size: stat.size, ino: stat.ino })
  cache.delete(key); cache.set(key, state)
  while (cache.size > 256) cache.delete(cache.keys().next().value)
  return snapshot(state)
}

export async function readRecordedUsage(file, kind) {
  if (!file) return null
  const key = `${kind}:${file}`
  if (pending.has(key)) return pending.get(key)
  const task = read(file, kind).catch(() => null).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

/** VS Code serializes latest-call input unless the provider supplies whole-turn modelTotals. */
export function vscodeUsage(requests) {
  const state = { models: new Map(), known: false, observedAt: 0, limits: new Map() }
  let credits = null
  for (const r of requests) {
    const at = Number(r.responseTimestamp) || Number(r.timestamp) || 0
    const rows = Array.isArray(r.modelTotals) ? r.modelTotals.filter(t => tokenNumber(t.inputTokens) !== null && tokenNumber(t.outputTokens) !== null) : []
    if (rows.length) for (const t of rows) add(state, t.model, tokenTotals(t.inputTokens, t.outputTokens, t.cachedTokens), at)
    else if (tokenNumber(r.promptTokens) !== null && tokenNumber(r.completionTokens) !== null) {
      add(state, r.modelId, tokenTotals(r.promptTokens, r.completionTokens), at)
      state.partial = true
    }
    if (rows.length || tokenNumber(r.promptTokens) !== null) state.observedAt = Math.max(state.observedAt, at)
    if (tokenNumber(r.sessionCopilotCredits) !== null) credits = r.sessionCopilotCredits
    const c = r.contextUsage
    if (tokenNumber(c?.currentTokens) !== null && tokenNumber(c?.tokenLimit) > 0) {
      state.context = { usedTokens: c.currentTokens, windowTokens: c.tokenLimit, observedAt: at }
    }
  }
  return { ...snapshot(state), copilotCredits: credits }
}
