/**
 * The office as a studio: rooms are Paperclip projects, the crew's bots are the characters in them,
 * and the sessions working for a bot are its small helpers.
 *
 * On only where Paperclip runs on this machine. Without it the office is what it always was: one
 * room per folder, one bot per thread. With it, a thread scan of hundreds of worktrees (one folder
 * per job, so one room per job) is folded into the handful of projects those jobs belong to, old
 * threads stay off the floor, and each bot of the crew stands in the project of the job it is on.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { managerWithRecords } from './manager.mjs'
import { refOf, withRefs } from './paperclip.mjs'

const HOUR_MS = 60 * 60 * 1000
const FRESH_MS = 24 * HOUR_MS
/** Your own session stays on the floor for a few hours after it stops; scripts' one-word probes age out with it. */
const OWN_FRESH_MS = 3 * HOUR_MS
/** A bot's session that has stopped is history within the half hour; the job's line tells the rest. */
const BOT_FRESH_MS = HOUR_MS / 2
const CLOSED = new Set(['done', 'cancelled'])
/** Past the office's own "nothing for three days" line, so a paused bot sits down and sleeps. */
const ASLEEP_MS = 4 * 24 * HOUR_MS
const SHOWN_SESSIONS = 10
const SHOWN_TITLE = 90
const SHOWN_PREVIEW = 200
const CREW_ROOM = 'Crew room'
const OTHER_ROOM = 'Other work'
/** A job's worktree: `<repo>/.paperclip/worktrees/NGE-12-what-it-is`. */
const WORKTREE = /^(.*)[\\/]\.paperclip[\\/]worktrees[\\/]([A-Z]+-\d+)/
const CREW_SIZE = 1.3
const SESSION_SIZE = 0.7
const FRESH_STUDIO_MS = 3_000

const short = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const folderOf = (project) => (project.primaryWorkspace || project.workspaces?.[0])?.cwd || ''
const inside = (dir, folder) => dir === folder || dir.startsWith(`${folder}/`)

/** Which project a folder belongs to: the deepest project folder it sits in. */
function projectAt(dir, folders) {
  let best = ''
  for (const folder of folders.keys()) if (inside(dir, folder) && folder.length > best.length) best = folder
  return folders.get(best) || ''
}

/**
 * The threads the map draws. `threads` is the office's scan, `manager` and `records` come from
 * `managerWithRecords`. Pure, so the tests can pin it.
 */
export function studioRoster({ threads, manager, records, linked = new Map(), now = Date.now() }) {
  const projectNames = new Map(records.projects.map((p) => [p.id, p.name]))
  const botNames = new Map(records.agents.map((a) => [a.id, a.name]))
  const jobs = new Map(records.issues.map((i) => [i.identifier, i]))
  const folders = new Map([...linked, ...records.projects.map((p) => [folderOf(p), p.id]).filter(([folder]) => folder)])
  // A repo that holds a project's job worktrees is that project's too, though Paperclip only
  // lists one folder per project: the studio app and its server are one project in two repos.
  const located = threads.map((t) => {
    const dir = t.cwd || t.projectPath || ''
    const [, root, identifier] = WORKTREE.exec(dir) || []
    return { thread: t, dir, root, job: jobs.get(identifier) }
  })
  for (const { root, job } of located) if (root && job?.projectId && !folders.has(root)) folders.set(root, job.projectId)

  const rooms = new Map()
  for (const { thread, dir, job } of located) {
    if (thread.archived) continue
    // A harness can go on calling a session live after its job was closed under it.
    const running = thread.running === true && !CLOSED.has(job?.status)
    if (!running && now - (thread.lastActivityAt || 0) > (job ? BOT_FRESH_MS : OWN_FRESH_MS)) continue
    const projectId = job?.projectId || projectAt(dir, folders)
    // Work outside every project is only worth a place on the map while it is happening.
    if (!projectId && !running) continue
    const room = projectNames.get(projectId) || OTHER_ROOM
    const ref = job ? refOf(job, projectNames) : ''
    // A bot's session is titled by the harness from its first lines, which are its instructions.
    const title = short(withRefs(job?.title || thread.title || 'Untitled'), SHOWN_TITLE)
    const session = {
      id: thread.id, harness: thread.harness, harnessName: thread.harnessName, ref: thread.ref, source: thread.source,
      title: ref && !title.includes(ref) ? `${ref} ${title}` : title,
      preview: short(thread.preview || '', SHOWN_PREVIEW),
      project: room, projectPath: thread.projectPath, cwd: thread.cwd, worktree: thread.worktree, gitBranch: thread.gitBranch,
      model: thread.model, createdAt: thread.createdAt, lastActivityAt: thread.lastActivityAt,
      running, hasError: thread.hasError === true, prState: thread.prState || '',
      // A bot's session asks its bot, not you: only your own sessions can be waiting on you.
      unread: job ? false : thread.unread === true,
      canOpen: thread.canOpen, archived: false, size: SESSION_SIZE,
      owner: job ? botNames.get(job.assigneeAgentId) || '' : '', job: ref,
    }
    if (!rooms.has(room)) rooms.set(room, [])
    rooms.get(room).push(session)
  }
  // One helper per job and bot: a job worked in five sittings is still one piece of work.
  for (const [room, list] of rooms) {
    const newest = new Map()
    for (const s of list.sort((a, b) => a.lastActivityAt - b.lastActivityAt)) newest.set(s.job ? `${s.job}\u0000${s.owner}` : s.id, s)
    rooms.set(room, [...newest.values()])
  }
  const sessions = [...rooms.values()].flatMap((list) => list
    .sort((a, b) => Number(b.running) - Number(a.running) || b.lastActivityAt - a.lastActivityAt)
    .slice(0, SHOWN_SESSIONS))

  const blocked = new Set(records.issues.filter((i) => i.status === 'blocked').map((i) => i.assigneeAgentId))
  const crew = manager.bots.map((bot, index) => {
    const room = projectNames.get(bot.projectId) || CREW_ROOM
    const running = bot.status === 'running'
    return {
      // The room is part of who this is on the map: a bot given a job in another project walks
      // out of one room and into the other, instead of its desk sliding across the floor.
      id: `crew:${bot.id}:${bot.projectId || 'none'}`,
      harness: 'crew', harnessName: bot.title || 'Crew', source: 'crew', ref: null, canOpen: false,
      title: bot.name,
      preview: bot.job ? `${bot.job.stage}: ${bot.job.title}` : bot.why || (bot.last ? `Last on ${bot.last.ref} ${bot.last.title}` : ''),
      project: room, projectPath: '', cwd: '', worktree: '', gitBranch: '', model: bot.model,
      // Before any session, so the crew keep the first desks of a room.
      createdAt: index + 1,
      lastActivityAt: running ? now : bot.status === 'paused' ? now - ASLEEP_MS : Math.max(bot.last?.at || 0, now - FRESH_MS),
      running, hasError: !running && bot.status !== 'paused' && blocked.has(bot.id), prState: '', unread: false, archived: false,
      size: CREW_SIZE,
      crew: { id: bot.id, name: bot.name, title: bot.title, status: bot.status, model: bot.model, where: bot.where, why: bot.why, job: bot.job, last: bot.last },
    }
  })
  return [...crew, ...sessions]
}

const linkSeen = new Map()

/**
 * Repos that hold a project's job worktrees without a session in one right now, read from disk.
 * Looked up once per folder: a repo does not change project.
 */
async function linkedFolders(threads, records) {
  const jobs = new Map(records.issues.map((i) => [i.identifier, i.projectId]))
  const linked = new Map()
  for (const folder of new Set(threads.map((t) => t.projectPath).filter(Boolean))) {
    if (!linkSeen.has(folder)) {
      const names = await fsp.readdir(path.join(folder, '.paperclip', 'worktrees')).catch(() => [])
      const owner = names.map((name) => jobs.get(/^[A-Z]+-\d+/.exec(name)?.[0])).find(Boolean)
      linkSeen.set(folder, owner || '')
    }
    if (linkSeen.get(folder)) linked.set(folder, linkSeen.get(folder))
  }
  return linked
}

let studioCache = null
let studioRefresh = null

/**
 * What the map polls: the roster and the manager's view in one small answer. The last one is
 * served while the next is worked out behind it, so the page never waits on Paperclip or git.
 */
export async function studioView({ scan, now = Date.now, ...options }) {
  const refresh = () => {
    studioRefresh ||= Promise.all([scan(), managerWithRecords({ now: now(), ...options })])
      .then(async ([threads, { manager, records }]) => {
        const fresh = threads.filter((t) => t.running || now() - (t.lastActivityAt || 0) < FRESH_MS)
        const linked = await linkedFolders(fresh, records)
        studioCache = { at: now(), view: { on: true, threads: studioRoster({ threads: fresh, manager, records, linked, now: now() }), manager, scannedAt: now() } }
        return studioCache.view
      })
      .finally(() => { studioRefresh = null })
    return studioRefresh
  }
  if (!studioCache) return refresh()
  if (now() - studioCache.at > FRESH_STUDIO_MS) refresh().catch(() => {})
  return studioCache.view
}
