/**
 * The Models answer is read from the crew's files, and every one of them may be missing, empty or
 * stale. These tests pin what the phone sees in each case, and that the answer stays small.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { modelLabel, parseFreeList, readModels } from '../server/lib/models.mjs'

const NOW = 1_794_290_000
const HOUR = 3600

// The list as setup-bots.py writes it: tuples, comments between them, one trailing comment.
const SETUP_BOTS = `import json
FREE = [('opencode/deepseek-v4.1-flash-free', 'deepseek', 'strong'),
        ('opencode/glm-5.3-flash-free', 'glm', 'strong'),
        # NVIDIA's free tier on the owner's key: 40 requests a minute.
        ('nvidia/nvidia/nemotron-3-ultra-550b-a55b', 'nemotron', 'strong'),
        ('openrouter/cohere/north-mini-code:free', 'cohere', 'strong'),
        # Small or unknown models: they passed our test, but long agent work needs more than that.
        ('opencode/flint-40b-free', 'flint', 'light'),
        ('opencode/beam-free', 'beam', 'light')]
# Groq is left out: its free tokens-per-minute is smaller than one OpenCode request.
FRED, FREYA = 'Fred The Builder', 'Freya The Checker'
`

const AGENTS = [
  { id: 'tony', name: 'Tony', status: 'idle', model: 'claude-sonnet-5-5', adapter: 'claude_local' },
  { id: 'fred', name: 'Fred The Builder', status: 'running', model: 'opencode/deepseek-v4.1-flash-free', adapter: 'opencode_local' },
  { id: 'critic', name: 'Critic', status: 'paused', model: 'gpt-6.1-sol', adapter: 'codex_local' },
]

function crew(files = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-crew-'))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(folder, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return folder
}

const read = (folder, extra = {}) => readModels({ folder, agents: async () => AGENTS, now: NOW, ...extra })

test('the FREE list is parsed from the file as written, comments and all', () => {
  const rows = parseFreeList(SETUP_BOTS)
  assert.deepEqual(rows.map((r) => [r.model, r.family, r.tier]), [
    ['opencode/deepseek-v4.1-flash-free', 'deepseek', 'strong'],
    ['opencode/glm-5.3-flash-free', 'glm', 'strong'],
    ['nvidia/nvidia/nemotron-3-ultra-550b-a55b', 'nemotron', 'strong'],
    ['openrouter/cohere/north-mini-code:free', 'cohere', 'strong'],
    ['opencode/flint-40b-free', 'flint', 'light'],
    ['opencode/beam-free', 'beam', 'light'],
  ])
})

test('a FREE list of another shape is refused, not misread', () => {
  assert.throws(() => parseFreeList('FRED = 1\n'), /no FREE list/)
  assert.throws(() => parseFreeList("FREE = [('a/b-free', 'b', 'strong', 'extra')]\n"), /not \(model, family, tier\)/)
  assert.throws(() => parseFreeList("FREE = [('a/b-free', 'b', 'medium')]\n"), /not \(model, family, tier\)/)
  assert.throws(() => parseFreeList("FREE = [{'model': 'a/b-free'}]\n"), /not a list of/)
  assert.throws(() => parseFreeList('FREE = [\n'), /never closes/)
  assert.throws(() => parseFreeList("FREE = [('a/b-free', 'b', 'strong'), MORE]\n"), /not a list of/)
})

test('model ids become plain names the owner can read', () => {
  assert.equal(modelLabel('opencode/deepseek-v4.1-flash-free'), 'DeepSeek V4.1 Flash, free')
  assert.equal(modelLabel('openrouter/cohere/north-mini-code:free'), 'North Mini Code, free via OpenRouter')
  assert.equal(modelLabel('nvidia/nvidia/nemotron-3-ultra-550b-a55b'), 'Nemotron 3 Ultra 550B A55B via NVIDIA')
  assert.equal(modelLabel('claude-sonnet-5-5'), 'Sonnet 5.5')
  assert.equal(modelLabel('gpt-6.1-sol'), 'GPT 6.1 Sol')
  assert.equal(modelLabel('gemini-3.8-flash-high'), 'Gemini 3.8 Flash High')
  assert.equal(modelLabel(''), 'Unknown model')
})

test('a model set aside stays aside only until its time, then counts by its last good check', async () => {
  const folder = crew({
    'setup-bots.py': SETUP_BOTS,
    'free-out.json': {
      'opencode/deepseek-v4.1-flash-free': { until: NOW - 60, error: 'did not answer' },
      'opencode/glm-5.3-flash-free': { until: NOW + HOUR, error: 'did not answer: its free limit, or the offer ended' },
    },
    'free-ok.json': { 'opencode/deepseek-v4.1-flash-free': NOW - 600, 'opencode/glm-5.3-flash-free': NOW - 7200 },
  })
  const { free, health } = await read(folder)
  const deepseek = free.find((m) => m.family === 'deepseek')
  const glm = free.find((m) => m.family === 'glm')
  assert.equal(deepseek.state, 'answering')
  assert.equal(deepseek.checkedAt, NOW - 600)
  assert.equal(deepseek.until, undefined)
  assert.equal(free.find((m) => m.state === 'unchecked').checkedAt, undefined)
  assert.equal(glm.state, 'aside')
  assert.equal(glm.until, NOW + HOUR)
  assert.equal(glm.why, 'did not answer: its free limit, or the offer ended')
  // Answering first, then never checked, then set aside.
  assert.deepEqual(free.map((m) => m.state), ['answering', 'unchecked', 'unchecked', 'unchecked', 'unchecked', 'aside'])
  assert.equal(health.tone, 'warn')
  assert.match(health.text, /^Mostly fine: 1 of 6 free models answer \(4 not checked yet\), 1 set aside\.$/)
})

test('with every file missing the answer still stands, and says the free list is not there', async () => {
  const answer = await read(crew())
  assert.equal(answer.freeListError, 'The free model list is not on this machine')
  assert.deepEqual(answer.free, [])
  assert.deepEqual(answer.switches, [])
  assert.deepEqual(answer.scout, [])
  assert.deepEqual(answer.subscriptions.thinking, { on: 'codex', since: null, back: null, onClaude: [] })
  assert.deepEqual(answer.subscriptions.antigravityUsedUp, [])
  assert.equal(answer.subscriptions.claude, null)
  assert.equal(answer.health.text, 'All good.')
  // Working bots first, then ready, then resting.
  assert.deepEqual(answer.bots.map((b) => [b.name, b.label, b.where, b.free]), [
    ['Fred The Builder', 'DeepSeek V4.1 Flash, free', 'free', true],
    ['Tony', 'Sonnet 5.5', 'Claude', false],
    ['Critic', 'GPT 6.1 Sol', 'Codex', false],
  ])
  assert.equal(answer.limits.length, 3)
})

test('a list of another shape is reported, and broken state files count as empty', async () => {
  const folder = crew({ 'setup-bots.py': "FREE = [('a/b-free', 'b', 'strong', 'extra')]\n", 'free-ok.json': '{not json', 'free-out.json': '[]', 'fallback.log': '\n\n' })
  const answer = await read(folder)
  assert.match(answer.freeListError, /not \(model, family, tier\)/)
  assert.deepEqual(answer.free, [])
  assert.deepEqual(answer.switches, [])
})

test('the scout\'s finds join the list once, and a model that keeps failing checks drops to light', async () => {
  const folder = crew({
    'setup-bots.py': SETUP_BOTS,
    'free-found.json': [['opencode/minimax-m3.1-flash-free', 'minimax', 'strong'], ['opencode/glm-5.3-flash-free', 'glm', 'strong'], ['bad'], 'junk'],
    'free-scores.json': { 'opencode/deepseek-v4.1-flash-free': { pass: 1, fail: 2 }, 'opencode/glm-5.3-flash-free': { pass: 1, fail: 1 } },
  })
  const { free } = await read(folder)
  assert.equal(free.length, 7)
  const minimax = free.find((m) => m.family === 'minimax')
  assert.equal(minimax.found, true)
  assert.equal(minimax.tier, 'strong')
  const deepseek = free.find((m) => m.family === 'deepseek')
  assert.deepEqual([deepseek.tier, deepseek.demoted, deepseek.pass, deepseek.fail], ['light', true, 1, 2])
  const glm = free.find((m) => m.family === 'glm')
  assert.deepEqual([glm.tier, glm.demoted], ['strong', undefined])
})

test('switches read newest first with their time, and show model names instead of ids', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `2026-11-${String(1 + Math.floor(i / 10)).padStart(2, '0')} 0${i % 10}:15 line ${i}`)
  const folder = crew({
    'setup-bots.py': SETUP_BOTS,
    'fallback.log': `${lines.join('\n')}\n2026-11-10 01:21 Fred moved from opencode/deepseek-v4.1-flash-free to opencode/glm-5.3-flash-free\n`,
    'free-scout.log': 'no time on this line\n',
  })
  const { switches, scout } = await read(folder)
  assert.equal(switches.length, 15)
  assert.equal(switches[0].text, 'Fred moved from DeepSeek V4.1 Flash, free to GLM 5.3 Flash, free')
  assert.equal(switches[0].at, Math.floor(new Date(2026, 10, 10, 1, 21).getTime() / 1000))
  assert.equal(switches[1].text, 'line 19')
  assert.deepEqual(scout, [{ at: null, text: 'no time on this line' }])
})

test('the subscriptions say where the thinking bots are and what is used up', async () => {
  const folder = crew({
    'setup-bots.py': SETUP_BOTS,
    'thinker.json': { on: 'gemini', back: NOW + 3 * HOUR, moved: NOW - HOUR, claude: ['Tony', 7] },
    'agy-used-up.json': { 'gemini-3.8-flash-high': NOW + HOUR, 'claude-opus-4-6-thinking': NOW - 1 },
    'free-ok.json': { 'opencode/deepseek-v4.1-flash-free': NOW - 10 },
  })
  const plans = { claude: { week: 0.93, resets: NOW + 86_400 }, codex: { week: 1, fiveHours: 0, resets: NOW + 3 * HOUR, fiveHoursResets: null }, backup: { until: NOW + 3 * HOUR } }
  const { subscriptions, health } = await read(folder, { plans })
  assert.deepEqual(subscriptions.thinking, { on: 'gemini', since: NOW - HOUR, back: NOW + 3 * HOUR, onClaude: ['Tony'] })
  assert.deepEqual(subscriptions.antigravityUsedUp.map((m) => m.label), ['Gemini 3.8 Flash High'])
  assert.equal(subscriptions.claude.week, 0.93)
  assert.equal(subscriptions.codex.fiveHours, 0)
  assert.equal(health.tone, 'warn')
  assert.match(health.text, /^Mostly fine: 1 of 6 free models answer \(5 not checked yet\), Codex is out until \w{3},? \d\d:\d\d, Antigravity is used up, Tony on Sonnet 5\.5, Claude is at 93% of its week\.$/)
})

test('every free model set aside, or a bot in trouble, reads as stuck', async () => {
  const folder = crew({
    'setup-bots.py': "FREE = [('opencode/a-free', 'a', 'strong'), ('opencode/b-free', 'b', 'strong')]\n",
    'free-out.json': { 'opencode/a-free': { until: NOW + 2 * HOUR, error: 'x' }, 'opencode/b-free': { until: NOW + HOUR, error: 'y' } },
  })
  const stuck = await read(folder)
  assert.equal(stuck.health.tone, 'bad')
  assert.match(stuck.health.text, /^Something is stuck: 0 of 2 free models answer, every free model is set aside, the first is back at \w{3},? \d\d:\d\d\.$/)
  const trouble = await read(crew({ 'setup-bots.py': SETUP_BOTS }), { agents: async () => [{ ...AGENTS[0], status: 'error' }] })
  assert.equal(trouble.health.tone, 'bad')
  assert.match(trouble.health.text, /^Something is stuck: Tony in trouble, 0 of 6 free models answer \(6 not checked yet\)\.$/)
})

test('the answer stays under 20 KB with a long free list, a full crew and full logs', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `('openrouter/maker-${i}/some-long-model-name-${i}-preview:free', 'maker${i}', 'strong')`)
  const line = (i) => `2026-11-10 ${String(i % 24).padStart(2, '0')}:00 Fred moved from openrouter/maker-1/some-long-model-name-1-preview:free to openrouter/maker-2/some-long-model-name-2-preview:free because it did not answer in time`
  const folder = crew({
    'setup-bots.py': `FREE = [${many.join(',\n')}]\n`,
    'free-out.json': Object.fromEntries(many.map((_, i) => [`openrouter/maker-${i}/some-long-model-name-${i}-preview:free`, { until: NOW + HOUR, error: 'did not answer: its free limit, or the offer ended' }])),
    'free-scores.json': Object.fromEntries(many.map((_, i) => [`openrouter/maker-${i}/some-long-model-name-${i}-preview:free`, { pass: 3, fail: 4 }])),
    'free-ok.json': Object.fromEntries(many.map((_, i) => [`openrouter/maker-${i}/some-long-model-name-${i}-preview:free`, NOW])),
    'fallback.log': Array.from({ length: 300 }, (_, i) => line(i)).join('\n'),
    'free-scout.log': Array.from({ length: 300 }, (_, i) => line(i)).join('\n'),
    'agy-used-up.json': Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`gemini-3.8-flash-level-${i}`, NOW + HOUR])),
    'thinker.json': { on: 'gemini', back: NOW + HOUR, moved: NOW, claude: ['Tony', 'Planner', 'Critic', 'Scout', 'Clerk'] },
  })
  const agents = async () => Array.from({ length: 12 }, (_, i) => ({ id: `bot-${i}`, name: `Bot number ${i}`, status: 'running', model: `openrouter/maker-${i}/some-long-model-name-${i}-preview:free`, adapter: 'opencode_local' }))
  const answer = await read(folder, { agents, plans: { claude: { week: 0.5, resets: NOW }, codex: { week: 0.5, fiveHours: 0.5, resets: NOW, fiveHoursResets: NOW }, backup: null } })
  assert.equal(answer.free.length, 40)
  assert.equal(answer.switches.length, 15)
  assert.equal(answer.scout.length, 10)
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) < 20 * 1024, `${Buffer.byteLength(JSON.stringify(answer))} bytes`)
})
