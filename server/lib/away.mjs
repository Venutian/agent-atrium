/**
 * Reaching the studio away from home, through a WireGuard tunnel to this PC.
 *
 * A tool on this machine sets the tunnel up and keeps the router's port open. It leaves away.json:
 * the PC's address inside the tunnel and the home internet address the phone's tunnel points at.
 * The door reads it so the app can learn the tunnel address. It writes one thing back: when the
 * phone comes through the tunnel after the home address changed, the phone has the new one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The tunnel address must be private, so this file can never point the app at another machine.
const PRIVATE = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const INTERFACE = /^[\w-]{1,15}$/

export const awayFile = (env = process.env) => env.AGENT_ATRIUM_AWAY_FILE || path.join(os.homedir(), '.config', 'agent-atrium', 'away', 'away.json')

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Null until away access is set up. `changed` means the phone's tunnel still points at an old home address. */
export function readAway(file) {
  const away = readJson(file)
  if (!away || !PRIVATE.test(away.address || '')) return null
  const endpoint = IPV4.test(away.endpoint || '') ? away.endpoint : ''
  const given = IPV4.test(away.phoneEndpoint || '') ? away.phoneEndpoint : endpoint
  const name = INTERFACE.test(away.interface || '') ? away.interface : ''
  return {
    address: away.address,
    port: Number(away.port) || 0,
    endpoint,
    changed: Boolean(endpoint && given !== endpoint),
    up: Boolean(name) && fs.existsSync(`/sys/class/net/${name}`),
  }
}

/**
 * Called for each request with the address it came from. The phone's own tunnel address means it
 * came through the tunnel, whichever of the PC's addresses it asked for, so it has the current home
 * address.
 */
export function noteArrival(file, fromAddress) {
  const from = String(fromAddress || '').replace(/^::ffff:/, '')
  const away = readJson(file)
  if (!away || !PRIVATE.test(away.phone || '') || from !== away.phone || !away.endpoint || away.phoneEndpoint === away.endpoint) return
  const next = `${file}.${process.pid}.tmp`
  fs.writeFileSync(next, JSON.stringify({ ...away, phoneEndpoint: away.endpoint }), { mode: 0o600 })
  fs.renameSync(next, file)
}
