/**
 * Background replies: a message you send a bot, run through its agent's own CLI on this
 * machine, watched until it finishes.
 *
 * The message travels on stdin, never in the argument list, so nothing typed into the page can
 * be read as a flag or, where a `.cmd` shim needs a shell, as shell syntax. The argument list
 * itself is fixed flags plus a session id the adapter has already validated. One job per thread
 * at a time; a job that runs past its limit is stopped.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const MAX_OUTPUT = 256 * 1024
const MAX_ERROR = 16 * 1024
/** A reply that takes longer than this is stopped rather than left running unseen. */
const TIME_LIMIT_MS = 20 * 60 * 1000
/** How many finished jobs are remembered for the page. */
const KEEP = 40

const jobs = new Map()

/** The reply to show: Claude's JSON `result`, else the last part of whatever was printed. */
export function replyFrom(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.result === 'string') return parsed.result.trim()
  } catch { /* plain text output */ }
  return text.length > 1500 ? `…${text.slice(-1500)}` : text
}

function prune() {
  const done = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)
  while (done.length && jobs.size > KEEP) jobs.delete(done.shift().id)
}

export function runningJobFor(threadId) {
  return [...jobs.values()].find((j) => j.threadId === threadId && j.status === 'running') || null
}

/**
 * Start a job. `command` is `{ argv, cwd, stdin }` with an absolute `argv[0]`.
 * Returns the job's public record.
 */
export function startJob({ threadId, label, command, spawnImpl = spawn, timeoutMs = TIME_LIMIT_MS }) {
  const job = {
    id: randomUUID(),
    threadId,
    label: label || 'Agent',
    status: 'running',
    startedAt: Date.now(),
    endedAt: 0,
    reply: '',
    error: '',
  }
  jobs.set(job.id, job)
  const [bin, ...args] = command.argv
  // A Windows .cmd shim cannot be spawned without a shell. Safe here: the arguments are fixed
  // flags and a validated session id, the message itself is on stdin, and the shim's own path
  // is quoted in case it has a space in it.
  const shell = /\.(cmd|bat)$/i.test(bin)
  let out = ''
  let err = ''
  let child
  try {
    child = spawnImpl(shell ? `"${bin}"` : bin, args, {
      cwd: command.cwd,
      windowsHide: true,
      shell,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    job.status = 'failed'
    job.error = e.message
    job.endedAt = Date.now()
    prune()
    return publicJob(job)
  }
  const timer = setTimeout(() => {
    if (job.status !== 'running') return
    job.error = 'Stopped after 20 minutes without finishing'
    job.status = 'failed'
    job.endedAt = Date.now()
    // Killing cmd.exe alone leaves its agent alive. Stop the entire job's process tree.
    if (Number.isInteger(child.pid) && child.pid > 0) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
      } else {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
      }
    } else child.kill()
    prune()
  }, timeoutMs)
  timer.unref?.()
  child.stdout?.on('data', (d) => { if (out.length < MAX_OUTPUT) out += String(d).slice(0, MAX_OUTPUT - out.length) })
  child.stderr?.on('data', (d) => { if (err.length < MAX_ERROR) err += String(d).slice(0, MAX_ERROR - err.length) })
  child.on('error', (e) => {
    clearTimeout(timer)
    job.status = 'failed'
    job.error = e.message
    job.endedAt = Date.now()
    prune()
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (job.status !== 'running') return
    job.endedAt = Date.now()
    job.reply = replyFrom(out)
    if (code === 0 && !job.error) job.status = 'done'
    else {
      job.status = 'failed'
      job.error ||= err.trim().split('\n').slice(-3).join(' ') || `Exited with code ${code}`
    }
    prune()
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(command.stdin ?? '')
  return publicJob(job)
}

const publicJob = (j) => ({ ...j })

/** Most recent first. */
export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(publicJob)
}

/** For tests. */
export function clearJobs() {
  jobs.clear()
}
