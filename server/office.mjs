import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { repoHealth, localModelHealth, repositoryKey } from './lib/office-health.mjs'

const FILE = process.env.AGENT_ATRIUM_OFFICE_FILE || path.join(process.env.AGENT_ATRIUM_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'), 'office.json')
let memory, pending = Promise.resolve(), scanPending
let health = [], healthPending, healthAt = 0
async function load() {
  if (memory) return memory
  const raw = await fsp.readFile(FILE, 'utf8').then(JSON.parse).catch(() => ({}))
  memory = { version: 1, initialized: Boolean(raw.initialized || Object.keys(raw.observed || {}).length), xp: Math.max(0, Number(raw.xp) || 0), firstObservedAt: Number(raw.firstObservedAt) || Date.now(),
    observed: raw.observed && typeof raw.observed === 'object' && !Array.isArray(raw.observed) ? raw.observed : {},
    events: Array.isArray(raw.events) ? raw.events.slice(-500) : [], missions: Array.isArray(raw.missions) ? raw.missions.slice(-100) : [] }
  return memory
}
async function save(data) {
  await fsp.mkdir(path.dirname(FILE), { recursive: true })
  const temporary = `${FILE}.${randomUUID()}.tmp`
  await fsp.writeFile(temporary, JSON.stringify(data), 'utf8')
  await fsp.rename(temporary, FILE)
}
function serial(fn) { const next = pending.then(fn, fn); pending = next.catch(() => {}); return next }
function event(data, record) {
  data.events.push({ id: randomUUID(), at: Date.now(), ...record })
  data.events = data.events.slice(-500)
}
export function phase(thread) { return thread.hasError ? 'blocked' : thread.running ? 'working' : thread.unread ? 'waiting' : thread.archived ? 'archived' : 'idle' }
export function observeThreads(data, threads, now = Date.now()) {
  const first = !data.initialized
  let changed = first
  const next = {}
  for (const t of threads) {
    const current = { phase: phase(t), title: t.title, project: t.project, model: t.model, activity: t.lastActivityAt, tokens: t.usage?.known ? t.usage.totalTokens : null }
    const before = data.observed[t.id]
    next[t.id] = current
    if (!first && (!before || before.phase !== current.phase || before.title !== current.title || before.activity !== current.activity)) {
      const kind = !before ? 'arrival' : before.phase !== current.phase ? current.phase : 'activity'
      data.events.push({ id: randomUUID(), at: now, threadId: t.id, project: t.project, title: t.title, model: t.model,
        kind, tokens: before?.tokens != null && current.tokens != null ? Math.max(0, current.tokens - before.tokens) : null })
      changed = true
    }
    if (JSON.stringify(before) !== JSON.stringify(current)) changed = true
  }
  if (!first) for (const [id, before] of Object.entries(data.observed)) if (!next[id]) {
    data.events.push({ id: randomUUID(), at: now, threadId: id, project: before.project, title: before.title, kind: 'departure' })
    changed = true
  }
  data.initialized = true
  data.observed = next
  data.events = data.events.slice(-500)
  return changed
}
export async function officeSnapshot(threads) {
  if (scanPending) return scanPending
  scanPending = (async () => {
    const history = await serial(async () => {
      const data = await load()
      if (observeThreads(data, threads)) await save(data)
      return { events: [...data.events].reverse(), missions: [...data.missions].reverse(), xp: data.xp, firstObservedAt: data.firstObservedAt }
    })
    if (!healthPending && Date.now() - healthAt > 30000) {
      healthPending = repoHealth(threads).then(async next => {
        if (health.length) {
          const before = new Map(health.map(r => [repositoryKey(r.path), r]))
          const updates = next.filter(r => before.has(repositoryKey(r.path)) &&
            (r.pr?.state === 'MERGED' && before.get(repositoryKey(r.path)).pr?.state !== 'MERGED' || r.checks === 'failed' && before.get(repositoryKey(r.path)).checks !== 'failed'))
          if (updates.length) await serial(async () => {
            const data = await load()
            for (const r of updates) event(data, { kind: r.checks === 'failed' ? 'build-failed' : 'pr-merged', project: r.project, title: r.pr?.title || r.commit?.title || 'Repository health changed' })
            await save(data)
          })
        }
        health = next; healthAt = Date.now()
      }).catch(() => {}).finally(() => { healthPending = null })
    }
    const localModels = await localModelHealth()
    return { ...history, health, healthChecking: Boolean(healthPending), localModels, observedAt: Date.now() }
  })().finally(() => { scanPending = null })
  return scanPending
}

export async function missionAction(body, threads) {
  return serial(async () => {
    const data = await load()
    if (body.action === 'create') {
      const source = threads.find(t => t.id === body.sourceId && !t.parentId && !t.archived)
      const target = threads.find(t => t.id === body.targetId && !t.parentId && !t.archived)
      const brief = typeof body.brief === 'string' ? body.brief.trim() : ''
      if (!source || !target || source.id === target.id || !brief || brief.length > 8000) return [400, { error: 'Choose two different live sessions and a brief of 1–8000 characters.' }]
      const mission = { id: randomUUID(), sourceId: source.id, targetId: target.id, sourceTitle: source.title, targetTitle: target.title,
        project: target.project, createdAt: Date.now(), status: 'draft', brief,
        packet: `Agent Atrium handoff\n\nFrom: ${source.harnessName || source.harness} — ${source.title}\nRepository: ${source.project}\nBranch: ${source.gitBranch || 'not recorded'}\nContext: ${source.preview || 'No preview recorded'}\n\nTo: ${target.harnessName || target.harness} — ${target.title}\nRepository: ${target.project}\n\nMission:\n${brief}\n\nReview this brief and ask for any missing context before making changes.` }
      data.missions.push(mission); data.missions = data.missions.slice(-100)
      event(data, { kind: 'mission-created', project: target.project, title: brief.slice(0, 160), threadId: target.id })
      await save(data)
      return [200, { mission }]
    }
    const mission = data.missions.find(m => m.id === body.id)
    if (!mission || !['delivered', 'done', 'cancelled'].includes(body.action)) return [400, { error: 'Unknown mission or action' }]
    if (['done', 'cancelled'].includes(mission.status)) return [409, { error: 'This mission is already closed' }]
    if (body.action === 'delivered' && mission.status !== 'draft') return [409, { error: 'This mission was already delivered' }]
    mission.status = body.action; mission.updatedAt = Date.now()
    if (body.action === 'done') data.xp += 100
    event(data, { kind: `mission-${body.action}`, project: mission.project, title: mission.brief.slice(0, 160), threadId: mission.targetId })
    await save(data)
    return [200, { mission }]
  })
}
