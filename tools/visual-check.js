import * as THREE from 'three'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Atrium } from '../src/game/atrium.js'
import { loadCrew, crewRig } from '../src/agents/crew.js'
import { installWorldCurve, setCurveView, CURVE_FULL } from '../src/core/curve.js'
import { OFFICES, OFFICE_ORDER, mulberry } from '../src/world/offices.js'

// Synthetic data only: no atrium API, saved preferences, or user threads are modified.
Math.random = mulberry(9342)
const output = document.querySelector('#results')
const query = new URLSearchParams(location.search)
const requestedOffice = OFFICES[query.get('office')] ? query.get('office') : 'glass'
const styles = query.has('all') ? OFFICE_ORDER : [requestedOffice]
const results = []
const report = (r) => { results.push(r); output.textContent = JSON.stringify(results, null, 2) }
try {
  await loadCrew()
  installWorldCurve()
  for (const office of styles) {
    Math.random = mulberry(9342)
    const settings = new Settings()
    Object.assign(settings.values, PRESETS.balanced.values, {
      office, autoQuality: false,
      renderScale: 1 / devicePixelRatio, tiltShift: false,
      exposure: 1, bloomStrength: 0.25, saturation: 1, vignette: 0.3, iblIntensity: 1, fov: 38,
    })
    const engine = new Engine(settings).mount(document.querySelector('#scene'))
    const atrium = new Atrium(engine.scene, settings, engine.camera, engine.renderer)
    atrium.bots.setRig(crewRig())
    const threads = Array.from({ length: 42 }, (_, i) => ({
      id: `visual-${i}`, project: `fixture-${Math.floor(i / 14)}`, title: `Fixture ${i}`,
      createdAt: i, lastActivityAt: Date.now(), sizeBytes: 100000, unread: i % 3 === 0, running: i % 3 === 1,
    }))
    atrium.setThreads(threads, new Set(), new Set(), new Set(threads.map(t => t.id)))
    const focus = new THREE.Vector3()
    const view = (x, y, z, distance = 1) => {
      focus.set(x, y, z)
      engine.camera.position.set(x + 30 * distance, y + 30 * distance, z + 40 * distance)
      engine.camera.lookAt(focus)
      engine.setFocusDistance(engine.camera.position.distanceTo(focus))
      setCurveView(focus, Math.atan2(30, 40), 0)
    }
    view(0, 0, 0)
    let corrections = 0
    const original = atrium.bots._unglitch.bind(atrium.bots)
    atrium.bots._unglitch = (a) => { corrections++; original(a) }
    const probe = Object.create(Object.getPrototypeOf(atrium.bots))
    probe._sep = new THREE.Vector3()
    probe._separation = (_, out) => out.set(0, 0, 0)
    const stopped = { pos: new THREE.Vector3(), vel: new THREE.Vector3(1, 0, 0), speed: 1, ghost: 0 }
    probe._walk(stopped, new THREE.Vector3(0.01, 0, 0), 0.01, 1 / 60, 1)
    const waypointStops = stopped.vel.length() === 0 && stopped.pos.length() === 0
    const history = new Map()
    let jitterSeconds = 0, settledJitterSeconds = 0, restingWalkSeconds = 0
    const timings = []
    const jitterAgents = new Set()
    const roofLandings = new Set()
    let clippedParcels = 0
    for (let frame = 0; frame < 10800; frame++) {
      const start = performance.now()
      atrium.update(1 / 60, frame / 60, focus)
      timings.push(performance.now() - start)
      for (const p of atrium.fauna.fleet?.parcels || []) {
        const surface = atrium.buildingSurfaces.at(p.x, p.z)
        if (p.y < surface.height - 0.01) clippedParcels++
        if (p.landed && surface.height > atrium.groundAt(p.x, p.z) + 0.25) roofLandings.add(p)
      }
      for (const a of atrium.bots.agents) {
        let h = history.get(a.id)
        if (!h) history.set(a.id, h = { x: a.pos.x, z: a.pos.z, startX: a.pos.x, startZ: a.pos.z, travel: 0 })
        h.travel += Math.hypot(a.pos.x - h.x, a.pos.z - h.z)
        h.x = a.pos.x; h.z = a.pos.z
        if (frame % 60 === 59) {
          if (frame > 600 && h.travel > 0.3 && Math.hypot(a.pos.x - h.startX, a.pos.z - h.startZ) < 0.15) {
            jitterSeconds++
            if (frame > 3600) { settledJitterSeconds++; jitterAgents.add(a.id) }
          }
          if (frame > 3600 && a.status === 'waiting' && a.state === 'at-site' && a.groundSpeed > 0.15) restingWalkSeconds++
          h.travel = 0; h.startX = a.pos.x; h.startZ = a.pos.z
        }
      }
      if (frame % 180 === 0) { engine.renderFrame(); await new Promise(requestAnimationFrame) }
    }
    let offDeckVertices = 0, buildingVertices = 0, offDeckProps = 0
    const point = new THREE.Vector3()
    for (const entry of atrium.buildings.values()) {
      entry.mesh.updateMatrixWorld(true)
      const pos = entry.mesh.geometry.attributes.position
      const plot = atrium.plots.get(entry.plot)
      for (let i = 0; i < pos.count; i++) {
        point.fromBufferAttribute(pos, i).applyMatrix4(entry.mesh.matrixWorld)
        if (!plot.containsWorld(point.x, point.z)) offDeckVertices++
        buildingVertices++
      }
    }
    for (const plot of atrium.plotOrder) {
      // The walls' own navigation markers stand on the room's edge by design; props must not.
      const walls = new Set(plot.rooms?.userData.obstacles || [])
      for (const p of plot.clutterSpots || []) if (!walls.has(p) && !plot.containsLocal(p.x, p.z, p.r)) offDeckProps++
    }
    timings.sort((a, b) => a - b)
    const blockedSites = atrium.bots.agents.filter(a => atrium.nav.isBlocked(a.site.x, a.site.z) || atrium.nav.insideKeep(a.site.x, a.site.z)).length
    report({ complete: true, passed: waypointStops && settledJitterSeconds === 0 && restingWalkSeconds === 0 && corrections === 0 && offDeckVertices === 0 && offDeckProps === 0 && clippedParcels === 0 && blockedSites === 0,
      office, simulatedSeconds: 180, waypointStops, jitterSeconds, settledJitterSeconds,
      jitterAgents: [...jitterAgents], restingWalkSeconds, corrections, offDeckVertices, buildingVertices,
      offDeckProps, roofLandings: roofLandings.size, clippedParcels,
      blockedSites,
      blockedDetail: atrium.bots.agents.filter(a => atrium.nav.isBlocked(a.site.x, a.site.z) || atrium.nav.insideKeep(a.site.x, a.site.z)).map(a => {
        const e = atrium.buildings.get(a.id)
        return { id: a.id, status: a.status, site: [a.site.x.toFixed(2), a.site.z.toFixed(2)], desk: e && [e.mesh.position.x.toFixed(2), e.mesh.position.z.toFixed(2), e.mesh.rotation.y.toFixed(2), e.mesh.userData.kind, e.slot], blocked: atrium.nav.isBlocked(a.site.x, a.site.z), keep: atrium.nav.insideKeep(a.site.x, a.site.z) }
      }),
      updateMedianMs: timings[Math.floor(timings.length * 0.5)], updateP95Ms: timings[Math.floor(timings.length * 0.95)],
    })
    if (office !== styles.at(-1)) {
      atrium.dispose()
      engine.dispose()
      engine.canvas.remove()
      continue
    }
    let elapsed = 180
    engine.add({ update(dt) { elapsed += dt; atrium.update(dt, elapsed, focus) } })
    engine.start()
    for (const id of OFFICE_ORDER) {
      const link = document.createElement('a')
      link.textContent = OFFICES[id].name
      link.href = `?office=${id}`
      document.querySelector('nav').append(link)
    }
    const button = (text, fn) => {
      const b = document.createElement('button'); b.textContent = text; b.onclick = fn
      document.querySelector('nav').append(b)
    }
    button('Overview', () => view(0, 0, 0))
    button('Delivery close-up', () => {
      const entry = [...atrium.buildings.values()].find(e => e.mesh.userData.kind === 'greenhouse') || [...atrium.buildings.values()][0]
      const p = entry.mesh.position
      view(p.x, p.y + 0.5, p.z, 0.22)
      const fleet = atrium.fauna.fleet
      if (fleet) for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2
        const x = p.x + Math.cos(a) * 0.5, z = p.z + Math.sin(a) * 0.5
        fleet._release({ x, z, y: atrium.buildingSurfaces.at(x, z).height + 4 })
      }
    })
    button('Night shift', () => {
      settings.values.office = settings.values.office === 'night' ? 'glass' : 'night'
      atrium.setStyle(settings.values.office)
      engine.setStyle(atrium.style)
    })
  }
} catch (error) { report({ error: error.stack }) }
