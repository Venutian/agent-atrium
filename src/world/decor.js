import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { withCurve } from '../core/curve.js'
import { lightPoolTexture } from './plots.js'

/**
 * The open floor's furniture: potted trees, benches, lamp posts and the odd sculpture, set in
 * the free spaces just outside the rooms so the floor between them reads as a place rather
 * than a car park. Each spot's arrangement is picked from its grid cell, so it stays the same
 * on every reload; it is rebuilt only when the rooms move.
 *
 * Solid parts merge into one vertex-coloured mesh, glowing parts (lamp heads, sculpture
 * rings) into a second, unlit one that the bloom pass picks up.
 */

class Parts {
  constructor() {
    this.solid = []
    this.glow = []
    /** Where a lamp throws a pool of light on the floor: `{ x, z, r }`. */
    this.pools = []
  }

  add(geo, color, glow = false) {
    const g = geo.index ? geo.toNonIndexed() : geo
    if (g !== geo) geo.dispose()
    g.deleteAttribute('uv')
    const c = new THREE.Color(color)
    const colors = new Float32Array(g.attributes.position.count * 3)
    for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i)
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    ;(glow ? this.glow : this.solid).push(g)
  }

  cyl(rTop, rBottom, h, color, x, y, z, segments = 14, glow = false) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments)
    g.translate(x, y, z)
    this.add(g, color, glow)
  }

  box(w, h, d, color, x, y, z, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d)
    g.rotateY(ry)
    g.translate(x, y, z)
    this.add(g, color)
  }

  blob(r, sy, color, x, y, z, detail = 1) {
    const g = new THREE.IcosahedronGeometry(r, detail)
    g.scale(1, sy, 1)
    g.translate(x, y, z)
    this.add(g, color)
  }
}

function hash(q, r) {
  let h = 2166136261 ^ (q * 73856093) ^ (r * 19349663)
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  return (h ^ (h >>> 15)) >>> 0
}

/** A big tree in a round planter, with a ring bench round it. */
function treeIsland(p, x, z, s, rand) {
  p.cyl(1.25, 1.35, 0.55, s.plants.pot, x, 0.275, z, 24)
  p.cyl(1.15, 1.15, 0.06, 0x4a3a2a, x, 0.56, z, 24)
  p.cyl(0.12, 0.16, 2.2, 0x6b4a32, x, 1.6, z, 8)
  for (let i = 0; i < 5; i++) {
    const a = rand() * Math.PI * 2
    const r = 0.25 + rand() * 0.45
    p.blob(0.75 + rand() * 0.35, 0.85, i % 2 ? s.plants.leaf : s.plants.leafDark, x + Math.cos(a) * r, 2.7 + rand() * 0.8, z + Math.sin(a) * r)
  }
  // The bench ring, in the style's sofa colour.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    p.box(0.95, 0.12, 0.42, s.furniture.sofa, x + Math.cos(a) * 1.75, 0.42, z + Math.sin(a) * 1.75, -a + Math.PI / 2)
    p.box(0.08, 0.36, 0.08, 0x3a3f48, x + Math.cos(a) * 1.75, 0.18, z + Math.sin(a) * 1.75)
  }
  return 2.25
}

/** A pair of lamp posts and a bench between them. */
function lampsAndBench(p, x, z, s, rand) {
  const ry = rand() * Math.PI
  const dx = Math.cos(ry)
  const dz = Math.sin(ry)
  for (const side of [-1, 1]) {
    const lx = x + dx * side * 1.4
    const lz = z + dz * side * 1.4
    p.cyl(0.06, 0.09, 3.2, 0x2e333b, lx, 1.6, lz, 8)
    p.cyl(0.2, 0.2, 0.07, 0x2e333b, lx, 3.2, lz, 12)
    p.cyl(0.17, 0.17, 0.22, s.furniture.glow, lx, 3.06, lz, 12, true)
    p.pools.push({ x: lx, z: lz, r: 2.6 })
  }
  p.box(1.8, 0.1, 0.5, s.furniture.wood, x, 0.45, z, -ry)
  p.box(1.8, 0.4, 0.08, s.furniture.wood, x - dz * 0.22, 0.7, z + dx * 0.22, -ry)
  for (const side of [-1, 1]) p.box(0.08, 0.42, 0.45, 0x2e333b, x + dx * side * 0.8, 0.21, z + dz * side * 0.8, -ry)
  return 1.7
}

/** Three tall potted plants of different heights. */
function plantCluster(p, x, z, s, rand) {
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rand()
    const px = x + Math.cos(a) * 0.75
    const pz = z + Math.sin(a) * 0.75
    const h = 0.5 + rand() * 0.4
    p.cyl(0.38, 0.3, h, s.plants.pot, px, h / 2, pz, 16)
    for (let k = 0; k < 4; k++) {
      p.blob(0.32 + rand() * 0.12, 1.8, k % 2 ? s.plants.leaf : s.plants.leafDark, px + (rand() - 0.5) * 0.3, h + 0.5 + k * 0.28, pz + (rand() - 0.5) * 0.3, 0)
    }
  }
  return 1.3
}

/** A playful sculpture: stacked shapes in the style's colours, ringed with light. */
function sculpture(p, x, z, s, rand) {
  p.cyl(0.9, 1.0, 0.3, s.reception.step, x, 0.15, z, 6)
  const colors = [s.furniture.sofa, s.furniture.table, s.furniture.glow, s.reception.stepAlt]
  let y = 0.3
  for (let i = 0; i < 3; i++) {
    const r = 0.55 - i * 0.12
    const kind = (i + Math.floor(rand() * 3)) % 3
    let g
    if (kind === 0) g = new THREE.IcosahedronGeometry(r, 0)
    else if (kind === 1) g = new THREE.BoxGeometry(r * 1.5, r * 1.5, r * 1.5)
    else g = new THREE.TorusGeometry(r * 0.8, r * 0.3, 8, 16)
    g.rotateY(rand() * Math.PI)
    g.rotateX(kind === 2 ? Math.PI / 2 : rand() * 0.6)
    g.translate(x, y + r, z)
    p.add(g, colors[(i + Math.floor(rand() * 4)) % colors.length])
    y += r * 1.7
  }
  const ring = new THREE.TorusGeometry(1.0, 0.035, 6, 40)
  ring.rotateX(Math.PI / 2)
  ring.translate(x, 0.32, z)
  p.add(ring, s.furniture.glow, true)
  return 1.1
}

const ARRANGEMENTS = [treeIsland, lampsAndBench, plantCluster, sculpture, treeIsland, plantCluster]

function curved(material) {
  material.onBeforeCompile = (shader) => withCurve(shader)
  return material
}

/**
 * Furnish the given free spots — `{ x, z, q, r }` in world space, on the floor — in a style.
 * Returns the group and the circles navigation should keep bots out of.
 */
export function createFloorDecor(spots, style, floorY) {
  const p = new Parts()
  const obstacles = []
  for (const spot of spots) {
    const seed = hash(spot.q, spot.r)
    // About one free spot in five is left open next to the rooms, and half of them further out.
    if (seed % (spot.outer ? 2 : 5) === 0) continue
    let state = seed
    const rand = () => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const arrange = ARRANGEMENTS[(seed >>> 3) % ARRANGEMENTS.length]
    const radius = arrange(p, spot.x, spot.z, style, rand)
    obstacles.push({ x: spot.x, z: spot.z, r: radius })
  }

  const group = new THREE.Group()
  group.name = 'floor-decor'
  group.position.y = floorY
  if (p.solid.length) {
    const geo = mergeGeometries(p.solid, false)
    p.solid.forEach((g) => g.dispose())
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, curved(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.04, flatShading: true })))
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  if (p.glow.length) {
    const geo = mergeGeometries(p.glow, false)
    p.glow.forEach((g) => g.dispose())
    // Pushed past 1.0 so the bloom pass catches lamp heads and sculpture rings.
    const mat = curved(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }))
    mat.color.setScalar(2.2)
    group.add(new THREE.Mesh(geo, mat))
  }
  // The pools of light the lamps throw on the floor, one additive draw for all of them.
  if (p.pools.length && typeof document !== 'undefined') {
    const quads = p.pools.map(({ x, z, r }) => {
      const g = new THREE.PlaneGeometry(r * 2, r * 2)
      g.rotateX(-Math.PI / 2)
      g.translate(x, 0.02, z)
      return g
    })
    const geo = mergeGeometries(quads, false)
    quads.forEach((g) => g.dispose())
    const mat = curved(new THREE.MeshBasicMaterial({
      map: lightPoolTexture(),
      color: new THREE.Color(style.furniture.glow).multiplyScalar(0.3 + style.night * 0.5),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }))
    const pools = new THREE.Mesh(geo, mat)
    pools.renderOrder = -1
    group.add(pools)
  }
  return {
    group,
    obstacles,
    dispose() {
      group.traverse((o) => {
        if (!o.isMesh) return
        o.geometry.dispose()
        o.material.dispose()
      })
    },
  }
}
