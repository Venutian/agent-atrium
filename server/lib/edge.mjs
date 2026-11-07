/**
 * Reaching the studio through Cloudflare, with nothing to switch on in the phone.
 *
 * A Cloudflare Tunnel with no public address carries requests from one Worker to this PC. The Worker
 * lets a request through only with a gate secret, which the door hands to devices that already hold
 * a key. edge.json names the two addresses and holds that secret. The door only reads it.
 */
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const GATE = /^[0-9a-f]{64}$/
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

export const edgeFile = (env = process.env) => env.AGENT_ATRIUM_EDGE_FILE || path.join(os.homedir(), '.config', 'agent-atrium', 'edge.json')

/** Null until the Cloudflare side is set up. */
export function readEdge(file) {
  try {
    const edge = JSON.parse(fs.readFileSync(file, 'utf8'))
    return HOST.test(edge.studio || '') && HOST.test(edge.play || '') && GATE.test(edge.gate || '') ? { studio: edge.studio, play: edge.play, gate: edge.gate } : null
  } catch {
    return null
  }
}

/** The Worker passes requests on from this PC's own tunnel, so they arrive from loopback marked as such. */
export const cameThroughEdge = (req) => LOOPBACK.test(req.socket?.remoteAddress || '') && req.headers['x-ngen-edge'] === '1'

/** The signature the Worker checks on a build link, so a link opens that build and no other. */
export const signPlay = (gate, key) => createHmac('sha256', gate).update(`play:${key}`).digest('hex')
