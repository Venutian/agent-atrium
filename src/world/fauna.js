import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { withCurve } from '../core/curve.js'
import { mulberry } from './offices.js'
import { stepParcel } from './parcel-physics.js'

/**
 * The office's delivery drones, ferrying parcels from reception to whoever is building.
 *
 * None of it matters and all of it is what makes the place feel inhabited rather than
 * rendered — the secondary animation your eye catches at the edge of the frame.
 *
 * The fleet is **one `InstancedMesh`**, and the CPU only ever decides *where* a drone is.
 * Everything that moves *on* one moves in the vertex shader: a rotor spins and a crate is
 * hidden, all from a single `uTime` write a frame. A vertex carries what it is (`aSpin`,
 * `aCrate`…) and the point it turns about (`aPivot`), and an instance carries a phase so
 * no two drones beat in step. The per-frame path allocates nothing.
 */

// ── shared uniforms ───────────────────────────────────────────────────────────────────

/** Shared by the drone material and its shadow pass. One `uTime` write a frame turns every rotor. */
export const faunaUniforms = {
  uTime: { value: 0 },
  /** 1 normally, 0.5 under reduced motion. */
  uMotion: { value: 1 },
}

/** How the `fauna` setting scales the fleet. Off is off; the rest is how many. */
const TIER = { off: 0, low: 0.6, full: 1 }

/** Deck top — the lowest thing a drone should ever count as "the ground" over the atrium. */
const DECK = 0.45

// ── the shader ────────────────────────────────────────────────────────────────────────

/**
 * The drone shader. Per vertex: `aSpin` marks a rotor and `aPivot` is the hub it turns about
 * — or, for a crate, the point it collapses to when the drone is flying empty. `aAccent` picks
 * a fixed colour (arms, crate) over the instance colour, and `aEmissive` marks the LED.
 *
 * Per instance: `aPhase` de-syncs the strobe, `aCarry` shows or folds the crate, and `aRotor`
 * is the rotor angle, integrated on the CPU — an angle rather than a rate, because
 * `uTime * rate * throttle` would leap by hundreds of radians the moment the throttle changed,
 * and a drone spooling up would strobe.
 */
const VERT_PARS = /* glsl */ `
#include <common>
// bc:fauna-vert
// The per-vertex flags share one slot: a drone carries position, normal, its instance
// matrix (four slots), its colour and five of its own, and the WebGL limit on a Mac is
// sixteen — one attribute per float is the difference between a drone and a link error.
attribute vec3 aPart; // spin, emissive, crate
#define aSpin aPart.x
#define aEmissive aPart.y
#define aCrate aPart.z
attribute vec3 aPivot;
attribute float aAccent;
attribute float aPhase;
attribute float aCarry;
attribute float aRotor;
varying float vEmissive;
varying float vAccent;
varying float vPhase;
uniform float uTime;
uniform float uMotion;

vec3 bcSpinY( vec3 p, vec3 hub, float a ) {
  vec3 r = p - hub;
  float s = sin( a );
  float c = cos( a );
  return hub + vec3( r.x * c + r.z * s, r.y, -r.x * s + r.z * c );
}
`

const VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
if ( aSpin != 0.0 ) objectNormal = bcSpinY( objectNormal, vec3( 0.0 ), aRotor * aSpin );
`

const VERT_MOVE = /* glsl */ `
#include <begin_vertex>
vEmissive = aEmissive;
vAccent = aAccent;
vPhase = aPhase;
if ( aSpin != 0.0 ) transformed = bcSpinY( transformed, aPivot, aRotor * aSpin );
// An empty drone's crate and cable collapse to a point inside the hull rather than being
// culled — degenerate triangles cost nothing and keep the geometry one piece.
if ( aCrate > 0.5 ) transformed = mix( aPivot, transformed, aCarry );
`

const FRAG_PARS = /* glsl */ `
#include <common>
// bc:fauna-frag
varying float vEmissive;
varying float vAccent;
varying float vPhase;
uniform float uTime;
uniform vec3 uAccentA;
uniform vec3 uAccentB;
`

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
if ( vAccent > 1.5 ) diffuseColor.rgb = uAccentB;
else if ( vAccent > 0.5 ) diffuseColor.rgb = uAccentA;
`

const FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
// A short strobe rather than a pulse, like an aircraft's, and well above 1.0 so bloom
// picks it out. Phase-offset so a parked row does not blink as one.
float bcBlink = step( 0.82, fract( uTime * 0.9 + vPhase * 0.16 ) );
totalEmissiveRadiance += vec3( 2.5, 0.2, 0.16 ) * vEmissive * ( 0.12 + 0.88 * bcBlink );
`

/**
 * Install the drone shader on a material. Used for the surface material and, with the very
 * same uniform objects, for the shadow pass's depth material — a rotor that turns has to turn
 * in its shadow too, or the shadow lags the drone.
 */
function decorate(material, uniforms, key) {
  material.customProgramCacheKey = () => key
  material.onBeforeCompile = (shader) => {
    withCurve(shader)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_PARS)
      .replace('#include <beginnormal_vertex>', VERT_NORMAL)
      .replace('#include <begin_vertex>', VERT_MOVE)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
  }
  return material
}

/** The drone material and its shadow-pass partner. */
function crowdMaterials(o) {
  const uniforms = {
    uTime: faunaUniforms.uTime,
    uMotion: faunaUniforms.uMotion,
    uAccentA: { value: new THREE.Color(o.accentA ?? 0x000000) },
    uAccentB: { value: new THREE.Color(o.accentB ?? 0x000000) },
  }
  const key = `bc-${o.name}`
  const material = decorate(new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, side: o.side ?? THREE.FrontSide }), uniforms, key)
  const depth = o.shadow
    ? decorate(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), uniforms, `${key}:depth`)
    : null
  return { material, depth }
}

// ── geometry ──────────────────────────────────────────────────────────────────────────

const PART = ['aSpin', 'aEmissive', 'aCrate']

/**
 * Stamp a part with the per-vertex attributes the shader reads. Every part gets every
 * attribute, zero where it does not apply, because merging needs the sets to agree. The
 * four flags are packed into one vec4 — see the shader for why.
 */
function tag(geo, t = {}) {
  const n = geo.attributes.position.count
  const part = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) part[i * 3 + k] = t[PART[k]] || 0
  }
  geo.setAttribute('aPart', new THREE.BufferAttribute(part, 3))
  geo.setAttribute('aAccent', new THREE.BufferAttribute(new Float32Array(n).fill(t.aAccent || 0), 1))
  const pivot = new Float32Array(n * 3)
  if (t.pivot) {
    for (let i = 0; i < n; i++) {
      pivot[i * 3] = t.pivot[0]
      pivot[i * 3 + 1] = t.pivot[1]
      pivot[i * 3 + 2] = t.pivot[2]
    }
  }
  geo.setAttribute('aPivot', new THREE.BufferAttribute(pivot, 3))
  return geo
}

/**
 * Merging insists every part be indexed or none be, and the addons' rounded box is the
 * one primitive here that is not — so everything is flattened first. These meshes are a
 * few hundred vertices; the index was never buying anything.
 */
function merge(parts) {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p))
  const geo = BufferGeometryUtils.mergeGeometries(flat, false)
  for (const p of parts) p.dispose()
  for (const p of flat) if (!parts.includes(p)) p.dispose()
  return geo
}

/**
 * Uniform scale that takes `aPivot` along. `BufferGeometry.scale()` transforms position
 * and normal and nothing else — miss this and a rotor turns about a hub left behind at the
 * unscaled width.
 */
function scaleTagged(geo, s) {
  if (s === 1) return geo
  geo.scale(s, s, s)
  const pivot = geo.getAttribute('aPivot')
  for (let i = 0; i < pivot.array.length; i++) pivot.array[i] *= s
  pivot.needsUpdate = true
  return geo
}

const ROTOR_SPIN = [1, -1.04, 1.08, -0.96]

/**
 * A quadcopter about half a metre across: rounded hull, canopy, four arms with a hub, a
 * hexagonal disc and two blades each, skids, a front LED, and a crate on a cable
 * underneath. The crate and cable are `aCrate` so the shader can fold them away.
 */
function droneGeometry() {
  const parts = []
  const hull = new RoundedBoxGeometry(0.5, 0.2, 0.5, 3, 0.07)
  parts.push(tag(hull))
  const canopy = new THREE.SphereGeometry(0.12, 8, 6)
  canopy.scale(1, 0.6, 1)
  canopy.translate(0, 0.1, 0.02)
  parts.push(tag(canopy, { aAccent: 1 }))

  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1
    const sz = i & 2 ? 1 : -1
    const arm = new THREE.BoxGeometry(0.42, 0.035, 0.05)
    // A box along X turned to point along (sx, sz).
    arm.rotateY(Math.atan2(-sz, sx))
    arm.translate(sx * 0.24, 0.06, sz * 0.24)
    parts.push(tag(arm, { aAccent: 1 }))

    const hx = sx * 0.36
    const hz = sz * 0.36
    const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8)
    hub.translate(hx, 0.09, hz)
    parts.push(tag(hub, { aAccent: 1 }))
    const spin = ROTOR_SPIN[i]
    const disc = new THREE.CylinderGeometry(0.15, 0.15, 0.008, 6)
    disc.translate(hx, 0.115, hz)
    parts.push(tag(disc, { aSpin: spin, pivot: [hx, 0.115, hz], aAccent: 2 }))
    const bladeA = new THREE.BoxGeometry(0.3, 0.01, 0.045)
    bladeA.translate(hx, 0.125, hz)
    parts.push(tag(bladeA, { aSpin: spin, pivot: [hx, 0.125, hz], aAccent: 1 }))
    const bladeB = new THREE.BoxGeometry(0.045, 0.01, 0.3)
    bladeB.translate(hx, 0.125, hz)
    parts.push(tag(bladeB, { aSpin: spin, pivot: [hx, 0.125, hz], aAccent: 1 }))
  }

  for (const sx of [-1, 1]) {
    const skid = new THREE.BoxGeometry(0.03, 0.12, 0.34)
    skid.translate(sx * 0.16, -0.15, 0)
    parts.push(tag(skid, { aAccent: 1 }))
  }

  const led = new THREE.SphereGeometry(0.028, 6, 4)
  led.translate(0, 0.02, 0.27)
  parts.push(tag(led, { aEmissive: 1 }))

  // The collapse point is inside the hull, so a folded crate is out of sight.
  const fold = [0, -0.05, 0]
  const cable = new THREE.BoxGeometry(0.012, 0.36, 0.012)
  cable.translate(0, -0.28, 0)
  parts.push(tag(cable, { aCrate: 1, pivot: fold, aAccent: 1 }))
  const crate = new THREE.BoxGeometry(0.3, 0.3, 0.3)
  crate.translate(0, -0.61, 0)
  parts.push(tag(crate, { aCrate: 1, pivot: fold, aAccent: 2 }))

  return merge(parts)
}

// ── shared scratch ────────────────────────────────────────────────────────────────────

const _dummy = new THREE.Object3D()
const _target = new THREE.Vector3()
const _sep = { x: 0, z: 0 }
const _color = new THREE.Color()
const _zero = new THREE.Matrix4().makeScale(0, 0, 0)

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

/** Build the instanced mesh every crowd shares the shape of. */
function crowdMesh(geo, mats, count, name, shadow) {
  const mesh = new THREE.InstancedMesh(geo, mats.material, count)
  mesh.name = name
  // Bounds are computed from the geometry, not from where the instances have flown to, so
  // culling would clip a flock the moment it left the origin.
  mesh.frustumCulled = false
  mesh.castShadow = shadow
  mesh.receiveShadow = false
  if (mats.depth) mesh.customDepthMaterial = mats.depth
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  return mesh
}

function phaseAttribute(geo, count, rand) {
  const phase = new Float32Array(count)
  for (let i = 0; i < count; i++) phase[i] = rand() * Math.PI * 2
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1))
}

function paint(mesh, count, colors, rand, jitter = 0.06) {
  for (let i = 0; i < count; i++) {
    _color.set(colors[i % colors.length])
    _color.offsetHSL((rand() - 0.5) * 0.02, (rand() - 0.5) * jitter, (rand() - 0.5) * jitter)
    mesh.setColorAt(i, _color)
  }
  mesh.instanceColor.needsUpdate = true
}

// ── drones ────────────────────────────────────────────────────────────────────────────

const DRONE_COLORS = [0xf2efe8, 0xf0a05a, 0x6fc4d8]
const DRONE_SPEED = 5
const CRUISE_CLEARANCE = 6
/** Where a parked drone hovers: just high enough that the slung crate clears the apron. */
/** How many dropped crates can be lying about at once, and how long each stays. */
const PARCEL_CAP = 24
const PARCEL_LIFE = 7
const PARK_HEIGHT = 0.85
const PARK_RING = 4.2
/** Rotor speed in radians per second at full throttle; idle is a slow tick-over. */
const ROTOR_RATE = 42
const IDLE_THROTTLE = 0.3

/**
 * The atrium's cargo run. A drone waits on the pad beside reception, picks a site —
 * one that is being built if there is one — climbs to a cruise height that clears any
 * building, flies over, lowers its crate, lets go, and comes home.
 *
 * Cruise is `max(heightAt, deck) + 6`, sampled under the drone as it goes: the tallest
 * building is about 4.5, so the crate never clips a mast, and over open ground the drone
 * follows the terrain rather than flying a fixed plane.
 */
class Fleet {
  constructor(group, spec, env, seed, tier) {
    this.env = env
    this.rand = mulberry(seed)
    this.count = Math.max(0, Math.round(spec.count ?? 3))

    const geo = droneGeometry()
    phaseAttribute(geo, this.count, this.rand)
    this.carry = new THREE.InstancedBufferAttribute(new Float32Array(this.count).fill(1), 1)
    this.carry.setUsage(THREE.DynamicDrawUsage)
    this.rotor = new THREE.InstancedBufferAttribute(new Float32Array(this.count), 1)
    this.rotor.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aCarry', this.carry)
    geo.setAttribute('aRotor', this.rotor)

    this.mats = crowdMaterials({
      name: 'drone',
      accentA: 0x3a3d44,
      accentB: 0xc9a26a,
      side: THREE.FrontSide,
      shadow: true,
    })
    this.mesh = crowdMesh(geo, this.mats, this.count, 'drones', true)
    paint(this.mesh, this.count, DRONE_COLORS, this.rand, 0.04)
    group.add(this.mesh)

    // The crates once let go of. A drone's own crate is folded into its hull the moment it
    // is "delivered"; what actually lands on the deck is one of these — a small box with
    // its own fall, a couple of bounces, and a quiet fade once it has settled.
    this.parcels = []
    this.parcelMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xc9a26a, roughness: 0.8, metalness: 0.05 }),
      PARCEL_CAP
    )
    this.parcelMesh.count = 0
    this.parcelMesh.castShadow = true
    this.parcelMesh.frustumCulled = false
    this.parcelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    group.add(this.parcelMesh)

    this.pad = { x: 0, y: 0, z: 0 }
    this.door = { x: 0, y: 0, z: 0 }
    this.sites = []
    this.drones = []
    this.pool = []
    for (let i = 0; i < this.count; i++) {
      this.drones.push({
        state: 'parked',
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        homeX: 0, homeZ: 0,
        tx: 0, ty: 0, tz: 0,
        heading: 0, roll: 0, pitch: 0,
        throttle: IDLE_THROTTLE,
        angle: this.rand() * Math.PI * 2,
        timer: 6 + this.rand() * 19,
        carry: 1,
        dropped: false,
      })
      this.pool.push({ x: 0, y: 0, z: 0, busy: false })
    }
    this.info = []
    this._placed = false
    this.setTier(tier)
  }

  setTier(scale) {
    this.active = this.count ? Math.max(1, Math.round(this.count * scale)) : 0
    this.mesh.count = this.active
    this.info.length = 0
    for (let i = 0; i < this.active; i++) this.info.push(this.pool[i])
  }

  setSites(pad, door, sites) {
    this.pad.x = pad.x
    this.pad.y = pad.y
    this.pad.z = pad.z
    this.door.x = door.x
    this.door.y = door.y
    this.door.z = door.z
    this.sites = sites
    // The parking ring sits on the apron, and starts from the ramp side so the drones
    // cluster by the door rather than round the back.
    const start = Math.atan2(door.x - pad.x, door.z - pad.z)
    for (let i = 0; i < this.count; i++) {
      const d = this.drones[i]
      const a = start + ((i + 0.5) / this.count) * Math.PI * 2
      d.homeX = pad.x + Math.sin(a) * PARK_RING
      d.homeZ = pad.z + Math.cos(a) * PARK_RING
      // A drone on the ground goes where the ground now is — the pad only ever moves when
      // the reception does. One in the air simply comes home to the new spot.
      if (d.state === 'parked' || d.state === 'land') {
        d.x = d.homeX
        d.z = d.homeZ
        d.y = pad.y + PARK_HEIGHT
        d.heading = a + Math.PI
        d.state = 'parked'
      }
    }
    this._placed = true
  }

  /** Let the crate go from under the hull. It lands on whatever is below and stays a while. */
  _release(d) {
    if (this.parcels.length >= PARCEL_CAP) this.parcels.shift()
    this.parcels.push({
      x: d.x + (this.rand() - 0.5) * 0.2,
      y: d.y - 0.75,
      z: d.z + (this.rand() - 0.5) * 0.2,
      vx: (this.rand() - 0.5) * 0.4,
      vy: 0,
      vz: (this.rand() - 0.5) * 0.4,
      spin: (this.rand() - 0.5) * 6,
      yaw: this.rand() * Math.PI * 2,
      tilt: 0,
      bounces: 0,
      life: 0,
      landed: false,
    })
  }

  /**
   * Gravity, a bounce or two, a skid, then a fade. `hooks.sound` gets the thud on the first
   * landing, which is the moment the drop actually *happens* rather than the moment the
   * drone let go.
   */
  _updateParcels(dt, hooks) {
    const list = this.parcels
    let n = 0
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]
      p.life += dt
      const surfaceAt = this.env.parcelSurfaceAt || ((x, z) => ({ height: this.env.heightAt(x, z) }))
      if (stepParcel(p, dt, surfaceAt)) hooks?.sound?.('drone-drop', p.x, p.y, p.z)
      // Gone after a while: shrinks away rather than blinking out.
      const fade = THREE.MathUtils.clamp((PARCEL_LIFE - p.life) / 1.2, 0, 1)
      if (fade <= 0) {
        list.splice(i, 1)
        continue
      }
      _dummy.position.set(p.x, p.y, p.z)
      _dummy.rotation.set(p.tilt, p.yaw, 0)
      _dummy.scale.setScalar(fade)
      _dummy.updateMatrix()
      this.parcelMesh.setMatrixAt(n++, _dummy.matrix)
    }
    this.parcelMesh.count = n
    this.parcelMesh.instanceMatrix.needsUpdate = true
  }

  _cruiseY(x, z) {
    return Math.max(this.env.heightAt(x, z), DECK) + CRUISE_CLEARANCE
  }

  /**
   * A building under construction first; failing that, anyone; failing that, nobody. A site
   * another drone is already flying to is passed over while there is any other choice, so
   * the fleet spreads across the atrium instead of stacking up over one roof.
   */
  _pickSite(self) {
    const sites = this.sites
    if (!sites.length) return null
    const taken = (site) => {
      for (let i = 0; i < this.active; i++) {
        const o = this.drones[i]
        if (o !== self && o.state !== 'parked' && o.state !== 'land' && o.site === site) return true
      }
      return false
    }
    const pick = (list) => (list.length ? list[Math.floor(this.rand() * list.length)] : null)
    const actives = sites.filter((s) => s.active)
    return pick(actives.filter((s) => !taken(s))) || pick(sites.filter((s) => !taken(s))) || pick(actives) || pick(sites)
  }

  /**
   * Where over the site a drone parks to drop: somewhere on the roof, not the one exact
   * centre every drone would otherwise share.
   */
  _dropSpot(d, site) {
    const a = this.rand() * Math.PI * 2
    const r = 0.4 + this.rand() * Math.max(0.4, (site.radius || 1.4) * 0.55)
    d.site = site
    d.tx = site.x + Math.cos(a) * r
    d.ty = site.y
    d.tz = site.z + Math.sin(a) * r
  }

  /** A shove away from any other airborne drone too close: no two hover in the same air. */
  _separate(d, out) {
    out.x = 0
    out.z = 0
    for (let i = 0; i < this.active; i++) {
      const o = this.drones[i]
      if (o === d || o.state === 'parked') continue
      const dx = d.x - o.x
      const dz = d.z - o.z
      const d2 = dx * dx + dz * dz
      if (d2 > 6.25 || d2 < 1e-4) continue
      const dist = Math.sqrt(d2)
      const k = (1 - dist / 2.5) * 2.2
      out.x += (dx / dist) * k
      out.z += (dz / dist) * k
    }
    return out
  }

  update(dt, elapsed, hooks, motion) {
    const n = this.active
    if (!n || !this._placed) return
    const speed = DRONE_SPEED * motion

    for (let i = 0; i < n; i++) {
      const d = this.drones[i]
      let wantY = d.y
      let wantThrottle = 1
      let wantVX = 0
      let wantVZ = 0

      switch (d.state) {
        case 'parked': {
          wantY = this.pad.y + PARK_HEIGHT
          wantThrottle = IDLE_THROTTLE
          d.timer -= dt
          if (d.timer <= 0) {
            const site = this._pickSite(d)
            if (site) {
              this._dropSpot(d, site)
              d.carry = 1
              d.dropped = false
              d.state = 'takeoff'
            } else d.timer = 4 + this.rand() * 6
          }
          break
        }
        case 'takeoff': {
          wantY = this._cruiseY(d.x, d.z)
          if (d.y > wantY - 0.3) d.state = 'cruise'
          break
        }
        case 'cruise':
        case 'return': {
          const gx = d.state === 'cruise' ? d.tx : d.homeX
          const gz = d.state === 'cruise' ? d.tz : d.homeZ
          const dx = gx - d.x
          const dz = gz - d.z
          const dist = Math.hypot(dx, dz)
          wantY = this._cruiseY(d.x, d.z)
          if (dist < 0.4) {
            if (d.state === 'cruise') {
              d.state = 'hover'
              d.timer = 3 + this.rand() * 3
              d.hoverT = d.timer
            } else d.state = 'land'
          } else {
            // Slow into the last few metres so arrival is a settle, not a stop.
            const v = Math.min(speed, 1 + dist * 1.6)
            wantVX = (dx / dist) * v
            wantVZ = (dz / dist) * v
          }
          const sep = this._separate(d, _sep)
          wantVX += sep.x
          wantVZ += sep.z
          break
        }
        case 'hover': {
          d.timer -= dt
          // Sink a little over the site and bob while the crate goes down. Each drone hangs
          // at its own height, and holds its distance from the others, so a busy roof reads
          // as a queue rather than one drone drawn several times.
          const t = 1 - d.timer / d.hoverT
          wantY = this._cruiseY(d.x, d.z) - 1 - Math.sin(t * Math.PI) * 0.6 + (i % 3) * 0.45
          const sep = this._separate(d, _sep)
          wantVX = sep.x
          wantVZ = sep.z
          if (!d.dropped && t > 0.55) {
            d.dropped = true
            d.carry = 0
            this._release(d)
          }
          if (d.timer <= 0) d.state = 'return'
          break
        }
        case 'land': {
          wantY = this.pad.y + PARK_HEIGHT
          if (d.y < wantY + 0.1) {
            d.state = 'parked'
            d.timer = 6 + this.rand() * 19
            d.carry = 1
          }
          break
        }
      }

      // Horizontal: ease toward the wanted velocity. Vertical: a climb or descent capped at
      // a couple of metres a second, so take-off and landing read as such.
      const ax = (wantVX - d.vx) * Math.min(1, 2.5 * dt)
      const az = (wantVZ - d.vz) * Math.min(1, 2.5 * dt)
      d.vx += ax
      d.vz += az
      const climb = d.state === 'takeoff' ? 2.6 : d.state === 'land' ? 1.6 : 2.2
      const dy = THREE.MathUtils.clamp((wantY - d.y) * 2, -climb * motion, climb * motion)
      d.vy += (dy - d.vy) * Math.min(1, 4 * dt)
      d.x += d.vx * dt
      d.y += d.vy * dt
      d.z += d.vz * dt

      // Lean: a quad tips into the direction it is pushing and into the direction it is
      // going, which is what makes it read as flying rather than sliding.
      const s2 = d.vx * d.vx + d.vz * d.vz
      if (s2 > 0.04) d.heading += wrapAngle(Math.atan2(d.vx, d.vz) - d.heading) * Math.min(1, 3 * dt)
      const fx = Math.sin(d.heading)
      const fz = Math.cos(d.heading)
      const forwardV = d.vx * fx + d.vz * fz
      const forwardA = dt > 0 ? (ax * fx + az * fz) / dt : 0
      const sideV = d.vx * fz - d.vz * fx
      const sideA = dt > 0 ? (ax * fz - az * fx) / dt : 0
      const pitch = THREE.MathUtils.clamp(forwardV * 0.045 + forwardA * 0.03, -0.35, 0.35)
      const roll = THREE.MathUtils.clamp(sideV * 0.045 + sideA * 0.03, -0.35, 0.35)
      d.pitch += (pitch - d.pitch) * Math.min(1, 4 * dt)
      d.roll += (roll - d.roll) * Math.min(1, 4 * dt)

      d.throttle += (wantThrottle - d.throttle) * Math.min(1, 1.5 * dt)
      d.angle += ROTOR_RATE * d.throttle * motion * dt
      if (d.angle > 1e4) d.angle -= 1e4
      this.rotor.array[i] = d.angle
      this.carry.array[i] = d.carry

      _dummy.position.set(d.x, d.y, d.z)
      _dummy.rotation.set(0, d.heading, 0)
      _dummy.rotateX(d.pitch)
      _dummy.rotateZ(d.roll)
      _dummy.scale.set(1, 1, 1)
      _dummy.updateMatrix()
      this.mesh.setMatrixAt(i, _dummy.matrix)

      const o = this.pool[i]
      o.x = d.x
      o.y = d.y
      o.z = d.z
      o.busy = d.state !== 'parked'
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.rotor.needsUpdate = true
    this.carry.needsUpdate = true
    this._updateParcels(dt, hooks)
  }

  dispose() {
    this.parcelMesh.removeFromParent()
    this.parcelMesh.geometry.dispose()
    this.parcelMesh.material.dispose()
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mats.material.dispose()
    this.mats.depth?.dispose()
  }
}

// ── the layer ─────────────────────────────────────────────────────────────────────────

const EMPTY = []

/**
 * Owns the fleet, and is the only thing the rest of the office talks to. `start` takes the
 * recipe — `{ drones: { count = 3 } }`, a missing key meaning none — and where the floor is.
 */
export class Fauna {
  constructor(scene, settings) {
    this.scene = scene
    this.settings = settings
    this.group = new THREE.Group()
    this.group.name = 'fauna'
    scene.add(this.group)

    this.env = null
    this.fleet = null

    this._sites = { pad: { x: 0, y: 0, z: 0 }, door: { x: 0, y: 0, z: 0 }, sites: [] }
    this._tier = TIER[settings.get('fauna')] ?? 1
    this.motion = settings.get('reducedMotion') ? 0.5 : 1
    faunaUniforms.uMotion.value = this.motion
  }

  start(recipe, env, seedName = 'office') {
    this._clear()
    this.env = env
    const fauna = recipe
    if (!fauna || !env) return
    const seed = hashString(seedName)
    if (fauna.drones && (fauna.drones.count ?? 3) > 0) {
      this.fleet = new Fleet(this.group, fauna.drones, env, seed ^ 0x4e40, this._tier)
      this.fleet.setSites(this._sites.pad, this._sites.door, this._sites.sites)
    }
  }

  /** Where the drones live and where they deliver. Call whenever the roster changes. */
  setSites({ door, pad, sites }) {
    const s = this._sites
    if (pad) {
      s.pad.x = pad.x
      s.pad.y = pad.y
      s.pad.z = pad.z
    }
    if (door) {
      s.door.x = door.x
      s.door.y = door.y
      s.door.z = door.z
    } else if (pad) {
      s.door.x = pad.x
      s.door.y = pad.y
      s.door.z = pad.z + 1
    }
    s.sites = sites || []
    this.fleet?.setSites(s.pad, s.door, s.sites)
  }

  update(dt, elapsed, camera, night, hooks) {
    // A tab that was hidden for a minute must not land every drone at once.
    dt = Math.min(dt, 0.1)
    faunaUniforms.uTime.value = elapsed
    const motion = this.motion
    this.fleet?.update(dt, elapsed, hooks, motion)
  }

  /** `{ x, y, z, busy }` per drone, reused frame to frame — for the rotor whine. */
  get drones() {
    return this.fleet ? this.fleet.info : EMPTY
  }


  onSettingsChanged(changed) {
    if (changed.has('fauna')) {
      this._tier = TIER[this.settings.get('fauna')] ?? 1
      this.fleet?.setTier(this._tier)
    }
    if (changed.has('reducedMotion')) {
      this.motion = this.settings.get('reducedMotion') ? 0.5 : 1
      faunaUniforms.uMotion.value = this.motion
    }
  }

  _clear() {
    this.fleet?.dispose()
    this.fleet = null
  }

  dispose() {
    this._clear()
    this.group.removeFromParent()
  }
}
