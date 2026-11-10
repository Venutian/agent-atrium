/**
 * The phone door: a second, separate server for the nGen Studio app.
 *
 * The office API answers only its own page on this machine and that does not change. This door
 * is what may be reachable from another device, so it holds a short list of named actions and
 * nothing else: there is no way through it to a path, a command, a thread or Paperclip's own API.
 *
 * It refuses to start without AGENT_ATRIUM_PHONE_TOKEN, and it refuses any request that carries an
 * Origin header, because the app sends none and every browser does. That closes the door on a web
 * page reaching it from a browser on the same network, whatever token that page might guess.
 */
import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { awayFile, noteArrival, readAway } from './lib/away.mjs'
import { changeCounts, changeDetail } from './lib/changes.mjs'
import { cameThroughEdge, edgeFile, readEdge, signPlay } from './lib/edge.mjs'
import { addDevice, deviceView, devicesFile, findDevice, readDevices, retireShared, revokeDevice, touchDevice } from './lib/devices.mjs'
import { guardFolder, readGuard, writeGuard } from './lib/guard.mjs'
import { readPlans } from './lib/plans.mjs'
import {
  PaperclipError, acceptQuestion, addComment, addJob, addRoutine, answerQuestion, cancelJob, chatList, chatThread, decideApproval,
  jobDetail, jobWorkspace, pauseBot, pauseRoutine, proofImage, rejectQuestion, removeRoutine, reopenJob, resumeBot, resumeRoutine,
  routineList, runRoutine, sendChat, stopJob, studioSummary,
} from './lib/paperclip.mjs'
import { PREVIEW_PORT, listPreviews, previewRoot, startPreviews } from './lib/previews.mjs'
import { scanThreads } from './scan.mjs'

const MIN_TOKEN = 32
const MAX_BODY = 16 * 1024
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 5 * 60 * 1000
const SHOWN_SESSIONS = 12
const JOB_ACTIONS = { stop: stopJob, cancel: cancelJob, reopen: reopenJob }
const BOT_ACTIONS = { pause: pauseBot, resume: resumeBot }
const ROUTINE_ACTIONS = { run: runRoutine, pause: pauseRoutine, resume: resumeRoutine, remove: removeRoutine }
const SEEN_EVERY_MS = 60 * 1000
const SESSIONS_TTL_MS = 60 * 1000
const SESSIONS_WAIT_MS = 700

const digest = (value) => createHash('sha256').update(String(value)).digest()
const waitUpTo = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

export function tokenMatches(header, token) {
  const given = /^Bearer (.+)$/.exec(header || '')?.[1]
  return Boolean(given) && timingSafeEqual(digest(given), digest(token))
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendImage(res, { type, bytes }) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': bytes.length,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(bytes)
}

/** The address the app reached this PC on, so links it gets back work from wherever it is. */
const hostOf = (req) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '')
  return /^[\w.-]+$/.test(host) ? host : '127.0.0.1'
}

/** Build links for an app that came through Cloudflare: signed, on the play address. */
const playLink = (cloud) => (cloud ? (key) => `https://${cloud.play}/open/${key}?g=${signPlay(cloud.gate, key)}` : undefined)

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new PaperclipError(413, 'That is too long')
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PaperclipError(400, 'That was not JSON')
  }
}

/** The agent sessions Atrium can see, including those Paperclip did not start. */
async function liveSessions() {
  const threads = await scanThreads()
  return threads
    .filter((t) => t.running)
    .slice(0, SHOWN_SESSIONS)
    .map((t) => ({ title: t.title || 'Session', harness: t.harness, project: t.project || t.cwdName || '' }))
}

export function phoneHandler({ token, paperclip = {}, sessions = liveSessions, previews = previewRoot(), previewPort = PREVIEW_PORT, devices = devicesFile(), guard = guardFolder(), away = awayFile(), edge = edgeFile(), port = 5288 }) {
  const failures = new Map()
  const seen = new Map()
  const options = paperclip.fetcher ? { fetcher: paperclip.fetcher } : undefined

  // The office-wide thread scan walks every transcript on this PC, and here that is hundreds of
  // files: over 18 seconds on 10 November. The phone's first screen only needs the dozen sessions
  // that are running, so the door keeps the last answer and refreshes it behind the request. No
  // /v1/ answer ever waits for the scan.
  const scans = { at: 0, list: null, running: null }
  const scanSessions = () => {
    if (scans.running) return scans.running
    scans.running = Promise.resolve()
      .then(() => sessions())
      .then((list) => {
        scans.at = Date.now()
        scans.list = list
      })
      .catch(() => undefined)
      .finally(() => {
        scans.running = null
      })
    return scans.running
  }
  const recentSessions = async () => {
    const current = scans.list && Date.now() - scans.at < SESSIONS_TTL_MS
    const running = current ? null : scanSessions()
    if (scans.list) return scans.list
    if (running) await Promise.race([running, waitUpTo(SESSIONS_WAIT_MS)])
    return scans.list || []
  }
  // Warm it, so the first summary after a door restart does not go without the list.
  scanSessions()

  const lockedOut = (ip) => {
    const entry = failures.get(ip)
    if (!entry) return false
    if (Date.now() - entry.since > FAILURE_WINDOW_MS) {
      failures.delete(ip)
      return false
    }
    return entry.count >= MAX_FAILURES
  }
  const failed = (ip) => {
    const entry = failures.get(ip) || { count: 0, since: Date.now() }
    entry.count += 1
    failures.set(ip, entry)
  }

  return async (req, res) => {
    // Through Cloudflare every request comes from this PC's tunnel, so wrong keys count against the
    // phone's own address, which the Worker passes on.
    const viaEdge = cameThroughEdge(req)
    const ip = viaEdge ? `edge:${String(req.headers['x-ngen-client'] || '')}` : req.socket?.remoteAddress || ''
    if (req.headers.origin) return send(res, 403, { error: 'The phone door does not answer web pages' })
    if (lockedOut(ip)) return send(res, 429, { error: 'Too many wrong tokens. Try again later' })
    const key = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
    const device = key ? findDevice(devices, key) : null
    if (!device && (readDevices(devices).sharedRetired || !tokenMatches(req.headers.authorization, token))) {
      failed(ip)
      return send(res, 401, { error: 'Wrong or missing token' })
    }
    failures.delete(ip)
    if (device && Date.now() - (seen.get(device.id) || 0) > SEEN_EVERY_MS) {
      seen.set(device.id, Date.now())
      touchDevice(devices, device.id)
    }
    try {
      noteArrival(away, ip)
    } catch (err) {
      console.error('Could not note a visit through the tunnel:', err.message)
    }

    const { pathname } = new URL(req.url, 'http://phone')
    const job = /^\/v1\/jobs\/([^/]+)$/.exec(pathname)
    const comment = /^\/v1\/jobs\/([^/]+)\/comments$/.exec(pathname)
    const changes = /^\/v1\/jobs\/([^/]+)\/changes$/.exec(pathname)
    const proof = /^\/v1\/proof\/([^/]+)$/.exec(pathname)
    const jobAction = /^\/v1\/jobs\/([^/]+)\/(stop|cancel|reopen)$/.exec(pathname)
    const question = /^\/v1\/jobs\/([^/]+)\/questions\/([^/]+)\/(respond|accept|reject)$/.exec(pathname)
    const routineAction = /^\/v1\/routines\/([^/]+)\/(run|pause|resume|remove)$/.exec(pathname)
    const deviceRevoke = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(pathname)
    const botAction = /^\/v1\/bots\/([^/]+)\/(pause|resume)$/.exec(pathname)
    const decision = /^\/v1\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname)
    const chat = /^\/v1\/chats\/([^/]+)$/.exec(pathname)
    const chatMessage = /^\/v1\/chats\/([^/]+)\/messages$/.exec(pathname)
    try {
      // The app knocks here on each address it knows, and keeps the one that answers first.
      if (pathname === '/v1/hello' && req.method === 'GET') {
        const tunnel = readAway(away)
        const cloud = readEdge(edge)
        return send(res, 200, {
          away: tunnel ? `${tunnel.address}:${port}` : null,
          edge: cloud ? { host: `https://${cloud.studio}`, gate: cloud.gate } : null,
        })
      }
      if (pathname === '/v1/summary' && req.method === 'GET') {
        const [summary, live, plans] = await Promise.all([studioSummary(options), recentSessions(), readPlans()])
        const limits = readGuard(guard)
        const tunnel = readAway(away)
        const notices = [
          ...(limits.tripped ? [{ kind: 'blocked', id: '', title: 'Claude bots are paused', detail: 'The token guard stopped them at your limit. Raise it or turn it off in Studio.' }] : []),
          ...(tunnel?.changed ? [{ kind: 'blocked', id: '', title: 'Your home internet address changed', detail: `Away access needs it. In the WireGuard app, edit the nGen tunnel and set Endpoint to ${tunnel.endpoint}:${tunnel.port}.` }] : []),
        ]
        return send(res, 200, { ...summary, needsYou: [...notices, ...summary.needsYou], sessions: live, guard: limits, plans })
      }
      if (pathname === '/v1/jobs' && req.method === 'POST') {
        return send(res, 201, await addJob(await readBody(req), options))
      }
      if (job && req.method === 'GET') {
        const [detail, workspace, builds] = await Promise.all([
          jobDetail(job[1], options),
          jobWorkspace(job[1], options),
          listPreviews(job[1], { root: previews, host: hostOf(req), port: previewPort, link: viaEdge ? playLink(readEdge(edge)) : undefined }),
        ])
        return send(res, 200, { ...detail, changes: await changeCounts(workspace ?? undefined), previews: builds })
      }
      if (changes && req.method === 'GET') {
        const detail = await changeDetail((await jobWorkspace(changes[1], options)) ?? undefined)
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'This job has no branch to read' })
      }
      if (proof && req.method === 'GET') return sendImage(res, await proofImage(proof[1], options))
      if (comment && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 201, await addComment(comment[1], body.text, options))
      }
      if (pathname === '/v1/routines' && req.method === 'GET') return send(res, 200, { routines: await routineList(options) })
      if (pathname === '/v1/routines' && req.method === 'POST') return send(res, 201, await addRoutine(await readBody(req), options))
      if (routineAction && req.method === 'POST') return send(res, 200, await ROUTINE_ACTIONS[routineAction[2]](routineAction[1], options))
      if (pathname === '/v1/guard' && req.method === 'POST') return send(res, 200, writeGuard(guard, await readBody(req)))
      if (pathname === '/v1/devices' && req.method === 'GET') {
        const state = readDevices(devices)
        const tunnel = readAway(away)
        return send(res, 200, {
          sharedActive: !state.sharedRetired,
          current: device?.id || null,
          devices: state.devices.map(deviceView),
          away: tunnel && { address: tunnel.address, up: tunnel.up, changed: tunnel.changed },
        })
      }
      if (pathname === '/v1/devices' && req.method === 'POST') return send(res, 201, addDevice(devices, (await readBody(req)).name))
      if (pathname === '/v1/devices/retire-shared' && req.method === 'POST') {
        if (!device) return send(res, 409, { error: 'Update this device to its own key first' })
        retireShared(devices)
        return send(res, 200, { ok: true })
      }
      if (deviceRevoke && req.method === 'POST') {
        if (device?.id === deviceRevoke[1]) return send(res, 409, { error: 'That is the device you are using' })
        revokeDevice(devices, deviceRevoke[1])
        return send(res, 200, { ok: true })
      }
      if (jobAction && req.method === 'POST') return send(res, 200, await JOB_ACTIONS[jobAction[2]](jobAction[1], options))
      if (botAction && req.method === 'POST') return send(res, 200, await BOT_ACTIONS[botAction[2]](botAction[1], options))
      if (question && req.method === 'POST') {
        const [, jobId, questionId, verb] = question
        const body = await readBody(req)
        if (verb === 'respond') return send(res, 200, await answerQuestion(jobId, questionId, body.answers, options))
        if (verb === 'accept') return send(res, 200, await acceptQuestion(jobId, questionId, options))
        return send(res, 200, await rejectQuestion(jobId, questionId, body.reason, options))
      }
      if (decision && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 200, await decideApproval(decision[1], decision[2], body.note, options))
      }
      if (pathname === '/v1/chats' && req.method === 'GET') return send(res, 200, { bots: await chatList(options) })
      if (chat && req.method === 'GET') return send(res, 200, await chatThread(chat[1], options))
      if (chatMessage && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 201, await sendChat(chatMessage[1], body.text, body.requestId, options))
      }
      return send(res, 404, { error: 'Unknown endpoint' })
    } catch (err) {
      const status = err instanceof PaperclipError ? err.status : 500
      return send(res, status >= 400 && status < 600 ? status : 502, { error: err.message || 'Something went wrong' })
    }
  }
}

export function startPhoneDoor(env = process.env) {
  const token = env.AGENT_ATRIUM_PHONE_TOKEN || ''
  if (token.length < MIN_TOKEN) {
    throw new Error(`Set AGENT_ATRIUM_PHONE_TOKEN to at least ${MIN_TOKEN} characters to open the phone door`)
  }
  const host = env.AGENT_ATRIUM_PHONE_HOST || '127.0.0.1'
  const port = Number(env.AGENT_ATRIUM_PHONE_PORT) || 5288
  const previews = previewRoot(env)
  const previewPort = Number(env.AGENT_ATRIUM_PREVIEW_PORT) || PREVIEW_PORT
  const server = http.createServer(phoneHandler({ token, previews, previewPort, away: awayFile(env), edge: edgeFile(env), port }))
  server.listen(port, host, () => console.log(`Agent Atrium phone door → http://${host}:${port}`))
  startPreviews({ root: previews, host, port: previewPort })
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    startPhoneDoor()
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}
