import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Merge opaque architectural details into one vertex-colored draw call.
function furniture() {
  const parts = []
  function add(geo, color, x, y, z, ry = 0) {
    geo.rotateY(ry)
    geo.translate(x, y, z)
    const c = new THREE.Color(color)
    const colors = new Float32Array(geo.attributes.position.count * 3)
    for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i)
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    parts.push(geo)
  }
  const box = (w, h, d, color, x, y, z) => add(new THREE.BoxGeometry(w, h, d), color, x, y, z)
  function plant(x, z, plants) {
    add(new THREE.CylinderGeometry(0.22, 0.17, 0.36, 12), plants.pot, x, 0.18, z)
    box(0.04, 0.5, 0.04, plants.leafDark, x, 0.57, z)
    for (let i = 0; i < 5; i++) {
      const a = i * 2.4
      const geo = new THREE.SphereGeometry(0.2, 8, 6)
      geo.scale(0.55, 1.7, 0.65)
      geo.rotateZ(0.5)
      add(geo, i % 2 ? plants.leaf : plants.leafDark, x + Math.cos(a) * 0.12, 0.62 + i * 0.05, z + Math.sin(a) * 0.12, a)
    }
  }
  function finish() {
    const geo = mergeGeometries(parts)
    parts.forEach((p) => p.dispose())
    geo.computeBoundingBox()
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.02 }))
    mesh.castShadow = mesh.receiveShadow = true
    return mesh
  }
  return { add, box, plant, finish }
}

/** Open-top architectural glass: every exterior edge has a wide walk-through portal.
 * Front panes are cut down so small bots remain visible in the isometric view. */
export function createGlassRooms(edges, accent, base, style) {
  const { frame: colors, glass: tint } = style
  const group = new THREE.Group()
  group.name = 'glass-rooms'
  const frame = furniture()
  const glassParts = []
  const obstacles = []
  for (const { x, z, angle, length } of edges) {
    const front = Math.cos(angle) + Math.sin(angle) > 0.25
    const height = front ? 1.35 : 3.25
    const door = 4.2
    const wing = (length - door) / 2
    const point = (along, y) => [x - Math.sin(angle) * along, y, z + Math.cos(angle) * along]
    const bar = (w, h, d, color, along, y) => frame.add(new THREE.BoxGeometry(w, h, d), color, ...point(along, y), -angle)
    for (const sign of [-1, 1]) {
      const center = sign * (door / 2 + wing / 2)
      const pane = new THREE.BoxGeometry(0.045, height - 0.22, wing - 0.12)
      pane.rotateY(-angle)
      pane.translate(...point(center, base + height / 2))
      glassParts.push(pane)
      bar(0.16, 0.13, wing, colors.base, center, base + 0.065)
      bar(0.12, 0.10, wing, colors.top, center, base + height)
      // A fine opaque rail makes even very transparent panes readable on white.
      bar(0.06, 0.04, wing, colors.rail, center, base + height * 0.58)
      for (const offset of [-wing / 2, wing / 2]) {
        bar(0.12, height, 0.12, colors.post, center + offset, base + height / 2)
      }
      for (let along = center - wing / 2; along <= center + wing / 2; along += 0.35) {
        const [ox, , oz] = point(along, base)
        obstacles.push({ x: ox, z: oz, r: 0.15 })
      }
    }
    // High portal header outlines the complete room without a roof covering its work.
    bar(0.15, 0.14, length, colors.header, 0, base + 3.4)
    for (const side of [-1, 1]) bar(0.12, 3.4, 0.12, colors.post, side * door / 2, base + 1.7)
    bar(0.18, 0.04, door - 0.5, accent, 0, base + 0.035)
  }
  group.add(frame.finish())
  if (glassParts.length) {
    const geometry = mergeGeometries(glassParts)
    glassParts.forEach(g => g.dispose())
    const glass = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: tint.color, transparent: true, opacity: tint.opacity, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }))
    glass.name = 'architectural-glass'
    group.add(glass)
  }
  group.userData.obstacles = obstacles
  return group
}

/** The plate and its brackets are actual room architecture; text is added by Plot. */
export function createSignMount(edge, width, base, style) {
  const f = furniture()
  const y = base + 3.9
  const nx = Math.cos(edge.angle), nz = Math.sin(edge.angle)
  for (const offset of [-width * 0.34, width * 0.34]) {
    const x = edge.x - nz * offset, z = edge.z + nx * offset
    f.add(new THREE.BoxGeometry(0.13, 0.7, 0.13), style.sign.bracket, x, y - 0.28, z)
  }
  const yaw = Math.PI / 2 - edge.angle
  f.add(new THREE.BoxGeometry(width + 0.18, 1.3, 0.18), style.sign.mount, edge.x, y + 0.15, edge.z, yaw)
  const mesh = f.finish()
  mesh.name = 'attached-repository-sign'
  mesh.userData.anchor = new THREE.Vector3(edge.x + nx * 0.105, y + 0.15, edge.z + nz * 0.105)
  mesh.userData.yaw = yaw
  return mesh
}

/** A pair of planters per room — two pairs in a garden — set against the side walls. */
export function createOfficePlanters(centers, radius, style) {
  const f = furniture()
  for (const spot of planterSpots(centers, radius, style)) f.plant(spot.x, spot.z, style.plants)
  return f.finish()
}

/**
 * Where the planters stand, room-local — shared with navigation so nobody walks through one.
 * Tucked into corners, past the desks that point at them and clear of every doorway.
 */
export function planterSpots(centers, radius, style) {
  const spots = []
  const corners = style.plants.extra ? [0, 3, 1, 4] : [0, 3]
  for (const { x, z } of centers) {
    for (const k of corners) {
      const a = (Math.PI / 3) * k
      spots.push({ x: x + Math.cos(a) * radius * 0.86, z: z + Math.sin(a) * radius * 0.86 })
    }
  }
  return spots
}

/** How far the coffee corner reaches from its middle: its island and the mugs on it. */
export const COFFEE_RADIUS = 0.8

/**
 * A room's coffee corner: a round island with an espresso machine, a stack of mugs and a
 * pendant lamp over it in the room's colour. Idle bots gather round it on their break.
 */
export function createCoffeeCorner(style, accent) {
  const f = furniture()
  const wood = style.furniture?.wood ?? 0xb98a5a
  f.add(new THREE.CylinderGeometry(0.62, 0.66, 0.86, 24), wood, 0, 0.43, 0)
  f.add(new THREE.CylinderGeometry(0.74, 0.74, 0.06, 28), 0xf2efe8, 0, 0.89, 0)
  // The machine: body, group head, drip tray, a lit panel in the room's colour.
  f.box(0.46, 0.44, 0.36, 0x2e333b, 0, 1.14, -0.12)
  f.box(0.5, 0.06, 0.4, 0x8b929c, 0, 1.39, -0.12)
  f.box(0.12, 0.08, 0.12, 0xb7bcc4, 0, 1.0, 0.1)
  f.box(0.3, 0.02, 0.18, 0x8b929c, 0, 0.93, 0.14)
  f.box(0.3, 0.07, 0.02, accent, 0, 1.28, 0.065)
  // Mugs round the rim, and a jar of beans.
  for (let i = 0; i < 5; i++) {
    const a = 0.9 + i * 0.75
    f.add(new THREE.CylinderGeometry(0.055, 0.048, 0.11, 12), i % 2 ? accent : 0xf2efe8, Math.cos(a) * 0.52, 0.975, Math.sin(a) * 0.52)
  }
  f.add(new THREE.CylinderGeometry(0.08, 0.08, 0.2, 12), 0x6b4a33, 0.32, 1.02, -0.3)
  // A pendant lamp over it, so a coffee corner reads from straight above.
  f.add(new THREE.CylinderGeometry(0.012, 0.012, 1.3, 6), 0x2e333b, 0, 2.55, 0)
  f.add(new THREE.ConeGeometry(0.34, 0.26, 20, 1, true), accent, 0, 1.82, 0)
  f.add(new THREE.SphereGeometry(0.1, 12, 8), 0xfff1cc, 0, 1.74, 0)
  const mesh = f.finish()
  mesh.material.side = THREE.DoubleSide
  mesh.name = 'coffee-corner'
  return mesh
}

/** Where new bots arrive: a stepped hexagonal courtyard with a living centrepiece. */
export function createOfficeReception(style) {
  const f = furniture()
  const { step, stepAlt } = style.reception
  for (let i = 0; i < 3; i++) f.add(new THREE.CylinderGeometry(2.7 - i * 0.45, 2.7 - i * 0.45, 0.15, 6), i % 2 ? stepAlt : step, 0, 0.075 + i * 0.15, 0)
  f.plant(-0.65, 0, style.plants)
  f.plant(0.65, 0, style.plants)
  const mesh = f.finish()
  mesh.name = 'office-reception'
  return mesh
}
