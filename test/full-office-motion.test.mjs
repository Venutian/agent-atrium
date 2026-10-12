// Simulation only: canvas painting is stubbed. Browser checks verify GPU pixels and the rig.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Atrium } from '../src/game/atrium.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { mulberry, OFFICE_ORDER } from '../src/world/offices.js'

function canvasStub() {
  const canvas = { width: 300, height: 150 }
  const noop = () => {}
  const gradient = () => ({ addColorStop: noop })
  const context = new Proxy({
    canvas,
    measureText: text => ({ width: String(text).length * 20 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  }, { get: (object, key) => key in object ? object[key] : noop })
  canvas.getContext = () => context
  return canvas
}

test('all five styles keep 42 bots on clear standing sites for three simulated minutes', () => {
  const previous = { document: globalThis.document, Path2D: globalThis.Path2D, random: Math.random }
  globalThis.Path2D = class {}
  globalThis.document = { createElement: canvasStub }
  try {
    for (const office of OFFICE_ORDER) {
      Math.random = mulberry(9342)
      const settings = new Settings()
      Object.assign(settings.values, PRESETS.balanced.values, { office, particles: 'off', ibl: false })
      const camera = new THREE.PerspectiveCamera(38, 1.6, 0.5, 900)
      camera.position.set(30, 30, 40)
      camera.lookAt(0, 0, 0)
      camera.updateMatrixWorld()
      const atrium = new Atrium(new THREE.Scene(), settings, camera, null)
      try {
        const threads = Array.from({ length: 42 }, (_, i) => ({
          id: `visual-${i}`, project: `fixture-${Math.floor(i / 14)}`, createdAt: i,
          lastActivityAt: Date.now(), sizeBytes: 100000, unread: i % 3 === 0, running: i % 3 === 1,
        }))
        atrium.setThreads(threads, new Set(), new Set(), new Set(threads.map(t => t.id)))
        const focus = new THREE.Vector3()
        let corrections = 0
        const unglitch = atrium.bots._unglitch.bind(atrium.bots)
        atrium.bots._unglitch = agent => { corrections++; unglitch(agent) }
        for (let frame = 0; frame < 10800; frame++) atrium.update(1 / 60, frame / 60, focus)
        const blocked = atrium.bots.agents.filter(agent =>
          atrium.nav.isBlocked(agent.site.x, agent.site.z) || atrium.nav.insideKeep(agent.site.x, agent.site.z))
        assert.equal(atrium.bots.agents.length, 42, office)
        assert.equal(blocked.length, 0, `${office}: blocked standing sites`)
        assert.equal(corrections, 0, `${office}: stuck-bot corrections`)
      } finally { atrium.dispose() }
    }
  } finally {
    globalThis.document = previous.document
    globalThis.Path2D = previous.Path2D
    Math.random = previous.random
  }
})
