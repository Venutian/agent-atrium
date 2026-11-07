/**
 * Playable builds of a job, served as plain files.
 *
 * A script on this machine builds each finished job and leaves the result under the preview
 * folder. This file only hands out what is already there, so tapping Play runs nothing here. Each
 * build lives at <root>/<key>/site with a manifest beside it, and the key is what a link is made of.
 *
 * Games ask for files from the root of their address, so a build cannot live under a path. The
 * link sets a cookie naming the build, and every later request reads from that build's folder.
 */
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export const PREVIEW_PORT = 5290
const COOKIE = 'atrium-preview'
const KEY = /^[0-9a-f]{32}$/
const COOKIE_DAY_S = 24 * 60 * 60
// A build is bot-written code in a phone's browser. It may use its own files and nothing else.
const POLICY = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' data: blob:; frame-ancestors 'none'; form-action 'none'"
// A service worker would outlive this build and keep answering for the next one at this address.
const NEVER_SERVED = /(^|\/)(sw|service-?worker)\.js$/i
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
}

export const previewRoot = (env = process.env) => env.AGENT_ATRIUM_PREVIEW_ROOT || path.join(os.homedir(), '.config', 'agent-atrium', 'previews')

async function readManifest(root, key) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, key, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * What has been built for a job, newest first. `host` is the address the app used to reach this PC,
 * and `link` makes a build's link some other way, such as through Cloudflare.
 */
export async function listPreviews(jobId, { root, host, port = PREVIEW_PORT, link = (key) => `http://${host}:${port}/open/${key}` }) {
  const keys = await fsp.readdir(root).catch(() => [])
  const found = await Promise.all(keys.filter((key) => KEY.test(key)).map(async (key) => ({ key, manifest: await readManifest(root, key) })))
  return found
    .filter(({ manifest }) => manifest?.job === jobId)
    .sort((a, b) => String(b.manifest.builtAt).localeCompare(String(a.manifest.builtAt)))
    .map(({ key, manifest }) => ({
      name: manifest.name || 'Build',
      ok: Boolean(manifest.ok),
      commit: manifest.commit || '',
      builtAt: manifest.builtAt || '',
      errors: Number(manifest.errors) || 0,
      note: manifest.ok ? '' : String(manifest.note || '').slice(-1200),
      url: manifest.ok ? link(key) : '',
    }))
}

function refuse(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(message)
}

const cookieKey = (header = '') => new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{32})(?:;|$)`).exec(header)?.[1]

/** The file a request means, or null. Symlinks are followed before the check, so a build cannot point outside itself. */
async function resolveFile(root, key, pathname) {
  const site = await fsp.realpath(path.join(root, key, 'site')).catch(() => null)
  if (!site) return null
  let wanted
  try {
    wanted = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (wanted.includes('\0') || NEVER_SERVED.test(wanted)) return null
  const asked = path.join(site, wanted.endsWith('/') ? `${wanted}index.html` : wanted)
  const real = await fsp.realpath(asked).catch(() => null)
  if (!real || !real.startsWith(site + path.sep)) return null
  const stat = await fsp.stat(real).catch(() => null)
  return stat?.isFile() ? { file: real, size: stat.size } : null
}

export function previewHandler({ root }) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, 'Previews are read only')
    const { pathname } = new URL(req.url, 'http://preview')
    const open = /^\/open\/([0-9a-f]{32})$/.exec(pathname)
    if (open) {
      if (!(await readManifest(root, open[1]))?.ok) return refuse(res, 404, 'That build is gone. Open it again from nGen Studio.')
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${open[1]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAY_S}`,
        'Cache-Control': 'no-store',
      })
      return res.end()
    }
    const key = cookieKey(req.headers.cookie)
    if (!key) return refuse(res, 404, 'Open a build from nGen Studio first.')
    const found = await resolveFile(root, key, pathname)
    if (!found) return refuse(res, 404, 'Not in this build')
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(found.file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': found.size,
      'Content-Security-Policy': POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(found.file).on('error', () => res.destroy()).pipe(res)
  }
}

export function startPreviews({ root, host, port = PREVIEW_PORT }) {
  return http.createServer(previewHandler({ root })).listen(port, host, () => {
    console.log(`Previews on http://${host}:${port}`)
  })
}
