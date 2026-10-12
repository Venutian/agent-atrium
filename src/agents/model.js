import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/**
 * The Atrium bot's head: a soft-cornered monitor with an LED face behind a glass front,
 * an ear pod on each side ringed with status light, and a halo floating above it in the
 * status colour, so what a bot is doing reads straight down from the bird's-eye view.
 *
 * Everything is measured off `R`, the rig's head radius, and every part stays one instanced
 * mesh: a hundred bots are still a handful of draws.
 */

/** Head proportions, in units of R. */
export const HEAD = {
  width: 2.0,
  height: 1.62,
  depth: 1.72,
  corner: 0.38,
}
/** The LED screen, in units of R, centred on the front face. */
export const SCREEN = { width: 1.5, height: 1.1, corner: 0.22 }
/** How far in front of the face the glass sits, in units of R. */
const GLASS_GAP = 0.05

/** The shell before the suit tint multiplies in: near white, so the tint reads true. */
const SHELL = 0xf4f5f7
const BEZEL = 0x23262d
const POD = 0x30353f

function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo
  if (g !== geo) geo.dispose()
  const c = new THREE.Color(hex)
  const colors = new Float32Array(g.attributes.position.count * 3)
  for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i)
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

function merge(parts) {
  for (const g of parts) g.deleteAttribute('uv')
  const combined = mergeGeometries(parts, false)
  const merged = mergeVertices(combined, 1e-5)
  combined.dispose()
  for (const g of parts) g.dispose()
  return merged
}

/** A rounded rectangle as a Shape, centred on the origin. */
function roundedRect(w, h, r) {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

/** The shell, the bezel round the screen, and the two ear pods — one vertex-coloured mesh. */
export function headGeometry(R) {
  const w = HEAD.width * R
  const h = HEAD.height * R
  const d = HEAD.depth * R
  const parts = [colored(new RoundedBoxGeometry(w, h, d, 5, HEAD.corner * R), SHELL)]

  // The bezel: a frame proud of the face, the screen's own outline cut out of it.
  const sw = SCREEN.width * R
  const sh = SCREEN.height * R
  const frame = roundedRect(sw + 0.16 * R, sh + 0.16 * R, (SCREEN.corner + 0.08) * R)
  frame.holes.push(roundedRect(sw, sh, SCREEN.corner * R))
  const bezel = new THREE.ExtrudeGeometry(frame, { depth: 0.05 * R, bevelEnabled: false, curveSegments: 6 })
  bezel.translate(0, 0, d / 2 - 0.02 * R)
  parts.push(colored(bezel, BEZEL))

  // A dark backing behind the screen, so the glass never shows the shell through the LEDs.
  const back = new THREE.ShapeGeometry(roundedRect(sw, sh, SCREEN.corner * R), 6)
  back.translate(0, 0, d / 2 - 0.004 * R)
  parts.push(colored(back, BEZEL))

  for (const side of [-1, 1]) {
    const pod = new THREE.CylinderGeometry(0.3 * R, 0.3 * R, 0.16 * R, 24)
    pod.rotateZ(Math.PI / 2)
    pod.translate(side * (w / 2 + 0.06 * R), -0.05 * R, -0.06 * R)
    parts.push(colored(pod, POD))
  }
  return merge(parts)
}

/** The LED screen: a flat rounded rectangle with 0..1 UVs across it. */
export function screenGeometry(R) {
  const sw = SCREEN.width * R
  const sh = SCREEN.height * R
  const geo = new THREE.ShapeGeometry(roundedRect(sw, sh, SCREEN.corner * R), 8)
  const pos = geo.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / sw + 0.5
    uv[i * 2 + 1] = pos.getY(i) / sh + 0.5
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.translate(0, 0, (HEAD.depth / 2) * R)
  return geo
}

/**
 * The glass front, just proud of the screen. Flat on purpose: a shape triangulated as a fan
 * has no interior vertices to carry a curve, and bending it anyway breaks the reflection
 * into hard triangles.
 */
export function glassGeometry(R) {
  const sw = (SCREEN.width + 0.06) * R
  const sh = (SCREEN.height + 0.06) * R
  const geo = new THREE.ShapeGeometry(roundedRect(sw, sh, (SCREEN.corner + 0.03) * R), 10)
  geo.translate(0, 0, (HEAD.depth / 2 + GLASS_GAP) * R)
  return geo
}

/** The status halo: a flat ring floating over the head, the first thing seen from above. */
export function haloGeometry(R) {
  const geo = new THREE.TorusGeometry(0.46 * R, 0.05 * R, 8, 40)
  geo.rotateX(Math.PI / 2)
  geo.translate(0, (HEAD.height / 2 + 0.42) * R, 0)
  return geo
}

/** The light ring round each ear pod, in the same status colour as the halo. */
export function earLightGeometry(R) {
  const parts = []
  for (const side of [-1, 1]) {
    const ring = new THREE.TorusGeometry(0.2 * R, 0.04 * R, 6, 24)
    ring.rotateY(Math.PI / 2)
    ring.translate(side * ((HEAD.width / 2 + 0.15) * R), -0.05 * R, -0.06 * R)
    parts.push(ring)
  }
  const geo = mergeGeometries(parts, false)
  parts.forEach((g) => g.dispose())
  return geo
}
