/**
 * The manager's view is worked out from job titles, check comments and the crew's logs. These tests
 * pin how one piece of work is read through its rounds, and that the answer stays small.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildManager, kindOf, readCrewFiles, verdictOf, workName } from '../server/lib/manager.mjs'

const NOW = Date.parse('2026-11-10T13:00:00Z')
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString()
const ALDIS = 'p-aldis'
const NIGHT = 'p-night'

const AGENTS = [
  { id: 'tony', name: 'Tony', title: 'Studio director', status: 'idle', adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5-5', cwd: '/secret' } },
  { id: 'fred', name: 'Fred The Builder', status: 'idle', adapterType: 'opencode_local', adapterConfig: { model: 'opencode/deepseek-v4.1-flash-free' } },
  { id: 'freya', name: 'Freya The Checker', status: 'idle', adapterType: 'opencode_local', adapterConfig: { model: 'opencode/glm-5.3-flash-free' } },
  { id: 'senior', name: 'Senior Builder', status: 'paused', pauseReason: 'manual', adapterType: 'claude_local', adapterConfig: { model: 'claude-fable-5-1' } },
]
const PROJECTS = [{ id: ALDIS, name: 'Aldis' }, { id: NIGHT, name: 'Night Rules' }]

let number = 0
const job = (title, status, bot, extra = {}) => {
  number += 1
  return {
    id: `job-${number}`, identifier: `NGE-${number}`, issueNumber: number, title, status, assigneeAgentId: bot, projectId: ALDIS,
    createdAt: ago(600), startedAt: ago(500), completedAt: status === 'done' ? ago(60) : null, lastActivityAt: ago(60), ...extra,
  }
}
const noFiles = () => ({ merges: [], stopped: [], switches: [], pace: {}, thinker: {}, freeOut: {}, freeOk: {} })
const view = (issues, extra = {}) => buildManager({ agents: AGENTS, issues, projects: PROJECTS, files: noFiles(), now: NOW, ...extra })
const lineOf = (manager, ref) => manager.lines.find((l) => l.ref === ref)

test('a job is known by the way the crew names it', () => {
  assert.deepEqual(kindOf('Check NGE-12: Town kit'), { kind: 'check', of: 'NGE-12', tony: false })
  assert.deepEqual(kindOf('Check NGE-12 (Tony): Town kit'), { kind: 'check', of: 'NGE-12', tony: true })
  assert.deepEqual(kindOf('Fix 2 of Town kit'), { kind: 'fix', round: 2 })
  assert.deepEqual(kindOf('Ruling: how the line is measured'), { kind: 'ruling' })
  assert.deepEqual(kindOf('Town kit (v2)'), { kind: 'build' })
  assert.equal(workName('Fix 2 of Town kit (v3)'), 'Town kit')
})

test('a verdict is read from the newest thing a bot said, and never guessed', () => {
  const said = (body, authorType = 'agent') => ({ authorType, body })
  assert.equal(verdictOf([said('## Workspace Ready'), said('# Report\n\n## OUTCOME: PASS\n')]), 'pass')
  assert.equal(verdictOf([said('## OUTCOME: BLOCKING\n1. the test fails')]), 'blocking')
  assert.equal(verdictOf([said('VERDICT: FAIL')]), 'blocking')
  assert.equal(verdictOf([said('**Verdict:** PASS')]), 'pass')
  assert.equal(verdictOf([said('Two BLOCKING findings, see below')]), 'blocking')
  assert.equal(verdictOf([said('VERDICT: PASS', 'user'), said('still reading')]), null)
  assert.equal(verdictOf([]), null)
})

test('one piece of work is one line through its build, checks and fix rounds', () => {
  number = 0
  const build = job('Town kit', 'done', 'fred')
  const check = job('Check NGE-1: Town kit', 'done', 'freya', { completedAt: ago(50) })
  const fix = job('Fix 1 of Town kit', 'done', 'fred', { createdAt: ago(45), completedAt: ago(30) })
  const recheck = job('Check NGE-3: Fix 1 of Town kit', 'done', 'freya', { completedAt: ago(20) })
  const tony = job('Check NGE-3 (Tony): Fix 1 of Town kit', 'in_progress', 'tony', { startedAt: ago(5) })
  const manager = view([build, check, fix, recheck, tony], { verdicts: new Map([[check.id, 'blocking'], [recheck.id, 'pass']]) })
  assert.equal(manager.lines.length, 1)
  const line = manager.lines[0]
  assert.equal(line.ref, 'ALD-3')
  assert.equal(line.title, 'Town kit')
  assert.deepEqual(line.steps, ['done', 'done', 'now', 'wait', 'wait'])
  assert.equal(line.stage, 'tony')
  assert.equal(line.fixes, 1)
  assert.equal(line.note, 'Tony is checking it')
  assert.equal(line.late, false)
  assert.deepEqual(manager.now.map((w) => [w.bot, w.ref, w.stage, w.minutes, w.model]), [['Tony', 'ALD-5', 'Checking ALD-3', 5, 'Sonnet 5.5']])
  assert.match(manager.state, /^1 bot is working: Tony on ALD-5\./)
})

test('work that failed its check is trouble until something newer starts', () => {
  number = 0
  const build = job('Frame clock', 'done', 'fred')
  const check = job('Check NGE-1: Frame clock', 'done', 'freya', { completedAt: ago(40) })
  const failed = view([build, check], { verdicts: new Map([[check.id, 'blocking']]) })
  assert.equal(lineOf(failed, 'ALD-1').stage, 'fix')
  assert.ok(failed.trouble.some((t) => t.level === 'bad' && /ALD-1 failed its check/.test(t.text)))
  const followUp = job('Frame clock: review fixes', 'in_progress', 'fred', { createdAt: ago(30), startedAt: ago(29) })
  const handled = view([build, check, followUp], { verdicts: new Map([[check.id, 'blocking']]) })
  assert.equal(lineOf(handled, 'ALD-1').stage, 'replaced')
  assert.equal(handled.trouble.some((t) => /ALD-1/.test(t.text)), false)
})

test('merged and pushed come from the merge log and from git', () => {
  number = 0
  const logged = job('Feel fixes', 'done', 'senior')
  const branched = job('Far ground', 'done', 'senior')
  const pushed = job('Shadow casters', 'done', 'senior')
  const local = job('Story bible', 'done', 'fred', { projectId: NIGHT })
  const files = { ...noFiles(), merges: [{ at: NOW - 60_000, text: 'NGE-1 95c1d67ef into aldis main: merged' }] }
  const repos = new Map([
    [ALDIS, { unpushed: 3, remote: true, merged: new Set(['NGE-2', 'NGE-3']), pushed: new Set(['NGE-3']) }],
    [NIGHT, { unpushed: null, remote: false, merged: new Set(['NGE-4']), pushed: new Set() }],
  ])
  const manager = view([logged, branched, pushed, local], { files, repos })
  assert.deepEqual(['ALD-1', 'ALD-2', 'ALD-3', 'NR-4'].map((ref) => lineOf(manager, ref).stage), ['merged', 'merged', 'pushed', 'kept'])
  assert.equal(lineOf(manager, 'ALD-3').open, false)
  assert.equal(manager.projects.find((p) => p.id === ALDIS).unpushed, 3)
  assert.equal(manager.projects.find((p) => p.id === NIGHT).unpushed, null)
  assert.ok(manager.feed.some((e) => e.kind === 'merged' && e.text === 'ALD-1 merged into Aldis'))
  assert.ok(manager.trouble.some((t) => /2 finished pieces of work are merged but not pushed/.test(t.text)))
})

test('old finished work drops off, open work stays, and late work is said', () => {
  number = 0
  const old = job('Last week', 'done', 'fred', { completedAt: ago(3000), lastActivityAt: ago(10) })
  const waiting = job('Critic read', 'todo', 'tony', { createdAt: ago(3000), startedAt: null })
  const blocked = job('Release prep', 'blocked', 'senior')
  const manager = view([old, waiting, blocked])
  assert.deepEqual(manager.lines.map((l) => [l.ref, l.stage, l.late]), [['ALD-3', 'blocked', false], ['ALD-2', 'queued', true]])
  assert.ok(manager.trouble.some((t) => t.level === 'bad' && t.text === '1 job is blocked: ALD-3'))
  assert.ok(manager.trouble.some((t) => t.level === 'warn' && /ALD-2 has been waiting for 3000 minutes/.test(t.text)))
  assert.equal(manager.state, 'Nobody is working right now. 1 thing needs a look.')
})

test('each bot stands in the project of its job, and a paused one says why', () => {
  number = 0
  const running = job('Scene art', 'in_progress', 'fred', { projectId: NIGHT, startedAt: ago(14) })
  const earlier = job('Town kit', 'done', 'senior')
  const files = { ...noFiles(), pace: { week: 0.9, cap: 1, resets: (NOW + 3 * 86_400_000) / 1000 }, thinker: { on: 'gemini' }, freeOut: { 'opencode/beam-free': { until: NOW / 1000 + 600, error: 'out' } }, freeOk: {} }
  const manager = view([running, earlier], { files, live: [{ agentId: 'fred' }] })
  const bot = (id) => manager.bots.find((b) => b.id === id)
  assert.deepEqual([bot('fred').status, bot('fred').projectId, bot('fred').job.ref, bot('fred').job.minutes], ['running', NIGHT, 'NR-1', 14])
  assert.equal(bot('fred').model, 'DeepSeek V4.1 Flash, free')
  assert.equal(bot('senior').projectId, ALDIS)
  assert.match(bot('senior').why, /^Claude's week is 90% used; back /)
  assert.equal(bot('tony').projectId, '')
  assert.deepEqual(manager.projects.map((p) => [p.name, p.running, p.bots]), [['Night Rules', 1, ['Fred The Builder']], ['Aldis', 0, ['Senior Builder']]])
  assert.ok(manager.trouble.some((t) => /Every free model is out/.test(t.text)))
  assert.ok(manager.trouble.some((t) => /Codex is out; the thinking bots run on Antigravity/.test(t.text)))
  assert.equal(JSON.stringify(manager).includes('/secret'), false)
})

test('the crew files may be missing, and the logs are read with their times', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-manager-'))
  assert.deepEqual(readCrewFiles(folder), noFiles())
  fs.writeFileSync(path.join(folder, 'merges.log'), '2026-11-10 11:47 NGE-355 299ec89ee into aldis main: merged\nnot a line\n')
  fs.writeFileSync(path.join(folder, 'pace.json'), '[1, 2]')
  const files = readCrewFiles(folder)
  assert.deepEqual(files.merges, [{ at: new Date(2026, 10, 10, 11, 47).getTime(), text: 'NGE-355 299ec89ee into aldis main: merged' }])
  assert.deepEqual(files.pace, {})
})

test('a busy day still fits in a small answer', () => {
  number = 0
  const issues = []
  const files = noFiles()
  for (let i = 0; i < 120; i += 1) {
    const build = job(`A long title for piece of work number ${i} that goes on and on past what the phone can show in one line`, 'done', 'fred', { completedAt: ago(i) })
    issues.push(build, job(`Check ${build.identifier}: ${build.title}`, 'done', 'freya', { completedAt: ago(i) }))
    files.switches.push({ at: NOW - i * 60_000, text: `Fred moved from opencode/deepseek-v4.1-flash-free to nvidia/nvidia/nemotron-3-ultra-550b-a55b on try ${i}` })
  }
  const manager = view(issues, { files })
  assert.equal(manager.lines.length, 24)
  assert.equal(manager.feed.length, 40)
  assert.ok(manager.feed[0].at >= manager.feed[39].at)
  assert.ok(JSON.stringify(manager).length < 30 * 1024, `the answer is ${JSON.stringify(manager).length} bytes`)
})
