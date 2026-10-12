import { SceneryReflections } from '../world/reflections.js'
import * as THREE from 'three'
import { createOfficeFloor, floorHeight, officeStyle } from '../world/offices.js'
import { Fauna } from '../world/fauna.js'
import { BuildingSurfaces } from '../world/building-surfaces.js'
import { bendPoint } from '../core/curve.js'
import { Sky } from '../world/sky.js'
import {
  Plot,
  allocateCells,
  receptionPosition,
  entranceDoor,
  createLabel,
  hashString,
  worldToHex,
  hexToWorld,
  DECK_TOP,
  PLOT_PALETTE,
  PLOT_CELL,
} from '../world/plots.js'
import { HEX_DIRS, RECEPTION_CELL, translateCells } from '../world/plot-move.js'
import { createFloorDecor } from '../world/decor.js'
import { createWorkstation, workstationUniforms } from '../world/workstations.js'
import { createCommons } from '../world/commons.js'
import { Bots } from '../agents/bots.js'
import { Indicators, BADGE } from '../agents/indicators.js'
import { MAX_AGENT_CAP } from '../core/settings.js'
import { Particles } from '../agents/particles.js'
import { Navigation } from '../agents/navigation.js'
import { liveThreadsOnFloor } from './hidden-projects.js'
import { createOfficeReception } from '../world/office.js'

/**
 * The office: everything that turns a list of agent threads into a place.
 *
 * The mapping is the whole game. It is a strict precedence rather than a set of independent
 * flags — errored, then running, then merged, then unread — so a bot can only ever be
 * telling you one thing, and the loudest true thing wins.
 *
 *   errored        → blocked, red eyes, a `!` over its head
 *   running        → hammering away at its building, sparks flying
 *   PR merged      → celebrating, confetti, a `✓`
 *   unread         → stopped and waiting on you, a bobbing `?` — click it to open the thread
 *   long idle      → asleep on the job
 *   anything else  → pottering about its plot
 *
 * Threads group by repo, one repo per glass room, and every thread gets a building seeded
 * from its own session id — so the office is a stable, readable picture of what you have
 * running.
 */

const STALE_MS = 3 * 24 * 60 * 60 * 1000
/** How wide a bot is, for the purpose of not fitting through gaps it should not. */
const AGENT_RADIUS = 0.26
/**
 * The radius the crew *travels* with, which is smaller than the one it stands with. The
 * grid is rasterised at this, so the gaps between buildings stay routes; a shoulder
 * through a wall for a step is the price, and the keep radius sorts it out on arrival.
 */
const TRAVEL_RADIUS = 0.12
/** Progress a live thread adds per second, so a working site visibly grows while you watch. */
const LIVE_GROWTH = 0.004
/** How many zones' positions to remember, including repos with nothing running in them. */
const LAYOUT_MEMORY = 80

export const STATUS_ORDER = ['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping']

export const STATUS_LABEL = {
  working: 'Working',
  waiting: 'Waiting on you',
  blocked: 'Blocked',
  celebrating: 'Shipped',
  idle: 'Idle',
  sleeping: 'Dormant',
  spawning: 'Arriving',
  leaving: 'Heading home',
}

/** Thread → behaviour. First match wins, exactly like the board's auto-sort. */
export function statusFor(thread, now = Date.now()) {
  const stale = now - thread.lastActivityAt > STALE_MS
  // An error from days ago is history, not something to drop everything for: a thread that
  // failed and was left alone dozes like any other quiet one.
  if (thread.hasError) return stale ? 'sleeping' : 'blocked'
  if (thread.running) return 'working'
  if (thread.prState === 'MERGED') return 'celebrating'
  if (thread.unread) return 'waiting'
  if (now - thread.lastActivityAt > STALE_MS) return 'sleeping'
  return 'idle'
}

/**
 * Which behaviours earn a badge. Dormant and idle deliberately get none: their pose and
 * face already say it, and with most of a real thread list sitting quiet, a badge over
 * every one of them buries the single `?` that actually wants you.
 */
const BADGE_FOR = {
  waiting: BADGE.waiting,
  blocked: BADGE.blocked,
  working: BADGE.working,
  celebrating: BADGE.done,
  sleeping: BADGE.none,
  idle: BADGE.none,
  spawning: BADGE.spawning,
  leaving: BADGE.leaving,
}

/** Transcript size → how finished the building looks. Log scale: threads grow fast early. */
/**
 * How far along a thread is, on a log scale over its transcript size. This drives the bar
 * on the thread card — it no longer drives how much of the building you can see.
 *
 * It used to. The shader draws construction by sinking the structure into the ground and
 * discarding what falls below the deck, and mapping transcript size onto that meant most
 * buildings stood permanently waist-deep in their own plot. Read as a picture of an atrium
 * rather than as a chart, that is not "this thread is young", it is "this building is
 * broken" — a dome cut off by a flat plane looks like a rendering fault, and it is the
 * first thing the eye goes to. So the sink is now only what it is good at: the few seconds
 * of a new building rising out of the ground.
 */
export function transcriptProgress(thread) {
  const size = Math.max(1, thread.sizeBytes || 0)
  return THREE.MathUtils.clamp((Math.log10(size) - 3) / 3.5, 0.05, 1)
}

export class Atrium {
  constructor(scene, settings, camera, renderer) {
    this.scene = scene
    this.settings = settings
    this.camera = camera
    this.renderer = renderer

    this.style = officeStyle(settings.get('office'))
    this.sky = new Sky(scene, settings, renderer)
    this.sky.setStyle(this.style)

    this.plots = new Map()
    this.plotOrder = []
    /**
     * Where every zone sits, kept across polls *and* across the departures of the threads
     * that made it: a repo whose last session you archive comes back to the same ground
     * when a new one starts. Seeded from the atrium file by `restoreLayout`.
     */
    this.plotCells = new Map()
    this.buildings = new Map()
    this.buildingSurfaces = new BuildingSurfaces(this.buildings, (x, z) => this.surfaceAt(x, z))
    this.threads = new Map()
    this.usedAccents = new Set()

    this.worldGroup = new THREE.Group()
    this.worldGroup.name = 'world'
    scene.add(this.worldGroup)

    this.bots = new Bots(scene, settings)
    this.bots.world = this._world()
    // Sized for the largest preset rather than the current one: unlike the bot meshes these
    // buffers are never rebuilt, so allocating against today's `maxAgents` means raising quality
    // later silently starves the badges — the one `?` that wants you being the thing that goes
    // missing. A badge is a single quad; the spare instances cost almost nothing.
    this.indicators = new Indicators(scene, settings, MAX_AGENT_CAP)
    this.particles = new Particles(scene, settings)
    // The delivery drones carrying parcels between rooms: the life that carries no information.
    this.fauna = new Fauna(scene, settings)
    this.reflections = new SceneryReflections({
      scene, renderer, settings, sky: this.sky, bots: this.bots,
      excluded: () => [this.labelGroup, this.indicators.mesh, this.particles.points, this.fauna.group],
    })
    /** Set by whoever owns the speakers: (name, x, y, z) for a sound the world just made. */
    this.onSound = null
    this.nav = new Navigation()
    this.bots.setNavigation(this.nav)

    this.plotGroup = new THREE.Group()
    this.labelGroup = new THREE.Group()
    scene.add(this.plotGroup, this.labelGroup)

    // Dismissing the HUD has to survive a poll: labels are chrome, and a scan landing while
    // everything is hidden must not quietly put them back on screen.
    this.uiVisible = true
    this.hoveredPlot = null
    this.activePlots = new Set()
    this._dustTint = new THREE.Color(this.style.floor.seam)
    this._c = new THREE.Color()
    this._c2 = new THREE.Color()
    this.stats = { agents: 0, projects: 0, working: 0, waiting: 0, blocked: 0, done: 0 }

    this._buildTerrain()
  }

  // ── floor ───────────────────────────────────────────────────────────────────────────

  /** The open floor and the reception courtyard, both in the current style's colours. */
  _buildTerrain() {
    if (this.terrain) {
      this.worldGroup.remove(this.terrain)
      this.terrain.geometry.dispose()
      this.terrain.userData.dispose?.()
      this.terrain.material.dispose()
    }
    if (this.reception) {
      this.worldGroup.remove(this.reception)
      disposeTree(this.reception)
    }
    if (this.commons) {
      this.worldGroup.remove(this.commons.group)
      this.commons.dispose()
    }
    this.terrain = createOfficeFloor(this.style)
    this.worldGroup.add(this.terrain)
    const desk = receptionPosition()
    this.reception = createOfficeReception(this.style)
    this.reception.position.set(desk.x, floorHeight(), desk.z)
    this.worldGroup.add(this.reception)
    // The lounge, coffee bar, games and status board around reception.
    this.commons = createCommons(this.style)
    this.commons.group.position.set(desk.x, floorHeight(), desk.z)
    this.worldGroup.add(this.commons.group)
    if (this.stats) this.commons.setStats(this.stats)
    if (this.officeData) this.setOfficeData(this.officeData)
    this._dustTint.set(this.style.floor.seam)

    // Only when the style itself changed, so an unrelated setting does not put every drone
    // back on its pad.
    if (this._faunaStyle !== this.style.id) {
      this._faunaStyle = this.style.id
      this.fauna.start({ drones: { count: 3 } }, {
        heightAt: (x, z) => this.groundAt(x, z),
        parcelSurfaceAt: (x, z) => this.buildingSurfaces.at(x, z),
      })
    }
    this._syncFaunaSites()
    if (this.nav) this._rebuildNavigation()
  }

  /** Where the drones fly between: the reception, and every building with anyone at it. */
  _syncFaunaSites() {
    const sites = []
    for (const [id, entry] of this.buildings) {
      if (entry.retiring) continue
      const p = entry.mesh.position
      sites.push({ x: p.x, y: p.y, z: p.z, radius: entry.mesh.userData.footprint, active: this._isActive(id) })
    }
    const pad = receptionPosition()
    pad.y = floorHeight()
    this.fauna.setSites({ door: entranceDoor(), pad, sites })
  }

  /**
   * Called once the model kits are in. Buildings are assembled from the kit, so nothing
   * here needs rebuilding — but the drones were seeded before it arrived.
   */
  onAssetsReady() {
    this._faunaStyle = null
    this._buildTerrain()
  }

  /** Re-dress the whole office in another style. Rooms are rebuilt; every building stays. */
  setStyle(id) {
    const style = officeStyle(id)
    if (style === this.style) return
    this.style = style
    this.reflections.invalidate()
    this.sky.setStyle(style)
    this._buildTerrain()
    if (this._lastRoster) this.setThreads(...this._lastRoster)
  }

  onSettingsChanged(changed) {
    if (changed.has('office')) this.setStyle(this.settings.get('office'))
    this.sky.onSettingsChanged(changed)
    this.bots.onSettingsChanged(changed)
    this.particles.onSettingsChanged(changed)
    this.fauna.onSettingsChanged(changed)
    if (changed.has('showLabels')) this._syncLabels()
  }

  // ── roster ──────────────────────────────────────────────────────────────────────────

  /**
   * Take a fresh scan and reshape the atrium around it. Everything here is keyed by stable
   * ids — repo name for plots, session id for buildings — so a poll that changes nothing
   * moves nothing on screen.
   */
  setThreads(threads, archivedIds = new Set(), hiddenProjects = new Set(), knownIds = new Set()) {
    this._lastRoster = [threads, archivedIds, hiddenProjects, knownIds]
    const now = Date.now()
    const live = liveThreadsOnFloor(threads, archivedIds, hiddenProjects)

    // Group by repo, biggest project first so the busiest work lands nearest the middle.
    const byProject = new Map()
    for (const thread of live) {
      const key = thread.project || 'unknown'
      if (!byProject.has(key)) byProject.set(key, [])
      byProject.get(key).push(thread)
    }
    /**
     * Repos where nothing has stirred in days, folded away on request.
     *
     * An atrium is a map you learn, and a map is only learnable if what is on it is worth
     * looking at. Someone with a hundred checkouts has most of the ground given over to work
     * they finished in the spring, and the six repos they are actually living in are somewhere
     * in among it. Dormant is already a status the atrium understands — nothing for three days
     * — so this is that same line drawn one level up, at the repo rather than the thread.
     *
     * Deliberately all-or-nothing per repo: a zone with one live thread in it stays whole,
     * because half a zone would misrepresent the repo rather than tidy the map.
     */
    const dormant = new Set()
    if (this.settings.get('hideDormant')) {
      for (const [name, list] of byProject) {
        if (!this.sessionReveals?.has(name) && list.every((t) => statusFor(t, now) === 'sleeping')) dormant.add(name)
      }
      // Never fold away everything: an atrium that answers a poll with an empty planet reads as
      // broken rather than tidy, and there is nothing on screen to tell you which it was.
      if (dormant.size === byProject.size) dormant.clear()
      for (const name of dormant) byProject.delete(name)
    }
    this.dormantProjects = dormant

    const projects = [...byProject.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length
      return a[0].localeCompare(b[0])
    })

    this._syncPlots(projects)

    // A repo that is off the map keeps its footprint in layout memory, so showing it again
    // reclaims the same ground if it is still free. Re-inserting the entry also keeps
    // LAYOUT_MEMORY from evicting a name you only hid — otherwise a zone folded away for a
    // week loses where it used to be, and comes back somewhere else entirely.
    for (const name of [...hiddenProjects, ...dormant]) {
      const cells = this.plotCells.get(name)
      if (!cells) continue
      this.plotCells.delete(name)
      this.plotCells.set(name, cells)
    }

    const roster = []
    const seenBuildings = new Set()
    const stats = { agents: 0, projects: projects.length }
    for (const key of STATUS_ORDER) stats[key] = 0
    // Plots holding anything that wants your attention get a pulsing rim, so you can spot
    // the repo that needs you from right across the atrium without reading a single label.
    const urgent = new Set()
    // Plots with anyone working, waiting or stuck keep their name on screen; quiet ones
    // only show it on hover.
    const active = new Set()

    for (const [name, list] of projects) {
      const plot = this.plots.get(name)
      if (!plot) continue
      // Oldest thread first, so the *first* assignment of slots is deterministic; after that a
      // thread keeps the slot it was given for as long as the plot stands. Numbering by
      // position in this list, which is what this used to do, meant one archive shifted every
      // younger sibling one slot along — every building on the plot moved and every
      // bot walked, for a thread that had left.
      list.sort((a, b) => a.createdAt - b.createdAt)
      const slotOf = plot.slotOf || (plot.slotOf = new Map())
      for (const id of [...slotOf.keys()]) if (!list.some((t) => t.id === id)) slotOf.delete(id)
      const taken = new Set(slotOf.values())
      for (const thread of list) {
        if (slotOf.has(thread.id)) continue
        let slot = 0
        while (taken.has(slot)) slot++
        taken.add(slot)
        slotOf.set(thread.id, slot)
      }

      list.forEach((thread) => {
        const i = slotOf.get(thread.id)
        const status = statusFor(thread, now)
        if (stats[status] !== undefined) stats[status]++
        if (status === 'waiting' || status === 'blocked') urgent.add(plot.id)
        if (status === 'waiting' || status === 'blocked' || status === 'working') active.add(plot.id)
        stats.agents++

        const building = this._syncBuilding(thread, plot, i)
        // The desk's screens show what its thread is doing.
        building.mesh.userData.setStatus?.(status)
        seenBuildings.add(thread.id)

        roster.push({
          id: thread.id,
          thread,
          status,
          site: null, // assigned after all buildings have reached the navigation map
          // Where the work actually is. A working bot circles it rather than standing
          // at one spot, so it needs the building, not just a place to stand near it.
          anchor: building.mesh.position.clone(),
          // Already on the atrium's books, so it does not need an entrance.
          known: knownIds.has(thread.id),
        })
      })
    }

    // Anything that dropped out of the scan — archived, or a transcript that vanished —
    // takes its building down and walks its bot back to reception.
    for (const [id, entry] of this.buildings) {
      if (!seenBuildings.has(id)) this._removeBuilding(id, entry)
    }

    this.threads = new Map(live.map((t) => [t.id, t]))
    this.urgentPlots = urgent
    this.activePlots = active
    this._rebuildNavigation()
    for (const member of roster) {
      const entry = this.buildings.get(member.id)
      const plot = this.plots.get(entry.plot)
      if (member.status === 'idle' && plot.breakSpot) {
        // On a break: round the room's coffee corner, at a spot keyed by its desk's slot so
        // it does not change places whenever somebody else wanders over.
        member.site = this._clearSpot(plot, plot.breakSpot(entry.slot))
        member.anchor = plot.coffeeWorld()
      } else member.site = this._workSite(plot, entry, entry.slot, member.status)
    }
    this._syncFaunaSites()
    this.stats = { ...stats, done: stats.celebrating }
    this.commons?.setStats(this.stats)
    this.bots.setRoster(roster, this._world())
    return this.stats
  }

  _syncPlots(projects) {
    // The previous layout is an input, so a zone only moves when its own footprint changes
    // — never because a different repo gained or lost a thread. `plotCells` carries it
    // between polls, and the atrium file carries it between sessions.
    const layout = allocateCells(
      projects.map(([name, list]) => ({ id: name, size: list.length })),
      this.plotCells
    )
    // Remembered, not replaced: a project that has just lost its last thread keeps its
    // ground on the books, and the oldest entries fall off the end.
    for (const [name, cells] of layout) {
      this.plotCells.delete(name)
      this.plotCells.set(name, cells)
    }
    while (this.plotCells.size > LAYOUT_MEMORY) this.plotCells.delete(this.plotCells.keys().next().value)

    const wanted = new Map()
    for (const [name, cells] of layout) wanted.set(name, `${this.style.id}:${name}:${cells.map((c) => `${c.q},${c.r}`).join('/')}`)

    // A plot is rebuilt whenever its own footprint moved, and left completely alone
    // whenever it did not.
    for (const [name, plot] of this.plots) {
      if (wanted.get(name) === plot.signature) continue
      this.plotGroup.remove(plot.group)
      if (plot.label) {
        this.labelGroup.remove(plot.label)
        plot.label.userData.dispose?.()
      }
      this.usedAccents.delete(plot.accent)
      plot.dispose()
      this.plots.delete(name)
    }

    projects.forEach(([name], index) => {
      if (this.plots.has(name)) return
      const cells = layout.get(name)
      if (!cells?.length) return
      const accent = this._pickAccent(name)
      const plot = new Plot({ id: name, name, index, cells, accent, style: this.style })
      plot.signature = wanted.get(name)
      this.plots.set(name, plot)
      this.plotGroup.add(plot.group)

      const label = createLabel(name, accent, this.style)
      plot.attachOfficeLabel(label)
      plot.label = label
      this.labelGroup.add(label)
    })

    this.plotOrder = [...this.plots.values()]
    // Which room owns each lattice cell. Ground height is asked for once per moving agent per
    // frame, so it wants to be a lookup rather than a scan over every room's every cell.
    this.cellOwner = new Map()
    for (const plot of this.plotOrder) {
      for (const cell of plot.cells) this.cellOwner.set(`${cell.q},${cell.r}`, plot)
    }
    this._syncDecor()
    this._syncLabels()
  }

  /**
   * How high the ground is at a world point — the surface anything walking stands on.
   *
   * A plot's tiles are a raised slab, so on one of those it is the deck; everywhere else it
   * is the terrain, sampled from the same noise field the mesh was built from. Without this
   * the crew walks along y=0 while the ground around them runs from -0.35 to +0.20, and they
   * spend half the atrium buried to the shins.
   */
  /** The bits of the world the crew needs to know about, as plain callbacks. */
  _world() {
    return {
      entranceDoor: () => entranceDoor(),
      // New bots step down off the top of the reception courtyard and walk out of the door.
      entranceStep: () => {
        const door = entranceDoor()
        const centre = receptionPosition()
        return new THREE.Vector3(centre.x + (door.x - centre.x) * 0.3, floorHeight() + 0.45, centre.z + (door.z - centre.z) * 0.3)
      },
      groundAt: (x, z) => this.groundAt(x, z),
    }
  }

  /**
   * Furnish the free grid cells just outside the rooms. Rebuilt only when the set of rooms'
   * cells or the style changes, so a poll that moves nothing touches nothing. Cells next to
   * reception are left open: that is the way in.
   */
  _syncDecor() {
    const taken = new Set(this.cellOwner.keys())
    const desk = `${RECEPTION_CELL.q},${RECEPTION_CELL.r}`
    const nearDesk = new Set(HEX_DIRS.map(([dq, dr]) => `${RECEPTION_CELL.q + dq},${RECEPTION_CELL.r + dr}`))
    const spots = new Map()
    for (const key of taken) {
      const [q, r] = key.split(',').map(Number)
      for (const [dq, dr] of HEX_DIRS) {
        const k = `${q + dq},${r + dr}`
        if (taken.has(k) || k === desk || nearDesk.has(k) || spots.has(k)) continue
        const { x, z } = hexToWorld(q + dq, r + dr)
        spots.set(k, { x, z, q: q + dq, r: r + dr })
      }
    }
    // A second ring further out, furnished more thinly, so the floor thins out into the
    // distance instead of stopping dead at the rooms' edge.
    for (const spot of [...spots.values()]) {
      for (const [dq, dr] of HEX_DIRS) {
        const k = `${spot.q + dq},${spot.r + dr}`
        if (taken.has(k) || k === desk || nearDesk.has(k) || spots.has(k)) continue
        const { x, z } = hexToWorld(spot.q + dq, spot.r + dr)
        spots.set(k, { x, z, q: spot.q + dq, r: spot.r + dr, outer: true })
      }
    }
    const signature = `${this.style.id}|${[...spots.keys()].sort().join('/')}`
    if (signature === this._decorSignature) return
    this._decorSignature = signature
    if (this.decor) {
      this.worldGroup.remove(this.decor.group)
      this.decor.dispose()
    }
    this.decor = createFloorDecor([...spots.values()], this.style, floorHeight())
    this.worldGroup.add(this.decor.group)
  }

  /**
   * How high the floor is at a world point: a room's raised floor where there is one, the
   * open floor everywhere else — including the walkways between a room's own cells and its
   * neighbours', which share a lattice cell with the room but are not on it.
   */
  groundAt(x, z) {
    // A bridge only ever joins two cells of its own room, and a cap sits where three of them
    // meet, so whatever lattice cell a point falls in names the only room it can be on.
    const cell = worldToHex(x, z)
    const plot = this.cellOwner?.get(`${cell.q},${cell.r}`)
    return plot?.containsWorld(x, z) ? DECK_TOP : floorHeight()
  }

  /** The surface anything falling meets. The office has no water, so it is the floor. */
  surfaceAt(x, z) {
    return this.groundAt(x, z)
  }

  /** A stable colour per repo, probing forward on a collision so no two plots match. */
  _pickAccent(name) {
    const start = hashString(name) % PLOT_PALETTE.length
    for (let i = 0; i < PLOT_PALETTE.length; i++) {
      const accent = PLOT_PALETTE[(start + i) % PLOT_PALETTE.length]
      if (!this.usedAccents.has(accent)) {
        this.usedAccents.add(accent)
        return accent
      }
    }
    return PLOT_PALETTE[start]
  }

  _syncBuilding(thread, plot, index) {
    let entry = this.buildings.get(thread.id)
    // Whole, always. A building that has finished rising is a building you can see all of.
    const target = 1

    if (!entry) {
      const mesh = createWorkstation({ seed: hashString(thread.id), accent: plot.accent })
      const pos = plot.worldSlot(index)
      mesh.position.copy(pos)
      mesh.rotation.y = this._deskFacing(plot, pos, index)
      // New buildings rise from nothing rather than appearing whole.
      mesh.userData.setProgress(0)
      this.worldGroup.add(mesh)
      entry = { mesh, plot: plot.id, slot: index, progress: 0, target, retiring: false }
      this.buildings.set(thread.id, entry)
    } else {
      // Where this building belongs *now*. Comparing the world position rather than the
      // plot id and slot number is what catches a zone that was rebuilt underneath it: the
      // repo is the same and the slot is the same, but the ground moved, and a habitat left
      // behind on bare terrain takes its bot off the plot with it.
      const want = plot.worldSlot(index, this._slotAt || (this._slotAt = new THREE.Vector3()))
      if (entry.plot !== plot.id || entry.slot !== index || entry.mesh.position.distanceToSquared(want) > 1e-4) {
        entry.plot = plot.id
        entry.slot = index
        entry.mesh.position.copy(want)
        entry.mesh.rotation.y = this._deskFacing(plot, want, index)
      }
    }

    entry.target = target
    entry.accent = plot.accent
    entry.retiring = false
    return entry
  }

  /**
   * Which way a desk faces: toward the middle of its room, so the bots working at a room's
   * desks gather round its middle with their screens behind them as you look in. A desk on
   * the middle itself has no "toward", so it is fanned by slot instead.
   */
  _deskFacing(plot, pos, index) {
    const middle = plot.middle || plot.center
    const dx = middle.x - pos.x
    const dz = middle.z - pos.z
    return Math.hypot(dx, dz) > 0.2 ? Math.atan2(dx, dz) : (index * 2.4) % (Math.PI * 2)
  }

  _removeBuilding(id, entry) {
    // Wind the reveal back down, then take it out — a building that vanishes mid-frame
    // reads as a glitch, one that sinks reads as being packed up.
    entry.retiring = true
    entry.target = 0
    if (entry.progress <= 0.02) {
      this.worldGroup.remove(entry.mesh)
      entry.mesh.geometry.dispose()
      entry.mesh.material.dispose()
      entry.mesh.customDepthMaterial?.dispose()
      this.buildings.delete(id)
    }
  }

  /**
   * Hand the navigation grid the atrium's current footprint.
   *
   * The blocking radius is the building's bounding radius trimmed a little, plus the
   * bot's own width. The trim matters: the bounding radius already over-covers
   * anything that is not round, and blocking the full extent closes the gaps between a ring
   * of buildings, which is exactly where the crew needs to walk.
   */
  _rebuildNavigation() {
    const obstacles = []
    for (const entry of this.buildings.values()) {
      if (entry.retiring) continue
      const p = entry.mesh.position
      const desk = entry.mesh.userData.obstacle
      if (desk) {
        // A desk blocks a circle pulled back behind it, so the spot in front stays free for
        // its bot to stand at.
        const ry = entry.mesh.rotation.y
        const x = p.x - Math.sin(ry) * desk.back
        const z = p.z - Math.cos(ry) * desk.back
        obstacles.push({ x, z, r: desk.r + TRAVEL_RADIUS, keep: desk.r + AGENT_RADIUS })
        continue
      }
      const footprint = entry.mesh.userData.footprint || 1.2
      const r = footprint * 0.8 + TRAVEL_RADIUS
      // The grid blocks less than the whole footprint so the gaps stay walkable; the
      // keep radius is where the crew is actually held to — see `Navigation.repel`.
      obstacles.push({ x: p.x, z: p.z, r, keep: footprint * 0.92 + AGENT_RADIUS })
    }
    // Ground clutter counts too. A crate is only knee-high, but a bot walking
    // straight through one is exactly as wrong as one walking through a habitat.
    for (const plot of this.plotOrder) {
      for (const spot of plot.clutterSpots || []) {
        obstacles.push({ x: plot.center.x + spot.x, z: plot.center.z + spot.z, r: spot.r + TRAVEL_RADIUS, keep: spot.r + AGENT_RADIUS + 0.1 })
      }
    }

    // The open floor's trees, benches, lamps and sculptures.
    for (const o of this.decor?.obstacles || []) {
      obstacles.push({ x: o.x, z: o.z, r: o.r + TRAVEL_RADIUS, keep: o.r + AGENT_RADIUS })
    }
    // The commons' furniture.
    const desk = receptionPosition()
    for (const o of this.commons?.obstacles || []) {
      obstacles.push({ x: desk.x + o.x, z: desk.z + o.z, r: o.r + TRAVEL_RADIUS, keep: o.r + AGENT_RADIUS })
    }
    // The reception's centrepiece planters; the steps around them are walkable.
    obstacles.push({ x: desk.x, z: desk.z, r: 1.2 + AGENT_RADIUS })
    this.nav.rebuild(obstacles)
  }

  /** The plot under a world point. On a hex lattice the nearest cell centre is the cell. */
  plotAt(x, z) {
    let best = null
    let bestD = Infinity
    for (const plot of this.plotOrder) {
      for (const local of plot.localCenters) {
        const dx = x - (plot.center.x + local.x)
        const dz = z - (plot.center.z + local.z)
        const d = dx * dx + dz * dz
        if (d < bestD) {
          bestD = d
          best = plot
        }
      }
    }
    return bestD <= PLOT_CELL * PLOT_CELL ? best : null
  }

  /**
   * The plot whose name plate is under the cursor.
   *
   * Plates are billboarded in the vertex shader — a CPU raycast against the quad would test
   * the geometry as authored, which is not where it ends up on screen. So this repeats the
   * shader's own maths instead: the plate sits at its anchor in view space and spans
   * `half * (0.55 + dist * 0.03)`, which projects to `half * k * P / dist` in NDC.
   *
   * Opacity is deliberately not consulted. A quiet project's plate is invisible until it is
   * pointed at, and it is this hit test that decides it is being pointed at.
   */
  pickLabel(ndcX, ndcY) {
    const view = this._labelView || (this._labelView = new THREE.Vector3())
    const p = this.camera.projectionMatrix.elements
    let best = null
    let bestDist = Infinity
    for (const plot of this.plotOrder) {
      const label = plot.label
      if (!label) continue
      if (label.userData.physical) {
        if (!this.uiVisible || !this.settings.get('showLabels')) continue
        const ray = this._signRay || (this._signRay = new THREE.Raycaster())
        ray.layers.set(1)
        ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
        label.updateMatrixWorld(true)
        const hit = ray.intersectObject(label)[0]
        if (hit && hit.distance < bestDist) { bestDist = hit.distance; best = plot }
        continue
      }
      // Bent like the shader bends the anchor, so a far plate is hit where it is drawn.
      const dist = -bendPoint(view.copy(label.position)).applyMatrix4(this.camera.matrixWorldInverse).z
      if (dist <= 0.01 || dist >= bestDist) continue
      const geo = label.geometry.parameters
      const k = 0.55 + dist * 0.03
      const cx = (view.x * p[0]) / dist
      const cy = (view.y * p[5]) / dist
      if (Math.abs(ndcX - cx) > ((geo.width / 2) * k * p[0]) / dist) continue
      if (Math.abs(ndcY - cy) > ((geo.height / 2) * k * p[5]) / dist) continue
      bestDist = dist
      best = plot
    }
    return best
  }

  /**
   * Take the zone layout out of the atrium file. Cells arrive as `[q, r]` pairs from a file
   * a person can edit, so anything that is not a pair of whole numbers is dropped rather
   * than trusted — a bad entry would put a zone on a cell that does not exist.
   */
  restoreLayout(saved) {
    const clean = new Map()
    for (const [name, cells] of Object.entries(saved || {})) {
      if (!Array.isArray(cells)) continue
      const list = []
      for (const cell of cells) {
        const q = Array.isArray(cell) ? cell[0] : cell?.q
        const r = Array.isArray(cell) ? cell[1] : cell?.r
        if (Number.isInteger(q) && Number.isInteger(r)) list.push({ q, r })
      }
      if (list.length) clean.set(String(name), list)
    }
    this.plotCells = clean
  }

  /** The same, on the way out. */
  layoutForSave() {
    const out = {}
    for (const [name, cells] of this.plotCells) out[name] = cells.map((c) => [c.q, c.r])
    return out
  }

  setHoveredPlot(plot) {
    this.hoveredPlot = plot || null
  }

  /** The zones actually on the map, name → cells — what a drag validates against. */
  visibleLayout() {
    const out = new Map()
    for (const [name, plot] of this.plots) out.set(name, plot.cells)
    return out
  }

  /**
   * Translate one zone's remembered footprint. Deliberately nothing but the bookkeeping:
   * the caller re-runs the roster pass, and the signature diff in `_syncPlots` is what
   * tears the old plot down and raises it on the new ground — moving the group directly
   * would leave every world coordinate baked into it (centres, slots, label) pointing at
   * where the zone used to be.
   */
  movePlot(name, dq, dr) {
    const cells = this.plotCells.get(name)
    if (!cells || (!dq && !dr)) return
    this.plotCells.set(name, translateCells(cells, dq, dr))
  }

  /**
   * Adopt a whole planned layout at once.
   *
   * A drag no longer moves only the zone under the cursor: carrying one out from between its
   * neighbours strands whatever it was bridging, and `planMove` slides those back into contact
   * rather than refusing the drop. That arrives as a layout for several zones, and it has to
   * land in one write — applied one zone at a time, the intermediate states are fragmented
   * atriums, and any roster pass that ran between them would throw the layout memory away and
   * re-seed the whole map, which is the exact jump the drag exists to prevent.
   *
   * Bookkeeping only, like `movePlot`: the caller re-runs the roster pass, and the signature
   * diff in `_syncPlots` raises each moved zone on its new ground.
   */
  applyLayout(layout) {
    if (!layout) return
    for (const [name, cells] of layout) {
      if (this.plotCells.has(name)) this.plotCells.set(name, cells)
    }
  }

  /**
   * Cosmetic lift while a zone is being dragged. Safe to fake with a raw y-offset because
   * nothing consults it — the real move is a rebuild on drop, and a cancelled drag sets it
   * back to zero. Buildings ride along by position: they live in the world group, not the
   * plot's, so raising the group alone would leave them standing on air.
   */
  setPlotLift(name, dy) {
    const plot = this.plots.get(name)
    if (!plot) return
    plot.group.position.y = dy
    if (plot.label) plot.label.position.y = (plot.label.userData.baseY ?? 3.2) + dy
    const faded = dy > 0
    plot.group.traverse((o) => {
      if (!o.isMesh) return
      o.userData.baseOpacity ??= o.material.opacity
      o.userData.baseTransparent ??= o.material.transparent
      o.material.transparent = faded || o.userData.baseTransparent
      o.material.opacity = o.userData.baseOpacity * (faded ? 0.55 : 1)
    })
    for (const entry of this.buildings.values()) {
      if (entry.plot === name) entry.mesh.position.y = DECK_TOP + dy
    }
  }

  /**
   * Names fade in for the plots that have something going on, and for whichever one you are
   * pointing at. Everywhere else the atrium stays unlabelled.
   */
  _updateLabels(dt) {
    const show = this.uiVisible && this.settings.get('showLabels')
    for (const plot of this.plotOrder) {
      const label = plot.label
      if (!label) continue
      const wanted = show ? 1 : 0
      const next = THREE.MathUtils.damp(label.material.opacity, wanted, 9, dt)
      label.material.opacity = next
      label.visible = next > 0.01
    }
  }

  /** A spot on the plot, moved to the nearest clear ground if something stands on it. */
  _clearSpot(plot, spot) {
    const site = new THREE.Vector3(spot.x, 0, spot.z)
    if (this.nav && (this.nav.isBlocked(site.x, site.z) || this.nav.insideKeep(site.x, site.z))) {
      const free = this.nav.nearestClear(site.x, site.z, 2, (x, z) => plot.containsWorld(x, z))
      if (free) site.set(free.x, 0, free.z)
    }
    return site
  }

  /**
   * Where the bot goes at its desk: into the chair while it works, and just behind the
   * chair for everything else — waiting on you, stuck, celebrating or dozing.
   */
  _workSite(plot, entry, index, status = 'working') {
    const b = entry.mesh.position
    // A desk is worked from the front, at the screens.
    if (entry.mesh.userData.stand) {
      const ry = entry.mesh.rotation.y
      const d = status === 'working' ? entry.mesh.userData.stand : entry.mesh.userData.behind ?? entry.mesh.userData.stand
      return this._clearSpot(plot, { x: b.x + Math.sin(ry) * d, z: b.z + Math.cos(ry) * d })
    }
    // Outward from the *middle* of the zone rather than from its root tile: the root sits
    // on one edge of a grown blob, and standing spots measured from there all point the
    // same way instead of fanning around the buildings.
    const middle = plot.middle || plot.center
    const dx = b.x - middle.x
    const dz = b.z - middle.z
    const len = Math.hypot(dx, dz)
    // Buildings in the middle of a plot have no outward direction, so fan those out by index.
    const a = len > 0.2 ? Math.atan2(dz, dx) : (index * 2.4) % (Math.PI * 2)
    // Clear of the building's *own* footprint rather than a fixed 2.35: a big habitat blocks
    // more ground than a small one, and a standing spot inside that radius is a spot the
    // crew can never actually reach — it walks at the wall for as long as the thread lives.
    const blocked = (entry.mesh.userData.footprint || 1.2) * 0.92 + AGENT_RADIUS
    const stand = Math.max(2.35, blocked + 0.5)
    let site = new THREE.Vector3(b.x + Math.cos(a) * stand, 0, b.z + Math.sin(a) * stand)
    // Outward points straight off the zone for a building on its edge, and a bot
    // standing in the neighbouring repo's yard reads as belonging to that repo. The inside
    // of its own plot is always the better answer when the outside is somebody else's.
    const onPlot = (v) => {
      const cell = worldToHex(v.x, v.z)
      return plot.cellKeys.has(`${cell.q},${cell.r}`)
    }
    if (!onPlot(site)) {
      const inward = new THREE.Vector3(b.x - Math.cos(a) * stand, 0, b.z - Math.sin(a) * stand)
      if (onPlot(inward)) site = inward
    }
    // Pick against the complete, current map, including scaffolds about to rise. A grid
    // cell alone is insufficient: it can still be inside a building's keep-out radius.
    const free = this.nav?.nearestClear(site.x, site.z, PLOT_CELL, (x, z) => {
      const cell = worldToHex(x, z)
      return plot.cellKeys.has(`${cell.q},${cell.r}`)
    }) || this.nav?.nearestClear(site.x, site.z, PLOT_CELL * 2)
    if (free) site.set(free.x, 0, free.z)
    return site
  }

  // ── per-frame ───────────────────────────────────────────────────────────────────────

  update(dt, elapsed, focus) {
    if (focus) this.sky.setFocus(focus)
    this.sky.update(dt, elapsed, this.camera)

    const night = this.sky.nightFactor ?? 0
    workstationUniforms.uNight.value = night
    // One write turns every rotor in the atrium.
    workstationUniforms.uTime.value = elapsed

    this._growBuildings(dt)
    this.bots.update(dt, elapsed)
    this.bots.updateRings(elapsed)
    this.indicators.update(this.bots.agents, elapsed, (a) => this._badgeFor(a))
    this._emit(dt, elapsed)
    this._emitMotes(dt, night)
    // Glowing motes in the style's colour, drifting up around whatever you are looking at.
    if (focus) {
      const m = this._moteColor || (this._moteColor = new THREE.Color())
      m.set(this.style.motes ?? 0xffffff).multiplyScalar(1.6)
      this._moteWeather = [{ kind: 'motes', rate: 1, color: [m.r, m.g, m.b] }]
      this.particles.ambient(dt, { position: focus }, { weather: this._moteWeather }, night, (x, z) => this.surfaceAt(x, z))
    }
    this.particles.update(dt)
    this.fauna.update(dt, elapsed, this.camera, night, this._faunaHooks || (this._faunaHooks = {
      ripple: () => {},
      sound: (name, x, y, z) => this.onSound?.(name, x, y, z),
    }))
    this.commons?.update(elapsed, this.settings.get('reducedMotion'))
    this._updatePlots(night, elapsed)
    this._updateLabels(dt)
    this.reflections.update(dt, focus || this.sky.focus, this.camera)
  }

  _growBuildings(dt) {
    for (const [id, entry] of this.buildings) {
      // A running thread's site creeps upward while you watch it.
      if (!entry.retiring && this._isLive(id)) entry.target = Math.min(1, entry.target + LIVE_GROWTH * dt)
      const next = THREE.MathUtils.damp(entry.progress, entry.target, 1.8, dt)
      if (Math.abs(next - entry.progress) > 0.0005) {
        entry.progress = next
        entry.mesh.userData.setProgress(next)
      }
      if (entry.retiring && entry.progress <= 0.02) this._removeBuilding(id, entry)
    }
  }

  _isLive(id) {
    const thread = this.threads.get(id)
    return Boolean(thread && thread.running)
  }

  /** A site somebody is standing at: running, or stopped waiting on you. */
  _isActive(id) {
    const thread = this.threads.get(id)
    return Boolean(thread && (thread.running || thread.unread || thread.hasError))
  }

  _badgeFor(agent) {
    if (agent.state === 'spawning') return BADGE.spawning
    if (agent.state === 'leaving') return BADGE.leaving
    // A badge belongs to the *thread*, not to the spot: a bot that has to walk —
    // shoved off its mark by a neighbour, re-routed round a new building — is still the one
    // waiting on you, and the symbol that says so must not blink out for the trip.
    return BADGE_FOR[agent.status] ?? BADGE.none
  }

  /** Particle emission, driven by what each bot is doing. */
  _emit(dt, elapsed) {
    if (!this.particles.enabled) return
    const full = this.settings.get('particles') === 'full'

    for (const agent of this.bots.agents) {
      if (agent.scale < 0.5) continue
      // What this one is standing on, which on a plot is the deck rather than the terrain
      // under it. Everything thrown off a bot has to land back on the same surface.
      const ground = agent.groundY || 0

      // A busy desk gives off the odd bright fleck of "output", rising off its screens.
      if (agent.state === 'at-site' && agent.status === 'working' && agent.anchor && Math.random() < dt * 1.2) {
        const c = this._c.set(0x7dffb0).multiplyScalar(1.8)
        this.particles.mote(
          agent.anchor.x + (Math.random() - 0.5) * 0.7,
          agent.anchor.y + 1.45 + Math.random() * 0.2,
          agent.anchor.z + (Math.random() - 0.5) * 0.7,
          c, 0.045, 2.5
        )
      }

      if (agent.state === 'at-site' && agent.status === 'celebrating' && agent.hop > 0.18 && !agent._cheered) {
        agent._cheered = true
        this.particles.cheer(agent.pos.x, agent.pos.y, agent.pos.z, this._c.set(0xffc86a), ground)
      } else if (agent.hop < 0.05) {
        agent._cheered = false
      }

      if (agent.state === 'at-site' && agent.status === 'sleeping' && Math.random() < dt * 0.35) {
        this.particles.snooze(agent.pos.x + 0.2, agent.pos.y + 1.05, agent.pos.z + 0.15)
      }

      // Boot dust, on the footfall.
      if (full && (agent.walkAmp || 0) > 0.4) {
        const step = Math.sin(agent.phase)
        if (step < -0.9 && !agent._stepped) {
          agent._stepped = true
          this.particles.step(agent.pos.x, agent.pos.y, agent.pos.z, this._dustTint, ground)
        } else if (step > 0) {
          agent._stepped = false
        }
      }

    }
  }

  /**
   * Light that lives *on* things. Every building near the view sheds a slow mote now and
   * then — warm by day, its room's accent after hours, when the windows are lit — and the
   * reception draws a few of its own. These say "this place is alive".
   */
  _emitMotes(dt, night) {
    if (!this.particles.enabled) return
    const full = this.settings.get('particles') === 'full'
    const focus = this.sky.focus
    const c = this._c
    // Buildings within reach of the view. Everything else is off screen or too far to read.
    const reach = full ? 48 : 34
    const reach2 = reach * reach
    for (const [id, entry] of this.buildings) {
      if (entry.retiring || entry.progress < 0.5) continue
      const p = entry.mesh.position
      const dx = p.x - focus.x
      const dz = p.z - focus.z
      if (dx * dx + dz * dz > reach2) continue
      const live = this._isActive(id)
      // A live site glows more; a dark one still breathes.
      const rate = (live ? 0.9 : 0.28) * (full ? 1 : 0.55) * (0.6 + night * 0.9)
      if (Math.random() < dt * rate) {
        const r = 0.9 + Math.random() * 1.4
        const a = Math.random() * Math.PI * 2
        if (night > 0.35) c.set(entry.accent).lerp(this._c2.set(0xfff0c0), 0.35).multiplyScalar(2.2)
        else c.set(0xfff2d0).multiplyScalar(1.6)
        this.particles.mote(p.x + Math.cos(a) * r, p.y + 0.4 + Math.random() * 1.8, p.z + Math.sin(a) * r, c, 0.055, 4)
      }
    }
    // Reception draws a slow halo of its own, brighter after dark.
    const desk = this.reception.position
    const sdx = desk.x - focus.x
    const sdz = desk.z - focus.z
    if (sdx * sdx + sdz * sdz < reach2 && Math.random() < dt * (0.8 + night * 1.4)) {
      const a = Math.random() * Math.PI * 2
      const r = 2 + Math.random() * 3
      c.setRGB(0.7, 1.4, 2.4)
      this.particles.mote(desk.x + Math.cos(a) * r, desk.y + 0.3 + Math.random() * 5, desk.z + Math.sin(a) * r, c, 0.06, 5)
    }
  }

  _updatePlots(night, elapsed) {
    const urgent = this.urgentPlots
    for (const plot of this.plotOrder) plot.setNight(night, urgent?.has(plot.id) ?? false, elapsed)
  }

  // ── interaction ─────────────────────────────────────────────────────────────────────

  pick(ndcX, ndcY, aspect) {
    return this.bots.pick(this.camera, ndcX, ndcY, aspect)
  }

  /**
   * Which HQ tab the pointer is on, if any: a screen, the trophy cabinet, Atlas or the status
   * board. Bounds are bent like the renderer bends them. A screen wins over anything in front
   * of it, since Atlas's desk sits right under the rank screen.
   */
  pickOffice(ndcX, ndcY) {
    const ray = this._officeRay || (this._officeRay = new THREE.Raycaster())
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const box = new THREE.Box3(), bentBox = new THREE.Box3(), point = new THREE.Vector3(), hit = new THREE.Vector3()
    let best = null
    for (const target of this.commons?.targets || []) {
      target.mesh.updateWorldMatrix(true, true)
      box.setFromObject(target.mesh); bentBox.makeEmpty()
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) bentBox.expandByPoint(bendPoint(point.set(x, y, z)))
      if (!ray.ray.intersectBox(bentBox, hit)) continue
      const distance = hit.distanceTo(ray.ray.origin)
      const priority = target.priority || 0
      if (!best || priority > best.priority || (priority === best.priority && distance < best.distance)) best = { priority, distance, action: target.action }
    }
    return best?.action ?? null
  }

  setOfficeData(data) {
    this.officeData = data
    this.commons?.setOffice(data.board || {})
    this.commons?.setStats(this.stats)
    for (const plot of this.plotOrder || []) plot.label?.userData.setHealth?.((data.health || []).find(h => h.project === plot.name))
  }

  agentFor(id) {
    return this.bots.byId.get(id)
  }

  setUiVisible(visible) {
    this.uiVisible = visible
    this._syncLabels()
  }

  _syncLabels() {
    // Visibility is per-label now; the group only ever hides everything at once.
    this.labelGroup.visible = true
  }

  dispose() {
    this.reflections.dispose()
    this.sky.dispose()
    this.fauna.dispose()
    this.bots.dispose()
    this.indicators.dispose()
    this.particles.dispose()
    disposeTree(this.worldGroup)
    disposeTree(this.plotGroup)
    disposeTree(this.labelGroup)
    this.scene.remove(this.worldGroup, this.plotGroup, this.labelGroup)
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints) return
    o.geometry?.dispose()
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose())
    else o.material?.dispose()
  })
}
