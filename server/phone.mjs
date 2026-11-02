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
import { PaperclipError, addComment, addJob, chatList, chatThread, decideApproval, jobDetail, sendChat, studioSummary } from './lib/paperclip.mjs'
import { scanThreads } from './scan.mjs'

const MIN_TOKEN = 32
const MAX_BODY = 16 * 1024
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 5 * 60 * 1000
const SHOWN_SESSIONS = 12

const digest = (value) => createHash('sha256').update(String(value)).digest()

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

export function phoneHandler({ token, paperclip = {}, sessions = liveSessions }) {
  const failures = new Map()
  const options = paperclip.fetcher ? { fetcher: paperclip.fetcher } : undefined

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
    const ip = req.socket?.remoteAddress || ''
    if (req.headers.origin) return send(res, 403, { error: 'The phone door does not answer web pages' })
    if (lockedOut(ip)) return send(res, 429, { error: 'Too many wrong tokens. Try again later' })
    if (!tokenMatches(req.headers.authorization, token)) {
      failed(ip)
      return send(res, 401, { error: 'Wrong or missing token' })
    }
    failures.delete(ip)

    const { pathname } = new URL(req.url, 'http://phone')
    const job = /^\/v1\/jobs\/([^/]+)$/.exec(pathname)
    const comment = /^\/v1\/jobs\/([^/]+)\/comments$/.exec(pathname)
    const decision = /^\/v1\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname)
    const chat = /^\/v1\/chats\/([^/]+)$/.exec(pathname)
    const chatMessage = /^\/v1\/chats\/([^/]+)\/messages$/.exec(pathname)
    try {
      if (pathname === '/v1/summary' && req.method === 'GET') {
        const [summary, live] = await Promise.all([studioSummary(options), sessions()])
        return send(res, 200, { ...summary, sessions: live })
      }
      if (pathname === '/v1/jobs' && req.method === 'POST') {
        return send(res, 201, await addJob(await readBody(req), options))
      }
      if (job && req.method === 'GET') return send(res, 200, await jobDetail(job[1], options))
      if (comment && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 201, await addComment(comment[1], body.text, options))
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
  const server = http.createServer(phoneHandler({ token }))
  server.listen(port, host, () => console.log(`Agent Atrium phone door → http://${host}:${port}`))
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
