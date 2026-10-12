/**
 * Messaging a bot: the job runner that carries a background reply, the adapters' answers to
 * "how would this travel", and one full round trip through `sendMessage` with a fake agent CLI
 * on disk, because only that proves the message reaches the CLI on stdin and its answer comes
 * back as the job's reply.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { clearJobs, listJobs, replyFrom, runningJobFor, startJob } from '../server/lib/jobs.mjs'
import { sendMessage as sendMessageActual } from '../server/api.mjs'
import { messageThread } from '../server/scan.mjs'
import { vscodeExtensionUrl } from '../server/lib/vscode-links.mjs'
import { withEnv } from './support/env.mjs'

const UUID = '2df3987c-02d3-405e-b8f5-da30e3835213'
const sendMessage = (body, options) => sendMessageActual(body, options || {
  scan: async () => [{ id: body.threadId, harness: body.harness, ref: body.ref, running: false }],
})

/** A child process that answers with whatever the test tells it to. */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdinText = ''
  child.stdin = Object.assign(new EventEmitter(), { end: (t) => (child.stdinText = t) })
  child.kill = () => child.emit('close', null)
  return child
}

test('a reply is Claude’s JSON result, or the tail of whatever was printed', () => {
  assert.equal(replyFrom(JSON.stringify({ type: 'result', result: '  All green.  ' })), 'All green.')
  assert.equal(replyFrom('plain answer\n'), 'plain answer')
  assert.equal(replyFrom(''), '')
  const long = 'x'.repeat(4000)
  assert.equal(replyFrom(long).length, 1501)
})

test('a job sends the message on stdin, never in the arguments, and records the reply', async () => {
  clearJobs()
  let call
  const child = fakeChild()
  const job = startJob({
    threadId: 't1',
    label: 'Claude Code',
    command: { argv: ['/bin/claude', '-p', '--resume', UUID], cwd: os.tmpdir(), stdin: 'run the tests; rm -rf /' },
    spawnImpl: (bin, args, opts) => ((call = { bin, args, opts }), child),
  })
  assert.equal(job.status, 'running')
  assert.equal(runningJobFor('t1')?.id, job.id)
  assert.equal(child.stdinText, 'run the tests; rm -rf /')
  assert.ok(!call.args.some((a) => a.includes('rm -rf')), 'the message is not an argument')
  assert.equal(call.opts.shell, false, 'no shell for a real executable')
  child.stdout.emit('data', JSON.stringify({ result: 'Tests pass.' }))
  child.emit('close', 0)
  const [done] = listJobs()
  assert.equal(done.status, 'done')
  assert.equal(done.reply, 'Tests pass.')
  assert.equal(runningJobFor('t1'), null)
})

test('a failed job says why, from the end of what it printed to stderr', () => {
  clearJobs()
  const child = fakeChild()
  startJob({ threadId: 't2', command: { argv: ['/bin/claude'], cwd: os.tmpdir(), stdin: 'hi' }, spawnImpl: () => child })
  child.stderr.emit('data', 'warming up\nNo conversation found with session ID\n')
  child.emit('close', 1)
  const [failed] = listJobs()
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /No conversation found/)
})

test('a Windows .cmd shim gets a shell, with its own path quoted', () => {
  clearJobs()
  let call
  const child = fakeChild()
  startJob({
    threadId: 't3',
    command: { argv: ['C:\\Program Files\\npm\\claude.cmd', '-p'], cwd: os.tmpdir(), stdin: 'hi' },
    spawnImpl: (bin, args, opts) => ((call = { bin, opts }), child),
  })
  assert.equal(call.opts.shell, true)
  assert.equal(call.bin, '"C:\\Program Files\\npm\\claude.cmd"')
  child.emit('close', 0)
})

test('the VS Code link for a Claude thread can carry a prompt to type in', () => {
  const url = new URL(vscodeExtensionUrl('claude-code', UUID, 'vscode', 'Continue & check #2'))
  assert.equal(url.searchParams.get('session'), UUID)
  assert.equal(url.searchParams.get('prompt'), 'Continue & check #2')
  assert.equal(new URL(vscodeExtensionUrl('claude-code', UUID)).searchParams.has('prompt'), false)
})

// ── adapters and the endpoint, with a fake CLI on disk ────────────────────────────────────

/**
 * A fake `claude`/`codex` that echoes its arguments and stdin back as Claude's JSON result.
 * On Windows it is a .cmd shim running node, the shape npm installs.
 */
async function fakeCli(dir, name) {
  const script = path.join(dir, `${name}-fake.cjs`)
  await fsp.writeFile(
    script,
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({result:'args='+process.argv.slice(2).join(' ')+' | said='+s}))})\n`
  )
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.cmd`)
    await fsp.writeFile(file, `@"${process.execPath}" "${script}" %*\r\n`)
    return file
  }
  const file = path.join(dir, name)
  await fsp.writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  return file
}

async function withCli(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-atrium-message-'))
  try {
    const claude = await fakeCli(dir, 'claude')
    const codex = await fakeCli(dir, 'codex')
    return await withEnv({ PATH: dir }, () => fn({ dir, claude, codex }))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('with its CLI installed, a Claude thread is messaged in the background, edits only when allowed', () =>
  withCli(async ({ dir, claude }) => {
    const ref = { cliSessionId: UUID, cwd: dir }
    const plain = await messageThread('claude-code', ref, 'hello')
    assert.equal(plain.mode, 'background')
    assert.deepEqual(plain.command.argv, [claude, '-p', '--resume', UUID, '--output-format', 'json', '--permission-mode', 'plan'])
    assert.equal(plain.command.stdin, 'hello')
    const edits = await messageThread('claude-code', ref, 'hello', { allowEdits: true })
    assert.deepEqual(edits.command.argv.slice(-2), ['--permission-mode', 'acceptEdits'])
  }))

test('asked for the app, a VS Code Claude thread opens with the message typed in', () =>
  withCli(async ({ dir }) => {
    const plan = await messageThread('claude-code', { cliSessionId: UUID, cwd: dir, source: 'vscode' }, 'ship it', { via: 'app' })
    assert.equal(plan.mode, 'app')
    assert.equal(plan.prefilled, true)
    assert.equal(new URL(plan.url).searchParams.get('prompt'), 'ship it')
  }))

test('Codex resume receives explicit read-only or workspace-write permissions and no approvals', () =>
  withCli(async ({ dir, codex }) => {
    const ref = { sessionId: UUID, cwd: dir }
    for (const [allowEdits, sandbox] of [[false, 'read-only'], [true, 'workspace-write']]) {
      assert.deepEqual((await messageThread('codex', ref, 'go', { allowEdits })).command.argv,
        [codex, 'exec', '--sandbox', sandbox, 'resume', '-c', `sandbox_mode=${sandbox}`, '-c', 'approval_policy=never', UUID, '-'])
    }
  }))

test('without a CLI, background is refused and auto falls back to opening the thread to paste', () =>
  withEnv({ PATH: '' }, async () => {
    const ref = { sessionId: UUID, cwd: os.tmpdir() }
    // Only meaningful where no codex lives in the adapter's own fallback folders.
    const auto = await messageThread('codex', ref, 'go')
    if (auto.mode === 'background') return
    assert.equal(auto.mode, 'app')
    assert.equal(auto.paste, true)
    const forced = await messageThread('codex', ref, 'go', { via: 'background' })
    assert.equal(forced.ok, false)
    assert.match(forced.error, /CLI/)
  }))

test('sendMessage validates before it runs anything', async () => {
  clearJobs()
  assert.equal((await sendMessage({ threadId: 'x', text: '   ' }))[0], 400)
  assert.equal((await sendMessage({ threadId: 'x', text: 'y'.repeat(8001) }))[0], 400)
  assert.equal((await sendMessage({ text: 'hi' }))[0], 400)
})

test('a message round-trips through the CLI: stdin in, the reply back on the job, one at a time', () =>
  withCli(async ({ dir }) => {
    clearJobs()
    const body = { threadId: 'thread-a', harness: 'claude-code', ref: { cliSessionId: UUID, cwd: dir }, text: 'Where are you at?' }

    const [planStatus, plan] = await sendMessage({ ...body, plan: true })
    assert.equal(planStatus, 200)
    assert.equal(plan.mode, 'background')
    assert.equal(listJobs().length, 0, 'a plan runs nothing')

    const [status, sent] = await sendMessage(body)
    assert.equal(status, 202)
    assert.equal(sent.job.status, 'running')
    const [busy] = await sendMessage(body)
    assert.equal(busy, 409, 'a second message waits for the first reply')

    for (let i = 0; i < 100 && runningJobFor('thread-a'); i++) await new Promise((r) => setTimeout(r, 50))
    const [job] = listJobs()
    assert.equal(job.status, 'done', job.error)
    assert.match(job.reply, /said=Where are you at\?/)
    assert.match(job.reply, new RegExp(`args=-p --resume ${UUID} --output-format json`))
  }))

test('a thread whose folder is gone is refused before anything runs', () =>
  withCli(async ({ dir }) => {
    clearJobs()
    const ref = { cliSessionId: UUID, cwd: path.join(dir, 'moved-away') }
    const [status, body] = await sendMessage({ threadId: 'b', harness: 'claude-code', ref, text: 'hi' })
    assert.equal(status, 400)
    assert.match(body.error, /not on this machine/)
    assert.equal(listJobs().length, 0)
  }))

test('the server refuses active, missing, archived and helper threads before starting any turn', async () => {
  clearJobs()
  const body = { threadId: 'claude-code:test', harness: 'claude-code', text: 'Continue', ref: { cliSessionId: UUID, cwd: os.tmpdir() } }
  for (const [thread, status] of [[{ running: true }, 409], [{ archived: true }, 404], [{ parentId: 'p' }, 404], [null, 404]]) {
    const [actual] = await sendMessage(body, { scan: async () => thread ? [{ ...body, id: body.threadId, ...thread }] : [] })
    assert.equal(actual, status)
  }
  assert.equal(listJobs().length, 0)
})

test('dispatch is locked during async lookups, and the reference comes from the server', () =>
  withCli(async ({ dir }) => {
    clearJobs()
    const body = { threadId: 'claude-code:test', harness: 'claude-code', text: 'Hello', ref: { cliSessionId: 'invalid-client-id', cwd: 'wrong-folder' } }
    let release
    const gate = new Promise(resolve => { release = resolve })
    const first = sendMessage(body, { scan: async () => {
      await gate
      return [{ id: body.threadId, harness: body.harness, ref: { cliSessionId: UUID, cwd: dir } }]
    } })
    const [second] = await sendMessage(body, { scan: async () => [] })
    assert.equal(second, 409)
    release()
    const [status] = await first
    assert.equal(status, 202)
    for (let i = 0; i < 100 && runningJobFor(body.threadId); i++) await new Promise(r => setTimeout(r, 20))
    assert.equal(listJobs().length, 1)
    assert.equal(listJobs()[0].status, 'done')
    assert.match(listJobs()[0].reply, new RegExp(UUID))
    assert.ok(!listJobs()[0].reply.includes('invalid-client-id'))
  }))

test('a timed-out job fails immediately even when its child does not report closing', async () => {
  clearJobs()
  const child = fakeChild()
  let killed = false
  child.kill = () => { killed = true }
  startJob({ threadId: 'timeout', command: { argv: ['/bin/claude'], cwd: os.tmpdir() }, spawnImpl: () => child, timeoutMs: 10 })
  await new Promise(r => setTimeout(r, 25))
  assert.equal(killed, true)
  assert.equal(runningJobFor('timeout'), null)
  assert.equal(listJobs()[0].status, 'failed')
})
