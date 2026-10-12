import * as THREE from 'three'

/**
 * The office's light: a backdrop dome, a key light, a sky/ground fill and the image-based
 * lighting taken from the dome.
 *
 * There is no day cycle. Each office style fixes its own light — where the key light sits
 * (as a time of day along the sun's old arc, which keeps shadows a readable length), how
 * bright and what colour it is, and how much of an evening it is — so switching style is the
 * only thing that changes the room's mood.
 */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // The dome is pinned to the camera, so it can never be walked out of.
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
  }
`

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  uniform vec3 uGlowDir;
  uniform float uGlowStrength;

  void main() {
    vec3 d = normalize( vDir );
    // Up from the horizon only: below it the dome is the horizon colour, which the fogged
    // floor fades into, so the office floats in its colour rather than on a hard line.
    float h = clamp( d.y, 0.0, 1.0 );
    vec3 col = mix( uHorizon, uTop, pow( h, 0.55 ) );
    // A broad warm patch on the side the key light comes from, the way a studio backdrop is lit.
    float toward = max( dot( normalize( vec3( d.x, 0.35, d.z ) ), uGlowDir ), 0.0 );
    col += uGlow * pow( toward, 3.0 ) * ( 1.0 - h ) * uGlowStrength;
    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const SUN_AXIS = 0.72 // which way the key light's arc runs
/**
 * How high the key light gets at its noon, in radians — 54°, not 90°. A light straight
 * overhead puts N·L at zero on every wall and they go black with only ambient to catch.
 */
const SUN_APEX = 0.95
/** Half-width of the shadow camera, in metres, centred on whatever you are looking at. */
const SHADOW_EXTENT = 30
/**
 * The focus is snapped to this grid before the shadow camera moves. Panning a shadow map by
 * sub-texel amounts makes every shadow edge crawl; snapping keeps them still.
 */
const SHADOW_SNAP = 2

export class Sky {
  constructor(scene, settings, renderer) {
    this.scene = scene
    this.settings = settings
    this.renderer = renderer
    this.group = new THREE.Group()
    this.group.name = 'sky'
    scene.add(this.group)

    this.sunDir = new THREE.Vector3(0, 1, 0)
    this.dayFactor = 1
    this.nightFactor = 0

    this._buildDome()
    this._buildLights()
    this._buildEnvironment()
    scene.fog = new THREE.Fog(0xffffff, 1000, 2000)
  }

  /**
   * Image-based lighting, taken from the dome: a second copy of it, sharing its uniforms, is
   * rendered into a prefiltered radiance map. That is what gives metal something to reflect.
   * It only changes when the style does.
   */
  _buildEnvironment() {
    if (!this.renderer) return
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envScene = new THREE.Scene()
    this.envDome = new THREE.Mesh(this.dome.geometry, this.dome.material)
    this.envDome.scale.setScalar(10)
    this.envDome.frustumCulled = false
    this.envScene.add(this.envDome)
    this._envDirty = true
    this._envTarget = null
  }

  _refreshEnvironment(force = false) {
    if (!this.pmrem) return
    if (!this.settings.get('ibl')) {
      if (this.scene.environment) {
        this.scene.environment = null
        this._envTarget?.dispose()
        this._envTarget = null
      }
      return
    }
    if (!force && !this._envDirty) return
    this._envDirty = false
    const next = this.pmrem.fromScene(this.envScene, 0, 0.5, 60)
    this._envTarget?.dispose()
    this._envTarget = next
    this.scene.environment = next.texture
    this._syncEnvironmentIntensity()
  }

  _buildDome() {
    const geo = new THREE.SphereGeometry(1, 32, 20)
    this.domeUniforms = {
      uTop: { value: new THREE.Color(0xffffff) },
      uHorizon: { value: new THREE.Color(0xffffff) },
      uGlow: { value: new THREE.Color(0x000000) },
      uGlowDir: { value: new THREE.Vector3(1, 0, 0) },
      uGlowStrength: { value: 0.3 },
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: this.domeUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
    this.dome = new THREE.Mesh(geo, mat)
    this.dome.renderOrder = -1000
    this.dome.frustumCulled = false
    this.dome.scale.setScalar(400)
    this.group.add(this.dome)
  }

  _buildLights() {
    this.sun = new THREE.DirectionalLight(0xffffff, 3)
    this.sun.castShadow = true
    // The shadow camera tracks what you are looking at rather than covering the whole
    // office, which roughly doubles the effective shadow resolution.
    const s = SHADOW_EXTENT
    this.sun.shadow.camera.left = -s
    this.sun.shadow.camera.right = s
    this.sun.shadow.camera.top = s
    this.sun.shadow.camera.bottom = -s
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 320
    // Normal bias alone, sized against the shadow texel: no acne on the big flat floors and
    // no peter-panning on the small characters.
    this.sun.shadow.bias = 0
    this.sun.shadow.normalBias = 0.09
    this.sun.shadow.mapSize.setScalar(this.settings.shadowSize || 1024)
    this.focus = new THREE.Vector3()
    this.sun.target.position.set(0, 0, 0)
    this.group.add(this.sun, this.sun.target)

    this.hemi = new THREE.HemisphereLight(0x8899cc, 0x4a4038, 0.6)
    this.group.add(this.hemi)

    // A cool rim from the opposite side keeps the faces turned away from the key light from
    // reading as holes.
    this.fill = new THREE.DirectionalLight(0x8fa8d8, 0.3)
    this.fill.position.set(-40, 30, -30)
    this.group.add(this.fill)

    // The rim: a coloured light from behind and low, opposite the key, that outlines every bot
    // and desk edge in the style's second colour.
    this.rim = new THREE.DirectionalLight(0xffffff, 0)
    this.group.add(this.rim, this.rim.target)
  }

  // ── style ───────────────────────────────────────────────────────────────────────────

  setStyle(style) {
    this.style = style
    const light = style.light

    // The key light sits where the sun would at `sunTime` along a tilted arc: 0.25 sunrise,
    // 0.5 noon, 0.75 sunset.
    const a = (light.sunTime - 0.25) * Math.PI * 2
    const across = Math.sin(SUN_AXIS)
    const along = Math.cos(SUN_AXIS)
    const lean = Math.cos(SUN_APEX)
    this.sunDir.set(
      Math.cos(a) * along + Math.sin(a) * lean * -across,
      Math.sin(a) * Math.sin(SUN_APEX),
      Math.cos(a) * across + Math.sin(a) * lean * along
    )
    this.nightFactor = style.night
    this.dayFactor = 1 - style.night

    this.sun.color.set(light.sun)
    this.sun.intensity = light.sunIntensity
    this._placeSun()

    this.hemi.color.set(light.sky)
    this.hemi.groundColor.set(light.ground)
    // The hemisphere light drops back when IBL is carrying the ambient — running both at
    // full strength double-counts the sky and flattens everything out.
    this.hemi.intensity = light.ambient * (this.settings.get('ibl') ? 0.55 : 1)
    this.fill.intensity = light.fill
    this.fill.color.set(light.fillColor ?? 0x8fa8d8)
    this.rim.color.set(light.rim ?? 0xffffff)
    this.rim.intensity = light.rimIntensity ?? 0
    this._placeRim()

    this.domeUniforms.uTop.value.set(style.sky.top)
    this.domeUniforms.uHorizon.value.set(style.sky.horizon)
    this.domeUniforms.uGlow.value.set(style.sky.glow ?? style.sky.horizon)
    this.domeUniforms.uGlowDir.value.set(this.sunDir.x, 0.35, this.sunDir.z).normalize()
    this.domeUniforms.uGlowStrength.value = style.sky.glowStrength ?? 0.3
    // Soft-edged shadows: the PCF kernel widened, the way a large, diffuse light casts them.
    this.sun.shadow.radius = light.softness ?? 3
    this.sun.shadow.blurSamples = 12
    this.scene.fog.color.set(style.fog.color)
    this.scene.fog.near = style.fog.near
    this.scene.fog.far = style.fog.far
    this._envDirty = true
    this._syncEnvironmentIntensity()
  }

  /** Keep reflected sky light below the key, without overriding the user's IBL slider. */
  _syncEnvironmentIntensity() {
    this.scene.environmentIntensity = this.settings.get('iblIntensity') * (this.style?.light.environment ?? 1)
  }

  /** Point the shadow frustum at the middle of the view. */
  setFocus(point) {
    const x = Math.round(point.x / SHADOW_SNAP) * SHADOW_SNAP
    const z = Math.round(point.z / SHADOW_SNAP) * SHADOW_SNAP
    if (x === this.focus.x && z === this.focus.z) return
    this.focus.set(x, 0, z)
    this._placeSun()
  }

  /** Light position and target both hang off the focus point, so the frustum travels with it. */
  _placeSun() {
    this.sun.position.copy(this.sunDir).multiplyScalar(150).add(this.focus)
    this.sun.target.position.copy(this.focus)
    this.sun.target.updateMatrixWorld()
    this._placeRim()
  }

  /** Opposite the key light and low over the floor, so it catches edges rather than tops. */
  _placeRim() {
    if (!this.rim) return
    this.rim.position.set(-this.sunDir.x * 100, 28, -this.sunDir.z * 100).add(this.focus)
    this.rim.target.position.copy(this.focus)
    this.rim.target.updateMatrixWorld()
  }

  onSettingsChanged(changed) {
    if (changed.has('shadows')) {
      const size = this.settings.shadowSize
      this.sun.castShadow = size > 0
      if (size > 0) {
        this.sun.shadow.mapSize.setScalar(size)
        this.sun.shadow.map?.dispose()
        this.sun.shadow.map = null
      }
    }
    if (changed.has('ibl') || changed.has('iblIntensity')) {
      if (this.style) this.setStyle(this.style)
      this._syncEnvironmentIntensity()
      this._refreshEnvironment(true)
    }
  }

  update(dt, elapsed, camera) {
    // The dome rides with the camera so it reads as infinitely far away.
    this.dome.position.copy(camera.position)
    this._refreshEnvironment()
  }

  dispose() {
    this.pmrem?.dispose()
    this._envTarget?.dispose()
    this.scene.environment = null
    this.dome.geometry.dispose()
    this.dome.material.dispose()
    this.scene.remove(this.group)
  }
}
