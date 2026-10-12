import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import { bodyGeometry } from '../src/agents/body.js'
import { demoThreads } from '../server/demo.mjs'
import { suitColorFor } from '../src/agents/bots.js'

/** The rig's bind-pose joints, read the way crew.js reads them: from the inverse bind matrices. */
async function rigJoints() {
  const doc = await new NodeIO().read(fileURLToPath(new URL('../public/assets/crew.glb', import.meta.url)))
  const skin = doc.getRoot().listSkins()[0]
  const ibm = skin.getInverseBindMatrices()
  const joints = new Map(), index = new Map()
  skin.listJoints().forEach((joint, i) => {
    const m = new THREE.Matrix4().fromArray(ibm.getElement(i, [])).invert()
    joints.set(joint.getName(), new THREE.Vector3().setFromMatrixPosition(m))
    index.set(joint.getName(), i)
  })
  return { joints, index }
}

test('the body is rigidly bound to real bones, painted, and stands on the floor at the rig height', async () => {
  const { joints, index } = await rigJoints()
  const body = bodyGeometry(joints, index)
  const { skinIndex, skinWeight, color, position, normal } = body.attributes
  assert.ok(position.count > 1000 && position.count < 20000, `${position.count} vertices`)
  assert.ok(normal && color, 'normals and vertex colours')
  const bones = index.size
  for (let i = 0; i < position.count; i++) {
    assert.equal(skinWeight.getX(i), 1)
    assert.ok(skinIndex.getX(i) >= 0 && skinIndex.getX(i) < bones)
  }
  // Every limb bone carries a part, so every clip moves the whole body.
  const used = new Set(Array.from({ length: position.count }, (_, i) => skinIndex.getX(i)))
  for (const name of ['hips', 'spine', 'chest', 'upperarm.l', 'lowerarm.r', 'hand.l', 'upperleg.r', 'lowerleg.l', 'foot.r', 'toes.l']) {
    assert.ok(used.has(index.get(name)), `${name} carries a part`)
  }
  const box = body.boundingBox
  assert.ok(Math.abs(box.min.y) < 0.02, `boots on the floor (${box.min.y})`)
  assert.ok(box.max.y < joints.get('head').y + 0.1, 'nothing pokes up into the monitor head')
})

test('the body fails loudly on a rig without the bones it is built on', () => {
  assert.throws(() => bodyGeometry(new Map([['hips', new THREE.Vector3()]]), new Map([['hips', 0]])), /no spine bone/)
})

test('the demo office is made up, varied, and leads nowhere', () => {
  const threads = demoThreads(Date.parse('2026-10-12T12:00:00Z'))
  assert.ok(threads.length >= 12)
  assert.deepEqual(new Set(threads.map((t) => suitColorFor(t))).size, 3, 'Claude, Codex and other suits all appear')
  for (const state of ['running', 'unread', 'hasError']) assert.ok(threads.some((t) => t[state]), state)
  assert.ok(threads.some((t) => t.prState === 'MERGED'))
  assert.ok(threads.every((t) => !t.canOpen && !t.cwd && !t.projectPath && t.id.startsWith('demo:')))
  assert.ok(threads.every((t) => t.usage.known && t.usage.byDay.length > 0))
})
