/**
 * The phone door is the one part of Agent Atrium that may face another device, so most of these
 * tests are about what it refuses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { noteArrival, readAway } from '../server/lib/away.mjs'
import { signPlay } from '../server/lib/edge.mjs'
import { phoneHandler, startPhoneDoor, tokenMatches } from '../server/phone.mjs'

const TOKEN = 'a'.repeat(40)
const JOB = '11111111-2222-4333-8444-555555555555'
const APPROVAL = '66666666-7777-4888-8999-000000000000'
const BOT = '77777777-8888-4999-8aaa-111111111111'
const REQUEST = '88888888-9999-4aaa-8bbb-222222222222'
const PROJECT = '99999999-aaaa-4bbb-8ccc-333333333333'
const QUESTION = 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444'
const ROUTINE = 'bbbbbbbb-cccc-4ddd-8eee-555555555555'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

function paperclip({ calls = [], attentionDelay = 0, chatDelay = 0, summaryDelay = 0, state = {} } = {}) {
  const agents = [
    { id: 'lead', name: 'Tony', title: 'Studio director', role: 'ceo', status: 'idle', spentMonthlyCents: 120, adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5-5', cwd: '/secret', env: { KEY: 'hidden' } } },
    { id: 'bot', name: 'Scout', role: 'qa', status: 'idle', adapterType: 'codex_local', adapterConfig: { model: 'gpt-6-luna' } },
    { id: BOT, name: 'Critic', title: 'Reviewer', role: 'qa', status: 'idle', adapterType: 'codex_local', adapterConfig: { model: 'gpt-6.1-sol', cwd: '/secret' } },
  ]
  const issues = [
    { id: JOB, identifier: 'NGE-1', title: 'Fix the map', status: 'in_progress', assigneeAgentId: 'bot', lastActivityAt: '2026-11-02T10:00:00Z', companyId: 'co' },
    { id: 'two', identifier: 'NGE-2', title: 'Stuck job', status: 'blocked', assigneeAgentId: 'lead', lastActivityAt: '2026-11-02T09:00:00Z' },
    { id: 'three', identifier: 'NGE-3', title: 'Old job', status: 'done', lastActivityAt: '2026-11-01T09:00:00Z' },
  ]
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname.replace('/api', '') + new URL(url).search
    calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body) })
    // The machine running Paperclip is off: every call fails, the way it does when the service is down.
    if (state.down) throw new Error('Paperclip is not running on this machine')
    if (attentionDelay && path === '/companies/co/attention') {
      await new Promise((resolve) => setTimeout(resolve, attentionDelay))
    }
    if (chatDelay && path === '/companies/co/chats') {
      await new Promise((resolve) => setTimeout(resolve, chatDelay))
    }
    if (summaryDelay && path === '/companies/co/agents') {
      await new Promise((resolve) => setTimeout(resolve, summaryDelay))
    }
    if (path === '/companies') return json([{ id: 'co', status: 'active' }])
    if (path === '/companies/co') return json({ name: 'nGen Labs' })
    if (path === '/companies/co/agents') return json(agents)
    if (path === '/companies/co/issues' && init.method === 'POST') return json({ id: 'new', identifier: 'NGE-4' }, 201)
    if (path === '/companies/co/issues') return json(issues)
    if (path === '/companies/co/approvals?status=pending') return json([{ id: APPROVAL, type: 'hire_agent', payload: { name: 'New bot' } }])
    if (path === '/companies/co/dashboard') return json({ costs: { monthSpendCents: 321 } })
    if (path === '/companies/co/sidebar-badges') return json({ failedRuns: 1 })
    if (path === '/companies/co/projects') return json([{ id: PROJECT, name: 'Baltis', secretPath: '/secret' }])
    if (path === '/companies/co/attention') return json({ items: [{ sourceKind: 'issue_thread_interaction', whyNow: 'Waiting on you', subject: { title: 'Which map?', metadata: { issueId: JOB } } }] })
    if (path === '/companies/co/costs/window-spend') return json([{ provider: 'anthropic', window: '7d', inputTokens: 100, outputTokens: 20, cachedInputTokens: 900, costCents: 0 }])
    if (path === `/issues/${JOB}/interactions` && init.method === 'GET') {
      return json([
        { id: QUESTION, kind: 'ask_user_questions', status: 'pending', title: 'Which map?', payload: { questions: [{ id: 'size', prompt: 'Size?', selectionMode: 'multi', required: true, options: [{ id: 's', label: 'Small', description: 'Fast' }] }] } },
        { id: 'c1', kind: 'request_confirmation', status: 'pending', title: 'Ship?', payload: { prompt: 'Ship it?', acceptLabel: 'Ship', rejectLabel: 'Hold' } },
        { id: 'c2', kind: 'request_item_verdicts', status: 'pending', payload: {} },
        { id: 'c3', kind: 'request_confirmation', status: 'answered', payload: {} },
      ])
    }
    if (path === `/issues/${JOB}/live-runs`) return json([{ id: 'run1', agentId: 'bot', status: 'running' }])
    if (path === `/issues/${JOB}/attachments`) return json([{ id: QUESTION, contentType: 'image/png', originalFilename: 'hud.png' }, { id: 'x', contentType: 'application/zip' }])
    if (path === `/attachments/${QUESTION}/content`) return new Response(Buffer.from('png'), { headers: { 'Content-Type': 'image/png' } })
    if (path === `/attachments/${REQUEST}/content`) return new Response('<script>', { headers: { 'Content-Type': 'text/html' } })
    if (path === '/heartbeat-runs/run1/cancel') return json({})
    if (path.startsWith('/companies/co/heartbeat-runs')) return json([{ id: 'old', issueId: JOB, agentId: 'bot', status: 'failed', error: 'Tests failed' }])
    if (path.startsWith(`/issues/${JOB}/interactions/${QUESTION}/`)) return json({})
    if (path === `/issues/${JOB}` && init.method === 'PATCH') return json({})
    if (path === '/companies/co/routines' && init.method === 'POST') return json({ id: ROUTINE }, 201)
    if (path === '/companies/co/routines') {
      return json([
        { id: ROUTINE, title: 'Nightly tests', status: 'active', assigneeAgentId: 'bot', projectId: PROJECT, lastTriggeredAt: '2026-11-02T03:00:00Z', triggers: [{ kind: 'schedule', cronExpression: '0 3 * * *', nextRunAt: '2026-11-03T03:00:00Z' }] },
        { id: 'gone', title: 'Old', status: 'archived' },
      ])
    }
    if (path.startsWith(`/routines/${ROUTINE}`)) return json({}, init.method === 'POST' ? 201 : 200)
    if (path === `/agents/${BOT}/pause` || path === `/agents/${BOT}/resume`) return json({})
    if (path === '/companies/co/live-runs') return json([{ agentId: 'bot' }])
    if (path === `/issues/${JOB}`) return json({ ...issues[0], description: 'Details' })
    if (path === `/issues/${JOB}/comments` && init.method === 'POST') return json({ id: 'c2' }, 201)
    if (path.startsWith(`/issues/${JOB}/comments`)) return json([{ id: 'c1', authorAgentId: 'bot', body: 'Working on it' }, { id: 'c0', body: 'Please do this' }])
    if (path === `/approvals/${APPROVAL}/approve`) return json({})
    if (path === '/companies/co/chats') return json([{ id: 'chat', conversationAgentId: BOT, lastActivityAt: '2026-11-02T10:00:00Z' }])
    if (path === `/agents/${BOT}`) return json(agents[2])
    if (path === `/companies/co/chats/${BOT}`) return json({ id: 'chat', conversationState: 'active' })
    if (path.startsWith('/issues/chat/comments?limit=')) {
      return json([
        { id: 'm3', authorType: 'system', body: 'Run retried' },
        { id: 'm2', authorType: 'agent', authorAgentId: BOT, body: 'On it' },
        { id: 'm1', authorType: 'user', body: 'Review this' },
      ])
    }
    if (path === '/issues/chat/comments' && init.method === 'POST') return json({ id: 'm4' }, 201)
    return json({ error: 'nope' }, 404)
  }
  return { fetcher }
}

async function withDoor(run, { calls, away, edge, build, sessions, attentionDelay, chatDelay, summaryDelay, crew, state = {}, warm = true } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-door-'))
  if (crew) {
    fs.mkdirSync(path.join(folder, 'crew'))
    for (const [name, content] of Object.entries(crew)) fs.writeFileSync(path.join(folder, 'crew', name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  if (away) fs.writeFileSync(path.join(folder, 'away.json'), JSON.stringify(away))
  if (edge) fs.writeFileSync(path.join(folder, 'edge.json'), JSON.stringify(edge))
  if (build) {
    fs.mkdirSync(path.join(folder, 'previews', build.key, 'site'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'previews', build.key, 'manifest.json'), JSON.stringify({ job: JOB, name: 'Baltis', ok: true, builtAt: '2026-11-03T10:00:00Z' }))
  }
  const handler = phoneHandler({
    token: TOKEN,
    paperclip: paperclip({ calls, attentionDelay, chatDelay, summaryDelay, state }),
    sessions: sessions || (async () => [{ title: 'Aldis build', harness: 'claude-code', project: 'aldis' }]),
    previews: path.join(folder, 'previews'),
    devices: path.join(folder, 'devices.json'),
    guard: folder,
    away: path.join(folder, 'away.json'),
    edge: path.join(folder, 'edge.json'),
    crew: path.join(folder, 'crew'),
    plans: async () => ({ claude: { week: 0.4, resets: 1_794_589_200 }, codex: null, backup: null }),
  })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  // The door warms the phone's first screen when it starts, so wait for that: a test that counts
  // Paperclip's calls then counts only the calls it makes itself. A test that wants the cold door
  // asks for `warm: false` and gets the answer before the warm has finished.
  if (warm) await handler.warmed
  const base = `http://127.0.0.1:${server.address().port}`
  const ask = (path, { token = TOKEN, method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  try {
    await run(ask)
  } finally {
    server.close()
  }
}

test('the door will not start without a long token', () => {
  assert.throws(() => startPhoneDoor({}), /AGENT_ATRIUM_PHONE_TOKEN/)
  assert.throws(() => startPhoneDoor({ AGENT_ATRIUM_PHONE_TOKEN: 'short' }), /at least 32/)
})

test('tokenMatches needs the exact token in a bearer header', () => {
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, TOKEN), true)
  assert.equal(tokenMatches(`Bearer ${TOKEN}x`, TOKEN), false)
  assert.equal(tokenMatches(TOKEN, TOKEN), false)
  assert.equal(tokenMatches(undefined, TOKEN), false)
})

test('a missing or wrong token is refused before anything else happens', async () => {
  const calls = []
  await withDoor(async (ask) => {
    // The door warms the phone's first screen when it starts, so this counts the calls the
    // refused request made, not the ones the warm made.
    const before = calls.length
    assert.equal((await ask('/v1/summary', { token: null })).status, 401)
    assert.equal((await ask('/v1/summary', { token: 'wrong' })).status, 401)
    assert.equal(calls.length, before)
  }, { calls })
})

test('a web page is refused even with the right token', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const before = calls.length
    const res = await ask('/v1/summary', { headers: { Origin: 'https://example.com' } })
    assert.equal(res.status, 403)
    assert.equal(calls.length, before)
  }, { calls })
})

test('guessing locks the address out, and the right token does not get past that', async () => {
  await withDoor(async (ask) => {
    for (let i = 0; i < 10; i += 1) await ask('/v1/summary', { token: `guess-${i}` })
    assert.equal((await ask('/v1/summary')).status, 429)
  })
})

test('only the named actions exist', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const before = calls.length
    for (const path of ['/', '/api/threads', '/v1', '/v1/companies', '/v1/../api/companies', '/v1/agents/lead/heartbeat/invoke']) {
      assert.equal((await ask(path)).status, 404, path)
    }
    assert.equal((await ask('/v1/summary', { method: 'POST', body: {} })).status, 404)
    assert.equal(calls.length, before)
  }, { calls })
})

test('the summary lists what needs you and leaves configuration out', async () => {
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/summary')
    assert.equal(status, 200)
    assert.equal(body.company, 'nGen Labs')
    assert.deepEqual(body.needsYou.map((n) => n.kind), ['approval', 'question', 'blocked', 'failed'])
    assert.equal(body.needsYou[1].id, JOB)
    assert.deepEqual(body.projects, [{ id: PROJECT, name: 'Baltis' }])
    assert.deepEqual(body.usage, [{ provider: 'anthropic', window: '7d', tokens: 120, cachedTokens: 900 }])
    assert.deepEqual(body.running.map((j) => [j.ref, j.bot]), [['CREW-1', 'Scout']])
    assert.equal(body.bots.find((b) => b.name === 'Scout').status, 'running')
    assert.equal(body.spentCents, 321)
    assert.deepEqual(body.sessions.map((s) => s.project), ['aldis'])
    assert.equal(JSON.stringify(body).includes('/secret'), false)
    assert.equal(JSON.stringify(body).includes('hidden'), false)
  })
})

test('a slow session scan never holds up the summary', async () => {
  let scans = 0
  const started = Date.now()
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/summary')
    assert.equal(status, 200)
    assert.deepEqual(body.sessions, [])
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2500, `the summary waited ${elapsed} ms for the scan`)
  }, { sessions: () => { scans += 1; return new Promise(() => {}) } })
  assert.equal(scans, 1)
})

test('the summary scans sessions once, then serves the remembered list', async () => {
  let scans = 0
  await withDoor(async (ask) => {
    const first = await ask('/v1/summary')
    assert.deepEqual(first.body.sessions.map((s) => s.project), ['aldis'])
    const second = await ask('/v1/summary')
    assert.deepEqual(second.body.sessions.map((s) => s.project), ['aldis'])
  }, {
    sessions: async () => {
      scans += 1
      return [{ title: 'Aldis build', harness: 'claude-code', project: 'aldis' }]
    },
  })
  assert.equal(scans, 1)
})

test('a scan that fails leaves the summary standing', async () => {
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/summary')
    assert.equal(status, 200)
    assert.deepEqual(body.sessions, [])
  }, { sessions: async () => { throw new Error('no harness') } })
})

test('a slow attention feed does not hold the summary past a second', async () => {
  await withDoor(async (ask) => {
    const started = Date.now()
    const first = await ask('/v1/summary')
    assert.equal(first.status, 200)
    assert.equal(first.body.needsYou.some((n) => n.kind === 'question'), false)
    // The answer comes from the cache the door warmed when it started, so the slow feed is never
    // waited for.
    assert.ok(Date.now() - started < 500, `the first summary waited ${Date.now() - started} ms`)
    await new Promise((resolve) => setTimeout(resolve, 600))
    // The cached answer is served at once; the refreshed answer lands on the next call.
    await ask('/v1/summary')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const latest = await ask('/v1/summary')
    assert.equal(latest.body.needsYou.some((n) => n.kind === 'question'), true)
  }, { attentionDelay: 1100 })
})

test('the summary is served at once without waiting for Paperclip, then refreshed behind it', async () => {
  await withDoor(async (ask) => {
    const started = Date.now()
    const first = await ask('/v1/summary')
    assert.equal(first.status, 200)
    assert.ok(Date.now() - started < 500, `the first summary took ${Date.now() - started} ms`)
    const second = await ask('/v1/summary')
    assert.equal(second.status, 200)
    assert.ok(Date.now() - started < 500, `the cached summary took ${Date.now() - started} ms`)
    // The background refresh lands on the next call after Paperclip has answered.
    await new Promise((resolve) => setTimeout(resolve, 4000))
    await ask('/v1/summary')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const latest = await ask('/v1/summary')
    assert.equal(latest.status, 200)
    assert.equal(latest.body.needsYou.some((n) => n.kind === 'question'), true)
  }, { attentionDelay: 2000 })
})

test('the chat list is served at once and refreshed behind the request', async () => {
  await withDoor(async (ask) => {
    const started = Date.now()
    const first = await ask('/v1/chats')
    assert.equal(first.status, 200)
    // The answer is at once, and it still carries the bots: a fast answer with nothing in it is
    // an empty studio, which is worse than a slow one.
    assert.deepEqual(first.body.bots.map((b) => b.name), ['Tony', 'Scout', 'Critic'])
    assert.ok(Date.now() - started < 500, `the first chat list took ${Date.now() - started} ms`)
    const second = await ask('/v1/chats')
    assert.equal(second.status, 200)
    assert.deepEqual(second.body.bots.map((b) => b.name), ['Tony', 'Scout', 'Critic'])
  }, { chatDelay: 900 })
})

test('a slow Paperclip still gives the phone the bots and the company', async () => {
  // The door has no answer yet and Paperclip takes longer than the old one-second wait, so the
  // phone waits for the answer rather than being shown an empty studio.
  await withDoor(async (ask) => {
    const first = await ask('/v1/summary')
    assert.equal(first.status, 200)
    assert.equal(first.body.company, 'nGen Labs')
    assert.deepEqual(first.body.bots.map((b) => b.name), ['Tony', 'Scout', 'Critic'])
    assert.deepEqual(first.body.needsYou.map((n) => n.kind), ['approval', 'question', 'blocked', 'failed'])
  }, { warm: false, summaryDelay: 1200 })
})

test('a slow Paperclip still gives the phone the bots in the chat list', async () => {
  await withDoor(async (ask) => {
    const first = await ask('/v1/chats')
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.bots.map((b) => b.name), ['Tony', 'Scout', 'Critic'])
  }, { warm: false, chatDelay: 1200 })
})

test('a Paperclip that is down is answered with the error, not an empty studio', async () => {
  await withDoor(async (ask) => {
    const first = await ask('/v1/summary')
    assert.ok(first.status >= 400, `the summary answered ${first.status}`)
    assert.match(first.body.error, /Paperclip/)
    const chats = await ask('/v1/chats')
    assert.ok(chats.status >= 400, `the chat list answered ${chats.status}`)
    assert.match(chats.body.error, /Paperclip/)
  }, { state: { down: true } })
})

test('the last good answer is kept, and the door says what went wrong', async () => {
  const state = { down: false }
  await withDoor(async (ask) => {
    const good = await ask('/v1/summary')
    assert.equal(good.status, 200)
    assert.deepEqual(good.body.bots.map((b) => b.name), ['Tony', 'Scout', 'Critic'])
    state.down = true
    // The next call refreshes behind the request and finds Paperclip down.
    await ask('/v1/summary')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = await ask('/v1/summary')
    assert.equal(after.status, 200)
    // The studio is still there, and the phone is told what went wrong.
    assert.deepEqual(after.body.bots.map((b) => b.name), ['Tony', 'Scout', 'Critic'])
    assert.match(after.body.error, /Paperclip/)
  }, { state })
})

test('the models screen reads every bot\'s model and the free list, and leaves configuration out', async () => {
  const crew = {
    'setup-bots.py': "FREE = [('opencode/deepseek-v4.1-flash-free', 'deepseek', 'strong'), ('opencode/beam-free', 'beam', 'light')]\n",
    'free-out.json': { 'opencode/beam-free': { until: Math.floor(Date.now() / 1000) + 3600, error: 'did not answer' } },
    'fallback.log': '2026-11-10 01:21 Fred moved from opencode/deepseek-v4.1-flash-free to opencode/beam-free\n',
  }
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/models', { token: 'wrong' })).status, 401)
    assert.equal((await ask('/v1/models', { method: 'POST', body: {} })).status, 404)
    const { status, body } = await ask('/v1/models')
    assert.equal(status, 200)
    assert.deepEqual(body.bots.map((b) => [b.name, b.label, b.where, b.status]), [['Critic', 'GPT 6.1 Sol', 'Codex', 'idle'], ['Scout', 'GPT 6 Luna', 'Codex', 'idle'], ['Tony', 'Sonnet 5.5', 'Claude', 'idle']])
    assert.deepEqual(body.free.map((m) => [m.label, m.state]), [['DeepSeek V4.1 Flash, free', 'unchecked'], ['Beam, free', 'aside']])
    assert.equal(body.subscriptions.claude.week, 0.4)
    assert.equal(body.switches[0].text, 'Fred moved from DeepSeek V4.1 Flash, free to Beam, free')
    assert.equal(body.health.tone, 'warn')
    assert.equal(JSON.stringify(body).includes('/secret'), false)
    assert.equal(JSON.stringify(body).includes('hidden'), false)
    assert.equal(JSON.stringify(body).includes('setup-bots'), false)
  }, { crew })
})

test('a new job goes to the director and a bad one is refused', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const made = await ask('/v1/jobs', { method: 'POST', body: { title: 'Fix the map', description: 'It is broken' } })
    assert.equal(made.status, 201)
    assert.equal(made.body.ref, 'NGE-4')
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: '   ' } })).status, 400)
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: 'x'.repeat(201) } })).status, 400)
  }, { calls })
  const created = calls.find((c) => c.method === 'POST')
  assert.equal(created.body.assigneeAgentId, 'lead')
  assert.equal(created.body.status, 'todo')
})

test('a job shows its comments, and an unusual id never reaches Paperclip', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const job = await ask(`/v1/jobs/${JOB}`)
    assert.deepEqual(job.body.comments.map((c) => c.from), ['Scout', 'You'])
    assert.equal((await ask('/v1/jobs/not-an-id')).status, 400)
    assert.equal((await ask('/v1/jobs/..%2F..%2Fcompanies')).status, 400)
  }, { calls })
  assert.equal(calls.some((c) => c.path.includes('not-an-id') || c.path.includes('companies/co/secrets')), false)
})

test('comments and approvals pass through by name', async () => {
  const calls = []
  await withDoor(async (ask) => {
    assert.equal((await ask(`/v1/jobs/${JOB}/comments`, { method: 'POST', body: { text: 'Carry on' } })).status, 201)
    assert.equal((await ask(`/v1/jobs/${JOB}/comments`, { method: 'POST', body: { text: '' } })).status, 400)
    assert.equal((await ask(`/v1/approvals/${APPROVAL}/approve`, { method: 'POST', body: { note: 'Fine' } })).status, 200)
    assert.equal((await ask(`/v1/approvals/${APPROVAL}/delete`, { method: 'POST', body: {} })).status, 404)
  }, { calls })
  assert.deepEqual(calls.find((c) => c.path.endsWith('/approve')).body, { decisionNote: 'Fine' })
})

test('the chat list shows who can be talked to and leaves configuration out', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask('/v1/chats')
    assert.deepEqual(body.bots.map((b) => b.name), ['Tony', 'Scout', 'Critic'])
    const critic = body.bots.find((b) => b.name === 'Critic')
    assert.equal(critic.lastActiveAt, '2026-11-02T10:00:00Z')
    assert.equal(critic.lastMessage.text, 'On it')
    assert.equal(critic.lastMessage.mine, false)
    assert.equal(body.bots.find((b) => b.name === 'Tony').lastMessage, null)
    assert.equal(JSON.stringify(body).includes('/secret'), false)
  })
})

test('a conversation reads oldest first and says when the bot is working', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/chats/${BOT}`)
    assert.equal(body.working, true)
    assert.deepEqual(body.messages.map((m) => [m.from, m.mine]), [['You', true], ['Critic', false], ['Paperclip', false]])
  })
})

test('a chat message opens the chat and carries the phone\'s request id', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const sent = await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: 'Hello', requestId: REQUEST } })
    assert.equal(sent.status, 201)
    assert.equal((await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: 'Hello' } })).status, 400)
    assert.equal((await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: ' ', requestId: REQUEST } })).status, 400)
    assert.equal((await ask('/v1/chats/not-a-bot')).status, 400)
  }, { calls })
  const message = calls.find((c) => c.path === '/issues/chat/comments' && c.method === 'POST')
  assert.deepEqual(message.body, { body: 'Hello', clientRequestId: REQUEST })
})

test('an oversized body is refused', async () => {
  await withDoor(async (ask) => {
    const res = await ask('/v1/jobs', { method: 'POST', body: { title: 'x', description: 'y'.repeat(20 * 1024) } })
    assert.equal(res.status, 413)
  })
})

test('a job shows its questions, and only the forms the app can answer', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/jobs/${JOB}`)
    assert.deepEqual(body.questions.map((q) => q.kind), ['choice', 'confirm'])
    assert.equal(body.questions[0].items[0].multiple, true)
    assert.equal(body.questions[0].items[0].options[0].hint, 'Fast')
    assert.equal(body.questions[1].accept, 'Ship')
  })
})

test('a job says whether it is live', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/jobs/${JOB}`)
    assert.equal(body.run.live, true)
    assert.equal(body.run.why, '')
  })
})

test('stopping a job cancels its live runs and leaves the job open', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const stopped = await ask(`/v1/jobs/${JOB}/stop`, { method: 'POST', body: {} })
    assert.equal(stopped.body.stopped, 1)
    assert.ok(calls.some((c) => c.path === '/heartbeat-runs/run1/cancel' && c.method === 'POST'))
    assert.equal(calls.some((c) => c.path === `/issues/${JOB}` && c.method === 'PATCH'), false)
  }, { calls })
})

test('a job can be cancelled and reopened', async () => {
  const calls = []
  await withDoor(async (ask) => {
    assert.equal((await ask(`/v1/jobs/${JOB}/cancel`, { method: 'POST', body: {} })).status, 200)
    assert.equal((await ask(`/v1/jobs/${JOB}/reopen`, { method: 'POST', body: {} })).status, 200)
    const sent = calls.filter((c) => c.path === `/issues/${JOB}` && c.method === 'PATCH').map((c) => c.body.status)
    assert.deepEqual(sent, ['cancelled', 'todo'])
  }, { calls })
})

test('a bot can be paused and resumed', async () => {
  const calls = []
  await withDoor(async (ask) => {
    assert.equal((await ask(`/v1/bots/${BOT}/pause`, { method: 'POST', body: {} })).status, 200)
    assert.equal((await ask(`/v1/bots/${BOT}/resume`, { method: 'POST', body: {} })).status, 200)
    assert.deepEqual(calls.filter((c) => c.path.startsWith('/agents/') && c.method === 'POST').map((c) => c.path.split('/').pop()), ['pause', 'resume'])
    assert.equal((await ask('/v1/bots/not-a-bot/pause', { method: 'POST', body: {} })).status, 400)
    assert.equal((await ask(`/v1/bots/${BOT}/delete`, { method: 'POST', body: {} })).status, 404)
  }, { calls })
})

test('questions are answered with only the fields Paperclip expects', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const path = `/v1/jobs/${JOB}/questions/${QUESTION}`
    const answers = [{ questionId: 'size', optionIds: ['s'], extra: 'dropped' }]
    assert.equal((await ask(`${path}/respond`, { method: 'POST', body: { answers } })).status, 200)
    assert.deepEqual(calls.find((c) => c.path.endsWith('/respond')).body, { answers: [{ questionId: 'size', optionIds: ['s'] }] })
    assert.equal((await ask(`${path}/respond`, { method: 'POST', body: {} })).status, 400)
    assert.equal((await ask(`${path}/accept`, { method: 'POST', body: {} })).status, 200)
    assert.equal((await ask(`${path}/reject`, { method: 'POST', body: { reason: 'Not yet' } })).status, 200)
    assert.equal(calls.find((c) => c.path.endsWith('/reject')).body.reason, 'Not yet')
    assert.equal((await ask(`/v1/jobs/${JOB}/questions/nope/accept`, { method: 'POST', body: {} })).status, 400)
  }, { calls })
})

test('a new job can name its project, bot and priority', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const made = await ask('/v1/jobs', { method: 'POST', body: { title: 'Polish', projectId: PROJECT, botId: BOT, priority: 'high' } })
    assert.equal(made.status, 201)
    const sent = calls.find((c) => c.path === '/companies/co/issues' && c.method === 'POST').body
    assert.equal(sent.projectId, PROJECT)
    assert.equal(sent.assigneeAgentId, BOT)
    assert.equal(sent.priority, 'high')
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: 'x', projectId: QUESTION } })).status, 400)
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: 'x', botId: QUESTION } })).status, 400)
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: 'x', priority: 'urgent' } })).status, 400)
  }, { calls })
})

test('a job lists only image proof, and images come through as images', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/jobs/${JOB}`)
    assert.deepEqual(body.proof, [{ id: QUESTION, name: 'hud.png' }])
    assert.equal(body.changes, null)
    assert.deepEqual(body.previews, [])
    assert.equal((await ask('/v1/proof/not-an-id')).status, 400)
    assert.equal((await ask(`/v1/proof/${REQUEST}`)).status, 415)
  })
})

test('a job with no branch has no changes to read', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask(`/v1/jobs/${JOB}/changes`)).status, 404)
  })
})

test('each device gets its own key, and it can be cut off alone', async () => {
  await withDoor(async (ask) => {
    const phone = (await ask('/v1/devices', { method: 'POST', body: { name: 'Pixel' } })).body
    const laptop = (await ask('/v1/devices', { method: 'POST', body: { name: 'Laptop' } })).body
    assert.equal((await ask('/v1/summary', { token: phone.key })).status, 200)
    const list = (await ask('/v1/devices', { token: phone.key })).body
    assert.equal(list.current, phone.id)
    assert.deepEqual(list.devices.map((d) => d.name), ['Pixel', 'Laptop'])
    assert.equal(JSON.stringify(list).includes('hash'), false)
    assert.equal((await ask(`/v1/devices/${phone.id}/revoke`, { method: 'POST', body: {}, token: phone.key })).status, 409)
    assert.equal((await ask(`/v1/devices/${laptop.id}/revoke`, { method: 'POST', body: {}, token: phone.key })).status, 200)
    assert.equal((await ask('/v1/summary', { token: laptop.key })).status, 401)
  })
})

test('the shared key can only be retired from a device, and stops working after', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/devices/retire-shared', { method: 'POST', body: {} })).status, 409)
    const { key } = (await ask('/v1/devices', { method: 'POST', body: {} })).body
    assert.equal((await ask('/v1/devices/retire-shared', { method: 'POST', body: {}, token: key })).status, 200)
    assert.equal((await ask('/v1/summary')).status, 401)
    assert.equal((await ask('/v1/summary', { token: key })).status, 200)
    assert.equal((await ask('/v1/devices', { token: key })).body.sharedActive, false)
  })
})

test('routines list what is live, and only fixed schedules can be set', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const { body } = await ask('/v1/routines')
    assert.deepEqual(body.routines.map((r) => r.title), ['Nightly tests'])
    assert.equal(body.routines[0].bot, 'Scout')
    assert.equal(body.routines[0].project, 'Baltis')
    const made = await ask('/v1/routines', { method: 'POST', body: { title: 'Nightly', schedule: 'nightly', timezone: 'Europe/Stockholm', projectId: PROJECT } })
    assert.equal(made.status, 201)
    assert.equal(calls.find((c) => c.path.endsWith('/triggers')).body.cronExpression, '0 3 * * *')
    assert.equal((await ask('/v1/routines', { method: 'POST', body: { title: 'x', schedule: '* * * * *' } })).status, 400)
    assert.equal((await ask('/v1/routines', { method: 'POST', body: { title: 'x', schedule: 'constructor' } })).status, 400)
    assert.equal((await ask('/v1/routines', { method: 'POST', body: { title: 'x', schedule: 'nightly', timezone: '../etc' } })).status, 400)
    for (const action of ['run', 'pause', 'resume', 'remove']) assert.equal((await ask(`/v1/routines/${ROUTINE}/${action}`, { method: 'POST', body: {} })).status, 200)
    assert.deepEqual(calls.filter((c) => c.path === `/routines/${ROUTINE}` && c.method === 'PATCH').map((c) => c.body.status), ['paused', 'active', 'archived'])
    assert.equal((await ask('/v1/routines/nope/run', { method: 'POST', body: {} })).status, 400)
  }, { calls })
})

test('the token guard is set through the door and reported with the summary', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/summary')).body.guard.enabled, false)
    const set = await ask('/v1/guard', { method: 'POST', body: { enabled: true, limit: 5000000 } })
    assert.deepEqual([set.body.enabled, set.body.limit], [true, 5000000])
    assert.equal((await ask('/v1/guard', { method: 'POST', body: { enabled: true, limit: -4 } })).body.limit, 0)
  })
})

test('the day report covers finished jobs and tokens', async () => {
  await withDoor(async (ask) => {
    const { report } = (await ask('/v1/summary')).body
    assert.equal(typeof report.finishedCount, 'number')
    assert.ok(Array.isArray(report.tokens))
  })
})

const TUNNEL = { address: '10.88.0.1', phone: '10.88.0.2', port: 51820, interface: 'ngen-test', endpoint: '83.1.2.3', phoneEndpoint: '83.1.2.3' }

test('the app learns the tunnel address once away access is set up', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/hello')).body.away, null)
    assert.equal((await ask('/v1/hello', { token: 'wrong' })).status, 401)
    assert.equal((await ask('/v1/devices')).body.away, null)
  })
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/hello')).body.away, '10.88.0.1:5288')
    assert.deepEqual((await ask('/v1/devices')).body.away, { address: '10.88.0.1', up: false, changed: false })
    assert.ok(!(await ask('/v1/summary')).body.needsYou.some((item) => /address changed/.test(item.title)))
  }, { away: TUNNEL })
})

test('a tunnel address outside the private ranges is ignored', async () => {
  for (const address of ['8.8.8.8', '127.0.0.1', 'evil.example', '10.0.0.1:80']) {
    await withDoor(async (ask) => {
      assert.equal((await ask('/v1/hello')).body.away, null)
    }, { away: { ...TUNNEL, address } })
  }
})

test('a changed home address asks the owner to update the phone, until the phone comes through', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-away-'))
  const file = path.join(folder, 'away.json')
  fs.writeFileSync(file, JSON.stringify({ ...TUNNEL, endpoint: '83.9.9.9' }))
  await withDoor(async (ask) => {
    const notice = (await ask('/v1/summary')).body.needsYou.find((item) => /address changed/.test(item.title))
    assert.match(notice.detail, /83\.9\.9\.9:51820/)
    assert.equal((await ask('/v1/devices')).body.away.changed, true)
  }, { away: { ...TUNNEL, endpoint: '83.9.9.9' } })
  noteArrival(file, '192.168.0.4')
  assert.equal(readAway(file).changed, true)
  noteArrival(file, '10.88.0.1')
  assert.equal(readAway(file).changed, true)
  noteArrival(file, '::ffff:10.88.0.2')
  assert.equal(readAway(file).changed, false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).phoneEndpoint, '83.9.9.9')
})

const EDGE = { studio: 'studio.example.org', play: 'play.example.org', gate: 'c'.repeat(64) }
const VIA_EDGE = (client) => ({ 'x-ngen-edge': '1', 'x-ngen-client': client })

test('a device with a key learns the Cloudflare address and its gate, and nothing without a key', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/hello')).body.edge, null)
  })
  await withDoor(async (ask) => {
    assert.deepEqual((await ask('/v1/hello')).body.edge, { host: 'https://studio.example.org', gate: EDGE.gate })
    assert.equal((await ask('/v1/hello', { token: '' })).body.edge, undefined)
  }, { edge: EDGE })
  for (const broken of [{ ...EDGE, gate: 'short' }, { ...EDGE, studio: 'evil host' }, { ...EDGE, play: '' }]) {
    await withDoor(async (ask) => {
      assert.equal((await ask('/v1/hello')).body.edge, null)
    }, { edge: broken })
  }
})

test('build links through Cloudflare are signed for that build alone', async () => {
  const key = 'a1'.repeat(16)
  await withDoor(async (ask) => {
    const direct = (await ask(`/v1/jobs/${JOB}`)).body.previews[0].url
    assert.match(direct, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/open/${key}$`))
    const cloud = (await ask(`/v1/jobs/${JOB}`, { headers: VIA_EDGE('90.1.2.3') })).body.previews[0].url
    assert.equal(cloud, `https://play.example.org/open/${key}?g=${signPlay(EDGE.gate, key)}`)
    assert.notEqual(signPlay(EDGE.gate, key), signPlay(EDGE.gate, 'b2'.repeat(16)))
  }, { edge: EDGE, build: { key } })
})

test('through Cloudflare, wrong keys lock out that phone and not every phone', async () => {
  await withDoor(async (ask) => {
    for (let i = 0; i < 10; i += 1) assert.equal((await ask('/v1/hello', { token: 'wrong', headers: VIA_EDGE('90.1.2.3') })).status, 401)
    assert.equal((await ask('/v1/hello', { headers: VIA_EDGE('90.1.2.3') })).status, 429)
    assert.equal((await ask('/v1/hello', { headers: VIA_EDGE('90.9.9.9') })).status, 200)
    assert.equal((await ask('/v1/hello')).status, 200)
  }, { edge: EDGE })
})
