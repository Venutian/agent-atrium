import * as THREE from 'three'

/**
 * The office styles you can switch between. Every style is the same building — an open
 * floor of glass rooms, one per repo — set in its own light: a gradient sky the floor fades
 * into, a floor with real relief that deepens toward the horizon, a soft key light with long
 * shadows and a rim light in a second colour. A style is only data.
 *
 *   sky       { top, horizon, glow, glowStrength }   the backdrop, and the warm patch toward the key light
 *   fog       { color, near, far }     how the floor melts into the backdrop past the rooms
 *   floor     { center, edge, seam, glow, glowStrength, pattern, roughness, relief, variation }
 *                                      a radial gradient out to the edge; 'hex', 'planks', 'stone' or
 *                                      'carpet' tiles with a normal map drawn from the same pattern
 *   room      { base, deck, kerbGlow, halo }   a room's floor, its lean to the repo colour, its edge
 *                                      glow, and the soft light it spills onto the floor round it
 *   frame     { base, top, post, rail, header }   the glass walls' structure
 *   glass     { color, opacity }
 *   sign      { plate, edge, text, mount, bracket }
 *   plants    { pot, leaf, leafDark, extra }   `extra` adds a second pair of planters per room
 *   furniture { sofa, rug, wood, table, glow }  the commons, and the decor on the open floor
 *   light     { sunTime, sun, sunIntensity, rim, rimIntensity, sky, ground, ambient, fill, fillColor,
 *               environment, softness }   environment scales the user's sky-light intensity
 *   motes     colour of the slow glowing specks in the air
 *   night     0..1 — lit windows and glowing eyes
 *   bloom     { threshold, strength } — what glows, and how much
 *   dof       0..1 — how shallow the depth of field is; a little reads as a real camera
 *   ui        'light' | 'dark' — which way the panels lean
 *   grade     { saturation, warmth, vignette }
 *   audio     { beds, events }   the room tone; every style gets ROOM_TONE unless it names its own
 */
export const OFFICES = {
  glass: {
    id: 'glass',
    name: 'Glass Studio',
    blurb: 'Pearl-white glass rooms, cool reflections and long afternoon shadows.',
    swatch: [0x6a78f0, 0xf2b3dd],
    sky: { top: 0x657aab, horizon: 0xd5dfea, glow: 0xffefdc, glowStrength: 0.18 },
    fog: { color: 0xb8c5db, near: 170, far: 480 },
    floor: { center: 0xe6e8fb, edge: 0x8e9dc0, seam: 0xc2c6ec, glow: 0x8fdcff, glowStrength: 0.04, pattern: 'hex', roughness: 0.42, relief: 1.1, variation: 0.05 },
    room: { base: 0xf8f9ff, deck: 0.08, kerbGlow: 0.45, halo: 0.22 },
    frame: { base: 0xc3cdf0, top: 0xffffff, post: 0xb5c1ec, rail: 0x5cc4ff, header: 0xd7defa },
    glass: { color: 0x7fd6ff, opacity: 0.15 },
    sign: { plate: '#ffffff', edge: '#d5dcf7', text: '#1f2a5a', mount: 0x3a4a8f, bracket: 0x6f7fc4 },
    plants: { pot: 0xffffff, leaf: 0x55b884, leafDark: 0x2d8061, extra: false },
    reception: { step: 0xf5f6ff, stepAlt: 0xa9b6ff },
    furniture: { sofa: 0x8b7bff, rug: 0xd9ddff, wood: 0xe8d6bd, table: 0x3f63e0, glow: 0x7fdcff },
    light: { sunTime: 0.65, sun: 0xffedda, sunIntensity: 2.2, rim: 0xb8dcff, rimIntensity: 0.45, sky: 0xd2dbff, ground: 0x65718e, ambient: 0.36, fill: 0.12, fillColor: 0xb9cfff, environment: 0.6, softness: 3.5 },
    motes: 0xd2efff,
    night: 0,
    bloom: { threshold: 1.3, strength: 0.28 },
    dof: 0.12,
    ui: 'light',
    grade: { saturation: 1.02, warmth: 0.015, vignette: 0.32 },
  },
  beige: {
    id: 'beige',
    name: 'Evening Office',
    blurb: 'A real office at blue hour: warm carpet and brass lamps inside, deep blue dusk outside.',
    swatch: [0x1e2c52, 0xd9a35f],
    sky: { top: 0x101a38, horizon: 0xc98a62, glow: 0xffc890, glowStrength: 0.12 },
    fog: { color: 0x2c3552, near: 150, far: 460 },
    floor: { center: 0x56607e, edge: 0x0c1020, seam: 0x4a536e, glow: 0xffb45a, glowStrength: 0.1, pattern: 'carpet', roughness: 0.9, relief: 0.9, variation: 0.07 },
    room: { base: 0xf3e3c6, deck: 0.08, kerbGlow: 0.7, halo: 0.32 },
    frame: { base: 0x3e2b1e, top: 0x6b4a30, post: 0x35251a, rail: 0xffb85a, header: 0x4a3423 },
    glass: { color: 0xffd8a8, opacity: 0.11 },
    sign: { plate: '#fbf1e1', edge: '#d9a35f', text: '#2e1f14', mount: 0x2a1c12, bracket: 0x6b4a30 },
    plants: { pot: 0x2e2620, leaf: 0x5f9a52, leafDark: 0x2f6430, extra: false },
    reception: { step: 0xf0dcc0, stepAlt: 0x9a6a3e },
    furniture: { sofa: 0x2f5f6e, rug: 0xc9ab84, wood: 0x6b4428, table: 0x1f3a52, glow: 0xffbe6a },
    light: { sunTime: 0.72, sun: 0xffcf9c, sunIntensity: 1.4, rim: 0x86aaff, rimIntensity: 0.85, sky: 0x93a3d0, ground: 0x1c2030, ambient: 0.5, fill: 0.2, fillColor: 0xffcf9a, environment: 0.6, softness: 3.5 },
    motes: 0xffd8a0,
    night: 0.45,
    bloom: { threshold: 1.15, strength: 0.32 },
    dof: 0.12,
    ui: 'light',
    grade: { saturation: 1.04, warmth: 0.01, vignette: 0.38 },
  },
  oak: {
    id: 'oak',
    name: 'Sunset Loft',
    blurb: 'Amber evening light across dark timber floors, an orange sky behind.',
    swatch: [0xff9a2e, 0x4a1f0c],
    sky: { top: 0x3a1608, horizon: 0xf2843a, glow: 0xffc890, glowStrength: 0.1 },
    fog: { color: 0xc8622a, near: 160, far: 470 },
    floor: { center: 0x8c4a22, edge: 0x2a0f05, seam: 0x5a2a10, glow: 0xff8a2a, glowStrength: 0.15, pattern: 'planks', roughness: 0.45, relief: 1.0, variation: 0.08 },
    room: { base: 0xfff1de, deck: 0.1, kerbGlow: 0.6, halo: 0.18 },
    frame: { base: 0x5a3018, top: 0x8a5228, post: 0x4a2814, rail: 0xffa040, header: 0x6e3c1c },
    glass: { color: 0xffb35c, opacity: 0.14 },
    sign: { plate: '#fff4e4', edge: '#f0c79a', text: '#3d1a08', mount: 0x3a1a0a, bracket: 0x6b3a1c },
    plants: { pot: 0xe8c39a, leaf: 0x7fae4f, leafDark: 0x4d7a2c, extra: false },
    reception: { step: 0xffe0bb, stepAlt: 0xd9732c },
    furniture: { sofa: 0xc45a30, rug: 0xf3c48c, wood: 0x7a3f1c, table: 0x1f6b5a, glow: 0xffb347 },
    light: { sunTime: 0.68, sun: 0xffc48a, sunIntensity: 1.8, rim: 0xffd68a, rimIntensity: 0.9, sky: 0xffcf9e, ground: 0x4a1a08, ambient: 0.55, fill: 0.2, softness: 3.5 },
    motes: 0xffd9a0,
    night: 0.1,
    bloom: { threshold: 1.25, strength: 0.3 },
    dof: 0.12,
    ui: 'light',
    grade: { saturation: 1.06, warmth: 0.06, vignette: 0.32 },
  },
  garden: {
    id: 'garden',
    name: 'Greenhouse',
    blurb: 'A tropical glasshouse at golden hour: mossy slate, black steel and brass, warm light through the leaves.',
    swatch: [0x123a2c, 0xe8b45a],
    sky: { top: 0x06221f, horizon: 0xd99a58, glow: 0xffd9a0, glowStrength: 0.12 },
    fog: { color: 0x1f3d36, near: 150, far: 460 },
    floor: { center: 0x2e5a4a, edge: 0x04100c, seam: 0x1d3a30, glow: 0x8affc8, glowStrength: 0.09, pattern: 'stone', roughness: 0.8, relief: 1.25, variation: 0.1 },
    room: { base: 0xe2c49a, deck: 0.1, kerbGlow: 0.7, halo: 0.3 },
    frame: { base: 0x18221c, top: 0x2a3830, post: 0x141c17, rail: 0xe8b45a, header: 0x1f2b24 },
    glass: { color: 0xc8f0c0, opacity: 0.1 },
    sign: { plate: '#f6efd9', edge: '#e8b45a', text: '#14261c', mount: 0x141c17, bracket: 0x2a3830 },
    plants: { pot: 0xb5603a, leaf: 0x3f9a46, leafDark: 0x1d5a28, extra: true },
    reception: { step: 0xe8dcc0, stepAlt: 0x3f6a4a },
    furniture: { sofa: 0xb5552e, rug: 0xd9c49a, wood: 0x6b4428, table: 0x1f4a3a, glow: 0xffcf6a },
    light: { sunTime: 0.7, sun: 0xffe0b4, sunIntensity: 1.45, rim: 0x9ff0d4, rimIntensity: 0.8, sky: 0xa8d0c4, ground: 0x0c1c16, ambient: 0.5, fill: 0.16, fillColor: 0x8fd8c0, environment: 0.6, softness: 3.2 },
    motes: 0xc8ffd8,
    night: 0.35,
    bloom: { threshold: 1.15, strength: 0.3 },
    dof: 0.12,
    ui: 'light',
    grade: { saturation: 1.06, warmth: 0, vignette: 0.38 },
  },
  night: {
    id: 'night',
    name: 'Neon Night',
    blurb: 'Low moonlight, silver-blue highlights and violet edges across a dark tiled floor.',
    swatch: [0x23306e, 0xb36bff],
    sky: { top: 0x0a1030, horizon: 0x23306e, glow: 0x4a63c8, glowStrength: 0.1 },
    fog: { color: 0x162660, near: 140, far: 440 },
    floor: { center: 0x16224f, edge: 0x070b1f, seam: 0x0c1640, glow: 0x4fc8ff, glowStrength: 0.1, pattern: 'hex', roughness: 0.44, relief: 1.0, variation: 0.05 },
    room: { base: 0x141f48, deck: 0.14, kerbGlow: 0.8, halo: 0.35 },
    frame: { base: 0x2a3a7a, top: 0x4a5fb0, post: 0x33458f, rail: 0x4fc8ff, header: 0x3b4f9e },
    glass: { color: 0x5fd8ff, opacity: 0.08 },
    sign: { plate: '#101c4f', edge: '#4fc8ff', text: '#eef6ff', mount: 0x0a1238, bracket: 0x2a3a7a },
    plants: { pot: 0x2a3a7a, leaf: 0x3fae7a, leafDark: 0x1f7050, extra: false },
    reception: { step: 0x1a2a6e, stepAlt: 0x8a5fe0 },
    furniture: { sofa: 0x5f46c8, rug: 0x182a72, wood: 0x2a1f4a, table: 0x1f5fc8, glow: 0xc06bff },
    light: { sunTime: 0.5, sun: 0xd6e6ff, sunIntensity: 1.2, rim: 0xb36bff, rimIntensity: 0.7, sky: 0x6a80b5, ground: 0x0a1040, ambient: 0.38, fill: 0.13, fillColor: 0x9eb9df, environment: 0.65, softness: 3.5 },
    motes: 0x9fd8ff,
    night: 0.8,
    bloom: { threshold: 0.95, strength: 0.3 },
    dof: 0.12,
    ui: 'dark',
    grade: { saturation: 1.0, warmth: 0, vignette: 0.42 },
  },
}

/**
 * A working office: ventilation, people talking across the floor, and the odd mug, chair,
 * keyboard or printer somewhere around you. After dark the talk thins out and only the air
 * and a late mug of coffee are left.
 */
const ROOM_TONE = Object.freeze({
  beds: Object.freeze([
    Object.freeze({ sound: 'room-tone', day: 1, night: 0.75 }),
    Object.freeze({ sound: 'office-murmur', day: 1, night: 0.15 }),
  ]),
  events: Object.freeze([
    Object.freeze({ sound: 'mug-clink', every: [20, 50], gain: 0.8 }),
    Object.freeze({ sound: 'chair-roll', every: [30, 75], when: 'day', gain: 0.7 }),
    Object.freeze({ sound: 'distant-keys', every: [12, 30], when: 'day', gain: 0.7 }),
    Object.freeze({ sound: 'printer', every: [90, 200], when: 'day', gain: 0.6 }),
  ]),
})
for (const style of Object.values(OFFICES)) style.audio ??= ROOM_TONE

export const OFFICE_ORDER = ['glass', 'beige', 'oak', 'garden', 'night']
export const DEFAULT_OFFICE = 'glass'

export const officeStyle = (id) => OFFICES[id] || OFFICES[DEFAULT_OFFICE]

/** How far the open floor runs, in every direction. Far past any atrium, so it reads as endless. */
export const FLOOR_SIZE = 600
/** Everything inside this radius is where rooms are laid out. */
export const ATRIUM_RADIUS = 60
/**
 * The open floor sits a step below the rooms' platforms rather than a slab below them: rooms
 * read as raised studios on one continuous floor, and a bot walking a corridor between two
 * of them steps up and down a few centimetres instead of climbing a plinth.
 */
export const FLOOR_Y = 0.36

/** Floor height at any point. The office is level, so this is a constant. */
export const floorHeight = () => FLOOR_Y

/** Where the floor's colour gradient starts to deepen, and where it reaches the edge colour. */
const GRADIENT_INNER = 22
const GRADIENT_OUTER = 150

/**
 * The open floor: one plane, vertex-coloured from the style's centre colour under the rooms
 * out to its edge colour. Over that, three maps drawn from the same pattern: the albedo with a
 * little variation tile to tile, a normal map from the pattern's own height field so every seam
 * catches light on one edge and shadow on the other, and the seams alone for an optional glow.
 */
export function createOfficeFloor(style) {
  const segments = 72
  const geo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, segments, segments)
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, FLOOR_Y, 0)
  const centre = new THREE.Color(style.floor.center)
  const edge = new THREE.Color(style.floor.edge)
  const c = new THREE.Color()
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i))
    const t = THREE.MathUtils.smoothstep(r, GRADIENT_INNER, GRADIENT_OUTER)
    c.copy(centre).lerp(edge, t).toArray(colors, i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const roughness = style.floor.roughness ?? 0.6
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness,
    metalness: roughness < 0.4 ? 0.2 : 0.02,
  })
  const textures = floorTextures(style)
  if (textures) {
    material.map = textures.map
    material.normalMap = textures.normal
    const relief = style.floor.relief ?? 1
    material.normalScale = new THREE.Vector2(relief, relief)
    if (style.floor.glowStrength > 0) {
      material.emissiveMap = textures.glow
      material.emissive = new THREE.Color(style.floor.glow)
      material.emissiveIntensity = style.floor.glowStrength
    }
  }
  const mesh = new THREE.Mesh(geo, material)
  mesh.receiveShadow = true
  mesh.name = 'office-floor'
  mesh.userData.dispose = () => {
    if (!textures) return
    for (const t of Object.values(textures)) t.dispose()
  }
  return mesh
}

/** Size of one hexagonal floor tile, centre to corner, in world units. */
const HEX_TILE = 2.1
/** One repeat of the plank, stone and carpet patterns covers this many world units. */
const PATTERN_SPAN = 8

/**
 * Tiles as polygons in canvas space, for one repeat of a pattern. Each is drawn three ways —
 * albedo, height and glow — so the three maps line up exactly.
 */
function patternTiles(pattern, w, h) {
  const tiles = []
  if (pattern === 'hex') {
    // A flat-top hex grid tiles every 3s across and √3·s down; the canvas is that period.
    const s = w / 3
    const sy = h / (Math.sqrt(3) * s)
    for (let col = -1; col <= 2; col++) {
      for (let row = -1; row <= 2; row++) {
        const cx = 1.5 * s * col
        const cy = Math.sqrt(3) * s * (row + (col & 1 ? 0.5 : 0)) * sy
        const pts = []
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k
          pts.push([cx + Math.cos(a) * s, cy + Math.sin(a) * s * sy])
        }
        // Copies of a tile across the repeat edge share a key, so they share a shade.
        tiles.push({ pts, key: col & 1 })
      }
    }
  } else if (pattern === 'planks') {
    // Boards run one way, with staggered butt joints so the floor does not read as a grid.
    const rows = 8
    const board = h / rows
    for (let i = 0; i < rows; i++) {
      const offset = ((i * 37) % 8) / 8
      for (let k = -1; k < 2; k++) {
        const x0 = (offset + k) * w
        tiles.push({ pts: [[x0, i * board], [x0 + w, i * board], [x0 + w, (i + 1) * board], [x0, (i + 1) * board]], key: i })
      }
    }
  } else if (pattern === 'stone') {
    // Large slabs in a running bond.
    const slab = w / 2
    for (let row = 0; row < 2; row++) {
      const shift = row % 2 ? slab / 2 : 0
      for (let k = -1; k < 3; k++) {
        const x0 = k * slab + shift
        tiles.push({ pts: [[x0, row * slab], [x0 + slab, row * slab], [x0 + slab, (row + 1) * slab], [x0, (row + 1) * slab]], key: row * 2 + ((k % 2) + 2) % 2 })
      }
    }
  } else {
    // Carpet tiles: a 4 × 4 grid of squares, quarter-turned one to the next, as offices lay them.
    const n = 4
    const t = w / n
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        tiles.push({ pts: [[i * t, j * t], [(i + 1) * t, j * t], [(i + 1) * t, (j + 1) * t], [i * t, (j + 1) * t]], key: i * n + j })
      }
    }
  }
  return tiles
}

function fillPath(g, pts) {
  g.beginPath()
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.closePath()
}

/** Seeded pseudo-random per tile, so a floor looks the same on every load. */
function tileRandom(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

function floorTextures(style) {
  if (typeof document === 'undefined') return null
  const { pattern } = style.floor
  const w = pattern === 'hex' ? 384 : 512
  const h = pattern === 'hex' ? Math.round(Math.sqrt(3) * 128) : 512
  const tiles = patternTiles(pattern, w, h)
  const seamShade = (() => {
    const seam = new THREE.Color(style.floor.seam).getHSL({}).l
    const base = new THREE.Color(style.floor.center).getHSL({}).l
    return Math.round(255 * THREE.MathUtils.clamp(seam / Math.max(0.05, base), 0.4, 0.95))
  })()
  const variation = style.floor.variation ?? 0.05
  const seamWidth = pattern === 'carpet' ? 1.5 : pattern === 'hex' ? 4 : 3
  const canvas = () => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }

  // Albedo: near white, each tile a shade apart, seams darker; the vertex colours tint it.
  const albedo = canvas()
  {
    const g = albedo.getContext('2d')
    g.fillStyle = '#fff'
    g.fillRect(0, 0, w, h)
    tiles.forEach(({ pts, key }) => {
      const v = Math.round(255 * (1 - variation * tileRandom(key)))
      g.fillStyle = `rgb(${v},${v},${v})`
      fillPath(g, pts)
      g.fill()
    })
    if (pattern === 'carpet') carpetFibres(g, w, h, tiles)
    if (pattern === 'planks') woodGrain(g, w, h)
    g.strokeStyle = `rgb(${seamShade},${seamShade},${seamShade})`
    g.lineWidth = seamWidth
    tiles.forEach(({ pts }) => { fillPath(g, pts); g.stroke() })
  }

  // Height: each tile a raised field with a bevelled edge down into its seam.
  const height = canvas()
  {
    const g = height.getContext('2d')
    g.fillStyle = '#000'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#fff'
    g.filter = `blur(${pattern === 'carpet' ? 1.2 : 2.4}px)`
    tiles.forEach(({ pts }) => { fillPath(g, pts); g.fill() })
    g.filter = 'none'
    g.strokeStyle = '#000'
    g.lineWidth = seamWidth + 1
    tiles.forEach(({ pts }) => { fillPath(g, pts); g.stroke() })
    if (pattern === 'carpet') carpetFibres(g, w, h, tiles, true)
  }

  // Glow: black, with only the seams in white.
  const glow = canvas()
  {
    const g = glow.getContext('2d')
    g.fillStyle = '#000'
    g.fillRect(0, 0, w, h)
    g.strokeStyle = '#fff'
    g.lineWidth = seamWidth - 1
    g.shadowColor = '#fff'
    g.shadowBlur = 5
    tiles.forEach(({ pts }) => { fillPath(g, pts); g.stroke() })
  }

  const wrap = (source, srgb) => {
    const t = new THREE.CanvasTexture(source)
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 8
    if (pattern === 'hex') t.repeat.set(FLOOR_SIZE / (3 * HEX_TILE), FLOOR_SIZE / (Math.sqrt(3) * HEX_TILE))
    else t.repeat.set(FLOOR_SIZE / PATTERN_SPAN, FLOOR_SIZE / PATTERN_SPAN)
    return t
  }
  return {
    map: wrap(albedo, true),
    normal: wrap(normalFromHeight(height, pattern === 'carpet' ? 2.2 : 3.5), false),
    glow: wrap(glow, true),
  }
}

/** A Sobel pass over the height canvas, wrapping at the edges so the map tiles. */
function normalFromHeight(source, strength) {
  const w = source.width
  const h = source.height
  const src = source.getContext('2d').getImageData(0, 0, w, h).data
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const g = out.getContext('2d')
  const img = g.createImageData(w, h)
  const at = (x, y) => src[((((y + h) % h) * w + ((x + w) % w)) * 4)] / 255
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const nx = -dx * strength
      const ny = dy * strength
      const len = Math.hypot(nx, ny, 1)
      const i = (y * w + x) * 4
      img.data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255)
      img.data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255)
      img.data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255)
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return out
}

/** Short fibre strokes inside each carpet tile, running one way or the other by checkerboard. */
function carpetFibres(g, w, h, tiles, forHeight = false) {
  const n = Math.sqrt(tiles.length)
  const size = w / n
  let seed = 7
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  g.lineWidth = 1
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const across = (i + j) % 2 === 0
      for (let k = 0; k < 260; k++) {
        const x = i * size + 3 + rand() * (size - 6)
        const y = j * size + 3 + rand() * (size - 6)
        const len = 2 + rand() * 4
        const v = forHeight ? 120 + rand() * 100 : 200 + rand() * 50
        g.strokeStyle = `rgba(${v},${v},${v},0.55)`
        g.beginPath()
        g.moveTo(x, y)
        g.lineTo(across ? x + len : x, across ? y : y + len)
        g.stroke()
      }
    }
  }
}

/** A faint grain along each board. */
function woodGrain(g, w, h) {
  let seed = 3
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  g.lineWidth = 1
  for (let k = 0; k < 140; k++) {
    const y = rand() * h
    const v = 200 + rand() * 40
    g.strokeStyle = `rgba(${v},${v},${v},0.35)`
    g.beginPath()
    g.moveTo(0, y)
    g.bezierCurveTo(w * 0.3, y + (rand() - 0.5) * 4, w * 0.7, y + (rand() - 0.5) * 4, w, y)
    g.stroke()
  }
}

/** Small deterministic PRNG — same seed, same office, every reload. */
export function mulberry(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
