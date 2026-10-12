import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry } from './offices.js'
import { withCurve } from '../core/curve.js'

/**
 * Workstations — one per thread, the desk its bot works at.
 *
 * Every desk is seeded from the thread's own id, so a session always gets the same setup:
 * a standing desk with one, two or three monitors, a laptop rig, a server tower or a little
 * whiteboard beside it. The whole station is one merged, vertex-coloured geometry and one
 * draw call, like the buildings it replaced, and keeps their contract — `footprint`,
 * `height`, `setProgress` and a `uProgress` uniform — so construction, drone deliveries and
 * navigation treat it the same way.
 *
 * The screens are the point. They are drawn in the shader as scrolling lines of "code" in the
 * bot's status colour: green and busy while the thread runs, a slow blue while it waits on
 * you, a stalled red when it hit an error, gold when its work shipped, and a dim screensaver
 * while it idles. `setStatus` is one uniform write.
 *
 * Authored facing +Z: the bot stands at `stand` in front of the desk, looking at the screens.
 */

/** Shared by every desk, so the office's clock and lighting are one uniform write each. */
export const workstationUniforms = {
  uNight: { value: 0 },
  uTime: { value: 0 },
}

/** Per-vertex role: plain surface, a screen, or an accent light (LED strips, rack lights). */
const PLAIN = 0
const SCREEN = 1
const GLOW = 2

const DESK_TOP = 0.92
const DESK_W = 1.6
const DESK_D = 0.72

/** How far in front of the desk's centre its bot stands while it works. */
export const DESK_STAND = 1.02

const STATUS_SCREEN = {
  working: { color: [0.35, 1.0, 0.55], live: 1 },
  waiting: { color: [0.45, 0.7, 1.0], live: 0.18 },
  blocked: { color: [1.0, 0.35, 0.3], live: 0 },
  celebrating: { color: [1.0, 0.82, 0.35], live: 0.5 },
  idle: { color: [0.5, 0.75, 0.8], live: 0.06 },
  sleeping: { color: [0.25, 0.3, 0.45], live: 0 },
}

class Parts {
  constructor() {
    this.list = []
  }

  /** Add a geometry in one colour, with a role and (for screens) its own 0..1 UVs. */
  add(geo, color, role = PLAIN) {
    const g = geo.index ? geo.toNonIndexed() : geo
    if (g !== geo) geo.dispose()
    const n = g.attributes.position.count
    const c = new THREE.Color(color)
    const colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) c.toArray(colors, i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.setAttribute('aRole', new THREE.BufferAttribute(new Float32Array(n).fill(role), 1))
    const uv = g.attributes.uv ? g.attributes.uv.array : new Float32Array(n * 2)
    g.setAttribute('aScreenUv', new THREE.BufferAttribute(new Float32Array(uv), 2))
    g.deleteAttribute('uv')
    this.list.push(g)
    return g
  }

  box(w, h, d, color, x, y, z, { ry = 0, rx = 0, role = PLAIN } = {}) {
    const g = new THREE.BoxGeometry(w, h, d)
    g.rotateX(rx)
    g.rotateY(ry)
    g.translate(x, y, z)
    return this.add(g, color, role)
  }

  cyl(rTop, rBottom, h, color, x, y, z, segments = 12) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, segments)
    g.translate(x, y, z)
    return this.add(g, color)
  }

  /** A monitor on a stand, its screen facing +Z (rotated by `ry` about its own foot). */
  monitor(x, z, { w = 0.62, h = 0.38, ry = 0, frame = 0x22262e, stand = 0x8b929c } = {}) {
    const foot = new THREE.Vector3(x, DESK_TOP, z)
    const parts = []
    const g = (geo, color, role) => { parts.push([geo, color, role]) }
    g(new THREE.BoxGeometry(0.22, 0.02, 0.16), stand)
    parts.at(-1)[0].translate(0, 0.01, 0)
    g(new THREE.BoxGeometry(0.05, 0.22, 0.04), stand)
    parts.at(-1)[0].translate(0, 0.12, -0.02)
    g(new THREE.BoxGeometry(w + 0.04, h + 0.04, 0.035), frame)
    parts.at(-1)[0].translate(0, 0.24 + h / 2, 0)
    const screen = new THREE.PlaneGeometry(w, h)
    screen.translate(0, 0.24 + h / 2, 0.019)
    g(screen, 0x000000, SCREEN)
    for (const [geo, color, role] of parts) {
      geo.rotateY(ry)
      geo.translate(foot.x, foot.y, foot.z)
      this.add(geo, color, role)
    }
  }

  finish() {
    const geo = mergeGeometries(this.list, false)
    for (const g of this.list) g.dispose()
    geo.computeVertexNormals()
    geo.computeBoundingBox()
    return geo
  }
}

/** The desk itself: top, frame legs in the room's colour, a cable tray and a keyboard. */
function desk(p, rand, accent, { width = DESK_W } = {}) {
  const top = rand() < 0.5 ? 0xe9e4da : 0xd2b48c // white laminate or light oak
  p.box(width, 0.05, DESK_D, top, 0, DESK_TOP - 0.025, 0)
  for (const sx of [-1, 1]) {
    p.box(0.07, DESK_TOP - 0.05, 0.07, accent, sx * (width / 2 - 0.12), (DESK_TOP - 0.05) / 2, 0)
    p.box(0.08, 0.03, DESK_D - 0.08, accent, sx * (width / 2 - 0.12), 0.015, 0)
  }
  p.box(width - 0.3, 0.06, 0.12, 0x5b616b, 0, DESK_TOP - 0.12, -DESK_D / 2 + 0.1)
  p.box(0.48, 0.025, 0.15, 0x2e333b, -0.05, DESK_TOP + 0.012, DESK_D / 2 - 0.16)
  p.box(0.08, 0.02, 0.11, 0x2e333b, 0.32, DESK_TOP + 0.01, DESK_D / 2 - 0.16)
}

function mug(p, x, z, color) {
  p.cyl(0.045, 0.04, 0.1, color, x, DESK_TOP + 0.05, z, 10)
}

function plant(p, x, z, rand) {
  p.cyl(0.07, 0.055, 0.12, 0xf3efe6, x, DESK_TOP + 0.06, z, 10)
  for (let i = 0; i < 4; i++) {
    const g = new THREE.SphereGeometry(0.06 + rand() * 0.02, 7, 5)
    g.scale(0.7, 1.6, 0.7)
    g.rotateZ((rand() - 0.5) * 0.9)
    g.translate(x + (rand() - 0.5) * 0.06, DESK_TOP + 0.2 + rand() * 0.05, z + (rand() - 0.5) * 0.06)
    p.add(g, i % 2 ? 0x5f9a62 : 0x3f7048)
  }
}

/** The recipes. Each draws onto a desk and returns a short name for the card. */
const KINDS = {
  single(p, rand, accent) {
    desk(p, rand, accent)
    p.monitor(0, -0.18, { w: 0.82, h: 0.44 })
    mug(p, 0.62, 0.12, rand() < 0.5 ? 0xd8553c : 0xf2efe8)
    return 'Focus desk'
  },
  dual(p, rand, accent) {
    desk(p, rand, accent)
    p.monitor(-0.34, -0.16, { ry: 0.22 })
    p.monitor(0.34, -0.16, { ry: -0.22 })
    // A desk lamp, angled over the keyboard.
    p.cyl(0.07, 0.08, 0.02, 0x2e333b, 0.66, DESK_TOP + 0.01, 0.12)
    p.box(0.025, 0.42, 0.025, 0x2e333b, 0.66, DESK_TOP + 0.21, 0.12, { rx: -0.25 })
    p.box(0.16, 0.05, 0.1, accent, 0.66, DESK_TOP + 0.42, 0.2, { role: GLOW })
    return 'Dual screen'
  },
  trading(p, rand, accent) {
    desk(p, rand, accent, { width: 1.8 })
    p.monitor(-0.6, -0.08, { ry: 0.5, w: 0.56 })
    p.monitor(0, -0.2, { w: 0.6 })
    p.monitor(0.6, -0.08, { ry: -0.5, w: 0.56 })
    // An LED strip under the front edge, in the room's colour.
    p.box(1.7, 0.02, 0.02, accent, 0, DESK_TOP - 0.06, DESK_D / 2 - 0.01, { role: GLOW })
    return 'Triple screen'
  },
  laptop(p, rand, accent) {
    desk(p, rand, accent)
    // A laptop on a riser, lid open, plus one external screen.
    p.box(0.36, 0.08, 0.26, 0xb7bcc4, -0.38, DESK_TOP + 0.04, -0.05, { rx: -0.12 })
    p.box(0.36, 0.015, 0.25, 0xc9ced5, -0.38, DESK_TOP + 0.095, -0.05, { rx: -0.12 })
    const lid = new THREE.PlaneGeometry(0.34, 0.22)
    lid.rotateX(-0.2)
    lid.translate(-0.38, DESK_TOP + 0.22, -0.17)
    p.add(lid, 0x000000, SCREEN)
    p.box(0.37, 0.24, 0.012, 0xb7bcc4, -0.38, DESK_TOP + 0.22, -0.177, { rx: -0.2 })
    p.monitor(0.3, -0.18, { w: 0.6 })
    plant(p, 0.7, 0.1, rand)
    return 'Laptop rig'
  },
  rack(p, rand, accent) {
    desk(p, rand, accent)
    p.monitor(-0.1, -0.18, { w: 0.74, h: 0.42 })
    // A server tower beside the desk, its status lights in the room's colour.
    const x = DESK_W / 2 + 0.3
    p.box(0.44, 1.25, 0.56, 0x2a2f37, x, 0.625, -0.05)
    for (let i = 0; i < 6; i++) {
      p.box(0.36, 0.03, 0.01, 0x3d434d, x, 0.2 + i * 0.17, 0.235)
      p.box(0.05, 0.025, 0.012, accent, x + 0.12, 0.2 + i * 0.17, 0.24, { role: GLOW })
    }
    return 'Build server'
  },
  board(p, rand, accent) {
    desk(p, rand, accent)
    p.monitor(0.25, -0.18, { w: 0.66 })
    mug(p, -0.62, 0.15, 0x4f7ec9)
    // A small whiteboard on legs behind the desk, with a few coloured scribbles.
    const z = -DESK_D / 2 - 0.25
    for (const sx of [-1, 1]) p.box(0.04, 1.75, 0.04, 0x9aa1ab, sx * 0.62, 0.875, z)
    p.box(1.3, 0.75, 0.03, 0xfbfbf8, 0, 1.4, z)
    const ink = [0x2f6fd0, 0xd8553c, 0x3f9a5a, 0x2e333b]
    for (let i = 0; i < 5; i++) {
      p.box(0.25 + rand() * 0.6, 0.025, 0.005, ink[i % ink.length], -0.15 + (rand() - 0.5) * 0.3, 1.62 - i * 0.11, z + 0.018)
    }
    return 'Planning desk'
  },
}
const KIND_IDS = Object.keys(KINDS)

function decorate(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    withCurve(shader)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aRole;
        attribute vec2 aScreenUv;
        varying float vRole;
        varying vec2 vScreenUv;
        varying float vLocalY;
        uniform float uProgress;
        uniform float uMaxY;
        uniform float uMinY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRole = aRole;
        vScreenUv = aScreenUv;
        vLocalY = transformed.y;
        transformed.y -= ( 1.0 - uProgress ) * ( uMaxY - uMinY );`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vRole;
        varying vec2 vScreenUv;
        varying float vLocalY;
        uniform float uProgress;
        uniform float uMaxY;
        uniform float uMinY;
        uniform float uTime;
        uniform float uNight;
        uniform float uLive;
        uniform float uSeed;
        uniform vec3 uStatus;
        uniform vec3 uAccent;
        float deskHash( float n ) { return fract( sin( n * 12.9898 + uSeed ) * 43758.5453 ); }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if ( vLocalY < uMinY + ( 1.0 - uProgress ) * ( uMaxY - uMinY ) - 0.001 ) discard;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if ( vRole > 0.5 && vRole < 1.5 ) {
          // A screen: rows of "code" scrolling up at the thread's own pace.
          float rows = 9.0;
          float scroll = uTime * uLive * 1.6;
          float row = floor( vScreenUv.y * rows + scroll );
          float fy = fract( vScreenUv.y * rows + scroll );
          float indent = 0.06 + 0.07 * floor( deskHash( row * 1.7 ) * 3.0 );
          float len = 0.18 + 0.62 * deskHash( row );
          float text = step( indent, vScreenUv.x ) * step( vScreenUv.x, indent + len ) * step( 0.32, fy ) * step( fy, 0.72 );
          // The cursor line blinks at the bottom while a thread is running.
          float cursor = step( vScreenUv.y, 0.12 ) * step( 0.06, vScreenUv.x ) * step( vScreenUv.x, 0.1 ) * step( 0.5, fract( uTime * 1.6 ) ) * step( 0.5, uLive );
          vec3 back = uStatus * 0.07 + vec3( 0.015, 0.02, 0.03 );
          diffuseColor.rgb = vec3( 0.0 );
          totalEmissiveRadiance += back + uStatus * ( text * ( 0.75 + 0.5 * uLive ) + cursor );
        } else if ( vRole > 1.5 ) {
          totalEmissiveRadiance += uAccent * ( 0.45 + uNight * 1.6 );
        }
        // The assembly line: a bright band riding just above the floor it rises from.
        float ground = uMinY + ( 1.0 - uProgress ) * ( uMaxY - uMinY );
        float band = 1.0 - smoothstep( 0.0, 0.15, vLocalY - ground );
        totalEmissiveRadiance += uAccent * band * ( 1.0 - step( 0.999, uProgress ) ) * 1.2;`)
  }
  material.customProgramCacheKey = () => 'agent-atrium-workstation'
  return material
}

function depthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    withCurve(shader)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vLocalY;
        uniform float uProgress;
        uniform float uMaxY;
        uniform float uMinY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocalY = transformed.y;
        transformed.y -= ( 1.0 - uProgress ) * ( uMaxY - uMinY );`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vLocalY;
        uniform float uProgress;
        uniform float uMaxY;
        uniform float uMinY;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if ( vLocalY < uMinY + ( 1.0 - uProgress ) * ( uMaxY - uMinY ) - 0.001 ) discard;`)
  }
  mat.customProgramCacheKey = () => 'agent-atrium-workstation-depth'
  return mat
}

/**
 * Build one workstation. `seed` comes from the thread id, so a session always gets the same
 * desk; `kind` can be forced, otherwise the seed picks it.
 */
export function createWorkstation({ seed = 1, accent = 0xc96442, kind = null } = {}) {
  const rand = mulberry(seed)
  const chosen = kind && KINDS[kind] ? kind : KIND_IDS[Math.floor(rand() * KIND_IDS.length)]
  const p = new Parts()
  const label = KINDS[chosen](p, rand, accent)
  const geo = p.finish()
  const box = geo.boundingBox
  const height = box.max.y
  let footprint = 0
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) footprint = Math.max(footprint, Math.hypot(pos.getX(i), pos.getZ(i)))

  const uniforms = {
    uProgress: { value: 1 },
    uMaxY: { value: height },
    uMinY: { value: box.min.y },
    uAccent: { value: new THREE.Color(accent) },
    uStatus: { value: new THREE.Vector3(...STATUS_SCREEN.idle.color) },
    uLive: { value: STATUS_SCREEN.idle.live },
    uSeed: { value: (seed % 1000) / 7.3 },
    uNight: workstationUniforms.uNight,
    uTime: workstationUniforms.uTime,
  }
  const material = decorate(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 }), uniforms)
  const mesh = new THREE.Mesh(geo, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.customDepthMaterial = depthMaterial(uniforms)

  mesh.userData.kind = chosen
  mesh.userData.label = label
  mesh.userData.height = height
  mesh.userData.footprint = footprint
  mesh.userData.uniforms = uniforms
  mesh.userData.progress = 1
  // Where its bot stands, and the circle it actually blocks: the desk and anything beside it,
  // pulled back so the spot in front stays free to stand in.
  mesh.userData.stand = DESK_STAND
  mesh.userData.obstacle = { back: 0.15, r: Math.min(footprint, 1.05) * 0.75 }
  mesh.userData.setProgress = (v) => {
    const t = THREE.MathUtils.clamp(v, 0, 1)
    mesh.userData.progress = t
    uniforms.uProgress.value = t
    mesh.visible = t > 0.02
  }
  mesh.userData.setStatus = (status) => {
    const look = STATUS_SCREEN[status] || STATUS_SCREEN.idle
    uniforms.uStatus.value.set(...look.color)
    uniforms.uLive.value = look.live
  }
  return mesh
}

export const WORKSTATION_KINDS = KIND_IDS
