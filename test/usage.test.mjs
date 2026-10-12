import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readRecordedUsage, vscodeUsage } from '../server/lib/usage.mjs'
import { usageStats, allowanceWindow, contextRemaining } from '../src/ui/usage.js'

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const at = '2026-10-12T12:00:00Z'
const assistant = (id, model, input, output, cache = 0, write = 0) => ({ type: 'assistant', timestamp: at,
  message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cache, cache_creation_input_tokens: write } } })
const count = (input, output, cached = 0, limits = null) => ({ type: 'event_msg', timestamp: at,
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
    last_token_usage: { total_tokens: 60 }, model_context_window: 200 }, rate_limits: limits } })
async function fixture(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atrium-usage-'))
  try { await fn(path.join(dir, 'session.jsonl')) }
  finally { await fsp.rm(dir, { recursive: true, force: true }) }
}

test('Claude usage deduplicates streaming message IDs, includes cache once and attributes model switches', async () => {
  await fixture(async file => {
    await fsp.writeFile(file, jsonl([assistant('1', 'model-a', 5, 2, 20, 3), assistant('1', 'model-a', 5, 9, 20, 3),
      assistant('2', 'model-b', 10, 4), assistant('synthetic', '<synthetic>', 0, 0)]))
    const u = await readRecordedUsage(file, 'claude')
    assert.equal(u.inputTokens, 38); assert.equal(u.outputTokens, 13); assert.equal(u.totalTokens, 51)
    assert.equal(u.cachedInputTokens, 20); assert.equal(u.cacheWriteTokens, 3)
    assert.deepEqual(u.byModel.map(m => [m.model, m.totalTokens]), [['model-a', 37], ['model-b', 14]])
    assert.deepEqual(await readRecordedUsage(file, 'claude'), u)
    assert.equal((await readRecordedUsage(file, 'codex')).known, false, 'kind isolates cached interpretations')
  })
})

test('incremental usage preserves incomplete appends, concurrent reads and resets after a larger rewrite', async () => {
  await fixture(async file => {
    await fsp.writeFile(file, jsonl([assistant('1', 'm', 10, 5)]))
    const original = await readRecordedUsage(file, 'claude')
    const line = JSON.stringify(assistant('2', 'm', 20, 10))
    await fsp.appendFile(file, line.slice(0, 40))
    assert.equal((await readRecordedUsage(file, 'claude')).totalTokens, 15)
    await fsp.appendFile(file, line.slice(40) + '\n{broken}\n')
    const [a, b] = await Promise.all([readRecordedUsage(file, 'claude'), readRecordedUsage(file, 'claude')])
    assert.equal(a.totalTokens, 45); assert.deepEqual(a, b)
    assert.equal(original.totalTokens, 15, 'earlier snapshots are immutable')
    await fsp.writeFile(file, jsonl([{ padding: 'x'.repeat(1000) }, assistant('3', 'new', 7, 3)]))
    assert.equal((await readRecordedUsage(file, 'claude')).totalTokens, 10)
    await fsp.writeFile(file, jsonl([assistant('4', 'short', 1, 1)]))
    assert.equal((await readRecordedUsage(file, 'claude')).totalTokens, 2)
  })
})

test('chunk boundaries and UTF-8 do not lose an assistant usage record', async () => {
  await fixture(async file => {
    const row = assistant('1', 'Modèle', 12, 8)
    row.padding = '🙂'.repeat(140000)
    await fsp.writeFile(file, jsonl([row]))
    assert.equal((await readRecordedUsage(file, 'claude')).totalTokens, 20)
  })
})

test('Codex cumulative usage is counted once with per-model deltas and independent allowance buckets', async () => {
  await fixture(async file => {
    const limit = { limit_id: 'codex', primary: { used_percent: 34, window_minutes: 300, resets_at: 1791807000 } }
    await fsp.writeFile(file, jsonl([{ type: 'turn_context', payload: { model: 'a' } }, count(100, 20, 40, limit), count(100, 20, 40),
      { type: 'turn_context', payload: { model: 'b' } }, count(150, 30, 60),
      { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', primary: { used_percent: 10, window_minutes: 10080, resets_at: 1792407000 } } } }]))
    const u = await readRecordedUsage(file, 'codex')
    assert.equal(u.totalTokens, 180); assert.equal(u.cachedInputTokens, 60)
    assert.deepEqual(u.byModel.map(m => [m.model, m.totalTokens]), [['a', 120], ['b', 60]])
    assert.equal(u.limits.length, 2); assert.equal(u.context.windowTokens, 200)
    assert.equal(contextRemaining(u.context).remaining, 140)
    await fsp.appendFile(file, jsonl([count(20, 2, 5)]))
    assert.equal((await readRecordedUsage(file, 'codex')).totalTokens, 202, 'reset begins a new segment')
  })
})

test('VS Code uses whole-turn model totals and labels latest-call input totals as partial', () => {
  const u = vscodeUsage([{ modelId: 'auto', promptTokens: 900, completionTokens: 9, responseTimestamp: 1,
    modelTotals: [{ model: 'local-a', inputTokens: 100, cachedTokens: 20, outputTokens: 10 }, { model: 'local-b', inputTokens: 50, cachedTokens: 0, outputTokens: 5 }],
    contextUsage: { currentTokens: 80, tokenLimit: 200 }, sessionCopilotCredits: 0.5 },
    { modelId: 'local-a', promptTokens: 30, completionTokens: 4, responseTimestamp: 2, sessionCopilotCredits: 0.8 }])
  assert.equal(u.totalTokens, 199); assert.equal(u.cachedInputTokens, 20)
  assert.equal(u.coverage, 'partial'); assert.equal(u.copilotCredits, 0.8)
  assert.equal(vscodeUsage([{}]).known, false)
  assert.equal(contextRemaining(u.context).remaining, 120)
})

test('office stats include unknown assistants, deduplicate sessions and choose latest limits instead of summing them', () => {
  const u = vscodeUsage([{ modelId: 'local', promptTokens: 30, completionTokens: 4 }])
  const make = (id, at) => ({ id, harness: 'test', harnessName: 'Test', project: 'repo', usage: { ...u,
    limits: [{ id: 'shared', observedAt: at, windows: [{ usedPercent: at, resetsAt: 300, windowMinutes: 300 }] }] } })
  const threads = [make('1', 10), make('2', 20), { id: '3', harness: 'other', harnessName: 'Other', project: 'repo2' }]
  const report = usageStats([...threads, threads[0]])
  assert.equal(report.totalTokens, 68); assert.equal(report.measured, 2); assert.equal(report.sessions, 3)
  assert.equal(report.models[0].totalTokens, 68); assert.equal(report.repos.length, 2)
  assert.equal(report.assistants.find(a => a.id === 'other').measured, 0)
  assert.equal(report.limits.length, 1); assert.equal(report.limits[0].windows[0].usedPercent, 20)
})

test('expired allowances remain unknown; older snapshots are marked stale, never reset to 100%', () => {
  const now = Date.parse(at)
  assert.deepEqual(allowanceWindow({ usedPercent: 34, resetsAt: now + 1000 }, now, now), { expired: false, stale: false, remainingPercent: 66 })
  assert.equal(allowanceWindow({ usedPercent: 100, resetsAt: now - 1 }, now - 1000, now).remainingPercent, null)
  assert.equal(allowanceWindow({ usedPercent: 34, resetsAt: now + 1000 }, now - 3600000, now).stale, true)
  assert.equal(contextRemaining(null), null)
})

test('errands never count their parent session again', async () => {
  const { withErrands } = await import('../src/game/errands.js')
  const usage = { known: true, inputTokens: 100, outputTokens: 50, totalTokens: 150, byModel: [{ model: 'm', inputTokens: 100, outputTokens: 50, totalTokens: 150 }] }
  const list = withErrands([{ id: 'p', harness: 'claude-code', project: 'r', usage, subagents: [{ id: 'a', task: 'x' }, { id: 'b', task: 'y' }] }])
  assert.equal(list.length, 3)
  assert.ok(list.slice(1).every((t) => t.usage === null))
  const report = usageStats(list)
  assert.equal(report.totalTokens, 150)
  assert.equal(report.sessions, 1)
})
