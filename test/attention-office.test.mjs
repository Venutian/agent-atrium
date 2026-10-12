import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withEnv } from './support/env.mjs'
import { AttentionAlerts } from '../src/ui/alerts.js'
import * as THREE from 'three'
import { OFFICES, createOfficeFloor, floorHeight } from '../src/world/offices.js'
import { Plot, DECK_TOP } from '../src/world/plots.js'
import { Atrium } from '../src/game/atrium.js'
import { Hud, shortPath } from '../src/ui/hud.js'

test('Codex disk merge excludes children, reviewers and disk-only helpers, and reads the database name', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atrium-codex-'))
  try {
    await withEnv({ CODEX_HOME: dir }, async () => {
      const db = new DatabaseSync(path.join(dir, 'state_99.sqlite'))
      db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, name TEXT, source TEXT, thread_source TEXT); CREATE TABLE thread_spawn_edges (child_thread_id TEXT)')
      const ids = Array.from({ length: 5 }, (_, i) => `019cc762-45a2-7112-89cd-cd345c17e83${i}`)
      const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)')
      insert.run(ids[0], path.resolve('demo'), '<environment_context>old title', 'Fix Expo runtime getDevServer', 'vscode', 'user')
      insert.run(ids[1], path.resolve('demo'), 'Child', '', 'cli', null)
      insert.run(ids[2], path.resolve('demo'), 'Reviewer', '', '{"subagent":{"other":"guardian"}}', null)
      db.prepare('INSERT INTO thread_spawn_edges VALUES (?)').run(ids[1])
      db.close()
      const day = path.join(dir, 'sessions', '2026', '10', '11')
      const repo = path.join(dir, 'repo')
      const cwd = path.join(repo, 'src')
      await fsp.mkdir(path.join(repo, '.git'), { recursive: true })
      await fsp.mkdir(cwd, { recursive: true })
      await fsp.mkdir(day, { recursive: true })
      for (let i = 0; i < ids.length; i++) {
        const records = [
          { type: 'session_meta', payload: { cwd, source: i === 3 ? { subagent: { other: 'guardian' } } : 'cli' } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: '<environment_context>setup</environment_context>' } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Real task' } },
          { type: 'event_msg', payload: { type: i === 4 ? 'task_started' : 'task_complete' } },
        ]
        await fsp.writeFile(path.join(day, `rollout-${ids[i]}.jsonl`), records.map(JSON.stringify).join('\n') + '\n')
      }
      const { default: codex } = await import(`../server/harnesses/codex.mjs?fixture=${dir}`)
      const threads = await codex.scanThreads()
      assert.deepEqual(threads.map((t) => t.id), [ids[0], ids[4]].map((id) => `codex:${id}`))
      assert.equal(threads[0].title, 'Fix Expo runtime getDevServer')
      assert.equal(threads[0].preview, 'Real task')
      assert.equal(threads[0].unread, true)
      assert.equal(threads[1].running, true)
      assert.equal(threads[1].unread, false)
      assert.equal(threads[1].title, 'Real task')
      assert.equal(threads[1].project, 'repo', 'subdirectory sessions show the actual repository')
      assert.equal(threads[1].projectPath, repo)
      assert.equal(threads[1].cwd, cwd, 'Open resumes in the original working directory')
    })
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('status files survive malformed writes, expire working state and refuse executable links', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atrium-status-'))
  try {
    await withEnv({ AGENT_ATRIUM_STATUS_DIR: dir }, async () => {
      const write = (name, data) => fsp.writeFile(path.join(dir, `${name}.json`), JSON.stringify(data))
      await write('working', { id: 'worker', title: 'Build', cwd: process.cwd(), status: 'working', updatedAt: Date.now() - 3600000, url: 'javascript:alert(1)' })
      await write('waiting', { id: 'waiter', status: 'waiting', project: 'My repo', url: 'https://example.com/task' })
      await write('bad', { id: '../bad', status: 'working' })
      await fsp.writeFile(path.join(dir, 'partial.json'), '{')
      const { default: adapter } = await import(`../server/harnesses/status-files.mjs?fixture=${dir}`)
      assert.equal(await adapter.detect(), true)
      const threads = await adapter.scanThreads()
      assert.equal(threads.length, 2)
      assert.equal(threads.find((t) => t.id.endsWith('worker')).running, false)
      assert.equal(threads.find((t) => t.id.endsWith('worker')).canOpen, false)
      assert.equal(threads.find((t) => t.id.endsWith('waiter')).unread, true)
      assert.equal(adapter.openThread({ url: 'file:///C:/Windows/system32/cmd.exe' }).ok, false)
      assert.equal(adapter.openThread({ url: 'https://example.com/task' }).ok, true)
    })
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('attention title works without notifications, alerts arrive once per new wait and clicks select the bot', () => {
  const sent = []
  let selected
  class Notification {
    static permission = 'granted'
    constructor(title, options) { this.title = title; this.options = options; sent.push(this) }
    close() {}
  }
  const document = { title: '', hidden: true }
  const alerts = new AttentionAlerts({ document, Notification, onClick: (id) => { selected = id } })
  const t = { id: '1', project: 'repo', title: 'Task', unread: true, lastActivityAt: 1 }
  alerts.update([t], true)
  assert.match(document.title, /1 need you/)
  assert.equal(sent.length, 0, 'reloads do not alert about old waits')
  alerts.update([t], true)
  assert.equal(sent.length, 0)
  alerts.update([{ ...t, lastActivityAt: 2 }], true)
  assert.equal(sent.length, 1)
  sent[0].onclick()
  assert.equal(selected, '1')
  alerts.update([], true)
  assert.equal(document.title, 'Agent Atrium')
  alerts.update([t], false)
  assert.equal(sent.length, 1)
  // Blocked bots are counted on their own, the way the panel counts them.
  alerts.update([t, { ...t, id: '2', hasError: true, lastActivityAt: Date.now() }], false)
  assert.equal(document.title, '(1 need you · 1 blocked) Agent Atrium')
  // An error from long ago is not something to drop everything for.
  alerts.update([{ ...t, id: '3', hasError: true, unread: false, lastActivityAt: Date.now() - 30 * 86400000 }], false)
  assert.equal(document.title, 'Agent Atrium')
  alerts.update([{ ...t, running: true }], false)
  assert.equal(document.title, 'Agent Atrium', 'a running thread is working, not waiting')
})

test('paths are shortened from the left in their own separator, home folded to ~', () => {
  assert.equal(shortPath('C:\\Users\\YoelM\\IdeaProjects\\venus'), '~\\IdeaProjects\\venus')
  assert.equal(shortPath('/Users/someone/code/app'), '~/code/app')
  assert.equal(shortPath('D:\\work\\clients\\northwind\\services\\billing-api'), '…\\services\\billing-api')
  assert.ok(!shortPath('C:\\Users\\YoelM\\a\\very\\long\\path\\to\\some\\repo').includes('/'))
})

test('office floors agree with walking height', () => {
  const floor = createOfficeFloor(OFFICES.glass)
  assert.equal(floor.geometry.attributes.position.getY(0).toFixed(2), floorHeight().toFixed(2))
  assert.ok(floorHeight() < DECK_TOP && DECK_TOP - floorHeight() < 0.15, 'rooms are a low step up from the open floor')
  const plot = new Plot({ id: 'repo', name: 'repo', index: 0, cells: [{ q: 1, r: 0 }], accent: 0x778899, style: OFFICES.night })
  assert.doesNotThrow(() => plot.setNight(1, true, 0))
  assert.equal(plot.deck.material.metalness, 0)
  plot.dispose()
  floor.geometry.dispose(); floor.material.dispose()
})

test('style switching preserves buildings and archive, hidden and viewed roster input', () => {
  const atrium = Object.create(Atrium.prototype)
  atrium.style = OFFICES.glass
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
  atrium.buildings = new Map([['1', { mesh }]])
  let removed = 0
  atrium.worldGroup = { remove() { removed++ } }
  atrium.reflections = { invalidate() {} }
  const lit = []
  atrium.sky = { setStyle(style) { lit.push(style.id) } }
  atrium._buildTerrain = () => {}
  const args = [[{ id: '1', unread: false }], new Set(['archived']), new Set(['hidden']), new Set(['known'])]
  atrium._lastRoster = args
  let rosters = 0
  atrium.setThreads = (...actual) => { rosters++; assert.deepEqual(actual, args) }
  atrium.setStyle('night')
  atrium.setStyle('night')
  atrium.setStyle('missing-style')
  assert.equal(removed, 0, 'style changes preserve the existing buildings')
  assert.equal(atrium.buildings.get('1').mesh, mesh)
  assert.deepEqual(lit, ['night', 'glass'], 'an unknown style falls back to the default, and a repeat is a no-op')
  assert.equal(rosters, 2)
})

test('selecting a bot shows its own repository, working directory and branch in the card', () => {
  const elements = new Map()
  const hud = Object.create(Hud.prototype)
  hud.$ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { classList: { add() {}, remove() {}, toggle() {} }, style: { setProperty() {} }, offsetWidth: 300, offsetHeight: 220 })
    return elements.get(selector)
  }
  hud.actions = { progressFor: () => 0.5 }
  hud.isPhone = () => false
  const thread = { id: 'bot', title: 'Fix checkout', project: 'storefront', cwd: 'C:\\work\\storefront\\src', gitBranch: 'fix-checkout', harnessName: 'Codex', unread: true }
  hud.setSelection({ status: 'waiting', trim: { getHex: () => 0x778899 } }, thread)
  assert.equal(hud.$('.thread-pop .repo-name').textContent, 'storefront')
  assert.equal(hud.$('.thread-pop .repo-path').textContent, thread.cwd)
  assert.match(hud.$('.thread-pop .meta').innerHTML, /fix-checkout/)
  assert.equal(hud.$('.thread-pop .title').textContent, 'Fix checkout')
})

test('repository signs stay visible on quiet zones and respect the labels and hide-UI controls', () => {
  const atrium = Object.create(Atrium.prototype)
  const label = { material: { opacity: 0 }, visible: false }
  atrium.plotOrder = [{ id: 'quiet', label }]
  atrium.uiVisible = true
  let show = true
  atrium.settings = { get: () => show }
  atrium._updateLabels(1)
  assert.equal(label.visible, true)
  atrium.uiVisible = false
  atrium._updateLabels(1)
  assert.equal(label.visible, false)
  atrium.uiVisible = true
  show = false
  atrium._updateLabels(1)
  assert.equal(label.visible, false)
})
