/**
 * The local Paperclip server, seen through its own API.
 *
 * Paperclip is a service with a public API, not a harness with a store, so "Agent Atrium never
 * writes to a harness" is not in question here: nothing on disk is touched, and the only writes
 * are the ones a person asks for by name (add a job, comment on one, decide an approval, or say
 * something to a bot in chat).
 *
 * Everything here returns plain shapes the phone can render. Paperclip's own records carry
 * adapter configuration and paths, and none of that is passed on.
 */
const BASE = (process.env.AGENT_ATRIUM_PAPERCLIP_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '')
const COMPANY = process.env.AGENT_ATRIUM_PAPERCLIP_COMPANY || ''
const TIME_LIMIT_MS = 10_000

export const MAX_TITLE = 200
export const MAX_TEXT = 8000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUNNING = new Set(['in_progress'])
const QUEUED = new Set(['backlog', 'todo'])
const FINISHED = new Set(['done', 'cancelled'])
const SHOWN_DONE = 10
const SHOWN_MESSAGES = 100

export class PaperclipError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function call(path, { method = 'GET', body, fetcher = fetch } = {}) {
  let res
  try {
    res = await fetcher(`${BASE}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIME_LIMIT_MS),
    })
  } catch {
    throw new PaperclipError(503, 'Paperclip is not running on this machine')
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* a non-JSON error page */ }
  if (!res.ok) throw new PaperclipError(res.status, json?.error || `Paperclip answered ${res.status}`)
  return json
}

async function companyId(options) {
  if (COMPANY) return COMPANY
  const companies = await call('/companies', options)
  const active = companies.find((c) => c.status === 'active') || companies[0]
  if (!active) throw new PaperclipError(404, 'Paperclip has no company yet')
  return active.id
}

const botView = (agent, liveAgents) => ({
  id: agent.id,
  name: agent.name,
  title: agent.title || '',
  status: liveAgents.has(agent.id) ? 'running' : agent.status,
  model: agent.adapterConfig?.model || '',
  spentCents: agent.spentMonthlyCents || 0,
})

const jobView = (issue, names) => ({
  id: issue.id,
  ref: issue.identifier || '',
  title: issue.title,
  status: issue.status,
  bot: names.get(issue.assigneeAgentId) || '',
  updatedAt: issue.lastActivityAt || issue.updatedAt || issue.createdAt,
})

function needsYou({ approvals, issues, names, failedRuns }) {
  const items = approvals.map((a) => ({
    kind: 'approval',
    id: a.id,
    title: a.payload?.title || a.payload?.name || a.type,
    detail: a.requestedByAgentId ? `Asked by ${names.get(a.requestedByAgentId) || 'a bot'}` : '',
  }))
  for (const issue of issues) {
    if (issue.status === 'blocked' || issue.status === 'in_review') {
      items.push({
        kind: issue.status === 'blocked' ? 'blocked' : 'review',
        id: issue.id,
        title: `${issue.identifier || ''} ${issue.title}`.trim(),
        detail: names.get(issue.assigneeAgentId) || '',
      })
    }
  }
  if (failedRuns > 0) {
    items.push({ kind: 'failed', id: '', title: `${failedRuns} failed run${failedRuns === 1 ? '' : 's'}`, detail: 'Open Paperclip to see why' })
  }
  return items
}

/** Everything the phone's first screen needs, in one call. */
export async function studioSummary(options) {
  const id = await companyId(options)
  const [company, agents, issues, approvals, dashboard, badges, live] = await Promise.all([
    call(`/companies/${id}`, options),
    call(`/companies/${id}/agents`, options),
    call(`/companies/${id}/issues`, options),
    call(`/companies/${id}/approvals?status=pending`, options),
    call(`/companies/${id}/dashboard`, options),
    call(`/companies/${id}/sidebar-badges`, options),
    call(`/companies/${id}/live-runs`, options),
  ])
  const names = new Map(agents.map((a) => [a.id, a.name]))
  const liveAgents = new Set(live.map((run) => run.agentId))
  const byNewest = [...issues].sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
  return {
    company: company.name,
    bots: agents.map((a) => botView(a, liveAgents)),
    needsYou: needsYou({ approvals, issues, names, failedRuns: badges?.failedRuns || 0 }),
    running: byNewest.filter((i) => RUNNING.has(i.status)).map((i) => jobView(i, names)),
    queued: byNewest.filter((i) => QUEUED.has(i.status)).map((i) => jobView(i, names)),
    finished: byNewest.filter((i) => FINISHED.has(i.status)).slice(0, SHOWN_DONE).map((i) => jobView(i, names)),
    spentCents: dashboard?.costs?.monthSpendCents || 0,
    at: Date.now(),
  }
}

/** Who wrote a comment, as the phone should show it. */
function authorOf(comment, names) {
  if (comment.authorType === 'system') return 'Paperclip'
  return comment.authorAgentId ? names.get(comment.authorAgentId) || 'A bot' : 'You'
}

export async function jobDetail(jobId, options) {
  if (!ID.test(jobId)) throw new PaperclipError(400, 'That is not a job id')
  const [issue, comments] = await Promise.all([
    call(`/issues/${jobId}`, options),
    call(`/issues/${jobId}/comments`, options),
  ])
  const agents = await call(`/companies/${issue.companyId}/agents`, options)
  const names = new Map(agents.map((a) => [a.id, a.name]))
  return {
    ...jobView(issue, names),
    description: issue.description || '',
    comments: comments.map((c) => ({
      id: c.id,
      from: authorOf(c, names),
      text: c.body || '',
      at: c.createdAt,
    })),
  }
}

/** Everyone you can talk to, with whether a conversation has started. */
export async function chatList(options) {
  const id = await companyId(options)
  const [agents, chats, live] = await Promise.all([
    call(`/companies/${id}/agents`, options),
    call(`/companies/${id}/chats`, options),
    call(`/companies/${id}/live-runs`, options),
  ])
  const liveAgents = new Set(live.map((run) => run.agentId))
  const started = new Map(chats.map((chat) => [chat.conversationAgentId, chat]))
  return agents.map((agent) => ({
    ...botView(agent, liveAgents),
    lastActiveAt: started.get(agent.id)?.lastActivityAt || started.get(agent.id)?.updatedAt || null,
  }))
}

/** One conversation, oldest message first. A bot nobody has spoken to yet has an empty one. */
export async function chatThread(botId, options) {
  if (!ID.test(botId)) throw new PaperclipError(400, 'That is not a bot id')
  const id = await companyId(options)
  const [agent, chat] = await Promise.all([
    call(`/agents/${botId}`, options),
    call(`/companies/${id}/chats/${botId}`, options),
  ])
  const bot = { id: agent.id, name: agent.name, title: agent.title || '' }
  if (!chat) return { bot, working: false, messages: [] }
  const comments = await call(`/issues/${chat.id}/comments?limit=${SHOWN_MESSAGES}`, options)
  const names = new Map([[agent.id, agent.name]])
  return {
    bot,
    working: chat.conversationState === 'active',
    messages: comments
      .map((c) => ({ id: c.id, from: authorOf(c, names), mine: c.authorType === 'user', text: c.body || '', at: c.createdAt }))
      .reverse(),
  }
}

/**
 * Say something to a bot. `requestId` comes from the phone, so a retry after a dropped connection
 * cannot send the same message twice.
 */
export async function sendChat(botId, text, requestId, options) {
  if (!ID.test(botId)) throw new PaperclipError(400, 'That is not a bot id')
  if (!ID.test(requestId || '')) throw new PaperclipError(400, 'A message needs a request id')
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) throw new PaperclipError(400, 'Write a message first')
  if (body.length > MAX_TEXT) throw new PaperclipError(400, `Messages are limited to ${MAX_TEXT} characters`)
  const id = await companyId(options)
  const chat = await call(`/companies/${id}/chats/${botId}`, { ...options, method: 'POST', body: {} })
  const comment = await call(`/issues/${chat.id}/comments`, { ...options, method: 'POST', body: { body, clientRequestId: requestId } })
  return { id: comment.id }
}

/** A new job goes to the top of the org chart, which decides who does it. */
export async function addJob({ title, description = '' } = {}, options) {
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name) throw new PaperclipError(400, 'A job needs a title')
  if (name.length > MAX_TITLE) throw new PaperclipError(400, `Job titles are limited to ${MAX_TITLE} characters`)
  if (typeof description !== 'string' || description.length > MAX_TEXT) {
    throw new PaperclipError(400, `Job details are limited to ${MAX_TEXT} characters`)
  }
  const id = await companyId(options)
  const agents = await call(`/companies/${id}/agents`, options)
  const lead = agents.find((a) => a.role === 'ceo')
  if (!lead) throw new PaperclipError(409, 'Paperclip has no director to give this job to')
  const issue = await call(`/companies/${id}/issues`, {
    ...options,
    method: 'POST',
    body: { title: name, description: description.trim(), status: 'todo', priority: 'medium', assigneeAgentId: lead.id },
  })
  return { id: issue.id, ref: issue.identifier || '' }
}

export async function addComment(jobId, text, options) {
  if (!ID.test(jobId)) throw new PaperclipError(400, 'That is not a job id')
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) throw new PaperclipError(400, 'Write a comment first')
  if (body.length > MAX_TEXT) throw new PaperclipError(400, `Comments are limited to ${MAX_TEXT} characters`)
  const comment = await call(`/issues/${jobId}/comments`, { ...options, method: 'POST', body: { body } })
  return { id: comment.id }
}

export async function decideApproval(approvalId, decision, note, options) {
  if (!ID.test(approvalId)) throw new PaperclipError(400, 'That is not an approval id')
  if (decision !== 'approve' && decision !== 'reject') throw new PaperclipError(400, 'Choose approve or reject')
  const decisionNote = typeof note === 'string' ? note.trim().slice(0, MAX_TEXT) : ''
  await call(`/approvals/${approvalId}/${decision}`, { ...options, method: 'POST', body: decisionNote ? { decisionNote } : {} })
  return { ok: true }
}
