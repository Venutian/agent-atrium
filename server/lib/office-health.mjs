import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findExecutable } from './fsutil.mjs'

const exec = promisify(execFile)
const cache = new Map()
let executables
async function bins() {
  return executables ??= Promise.all([
    findExecutable('git'),
    findExecutable('gh', process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI')] : []),
    findExecutable('nvidia-smi', process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : []),
  ])
}
async function command(bin, args, options = {}) {
  if (!bin) throw new Error('Not installed')
  return (await exec(bin, args, { timeout: 4000, maxBuffer: 512 * 1024, windowsHide: true, ...options })).stdout.trim()
}

export function githubRepo(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote || '')
  return match?.[1] || ''
}
export function checksState(checks) {
  if (!checks?.length) return 'unknown'
  const results = checks.map(c => String(c.conclusion || c.state || c.status || '').toUpperCase())
  if (results.some(v => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'CANCELLED'].includes(v))) return 'failed'
  if (results.some(v => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(v))) return 'running'
  return results.every(v => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) ? 'passed' : 'unknown'
}

async function repositoryHealth(dir, name) {
  const [git, gh] = await bins()
  const result = { project: name, path: dir, observedAt: Date.now(), branch: '', changedFiles: null, tests: 'unknown',
    checks: 'unknown', pr: null, commit: null, status: 'unknown', message: '' }
  if (!dir || !path.isAbsolute(dir)) return { ...result, message: 'No local repository folder' }
  const gitArgs = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'log.showSignature=false', '-C', dir]
  try {
    const status = await command(git, [...gitArgs, 'status', '--porcelain=v1', '--branch', '--untracked-files=all'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    const lines = status.split('\n')
    result.branch = lines[0].replace(/^## (?:No commits yet on |Initial commit on )?/, '').split('...')[0].trim()
    result.changedFiles = lines.slice(1).filter(Boolean).length
    result.status = result.changedFiles ? 'in-progress' : 'clear'
    const commit = await command(git, [...gitArgs, 'log', '-1', '--format=%h%n%s%n%ct']).catch(() => '')
    if (commit) { const [sha, title, seconds] = commit.split('\n'); result.commit = { sha, title: title.slice(0, 200), at: Number(seconds) * 1000 } }
    const remote = await command(git, [...gitArgs, 'remote', 'get-url', 'origin']).catch(() => '')
    const repo = githubRepo(remote)
    if (repo && gh && result.branch && !result.branch.startsWith('HEAD ') && !result.branch.startsWith('-')) {
      const key = `${repo}:${result.branch}`
      let entry = cache.get(key)
      if (!entry || Date.now() - entry.at > 5 * 60 * 1000) {
        let pr = null
        try {
          const raw = JSON.parse(await command(gh, ['pr', 'view', result.branch, '--repo', repo, '--json', 'number,title,state,url,statusCheckRollup,mergedAt']))
          pr = { number: raw.number, title: String(raw.title || '').slice(0, 200), state: raw.mergedAt ? 'MERGED' : raw.state,
            url: /^https:\/\/github\.com\//.test(raw.url) ? raw.url : '', checks: checksState(raw.statusCheckRollup) }
        } catch { /* No PR, no authentication or network unavailable: never invent a passing check. */ }
        let checks = pr?.checks || 'unknown'
        if (checks === 'unknown') {
          const ref = encodeURIComponent(result.branch)
          const checkRuns = await command(gh, ['api', `repos/${repo}/commits/${ref}/check-runs`, '--jq', '.check_runs']).then(JSON.parse).catch(() => [])
          const statuses = await command(gh, ['api', `repos/${repo}/commits/${ref}/status`, '--jq', '.statuses']).then(JSON.parse).catch(() => [])
          checks = checksState([...checkRuns, ...statuses])
        }
        entry = { at: Date.now(), pr, checks }; cache.set(key, entry)
      }
      result.pr = entry.pr
      result.checks = entry.checks || 'unknown'
      result.remoteRepo = repo
    }
    // Optional producer file: report actual local test results without executing repo code.
    const file = path.join(dir, '.agent-atrium', 'health.json')
    const stat = await fsp.stat(file).catch(() => null)
    if (stat?.isFile() && stat.size < 16384) {
      const health = JSON.parse(await fsp.readFile(file, 'utf8'))
      const reportedAt = typeof health.updatedAt === 'number' ? health.updatedAt : stat.mtimeMs
      if (['passed', 'failed', 'running'].includes(health.tests)) {
        result.tests = health.tests; result.testsAt = reportedAt
        result.testsStale = Date.now() - reportedAt > 24 * 60 * 60 * 1000
      }
    }
    if (result.checks === 'failed' || result.tests === 'failed' && !result.testsStale) result.status = 'blocked'
    else if (result.pr?.state === 'MERGED' && !result.changedFiles) result.status = 'shipped'
  } catch { result.message = 'Git health unavailable'; }
  return result
}

const repoCache = new Map()
export function repositoryKey(value) {
  const plain = String(value || '').replace(/^\\\\\?\\(?=[A-Za-z]:)/, '')
  return /^[A-Za-z]:[\\/]/.test(plain) ? plain.replaceAll('\\', '/').toLowerCase() : plain
}
export async function repoHealth(threads) {
  const projects = [...new Map(threads.filter(t => !t.parentId).map(t => [repositoryKey(t.projectPath || t.cwd || t.project), t])).values()]
  const out = []
  // Two reads at a time keeps a large office from spawning dozens of Git/GitHub processes.
  for (let index = 0; index < projects.length; index += 2) {
    out.push(...await Promise.all(projects.slice(index, index + 2).map(async t => {
      const key = repositoryKey(t.projectPath || t.cwd || t.project)
      let cached = repoCache.get(key)
      if (!cached || Date.now() - cached.at > 60000) {
        cached = { at: Date.now(), data: await repositoryHealth(t.projectPath || t.cwd, t.project) }
        repoCache.set(key, cached)
      }
      return { ...cached.data, project: t.project }
    })))
  }
  for (const key of repoCache.keys()) if (!projects.some(t => repositoryKey(t.projectPath || t.cwd || t.project) === key)) repoCache.delete(key)
  return out
}

export async function probeLocalModel(name, url, kind, fetcher = fetch) {
  const start = performance.now()
  try {
    const target = new URL(url)
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) throw new Error('Loopback only')
    const response = await fetcher(target, { signal: AbortSignal.timeout(1800), redirect: 'error' })
    if (!response.ok) return { name, status: response.status === 401 || response.status === 403 ? 'auth-required' : 'offline', observedAt: Date.now(), models: [] }
    const text = await response.text()
    if (text.length > 1024 * 1024) throw new Error('Oversized model list')
    const data = JSON.parse(text)
    if (!Array.isArray(kind === 'ollama' ? data.models : data.data)) throw new Error('Not a model-list response')
    const models = kind === 'ollama' ? (data.models || []).map(m => ({ name: String(m.name || m.model || 'Unknown').slice(0, 160),
      vramBytes: Number.isFinite(m.size_vram) ? m.size_vram : null, contextTokens: Number.isFinite(m.context_length) ? m.context_length : null, loaded: true }))
      : (data.data || []).map(m => ({ name: String(m.id || 'Unknown').slice(0, 160), vramBytes: null, contextTokens: null, loaded: null }))
    return { name, status: 'online', latencyMs: Math.round(performance.now() - start), observedAt: Date.now(), models: models.slice(0, 50) }
  } catch { return { name, status: 'offline', observedAt: Date.now(), models: [] } }
}

let localCache
export async function localModelHealth() {
  if (localCache && Date.now() - localCache.at < 30000) return localCache.data
  const probes = await Promise.all([
    probeLocalModel('Ollama', 'http://127.0.0.1:11434/api/ps', 'ollama'),
    probeLocalModel('LM Studio', 'http://127.0.0.1:1234/v1/models', 'openai'),
  ])
  const [, , nvidia] = await bins()
  let gpus = []
  if (nvidia) {
    const csv = await command(nvidia, ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits']).catch(() => '')
    gpus = csv.split('\n').filter(Boolean).map(line => {
      const [name, total, used, utilization] = line.split(',').map(v => v.trim())
      const number = v => /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : null
      return { name, totalMiB: number(total), usedMiB: number(used), utilization: number(utilization) }
    })
  }
  const data = { servers: probes, gpus, observedAt: Date.now() }
  localCache = { at: Date.now(), data }
  return data
}
