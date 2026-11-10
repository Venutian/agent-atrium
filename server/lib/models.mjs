/**
 * What runs on which model, for the app's Models screen.
 *
 * Read-only. It reads the files the crew's own scripts keep in ~/.paperclip/ngen (which free model
 * answered last, which is set aside and why, where the thinking bots run, the switch logs) and asks
 * Paperclip which model each bot is on. No model is called, and nothing is written. The free list
 * itself lives in setup-bots.py; it is parsed here rather than run, because the door must not
 * execute crew code and the list is plain tuples. The parser refuses anything but that shape, so a
 * change to the list's form shows up as a test failure instead of an empty screen.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SHOWN_SWITCHES = 15
const SHOWN_SCOUT = 10
const TUPLE = /^\(\s*'([^'\s]+)'\s*,\s*'([^'\s]+)'\s*,\s*'(strong|light)'\s*\)$/
const LOG_LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (.*)$/

/** Known facts about each free provider's limits, as text: none of them publish live counters. */
export const PROVIDER_LIMITS = [
  { provider: 'OpenCode Zen free models', note: 'No key needed. Limits are not published; a model over its limit stops answering until it is tried again an hour later.' },
  { provider: 'OpenRouter free models', note: '1,000 requests a day, shared by every model on the key.' },
  { provider: 'NVIDIA', note: '40 requests a minute on the key.' },
]

const WHERE = { claude_local: 'Claude', codex_local: 'Codex', gemini_local: 'Antigravity', opencode_local: 'free' }
const WORDS = {
  deepseek: 'DeepSeek', glm: 'GLM', gpt: 'GPT', mimo: 'MiMo', longcat: 'LongCat', minimax: 'MiniMax', vl: 'VL',
  oss: 'OSS', ai: 'AI', agi: 'AGI', it: 'IT', north: 'North',
}
const PROVIDERS = { openrouter: 'OpenRouter', nvidia: 'NVIDIA', opencode: '' }

export const crewFolder = (env = process.env) => env.NGEN_CREW_FOLDER || path.join(os.homedir(), '.paperclip', 'ngen')

function readJson(file, empty) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value === null || typeof value !== typeof empty || Array.isArray(value) !== Array.isArray(empty) ? empty : value
  } catch {
    return empty
  }
}

/**
 * The FREE list in setup-bots.py: `FREE = [('model', 'family', 'strong'|'light'), ...]` with
 * comments between. Throws on any other shape, so the door says so rather than showing nothing.
 */
export function parseFreeList(source) {
  const start = /^FREE = \[/m.exec(source)
  if (!start) throw new Error('setup-bots.py has no FREE list')
  const rest = source.slice(start.index + start[0].length)
  const end = rest.indexOf(']')
  if (end < 0) throw new Error('the FREE list never closes')
  const body = rest.slice(0, end).split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean).join(' ')
  const tuples = body.match(/\([^()]*\)/g) || []
  const leftover = body.replace(/\([^()]*\)/g, '').replace(/[\s,]/g, '')
  if (!tuples.length || leftover) throw new Error('the FREE list is not a list of (model, family, tier) tuples')
  return tuples.map((tuple) => {
    const match = TUPLE.exec(tuple)
    if (!match) throw new Error(`the FREE list has an entry that is not (model, family, tier): ${tuple}`)
    return { model: match[1], family: match[2], tier: match[3] }
  })
}

/** 'opencode/deepseek-v4.1-flash-free' as "DeepSeek V4.1 Flash, free"; 'claude-sonnet-5-5' as "Sonnet 5.5". */
export function modelLabel(id) {
  if (typeof id !== 'string' || !id) return 'Unknown model'
  const parts = id.split('/')
  const provider = parts.length > 1 ? PROVIDERS[parts[0]] ?? parts[0] : ''
  let name = parts[parts.length - 1]
  let free = false
  if (name.endsWith(':free')) {
    free = true
    name = name.slice(0, -5)
  }
  if (name.endsWith('-free')) {
    free = true
    name = name.slice(0, -5)
  }
  const words = []
  for (const raw of name.split('-')) {
    if (!raw || (raw === 'claude' && words.length === 0)) continue
    const last = words[words.length - 1]
    if (/^\d+$/.test(raw) && last && /^\d+(\.\d+)*$/.test(last)) {
      words[words.length - 1] = `${last}.${raw}`
      continue
    }
    if (WORDS[raw]) words.push(WORDS[raw])
    else if (/^v\d/.test(raw)) words.push(raw.toUpperCase())
    else if (/^\d+[a-z]\d*[a-z]?$/.test(raw) || /^[a-z]\d+[a-z]$/.test(raw)) words.push(raw.toUpperCase())
    else words.push(raw[0].toUpperCase() + raw.slice(1))
  }
  const base = words.join(' ') || id
  return `${base}${free ? ', free' : ''}${provider ? ` via ${provider}` : ''}`
}

/** The last lines of a log, newest first, each with its time in epoch seconds where the line has one. */
function readLog(file, count) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').filter((line) => line.trim()).slice(-count).reverse().map((line) => {
    const match = LOG_LINE.exec(line)
    if (!match) return { at: null, text: line.slice(0, 160) }
    const [, y, mo, d, h, mi, rest] = match
    return { at: Math.floor(new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime() / 1000), text: rest.slice(0, 160) }
  })
}

const clock = (stamp) => new Date(stamp * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** Replaces every model id in a log line with its label, so the phone shows no internal names. */
function plain(text, labels) {
  let out = text
  for (const [id, label] of labels) out = out.split(id).join(label)
  return out
}

function freeModels({ folder, now, listed }) {
  const found = readJson(path.join(folder, 'free-found.json'), [])
    .filter((row) => Array.isArray(row) && row.length === 3 && row.every((v) => typeof v === 'string'))
    .filter((row) => !listed.some((r) => r.model === row[0]))
    .map(([model, family, tier]) => ({ model, family, tier: tier === 'light' ? 'light' : 'strong', found: true }))
  const scores = readJson(path.join(folder, 'free-scores.json'), {})
  const ok = readJson(path.join(folder, 'free-ok.json'), {})
  const out = readJson(path.join(folder, 'free-out.json'), {})
  const ids = []
  const rows = [...listed, ...found].map((row) => {
    ids.push(row.model)
    const score = scores[row.model] && typeof scores[row.model] === 'object' ? scores[row.model] : {}
    const pass = Number(score.pass) || 0
    const fail = Number(score.fail) || 0
    const checked = pass + fail
    const demoted = checked >= 3 && pass / checked < 0.5
    const aside = out[row.model] && typeof out[row.model] === 'object' && Number(out[row.model].until) > now ? out[row.model] : null
    const checkedAt = Number(ok[row.model]) > 0 ? Math.floor(Number(ok[row.model])) : null
    return {
      label: modelLabel(row.model),
      family: row.family,
      tier: demoted ? 'light' : row.tier,
      ...(demoted ? { demoted: true } : {}),
      ...(row.found ? { found: true } : {}),
      state: aside ? 'aside' : checkedAt ? 'answering' : 'unchecked',
      ...(checkedAt ? { checkedAt } : {}),
      ...(aside ? { until: Math.floor(Number(aside.until)), why: String(aside.error || 'did not answer').slice(0, 120) } : {}),
      ...(checked ? { pass, fail } : {}),
    }
  })
  const rank = { answering: 0, unchecked: 1, aside: 2 }
  return { ids, rows: rows.map((row, index) => ({ row, index })).sort((a, b) => rank[a.row.state] - rank[b.row.state] || a.index - b.index).map(({ row }) => row) }
}

function subscriptions({ folder, plans, now }) {
  const thinker = readJson(path.join(folder, 'thinker.json'), {})
  const usedUp = readJson(path.join(folder, 'agy-used-up.json'), {})
  return {
    claude: plans?.claude ?? null,
    codex: plans?.codex ?? null,
    backup: plans?.backup ?? null,
    thinking: {
      on: thinker.on === 'gemini' ? 'gemini' : 'codex',
      since: Number(thinker.moved) > 0 ? Math.floor(Number(thinker.moved)) : null,
      back: Number(thinker.back) > 0 ? Math.floor(Number(thinker.back)) : null,
      onClaude: Array.isArray(thinker.claude) ? thinker.claude.filter((n) => typeof n === 'string').slice(0, 20) : [],
    },
    antigravityUsedUp: Object.entries(usedUp)
      .filter(([model, until]) => typeof model === 'string' && Number(until) > now)
      .map(([model, until]) => ({ label: modelLabel(model), until: Math.floor(Number(until)) })),
  }
}

/** One sentence a first-time reader can act on: what is stuck, and why. */
function health({ bots, free, plans, now }) {
  const answering = free.filter((m) => m.state === 'answering')
  const aside = free.filter((m) => m.state === 'aside')
  const parts = []
  let tone = 'good'
  const troubled = bots.filter((b) => b.status === 'error')
  if (troubled.length) {
    tone = 'bad'
    parts.push(`${troubled.map((b) => b.name).join(' and ')} in trouble`)
  }
  if (free.length) {
    const unchecked = free.length - answering.length - aside.length
    // Only a model Fred or Freya ran on gets checked, so most of the list is never tried: say so.
    parts.push(`${answering.length} of ${free.length} free models answer${unchecked ? ` (${unchecked} not checked yet)` : ''}`)
    if (aside.length === free.length) {
      tone = 'bad'
      const back = Math.min(...aside.map((m) => m.until))
      parts.push(`every free model is set aside, the first is back at ${clock(back)}`)
    } else if (aside.length) {
      if (tone === 'good') tone = 'warn'
      parts.push(`${aside.length} set aside`)
    }
  }
  if (plans.thinking.on === 'gemini') {
    if (tone === 'good') tone = 'warn'
    parts.push(plans.thinking.back ? `Codex is out until ${clock(plans.thinking.back)}` : 'Codex is out')
    if (plans.antigravityUsedUp.length) parts.push('Antigravity is used up')
    for (const name of plans.thinking.onClaude) {
      const bot = bots.find((b) => b.name === name)
      if (bot) parts.push(`${name} on ${bot.label}`)
    }
  }
  for (const [name, plan] of [['Claude', plans.claude], ['Codex', plans.codex]]) {
    // Codex at 100% is already said above as "Codex is out".
    if (plan && plan.week >= 0.9 && !(name === 'Codex' && plans.thinking.on === 'gemini')) {
      if (tone === 'good') tone = 'warn'
      parts.push(`${name} is at ${Math.round(plan.week * 100)}% of its week`)
    }
  }
  const lead = tone === 'good' ? 'All good' : tone === 'warn' ? 'Mostly fine' : 'Something is stuck'
  return { tone, text: parts.length ? `${lead}: ${parts.join(', ')}.` : `${lead}.`, at: now }
}

/**
 * The whole answer for GET /v1/models. `agents` is a function that lists Paperclip's agents with
 * their models, `plans` what readPlans() gives. Every file may be missing: each part then shows
 * less, and the free list says why when it cannot be read.
 */
export async function readModels({ folder = crewFolder(), agents, plans = null, now = Math.floor(Date.now() / 1000) } = {}) {
  let listed = []
  let freeListError = null
  try {
    listed = parseFreeList(fs.readFileSync(path.join(folder, 'setup-bots.py'), 'utf8'))
  } catch (err) {
    freeListError = err.code === 'ENOENT' ? 'The free model list is not on this machine' : err.message
  }
  const { ids, rows: free } = freeModels({ folder, now, listed })
  const freeIds = new Set(ids)
  const agentList = await agents()
  const order = { error: 0, running: 1, idle: 2, paused: 3 }
  const bots = [...agentList].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4) || String(a.name).localeCompare(String(b.name))).map((a) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    label: modelLabel(a.model),
    where: WHERE[a.adapter] || 'Other',
    free: freeIds.has(a.model) || a.adapter === 'opencode_local',
  }))
  const subs = subscriptions({ folder, plans, now })
  // The phone shows names, never ids: the log lines get the same names, longest ids first so none is cut in half.
  const known = [...ids, ...agentList.map((a) => a.model), ...Object.keys(readJson(path.join(folder, 'agy-used-up.json'), {}))]
  const labels = [...new Set(known.filter(Boolean))].map((id) => [id, modelLabel(id)]).sort((a, b) => b[0].length - a[0].length)
  const tidy = (line) => ({ ...line, text: plain(line.text, labels) })
  return {
    health: health({ bots, free, plans: subs, now }),
    bots,
    subscriptions: subs,
    free,
    freeListError,
    switches: readLog(path.join(folder, 'fallback.log'), SHOWN_SWITCHES).map(tidy),
    scout: readLog(path.join(folder, 'free-scout.log'), SHOWN_SCOUT).map(tidy),
    limits: PROVIDER_LIMITS,
    at: now,
  }
}
