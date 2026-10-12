/** Native VS Code / Copilot Chat, including BYOK and local models. Read-only.
 * Supports the old JSON snapshots and the current JSONL object-mutation journal.
 * Sources: microsoft/vscode chatSessionStore.ts, objectMutationLog.ts, chatUri.ts.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { exists, listDirs, listFiles } from '../lib/fsutil.mjs'
import { editorWindow, sessionIdValid, vscodeFolderUrl, vscodeSessionUrl } from '../lib/vscode-links.mjs'

const MAX_BYTES = 32 * 1024 * 1024
const cache = new Map()
const clean = text => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
let sqlitePromise

async function sessionIndex(file) {
  const sqlite = await (sqlitePromise ??= import('node:sqlite').catch(() => null))
  if (!sqlite?.DatabaseSync || !await exists(file)) return {}
  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('chat.ChatSessionStore.index')
    const index = row ? JSON.parse(row.value) : {}
    return index.entries && typeof index.entries === 'object' ? index.entries : {}
  } catch { return {} } finally { db?.close() }
}

function roots() {
  if (process.env.AGENT_ATRIUM_VSCODE_USER_DIR) return [{ dir: process.env.AGENT_ATRIUM_VSCODE_USER_DIR, scheme: 'vscode' }]
  const home = os.homedir()
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return [{ dir: path.join(base, 'Code', 'User'), scheme: 'vscode' }, { dir: path.join(base, 'Code - Insiders', 'User'), scheme: 'vscode-insiders' }]
}

/** Reject unsafe mutation paths rather than ever walking an object's prototype. */
export function replayChatJournal(text) {
  let state
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue
    let record
    try { record = JSON.parse(lines[index]) } catch {
      if (index === lines.length - 1) break // incomplete append; retain committed records
      return null
    }
    if (record.kind === 0) { state = record.v; continue }
    const keys = record.k
    if (!state || !Array.isArray(keys) || !keys.length || keys.length > 64 || keys.some(k =>
      !(typeof k === 'string' || Number.isInteger(k) && k >= 0) || ['__proto__', 'prototype', 'constructor'].includes(k))) return null
    let parent = state
    for (const key of keys.slice(0, -1)) {
      if (!parent || !Object.hasOwn(parent, key)) return null
      parent = parent[key]
    }
    if (!parent || typeof parent !== 'object') return null
    const key = keys.at(-1)
    if (record.kind === 1) parent[key] = record.v
    else if (record.kind === 3) delete parent[key]
    else if (record.kind === 2) {
      const array = parent[key] ?? []
      if (!Array.isArray(array) || record.v !== undefined && !Array.isArray(record.v)) return null
      if (record.i !== undefined) {
        if (!Number.isInteger(record.i) || record.i < 0 || record.i > array.length) return null
        array.length = record.i
      }
      for (const value of record.v || []) array.push(value)
      parent[key] = array
    } else return null
  }
  return state && typeof state === 'object' && !Array.isArray(state) ? state : null
}

function localPath(uri) {
  if (typeof uri !== 'string') return ''
  try { return uri.startsWith('file:') ? fileURLToPath(uri) : path.isAbsolute(uri) ? uri : '' } catch { return '' }
}

async function readSession(file, stat) {
  const previous = cache.get(file)
  if (previous?.mtime === stat.mtimeMs && previous.size === stat.size) return previous.data
  if (stat.size > MAX_BYTES) return null
  try {
    const text = await fsp.readFile(file, 'utf8')
    const raw = file.endsWith('.jsonl') ? replayChatJournal(text) : JSON.parse(text)
    if (!raw || typeof raw !== 'object') return null
    // Cache only metadata and the first/last request, never entire conversations.
    const requests = Array.isArray(raw.requests) ? raw.requests : []
    const first = requests.find(r => !r.isSystemInitiated && !r.requestHiddenFromTranscript)
    const request = r => r && ({ message: r.message, modelId: r.modelId, timestamp: r.timestamp,
      responseTimestamp: r.responseTimestamp, modelState: r.modelState, isCanceled: r.isCanceled,
      response: r.response === undefined ? undefined : [],
      result: r.result?.errorDetails ? { errorDetails: true } : undefined,
      responseErrorDetails: Boolean(r.responseErrorDetails) })
    const data = { sessionId: raw.sessionId, creationDate: raw.creationDate, customTitle: raw.customTitle,
      computedTitle: raw.computedTitle, title: raw.title, workingDirectory: raw.workingDirectory,
      isSubagent: raw.isSubagent, parentSessionId: raw.parentSessionId, isArchived: raw.isArchived,
      repoData: { branchName: raw.repoData?.branchName },
      inputState: { selectedModel: { metadata: { name: raw.inputState?.selectedModel?.metadata?.name }, identifier: raw.inputState?.selectedModel?.identifier } },
      requests: first ? [request(first), request(requests.at(-1))] : [] }
    cache.set(file, { mtime: stat.mtimeMs, size: stat.size, data })
    return data
  } catch { return null }
}

async function workspaceOf(dir) {
  try {
    const workspace = JSON.parse(await fsp.readFile(path.join(dir, 'workspace.json'), 'utf8'))
    const folder = localPath(workspace.folder)
    if (folder) return { cwd: folder, openPath: folder }
    const configPath = localPath(workspace.workspace)
    if (configPath) {
      // JSONC permits comments and trailing commas; extract folder path entries only.
      const text = await fsp.readFile(configPath, 'utf8')
      const match = /"path"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)
      const folderPath = match ? JSON.parse(match[1]) : ''
      return { cwd: folderPath ? path.resolve(path.dirname(configPath), folderPath) : '', openPath: configPath }
    }
  } catch { /* unavailable workspace */ }
  return { cwd: '', openPath: '' }
}

async function repository(cwd) {
  if (!cwd) return { project: 'VS Code Chat', projectPath: '' }
  let dir = cwd
  while (dir) {
    if (await exists(path.join(dir, '.git'))) return { project: path.basename(dir), projectPath: dir }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { project: path.basename(cwd), projectPath: cwd }
}

async function stores() {
  const out = []
  for (const root of roots()) {
    for (const dir of await listDirs(path.join(root.dir, 'workspaceStorage'))) {
      out.push({ ...root, folder: path.join(dir, 'chatSessions'), workspace: await workspaceOf(dir), indexFile: path.join(dir, 'state.vscdb') })
    }
    out.push({ ...root, folder: path.join(root.dir, 'globalStorage', 'emptyWindowChatSessions'), workspace: { cwd: '', openPath: '' }, indexFile: path.join(root.dir, 'globalStorage', 'state.vscdb') })
  }
  return out
}

async function scanThreads() {
  const out = new Map(), seen = new Set(), projects = new Map()
  for (const store of await stores()) {
    const index = await sessionIndex(store.indexFile)
    for (const file of await listFiles(store.folder, n => /\.jsonl?$/.test(n))) {
      if (seen.size >= 4096) break
      seen.add(file)
      const stat = await fsp.stat(file).catch(() => null)
      if (!stat) continue
      const data = await readSession(file, stat)
      const requests = data?.requests
      if (!Array.isArray(requests) || !requests.length || data.isSubagent || data.parentSessionId) continue
      const id = data.sessionId || path.basename(file).replace(/\.jsonl?$/, '')
      if (!sessionIdValid(id)) continue
      const indexed = index[id] || Object.values(index).find(e => e?.sessionId === id)
      if (indexed?.isExternal) continue
      const last = requests.at(-1), first = requests.find(r => !r.isSystemInitiated && !r.requestHiddenFromTranscript)
      if (!first) continue
      const prompt = clean(typeof first.message === 'string' ? first.message : first.message?.text)
      const title = clean(data.customTitle || indexed?.title || data.computedTitle || data.title || prompt) || 'VS Code chat'
      const cwd = localPath(data.workingDirectory) || store.workspace.cwd
      if (!projects.has(cwd)) projects.set(cwd, await repository(cwd))
      const activity = Number(indexed?.lastMessageDate) || Math.max(Number(last.responseTimestamp) || Number(last.timestamp) || 0, stat.mtimeMs)
      const state = indexed?.lastResponseState ?? last.modelState?.value
      const cancelled = state === 2 || state === undefined && last.isCanceled
      const hasError = state === 3 || Boolean(last.result?.errorDetails || last.responseErrorDetails)
      const fresh = Date.now() - activity < 30 * 60 * 1000
      const running = !cancelled && !hasError && state !== 4 && fresh && (state === 0 || state === undefined && last.response === undefined)
      const unread = !running && !cancelled && (state === 4 || Date.now() - activity < 24 * 60 * 60 * 1000)
      const openPath = store.workspace.openPath || cwd
      const thread = {
        id: `vscode-chat:${id}`, title: title.slice(0, 120), preview: prompt.slice(0, 240),
        ...projects.get(cwd), cwd, worktree: '', gitBranch: data.repoData?.branchName || '',
        model: clean(last.modelId || data.inputState?.selectedModel?.metadata?.name || data.inputState?.selectedModel?.identifier),
        effort: '', createdAt: Number(data.creationDate) || stat.birthtimeMs, lastActivityAt: activity,
        lastFocusedAt: 0, unread, running, hasError, archived: Boolean(data.isArchived),
        starred: false, routine: '', prState: '', sizeBytes: stat.size, source: 'vscode',
        canOpen: Boolean(vscodeSessionUrl(openPath, id, store.scheme)),
        ref: { sessionId: id, cwd, openPath, scheme: store.scheme },
      }
      if (!out.has(id) || out.get(id).lastActivityAt < activity) out.set(id, thread)
    }
  }
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file)
  return [...out.values()]
}

function openThread(ref) {
  const folder = ref?.openPath || ref?.cwd
  const url = vscodeSessionUrl(folder, ref?.sessionId, ref?.scheme || 'vscode')
  return url
    ? { ok: true, url, window: editorWindow(ref?.cwd || folder, ref?.scheme || 'vscode') }
    : { ok: false, error: 'This VS Code chat has no local workspace to open' }
}

function newSession(cwd) {
  const url = vscodeFolderUrl(cwd)
  return url ? { ok: true, url, note: 'Opened the workspace in VS Code; start a new chat there.' } : { ok: false, error: 'No local VS Code workspace' }
}

export default {
  id: 'vscode-chat', name: 'VS Code Chat', scanThreads, openThread, newSession,
  detect: async () => (await Promise.all(roots().flatMap(r => [exists(path.join(r.dir, 'workspaceStorage')), exists(path.join(r.dir, 'globalStorage', 'emptyWindowChatSessions'))]))).some(Boolean),
  paths: {},
}
