import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { withCurve } from '../core/curve.js'

/**
 * Director Atlas's HQ: a big glass hex office in the commons where the office's numbers live
 * on the walls instead of behind a click.
 *
 * Three wall screens face the default camera — rank and trophies, the fourteen-day energy
 * trail, and the mission board — and two kiosks by the door show the repo workshop and the
 * chronicle. A trophy cabinet under the rank screen lights a cup for each achievement. Every
 * screen, the cabinet and Atlas are pick targets that open the matching tab of the HQ panel,
 * so the details are one click from the thing that summarises them.
 *
 * Built around its own origin; the commons places it. Everything solid is one merged mesh;
 * each screen is a canvas texture redrawn only when its own numbers change.
 */

/** The hex's circumradius: also the length of each wall. */
export const HQ_RADIUS = 3.4
const WALL = 3.2
const APOTHEM = HQ_RADIUS * Math.cos(Math.PI / 6)
const FONT = '"Barlow Semi Condensed", ui-sans-serif, system-ui, sans-serif'

/** The achievements on the cabinet, in order. Each reads the same data the screens do. */
export const TROPHIES = [
  { id: 'handoff', name: 'First handoff', hint: 'Seal a mission packet', earned: (d) => d.missionCount > 0 },
  { id: 'cleared', name: 'Mission cleared', hint: 'Complete a mission', earned: (d) => d.xp >= 100 },
  { id: 'inbox', name: 'Inbox zero', hint: 'Nobody waiting or blocked', earned: (d) => d.agents > 0 && !d.waiting && !d.blocked },
  { id: 'house', name: 'Full house', hint: 'Five bots working at once', earned: (d) => d.working >= 5 },
  { id: 'shipped', name: 'Shipped', hint: 'A pull request lands', earned: (d) => d.celebrating > 0 || d.merged > 0 },
  { id: 'million', name: 'Million day', hint: 'A million tokens in a day', earned: (d) => d.todayTokens >= 1e6 },
]

const LEVEL_XP = 500
export const levelFor = (xp = 0) => 1 + Math.floor(Math.max(0, xp) / LEVEL_XP)

class Parts {
  constructor() { this.list = [] }
  add(geo, color, x = 0, y = 0, z = 0, ry = 0) {
    const g = geo.index ? geo.toNonIndexed() : geo
    if (g !== geo) geo.dispose()
    g.deleteAttribute('uv')
    g.rotateY(ry)
    g.translate(x, y, z)
    const c = new THREE.Color(color)
    const colors = new Float32Array(g.attributes.position.count * 3)
    for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i)
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.list.push(g)
    return g
  }
  box(w, h, d, color, x, y, z, ry) { return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, ry) }
  cyl(rt, rb, h, color, x, y, z, seg = 16) { return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), color, x, y, z) }
  mesh(material) {
    const geo = mergeGeometries(this.list, false)
    this.list.forEach((g) => g.dispose())
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, material)
    mesh.castShadow = mesh.receiveShadow = true
    return mesh
  }
}

const curved = (material) => {
  material.onBeforeCompile = (shader) => withCurve(shader)
  return material
}

/** Rotate a local point (x, z) by `ry` about Y, as three does. */
const turn = (x, z, ry) => [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)]

/**
 * A screen: a canvas on a plane, a dark bezel behind it, and a glow frame that lights when the
 * pointer is on it. `paint(c, w, h, data)` draws it.
 */
function screen(width, height, paint, accent) {
  const group = new THREE.Group()
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(width + 0.16, height + 0.16, 0.06), curved(new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.5 })))
  bezel.position.z = -0.035
  group.add(bezel)
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.34, height + 0.34), curved(new THREE.MeshBasicMaterial({ color: accent, toneMapped: false, transparent: true, opacity: 0.85 })))
  glow.position.z = -0.07
  glow.visible = false
  group.add(glow)
  let draw = () => {}
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = 768
    canvas.height = Math.round((768 * height) / width)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), curved(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })))
    face.position.z = 0.002
    group.add(face)
    const c = canvas.getContext('2d')
    let last = ''
    draw = (data) => {
      const key = JSON.stringify(data)
      if (key === last) return
      last = key
      const bg = c.createLinearGradient(0, 0, 0, canvas.height)
      bg.addColorStop(0, '#102027')
      bg.addColorStop(1, '#0a1216')
      c.fillStyle = bg
      c.fillRect(0, 0, canvas.width, canvas.height)
      paint(c, canvas.width, canvas.height, data)
      texture.needsUpdate = true
    }
  }
  return { group, glow, draw, setHover: (on) => { glow.visible = on } }
}

const title = (c, text, color = '#7fe0b3') => {
  c.fillStyle = color
  c.font = `700 34px ${FONT}`
  c.textAlign = 'left'
  c.fillText(text, 34, 54)
  c.fillStyle = '#5c7480'
  c.font = `600 20px ${FONT}`
  c.textAlign = 'right'
  c.fillText('CLICK FOR DETAILS', 734, 52)
  c.textAlign = 'left'
}
const fit = (c, text, max) => {
  let line = String(text ?? '')
  while (line.length > 1 && c.measureText(line).width > max) line = line.slice(0, -2) + '…'
  return line
}
const short = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n || 0))

const paintRank = (c, w, h, d) => {
  title(c, 'DIRECTOR ATLAS · COORDINATOR RANK')
  const level = levelFor(d.xp)
  c.fillStyle = '#ffd27a'
  c.font = `700 110px ${FONT}`
  c.fillText(`LV ${level}`, 34, 178)
  c.fillStyle = '#e8eef0'
  c.font = `600 30px ${FONT}`
  c.fillText(`${d.xp || 0} office XP`, 300, 118)
  // XP bar to the next level.
  const into = (d.xp || 0) % LEVEL_XP
  c.fillStyle = 'rgba(255,255,255,0.08)'
  c.beginPath(); c.roundRect(300, 136, 430, 26, 13); c.fill()
  c.fillStyle = '#ffbf4d'
  c.beginPath(); c.roundRect(300, 136, Math.max(26, (430 * into) / LEVEL_XP), 26, 13); c.fill()
  c.fillStyle = '#9fb4bd'
  c.font = `600 22px ${FONT}`
  c.fillText(`${LEVEL_XP - into} XP to level ${level + 1} · +100 per mission cleared`, 300, 194)
  // The crew right now.
  const tiles = [['ON SHIFT', d.working, '#5ce59a'], ['NEED YOU', d.waiting, '#76a8ff'], ['BLOCKED', d.blocked, '#ff6b5f'], ['TROPHIES', `${d.trophies}/${TROPHIES.length}`, '#ffd27a']]
  tiles.forEach(([label, value, color], i) => {
    const x = 34 + i * 178
    c.fillStyle = 'rgba(255,255,255,0.05)'
    c.beginPath(); c.roundRect(x, 222, 160, 118, 16); c.fill()
    c.fillStyle = color
    c.font = `700 62px ${FONT}`
    c.fillText(String(value ?? 0), x + 18, 292)
    c.fillStyle = '#9fb4bd'
    c.font = `600 20px ${FONT}`
    c.fillText(label, x + 20, 324)
  })
  if (d.nextTrophy) {
    c.fillStyle = '#ffd27a'
    c.font = `600 22px ${FONT}`
    c.fillText(fit(c, `NEXT TROPHY · ${d.nextTrophy.name.toUpperCase()}: ${d.nextTrophy.hint}`, 700), 34, h - 26)
  }
}

const paintEnergy = (c, w, h, d) => {
  title(c, 'ENERGY LAB · 14 DAYS', '#8fd0ff')
  const days = d.days || []
  const max = Math.max(1, ...days.map((x) => x.totalTokens))
  const base = h - 70
  const bw = (w - 80) / Math.max(1, days.length)
  days.forEach((day, i) => {
    const bh = ((h - 170) * day.totalTokens) / max
    const x = 40 + i * bw
    const today = i === days.length - 1
    c.fillStyle = today ? '#ffd27a' : '#4f8fe0'
    c.beginPath(); c.roundRect(x + 4, base - bh, bw - 8, Math.max(bh, 3), 6); c.fill()
    const cached = day.totalTokens ? (bh * day.cachedInputTokens) / day.totalTokens : 0
    c.fillStyle = today ? 'rgba(255,255,255,0.35)' : '#3fb6a0'
    c.beginPath(); c.roundRect(x + 4, base - cached, bw - 8, cached, 6); c.fill()
  })
  c.fillStyle = '#9fb4bd'
  c.font = `600 22px ${FONT}`
  c.fillText(`TODAY ${short(d.todayTokens)} · PEAK ${short(max === 1 ? 0 : max)} · TEAL IS CACHED INPUT`, 40, h - 28)
  if (d.lowEnergy) {
    c.fillStyle = '#ffbf65'
    c.textAlign = 'right'
    c.fillText(`${d.lowEnergy} LOW ALLOWANCE`, w - 40, h - 28)
    c.textAlign = 'left'
  }
}

const paintMissions = (c, w, h, d) => {
  title(c, 'MISSION BOARD', '#ffd27a')
  c.fillStyle = '#e8eef0'
  c.font = `700 84px ${FONT}`
  c.fillText(String(d.missions || 0), 34, 160)
  c.fillStyle = '#9fb4bd'
  c.font = `600 24px ${FONT}`
  c.fillText('OPEN PACKETS', 34, 196)
  const list = d.openMissions || []
  if (!list.length) {
    c.fillStyle = '#5c7480'
    c.fillText('No open missions. Click to brief one bot for another.', 200, 150)
  }
  list.slice(0, 4).forEach((m, i) => {
    const y = 96 + i * 62
    c.fillStyle = 'rgba(255,255,255,0.05)'
    c.beginPath(); c.roundRect(200, y, 534, 52, 12); c.fill()
    c.fillStyle = m.status === 'delivered' ? '#76a8ff' : '#ffbf4d'
    c.beginPath(); c.arc(224, y + 26, 8, 0, Math.PI * 2); c.fill()
    c.fillStyle = '#e8eef0'
    c.font = `600 22px ${FONT}`
    c.fillText(fit(c, m.brief, 470), 244, y + 24)
    c.fillStyle = '#9fb4bd'
    c.font = `500 18px ${FONT}`
    c.fillText(fit(c, `→ ${m.target}`, 470), 244, y + 44)
  })
}

const paintWorkshop = (c, w, h, d) => {
  title(c, 'WORKSHOP', '#9ae6b4')
  const rows = [['CI PASSING', d.passing, '#5ce59a'], ['CI FAILING', d.failing, '#ff6b5f'], ['OPEN PRS', d.prs, '#76a8ff'], ['LOCAL MODELS', d.localModels, '#ffd27a']]
  rows.forEach(([label, value, color], i) => {
    const x = 34 + (i % 2) * 360
    const y = 90 + Math.floor(i / 2) * 150
    c.fillStyle = 'rgba(255,255,255,0.05)'
    c.beginPath(); c.roundRect(x, y, 340, 130, 16); c.fill()
    c.fillStyle = color
    c.font = `700 70px ${FONT}`
    c.fillText(String(value ?? 0), x + 24, y + 80)
    c.fillStyle = '#9fb4bd'
    c.font = `600 22px ${FONT}`
    c.fillText(label, x + 24, y + 114)
  })
}

const paintChronicle = (c, w, h, d) => {
  title(c, 'CHRONICLE', '#c3a6ff')
  const events = d.events || []
  if (!events.length) {
    c.fillStyle = '#5c7480'
    c.font = `600 24px ${FONT}`
    c.fillText('The chronicle starts when something changes.', 34, 130)
  }
  events.slice(0, 5).forEach((e, i) => {
    const y = 94 + i * 64
    c.fillStyle = '#c3a6ff'
    c.font = `600 18px ${FONT}`
    c.fillText(String(e.kind || '').replaceAll('-', ' ').toUpperCase(), 34, y + 18)
    c.fillStyle = '#e8eef0'
    c.font = `600 24px ${FONT}`
    c.fillText(fit(c, e.title, 690), 34, y + 46)
  })
}

/** Build the HQ. Returns the group, local obstacles and the hooks the commons forwards. */
export function createHeadquarters(style) {
  const f = style.furniture
  const group = new THREE.Group()
  group.name = 'director-atlas'
  const obstacles = []
  const block = (x, z, r) => obstacles.push({ x, z, r })

  // ── the room: floor, posts and glass, the portal facing the open floor ───────────────
  const shell = new Parts()
  shell.cyl(HQ_RADIUS, HQ_RADIUS, 0.07, style.room.base, 0, 0.035, 0, 6)
  shell.cyl(HQ_RADIUS * 0.62, HQ_RADIUS * 0.62, 0.02, f.rug, 0, 0.08, 0, 6)
  const panes = []
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3
    const b = ((i + 1) * Math.PI) / 3
    const x = Math.cos(a) * HQ_RADIUS
    const z = Math.sin(a) * HQ_RADIUS
    shell.box(0.1, WALL + 0.1, 0.1, style.frame.post, x, (WALL + 0.1) / 2, z)
    if (i === 0) continue // the portal faces the open floor
    const mx = (x + Math.cos(b) * HQ_RADIUS) / 2
    const mz = (z + Math.sin(b) * HQ_RADIUS) / 2
    const ry = -Math.atan2(Math.sin(b) - Math.sin(a), Math.cos(b) - Math.cos(a))
    // The walls the camera looks through stay low; the back three are full height for screens.
    const height = mz + mx > 0 ? 1.15 : WALL
    shell.box(HQ_RADIUS, 0.08, 0.08, style.frame.top, mx, height + 0.06, mz, ry)
    shell.box(HQ_RADIUS, 0.12, 0.14, style.frame.base, mx, 0.06, mz, ry)
    const pane = new THREE.BoxGeometry(HQ_RADIUS - 0.08, height, 0.03)
    pane.rotateY(ry)
    pane.translate(mx, height / 2 + 0.06, mz)
    panes.push(pane)
    for (let t = 0; t <= 1.0001; t += 0.12) block(x + (Math.cos(b) * HQ_RADIUS - x) * t, z + (Math.sin(b) * HQ_RADIUS - z) * t, 0.1)
  }
  group.add(shell.mesh(curved(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }))))
  const glassGeo = mergeGeometries(panes)
  panes.forEach((p) => p.dispose())
  group.add(new THREE.Mesh(glassGeo, curved(new THREE.MeshStandardMaterial({ color: style.glass.color, opacity: style.glass.opacity, transparent: true, depthWrite: false, roughness: 0.2, side: THREE.DoubleSide }))))

  // ── Atlas at a big desk, facing the portal ───────────────────────────────────────────
  // Interior pieces are authored facing +Z and turned toward the portal (30°).
  const face = Math.PI / 3
  const atlas = new THREE.Group()
  atlas.rotation.y = face
  const desk = new Parts()
  desk.box(2.3, 0.09, 0.95, f.wood, 0, 0.88, 0.1)
  for (const x of [-0.98, 0.98]) desk.box(0.1, 0.84, 0.82, style.frame.post, x, 0.42, 0.1)
  desk.box(1.8, 0.5, 0.05, f.wood, 0, 0.6, 0.55)
  desk.box(0.55, 0.03, 0.2, 0x182d38, 0, 0.94, 0.25)
  desk.cyl(0.09, 0.09, 0.13, 0xf4eee2, 0.82, 0.99, 0.3, 12)
  // Atlas's chair and seated body.
  desk.box(0.9, 0.12, 0.7, 0x263944, 0, 0.56, -0.75)
  desk.box(0.9, 1.05, 0.14, 0x263944, 0, 1.0, -1.08)
  desk.cyl(0.08, 0.08, 0.4, 0x263944, 0, 0.23, -0.75, 8)
  desk.box(0.56, 0.5, 0.32, 0x28546b, 0, 0.9, -0.66)
  desk.box(0.1, 0.33, 0.035, 0xffcc65, 0, 0.94, -0.49)
  for (const x of [-0.21, 0.21]) { desk.box(0.18, 0.26, 0.24, 0x28546b, x, 0.5, -0.33); desk.box(0.21, 0.13, 0.38, 0x182d38, x, 0.32, -0.2) }
  for (const x of [-0.42, 0.42]) desk.box(0.19, 0.16, 0.58, 0x28546b, x, 0.93, -0.3)
  const deskMesh = desk.mesh(curved(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 })))
  atlas.add(deskMesh)
  const headParts = new Parts()
  headParts.box(0.8, 0.58, 0.42, 0x263944, 0, 0, 0)
  headParts.box(0.66, 0.44, 0.03, 0x091b24, 0, 0, 0.23)
  for (const x of [-0.15, 0.15]) headParts.box(0.08, 0.11, 0.04, 0x81edc4, x, 0.05, 0.255)
  headParts.box(0.18, 0.028, 0.04, 0x81edc4, 0, -0.1, 0.255)
  headParts.cyl(0.05, 0.05, 0.17, 0xffcc65, 0, 0.37, 0, 8)
  const head = headParts.mesh(curved(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 })))
  head.position.set(0, 1.42, -0.64)
  atlas.add(head)
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), curved(new THREE.MeshBasicMaterial({ color: 0x81edc4 })))
  beacon.position.set(0, 1.92, -0.64)
  atlas.add(beacon)
  // Mission packets stack up on the desk.
  const missionStack = []
  for (let i = 0; i < 5; i++) {
    const envelope = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.045, 0.24), curved(new THREE.MeshStandardMaterial({ color: i % 2 ? 0xd5eaf9 : 0xfff2d6, roughness: 0.65 })))
    envelope.position.set(-0.7 + (i % 2) * 0.025, 0.955 + i * 0.05, 0.25)
    envelope.rotation.y = i * 0.08
    envelope.visible = false
    atlas.add(envelope)
    missionStack.push(envelope)
  }
  atlas.position.set(...(() => { const [x, z] = turn(0, -0.55, face); return [x, 0, z] })())
  group.add(atlas)
  { const [x, z] = turn(0, -0.75, face); block(x, z, 1.25) }

  // ── wall screens on the three back walls, each facing into the room ──────────────────
  const accent = style.furniture.glow ?? 0x7fe0b3
  const screens = {}
  const wall = (deg, key, paint) => {
    const s = screen(2.7, 1.45, paint, accent)
    const a = (deg * Math.PI) / 180
    s.group.position.set(Math.cos(a) * (APOTHEM - 0.12), 2.05, Math.sin(a) * (APOTHEM - 0.12))
    s.group.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a))
    group.add(s.group)
    screens[key] = s
  }
  wall(210, 'briefing', paintRank)
  wall(150, 'energy', paintEnergy)
  wall(270, 'missions', paintMissions)

  // Two kiosks by the door, angled to the camera: the workshop and the chronicle.
  const kiosk = (x, z, key, paint) => {
    const stand = new Parts()
    stand.cyl(0.32, 0.36, 0.06, 0x2e333b, 0, 0.03, 0)
    stand.box(0.12, 1.1, 0.12, 0x8b929c, 0, 0.6, 0)
    const legs = stand.mesh(curved(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 })))
    legs.position.set(x, 0, z)
    group.add(legs)
    const s = screen(1.3, 0.95, paint, accent)
    s.group.position.set(x, 1.55, z)
    s.group.rotation.set(-0.15, Math.PI / 4, 0, 'YXZ')
    group.add(s.group)
    screens[key] = s
    block(x, z, 0.4)
  }
  // Either side of the doorway, which faces 30°.
  kiosk(2.2, -0.2, 'workshop', paintWorkshop)
  kiosk(0.9, 2.0, 'chronicle', paintChronicle)

  // ── the trophy cabinet, under the rank screen ────────────────────────────────────────
  const cabinet = new THREE.Group()
  const shelf = new Parts()
  shelf.box(2.6, 0.82, 0.42, f.wood, 0, 0.41, 0)
  shelf.box(2.7, 0.05, 0.46, 0xf2efe8, 0, 0.845, 0)
  cabinet.add(shelf.mesh(curved(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }))))
  const cups = TROPHIES.map((_, i) => {
    const cup = new Parts()
    cup.cyl(0.07, 0.09, 0.05, 0x2e333b, 0, 0.025, 0, 10)
    cup.cyl(0.025, 0.025, 0.12, 0xffffff, 0, 0.11, 0, 8)
    cup.cyl(0.12, 0.05, 0.16, 0xffffff, 0, 0.25, 0, 14)
    for (const s of [-1, 1]) cup.add(new THREE.TorusGeometry(0.05, 0.014, 6, 12), 0xffffff, s * 0.13, 0.26, 0, Math.PI / 2)
    const mesh = cup.mesh(curved(new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x6f747c, roughness: 0.35, metalness: 0.6, emissive: 0x000000 })))
    mesh.position.set(-1.05 + i * 0.42, 0.87, 0.02)
    cabinet.add(mesh)
    return mesh
  })
  {
    const a = (210 * Math.PI) / 180
    cabinet.position.set(Math.cos(a) * (APOTHEM - 0.4), 0, Math.sin(a) * (APOTHEM - 0.4))
    cabinet.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a))
    block(cabinet.position.x, cabinet.position.z, 0.6)
  }
  group.add(cabinet)

  // ── the name plate over the portal ───────────────────────────────────────────────────
  if (typeof document !== 'undefined') {
    const plate = document.createElement('canvas')
    plate.width = 768
    plate.height = 160
    const c = plate.getContext('2d')
    c.fillStyle = style.sign.plate
    c.fillRect(0, 0, 768, 160)
    c.textAlign = 'center'
    c.fillStyle = style.sign.text
    c.font = `700 58px ${FONT}`
    c.fillText('ATLAS · HQ', 384, 76)
    c.font = `500 28px ${FONT}`
    c.fillText('CLICK A SCREEN FOR ITS DETAILS', 384, 124)
    const texture = new THREE.CanvasTexture(plate)
    texture.colorSpace = THREE.SRGBColorSpace
    // Along the top of the back wall, over the rank screen: over the portal it would stand
    // between the camera and Atlas.
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 0.62), curved(new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false })))
    const a = (210 * Math.PI) / 180
    sign.position.set(Math.cos(a) * (APOTHEM - 0.1), WALL + 0.42, Math.sin(a) * (APOTHEM - 0.1))
    sign.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a))
    group.add(sign)
  }

  const targets = [
    ...Object.entries(screens).map(([action, s]) => ({ mesh: s.group, action, priority: 1 })),
    { mesh: cabinet, action: 'briefing' },
    { mesh: atlas, action: 'briefing' },
  ]

  return {
    group,
    obstacles,
    targets,
    setHover(action, mesh) {
      for (const [key, s] of Object.entries(screens)) s.setHover(key === action && (!mesh || mesh === s.group))
    },
    /** `data` is the office summary main.js assembles: crew, energy, missions, health, events. */
    setOffice(data) {
      const earned = TROPHIES.map((t) => Boolean(t.earned(data)))
      const view = { ...data, trophies: earned.filter(Boolean).length, nextTrophy: TROPHIES.find((_, i) => !earned[i]) || null }
      for (const s of Object.values(screens)) s.draw(view)
      cups.forEach((cup, i) => {
        cup.material.color.set(earned[i] ? 0xffc84a : 0x6f747c)
        cup.material.emissive.set(earned[i] ? 0x7a4a00 : 0x000000)
      })
      beacon.material.color.set(data.lowEnergy ? 0xffbf65 : 0x81edc4)
      for (let i = 0; i < missionStack.length; i++) missionStack[i].visible = i < (data.missions || 0)
      return view
    },
    update(elapsed, reducedMotion) {
      head.position.y = 1.42 + (reducedMotion ? 0 : Math.sin(elapsed * 1.3) * 0.025)
      head.rotation.y = reducedMotion ? 0 : Math.sin(elapsed * 0.4) * 0.12
    },
  }
}
