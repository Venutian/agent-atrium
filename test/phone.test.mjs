/**
 * The phone door is the one part of Agent Atrium that may face another device, so most of these
 * tests are about what it refuses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { phoneHandler, startPhoneDoor, tokenMatches } from '../server/phone.mjs'

const TOKEN = 'a'.repeat(40)
const JOB = '11111111-2222-4333-8444-555555555555'
const APPROVAL = '66666666-7777-4888-8999-000000000000'
const BOT = '77777777-8888-4999-8aaa-111111111111'
const REQUEST = '88888888-9999-4aaa-8bbb-222222222222'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

function paperclip({ calls = [] } = {}) {
  const agents = [
    { id: 'lead', name: 'Tony', title: 'Studio director', role: 'ceo', status: 'idle', spentMonthlyCents: 120, adapterConfig: { model: 'claude-sonnet-5-5', cwd: '/secret', env: { KEY: 'hidden' } } },
    { id: 'bot', name: 'Scout', role: 'qa', status: 'idle', adapterConfig: { model: 'gpt-6-luna' } },
    { id: BOT, name: 'Critic', title: 'Reviewer', role: 'qa', status: 'idle', adapterConfig: { model: 'gpt-6.1-sol', cwd: '/secret' } },
  ]
  const issues = [
    { id: JOB, identifier: 'NGE-1', title: 'Fix the map', status: 'in_progress', assigneeAgentId: 'bot', lastActivityAt: '2026-11-02T10:00:00Z', companyId: 'co' },
    { id: 'two', identifier: 'NGE-2', title: 'Stuck job', status: 'blocked', assigneeAgentId: 'lead', lastActivityAt: '2026-11-02T09:00:00Z' },
    { id: 'three', identifier: 'NGE-3', title: 'Old job', status: 'done', lastActivityAt: '2026-11-01T09:00:00Z' },
  ]
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname.replace('/api', '') + new URL(url).search
    calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body) })
    if (path === '/companies') return json([{ id: 'co', status: 'active' }])
    if (path === '/companies/co') return json({ name: 'nGen Labs' })
    if (path === '/companies/co/agents') return json(agents)
    if (path === '/companies/co/issues' && init.method === 'POST') return json({ id: 'new', identifier: 'NGE-4' }, 201)
    if (path === '/companies/co/issues') return json(issues)
    if (path === '/companies/co/approvals?status=pending') return json([{ id: APPROVAL, type: 'hire_agent', payload: { name: 'New bot' } }])
    if (path === '/companies/co/dashboard') return json({ costs: { monthSpendCents: 321 } })
    if (path === '/companies/co/sidebar-badges') return json({ failedRuns: 1 })
    if (path === '/companies/co/live-runs') return json([{ agentId: 'bot' }])
    if (path === `/issues/${JOB}`) return json({ ...issues[0], description: 'Details' })
    if (path === `/issues/${JOB}/comments` && init.method === 'POST') return json({ id: 'c2' }, 201)
    if (path === `/issues/${JOB}/comments`) return json([{ id: 'c1', authorAgentId: 'bot', body: 'Working on it' }, { id: 'c0', body: 'Please do this' }])
    if (path === `/approvals/${APPROVAL}/approve`) return json({})
    if (path === '/companies/co/chats') return json([{ id: 'chat', conversationAgentId: BOT, lastActivityAt: '2026-11-02T10:00:00Z' }])
    if (path === `/agents/${BOT}`) return json(agents[2])
    if (path === `/companies/co/chats/${BOT}`) return json({ id: 'chat', conversationState: 'active' })
    if (path === '/issues/chat/comments?limit=100') {
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

async function withDoor(run, { calls } = {}) {
  const handler = phoneHandler({ token: TOKEN, paperclip: paperclip({ calls }), sessions: async () => [{ title: 'Aldis build', harness: 'claude-code', project: 'aldis' }] })
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
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
    assert.equal((await ask('/v1/summary', { token: null })).status, 401)
    assert.equal((await ask('/v1/summary', { token: 'wrong' })).status, 401)
  }, { calls })
  assert.equal(calls.length, 0)
})

test('a web page is refused even with the right token', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const res = await ask('/v1/summary', { headers: { Origin: 'https://example.com' } })
    assert.equal(res.status, 403)
  }, { calls })
  assert.equal(calls.length, 0)
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
    for (const path of ['/', '/api/threads', '/v1', '/v1/companies', '/v1/../api/companies', '/v1/agents/lead/heartbeat/invoke']) {
      assert.equal((await ask(path)).status, 404, path)
    }
    assert.equal((await ask('/v1/summary', { method: 'POST', body: {} })).status, 404)
  }, { calls })
  assert.equal(calls.length, 0)
})

test('the summary lists what needs you and leaves configuration out', async () => {
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/summary')
    assert.equal(status, 200)
    assert.equal(body.company, 'nGen Labs')
    assert.deepEqual(body.needsYou.map((n) => n.kind), ['approval', 'blocked', 'failed'])
    assert.deepEqual(body.running.map((j) => [j.ref, j.bot]), [['NGE-1', 'Scout']])
    assert.equal(body.bots.find((b) => b.name === 'Scout').status, 'running')
    assert.equal(body.spentCents, 321)
    assert.deepEqual(body.sessions.map((s) => s.project), ['aldis'])
    assert.equal(JSON.stringify(body).includes('/secret'), false)
    assert.equal(JSON.stringify(body).includes('hidden'), false)
  })
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
    assert.equal(body.bots.find((b) => b.name === 'Critic').lastActiveAt, '2026-11-02T10:00:00Z')
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
