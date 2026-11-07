import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { listPreviews, previewHandler } from '../server/lib/previews.mjs'

const KEY = 'a'.repeat(32)
const FAILED = 'b'.repeat(32)
const JOB = 'job-1'

function folder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atrium-previews-'))
  const site = path.join(root, KEY, 'site')
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>Game</h1>')
  fs.writeFileSync(path.join(site, 'assets', 'a.js'), 'run()')
  fs.writeFileSync(path.join(site, 'sw.js'), 'self')
  fs.writeFileSync(path.join(root, 'secret.txt'), 'hidden')
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(site, 'link.txt'))
  fs.writeFileSync(path.join(root, KEY, 'manifest.json'), JSON.stringify({ job: JOB, name: 'Baltis', ok: true, commit: 'abc1234', builtAt: '2026-11-03T10:00:00Z' }))
  fs.mkdirSync(path.join(root, FAILED))
  fs.writeFileSync(path.join(root, FAILED, 'manifest.json'), JSON.stringify({ job: JOB, name: 'Aldis', ok: false, note: 'Build failed', builtAt: '2026-11-03T09:00:00Z' }))
  return root
}

async function withServer(run) {
  const root = folder()
  const server = http.createServer(previewHandler({ root }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = (url, { cookie, method = 'GET' } = {}) => fetch(`${base}${url}`, { method, redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
  try {
    await run(get, root)
  } finally {
    server.close()
  }
}

test('previews list what was built for this job, newest first', async () => {
  const root = folder()
  const list = await listPreviews(JOB, { root, host: '192.168.0.4', port: 5290 })
  assert.deepEqual(list.map((p) => p.name), ['Baltis', 'Aldis'])
  assert.equal(list[0].url, `http://192.168.0.4:5290/open/${KEY}`)
  assert.equal(list[1].url, '')
  assert.equal(list[1].note, 'Build failed')
  assert.deepEqual(await listPreviews('other', { root, host: 'x' }), [])
  assert.deepEqual(await listPreviews(JOB, { root: path.join(root, 'none'), host: 'x' }), [])
})

test('a link sets the build, and files then come from its folder', async () => {
  await withServer(async (get) => {
    const open = await get(`/open/${KEY}`)
    assert.equal(open.status, 302)
    const cookie = open.headers.get('set-cookie').split(';')[0]
    assert.match(open.headers.get('set-cookie'), /HttpOnly/)
    const page = await get('/', { cookie })
    assert.equal(await page.text(), '<h1>Game</h1>')
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/)
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await get('/assets/a.js', { cookie })).headers.get('content-type'), 'text/javascript')
  })
})

test('nothing is served without a link, or for a failed or unknown build', async () => {
  await withServer(async (get) => {
    assert.equal((await get('/')).status, 404)
    assert.equal((await get(`/open/${FAILED}`)).status, 404)
    assert.equal((await get(`/open/${'c'.repeat(32)}`)).status, 404)
    assert.equal((await get('/open/not-a-key')).status, 404)
  })
})

test('a build cannot reach outside its own folder', async () => {
  await withServer(async (get) => {
    const cookie = `atrium-preview=${KEY}`
    assert.equal((await get('/%2e%2e/%2e%2e/secret.txt', { cookie })).status, 404)
    assert.equal((await get('/..%2f..%2fsecret.txt', { cookie })).status, 404)
    assert.equal((await get('/link.txt', { cookie })).status, 404)
    assert.equal((await get('/assets', { cookie })).status, 404)
    assert.equal((await get('/%00', { cookie })).status, 404)
    assert.equal((await get('/%E0%A4%A', { cookie })).status, 404)
  })
})

test('service workers are never served, and previews are read only', async () => {
  await withServer(async (get) => {
    const cookie = `atrium-preview=${KEY}`
    assert.equal((await get('/sw.js', { cookie })).status, 404)
    assert.equal((await get('/', { cookie, method: 'POST' })).status, 405)
  })
})
