import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  HEAD,
  SCREEN,
  earLightGeometry,
  glassGeometry,
  haloGeometry,
  headGeometry,
  screenGeometry,
} from '../src/agents/model.js'

const R = 0.48
const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
const hit = (geometry, origin, dir) =>
  new THREE.Raycaster(origin, dir).intersectObject(new THREE.Mesh(geometry, material))[0]?.distance

test('the glass sits in front of the LED screen, and the screen in front of the shell', () => {
  const head = headGeometry(R)
  const screen = screenGeometry(R)
  const glass = glassGeometry(R)
  // Across the screen, straight on: glass first, then the screen, and nothing of the shell
  // in front of either — the bezel's hole is the screen's own outline.
  for (const [u, v] of [[0, 0], [0.4, 0.3], [-0.4, -0.3], [0.45, -0.35]]) {
    const origin = new THREE.Vector3(u * SCREEN.width * R, v * SCREEN.height * R, 3)
    const dir = new THREE.Vector3(0, 0, -1)
    const g = hit(glass, origin, dir)
    const s = hit(screen, origin, dir)
    const h = hit(head, origin, dir)
    assert.ok(Number.isFinite(g) && Number.isFinite(s) && Number.isFinite(h))
    assert.ok(g < s, 'glass in front of the screen')
    assert.ok(s <= h + 1e-6, 'nothing of the shell covers the screen')
  }
  for (const g of [head, screen, glass]) g.dispose()
})

test('the screen spans 0..1 in UV across its own face', () => {
  const screen = screenGeometry(R)
  const uv = screen.attributes.uv
  let [minU, maxU, minV, maxV] = [1, 0, 1, 0]
  for (let i = 0; i < uv.count; i++) {
    minU = Math.min(minU, uv.getX(i)); maxU = Math.max(maxU, uv.getX(i))
    minV = Math.min(minV, uv.getY(i)); maxV = Math.max(maxV, uv.getY(i))
  }
  assert.ok(minU > -1e-6 && maxU < 1 + 1e-6 && minV > -1e-6 && maxV < 1 + 1e-6)
  assert.ok(maxU - minU > 0.99 && maxV - minV > 0.99)
  screen.dispose()
})

test('the halo floats clear above the head, where a bird’s-eye view sees it first', () => {
  const head = headGeometry(R)
  const halo = haloGeometry(R)
  head.computeBoundingBox()
  halo.computeBoundingBox()
  assert.ok(halo.boundingBox.min.y > head.boundingBox.max.y, 'a gap between the halo and the head')
  assert.ok(halo.boundingBox.max.x - halo.boundingBox.min.x < HEAD.width * R, 'narrower than the head')
  head.dispose(); halo.dispose()
})

test('the ear lights ring the pods outside the shell, one each side', () => {
  const ears = earLightGeometry(R)
  const pos = ears.attributes.position
  let left = 0
  let right = 0
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    assert.ok(Math.abs(x) > (HEAD.width / 2) * R, 'outside the shell')
    if (x < 0) left++
    else right++
  }
  assert.equal(left, right)
  ears.dispose()
})

test('every part is finite and the head is one vertex-coloured mesh', () => {
  const parts = [headGeometry(R), screenGeometry(R), glassGeometry(R), haloGeometry(R), earLightGeometry(R)]
  for (const g of parts) {
    for (const attribute of Object.values(g.attributes)) assert.ok([...attribute.array].every(Number.isFinite))
  }
  assert.ok(parts[0].attributes.color, 'the head carries its shell, bezel and pod colours')
  assert.equal(parts[0].attributes.uv, undefined, 'merged without stray UVs')
  for (const g of parts) g.dispose()
})
