import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { Plot, DECK_TOP, hexToWorld } from '../src/world/plots.js'
import { OFFICES, OFFICE_ORDER } from '../src/world/offices.js'
import { Settings } from '../src/core/settings.js'
import { Engine } from '../src/core/engine.js'
import { Atrium } from '../src/game/atrium.js'
import { suitColorFor } from '../src/agents/bots.js'
import { Navigation } from '../src/agents/navigation.js'
import { Sky } from '../src/world/sky.js'

const room = (cells = [{ q: 1, r: 0 }], style = OFFICES.glass) => new Plot({ id: 'repo', name: 'repo', index: 0, cells, accent: 0x4f7ec9, style })

test('glass studio is the first and default style, and every style is complete', () => {
  assert.equal(OFFICE_ORDER[0], 'glass')
  assert.equal(new Settings().get('office'), 'glass')
  assert.deepEqual([...OFFICE_ORDER].sort(), Object.keys(OFFICES).sort())
  for (const style of Object.values(OFFICES)) {
    for (const key of ['sky', 'fog', 'floor', 'room', 'frame', 'glass', 'sign', 'plants', 'reception', 'furniture', 'light', 'bloom', 'grade']) assert.ok(style[key], `${style.id}.${key}`)
    assert.ok(style.fog.near > 120, 'fog starts past the rooms, so they stay clear')
    assert.ok(style.night >= 0 && style.night <= 1)
    assert.ok(['light', 'dark'].includes(style.ui))
  }
})

test('rooms stand apart with a walkway between them, and a big room is joined into one', () => {
  const single = room([{ q: 0, r: 0 }])
  const neighbour = room([{ q: 1, r: 0 }])
  const mid = hexToWorld(0.5, 0)
  assert.equal(single.containsWorld(mid.x, mid.z), false, 'the walkway between two rooms is open floor')
  assert.equal(neighbour.containsWorld(mid.x, mid.z), false)
  const joined = room([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }])
  assert.equal(joined.bridges.length, 3)
  assert.equal(joined.caps.length, 1, 'three cells meeting leave one gap to cap')
  assert.equal(joined.containsWorld(mid.x, mid.z), true, 'cells of the same room are bridged')
  for (const plot of [single, neighbour, joined]) plot.dispose()
})

test('white rooms have visible glass and high frames, with shared walls removed', () => {
  for (const [cells, expectedEdges] of [[[{ q: 1, r: 0 }], 6], [[{ q: 1, r: 0 }, { q: 2, r: 0 }], 10]]) {
    const plot = room(cells)
    const glass = plot.rooms.getObjectByName('architectural-glass')
    assert.ok(glass.material.opacity > 0.1 && glass.material.opacity < 0.25)
    assert.equal(glass.material.depthWrite, false)
    const bounds = new THREE.Box3().setFromObject(plot.rooms)
    assert.ok(bounds.max.y > DECK_TOP + 3.4)
    // Four vertices on each side of two box panes per exterior edge.
    assert.equal(glass.geometry.attributes.position.count, expectedEdges * 2 * 24)
    assert.ok(plot.rooms.userData.obstacles.length > 0)
    plot.dispose()
  }
})

test('open portals provide a walkable path into each fully populated room', () => {
  const plot = room()
  const nav = new Navigation()
  const obstacles = plot.clutterSpots.map(s => ({ x: s.x, z: s.z, r: s.r + 0.4, keep: s.r + 0.4 }))
  // A full seven-bot room includes a project in its center and all six ring slots.
  for (const s of plot.slots) obstacles.push({ x: s.x, z: s.z, r: 1.8, keep: 2 })
  nav.rebuild(obstacles)
  const e = plot.signEdge
  const outward = new THREE.Vector3(Math.cos(e.angle), 0, Math.sin(e.angle))
  const doorway = new THREE.Vector3(e.x, 0, e.z)
  assert.equal(nav.insideKeep(doorway.x, doorway.z), false)
  const start = doorway.clone().addScaledVector(outward, 2)
  const target = doorway.clone().addScaledVector(outward, -0.3)
  assert.ok(nav.findPath(start.x, start.z, target.x, target.z)?.length)
  plot.dispose()
})

test('sign is attached to the exterior, remains clickable and rises with its room', () => {
  const plot = room()
  const label = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 1.16), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  label.layers.set(1)
  label.userData.physical = true
  plot.attachOfficeLabel(label)
  plot.label = label
  assert.equal(plot.signMount.parent, plot.group)
  assert.ok(label.position.y > DECK_TOP + 3.4)
  const camera = new THREE.PerspectiveCamera(38, 1.6, 0.5, 900)
  camera.position.copy(label.position).add(new THREE.Vector3(20, 20, 25))
  camera.lookAt(label.position)
  camera.updateMatrixWorld()
  const atrium = Object.create(Atrium.prototype)
  Object.assign(atrium, { camera, plotOrder: [plot], plots: new Map([['repo', plot]]), buildings: new Map(), uiVisible: true, settings: { get: () => true } })
  assert.equal(atrium.pickLabel(0, 0), plot)
  atrium.setPlotLift('repo', 2)
  assert.equal(label.position.y, label.userData.baseY + 2)
  const glass = plot.rooms.getObjectByName('architectural-glass')
  atrium.setPlotLift('repo', 0)
  assert.equal(glass.material.opacity, OFFICES.glass.glass.opacity)
  assert.equal(glass.material.transparent, true)
  plot.dispose(); label.geometry.dispose(); label.material.dispose()
})

test('every style blooms within its own threshold, light floors only on real glows, and focus is the style’s own', () => {
  const engine = Object.create(Engine.prototype)
  let bloom = true
  let focus = true
  const values = { bloomStrength: 0.25, tiltShiftStrength: 0.2, tiltShiftAngle: 0 }
  engine.settings = { get: (key) => (key === 'bloom' ? bloom : key === 'tiltShift' ? focus : key in values ? values[key] : true) }
  const lens = { strength: -1, angle: -1 }
  engine.bloomPass = {}
  engine.tiltShift = { setStrength: (v) => (lens.strength = v), setAngle: (v) => (lens.angle = v), setCamera() {} }
  engine.setStyle(OFFICES.glass)
  assert.equal(engine.bloomPass.enabled, true)
  assert.ok(engine.bloomPass.threshold > 1, 'a light floor must not clear the threshold itself')
  assert.equal(engine.tiltShift.enabled, OFFICES.glass.dof > 0)
  assert.equal(lens.strength, OFFICES.glass.dof, 'the default slider shows the style as designed')
  assert.equal(lens.angle, 0)
  values.tiltShiftStrength = 0.4
  engine.setStyle(OFFICES.glass)
  assert.equal(lens.strength, OFFICES.glass.dof * 2, 'the slider scales the style')
  focus = false
  engine.setStyle(OFFICES.glass)
  assert.equal(engine.tiltShift.enabled, false, 'the setting still turns it off')
  engine.setStyle(OFFICES.night)
  assert.ok(engine.bloomPass.threshold < OFFICES.glass.bloom.threshold)
  assert.equal(engine.bloomPass.strength, OFFICES.night.bloom.strength)
  bloom = false
  engine.setStyle(OFFICES.night)
  assert.equal(engine.bloomPass.enabled, false, 'the bloom setting still turns it off')
})

test('suit colors identify agent source independently of model and task status', () => {
  assert.equal(suitColorFor({ harness: 'claude-code', running: true }), 0xe87532)
  assert.equal(suitColorFor({ harness: 'codex', unread: true }), 0x181d24)
  assert.equal(suitColorFor({ harnessName: 'Claude Code' }), 0xe87532)
  assert.equal(suitColorFor({ id: 'codex:1' }), 0x181d24)
  for (const harness of ['cursor', 'status-files', 'kilocode', 'opencode', 'copilot']) assert.equal(suitColorFor({ harness, model: 'local' }), 0x397fcb)
})

test('style sky light follows the user slider and resets correctly when switching offices', () => {
  const scene = new THREE.Scene()
  const values = { ibl: true, iblIntensity: 1 }
  const settings = { shadowSize: 1024, get: key => values[key] }
  const sky = new Sky(scene, settings)
  try {
    sky.setStyle(OFFICES.glass)
    const glassIntensity = scene.environmentIntensity
    assert.ok(glassIntensity > 0 && glassIntensity < 1)
    values.iblIntensity = 1.8
    sky.onSettingsChanged(new Set(['iblIntensity']))
    assert.equal(scene.environmentIntensity, glassIntensity * 1.8)
    sky.setStyle(OFFICES.oak)
    assert.equal(scene.environmentIntensity, 1.8, 'Sunset keeps its existing sky-light balance')
    assert.equal(sky.fill.color.getHex(), 0x8fa8d8, 'a style without a fill tint resets to the original')
    sky.setStyle(OFFICES.night)
    assert.equal(sky.fill.color.getHex(), OFFICES.night.light.fillColor)
    values.ibl = false
    sky.onSettingsChanged(new Set(['ibl']))
    assert.equal(sky.hemi.intensity, OFFICES.night.light.ambient)
    values.ibl = true
    sky.onSettingsChanged(new Set(['ibl']))
    assert.equal(sky.hemi.intensity, OFFICES.night.light.ambient * 0.55)
    assert.equal(scene.environmentIntensity, values.iblIntensity * OFFICES.night.light.environment)
  } finally {
    sky.dispose()
  }
})
