import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EnergyAlerts, dailyUsage, filterCrew, morningBriefing } from '../src/game/office-data.js'
import { githubRepo, checksState, probeLocalModel, repoHealth, repositoryKey } from '../server/lib/office-health.mjs'
import { installLinux, desktopQuote, shellQuote } from '../tools/install-linux.mjs'
import * as THREE from 'three'
import { createCommons } from '../src/world/commons.js'
import { OFFICES } from '../src/world/offices.js'
import { Atrium } from '../src/game/atrium.js'
const exec = promisify(execFile)
const now = Date.parse('2026-10-12T12:00:00Z')

test('crew search combines words, status, assistant, model and repository filters', () => {
  const threads = [{ id: '1', title: 'Fix Expo server', model: 'local-llama', harness: 'vscode-chat', project: 'app', running: true },
    { id: '2', title: 'Fix billing', project: 'store', unread: true }, { id: '3', title: 'Old work', archived: true }]
  assert.deepEqual(filterCrew(threads, { query: 'Expo local', status: 'working', model: 'local-llama', repo: 'app', harness: 'vscode-chat' }).map(t => t.id), ['1'])
  assert.equal(filterCrew(threads, { status: 'archived' }).length, 1)
  assert.equal(filterCrew(threads, { query: 'does not exist' }).length, 0)
})

test('daily trail keeps missing dates visible and filters models without mixing other dates', () => {
  const rows = [{ day: '2026-10-12', model: 'a', inputTokens: 10, outputTokens: 2, cachedInputTokens: 5, totalTokens: 12 },
    { day: '2026-10-12', model: 'b', inputTokens: 20, outputTokens: 3, cachedInputTokens: 0, totalTokens: 23 }]
  const days = dailyUsage(rows, { model: 'a', days: 3, now })
  assert.equal(days.length, 3); assert.equal(days[0].totalTokens, 0); assert.equal(days[2].totalTokens, 12)
  assert.equal(dailyUsage(rows, { days: 1, now })[0].totalTokens, 35)
})

test('energy warns once per fresh limit window and budget, then reminds rather than claiming a refill', () => {
  const notices = [], stored = []
  const alerts = new EnergyAlerts({ notify: text => notices.push(text), write: values => stored.push(values) })
  const report = { limits: [{ id: 'shared', assistant: 'Codex', observedAt: now, windows: [{ label: 'primary', resetsAt: now + 1000, usedPercent: 85 }] }],
    byDay: [{ day: '2026-10-12', inputTokens: 850, outputTokens: 0, cachedInputTokens: 0, totalTokens: 850 }] }
  alerts.update(report, { dailyBudget: 1000, now }); alerts.update(report, { dailyBudget: 1000, now })
  assert.equal(notices.length, 2)
  alerts.update(report, { dailyBudget: 1000, now: now + 2000 }); assert.equal(notices.length, 3)
  assert.match(notices[2], /fresh allowance/)
  const reloaded = new EnergyAlerts({ notify: text => notices.push(text), read: () => stored.at(-1) })
  reloaded.update(report, { dailyBudget: 1000, now: now + 2000 }); assert.equal(notices.length, 3)
  const stale = { limits: [{ ...report.limits[0], observedAt: now - 3600000 }] }
  assert.equal(alerts.update(stale, { now }).length, 0)
})

test('briefing prioritises blockers and keeps complete missions distinct from discovered merged PRs', () => {
  const report = morningBriefing([{ id: '1', hasError: true }, { id: '2', running: true }, { id: '3', unread: true }, { id: '4', hasError: true, archived: true }],
    { missions: [{ status: 'draft' }, { status: 'done' }], events: [{ kind: 'mission-done', at: now }], health: [{ pr: { state: 'MERGED' } }] }, now)
  assert.equal(report.blocked.length, 1); assert.equal(report.working.length, 1); assert.equal(report.waiting.length, 1)
  assert.equal(report.missions.length, 1); assert.equal(report.shipped.length, 1); assert.equal(report.merged.length, 1)
  assert.match(report.suggestion, /red beacons/)
})

test('GitHub names and CI conclusions accept known formats and preserve unknown state', () => {
  assert.equal(repositoryKey('C:\\Users\\ME\\repo'), repositoryKey('c:/Users/me/repo'))
  assert.equal(repositoryKey('\\\\?\\C:\\Users\\ME\\repo'), repositoryKey('c:/Users/me/repo'))
  assert.equal(githubRepo('git@github.com:Venutian/agent-atrium.git'), 'Venutian/agent-atrium')
  assert.equal(githubRepo('https://github.com/Venutian/agent-atrium.git'), 'Venutian/agent-atrium')
  assert.equal(githubRepo('https://github.com.evil.test/user/repo'), '')
  assert.equal(checksState([]), 'unknown'); assert.equal(checksState([{ conclusion: 'SUCCESS' }]), 'passed')
  assert.equal(checksState([{ status: 'IN_PROGRESS' }]), 'running')
  assert.equal(checksState([{ conclusion: 'FAILURE' }, { conclusion: 'SUCCESS' }]), 'failed')
})

test('local model probes never generate text and reject remote endpoints and redirects', async () => {
  const calls = []
  const fetcher = async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, text: async () => JSON.stringify({ models: [{ name: 'llama', size_vram: 100, context_length: 200 }] }) } }
  const model = await probeLocalModel('Ollama', 'http://127.0.0.1:11434/api/ps', 'ollama', fetcher)
  assert.equal(model.status, 'online'); assert.equal(model.models[0].vramBytes, 100)
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.method, undefined)
  assert.equal((await probeLocalModel('Remote', 'https://example.com/v1/models', 'openai', fetcher)).status, 'offline')
  assert.equal(calls.length, 1)
})

test('repository health reads real Git changes and stale test reports without running tests', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atrium-repo-health-'))
  try {
    await exec('git', ['init', dir]); await fsp.writeFile(path.join(dir, 'change.txt'), 'pending work')
    await fsp.mkdir(path.join(dir, '.agent-atrium')); await fsp.writeFile(path.join(dir, '.agent-atrium', 'health.json'), JSON.stringify({ tests: 'passed', updatedAt: Date.now() - 2 * 86400000 }))
    const [health] = await repoHealth([{ id: 'fixture', project: 'fixture', projectPath: dir }])
    assert.equal(health.changedFiles, 2); assert.equal(health.tests, 'passed'); assert.equal(health.testsStale, true)
    assert.equal(health.checks, 'unknown'); assert.equal(health.status, 'in-progress')
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('Linux installer safely quotes paths, creates XDG entries and removes only its own files', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atrium-linux-install-'))
  const home = path.join(root, 'home'), configHome = path.join(root, 'config'), dataHome = path.join(root, 'share')
  const desktopDir = path.join(home, 'Desktop'), nodeBin = path.join(root, 'node bin')
  try {
    const result = await installLinux({ root, home, configHome, dataHome, desktopDir, nodeBin })
    assert.match(await fsp.readFile(result.launcher, 'utf8'), /exec bash/)
    assert.match(await fsp.readFile(result.launcher, 'utf8'), /export PATH='[^']*node bin':"\$PATH"/)
    assert.match(await fsp.readFile(result.app, 'utf8'), /Terminal=false/)
    assert.match(await fsp.readFile(result.shortcut, 'utf8'), /Name=Agent Atrium\n/)
    assert.match(await fsp.readFile(result.startup, 'utf8'), /--headless/)
    await fsp.writeFile(path.join(root, 'keep.txt'), 'untouched')
    await installLinux({ root, home, configHome, dataHome, desktopDir, remove: true })
    assert.equal(await fsp.readFile(path.join(root, 'keep.txt'), 'utf8'), 'untouched')
    assert.equal(await fsp.stat(result.app).catch(() => null), null)
    assert.equal(await fsp.stat(result.shortcut).catch(() => null), null)
    assert.match(desktopQuote('/home/a $b/100%/app'), /\\\\\$/)
    assert.match(desktopQuote('/home/a $b/100%/app'), /100%%/)
    assert.throws(() => desktopQuote('/home/a\nother'))
    assert.equal(shellQuote("a'b"), "'a'\\''b'")
  } finally { await fsp.rm(root, { recursive: true, force: true }) }
})

test('Atlas is seated in a physical office, pickable separately from the crew, and survives theme switches', () => {
  for (const style of Object.values(OFFICES)) {
    const commons = createCommons(style)
    const director = commons.director
    assert.equal(director.name, 'director-atlas')
    assert.ok(commons.targets.some(t => t.mesh === director))
    const camera = new THREE.PerspectiveCamera(38, 1.6, 0.1, 100)
    const centre = new THREE.Box3().setFromObject(director).getCenter(new THREE.Vector3())
    camera.position.copy(centre).add(new THREE.Vector3(0, 3, 8)); camera.lookAt(centre); camera.updateMatrixWorld()
    const atrium = Object.assign(Object.create(Atrium.prototype), { camera, commons })
    assert.equal(atrium.pickOffice(0, 0), 'director')
    commons.update(1, true); commons.setOffice({ lowEnergy: 1 }); commons.dispose()
  }
})

test('mission packets stay local, validate targets, serialize completion and award XP once', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atrium-missions-'))
  const previous = process.env.AGENT_ATRIUM_OFFICE_FILE
  process.env.AGENT_ATRIUM_OFFICE_FILE = path.join(dir, 'office.json')
  try {
    const { missionAction, observeThreads } = await import(`../server/office.mjs?fixture=${Date.now()}`)
    const threads = [{ id: 'a', title: 'Source', project: 'repo', harness: 'test', preview: 'Existing brief', gitBranch: 'feature' },
      { id: 'b', title: 'Target', project: 'repo', harness: 'test' }]
    assert.equal((await missionAction({ action: 'create', sourceId: 'a', targetId: 'a', brief: 'Review' }, threads))[0], 400)
    assert.equal((await missionAction({ action: 'create', sourceId: 'a', targetId: 'missing', brief: 'Review' }, threads))[0], 400)
    const [code, body] = await missionAction({ action: 'create', sourceId: 'a', targetId: 'b', brief: 'Review the tests' }, threads)
    assert.equal(code, 200); assert.equal(body.mission.status, 'draft'); assert.match(body.mission.packet, /Existing brief/)
    const answers = await Promise.all([missionAction({ action: 'done', id: body.mission.id }, threads), missionAction({ action: 'done', id: body.mission.id }, threads)])
    assert.deepEqual(answers.map(a => a[0]), [200, 409])
    const stored = JSON.parse(await fsp.readFile(process.env.AGENT_ATRIUM_OFFICE_FILE, 'utf8')); assert.equal(stored.xp, 100)
    const data = { observed: {}, events: [] }
    observeThreads(data, threads, now); assert.equal(data.events.length, 0, 'first scan is a baseline')
    observeThreads(data, [{ ...threads[0], running: true }, threads[1]], now + 1); assert.equal(data.events[0].kind, 'working')
  } finally { if (previous === undefined) delete process.env.AGENT_ATRIUM_OFFICE_FILE; else process.env.AGENT_ATRIUM_OFFICE_FILE = previous; await fsp.rm(dir, { recursive: true, force: true }) }
})
