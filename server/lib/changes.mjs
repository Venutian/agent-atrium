/**
 * What a job's branch changed, read with git and nothing else.
 *
 * The folder and branch come from Paperclip's record of the job, never from the phone. Bots can
 * write to the repositories this reads, so every setting that could make git run a program is
 * pinned off, and only two commits are compared: the working tree is never looked at.
 */
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

const TIME_LIMIT_MS = 8_000
const MAX_OUTPUT = 8 * 1024 * 1024
const MAX_FILES = 200
const MAX_COMMITS = 30
const MAX_FILE_PATCH = 60 * 1024
const MAX_ALL_PATCHES = 400 * 1024
const SAFE_REF = /^(?!-)(?!.*\.\.)[\w./-]+$/
const PINNED = [
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false',
  '-c', 'log.showSignature=false', '-c', 'diff.noprefix=false', '--no-pager',
]
const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames']

export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...PINNED, ...args], {
      timeout: TIME_LIMIT_MS,
      maxBuffer: MAX_OUTPUT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

const usable = ({ cwd, branch, base } = {}) =>
  typeof cwd === 'string' && isAbsolute(cwd) && SAFE_REF.test(branch || '') && SAFE_REF.test(base || '')

function parseCounts(numstat) {
  return numstat.split('\n').filter(Boolean).map((line) => {
    const [added, removed, ...rest] = line.split('\t')
    const binary = added === '-'
    return { path: rest.join('\t'), added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary }
  })
}

/** Lines added and removed, for the job screen. Null when the job has no branch to read. */
export async function changeCounts(workspace) {
  if (!usable(workspace)) return null
  const range = `${workspace.base}...${workspace.branch}`
  try {
    const files = parseCounts(await git(workspace.cwd, [...DIFF, '--numstat', '--end-of-options', range, '--']))
    return { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }
  } catch {
    return null
  }
}

/** Commits and per-file patches, cut down to what a phone can show. */
export async function changeDetail(workspace) {
  if (!usable(workspace)) return null
  const { cwd, base, branch } = workspace
  const range = `${base}...${branch}`
  let numstat, patches, log
  try {
    [numstat, patches, log] = await Promise.all([
      git(cwd, [...DIFF, '--numstat', '--end-of-options', range, '--']),
      git(cwd, [...DIFF, '--patch', '--end-of-options', range, '--']),
      git(cwd, ['log', '--format=%h%x09%s', `-n${MAX_COMMITS}`, '--end-of-options', `${base}..${branch}`, '--']),
    ])
  } catch {
    return null
  }
  const counts = parseCounts(numstat)
  // Both lists come from the same comparison, so they line up file for file.
  const parts = patches.split(/^(?=diff --git )/m).filter(Boolean)
  let room = MAX_ALL_PATCHES
  let cut = counts.length > MAX_FILES
  const files = counts.slice(0, MAX_FILES).map((file, index) => {
    // Headers differ for new and deleted files, so start at the first change rather than a line count.
    const part = parts[index] || ''
    const body = part.slice(Math.max(0, part.indexOf('@@')))
    const allowed = Math.min(MAX_FILE_PATCH, room)
    if (body.length > allowed) cut = true
    const patch = file.binary ? '' : body.slice(0, allowed)
    room -= patch.length
    return { ...file, patch }
  })
  const commits = log.split('\n').filter(Boolean).map((line) => {
    const [sha, ...subject] = line.split('\t')
    return { sha, subject: subject.join('\t') }
  })
  return { branch, base, commits, files, cut }
}
