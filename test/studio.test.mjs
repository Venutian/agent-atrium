/**
 * The studio map folds a scan of job worktrees into project rooms. These tests pin which threads
 * reach the floor, whose helper each one is, and where each bot of the crew stands.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { studioRoster } from '../server/lib/studio.mjs'

const NOW = Date.parse('2026-11-10T13:00:00Z')
const ago = (minutes) => NOW - minutes * 60_000
const records = {
  projects: [
    { id: 'p-aldis', name: 'Aldis', primaryWorkspace: { cwd: '/home/o/aldis' } },
    { id: 'p-studio', name: 'nGen Studio', workspaces: [{ cwd: '/home/o/studio' }] },
  ],
  agents: [{ id: 'fred', name: 'Fred' }, { id: 'tony', name: 'Tony' }, { id: 'critic', name: 'Critic' }],
  issues: [
    { identifier: 'NGE-7', title: 'Town kit', status: 'in_progress', projectId: 'p-aldis', assigneeAgentId: 'fred' },
    { identifier: 'NGE-8', title: 'Old job', status: 'cancelled', projectId: 'p-aldis', assigneeAgentId: 'fred' },
    { identifier: 'NGE-9', title: 'Door fix', status: 'blocked', projectId: 'p-studio', assigneeAgentId: 'tony' },
  ],
}
const manager = {
  bots: [
    { id: 'fred', name: 'Fred', title: 'Builder', status: 'running', model: 'DeepSeek', where: 'free', why: '', projectId: 'p-aldis', job: { id: 'j7', ref: 'ALD-7', title: 'Town kit', stage: 'Building', minutes: 4 }, last: null },
    { id: 'tony', name: 'Tony', title: 'Director', status: 'idle', model: 'Sonnet 5.5', where: 'Claude', why: '', projectId: 'p-studio', job: null, last: { id: 'j9', ref: 'STU-9', title: 'Door fix', at: ago(50) } },
    { id: 'critic', name: 'Critic', title: '', status: 'paused', model: 'Opus 5.5', where: 'Claude', why: 'Paused by hand', projectId: '', job: null, last: null },
  ],
}
const thread = (id, cwd, extra = {}) => ({
  id, harness: 'opencode', harnessName: 'OpenCode', title: 'Agent instructions for this run were loaded', cwd, projectPath: cwd,
  createdAt: ago(300), lastActivityAt: ago(5), running: false, unread: true, usage: { totalTokens: 9 }, ref: { id }, ...extra,
})
const roster = (threads, extra = {}) => studioRoster({ threads, manager, records, now: NOW, ...extra })
const byId = (list, id) => list.find((t) => t.id === id)

test('a job worktree is a helper of the bot on that job, in the project room', () => {
  const list = roster([thread('a', '/home/o/aldis/.paperclip/worktrees/NGE-7-town-kit', { running: true })])
  const helper = byId(list, 'a')
  assert.deepEqual([helper.project, helper.owner, helper.job, helper.title, helper.unread, helper.running], ['Aldis', 'Fred', 'ALD-7', 'ALD-7 Town kit', false, true])
  assert.ok(helper.size < 1)
  assert.equal(helper.usage, undefined)
})

test('each bot of the crew is a character in the room of its job', () => {
  const list = roster([])
  const fred = byId(list, 'crew:fred:p-aldis')
  assert.deepEqual([fred.project, fred.title, fred.running, fred.crew.job.ref, fred.canOpen], ['Aldis', 'Fred', true, 'ALD-7', false])
  assert.ok(fred.size > 1)
  const tony = byId(list, 'crew:tony:p-studio')
  assert.deepEqual([tony.project, tony.running, tony.hasError, tony.preview], ['nGen Studio', false, true, 'Last on STU-9 Door fix'])
  const critic = byId(list, 'crew:critic:none')
  assert.equal(critic.project, 'Crew room')
  assert.ok(NOW - critic.lastActivityAt > 3 * 24 * 3600_000, 'a paused bot is asleep')
})

test('old threads, closed jobs and work outside every project stay off the floor', () => {
  const list = roster([
    thread('stale', '/home/o/aldis/.paperclip/worktrees/NGE-7-town-kit', { lastActivityAt: ago(45) }),
    thread('closed', '/home/o/aldis/.paperclip/worktrees/NGE-8-old', { running: true, lastActivityAt: ago(45) }),
    thread('mine', '/home/o/studio/app', { lastActivityAt: ago(100), title: 'Home screen' }),
    thread('mine-old', '/home/o/studio', { lastActivityAt: ago(300) }),
    thread('tmp', '/tmp/x'),
    thread('tmp-live', '/tmp/y', { running: true, title: 'A scratch run' }),
    thread('gone', '/home/o/aldis', { archived: true }),
  ]).filter((t) => !t.crew)
  assert.deepEqual(list.map((t) => [t.id, t.project, t.unread]), [['mine', 'nGen Studio', true], ['tmp-live', 'Other work', true]])
})

test('a job worked in several sittings is one helper, and a repo that holds a project\'s worktrees is its room', () => {
  const list = roster([
    thread('first', '/home/o/aldis/.paperclip/worktrees/NGE-7-town-kit', { lastActivityAt: ago(20) }),
    thread('second', '/home/o/aldis/.paperclip/worktrees/NGE-7-town-kit', { lastActivityAt: ago(2) }),
    thread('door', '/home/o/door/.paperclip/worktrees/NGE-9-door', { running: true }),
    thread('door-main', '/home/o/door', { title: 'Mine' }),
    thread('linked', '/home/o/tools', { title: 'Tools' }),
  ], { linked: new Map([['/home/o/tools', 'p-aldis']]) }).filter((t) => !t.crew)
  assert.deepEqual(list.map((t) => [t.id, t.project]).sort(), [['door', 'nGen Studio'], ['door-main', 'nGen Studio'], ['linked', 'Aldis'], ['second', 'Aldis']])
})
