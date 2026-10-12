import * as THREE from 'three'
import { createOfficePlanters, createGlassRooms, createSignMount, planterSpots, createCoffeeCorner, COFFEE_RADIUS } from './office.js'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { withCurve } from '../core/curve.js'
import { OVERLAY_LAYER } from '../core/engine.js'
import { FLOOR_Y } from './offices.js'
import { HEX_DIRS, RECEPTION_CELL, ORIGIN, POOL_RINGS, cellKey as key, hexDistance, isConnected } from './plot-move.js'

/**
 * Rooms — the glass-walled studios on the office floor, one per repo.
 *
 * Plots sit on a hexagonal lattice, and a project claims **as many cells as it has threads
 * to house**: a repo with forty sessions sprawls across six tiles, a one-off gets a single
 * tile. The cells tile exactly, so a multi-cell plot reads as one continuous zone, and the
 * accent border is drawn only on the edges that actually face something else — internal
 * seams between a project's own cells get no border at all.
 *
 * Cells are handed out in a spiral from the middle, biggest project first, so the busiest
 * repo lands where you are already looking and quiet ones ring the edge.
 */

export const PLOT_PALETTE = [
  0xc96442, 0x4f9a63, 0x4f7ec9, 0xb8942a, 0x8b5cc9, 0xc94f8b,
  0x3fa8a0, 0xc97f4f, 0x6f8f4f, 0x5c7fc9, 0xc95c5c, 0x7f6fc9,
]

/**
 * Lattice pitch, centre to corner. Cells are laid out at this size but a room's floor is
 * the smaller TILE, so a walkway of about 3.5 units runs between neighbouring rooms — the
 * office reads as open plan rather than as one honeycomb. Cells of the same room are joined
 * across that gap by a bridge of floor, so a big repo is still one room.
 */
const CELL = 11.4
/** Exported for hit-testing: on a hex lattice the nearest cell centre *is* the containing cell. */
export const PLOT_CELL = CELL
/** A room cell's own floor, centre to corner. */
const TILE = 8.4
export const PLOT_TILE = TILE
/** Top face of a room's floor — what every building, planter and pair of boots stands on. */
export const DECK_TOP = 0.45
/** How far the slab reaches below the room's top face — past the open floor under it. */
const DECK_SKIRT = 0.4
/** The whole prism: the rim you can see, plus the skirt buried under it. */
const DECK_HEIGHT = DECK_TOP + DECK_SKIRT
/**
 * Building slots per cell: one in the middle and six around it. The root cell's middle is the
 * room's coffee corner instead, so a room seats one fewer than its cells would suggest.
 */
const SLOTS_PER_CELL = 7
const MAX_CELLS = 9

/**
 * Edge j of a flat-top hexagon runs between the corners at 60j° and 60(j+1)°, so its
 * midpoint faces 60j+30°. This maps that edge to the neighbour sitting across it.
 */
const EDGE_TO_DIR = [0, 5, 4, 3, 2, 1]

/** Flat-top axial hex → world. */
export function hexToWorld(q, r, size = CELL) {
  return { x: size * 1.5 * q, z: size * Math.sqrt(3) * (r + q / 2) }
}

/**
 * The inverse: which cell a world point falls in. Exact rather than nearest-centre, because
 * it decides whether something is standing on a plot's raised deck or on bare ground, and a
 * radius test would put a bot on a deck it is not actually over.
 */
export function worldToHex(x, z, size = CELL) {
  const q = x / (size * 1.5)
  const r = z / (size * Math.sqrt(3)) - q / 2
  return cubeRound(q, r)
}

/** Round fractional axial coordinates to the cell that actually contains the point. */
function cubeRound(q, r) {
  const y = -q - r
  let rq = Math.round(q)
  let rr = Math.round(r)
  const ry = Math.round(y)
  const dq = Math.abs(rq - q)
  const dr = Math.abs(rr - r)
  const dy = Math.abs(ry - y)
  // Whichever axis drifted furthest is the one recomputed from the other two.
  if (dq > dr && dq > dy) rq = -rr - ry
  else if (dr > dy) rr = -rq - ry
  return { q: rq, r: rr }
}

function hexRing(radius) {
  if (radius === 0) return [{ q: 0, r: 0 }]
  const out = []
  let q = HEX_DIRS[4][0] * radius
  let r = HEX_DIRS[4][1] * radius
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < radius; j++) {
      out.push({ q, r })
      q += HEX_DIRS[i][0]
      r += HEX_DIRS[i][1]
    }
  }
  return out
}

const cellsNeeded = (threadCount) =>
  Math.max(1, Math.min(MAX_CELLS, Math.ceil((threadCount + 1) / SLOTS_PER_CELL)))

/**
 * Hand out cells to projects, keeping every zone exactly where it already is.
 *
 * This used to be a pure function of the size list, and that was the bug: one thread
 * appearing anywhere changed the order, the order decided the cells, and the whole atrium
 * re-laid itself out. A zone you were watching could jump to the far side of the map
 * because a *different* repo gained a session, which makes the place impossible to learn.
 *
 * So the previous layout is an input. A zone that still needs the same number of cells
 * keeps precisely the cells it had; one that grew keeps them and claims neighbours; one
 * that shrank drops the cells it claimed most recently. Only a repo that has never been
 * placed is placed at all, and it takes the innermost cells still free — which is what
 * keeps the busy middle busy.
 *
 * Each list is ordered root-first and growth appends, so a shrink is a slice, and
 * grow-then-shrink puts a zone back in exactly the shape it started in.
 *
 * Contiguity still comes from a flood fill: slicing runs out of a hex spiral looks like it
 * would work and does not, because the last cell of one ring and the first of the next sit
 * on opposite sides of the atrium.
 *
 * @param projects [{ id, size }], biggest first — the order only decides who gets the
 *   innermost seed among repos that are *new*.
 * @param previous Map of id → cells from the last pass (or a saved atrium file).
 * @returns Map of id → cells.
 */
export function allocateCells(projects, previous = new Map()) {
  const laid = layOut(projects, previous)
  // Remembering where a zone sat is worth a great deal, right up until it leaves the atrium
  // as scattered islands. Then the memory is describing a map that no longer exists, and
  // starting over — compact, from the middle, the way a first run does it — is the lesser
  // upheaval. It only happens when the alternative is visibly broken.
  return isConnected(laid) ? laid : layOut(projects, new Map())
}

function layOut(projects, previous) {
  const reserved = key(RECEPTION_CELL.q, RECEPTION_CELL.r)
  // Shrinking has hysteresis. A zone sitting exactly on a cell boundary would otherwise
  // hand a tile back the moment one thread is archived and claim it again when the next
  // one starts — and every hand-back rebuilds the plot and walks its whole crew. A tile is
  // only returned once the repo has lost a few threads past the line.
  const wanted = projects.map((p) => {
    const before = previous.get(p.id)
    let want = cellsNeeded(p.size)
    if (before && before.length > want) want = Math.min(before.length, cellsNeeded(p.size + 3))
    return { id: p.id, want }
  })
  const total = wanted.reduce((n, w) => n + w.want, 0)

  // Spiral order decides where a *new* project settles. The pool runs past what is needed
  // so there is always somewhere to grow into.
  const pool = []
  const free = new Set()
  // The pool has to reach every cell anybody *remembers*, not merely as far as today's
  // atrium needs. Sized from `total` alone, a zone that has sat out at ring five for a week
  // finds its own cell missing from `free` the moment the atrium shrinks, cannot reclaim
  // it, and is re-seeded in the middle — which is exactly the jump this function exists to
  // prevent, arriving by the back door.
  let farthest = 0
  for (const project of projects) {
    for (const cell of previous.get(project.id) || []) farthest = Math.max(farthest, hexDistance(cell, ORIGIN))
  }
  for (let ring = 0; (pool.length < total + 30 || ring <= farthest) && ring < POOL_RINGS; ring++) {
    for (const cell of hexRing(ring)) {
      const k = key(cell.q, cell.r)
      if (k === reserved) continue
      pool.push(cell)
      free.add(k)
    }
  }

  const held = new Map()
  for (const { id, want } of wanted) {
    const before = previous.get(id)
    if (!before || !before.length) continue
    // The root cell is the whole point — it is the zone's origin, and everything standing
    // on the zone is placed relative to it. A blob that loses its root has *moved*, so if
    // the root is gone this project is seeded afresh rather than quietly re-rooted onto
    // whichever of its old cells happens to still be free.
    if (!free.has(key(before[0].q, before[0].r))) continue
    const keep = []
    for (const cell of before) {
      if (keep.length >= want) break // shrunk: whatever it claimed last is what it gives up
      const k = key(cell.q, cell.r)
      if (!free.has(k)) continue // reception's cell, or a duplicate in a hand-edited file
      free.delete(k)
      keep.push({ q: cell.q, r: cell.r })
    }
    if (keep.length) held.set(id, keep)
  }

  const out = new Map()
  // Anybody who was already here grows first, so a newcomer cannot take the cell a zone
  // was about to expand into while its own seed is still free.
  for (const { id, want } of wanted) {
    const cells = held.get(id)
    if (!cells) continue
    growBlob(cells, want, free)
    out.set(id, cells)
  }

  for (const { id, want } of wanted) {
    if (out.has(id)) continue
    const seed = pool.find((c) => free.has(key(c.q, c.r)))
    if (!seed) {
      out.set(id, [])
      continue
    }
    free.delete(key(seed.q, seed.r))
    const cells = [{ q: seed.q, r: seed.r }]
    growBlob(cells, want, free)
    out.set(id, cells)
  }
  return out
}

/** Claim free neighbours until the blob is big enough, hugging its root cell first. */
function growBlob(cells, want, free) {
  const root = cells[0]
  while (cells.length < want) {
    let best = null
    let bestScore = Infinity
    for (const c of cells) {
      for (const [dq, dr] of HEX_DIRS) {
        const n = { q: c.q + dq, r: c.r + dr }
        if (!free.has(key(n.q, n.r))) continue
        // Hug the root first, then the middle of the atrium, so blobs come out compact.
        const score = hexDistance(n, root) * 100 + hexDistance(n, ORIGIN)
        if (score < bestScore) {
          bestScore = score
          best = n
        }
      }
    }
    if (!best) break // completely hemmed in by neighbours
    free.delete(key(best.q, best.r))
    cells.push(best)
  }
}

export const receptionPosition = () => {
  const { x, z } = hexToWorld(RECEPTION_CELL.q, RECEPTION_CELL.r)
  return new THREE.Vector3(x, 0, z)
}

/** How far in front of reception's centre the door is: the foot of its steps, facing the floor. */
const DOOR_REACH = 6.7

/**
 * Where bots appear when a thread does and vanish when it is archived: just off reception's
 * front step, on the side facing the middle of the office.
 */
export function entranceDoor(out = new THREE.Vector3()) {
  const c = receptionPosition()
  const len = Math.hypot(c.x, c.z) || 1
  return out.set(c.x - (c.x / len) * DOOR_REACH, FLOOR_Y, c.z - (c.z / len) * DOOR_REACH)
}

/**
 * Three builds a 6-sided cylinder with its first vertex on +Z, which puts its corners at
 * 30°, 90°, 150°… — a *pointy-top* hexagon. The lattice and the edge-to-neighbour mapping
 * assume a **flat-top** hexagon, so every hexagonal prism is turned by this much to agree.
 */
const HEX_PHASE = Math.PI / 6

function hexPrism(radius, height) {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 6)
  geo.rotateY(HEX_PHASE)
  return geo
}

/** Distance between facing edges of two neighbouring cells. */
const WALKWAY = Math.sqrt(3) * (CELL - TILE)

// ── room mesh ─────────────────────────────────────────────────────────────────────────

export class Plot {
  constructor({ id, name, index, cells, accent, style }) {
    this.id = id
    this.name = name
    this.index = index
    this.cells = cells
    this.accent = accent
    this.style = style
    this.cellKeys = new Set(cells.map((c) => key(c.q, c.r)))

    // The plot's origin is its **root** tile — the one it was seeded on and never gives up
    // — rather than the centroid of whatever cells it holds this minute. A room that gains
    // a cell must not drag its buildings, its crew and its name sideways.
    const origin = hexToWorld(cells[0].q, cells[0].r)
    let sx = 0
    let sz = 0
    this.localCenters = cells.map((c) => {
      const { x, z } = hexToWorld(c.q, c.r)
      sx += x
      sz += z
      return { x: x - origin.x, z: z - origin.z }
    })
    this.center = new THREE.Vector3(origin.x, 0, origin.z)
    // Where the camera aims: the middle of the whole room, so an L-shaped one is framed as
    // one place rather than from its corner.
    this.middle = new THREE.Vector3(sx / cells.length, 0, sz / cells.length)
    this.radius = CELL * Math.sqrt(cells.length)

    this.group = new THREE.Group()
    this.group.position.copy(this.center)
    this.group.name = `plot:${id}`

    this._findJoins()
    this._buildDeck()
    this._buildBorder()
    this.slots = this._buildSlots()
    this._buildPlanters()
    this._buildCoffee()
    this._buildRooms()
  }

  /**
   * Where this room's cells meet: a bridge across the walkway for every pair of neighbouring
   * cells, and a cap over the little triangle left where three of them meet. Kept as shapes
   * as well as geometry, because "is this point on the room's floor" has to agree with what
   * is drawn — a bot crossing a bridge must not drop to the open floor and back.
   */
  _findJoins() {
    this.bridges = []
    this.caps = []
    const capKeys = new Set()
    this.cells.forEach((cell, i) => {
      const c = this.localCenters[i]
      for (let edge = 0; edge < 6; edge++) {
        const [dq, dr] = HEX_DIRS[EDGE_TO_DIR[edge]]
        const other = key(cell.q + dq, cell.r + dr)
        if (!this.cellKeys.has(other)) continue
        const angle = edge * Math.PI / 3 + Math.PI / 6
        if (key(cell.q, cell.r) < other) {
          const reach = CELL * Math.cos(Math.PI / 6)
          this.bridges.push({ x: c.x + Math.cos(angle) * reach, z: c.z + Math.sin(angle) * reach, angle, depth: WALKWAY + 0.6, length: TILE })
        }
        // The corner shared by this edge and the next one, if that neighbour is ours too.
        const [nq, nr] = HEX_DIRS[EDGE_TO_DIR[(edge + 1) % 6]]
        if (!this.cellKeys.has(key(cell.q + nq, cell.r + nr))) continue
        const a = (edge + 1) * Math.PI / 3
        const x = c.x + Math.cos(a) * CELL
        const z = c.z + Math.sin(a) * CELL
        const k = `${x.toFixed(2)},${z.toFixed(2)}`
        if (capKeys.has(k)) continue
        capKeys.add(k)
        this.caps.push({ x, z, r: (CELL - TILE) * 1.25 })
      }
    })
  }

  _buildRooms() {
    const edges = []
    const radius = TILE * Math.cos(Math.PI / 6) - 0.06
    this.cells.forEach((cell, i) => {
      const center = this.localCenters[i]
      for (let edge = 0; edge < 6; edge++) {
        const [dq, dr] = HEX_DIRS[EDGE_TO_DIR[edge]]
        if (this.cellKeys.has(key(cell.q + dq, cell.r + dr))) continue
        const angle = edge * Math.PI / 3 + Math.PI / 6
        edges.push({ x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius, angle, length: radius / Math.cos(Math.PI / 6) })
      }
    })
    this.rooms = createGlassRooms(edges, this.accent, DECK_TOP, this.style)
    this.group.add(this.rooms)
    this.clutterSpots.push(...this.rooms.userData.obstacles)
    // A camera-facing exterior edge near the root carries the sign; it stays attached after a drag.
    this.signEdge = edges.reduce((best, edge) => {
      const score = e => Math.cos(e.angle - Math.PI / 6) * 20 - Math.hypot(e.x, e.z) * 0.1
      return score(edge) > score(best) ? edge : best
    })
  }

  attachOfficeLabel(label) {
    const mount = createSignMount(this.signEdge, label.geometry.parameters.width, DECK_TOP, this.style)
    this.group.add(mount)
    label.position.copy(mount.userData.anchor).add(this.center)
    label.rotation.y = mount.userData.yaw
    label.userData.baseY = label.position.y
    this.signMount = mount
  }

  /** One merged slab: a hexagon per cell, plus the bridges and caps that join them. */
  _buildDeck() {
    const parts = this.localCenters.map(({ x, z }) => {
      const geo = hexPrism(TILE, DECK_HEIGHT)
      geo.translate(x, DECK_TOP - DECK_HEIGHT / 2, z)
      return geo
    })
    for (const b of this.bridges) {
      const geo = new THREE.BoxGeometry(b.depth, DECK_HEIGHT, b.length)
      geo.rotateY(-b.angle)
      geo.translate(b.x, DECK_TOP - DECK_HEIGHT / 2, b.z)
      parts.push(geo)
    }
    for (const c of this.caps) {
      const geo = new THREE.CylinderGeometry(c.r, c.r, DECK_HEIGHT, 18)
      geo.translate(c.x, DECK_TOP - DECK_HEIGHT / 2, c.z)
      parts.push(geo)
    }
    const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g))
    for (const g of flat) g.deleteAttribute('uv')
    const geo = BufferGeometryUtils.mergeGeometries(flat)
    for (const g of new Set([...parts, ...flat])) g.dispose()

    // The room's floor is the open floor lifted toward white and leaning a little toward the
    // repo's own colour — enough to tell rooms apart, not so much that it competes with the work.
    const color = new THREE.Color(this.style.room.base).lerp(new THREE.Color(this.accent), this.style.room.deck)
    this.deck = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0 }))
    this.deck.receiveShadow = true
    this.group.add(this.deck)

    // The light a room spills onto the floor round it, in its own colour: a soft pool under
    // each cell, wider than the room, drawn just above the open floor.
    const halo = this.style.room.halo ?? 0
    if (halo > 0 && typeof document !== 'undefined') {
      const pools = this.localCenters.map(({ x, z }) => {
        const g = new THREE.PlaneGeometry(TILE * 3.1, TILE * 3.1)
        g.rotateX(-Math.PI / 2)
        g.translate(x, FLOOR_Y + 0.015, z)
        return g
      })
      const geoPools = BufferGeometryUtils.mergeGeometries(pools, false)
      pools.forEach((g) => g.dispose())
      const material = new THREE.MeshBasicMaterial({
        map: lightPoolTexture(),
        color: new THREE.Color(this.accent).multiplyScalar(halo),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
      material.onBeforeCompile = (shader) => withCurve(shader)
      this.pool = new THREE.Mesh(geoPools, material)
      this.pool.renderOrder = -1
      this.group.add(this.pool)
    }
  }

  /**
   * The accent kerb, one bar per *outside* edge — skipping shared edges is what makes several
   * cells read as one room. Inset so it lies wholly inside its own cell and sits on the deck
   * rather than in it, so no two surfaces are ever coplanar.
   */
  _buildBorder() {
    const parts = []
    const apothem = TILE * Math.cos(Math.PI / 6)
    const width = 0.32
    const inset = 0.05
    const mid = apothem - inset - width / 2
    const side = mid / Math.cos(Math.PI / 6)

    this.cells.forEach((cell, i) => {
      const { x, z } = this.localCenters[i]
      for (let edge = 0; edge < 6; edge++) {
        const dir = HEX_DIRS[EDGE_TO_DIR[edge]]
        if (this.cellKeys.has(key(cell.q + dir[0], cell.r + dir[1]))) continue
        const angle = (Math.PI / 3) * edge + Math.PI / 6
        const geo = new THREE.BoxGeometry(width, 0.14, side * 1.02)
        geo.rotateY(-angle)
        geo.translate(x + Math.cos(angle) * mid, DECK_TOP + 0.07, z + Math.sin(angle) * mid)
        parts.push(geo)
      }
    })

    if (!parts.length) return
    const geo = BufferGeometryUtils.mergeGeometries(parts)
    parts.forEach((g) => g.dispose())
    this.borderMaterial = new THREE.MeshStandardMaterial({
      color: this.accent,
      emissive: this.accent,
      emissiveIntensity: this.style.room.kerbGlow,
      roughness: 0.55,
      metalness: 0.1,
    })
    this.border = new THREE.Mesh(geo, this.borderMaterial)
    this.border.receiveShadow = true
    this.group.add(this.border)
  }

  /** Planters against the side walls, also handed to navigation so nobody walks through one. */
  _buildPlanters() {
    this.clutter = createOfficePlanters(this.localCenters, TILE, this.style)
    this.clutter.position.y = DECK_TOP
    this.group.add(this.clutter)
    this.clutterSpots = planterSpots(this.localCenters, TILE, this.style).map((p) => ({ ...p, r: 0.3 }))
  }

  /**
   * The coffee corner, in the middle of the root cell: where the room's idle bots take a
   * break. Handed to navigation like the planters, so it is walked round, not through.
   */
  _buildCoffee() {
    const { x, z } = this.localCenters[0]
    this.coffee = { x, z }
    this.coffeeCorner = createCoffeeCorner(this.style, this.accent)
    this.coffeeCorner.position.set(x, DECK_TOP, z)
    this.group.add(this.coffeeCorner)
    this.clutterSpots.push({ x, z, r: COFFEE_RADIUS })
  }

  /**
   * Where idle bot number `index` stands on its break, in world space: rings round the
   * coffee corner, the near ring first, staggered so the outer ring looks between heads.
   */
  breakSpot(index, out = new THREE.Vector3()) {
    const rings = [[COFFEE_RADIUS + 0.85, 7], [COFFEE_RADIUS + 1.7, 12]]
    let i = index % (rings[0][1] + rings[1][1])
    let ring = 0
    if (i >= rings[0][1]) { i -= rings[0][1]; ring = 1 }
    const [r, n] = rings[ring]
    const a = (i / n) * Math.PI * 2 + 0.35 + ring * (Math.PI / n)
    return out.set(this.center.x + this.coffee.x + Math.cos(a) * r, DECK_TOP, this.center.z + this.coffee.z + Math.sin(a) * r)
  }

  /** The coffee corner's middle, in world space: what a bot on its break looks at. */
  coffeeWorld(out = new THREE.Vector3()) {
    return out.set(this.center.x + this.coffee.x, DECK_TOP, this.center.z + this.coffee.z)
  }

  /**
   * Slots, in room-local coordinates: cell centre first, then the ring around it, cell by
   * cell, skipping the root cell's centre, which is the coffee corner. Fixed rather than
   * random, so a session keeps its spot as siblings come and go — a building must never jump
   * because a neighbour was archived.
   */
  _buildSlots() {
    const slots = []
    this.localCenters.forEach(({ x, z }, cell) => {
      if (cell > 0) slots.push({ x, z })
      // Toward the room's corners, not its walls: every wall has a doorway in the middle, and
      // a desk standing square in front of one turns the door into an obstacle course.
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i
        slots.push({ x: x + Math.cos(a) * TILE * 0.58, z: z + Math.sin(a) * TILE * 0.58 })
      }
    })
    return slots
  }

  slotFor(index) {
    return this.slots[index % this.slots.length]
  }

  /**
   * Whether a complete circular footprint fits on the room's floor: on one of its hex cells,
   * or — for a point, which is all walking needs — on a bridge or cap between them.
   */
  containsLocal(x, z, radius = 0) {
    const apothem = TILE * Math.sqrt(3) / 2 - radius
    const onCell = this.localCenters.some((c) => {
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + Math.PI / 6
        if ((x - c.x) * Math.cos(a) + (z - c.z) * Math.sin(a) > apothem) return false
      }
      return true
    })
    if (onCell || radius > 0) return onCell
    for (const b of this.bridges) {
      const dx = x - b.x
      const dz = z - b.z
      const across = dx * Math.cos(b.angle) + dz * Math.sin(b.angle)
      const along = -dx * Math.sin(b.angle) + dz * Math.cos(b.angle)
      if (Math.abs(across) <= b.depth / 2 && Math.abs(along) <= b.length / 2) return true
    }
    return this.caps.some((c) => (x - c.x) ** 2 + (z - c.z) ** 2 <= c.r * c.r)
  }

  containsWorld(x, z, radius = 0) {
    return this.containsLocal(x - this.center.x, z - this.center.z, radius)
  }

  worldSlot(index, out = new THREE.Vector3()) {
    const s = this.slotFor(index)
    return out.set(this.center.x + s.x, DECK_TOP, this.center.z + s.z)
  }

  /** The kerb holds the style's own glow, and pulses when this room holds something urgent. */
  setNight(night, urgent, elapsed) {
    if (!this.borderMaterial) return
    this.borderMaterial.emissiveIntensity =
      this.style.room.kerbGlow + (urgent ? 0.4 + Math.sin(elapsed * 3.4) * 0.32 : 0)
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
  }
}

/** A soft radial falloff, shared by every light pool. */
let poolTexture = null
export function lightPoolTexture() {
  if (poolTexture) return poolTexture
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  poolTexture = new THREE.CanvasTexture(canvas)
  poolTexture.colorSpace = THREE.SRGBColorSpace
  return poolTexture
}

// ── signs ─────────────────────────────────────────────────────────────────────────────

/**
 * A room's name, drawn to a canvas once and mounted on a plate above one of its walls. The
 * plate is in the style's own colours, so it reads on a white floor and a dark one alike.
 */
export function createLabel(text, accent, style, pixelRatio = 4) {
  const fontSize = 34
  const font = `700 ${fontSize}px "Barlow Semi Condensed", ui-sans-serif, system-ui, "Segoe UI", sans-serif`
  const dot = 9
  const gap = 10
  const pad = 14

  const measure = document.createElement('canvas').getContext('2d')
  measure.font = font
  const textWidth = Math.ceil(measure.measureText(text).width)

  const canvas = document.createElement('canvas')
  const w = textWidth + dot + gap + pad * 2
  const h = fontSize + pad * 2 + 20
  canvas.width = Math.ceil(w * pixelRatio)
  canvas.height = Math.ceil(h * pixelRatio)
  const c = canvas.getContext('2d')
  c.scale(pixelRatio, pixelRatio)
  // Redrawn in place when the repository's health arrives, so the sign keeps one texture.
  const draw = (subtitle = 'CREW STATION · CLICK ROOM', healthColor = accent) => {
    c.clearRect(0, 0, w, h)
    c.fillStyle = style.sign.plate
    c.beginPath()
    c.roundRect(1, 1, w - 2, h - 2, 12)
    c.fill()
    c.strokeStyle = style.sign.edge
    c.lineWidth = 2
    c.stroke()

    c.font = font
    c.textAlign = 'left'
    c.textBaseline = 'middle'
    const textX = pad + dot + gap
    const midY = fontSize / 2 + pad
    c.fillStyle = '#' + new THREE.Color(healthColor).getHexString()
    c.beginPath()
    c.arc(pad + dot / 2, midY, dot / 2, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = style.sign.text
    c.fillText(text, textX, midY)
    c.font = '600 12px "Barlow Semi Condensed", ui-sans-serif, system-ui, sans-serif'
    let line = subtitle
    while (line.length > 1 && c.measureText(line).width > w - pad * 2) line = line.slice(0, -2) + '…'
    c.fillText(line, pad, h - 16)
  }
  draw()

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // Magnified when you lean in and minified when you pull out: the pixel ratio covers the
  // close end, mipmaps the far one.
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8

  const height = 1.36
  const geo = new THREE.PlaneGeometry(Math.min(6.6, Math.max(3.8, height * (w / h))), height)
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    // Drawn over the scene with the badges, so a building between it and the camera never
    // cuts the name in half.
    depthTest: false,
    toneMapped: false,
    fog: false,
    side: THREE.DoubleSide,
    opacity: 0,
  })
  mat.onBeforeCompile = (shader) => {
    withCurve(shader)
    // The mounted plate reads correctly from either side when the camera is orbited.
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec2 signUv = vMapUv;
        if (!gl_FrontFacing) signUv.x = 1.0 - signUv.x;
        diffuseColor *= texture2D(map, signUv);
      #endif
    `)
  }
  mat.customProgramCacheKey = () => 'repository-sign:mounted'
  const mesh = new THREE.Mesh(geo, mat)
  let healthKey = ''
  mesh.userData.setHealth = health => {
    const key = JSON.stringify(health)
    if (key === healthKey) return
    healthKey = key
    // No folder or no Git to read: a sign of question marks says less than the default line.
    if (!health?.branch) health = null
    const color = health?.status === 'blocked' ? 0xe86f62 : health?.status === 'shipped' ? 0x46bb87 : health?.status === 'in-progress' ? 0xe0ac50 : accent
    const status = health?.checks !== 'unknown' && health?.checks ? `CI ${health.checks}` : health?.tests !== 'unknown' && health?.tests ? `TESTS ${health.tests}${health.testsStale ? ' (OLD)' : ''}` : 'CHECKS ?'
    draw(health ? `${health.branch || 'BRANCH ?'} · ${health.changedFiles ?? '?'} CHANGES · ${status}` : undefined, color)
    texture.needsUpdate = true
  }
  mesh.userData.physical = true
  mesh.renderOrder = 8
  mesh.frustumCulled = false
  mesh.visible = false
  // After bloom, with the badges — see the engine's overlay pass.
  mesh.layers.set(OVERLAY_LAYER)
  mesh.userData.dispose = () => {
    texture.dispose()
    geo.dispose()
    mat.dispose()
  }
  return mesh
}

export function hashString(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
