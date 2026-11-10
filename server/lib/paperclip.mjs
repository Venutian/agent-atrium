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
const SHOWN_UPDATES = 30
const PREVIEW_LOOKBACK = 5
const PREVIEW_CHARS = 140
const PRIORITIES = new Set(['critical', 'high', 'medium', 'low'])
const FAILED_RUNS = new Set(['failed', 'timed_out'])
const SHOWN_RUNS = 50
const MAX_ANSWERS = 20
const REPORT_MS = 24 * 60 * 60 * 1000
// Paperclip's attention feed took about a second on 10 November, and it is the slowest part of the
// phone's first screen. The door keeps the last answer, so a refresh never waits longer than this.
const ATTENTION_TTL_MS = 20_000
const ATTENTION_WAIT_MS = 800
const SCHEDULES = { nightly: '0 3 * * *', morning: '0 7 * * *', weekdays: '0 7 * * 1-5', weekly: '0 4 * * 1' }
const TIMEZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/
const PROOF_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_PROOF_BYTES = 12 * 1024 * 1024

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

/** For extras a screen can live without: losing one must not take the whole screen down. */
const orElse = (promise, fallback) => promise.catch(() => fallback)

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

const jobView = (issue, names, projects = new Map()) => ({
  id: issue.id,
  ref: issue.identifier || '',
  title: issue.title,
  status: issue.status,
  bot: names.get(issue.assigneeAgentId) || '',
  project: projects.get(issue.projectId) || '',
  projectId: issue.projectId || '',
  priority: issue.priority || 'medium',
  updatedAt: issue.lastActivityAt || issue.updatedAt || issue.createdAt,
})

const attentionView = (item, kind) => ({
  kind,
  id: item.subject?.metadata?.issueId || '',
  title: item.subject?.title || item.whyNow || 'Needs a look',
  detail: item.whyNow || '',
})

function needsYou({ approvals, attention, issues, names, failedRuns }) {
  const items = approvals.map((a) => ({
    kind: 'approval',
    id: a.id,
    title: a.payload?.title || a.payload?.name || a.type,
    detail: a.requestedByAgentId ? `Asked by ${names.get(a.requestedByAgentId) || 'a bot'}` : '',
  }))
  const noticed = (...kinds) => attention.filter((item) => kinds.includes(item.sourceKind))
  items.push(...noticed('issue_thread_interaction').map((item) => attentionView(item, 'question')))
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
  const failures = noticed('failed_run', 'agent_error_alert')
  items.push(...failures.map((item) => attentionView(item, 'failed')))
  if (!failures.length && failedRuns > 0) {
    items.push({ kind: 'failed', id: '', title: `${failedRuns} failed run${failedRuns === 1 ? '' : 's'}`, detail: 'Open Paperclip to see why' })
  }
  return items
}

/** Tokens the bots used per provider. Subscription runs bill nothing, so dollars would always read zero. */
const usageView = (rows) => rows.map((row) => ({
  provider: row.provider,
  window: row.window,
  tokens: (row.inputTokens || 0) + (row.outputTokens || 0),
  cachedTokens: row.cachedInputTokens || 0,
}))

/** What happened in the last day, worked out from the jobs themselves with no AI. */
function dayReport({ issues, names, projects, spend, now = Date.now() }) {
  const since = now - REPORT_MS
  const finished = issues.filter((i) => i.status === 'done' && Date.parse(i.completedAt || i.updatedAt || 0) >= since)
  return {
    finished: finished.slice(0, SHOWN_DONE).map((i) => ({ id: i.id, ref: i.identifier || '', title: i.title, bot: names.get(i.assigneeAgentId) || '', project: projects.get(i.projectId) || '' })),
    finishedCount: finished.length,
    tokens: usageView(spend.filter((row) => row.window === '24h')),
  }
}

/**
 * Questions bots asked in their chats. Paperclip's attention feed leaves chats out, so without this a
 * choice Tony put to the owner never reached "Needs you". One card per chat; it opens the cards to answer.
 */
async function chatQuestions(id, names, options) {
  const chats = await orElse(call(`/companies/${id}/chats`, options), [])
  const asked = await Promise.all(chats.map(async (chat) => {
    const pending = (await orElse(call(`/issues/${chat.id}/interactions`, options), []))
      .filter((i) => i.status === 'pending').map(questionView).filter(Boolean)
    if (!pending.length) return null
    const bot = names.get(chat.conversationAgentId) || 'A bot'
    return {
      kind: 'question',
      id: chat.id,
      title: pending.length === 1 ? pending[0].title : `${bot} has ${pending.length} questions for you`,
      detail: pending.length === 1 ? `${bot} asked in chat` : pending.map((q) => q.title).join('\n'),
    }
  }))
  return asked.filter(Boolean)
}

const attentionSeen = new WeakMap()
const attentionByCompany = new Map()
const waitUpTo = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/**
 * Paperclip's attention feed, answered from the last result while a fresh one is fetched behind
 * the request. The first call after a restart waits at most ATTENTION_WAIT_MS; every later one
 * inside the TTL is instant, and a slow feed never holds the phone's first screen.
 */
function attentionSoon(id, options) {
  // Keyed by the fetcher when a caller supplies one, so one door's tests cannot see another's
  // remembered feed; on the real door it is one company and one cache.
  const store = options?.fetcher ? attentionSeen : attentionByCompany
  const key = options?.fetcher || id
  const seen = store.get(key) || { at: 0, items: null, running: null }
  store.set(key, seen)
  const refresh = () => {
    if (seen.running) return seen.running
    seen.running = orElse(call(`/companies/${id}/attention`, options), { items: [] })
      .then((value) => {
        seen.at = Date.now()
        seen.items = value
      })
      .finally(() => {
        seen.running = null
      })
    return seen.running
  }
  if (seen.items && Date.now() - seen.at < ATTENTION_TTL_MS) return Promise.resolve(seen.items)
  const running = refresh()
  if (seen.items) return Promise.resolve(seen.items)
  return Promise.race([running, waitUpTo(ATTENTION_WAIT_MS)]).then(() => seen.items || { items: [] })
}

/** Everything the phone's first screen needs, in one call. */
export async function studioSummary(options) {
  const id = await companyId(options)
  const [company, agents, issues, approvals, dashboard, badges, live, projects, attention, spend] = await Promise.all([
    call(`/companies/${id}`, options),
    call(`/companies/${id}/agents`, options),
    call(`/companies/${id}/issues`, options),
    call(`/companies/${id}/approvals?status=pending`, options),
    call(`/companies/${id}/dashboard`, options),
    call(`/companies/${id}/sidebar-badges`, options),
    call(`/companies/${id}/live-runs`, options),
    orElse(call(`/companies/${id}/projects`, options), []),
    attentionSoon(id, options),
    orElse(call(`/companies/${id}/costs/window-spend`, options), []),
  ])
  const names = new Map(agents.map((a) => [a.id, a.name]))
  const asked = needsYou({ approvals, attention: attention?.items || [], issues, names, failedRuns: badges?.failedRuns || 0 })
  const inChats = (await chatQuestions(id, names, options)).filter((q) => !asked.some((a) => a.id === q.id))
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  const view = (issue) => jobView(issue, names, projectNames)
  const liveAgents = new Set(live.map((run) => run.agentId))
  const byNewest = [...issues].sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
  return {
    company: company.name,
    bots: agents.map((a) => botView(a, liveAgents)),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    needsYou: [...inChats, ...asked],
    running: byNewest.filter((i) => RUNNING.has(i.status)).map(view),
    queued: byNewest.filter((i) => QUEUED.has(i.status)).map(view),
    finished: byNewest.filter((i) => FINISHED.has(i.status)).slice(0, SHOWN_DONE).map(view),
    usage: usageView(spend),
    report: dayReport({ issues, names, projects: projectNames, spend }),
    spentCents: dashboard?.costs?.monthSpendCents || 0,
    at: Date.now(),
  }
}

/** The crew's scripts post with the owner's board identity and sign with this, so they are not shown as the owner. */
const SCRIPT_MARK = /\n*<!-- ngen-script: ([^>]+?) -->\s*$/
// Messages the scripts posted before they signed them, known by their fixed wording.
const OLD_SCRIPT = [
  [/^The crew check found \d+ thing/, 'Crew check'],
  [/is stuck on .+ Read its comments and act now/s, 'Review guard'],
  [/ is finished\. Critic's verdict:/, 'Review guard'],
  [/You own every session: check it with sessions\.py list/, 'Review guard'],
]
const scriptOf = (body = '') => body.match(SCRIPT_MARK)?.[1] || OLD_SCRIPT.find(([rx]) => rx.test(body))?.[1]

/** Who wrote a comment, as the phone should show it. */
function authorOf(comment, names) {
  if (comment.authorType === 'system') return 'Paperclip'
  const script = comment.authorType === 'user' && scriptOf(comment.body)
  if (script) return script
  return comment.authorAgentId ? names.get(comment.authorAgentId) || 'A bot' : 'You'
}

/** Whether the owner wrote it, and its words without a script's signature. */
const mineOf = (comment) => comment.authorType === 'user' && !scriptOf(comment.body)
const textOf = (comment) => (comment.body || '').replace(SCRIPT_MARK, '')

/** A question a bot is waiting on, in the two forms the app can answer. Other kinds stay in Paperclip. */
function questionView(interaction) {
  const { id, kind, title, payload } = interaction
  if (kind === 'ask_user_questions') {
    return {
      id,
      kind: 'choice',
      title: title || payload?.title || 'A bot has a question',
      items: (payload?.questions || []).map((q) => ({
        id: q.id,
        prompt: q.prompt,
        multiple: q.selectionMode === 'multi',
        required: Boolean(q.required),
        options: (q.options || []).filter((o) => !o.freeText).map((o) => ({ id: o.id, label: o.label, hint: o.description || '' })),
      })),
    }
  }
  if (kind === 'request_confirmation') {
    return {
      id,
      kind: 'confirm',
      title: title || 'A bot wants a yes or no',
      prompt: payload?.prompt || '',
      accept: payload?.acceptLabel || 'Yes',
      reject: payload?.rejectLabel || 'No',
    }
  }
  return null
}

/** The latest run on this job: whether it is live, and why it failed if it did. */
function runView(runs, live, names) {
  const latest = live[0] || runs.find((r) => r.issueId)
  if (!latest) return null
  const failed = !live.length && FAILED_RUNS.has(latest.status)
  return {
    id: latest.id,
    live: live.length > 0,
    status: latest.status,
    bot: names.get(latest.agentId) || '',
    why: failed ? latest.error || latest.errorCode || 'The run stopped without saying why' : '',
    at: latest.finishedAt || latest.startedAt || latest.createdAt || '',
  }
}

export async function jobDetail(jobId, options) {
  if (!ID.test(jobId)) throw new PaperclipError(400, 'That is not a job id')
  const [issue, comments, interactions, live, attachments] = await Promise.all([
    call(`/issues/${jobId}`, options),
    // Newest first. Tony's chat once sent 600 updates (550 KB) every 20 seconds, and the phone was too busy
    // drawing them to take a tap on a question card.
    call(`/issues/${jobId}/comments?limit=${SHOWN_UPDATES}`, options),
    orElse(call(`/issues/${jobId}/interactions`, options), []),
    orElse(call(`/issues/${jobId}/live-runs`, options), []),
    orElse(call(`/issues/${jobId}/attachments`, options), []),
  ])
  const [agents, runs, projects] = await Promise.all([
    call(`/companies/${issue.companyId}/agents`, options),
    orElse(call(`/companies/${issue.companyId}/heartbeat-runs?limit=${SHOWN_RUNS}&summary=true`, options), []),
    orElse(call(`/companies/${issue.companyId}/projects`, options), []),
  ])
  const names = new Map(agents.map((a) => [a.id, a.name]))
  return {
    ...jobView(issue, names, new Map(projects.map((p) => [p.id, p.name]))),
    description: issue.description || '',
    run: runView(runs.filter((r) => r.issueId === jobId), live, names),
    questions: interactions.filter((i) => i.status === 'pending').map(questionView).filter(Boolean),
    proof: attachments.filter((a) => PROOF_TYPES.has(a.contentType)).map((a) => ({ id: a.id, name: a.originalFilename || 'Screenshot' })),
    comments: comments.map((c) => ({
      id: c.id,
      from: authorOf(c, names),
      text: textOf(c),
      at: c.createdAt,
    })),
  }
}

/** The newest thing a person or a bot said, for the chat list. System notes do not count. */
async function lastSaid(chat, options) {
  if (!chat) return null
  const comments = await call(`/issues/${chat.id}/comments?limit=${PREVIEW_LOOKBACK}`, options)
  const said = comments.find((c) => c.authorType !== 'system')
  return said ? { text: textOf(said).slice(0, PREVIEW_CHARS), mine: mineOf(said), at: said.createdAt } : null
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
  return Promise.all(agents.map(async (agent) => {
    const chat = started.get(agent.id)
    return {
      ...botView(agent, liveAgents),
      lastActiveAt: chat?.lastActivityAt || chat?.updatedAt || null,
      lastMessage: await lastSaid(chat, options),
    }
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
      .map((c) => ({ id: c.id, from: authorOf(c, names), mine: mineOf(c), text: textOf(c), at: c.createdAt }))
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

/** A new job goes to the top of the org chart, which decides who does it, unless a bot is named. */
export async function addJob({ title, description = '', projectId, botId, priority = 'medium' } = {}, options) {
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name) throw new PaperclipError(400, 'A job needs a title')
  if (name.length > MAX_TITLE) throw new PaperclipError(400, `Job titles are limited to ${MAX_TITLE} characters`)
  if (typeof description !== 'string' || description.length > MAX_TEXT) {
    throw new PaperclipError(400, `Job details are limited to ${MAX_TEXT} characters`)
  }
  if (!PRIORITIES.has(priority)) throw new PaperclipError(400, 'Priority must be critical, high, medium or low')
  const id = await companyId(options)
  const [agents, projects] = await Promise.all([
    call(`/companies/${id}/agents`, options),
    projectId ? call(`/companies/${id}/projects`, options) : [],
  ])
  const owner = botId ? agents.find((a) => a.id === botId) : agents.find((a) => a.role === 'ceo')
  if (!owner) throw botId ? new PaperclipError(400, 'That bot is not in this studio') : new PaperclipError(409, 'Paperclip has no director to give this job to')
  if (projectId && !projects.some((p) => p.id === projectId)) throw new PaperclipError(400, 'That project is not in this studio')
  const issue = await call(`/companies/${id}/issues`, {
    ...options,
    method: 'POST',
    body: { title: name, description: description.trim(), status: 'todo', priority, assigneeAgentId: owner.id, ...(projectId ? { projectId } : {}) },
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

/** Where a job's work lives, from Paperclip's own record. Null when it never had a workspace. */
export async function jobWorkspace(jobId, options) {
  if (!ID.test(jobId)) throw new PaperclipError(400, 'That is not a job id')
  const issue = await call(`/issues/${jobId}`, options)
  if (!issue.executionWorkspaceId) return null
  const workspace = await orElse(call(`/execution-workspaces/${issue.executionWorkspaceId}`, options), null)
  return workspace && { cwd: workspace.cwd, branch: workspace.branchName, base: workspace.baseRef }
}

/** One screenshot's bytes. Only plain image types pass, so nothing a browser would run can come through here. */
export async function proofImage(attachmentId, { fetcher = fetch } = {}) {
  if (!ID.test(attachmentId)) throw new PaperclipError(400, 'That is not an image id')
  let res
  try {
    res = await fetcher(`${BASE}/api/attachments/${attachmentId}/content`, { method: 'GET', signal: AbortSignal.timeout(TIME_LIMIT_MS) })
  } catch {
    throw new PaperclipError(503, 'Paperclip is not running on this machine')
  }
  if (!res.ok) throw new PaperclipError(res.status, `Paperclip answered ${res.status}`)
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!PROOF_TYPES.has(type)) throw new PaperclipError(415, 'That file is not an image')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_PROOF_BYTES) throw new PaperclipError(413, 'That image is too large')
  return { type, bytes }
}

const routineView = (routine, names, projects) => {
  const schedule = (routine.triggers || []).find((t) => t.kind === 'schedule' && !t.archived)
  return {
    id: routine.id,
    title: routine.title,
    paused: routine.status !== 'active',
    bot: names.get(routine.assigneeAgentId) || '',
    project: projects.get(routine.projectId) || '',
    cron: schedule?.cronExpression || '',
    nextAt: schedule?.nextRunAt || null,
    lastAt: routine.lastTriggeredAt || routine.lastRun?.triggeredAt || null,
    lastStatus: routine.lastRun?.status || '',
  }
}

export async function routineList(options) {
  const id = await companyId(options)
  const [routines, agents, projects] = await Promise.all([
    call(`/companies/${id}/routines`, options),
    call(`/companies/${id}/agents`, options),
    orElse(call(`/companies/${id}/projects`, options), []),
  ])
  const names = new Map(agents.map((a) => [a.id, a.name]))
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  return routines.filter((r) => r.status !== 'archived').map((r) => routineView(r, names, projectNames))
}

/** A repeating job, on one of a few fixed schedules so the phone never writes a cron line. */
export async function addRoutine({ title, description = '', botId, projectId, schedule, timezone = 'UTC' } = {}, options) {
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name) throw new PaperclipError(400, 'A routine needs a title')
  if (name.length > MAX_TITLE) throw new PaperclipError(400, `Titles are limited to ${MAX_TITLE} characters`)
  if (typeof description !== 'string' || description.length > MAX_TEXT) throw new PaperclipError(400, `Details are limited to ${MAX_TEXT} characters`)
  const cronExpression = Object.hasOwn(SCHEDULES, schedule) ? SCHEDULES[schedule] : null
  if (!cronExpression) throw new PaperclipError(400, 'Choose a schedule')
  if (typeof timezone !== 'string' || !TIMEZONE.test(timezone)) throw new PaperclipError(400, 'That is not a time zone')
  const id = await companyId(options)
  const [agents, projects] = await Promise.all([call(`/companies/${id}/agents`, options), projectId ? call(`/companies/${id}/projects`, options) : []])
  const owner = botId ? agents.find((a) => a.id === botId) : agents.find((a) => a.role === 'ceo')
  if (!owner) throw new PaperclipError(400, 'That bot is not in this studio')
  if (projectId && !projects.some((p) => p.id === projectId)) throw new PaperclipError(400, 'That project is not in this studio')
  const routine = await call(`/companies/${id}/routines`, {
    ...options,
    method: 'POST',
    body: { title: name, description: description.trim(), assigneeAgentId: owner.id, ...(projectId ? { projectId } : {}) },
  })
  await call(`/routines/${routine.id}/triggers`, { ...options, method: 'POST', body: { kind: 'schedule', cronExpression, timezone } })
  return { id: routine.id }
}

async function setRoutineStatus(routineId, status, options) {
  if (!ID.test(routineId)) throw new PaperclipError(400, 'That is not a routine id')
  await call(`/routines/${routineId}`, { ...options, method: 'PATCH', body: { status } })
  return { ok: true }
}

export const pauseRoutine = (id, options) => setRoutineStatus(id, 'paused', options)
export const resumeRoutine = (id, options) => setRoutineStatus(id, 'active', options)
export const removeRoutine = (id, options) => setRoutineStatus(id, 'archived', options)

export async function runRoutine(routineId, options) {
  if (!ID.test(routineId)) throw new PaperclipError(400, 'That is not a routine id')
  await call(`/routines/${routineId}/run`, { ...options, method: 'POST', body: {} })
  return { ok: true }
}

/** Stops whatever is running on a job now. The job stays open, so a comment can start it again. */
export async function stopJob(jobId, options) {
  if (!ID.test(jobId)) throw new PaperclipError(400, 'That is not a job id')
  const live = await call(`/issues/${jobId}/live-runs`, options)
  await Promise.all(live.map((run) => call(`/heartbeat-runs/${run.id}/cancel`, { ...options, method: 'POST', body: {} })))
  return { stopped: live.length }
}

async function setJobStatus(jobId, status, options) {
  if (!ID.test(jobId)) throw new PaperclipError(400, 'That is not a job id')
  await call(`/issues/${jobId}`, { ...options, method: 'PATCH', body: { status } })
  return { ok: true }
}

export const cancelJob = (jobId, options) => setJobStatus(jobId, 'cancelled', options)
export const reopenJob = (jobId, options) => setJobStatus(jobId, 'todo', options)

async function setBotRunning(botId, action, options) {
  if (!ID.test(botId)) throw new PaperclipError(400, 'That is not a bot id')
  await call(`/agents/${botId}/${action}`, { ...options, method: 'POST', body: {} })
  return { ok: true }
}

export const pauseBot = (botId, options) => setBotRunning(botId, 'pause', options)
export const resumeBot = (botId, options) => setBotRunning(botId, 'resume', options)

function questionPath(jobId, questionId, verb) {
  if (!ID.test(jobId) || !ID.test(questionId)) throw new PaperclipError(400, 'That is not a question id')
  return `/issues/${jobId}/interactions/${questionId}/${verb}`
}

const answerView = (answer) => ({
  questionId: String(answer?.questionId || ''),
  optionIds: Array.isArray(answer?.optionIds) ? answer.optionIds.map(String) : [],
  ...(typeof answer?.otherText === 'string' ? { otherText: answer.otherText.slice(0, MAX_TEXT) } : {}),
})

export async function answerQuestion(jobId, questionId, answers, options) {
  if (!Array.isArray(answers) || !answers.length || answers.length > MAX_ANSWERS) throw new PaperclipError(400, 'Answer the question first')
  await call(questionPath(jobId, questionId, 'respond'), { ...options, method: 'POST', body: { answers: answers.map(answerView) } })
  return { ok: true }
}

export async function acceptQuestion(jobId, questionId, options) {
  await call(questionPath(jobId, questionId, 'accept'), { ...options, method: 'POST', body: {} })
  return { ok: true }
}

export async function rejectQuestion(jobId, questionId, reason, options) {
  const note = typeof reason === 'string' ? reason.trim().slice(0, MAX_TEXT) : ''
  await call(questionPath(jobId, questionId, 'reject'), { ...options, method: 'POST', body: note ? { reason: note } : {} })
  return { ok: true }
}
