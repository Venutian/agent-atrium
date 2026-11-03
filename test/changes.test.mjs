import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { changeCounts, changeDetail } from '../server/lib/changes.mjs'

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-changes-'))
  const git = (...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\ntwo\n')
  git('add', '.')
  git('commit', '-qm', 'First')
  git('checkout', '-qb', 'job-1')
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\n2\n')
  fs.writeFileSync(path.join(cwd, 'b.bin'), Buffer.from([0, 1, 2, 0]))
  git('add', '.')
  git('commit', '-qm', 'Change a file')
  return { cwd, git, workspace: { cwd, branch: 'job-1', base: 'main' } }
}

test('changes are counted per job branch', async () => {
  const { workspace } = repo()
  assert.deepEqual(await changeCounts(workspace), { files: 2, added: 1, removed: 1 })
})

test('the detail lists commits and patches, and marks binary files', async () => {
  const { workspace } = repo()
  const detail = await changeDetail(workspace)
  assert.deepEqual(detail.commits.map((c) => c.subject), ['Change a file'])
  assert.deepEqual(detail.files.map((f) => f.path), ['a.txt', 'b.bin'])
  assert.match(detail.files[0].patch, /^-two$/m)
  assert.match(detail.files[0].patch, /^\+2$/m)
  assert.equal(detail.files[0].patch.includes('diff --git'), false)
  assert.equal(detail.files[1].binary, true)
  assert.equal(detail.cut, false)
})

test('a very long file is cut, and says so', async () => {
  const { cwd, git, workspace } = repo()
  fs.writeFileSync(path.join(cwd, 'long.txt'), 'line\n'.repeat(40000))
  git('add', '.')
  git('commit', '-qm', 'Long')
  const detail = await changeDetail(workspace)
  assert.equal(detail.cut, true)
  assert.ok(detail.files.find((f) => f.path === 'long.txt').patch.length <= 60 * 1024)
})

test('unsafe or unknown refs read as nothing', async () => {
  const { cwd, workspace } = repo()
  assert.equal(await changeCounts({ cwd, branch: '--output=/tmp/x', base: 'main' }), null)
  assert.equal(await changeDetail({ cwd, branch: 'a..b', base: 'main' }), null)
  assert.equal(await changeDetail({ cwd: 'relative', branch: 'job-1', base: 'main' }), null)
  assert.equal(await changeCounts({ ...workspace, branch: 'missing' }), null)
  assert.equal(await changeCounts(undefined), null)
})

test('settings a bot could plant in the repository do not run', async () => {
  const { cwd, git, workspace } = repo()
  const flag = path.join(cwd, 'ran')
  const program = path.join(cwd, 'evil.sh')
  fs.writeFileSync(program, `#!/bin/sh\ntouch ${flag}\n`, { mode: 0o755 })
  git('config', 'core.fsmonitor', program)
  git('config', 'diff.external', program)
  git('config', 'core.pager', program)
  git('config', 'gpg.program', program)
  git('config', 'log.showSignature', 'true')
  fs.writeFileSync(path.join(cwd, '.gitattributes'), '*.txt diff=evil\n')
  git('config', 'diff.evil.textconv', program)
  git('config', 'diff.evil.command', program)
  const detail = await changeDetail(workspace)
  assert.equal(detail.commits.length, 1)
  assert.equal(fs.existsSync(flag), false)
})
