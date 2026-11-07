/**
 * One key per device, so a lost phone can be cut off alone.
 *
 * Only a hash of each key is kept here, so this file cannot be used to get in. It lives beside the
 * door's own settings and has nothing to do with any agent's files: this is the door's keyring, not
 * Atrium's office data.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_NAME = 40
const EMPTY = { sharedRetired: false, devices: [] }

export const devicesFile = (env = process.env) => env.AGENT_ATRIUM_DEVICES_FILE || path.join(os.homedir(), '.config', 'agent-atrium', 'devices.json')

const digest = (value) => createHash('sha256').update(String(value)).digest()

export function readDevices(file) {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...EMPTY, devices: [] }
  }
}

function writeDevices(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function findDevice(file, key) {
  const given = digest(key)
  return readDevices(file).devices.find((device) => timingSafeEqual(Buffer.from(device.hash, 'hex'), given)) || null
}

/** The key is returned once and never stored, so it cannot be read back. */
export function addDevice(file, name) {
  const state = readDevices(file)
  const key = randomBytes(32).toString('hex')
  const device = {
    id: randomUUID(),
    name: (typeof name === 'string' && name.trim().slice(0, MAX_NAME)) || 'New device',
    hash: digest(key).toString('hex'),
    createdAt: new Date().toISOString(),
    lastSeen: '',
  }
  writeDevices(file, { ...state, devices: [...state.devices, device] })
  return { id: device.id, key }
}

export function revokeDevice(file, id) {
  const state = readDevices(file)
  writeDevices(file, { ...state, devices: state.devices.filter((device) => device.id !== id) })
}

export function touchDevice(file, id, at = new Date().toISOString()) {
  const state = readDevices(file)
  writeDevices(file, { ...state, devices: state.devices.map((device) => (device.id === id ? { ...device, lastSeen: at } : device)) })
}

export function retireShared(file) {
  writeDevices(file, { ...readDevices(file), sharedRetired: true })
}

export const deviceView = ({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })
