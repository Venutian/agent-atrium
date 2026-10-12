import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/**
 * The Atrium bot's body: chunky and round, like a toy — a barrel of a hard-shell torso with a
 * chest plate, a jointed waist, stubby capsule limbs on dark ball joints, gauntlet forearms,
 * big mitt hands and big boots.
 *
 * Every part is a rigid shell bound wholly to one bone, the way a real robot is built: the
 * joints are spheres, so a bend never stretches a panel, it rotates one shell past another.
 * The parts are laid out between the rig's own joint positions in its bind pose, which is
 * why any clip authored for that skeleton drives this body without being retargeted.
 *
 * Vertex colours carry the paint scheme. Shell parts are near-white so the per-agent suit
 * tint (instance colour) reads true; joints, hands and boots are dark enough to stay dark
 * under any tint.
 */

const SHELL = 0xf2f3f5
const PLATE = 0xd3d9e0
const JOINT = 0x2a2f37
const GEAR = 0x3b414b

/** The rig's joint names, as three's loader leaves them, matched loosely. */
const plain = (n) => n.replace(/[.\s_]/g, '').toLowerCase()

/**
 * @param {Map<string, THREE.Vector3>} joints  bind-pose position of each bone, by bone name
 * @param {Map<string, number>} boneIndex  skinning index of each bone, by bone name
 */
export function bodyGeometry(joints, boneIndex) {
  const at = new Map([...joints].map(([name, p]) => [plain(name), p]))
  const index = new Map([...boneIndex].map(([name, i]) => [plain(name), i]))
  const J = (name) => {
    const p = at.get(plain(name))
    if (!p) throw new Error(`body: the rig has no ${name} bone`)
    return p
  }
  const parts = []
  const add = (geo, bone, color) => {
    const b = index.get(plain(bone))
    if (b === undefined) throw new Error(`body: the rig has no ${bone} bone`)
    parts.push(rigid(geo, b, color))
  }

  const hips = J('hips'), spine = J('spine'), chest = J('chest'), head = J('head')

  // Pelvis and belt.
  add(new RoundedBoxGeometry(0.56, 0.24, 0.42, 4, 0.11).translate(0, (hips.y + spine.y) / 2, 0), 'hips', SHELL)
  add(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 20).scale(1.18, 1, 0.88).translate(0, spine.y - 0.03, 0), 'hips', JOINT)

  // The waist: a dark flexible core with one ridge, so the torso visibly sits on a joint.
  const waistY = spine.y + 0.08
  add(new THREE.CylinderGeometry(0.2, 0.22, 0.17, 18).translate(0, waistY, 0), 'spine', JOINT)
  add(new THREE.TorusGeometry(0.215, 0.026, 6, 20).rotateX(Math.PI / 2).translate(0, waistY, 0), 'spine', GEAR)

  // The torso: a tapered hard shell, broad at the shoulders, with a chest plate the status
  // lamp sits on and a neck collar for the monitor head.
  const torsoH = (head.y - 0.02) - (chest.y - 0.24)
  const torsoY = (head.y - 0.02 + chest.y - 0.24) / 2
  const torso = new RoundedBoxGeometry(0.72, torsoH, 0.54, 5, 0.21)
  taper(torso, torsoH, 0.86, 0.9)
  add(torso.translate(0, torsoY, -0.01), 'chest', SHELL)
  const plate = new RoundedBoxGeometry(0.4, 0.27, 0.06, 3, 0.06).translate(0, chest.y + 0.05, 0.24)
  add(plate, 'chest', PLATE)
  add(new THREE.CylinderGeometry(0.12, 0.14, 0.1, 16).translate(0, head.y + 0.02, 0), 'chest', JOINT)

  for (const s of ['l', 'r']) {
    const side = Math.sign(J(`upperarm.${s}`).x) || 1
    const shoulder = J(`upperarm.${s}`), elbow = J(`lowerarm.${s}`), wrist = J(`wrist.${s}`), hand = J(`hand.${s}`)

    // Shoulder: a dark ball under a rounded pauldron in the suit colour.
    add(sphere(0.105).translate(shoulder.x + side * 0.04, shoulder.y, shoulder.z), `upperarm.${s}`, JOINT)
    add(sphere(0.165, 0.6).scale(1.05, 0.92, 1).translate(shoulder.x + side * 0.08, shoulder.y + 0.03, shoulder.z), `upperarm.${s}`, SHELL)
    add(limb(shoulder, elbow, 0.095, 0.09, 0.14, 0.05), `upperarm.${s}`, SHELL)
    add(sphere(0.09).translate(elbow.x, elbow.y, elbow.z), `lowerarm.${s}`, JOINT)
    // The forearm flares into a gauntlet with a dark cuff ring at the wrist.
    add(limb(elbow, wrist, 0.088, 0.118, 0.05, 0.02), `lowerarm.${s}`, SHELL)
    add(ring(elbow, wrist, 0.12, 0.026, 0.93), `lowerarm.${s}`, JOINT)
    // A big round mitt with a thumb, which reads as a hand from any distance.
    add(new RoundedBoxGeometry(0.2, 0.15, 0.18, 3, 0.07).translate(hand.x + side * 0.04, hand.y, hand.z + 0.005), `hand.${s}`, GEAR)
    add(new RoundedBoxGeometry(0.08, 0.07, 0.07, 2, 0.03).translate(hand.x - side * 0.005, hand.y - 0.02, hand.z + 0.1), `hand.${s}`, GEAR)

    const hip = J(`upperleg.${s}`), knee = J(`lowerleg.${s}`), ankle = J(`foot.${s}`), toes = J(`toes.${s}`)
    add(sphere(0.11).translate(hip.x, hip.y - 0.03, hip.z), `upperleg.${s}`, JOINT)
    add(limb(hip, knee, 0.11, 0.1, 0.05, 0.04), `upperleg.${s}`, SHELL)
    add(sphere(0.095).translate(knee.x, knee.y, knee.z + 0.005), `lowerleg.${s}`, JOINT)
    // A knee guard on the front of the shin, then the shin itself widening into the boot.
    add(new RoundedBoxGeometry(0.15, 0.11, 0.06, 2, 0.03).translate(knee.x, knee.y - 0.01, knee.z + 0.095), `lowerleg.${s}`, PLATE)
    add(limb(knee, ankle, 0.095, 0.115, 0.04, 0.02), `lowerleg.${s}`, SHELL)
    // The boot: heel and arch on the foot bone, the toe cap on the toes so it bends.
    add(new RoundedBoxGeometry(0.24, 0.16, 0.27, 3, 0.07).translate(ankle.x, 0.08, ankle.z + 0.02), `foot.${s}`, GEAR)
    add(new RoundedBoxGeometry(0.24, 0.12, 0.14, 3, 0.055).translate(toes.x, 0.06, toes.z + 0.07), `toes.${s}`, GEAR)
  }

  const merged = mergeGeometries(parts, false)
  parts.forEach((g) => g.dispose())
  const body = mergeVertices(merged, 1e-5)
  merged.dispose()
  body.computeBoundingBox()
  return body
}

/** A sphere; `cap` < 1 keeps only that fraction of it from the top down, for a pauldron. */
function sphere(r, cap = 1) {
  return new THREE.SphereGeometry(r, 14, 10, 0, Math.PI * 2, 0, Math.PI * cap)
}

/**
 * A capsule-ended cylinder from joint `a` to joint `b`, radius `ra` at a and `rb` at b,
 * pulled in from each joint by `insetA` / `insetB` so the ball joints show.
 */
function limb(a, b, ra, rb, insetA, insetB) {
  const dir = new THREE.Vector3().subVectors(b, a)
  const full = dir.length()
  dir.normalize()
  const length = Math.max(0.01, full - insetA - insetB)
  // Cylinder's +Y is the top: the top is the b end.
  const geo = new THREE.CylinderGeometry(rb, ra, length, 12, 1)
  const caps = [new THREE.SphereGeometry(rb, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, length / 2, 0),
    new THREE.SphereGeometry(ra, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).translate(0, -length / 2, 0)]
  const piece = mergeGeometries([geo, ...caps].map((g) => g.toNonIndexed()), false)
  ;[geo, ...caps].forEach((g) => g.dispose())
  piece.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir))
  const mid = new THREE.Vector3().copy(a).addScaledVector(dir, insetA + length / 2)
  return piece.translate(mid.x, mid.y, mid.z)
}

/** A torus round the bone from `a` to `b`, `t` of the way along it. */
function ring(a, b, r, tube, t) {
  const dir = new THREE.Vector3().subVectors(b, a).normalize()
  const geo = new THREE.TorusGeometry(r, tube, 6, 16)
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir))
  const p = new THREE.Vector3().lerpVectors(a, b, t)
  return geo.translate(p.x, p.y, p.z)
}

/** Narrow a centred box towards its bottom: the hard-shell chest's V. */
function taper(geo, height, bottomX, bottomZ) {
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const f = THREE.MathUtils.clamp(0.5 - pos.getY(i) / height, 0, 1)
    pos.setX(i, pos.getX(i) * THREE.MathUtils.lerp(1, bottomX, f))
    pos.setZ(i, pos.getZ(i) * THREE.MathUtils.lerp(1, bottomZ, f))
  }
  geo.computeVertexNormals()
}

/** Bind a part wholly to one bone and paint it, in the attribute set the crew shader reads. */
function rigid(geo, bone, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo
  if (g !== geo) geo.dispose()
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
  const n = g.attributes.position.count
  const color = new Float32Array(n * 3)
  const skinIndex = new Float32Array(n * 4)
  const skinWeight = new Float32Array(n * 4)
  const c = new THREE.Color(hex)
  for (let i = 0; i < n; i++) {
    c.toArray(color, i * 3)
    skinIndex[i * 4] = bone
    skinWeight[i * 4] = 1
  }
  g.setAttribute('color', new THREE.BufferAttribute(color, 3))
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4))
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4))
  return g
}
