import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { withCurve } from '../core/curve.js'
import { createHeadquarters } from './hq.js'

/**
 * The commons: the reception cell's floor, around the arrival steps, furnished as the office's
 * shared space — a lounge, a coffee bar, a water cooler, a ping-pong table, an arcade cabinet,
 * bean bags, a big status board that shows the whole office at a glance, and Director Atlas's
 * HQ (see `hq.js`).
 *
 * Local coordinates, centred on the reception cell. New bots come down the steps and leave
 * toward +X, so that side is kept clear as a walkway. The default camera looks in from +X/+Z,
 * so the status board stands at the back, facing it.
 *
 * Everything but the board's screen is one vertex-coloured merged mesh; the screen is a
 * canvas texture redrawn when the numbers change.
 */

class Parts {
  constructor() {
    this.solid = []
    this.glow = []
  }

  add(geo, color, { glow = false } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo
    if (g !== geo) geo.dispose()
    g.deleteAttribute('uv')
    const c = new THREE.Color(color)
    const colors = new Float32Array(g.attributes.position.count * 3)
    for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i)
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    ;(glow ? this.glow : this.solid).push(g)
    return g
  }

  box(w, h, d, color, x, y, z, ry = 0, opts) {
    const g = new THREE.BoxGeometry(w, h, d)
    g.rotateY(ry)
    g.translate(x, y, z)
    return this.add(g, color, opts)
  }

  cyl(r, h, color, x, y, z, segments = 16, opts) {
    const g = new THREE.CylinderGeometry(r, r, h, segments)
    g.translate(x, y, z)
    return this.add(g, color, opts)
  }

  /** A group of parts placed and turned together, built around its own origin. */
  piece(x, z, ry, build) {
    const start = { solid: this.solid.length, glow: this.glow.length }
    build()
    const m = new THREE.Matrix4().makeRotationY(ry).setPosition(x, 0, z)
    for (const g of this.solid.slice(start.solid)) g.applyMatrix4(m)
    for (const g of this.glow.slice(start.glow)) g.applyMatrix4(m)
  }

  mesh(list, material) {
    if (!list.length) return null
    const geo = mergeGeometries(list, false)
    for (const g of list) g.dispose()
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }
}

function curved(material) {
  material.onBeforeCompile = (shader) => withCurve(shader)
  return material
}

/** Status board: a canvas the atrium redraws with the office's numbers. */
function statusBoard(style) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 512
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  const draw = (stats = {}) => {
    const c = canvas.getContext('2d')
    const bg = c.createLinearGradient(0, 0, 0, 512)
    bg.addColorStop(0, '#0f1a1f')
    bg.addColorStop(1, '#0a1014')
    c.fillStyle = bg
    c.fillRect(0, 0, 1024, 512)
    c.fillStyle = '#7fe0b3'
    c.font = '600 34px "Barlow Semi Condensed", ui-sans-serif, system-ui, sans-serif'
    c.fillText('ATRIUM HQ · DIRECTOR ATLAS', 52, 74)
    const now = new Date()
    c.textAlign = 'right'
    c.fillStyle = '#9fb4bd'
    c.fillText(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 972, 74)
    c.textAlign = 'left'
    const tiles = [
      ['ON SHIFT', stats.working ?? 0, '#5ce59a'],
      ['MISSIONS', stats.missions ?? 0, '#76a8ff'],
      ['LOW ENERGY', stats.lowEnergy ?? 0, '#ffbf65'],
      ['TOKENS', stats.tokens || '—', '#e8eef0'],
    ]
    tiles.forEach(([label, value, color], i) => {
      const x = 52 + i * 236
      c.fillStyle = 'rgba(255,255,255,0.05)'
      c.beginPath()
      c.roundRect(x, 130, 212, 300, 22)
      c.fill()
      c.fillStyle = color
      c.font = `700 ${String(value).length > 3 ? 66 : 140}px "Barlow Semi Condensed", ui-sans-serif, system-ui, sans-serif`
      c.fillText(String(value), x + 26, 330)
      c.fillStyle = '#9fb4bd'
      c.font = '600 28px "Barlow Semi Condensed", ui-sans-serif, system-ui, sans-serif'
      c.fillText(label, x + 28, 398)
    })
    c.fillStyle = '#9fb4bd'
    c.font = '600 24px "Barlow Semi Condensed", ui-sans-serif, system-ui, sans-serif'
    c.fillText('THE FULL STORY IS IN ATLAS’S HQ, NEXT DOOR', 52, 478)
    texture.needsUpdate = true
  }
  draw()
  const geo = new THREE.PlaneGeometry(4.0, 2.0)
  const mat = curved(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }))
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'status-board-screen'
  return { mesh, draw, dispose: () => { texture.dispose(); geo.dispose(); mat.dispose() } }
}

/**
 * Build the commons for a style. Returns the group (place it at the reception cell), the
 * obstacles in local coordinates for navigation, and `setStats` for the status board.
 */
export function createCommons(style) {
  const p = new Parts()
  const f = style.furniture
  const obstacles = []
  const block = (x, z, r) => obstacles.push({ x, z, r })

  // Lounge, at the back: a rug, an L of sofas round a low table, and a floor lamp.
  p.piece(-3.8, 3.2, 0, () => {
    p.cyl(1.75, 0.02, f.rug, 0, 0.01, 0, 32)
    for (const [x, z, ry] of [[-1.35, 0, Math.PI / 2], [0, -1.35, 0]]) {
      p.box(2.2, 0.38, 0.8, f.sofa, x, 0.19, z, ry)
      p.box(2.2, 0.5, 0.22, f.sofa, x - Math.sin(ry) * 0.36, 0.5, z - Math.cos(ry) * 0.36, ry)
      for (const side of [-1, 1]) p.box(0.2, 0.55, 0.8, f.sofa, x + Math.cos(ry) * side * 1.0, 0.28, z - Math.sin(ry) * side * 1.0, ry)
    }
    p.box(1.1, 0.06, 0.7, f.wood, 0.3, 0.38, 0.3)
    for (const [x, z] of [[-0.15, 0.05], [0.75, 0.05], [-0.15, 0.55], [0.75, 0.55]]) p.box(0.06, 0.35, 0.06, f.wood, x, 0.175, z)
    p.cyl(0.07, 0.08, 0xf2efe8, 0.1, 0.45, 0.2, 10)
    p.cyl(0.05, 1.7, 0x2e333b, -1.3, 0.85, -1.3, 8)
    p.cyl(0.24, 0.3, 0xfff1cc, -1.3, 1.75, -1.3, 14, { glow: true })
  })
  block(-3.8, 3.2, 1.9)

  // Coffee bar: a counter, an espresso machine with a warm glow, a stack of cups.
  p.piece(-1.2, -5.4, Math.PI / 6, () => {
    p.box(2.4, 1.0, 0.7, f.wood, 0, 0.5, 0)
    p.box(2.5, 0.05, 0.78, 0xf2efe8, 0, 1.025, 0)
    p.box(0.55, 0.5, 0.42, 0x2e333b, -0.6, 1.3, -0.05)
    p.box(0.4, 0.08, 0.05, 0xffb35c, -0.6, 1.42, 0.17, 0, { glow: true })
    for (let i = 0; i < 4; i++) p.cyl(0.06, 0.09, i % 2 ? 0xd8553c : 0xf2efe8, 0.3 + i * 0.16, 1.1, 0.1, 10)
    p.box(0.3, 0.4, 0.3, 0x5f9a62, 0.95, 1.25, -0.1)
  })
  block(-1.2, -5.4, 1.4)

  // Water cooler.
  p.piece(2.6, -5.2, 0, () => {
    p.box(0.42, 1.0, 0.42, 0xe9ecef, 0, 0.5, 0)
    p.cyl(0.2, 0.5, 0x8fd0ff, 0, 1.25, 0, 14)
  })
  block(2.6, -5.2, 0.5)

  // Ping-pong table, with a net, in front.
  p.piece(0.6, 5.0, 0.15, () => {
    p.box(2.6, 0.06, 1.45, f.table, 0, 0.78, 0)
    p.box(2.6, 0.012, 0.03, 0xffffff, 0, 0.815, 0)
    p.box(0.02, 0.15, 1.5, 0xf2efe8, 0, 0.88, 0)
    for (const [x, z] of [[-1.1, -0.6], [1.1, -0.6], [-1.1, 0.6], [1.1, 0.6]]) p.box(0.07, 0.75, 0.07, 0x2e333b, x, 0.375, z)
  })
  block(0.6, 5.0, 1.5)

  // Arcade cabinet, its screen in the style's accent.
  p.piece(-1.9, 6.7, Math.PI * 0.15, () => {
    p.box(0.7, 1.75, 0.65, 0x23262d, 0, 0.875, 0)
    p.box(0.52, 0.42, 0.04, f.glow, 0, 1.35, 0.33, 0, { glow: true })
    p.box(0.6, 0.1, 0.3, 0x3a3f48, 0, 1.0, 0.42)
    p.box(0.7, 0.12, 0.66, f.glow, 0, 1.81, 0, 0, { glow: true })
  })
  block(-1.9, 6.7, 0.6)

  // Bean bags round the ping-pong table.
  for (const [x, z, color] of [[3.3, 3.9, f.sofa], [3.9, 5.2, f.glow]]) {
    const g = new THREE.SphereGeometry(0.55, 14, 10)
    g.scale(1, 0.55, 1)
    g.translate(x, 0.3, z)
    p.add(g, color)
    block(x, z, 0.55)
  }

  const group = new THREE.Group()
  group.name = 'commons'
  const solid = p.mesh(p.solid, curved(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.02 })))
  const glow = p.mesh(p.glow, curved(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })))
  if (solid) group.add(solid)
  if (glow) {
    glow.castShadow = false
    group.add(glow)
  }

  // The status board, on two legs at the back, angled toward the camera's usual seat.
  const board = statusBoard(style)
  const boardAt = { x: -7.6, z: 3.6, ry: Math.PI * 0.62 }
  const stand = new Parts()
  stand.piece(boardAt.x, boardAt.z, boardAt.ry, () => {
    for (const s of [-1, 1]) stand.box(0.1, 2.4, 0.1, 0x3a3f48, s * 1.7, 1.2, -0.08)
    stand.box(4.25, 2.25, 0.12, 0x1c2026, 0, 2.55, -0.08)
  })
  const standMesh = stand.mesh(stand.solid, curved(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 })))
  if (standMesh) group.add(standMesh)
  if (board) {
    board.mesh.position.set(boardAt.x, 2.55, boardAt.z)
    board.mesh.rotation.y = boardAt.ry
    group.add(board.mesh)
  }
  block(boardAt.x, boardAt.z, 0.6)

  // Atlas's HQ, at the back left, outside the arrival lane.
  const hq = createHeadquarters(style)
  const hqAt = { x: -7.6, z: -2.4 }
  hq.group.position.set(hqAt.x, 0, hqAt.z)
  group.add(hq.group)
  for (const o of hq.obstacles) block(hqAt.x + o.x, hqAt.z + o.z, o.r)

  let last = ''
  let office = {}
  return {
    group,
    obstacles,
    // What a click on the commons can open: a screen opens its own tab of the HQ panel.
    targets: [...hq.targets, ...(board ? [{ mesh: board.mesh, action: 'briefing' }] : [])],
    director: hq.group,
    setHover: (action, mesh) => hq.setHover(action, mesh),
    setOffice(data) {
      office = { missions: data.missions, lowEnergy: data.lowEnergy, tokens: data.tokens }
      last = ''
      hq.setOffice(data)
    },
    update(elapsed, reducedMotion) {
      hq.update(elapsed, reducedMotion)
    },
    setStats(stats) {
      if (!board) return
      const minute = Math.floor(Date.now() / 60000)
      const key = `${stats.working}/${stats.waiting}/${stats.blocked}/${stats.agents}/${minute}/${JSON.stringify(office)}`
      if (key === last) return
      last = key
      board.draw({ ...stats, ...office })
    },
    dispose() {
      board?.dispose()
      group.traverse((o) => {
        if (!o.isMesh) return
        o.geometry.dispose()
        o.material.map?.dispose()
        o.material.dispose()
      })
    },
  }
}
