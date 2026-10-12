import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withEnv } from './support/env.mjs'
import { focusAppWindow } from '../server/lib/focus.mjs'
import { editorWindow, plainPath, vscodeFolderUrl } from '../server/lib/vscode-links.mjs'
import codex from '../server/harnesses/codex.mjs'
import claude from '../server/harnesses/claude-code.mjs'

const uuid = '0f3d2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6'

test('folder links keep the drive colon and drop the extended-length prefix', () => {
  assert.equal(vscodeFolderUrl('C:\\work\\my repo'), 'vscode://file/C:/work/my%20repo')
  assert.equal(vscodeFolderUrl('\\\\?\\C:\\Users\\me\\New folder'), 'vscode://file/C:/Users/me/New%20folder')
  assert.equal(plainPath('\\\\?\\D:\\x'), 'D:\\x')
  assert.equal(plainPath('\\\\?\\UNC\\server\\share'), '\\\\?\\UNC\\server\\share', 'network paths are left alone')
  assert.equal(vscodeFolderUrl('/home/me/app'), 'vscode://file/home/me/app')
})

test('every open names the window the thread lives in', async () => {
  const folder = path.resolve('fixture-repo')
  const inEditor = await claude.openThread({ cliSessionId: uuid, cwd: folder, source: 'vscode' })
  assert.deepEqual(inEditor.window, editorWindow(folder))
  assert.equal(inEditor.window.title, 'fixture-repo')
  const desktop = await claude.openThread({ cliSessionId: uuid, cwd: folder, desktopSessionId: `local_${uuid}` })
  assert.ok(desktop.window.names.includes('claude'))
  const codexDesktop = await codex.openThread({ sessionId: uuid, cwd: folder })
  assert.ok(codexDesktop.window.names.includes('ChatGPT'), 'the Codex desktop app runs as ChatGPT.exe on Windows')
})

test('window focusing refuses names that could reach a shell', async () => {
  assert.equal(await focusAppWindow({ names: ["Code'; rm -rf /"], title: 'x' }), false)
  assert.equal(await focusAppWindow({ names: [] }), false)
  assert.equal(await focusAppWindow(null), false)
})

test('on Linux the matching window is raised with wmctrl, preferring the title', { skip: process.platform !== 'linux' }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atrium-focus-'))
  try {
    const log = path.join(dir, 'calls')
    const fake = path.join(dir, 'wmctrl')
    await fsp.writeFile(fake, `#!/bin/sh
if [ "$1" = "-lx" ]; then
  echo "0x01 0 code.Code host other-repo - Visual Studio Code"
  echo "0x02 0 code.Code host my-repo - Visual Studio Code"
  echo "0x03 0 claude.Claude host Claude"
else
  echo "$@" >> "${log}"
fi
`, { mode: 0o755 })
    await withEnv({ PATH: dir }, async () => {
      assert.equal(await focusAppWindow({ names: ['Code', 'code'], title: 'my-repo' }), true)
      assert.equal(await focusAppWindow({ names: ['claude', 'Claude'], title: '' }), true)
    })
    assert.deepEqual((await fsp.readFile(log, 'utf8')).trim().split('\n'), ['-i -a 0x02', '-i -a 0x03'])
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})
