import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { withEnv } from './support/env.mjs'
import chat, { replayChatJournal } from '../server/harnesses/vscode-chat.mjs'
import codex from '../server/harnesses/codex.mjs'
import claude from '../server/harnesses/claude-code.mjs'
import { vscodeSessionUrl, vscodeExtensionUrl, vscodeFolderUrl } from '../server/lib/vscode-links.mjs'

const uuid = '019cc762-45a2-7112-89cd-cd345c17e834'
const uuid2 = '019cc762-45a2-7112-89cd-cd345c17e835'
const journal = records => records.map(JSON.stringify).join('\n') + '\n'

test('native chat journals replay append, replace, truncate and delete and reject prototype paths', () => {
  const state = replayChatJournal(journal([
    { kind: 0, v: { requests: [], inputState: { draft: 'old' } } },
    { kind: 2, k: ['requests'], v: [{ message: 'one' }, { message: 'two' }] },
    { kind: 1, k: ['requests', 0, 'message'], v: 'edited' },
    { kind: 2, k: ['requests'], i: 1, v: [{ message: 'replacement' }] },
    { kind: 3, k: ['inputState', 'draft'] },
  ]) + '{"kind":')
  assert.deepEqual(state, { requests: [{ message: 'edited' }, { message: 'replacement' }], inputState: {} })
  assert.equal(replayChatJournal(journal([{ kind: 0, v: {} }, { kind: 1, k: ['__proto__', 'polluted'], v: true }])), null)
  assert.equal({}.polluted, undefined)
  assert.equal(replayChatJournal(journal([{ kind: 0, v: { requests: [] } }, { kind: 2, k: ['requests'], i: -1 }])), null)
})

test('VS Code reads local models, real repository roots, saved titles and state index, without mutating chat files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atrium-vscode-'))
  try {
    await withEnv({ AGENT_ATRIUM_VSCODE_USER_DIR: root }, async () => {
      const repo = path.join(root, 'repo'), cwd = path.join(repo, 'src')
      await fs.mkdir(path.join(repo, '.git'), { recursive: true })
      await fs.mkdir(cwd)
      const workspace = path.join(root, 'workspaceStorage', 'abc'), dir = path.join(workspace, 'chatSessions')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(cwd).href }))
      const file = path.join(dir, `${uuid}.jsonl`)
      const bytes = journal([
        { kind: 0, v: { sessionId: uuid, requests: [], creationDate: Date.now(), inputState: { selectedModel: { metadata: { name: 'Local llama' } } } } },
        { kind: 2, k: ['requests'], v: [{ message: { text: 'Build search' }, response: [], modelState: { value: 2 } }] },
        { kind: 1, k: ['customTitle'], v: 'Search with Ollama' },
      ])
      await fs.writeFile(file, bytes)
      await fs.writeFile(path.join(dir, `${uuid2}.json`), JSON.stringify({ sessionId: uuid2, requests: [{ message: 'Legacy chat', response: ['Done'], isCanceled: true }] }))
      await fs.writeFile(path.join(dir, 'empty.json'), JSON.stringify({ sessionId: '019cc762-45a2-7112-89cd-cd345c17e836', requests: [] }))
      await fs.writeFile(path.join(dir, 'broken.jsonl'), '{bad}\n')
      const db = new DatabaseSync(path.join(workspace, 'state.vscdb'))
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
      // The journal serializes in-flight turns as cancelled; the index preserves their state.
      db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('chat.ChatSessionStore.index', JSON.stringify({ version: 1, entries: { [uuid]: { sessionId: uuid, lastResponseState: 0, lastMessageDate: Date.now() } } }))
      db.close()
      assert.equal(await chat.detect(), true)
      const threads = await chat.scanThreads()
      assert.equal(threads.length, 2)
      const t = threads.find(t => t.id === `vscode-chat:${uuid}`)
      assert.equal(t.title, 'Search with Ollama')
      assert.equal(t.model, 'Local llama')
      assert.equal(t.project, 'repo')
      assert.equal(t.projectPath, repo)
      assert.equal(t.cwd, cwd)
      assert.equal(t.running, true)
      assert.equal(t.unread, false)
      assert.equal(threads.find(t => t.id.endsWith(uuid2)).unread, false)
      const opened = chat.openThread(t.ref)
      assert.equal(opened.ok, true)
      assert.equal(new URL(opened.url).searchParams.get('session'), `vscode-local-chat-session://local/${Buffer.from(uuid).toString('base64url')}`)
      assert.equal(await fs.readFile(file, 'utf8'), bytes)
      assert.deepEqual(await chat.scanThreads(), threads, 'cached reads preserve results')
    })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('VS Code links are constrained to real session identifiers and safe encoded workspace paths', async () => {
  const folder = path.resolve('work # & project')
  const url = vscodeSessionUrl(folder, uuid)
  assert.ok(url.includes('%23') && url.includes('%26'))
  assert.equal(vscodeSessionUrl('relative', uuid), '')
  assert.equal(vscodeSessionUrl(folder, [uuid]), '')
  assert.equal(vscodeSessionUrl(folder, uuid, 'javascript'), '')
  assert.equal(chat.openThread({ sessionId: uuid, cwd: 'relative' }).ok, false)
  assert.equal(vscodeExtensionUrl('codex', '../bad'), '')
  const codexIDE = await codex.openThread({ sessionId: uuid, cwd: folder, source: 'vscode' })
  assert.equal(codexIDE.url, `vscode://openai.chatgpt/local/${uuid}`)
  const codexDesktop = await codex.openThread({ sessionId: uuid, cwd: folder })
  assert.equal(codexDesktop.url, `codex://threads/${uuid}`)
  const claudeIDE = await claude.openThread({ cliSessionId: uuid, cwd: folder, source: 'vscode', desktopSessionId: `local_${uuid}` })
  assert.equal(claudeIDE.url, `vscode://anthropic.claude-code/open?session=${uuid}`)
  assert.equal(claudeIDE.pid, 0, 'IDE links are not replaced by terminal focusing')
  const claudeDesktop = await claude.openThread({ cliSessionId: uuid, cwd: folder, desktopSessionId: `local_${uuid}` })
  assert.equal(claudeDesktop.url, `claude://claude.ai/epitaxy/local_${uuid}`)
  // A VS Code session first fronts the window holding its folder; a desktop one does not.
  assert.equal(codexIDE.focusUrl, vscodeFolderUrl(folder))
  assert.equal(claudeIDE.focusUrl, vscodeFolderUrl(folder))
  assert.ok(!codexDesktop.focusUrl && !claudeDesktop.focusUrl)
})
