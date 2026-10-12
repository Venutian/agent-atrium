import { PRESETS } from './hud-data.js'
import { OFFICES, OFFICE_ORDER } from '../world/offices.js'
import { STATUS_LABEL } from '../game/atrium.js'
import { FACE, FRAME_COLS, FRAME_ROWS } from '../agents/faces.js'
import { PLOT_PALETTE, hashString } from '../world/plots.js'
import { usageStats, formatTokens, exactTokens, allowanceWindow, contextRemaining } from './usage.js'
import { OfficeHub } from './office-hub.js'

/**
 * The whole HUD, in plain DOM.
 *
 * Deliberately not a framework: this sits on top of a render loop that must not miss a
 * frame, so the UI only ever touches the DOM when something it shows has actually changed —
 * every setter compares against the last value it wrote and returns early otherwise.
 *
 * The one hard rule is that all of this is optional. Pressing H hides every panel, and the
 * office stays fully readable because status lives above the bots' heads in the scene,
 * not in here.
 */

/**
 * The page only ever runs on the machine the server is on — it answers nothing else — so the
 * browser's OS is the server's OS, and the name of the thing that shows a folder can be read
 * here rather than asked for.
 */
const IS_MAC = /Mac/.test(navigator.platform)
const IS_WIN = /Win/.test(navigator.platform)
const FILE_MANAGER = IS_MAC ? 'Finder' : IS_WIN ? 'Explorer' : 'Files'

const ICON = {
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M6.6 6.6C4.06 8.2 2 11 2 11s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-6h5v6"/></svg>`,
  next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8.5h3.2l1.5-2h8.6l1.5 2H21v11H3z"/><circle cx="12" cy="14" r="3.4"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.6v.4"/><path d="M12 17h.01"/></svg>`,
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18v3H3z"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12h11"/><path d="M4 4.5 20 12 4 19.5l2.6-7.5z"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.7a8 8 0 0 1-8.5 8 9.3 9.3 0 0 1-2.7-.4L4.5 21l1.4-4.1a7.9 7.9 0 0 1-2.4-5.7A8 8 0 0 1 12 3.6a8 8 0 0 1 8.5 8.1z"/><path d="M12 8.6v5.4M9.3 11.3h5.4"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.4A1.4 1.4 0 0 1 4.4 6h4.2l2 2.5h7A1.4 1.4 0 0 1 19 9.9v7.7a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 17.6z"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.6"/><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6"/></svg>`,
  orbit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10.2" ry="4.6" transform="rotate(-24 12 12)"/><circle cx="21" cy="8.2" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  sound: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/></svg>`,
  soundOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>`,
}

const STAT_DEFS = [
  { key: 'working', label: 'at work', cls: 'working' },
  { key: 'waiting', label: 'need you', cls: 'waiting' },
  { key: 'blocked', label: 'blocked', cls: 'blocked' },
  { key: 'celebrating', label: 'shipped', cls: 'done' },
  { key: 'agents', label: 'bots', cls: 'idle' },
]

/** The glass-hex mark: the same shape as the rooms, with a bot's screen inside. */
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><rect x="10.5" y="13" width="11" height="6.5" rx="3.2" fill="currentColor"/></svg>`

export class Hud {
  constructor(root, settings, actions) {
    this.settings = settings
    this.actions = actions
    this.visible = true
    this._last = {}
    this.hiddenOpen = false

    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = TEMPLATE
    root.appendChild(this.el)

    this.$ = (sel) => this.el.querySelector(sel)

    this._buildStats()
    this._buildSettings()
    this._buildAvatar()
    this._wire()
    this.officeHub = new OfficeHub(this)
    this.syncSettings()
    // Read layout when panels resize/change, never in the animation loop.
    this._layoutObserver = new ResizeObserver(() => this._syncLayout())
    this._layoutObserver.observe(this.el)
    this._layoutObserver.observe(this.$('.side'))
    this._syncLayout()
  }

  // ── construction ────────────────────────────────────────────────────────────────────

  _buildStats() {
    const wrap = this.$('.stats')
    this.statEls = {}
    for (const def of STAT_DEFS) {
      const b = document.createElement('button')
      b.className = `stat ${def.cls}`
      b.type = 'button'
      b.dataset.key = def.key
      b.title = `Jump to the next ${def.label} bot`
      b.innerHTML = `<i class="pip"></i><span class="n">0</span><span class="lbl">${def.label}</span>`
      b.type = 'button'
      b.addEventListener('click', () => this.actions.focusStatus?.(def.key))
      wrap.appendChild(b)
      this.statEls[def.key] = b
    }
  }

  _buildSettings() {
    const body = this.$('.settings .body')
    const s = this.settings
    this.controls = []

    // Quality presets.
    body.appendChild(
      group(
        'Quality preset',
        chips(
          Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, title: p.hint })),
          () => s.get('preset'),
          (id) => s.applyPreset(id),
          this.controls
        )
      )
    )

    // Performance.
    const perf = group('Performance')
    perf.append(
      this._toggle('HDR + bloom', 'bloom', 'The glow on screens, eyes, room edges and the neon floor. The first thing to drop.'),
      this._select('Shadows', 'shadows', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._select('Particles', 'particles', [
        ['off', 'Off'],
        ['low', 'Low'],
        ['full', 'Full'],
      ]),
      this._select('Textures', 'textureQuality', [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ]),
      this._toggle('Anti-aliasing', 'antialias', 'SMAA pass. Cheap, but not free.'),
      this._slider(
        'Render scale',
        'renderScale',
        0.35,
        2,
        0.05,
        (v) => `${Math.round(v * 100)}%`,
        '100% is your display’s own resolution, retina included.'
      ),
      this._toggle('Adaptive quality', 'autoQuality', 'Quietly drops render scale if frames get expensive.'),
      this._slider('Max bots', 'maxAgents', 10, 200, 10, (v) => String(v))
    )
    body.appendChild(perf)

    // Office style.
    const world = group('Office style')
    const offices = document.createElement('div')
    offices.className = 'planets'
    for (const id of OFFICE_ORDER) {
      const office = OFFICES[id]
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'planet'
      b.title = office.blurb
      const [c1, c2] = office.swatch.map(hex)
      b.innerHTML = `<i class="orb" style="background:linear-gradient(135deg, ${c1} 0 55%, ${c2} 55% 100%)"></i><span>${office.name}</span>`
      b.addEventListener('click', () => this.settings.set('office', id))
      offices.appendChild(b)
      this.controls.push({ el: b, sync: () => b.setAttribute('aria-pressed', String(this.settings.get('office') === id)) })
    }
    world.appendChild(offices)
    body.appendChild(world)

    // Lighting.
    const light = group('Lighting')
    light.append(
      this._toggle(
        'Environment light',
        'ibl',
        'Soft reflected light from the office around it. Metals get something to reflect.'
      ),
      this._slider('Environment', 'iblIntensity', 0, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Exposure', 'exposure', 0.4, 2, 0.05, (v) => v.toFixed(2)),
      this._slider('Bloom', 'bloomStrength', 0, 1.6, 0.02, (v) => v.toFixed(2))
    )
    body.appendChild(light)

    // View.
    const view = group('View')
    // The server refuses terminals on Windows, so a choice there would only ever toast an error.
    if (!IS_WIN) {
      view.append(
        this._select(
          'Open threads in',
          'openIn',
          [
            ['app', 'Original app / VS Code'],
            ['terminal', 'Terminal'],
          ],
          'Terminal runs the harness’s own CLI in a new window, so the CLI has to be installed. ' +
            'AGENT_ATRIUM_TERMINAL or $TERMINAL picks the emulator.'
        )
      )
    }
    view.append(
      this._toggle(
        'Hide dormant repos',
        'hideDormant',
        'Takes a repo’s room away when every thread in it has been quiet for three days. Its threads are untouched, and the room comes back in the same place the moment one wakes up.'
      )
    )
    view.append(
      this._toggle('Follow selected bot', 'followSelected', 'Tracks the selected bot until you deselect. Drag to pan, right-drag to orbit, and scroll to zoom.'),
      this._toggle('Return to isometric', 'autoFrame', 'Eases the angle back when you stop dragging.'),
      this._slider('Field of view', 'fov', 20, 60, 1, (v) => `${v}°`),
      this._toggle('Room signs', 'showLabels'),
      this._toggle('Reduced motion', 'reducedMotion', 'Calms the bobbing and the camera easing.'),
      this._toggle('Show FPS', 'showFps')
    )
    body.appendChild(view)

    // Look.
    const look = group('Look')
    look.append(
      this._slider(
        'Ambient occlusion',
        'ambientOcclusion',
        0,
        1,
        0.05,
        (v) => v === 0 ? 'Off' : `${Math.round(v * 100)}%`,
        'Soft shading in creases and where surfaces meet. Try 20–35% for a subtle effect; 0 turns it off.'
      ),
      this._toggle('Colour grade', 'colorGrade', 'Saturation, warmth, lifted shadows and a soft vignette on the finished frame.'),
      this._slider('Saturation', 'saturation', 0.6, 1.5, 0.05, (v) => v.toFixed(2)),
      this._slider('Vignette', 'vignette', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._select('Delivery drones', 'fauna', [
        ['off', 'Off'],
        ['low', 'Some'],
        ['full', 'Full'],
      ])
    )
    body.appendChild(look)

    // Sound.
    const sound = group('Sound')
    sound.append(
      this._toggle(
        'Ambient sound',
        'sound',
        'Work you can hear where it is happening, and a chime when a bot needs you. Louder as you lean in.'
      ),
      this._slider('Master', 'masterVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this._slider('Ambience', 'ambienceVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, 'The background hum of the office.'),
      this._slider('Effects', 'effectsVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, 'Hammering, drones, and the chime when somebody needs you.')
    )
    body.appendChild(sound)
    const alerts = group('Alerts')
    const notify = document.createElement('button')
    notify.className = 'btn'
    notify.type = 'button'
    notify.addEventListener('click', () => this.actions.enableNotifications?.())
    alerts.appendChild(notify)
    this.controls.push({ el: notify, sync: () => { notify.textContent = this.settings.get('notifications') ? 'Disable browser notifications' : 'Enable browser notifications' } })
    body.appendChild(alerts)
  }

  _row(label, hint) {
    const row = document.createElement('div')
    row.className = 'row'
    const l = document.createElement('div')
    l.className = 'label'
    l.innerHTML = `<span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}`
    row.appendChild(l)
    return row
  }

  _toggle(label, key, hint) {
    const row = this._row(label, hint)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'toggle'
    b.setAttribute('role', 'switch')
    b.setAttribute('aria-label', label)
    b.addEventListener('click', () => this.settings.set(key, !this.settings.get(key)))
    row.appendChild(b)
    this.controls.push({
      el: row,
      sync: () => {
        b.setAttribute('aria-checked', String(Boolean(this.settings.get(key))))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _select(label, key, options, hint) {
    const row = this._row(label, hint)
    const sel = document.createElement('select')
    sel.className = 'select'
    for (const [value, text] of options) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => this.settings.set(key, sel.value))
    row.appendChild(sel)
    this.controls.push({
      el: row,
      sync: () => {
        sel.value = String(this.settings.get(key))
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  _slider(label, key, min, max, step, format, hint, onInput) {
    const row = this._row(label, hint)
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px'
    const input = document.createElement('input')
    input.type = 'range'
    input.setAttribute('aria-label', label)
    input.className = 'slider'
    input.min = min
    input.max = max
    input.step = step
    const out = document.createElement('span')
    out.className = 'value'
    input.addEventListener('input', () => {
      onInput?.()
      this.settings.set(key, Number(input.value))
    })
    wrap.append(input, out)
    row.appendChild(wrap)
    this.controls.push({
      el: row,
      sync: () => {
        const v = Number(this.settings.get(key))
        // Never fight the thumb the user is dragging.
        if (document.activeElement !== input) input.value = String(v)
        out.textContent = format(v)
        row.classList.toggle('overridden', this.settings.isOverridden(key))
      },
    })
    return row
  }

  /** The little face on the agent card, drawn from the same atlas the bots use. */
  _buildAvatar() {
    const canvas = this.$('.thread-pop .avatar canvas')
    canvas.width = 108
    canvas.height = 108
    this.avatarCtx = canvas.getContext('2d')
    this.avatarTmp = document.createElement('canvas')
    this.avatarTmp.width = 108
    this.avatarTmp.height = 108
    this.avatarTmpCtx = this.avatarTmp.getContext('2d')
    this._avatarState = { frame: -1, color: '' }
  }

  _wire() {
    const on = (sel, ev, fn) => this.$(sel).addEventListener(ev, fn)

    on('#btn-settings', 'click', () => this.toggleSettings())
    on('#btn-usage', 'click', () => this.toggleUsage())
    on('#btn-close-usage', 'click', () => this.toggleUsage(false))
    on('.usage-dashboard', 'click', e => {
      if (e.target === this.$('.usage-dashboard')) this.toggleUsage(false)
    })
    for (const button of this.el.querySelectorAll('[data-usage-tab]')) button.addEventListener('click', () => {
      this.usageTab = button.dataset.usageTab
      this._renderUsage()
    })
    on('.usage-dashboard', 'keydown', e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); this.toggleUsage(false); return }
      if (e.key !== 'Tab') return
      const buttons = [...this.$('.usage-dashboard').querySelectorAll('button, a[href], input, select, textarea')].filter(el => !el.disabled && el.offsetParent !== null)
      const first = buttons[0], last = buttons.at(-1)
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    })
    // On a phone the sidebar is a sheet: a tap on its brand row (not on its buttons) pulls
    // it up or lets it drop, and a drag on the row does the same by direction.
    const brandbar = this.$('.side .brandbar')
    const grab = this.$('.side .grab')
    let dragY = null
    const startDrag = (e) => {
      if (!this.isPhone() || e.target.closest('.btn')) return
      dragY = e.clientY
    }
    const endDrag = (e) => {
      if (dragY === null) return
      const dy = e.clientY - dragY
      dragY = null
      if (Math.abs(dy) > 24) this.toggleSheet(dy < 0)
      else if (!e.target.closest('.btn')) this.toggleSheet()
    }
    for (const el of [brandbar, grab]) {
      el.addEventListener('pointerdown', startDrag)
      el.addEventListener('pointerup', endDrag)
    }
    on('#btn-close-settings', 'click', () => this.toggleSettings(false))
    on('#btn-hide', 'click', () => this.toggleUi())
    on('#btn-help', 'click', () => this.toggleHelp())
    on('#btn-shot', 'click', () => this.actions.screenshot?.())
    on('#btn-home', 'click', () => this.actions.resetView?.())
    on('#btn-next', 'click', () => this.actions.focusStatus?.('waiting'))
    on('#btn-orbit', 'click', () => this.setOrbit(this.actions.toggleOrbit?.()))
    on('#btn-planet', 'click', () => this.actions.cycleOffice?.())
    on('#btn-sound', 'click', () => this.settings.set('sound', !this.settings.get('sound')))
    on('#btn-open', 'click', () => this.actions.openThread?.())
    on('#btn-viewed', 'click', () => this.actions.markViewed?.())
    on('#btn-archive', 'click', () => this.actions.archiveThread?.())
    this._wireCompose()
    on('#btn-deselect', 'click', () => this.actions.select?.(null))
    on('#btn-follow', 'click', () => this.settings.set('followSelected', !this.settings.get('followSelected')))
    on('#btn-new-session', 'click', () => this.actions.newConversation?.())
    on('#btn-reveal', 'click', () => this.actions.revealProject?.())
    on('#btn-copy-path', 'click', () => this.actions.copyProjectPath?.())
    on('#btn-hide-project', 'click', () => this.actions.hideProject?.())
    on('#btn-hidden-toggle', 'click', () => this.toggleHiddenList())
    on('#btn-locate', 'click', () => this.actions.focusProject?.(this.project?.name))
    on('#btn-close-project', 'click', () => this.actions.closeProject?.())
    on('.help', 'click', (e) => {
      if (e.target === this.$('.help')) this.toggleHelp(false)
    })
    this.$('.help .sheet').addEventListener('click', (e) => e.stopPropagation())
    on('#btn-help-close', 'click', () => this.toggleHelp(false))

    this.settings.onChange(() => this.syncSettings())
  }

  // ── state in ────────────────────────────────────────────────────────────────────────

  syncSettings() {
    const follow = Boolean(this.settings.get('followSelected'))
    this.$('#btn-follow').setAttribute('aria-pressed', String(follow))
    this.$('#btn-follow').title = follow ? 'Stop following selected bot' : 'Follow selected bot'
    for (const c of this.controls) c.sync()
    this.$('.fps').classList.toggle('on', Boolean(this.settings.get('showFps')))
    const sound = Boolean(this.settings.get('sound'))
    const btn = this.$('#btn-sound')
    btn.innerHTML = sound ? ICON.sound : ICON.soundOff
    btn.setAttribute('aria-pressed', String(sound))
    btn.title = sound ? 'Mute (M)' : 'Unmute (M)'
  }

  /**
   * The front desk: the bots waiting on you or stuck, at the top of the screen, one click
   * from each. Empty, it is not there at all.
   */
  setQueue(items) {
    const desk = this.$('.frontdesk')
    const signature = items.map((t) => `${t.id}:${t.status}`).join('|')
    if (this._last.queue === signature) return
    this._last.queue = signature
    desk.hidden = !items.length
    const list = this.$('.frontdesk .fd-list')
    list.textContent = ''
    const shown = items.slice(0, 4)
    for (const t of shown) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `fd-item ${t.status}`
      b.title = `${t.status === 'blocked' ? 'Blocked' : 'Waiting on you'}: ${t.title}`
      b.innerHTML = `<i class="light"></i><span class="fd-text"><span class="fd-repo">${escapeHtml(t.project || '')}</span><span class="fd-title">${escapeHtml(t.title || 'Untitled thread')}</span></span>`
      b.addEventListener('click', () => this.actions.focusThread?.(t.id))
      list.appendChild(b)
    }
    if (items.length > shown.length) {
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'fd-more'
      more.textContent = `+${items.length - shown.length}`
      more.title = 'Next bot waiting on you (N)'
      more.addEventListener('click', () => this.actions.focusStatus?.('waiting'))
      list.appendChild(more)
    }
  }

  setStats(stats) {
    for (const def of STAT_DEFS) {
      const n = stats[def.key] ?? 0
      const el = this.statEls[def.key]
      if (this._last['stat:' + def.key] === n) continue
      this._last['stat:' + def.key] = n
      el.querySelector('.n').textContent = String(n)
      el.dataset.empty = String(n === 0)
    }
  }

  setUsage(threads) {
    this.usage = usageStats(threads)
    this.usageThreads = threads
    this.$('#btn-usage .usage-total').textContent = this.usage.measured ? `${formatTokens(this.usage.totalTokens)} tokens` : 'View usage'
    this.officeHub?.setData(threads, this.officeSnapshot, this.usage, this.energyWarnings)
  }

  setOffice(snapshot, warnings = []) {
    this.officeSnapshot = snapshot; this.energyWarnings = warnings
    this.officeHub?.setData(this.usageThreads || [], snapshot, this.usage, warnings)
  }

  _renderUsage() {
    const report = this.usage || usageStats([])
    const tab = this.usageTab || 'assistants'
    for (const button of this.el.querySelectorAll('[data-usage-tab]')) button.setAttribute('aria-pressed', String(button.dataset.usageTab === tab))
    this.$('.usage-summary').innerHTML = [
      ['Tokens recorded', report.measured ? formatTokens(report.totalTokens) : 'Unknown'],
      ['Input · includes cache', report.measured ? formatTokens(report.inputTokens) : 'Unknown'],
      ['Output', report.measured ? formatTokens(report.outputTokens) : 'Unknown'],
      ['Sessions with usage', `${report.measured} / ${report.sessions}`],
    ].map(([label, value]) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')
    this.$('.usage-coverage').textContent = `Scanned local sessions, including hidden and archived rooms. ${report.partial ? `${report.partial} session(s) have partial usage. ` : ''}Subagent logs and cloud-only work are excluded; this is not an account bill.`
    const time = at => at ? new Date(at).toLocaleString() : 'Unknown'
    const windowName = minutes => minutes >= 1440 ? `${Math.round(minutes / 1440)}-day window` : `${minutes / 60}-hour window`
    this.$('.usage-allowances').innerHTML = report.assistants.map(assistant => {
      const limits = report.limits.filter(limit => limit.assistant === assistant.label)
      const windows = limits.flatMap(limit => limit.windows.map(window => {
        const status = allowanceWindow(window, limit.observedAt)
        const remaining = status.remainingPercent === null ? 'Awaiting new report' : `${Math.round(status.remainingPercent)}% left${status.stale ? ' · older snapshot' : ' · last reported'}`
        return `<div class="allowance-window"><div><span>${escapeHtml(limit.name || limit.id)} · ${escapeHtml(windowName(window.windowMinutes))}</span><strong>${remaining}</strong></div>
          ${status.expired ? '' : `<meter min="0" max="100" value="${status.remainingPercent}" aria-label="Last reported allowance remaining"></meter>`}
          <small>Reset: ${escapeHtml(time(window.resetsAt))} · Reported: ${escapeHtml(time(limit.observedAt))}</small></div>`
      }))
      const providerUrl = assistant.id === 'codex' ? 'https://chatgpt.com/codex/settings/usage' : assistant.id === 'claude-code' ? 'https://claude.ai/settings/usage' : ''
      return `<article><h4>${escapeHtml(assistant.label)}</h4>${windows.length ? windows.join('') : '<p>Remaining allowance unavailable in local records.</p>'}${providerUrl ? `<a href="${providerUrl}" target="_blank" rel="noopener noreferrer">View provider usage ↗</a>` : ''}</article>`
    }).join('') || '<p>No assistants detected yet.</p>'
    this.$('.usage-table-wrap').innerHTML = `<table><thead><tr><th>${tab === 'repos' ? 'Repository' : tab === 'models' ? 'Model' : 'Assistant'}</th><th>Input</th><th>Cached input</th><th>Output</th><th>Total</th></tr></thead><tbody>${report[tab].map(row =>
      `<tr><th scope="row">${escapeHtml(row.label)}${row.assistant ? `<small>${escapeHtml(row.assistant)}</small>` : `<small>${row.measured} / ${row.sessions} sessions reporting</small>`}</th>${['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].map(key => `<td title="${row.measured ? exactTokens(row[key]) : 'Usage unavailable'}">${row.measured ? formatTokens(row[key]) : 'Unknown'}</td>`).join('')}</tr>`
    ).join('') || '<tr><td colspan="5">No recorded usage for this view yet.</td></tr>'}</tbody></table>`
  }

  toggleUsage(force) {
    const panel = this.$('.usage-dashboard')
    const open = force ?? !panel.classList.contains('open')
    panel.classList.toggle('open', open)
    panel.inert = !open
    this.$('#btn-usage').setAttribute('aria-expanded', String(open))
    if (open) { this.officeHub?.onOpen(); this.$('#btn-close-usage').focus({ preventScroll: true }) }
    else if (panel.contains(document.activeElement)) this.$('#btn-usage').focus({ preventScroll: true })
  }

  /**
   * Every repo, in the sidebar. This was a strip of chips along the bottom of the screen;
   * it is a list now because the sidebar is where all the chrome lives, and because a list
   * can carry a count and an alarm without running out of room at eleven repos.
   */
  setLegend(projects, activeName = null, hidden = [], folded = []) {
    const signature =
      projects.map((p) => `${p.name}:${p.count}:${p.accent}:${p.urgent ? 1 : 0}`).join('|') +
      `~${activeName}~` +
      hidden.map((p) => `${p.name}:${p.count}`).join('|') +
      `~${folded.length}`
    if (this._last.legend === signature) return
    this._last.legend = signature

    this._accents = new Map(projects.map((p) => [p.name, p.accent]))
    const wrap = this.$('.projects')
    wrap.innerHTML = ''
    for (const p of projects) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'repo'
      b.title = `${p.count} thread${p.count === 1 ? '' : 's'} in ${p.name}`
      b.setAttribute('aria-pressed', String(p.name === activeName))
      b.innerHTML =
        `<i class="swatch" style="background:${hex(p.accent)};color:${hex(p.accent)}"></i>` +
        `<span class="n">${escapeHtml(p.name)}</span>` +
        (p.urgent ? '<i class="alarm"></i>' : '') +
        `<span class="count">${p.count}</span>`
      b.addEventListener('click', () => this.actions.pickProject?.(p.name))
      wrap.appendChild(b)
    }
    this.$('.sec-head span').textContent = `${projects.length} repo${projects.length === 1 ? '' : 's'}`

    // The hidden list is its own block at the foot of the sidebar: collapsed by default, because
    // the whole point of hiding a repo is not to look at it.
    const block = this.$('.hidden-block')
    block.hidden = hidden.length === 0 && folded.length === 0
    const hiddenWrap = this.$('.hidden-projects')
    hiddenWrap.innerHTML = ''
    for (const p of hidden) {
      const accent = PLOT_PALETTE[hashString(p.name) % PLOT_PALETTE.length]
      const row = document.createElement('div')
      row.className = 'repo hidden-repo'
      row.innerHTML =
        `<i class="swatch" style="background:${hex(accent)};color:${hex(accent)}"></i>` +
        `<span class="n">${escapeHtml(p.name)}</span>` +
        `<span class="count">${p.count}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = `Bring ${p.name}’s room back`
      show.textContent = 'Show'
      show.addEventListener('click', () => this.actions.unhideProject?.(p.name))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    // The dormant fold gets one line rather than a row each: it is a setting, not a list of
    // decisions, and the thing worth offering is the way back rather than per-repo control.
    if (folded.length) {
      const n = folded.reduce((sum, p) => sum + p.count, 0)
      const row = document.createElement('div')
      row.className = 'repo hidden-repo folded-note'
      row.innerHTML =
        `<span class="n">${folded.length} quiet repo${folded.length === 1 ? '' : 's'}` +
        `, ${n} thread${n === 1 ? '' : 's'}</span>`
      const show = document.createElement('button')
      show.type = 'button'
      show.className = 'btn ghost show-repo'
      show.title = 'Bring the quiet rooms back'
      show.textContent = 'Show'
      show.addEventListener('click', () => this.settings.set('hideDormant', false))
      row.appendChild(show)
      hiddenWrap.appendChild(row)
    }

    const total = hidden.length + folded.length
    this.$('#btn-hidden-toggle .label').textContent = `${total} ${total === 1 ? 'room' : 'rooms'} put away`
    this._syncHiddenList()
  }

  toggleHiddenList() {
    this.hiddenOpen = !this.hiddenOpen
    this._syncHiddenList()
  }

  _syncHiddenList() {
    this.$('#btn-hidden-toggle').setAttribute('aria-expanded', String(this.hiddenOpen))
    this.$('.hidden-projects').hidden = !this.hiddenOpen
  }

  /**
   * The project sidebar: what a zone is, and the things you can do to the *repo* rather
   * than to one thread in it. Opened by clicking a zone, its name plate, its legend chip,
   * or any bot standing on it.
   */
  setProject(project) {
    const panel = this.$('.side')
    if (!project) {
      this.project = null
      if (this._last.project === null) return
      this._last.project = null
      panel.classList.remove('drilled')
      panel.classList.remove('open')
      this._syncLayout()
      return
    }

    this.project = project
    // On a phone, opening a repo pulls the sheet up so its threads are in view — unless an
    // bot was just picked, whose card wants the room above the sheet's peek.
    if (this.isPhone() && !this.selected && !panel.classList.contains('open')) {
      panel.classList.add('open')
      this._syncLayout()
    }
    // The minute is part of the signature because `ago()` is: without it a repo where
    // nothing is happening keeps whatever "4m ago" it was first drawn with, for as long as
    // you leave the panel open.
    const signature =
      `${project.name}~${project.path}~${project.accent}~${project.selectedId}~${Math.floor(Date.now() / 60000)}~` +
      project.threads.map((t) => `${t.id}:${t.status}:${t.title}:${t.lastActivityAt}`).join('|')
    panel.classList.add('drilled')
    if (this._last.project === signature) return
    this._last.project = signature

    const swatch = this.$('.side .who .swatch')
    swatch.style.background = hex(project.accent)
    swatch.style.color = hex(project.accent) // the halo is `currentColor`
    this.$('.side .name').textContent = project.name
    const path = this.$('.side .path')
    path.textContent = project.path ? shortPath(project.path) : 'folder unknown'
    path.title = project.path || ''
    // Nothing to open a new thread in, and nothing to reveal, without a folder on disk.
    this.$('#btn-new-session').disabled = !project.path
    this.$('#btn-reveal').disabled = !project.path
    this.$('#btn-copy-path').disabled = !project.path

    const n = project.threads.length
    const waiting = project.threads.filter((t) => t.status === 'waiting' || t.status === 'blocked').length
    this.$('.side .threads-head').innerHTML =
      `<span>${n} thread${n === 1 ? '' : 's'}</span>` + (waiting ? `<span class="want">${waiting} need you</span>` : '')

    const list = this.$('.side .threads')
    // A poll rewrites these rows every time a live thread's timestamp moves. Losing your
    // place in a forty-thread repo every fifteen seconds would make the list unusable.
    const scroll = list.scrollTop
    list.innerHTML = ''
    for (const t of project.threads) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `thread ${statusClass(t.status)}`
      b.setAttribute('aria-pressed', String(t.id === project.selectedId))
      b.title = STATUS_LABEL[t.status] || t.status
      b.innerHTML =
        '<i class="pip"></i>' +
        `<span class="t">${escapeHtml(t.title || 'Untitled thread')}</span>` +
        `<span class="when">${ago(t.lastActivityAt)}</span>` +
        (t.worktree ? `<span class="wt">⑂ ${escapeHtml(t.worktree)}</span>` : '')
      b.addEventListener('click', () => this.actions.focusThread?.(t.id))
      list.appendChild(b)
      // A long repo can hide the bot you just clicked in the world. Scrolled by hand
      // rather than with `scrollIntoView`, which walks up the ancestors and will happily
      // scroll the *page* — and a page that can scroll at all is one keystroke away from
      // the whole HUD sitting sideways with nothing to put it back.
      if (t.id === project.selectedId && this._scrolledTo !== t.id) {
        this._scrolledTo = t.id
        const row = b
        requestAnimationFrame(() => {
          const top = row.offsetTop
          const bottom = top + row.offsetHeight
          if (top < list.scrollTop) list.scrollTop = top
          else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
        })
      }
    }
    list.scrollTop = scroll
    if (!project.selectedId) this._scrolledTo = null
  }

  /**
   * The selected thread, shown inside the zone sidebar rather than in a panel of its own —
   * one thread and its repo are the same context, and splitting them across the screen made
   * you look in two places to act on one bot.
   */
  setSelection(agent, thread) {
    const card = this.$('.thread-pop')
    // Only ever one accent button in the panel: whichever action is the immediate one.
    this.$('#btn-new-session').classList.toggle('primary', !agent || !thread)
    if (!agent || !thread) {
      card.classList.remove('on')
      this.selected = null
      return
    }
    this.selected = { agent, thread }
    card.classList.add('on')
    // On a phone the card docks above the sheet's peek, so the sheet drops to make room.
    if (this.isPhone()) this.toggleSheet(false)

    // A staff badge: the repo is the department band across the top, in the room's colour;
    // the thread is the name; the agent is the role; the status is a presence light.
    this.$('.thread-pop .title').textContent = thread.title || 'Untitled thread'
    this.$('.thread-pop .repo-name').textContent = thread.project || 'Unknown repository'
    this.$('.thread-pop .repo-path').textContent = thread.cwd || thread.projectPath || 'No working folder recorded'
    this.$('.thread-pop .repo-path').title = thread.cwd || thread.projectPath || ''
    const accent = this._accents?.get(thread.project)
    card.style.setProperty('--dept', accent != null ? hex(accent) : 'var(--mullion)')
    card.style.setProperty('--presence', hex(agent.trim.getHex()))
    const status = STATUS_LABEL[agent.status] || agent.status
    const where = thread.source === 'vscode' && thread.harness !== 'vscode-chat' ? ' in VS Code' : ''
    this.$('.thread-pop .role').textContent = `${thread.harnessName || 'Agent'}${where}`
    this.$('.thread-pop .state').innerHTML = `<span class="now">${escapeHtml(status)}</span><span class="when">${ago(thread.lastActivityAt)}</span>`
    const facts = []
    if (thread.gitBranch) facts.push(['Branch', thread.gitBranch])
    if (thread.worktree) facts.push(['Worktree', thread.worktree])
    if (thread.model) facts.push(['Model', shortModel(thread.model)])
    if (thread.usage?.known) {
      const u = thread.usage
      facts.push(['Tokens recorded', `${formatTokens(u.totalTokens)}${u.coverage === 'partial' ? ' · partial' : ''}`])
      facts.push(['Input / output', `${formatTokens(u.inputTokens)} / ${formatTokens(u.outputTokens)}`])
      if (u.cachedInputTokens) facts.push(['Cached input', formatTokens(u.cachedInputTokens)])
    } else facts.push(['Token usage', 'Unavailable in local records'])
    const context = contextRemaining(thread.usage?.context)
    if (context) facts.push(['Context headroom', `${thread.usage.context.basis === 'last-call' ? '~' : ''}${formatTokens(context.remaining)} · last report`])
    if (thread.usage?.copilotCredits != null) facts.push(['Copilot credits used', String(thread.usage.copilotCredits)])
    this.$('.thread-pop .meta').innerHTML = facts
      .map(([k, v]) => `<div class="fact"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`)
      .join('')

    const pct = Math.round((this.actions.progressFor?.(thread.id) ?? 0) * 100)
    this.$('.thread-pop .progress > i').style.width = `${pct}%`
    this.$('.thread-pop .progress > i').style.background = hex(agent.trim.getHex())
    // Measured once per selection rather than per frame: placing the card beside its
    // bot needs its size sixty times a second, and asking the layout for it that
    // often is how a HUD starts costing frames.
    this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
    this.$('#btn-open').disabled = thread.canOpen === false
    // Only offered when there is something to dismiss. A third button on every card would
    // crowd the two that are always worth having, and "Viewed" on a thread that is not asking
    // for anything is a control with no effect.
    this.$('#btn-viewed').hidden = !thread.unread
  }

  /** The message slip: chips fill the box, Enter sends, Shift+Enter starts a new line. */
  _wireCompose() {
    const form = this.$('.thread-pop .compose')
    const text = this.$('#compose-text')
    const fit = () => {
      text.style.height = 'auto'
      text.style.height = `${Math.min(text.scrollHeight, 132)}px`
      this._measureCard()
    }
    const send = async (via) => {
      const message = text.value.trim()
      if (!message || this._sending) return
      this._sending = true
      form.classList.add('sending')
      const sent = await this.actions.sendMessage?.(message, via)
      this._sending = false
      form.classList.remove('sending')
      if (sent) {
        text.value = ''
        fit()
      }
    }
    text.addEventListener('input', fit)
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        send()
      } else if (e.key === 'Escape') {
        text.blur()
      }
    })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      send()
    })
    this.$('#btn-send-app').addEventListener('click', () => send('app'))
    for (const chip of form.querySelectorAll('.say')) {
      chip.addEventListener('click', () => {
        text.value = chip.dataset.say
        fit()
        text.focus()
        text.setSelectionRange(text.value.length, text.value.length)
      })
    }
    const edits = this.$('#compose-edits')
    edits.checked = Boolean(this.settings.get('messageEdits'))
    edits.addEventListener('change', () => {
      this.settings.set('messageEdits', edits.checked)
      this.setCompose(this._composePlan, this._composeOptions)
    })
  }

  /**
   * How a message to the selected bot would travel, said before anything is typed.
   * `plan` is the server's answer, or `{ ok: false, error }` when this thread takes none.
   */
  setCompose(plan, { running = false } = {}) {
    this._composePlan = plan
    this._composeOptions = { running }
    const form = this.$('.thread-pop .compose')
    const how = this.$('.thread-pop .compose .how')
    const ok = Boolean(plan?.ok)
    form.hidden = !plan
    form.classList.toggle('off', !ok)
    this.$('#compose-text').disabled = !ok
    this.$('#btn-send').disabled = !ok || Boolean(plan?.busy)
    const background = ok && plan.mode === 'background'
    this.$('.thread-pop .compose .edits').hidden = !background
    this.$('#compose-edits').checked = Boolean(this.settings.get('messageEdits'))
    // The app is a second door only when the first one is the background.
    this.$('#btn-send-app').hidden = !background
    let line = ''
    if (!ok) line = plan?.error || 'This thread cannot take messages'
    else if (plan.busy) line = 'Still on your last message'
    else if (background) line = this.settings.get('messageEdits')
      ? `Runs with ${plan.label || 'its CLI'} and can edit files; the reply lands here`
      : `Read-only reply with ${plan.label || 'its CLI'}; enable edits or use the app to continue implementation`
    else if (plan.prefilled) line = running ? 'Mid-turn, so this opens the thread with your message typed in' : 'Opens the thread with your message typed in'
    else line = 'Opens the thread and copies your message to paste'
    how.textContent = line
    this._measureCard()
  }

  /** The latest background reply for the selected bot: working on it, its answer, or why not. */
  setReply(job) {
    const box = this.$('.thread-pop .compose .reply')
    if (!job) {
      box.hidden = true
      this._measureCard()
      return
    }
    box.hidden = false
    box.dataset.status = job.status
    const took = Math.max(1, Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000))
    const span = took < 60 ? `${took}s` : `${Math.floor(took / 60)}m ${String(took % 60).padStart(2, '0')}s`
    this.$('.thread-pop .compose .reply .who').textContent =
      job.status === 'running' ? `Working on it · ${span}` : job.status === 'done' ? `Replied after ${span}` : 'Could not finish'
    this.$('.thread-pop .compose .reply .text').textContent =
      job.status === 'running' ? '' : job.status === 'done' ? job.reply || 'Done — nothing to say back.' : job.error || 'It stopped without a reply.'
    this._measureCard()
  }

  /** A different bot: its slip starts empty rather than with the last one's draft. */
  clearCompose() {
    const text = this.$('#compose-text')
    text.value = ''
    text.style.height = 'auto'
  }

  /** Put the cursor in the message box (R). */
  focusCompose() {
    const text = this.$('#compose-text')
    if (!this.selected || text.disabled) return false
    text.focus()
    return true
  }

  _measureCard() {
    const card = this.$('.thread-pop')
    if (card.classList.contains('on')) this._cardSize = { w: card.offsetWidth, h: card.offsetHeight }
  }

  /**
   * Put the thread card beside its own bot, in screen space, every frame.
   *
   * `screen` is where the bot is right now, in CSS pixels, or null when it is behind
   * the camera. The card prefers the bot's right, flips to its left rather than slide
   * under the sidebar, and never leaves the window — so it stays reachable at any zoom
   * without ever covering the thing it is describing.
   */
  placeCard(screen) {
    const el = this.$('.thread-pop')
    if (!screen || !this.selected) {
      if (this._cardOn) {
        this._cardOn = false
        el.classList.remove('on')
      }
      return
    }
    // On a phone the card is docked above the sheet by the stylesheet; nothing to place.
    if (this.isPhone()) {
      if (!this._cardOn) {
        this._cardOn = true
        el.classList.add('on')
      }
      return
    }
    const size = this._cardSize || { w: 280, h: 150 }
    const margin = 12
    const gap = 26
    const rightWall = window.innerWidth - margin - (this._sideWidth || 0)

    let flip = false
    let left = screen.x + gap
    if (left + size.w > rightWall) {
      left = screen.x - gap - size.w
      flip = true
      // Nowhere to go on either side — sit over the middle rather than off the edge.
      if (left < margin) left = Math.min(Math.max(margin, screen.x - size.w / 2), rightWall - size.w)
    }
    const top = Math.min(Math.max(margin, screen.y - size.h / 2), window.innerHeight - margin - size.h)

    if (!this._cardOn) {
      this._cardOn = true
      el.classList.add('on')
    }
    // Whole pixels, and only when it actually moved: a transform written every frame with a
    // fractional delta is a repaint the compositor cannot skip.
    const x = Math.round(left)
    const y = Math.round(top)
    if (x !== this._cardX || y !== this._cardY) {
      this._cardX = x
      this._cardY = y
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    // The nib points back at the bot, so it changes sides with the card.
    if (flip !== this._cardFlip) {
      this._cardFlip = flip
      el.classList.toggle('flip', flip)
    }
    // And it tracks the bot vertically when the card has been pushed off-centre.
    const nib = Math.min(Math.max(14, screen.y - y), size.h - 14)
    if (nib !== this._cardNib) {
      this._cardNib = nib
      el.style.setProperty('--nib-y', `${Math.round(nib)}px`)
    }
  }

  /** Share one measured safe area between camera framing, cards, and the legend. */
  _syncLayout() {
    const width = this.el.clientWidth
    const height = this.el.clientHeight
    const side = this.$('.side')
    const rail = this.$('.rail')
    let right = 0
    let bottom = 0
    let left = 0
    if (this.visible) {
      if (this.isPhone()) {
        // Use the sheet's destination, not an intermediate animation transform.
        const peek = parseFloat(getComputedStyle(this.el).getPropertyValue('--peek')) || 0
        const top = side.offsetTop + (side.classList.contains('open') ? 0 : side.offsetHeight - peek)
        bottom = Math.max(0, height - top)
      } else {
        right = Math.max(0, width - side.offsetLeft)
        // The button rail floats over the left edge; the view centres in what is left beside it.
        if (rail) left = Math.max(0, rail.offsetLeft + rail.offsetWidth)
      }
    }
    this._sideWidth = right
    this.el.style.setProperty('--side', `${right}px`)
    this.actions.viewportChanged?.({ width, height, right, bottom, left })
  }

  /** Redraw the card's face so it blinks in step with the bot it belongs to. */
  updateAvatar(faceAtlasCanvas) {
    if (!this.selected || !faceAtlasCanvas) return
    const agent = this.selected.agent
    const frame = agent.faceFrame ?? FACE.idle
    const color = agent.eye
    const css = cssFromGlow(color)
    if (this._avatarState.frame === frame && this._avatarState.color === css) return
    this._avatarState = { frame, color: css }

    const size = 108
    const cell = faceAtlasCanvas.width / FRAME_COLS
    const sx = (frame % FRAME_COLS) * cell
    const sy = Math.floor(frame / FRAME_COLS) * (faceAtlasCanvas.height / FRAME_ROWS)

    // The atlas is an opaque white-on-black mask, so the tint is a `multiply`, not a
    // `source-in`: black stays black and the white features take the eye colour. Keying on
    // alpha instead would flood the whole cell, because every pixel in it is opaque.
    const t = this.avatarTmpCtx
    t.globalCompositeOperation = 'source-over'
    t.clearRect(0, 0, size, size)
    t.drawImage(faceAtlasCanvas, sx, sy, cell, cell, 0, 0, size, size)
    t.globalCompositeOperation = 'multiply'
    t.fillStyle = css
    t.fillRect(0, 0, size, size)
    t.globalCompositeOperation = 'source-over'

    const c = this.avatarCtx
    c.fillStyle = '#06070c'
    c.fillRect(0, 0, size, size)
    c.drawImage(this.avatarTmp, 0, 0)
    // Scanlines, so the card's face reads as the same little screen as the one in the world.
    c.globalAlpha = 0.2
    c.fillStyle = '#000'
    for (let y = 0; y < size; y += 3) c.fillRect(0, y, size, 1)
    c.globalAlpha = 1
  }

  setFps(perf, viewport, extra) {
    if (!this.settings.get('showFps')) return
    const el = this.$('.fps')
    const fps = Math.round(perf.fps)
    if (this._last.fps === fps && this._last.calls === perf.drawCalls) return
    this._last.fps = fps
    this._last.calls = perf.drawCalls
    el.innerHTML =
      `<b>${fps}</b> fps · ${perf.frameMs.toFixed(1)} ms<br>` +
      `${perf.drawCalls} draws · ${(perf.triangles / 1000).toFixed(0)}k tris<br>` +
      // The setting is a share of the display, so the readout is too — otherwise a retina
      // machine sitting exactly on the 100% slider reads back "200%".
      `${viewport.bw}×${viewport.bh} (${Math.round((viewport.scale / (window.devicePixelRatio || 1)) * 100)}%)` +
      (extra ? `<br>${extra}` : '')
  }

  hint(text, ms = 3200) {
    const el = this.$('.hint-pill')
    el.textContent = text
    el.classList.add('on')
    clearTimeout(this._hintTimer)
    this._hintTimer = setTimeout(() => el.classList.remove('on'), ms)
  }

  toast(message, kind = '') {
    const el = document.createElement('div')
    el.className = `toast panel ${kind}`
    el.textContent = message
    this.$('.toasts').appendChild(el)
    setTimeout(() => {
      el.classList.add('leaving')
      setTimeout(() => el.remove(), 260)
    }, 3600)
  }

  // ── visibility ──────────────────────────────────────────────────────────────────────

  /** Reflect orbit mode on the rail button. */
  setOrbit(on) {
    this.$('#btn-orbit').setAttribute('aria-pressed', String(Boolean(on)))
  }

  /** Whether the layout is the phone one: the sheet, the docked card, the top rail. */
  isPhone() {
    return window.matchMedia('(max-width: 600px)').matches
  }

  /** Pull the sidebar sheet up over the atrium, or let it drop to its peek. Phone only. */
  toggleSheet(force) {
    const side = this.$('.side')
    const open = force ?? !side.classList.contains('open')
    side.classList.toggle('open', open)
    this._syncLayout()
    return open
  }

  toggleSettings(force) {
    const panel = this.$('.settings')
    const open = force ?? panel.classList.contains('closed')
    panel.classList.toggle('closed', !open)
    this.$('#btn-settings').setAttribute('aria-pressed', String(open))
    // Settings replaces the sidebar in its existing slot, including for keyboard users.
    const side = this.$('.side')
    side.classList.toggle('covered', open)
    side.inert = open
    panel.inert = !open
    if (open) this.$('#btn-close-settings').focus({ preventScroll: true })
    else if (panel.contains(document.activeElement)) this.$('#btn-settings').focus({ preventScroll: true })
  }

  toggleHelp(force) {
    const el = this.$('.help')
    const open = force ?? !el.classList.contains('open')
    el.classList.toggle('open', open)
  }

  /**
   * Dismiss everything. This is the mode the game is really meant to be left in — the
   * atrium carries its own state above the bots' heads, so the panels are for
   * setting things up, not for playing.
   */
  toggleUi(force) {
    this.visible = force ?? !this.visible
    this.el.classList.toggle('hidden', !this.visible)
    this.$('#btn-hide').innerHTML = this.visible ? ICON.eye : ICON.eyeOff
    this.actions.uiVisibility?.(this.visible)
    this._syncLayout()
    if (!this.visible) this.toggleHelp(false)
    if (!this.visible) this.toggleUsage(false)
    return this.visible
  }

  removeBoot() {
    const boot = document.querySelector('.boot')
    if (!boot) return
    boot.classList.add('gone')
    setTimeout(() => boot.remove(), 550)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

function group(title, child) {
  const el = document.createElement('div')
  el.className = 'group'
  el.innerHTML = `<h3>${title}</h3>`
  if (child) el.appendChild(child)
  return el
}

function chips(items, current, onPick, registry) {
  const wrap = document.createElement('div')
  wrap.className = 'chips'
  const buttons = []
  for (const item of items) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip'
    b.textContent = item.label
    if (item.title) b.title = item.title
    b.addEventListener('click', () => onPick(item.id))
    wrap.appendChild(b)
    buttons.push([item.id, b])
  }
  registry.push({
    el: wrap,
    sync: () => {
      const now = current()
      for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === now))
    },
  })
  return wrap
}

const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6)
/**
 * Eye colours are authored above 1.0 so the bloom pass catches them in the scene. For the
 * card they are normalised by the brightest channel — which keeps the hue the bot
 * actually has rather than clipping a 3.0-red down to the same white as a 3.0-blue.
 */
function cssFromGlow(color) {
  const peak = Math.max(color.r, color.g, color.b, 1)
  const enc = (v) => Math.round(Math.pow(Math.min(1, v / peak), 1 / 2.2) * 255)
  return `rgb(${enc(color.r)},${enc(color.g)},${enc(color.b)})`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** Status → the colour family the top-bar counters already use for it. */
function statusClass(status) {
  if (status === 'working') return 'working'
  if (status === 'waiting') return 'waiting'
  if (status === 'blocked') return 'blocked'
  if (status === 'celebrating') return 'done'
  return 'idle'
}

/**
 * A path that fits, trimmed from the *left* so the repo end survives — the deep end is the
 * part that identifies it. CSS can only ellipsise the tail, and `direction: rtl` mangles a
 * leading `~`, so the trim is done here and the whole path lives in the title attribute.
 */
export function shortPath(dir, max = 30) {
  // Windows paths keep their own separator, so the trimmed form reads like the real one.
  const sep = /^[a-z]:\\/i.test(dir) || dir.startsWith('\\\\') ? '\\' : '/'
  const home = dir
    .replace(/^\/(?:Users|home)\/[^/]+/, '~')
    .replace(/^[a-z]:\\Users\\[^\\]+/i, '~')
  if (home.length <= max) return home
  const parts = home.split(sep)
  let out = parts.pop() || ''
  while (parts.length) {
    const next = parts.pop()
    if (out.length + next.length + 3 > max) break
    out = `${next}${sep}${out}`
  }
  return `…${sep}${out}`
}

function shortModel(model) {
  return String(model).replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function ago(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const TEMPLATE = `
<aside class="side panel">
  <div class="grab"></div>
  <header class="brandbar">
    <div class="brand">${MARK}<span>Agent Atrium</span></div>
    <button class="btn icon ghost" id="btn-shot" title="Screenshot (P)">${ICON.camera}</button>
    <button class="btn icon ghost" id="btn-help" title="Help (?)">${ICON.help}</button>
    <button class="btn icon ghost" id="btn-hide" title="Hide all UI (H)">${ICON.eye}</button>
    <button class="btn icon ghost" id="btn-settings" title="Settings (S)" aria-pressed="false">${ICON.settings}</button>
  </header>

  <div class="stats"></div>
  <button class="btn ghost usage-launch" id="btn-usage" aria-expanded="false"><span>Visit Atlas · HQ</span><span class="usage-total">Office stats</span></button>

  <div class="side-body">
    <div class="projects-pane">
      <div class="sec-head"><span>Repos</span></div>
      <div class="projects"></div>
      <div class="hidden-block" hidden>
        <button type="button" class="hidden-toggle" id="btn-hidden-toggle" aria-expanded="false">
          <span class="label">0 hidden</span>
        </button>
        <div class="hidden-projects" hidden></div>
      </div>
    </div>

    <div class="project-detail">
      <button class="btn ghost back" id="btn-close-project" title="Back to every repo (Esc)">${ICON.back} All repos</button>
      <div class="who">
        <i class="swatch"></i>
        <div class="text">
          <div class="name"></div>
          <div class="path"></div>
        </div>
        <button class="btn icon ghost" id="btn-locate" title="Fly to this room">${ICON.locate}</button>
      </div>
      <div class="project-actions">
        <button class="btn primary" id="btn-new-session" title="Start a new thread in this folder (C)">${ICON.plus} New conversation</button>
        <div class="pair">
          <button class="btn" id="btn-reveal" title="Show this folder in ${FILE_MANAGER}">${ICON.folder} ${FILE_MANAGER}</button>
          <button class="btn" id="btn-copy-path" title="Copy the folder path">${ICON.copy} Copy path</button>
        </div>
        <button class="btn" id="btn-hide-project" title="Hide this repo’s room — does not archive its threads">${ICON.eyeOff} Hide room</button>
      </div>
      <div class="threads-head"></div>
      <div class="threads"></div>
    </div>
  </div>
</aside>

<div class="rail panel">
  <button class="btn icon" id="btn-home" title="Reset the view (0)">${ICON.home}</button>
  <button class="btn icon" id="btn-next" title="Next bot waiting on you (N)">${ICON.next}</button>
  <div class="sep"></div>
  <button class="btn icon" id="btn-orbit" title="Orbit mode — sweep around the office (O)" aria-pressed="false">${ICON.orbit}</button>
  <button class="btn icon" id="btn-planet" title="Next office style (Tab)">${ICON.sun}</button>
  <div class="sep"></div>
  <button class="btn icon" id="btn-sound" title="Mute (M)" aria-pressed="true">${ICON.sound}</button>
</div>

<div class="settings panel closed" inert>
  <header>Settings <button class="btn icon ghost" id="btn-close-settings" title="Close">${ICON.close}</button></header>
  <div class="body"></div>
</div>

<div class="usage-dashboard" inert>
  <section class="panel usage-sheet" role="dialog" aria-modal="true" aria-labelledby="usage-title">
    <header><div><h2 id="usage-title">Office stats</h2><p>Tokens, models and remaining allowances</p></div><button class="btn icon ghost" id="btn-close-usage" aria-label="Close office stats">${ICON.close}</button></header>
    <div class="usage-body">
      <div class="usage-summary"></div>
      <p class="usage-coverage"></p>
      <h3>Assistant allowances</h3>
      <p class="usage-note">Provider limits may be shared across models. These are local snapshots, not live account balances. An expired window needs a new report.</p>
      <div class="usage-allowances"></div>
      <div class="usage-tabs" aria-label="Usage breakdown"><button class="btn" data-usage-tab="assistants" aria-pressed="true">Assistants</button><button class="btn" data-usage-tab="models" aria-pressed="false">Models</button><button class="btn" data-usage-tab="repos" aria-pressed="false">Repositories</button></div>
      <div class="usage-table-wrap"></div>
      <p class="usage-note">Cache and reasoning tokens are already included in input or output totals. Context headroom on a bot is separate from your subscription allowance.</p>
    </div>
  </section>
</div>

<div class="thread-pop panel badge">
  <i class="nib"></i>
  <span class="clip" aria-hidden="true"></span>
  <div class="band">
    <span class="repo-name"></span>
    <button class="btn icon ghost" id="btn-follow" title="Follow this bot" aria-label="Follow this bot" aria-pressed="false">${ICON.locate}</button>
    <button class="btn icon ghost" id="btn-deselect" title="Put the badge away (Esc)">${ICON.close}</button>
  </div>
  <div class="top">
    <div class="avatar"><canvas></canvas><i class="presence"></i></div>
    <div class="info">
      <div class="title"></div>
      <div class="role"></div>
      <div class="state"></div>
    </div>
  </div>
  <div class="meta"></div>
  <div class="progress" title="How far along this thread is"><i></i></div>
  <div class="repo-path"></div>
  <div class="pair">
    <button class="btn primary" id="btn-open" title="Open this thread in the harness it came from (Enter)">${ICON.open} Open</button>
    <button class="btn" id="btn-viewed" title="Stop this thread asking for you until it moves on again (V)">${ICON.eye} Viewed</button>
    <button class="btn" id="btn-archive" title="Archive — this bot heads back to reception (A)">${ICON.archive} Archive</button>
  </div>
  <form class="compose" novalidate>
    <div class="sayings" role="group" aria-label="Quick messages">
      <button type="button" class="say" data-say="Continue where you left off.">Continue</button>
      <button type="button" class="say" data-say="Where are you at? Give me a short update: what is done, what is left, and anything you need from me.">Where are you at?</button>
      <button type="button" class="say" data-say="Run the tests and fix whatever fails.">Run the tests</button>
    </div>
    <div class="field">
      <textarea id="compose-text" rows="1" maxlength="8000" placeholder="Tell it what to do next" aria-label="Message this bot"></textarea>
      <button type="submit" class="btn icon primary" id="btn-send" title="Send (Enter)" aria-label="Send">${ICON.send}</button>
    </div>
    <div class="route">
      <span class="how"></span>
      <label class="edits" title="Off: read-only replies. On: allow file edits using your agent CLI's configured permissions."><input type="checkbox" id="compose-edits"> Can edit files</label>
    </div>
    <button type="button" class="linkish" id="btn-send-app">Type it in the app instead</button>
    <div class="reply" hidden><div class="who"></div><div class="text"></div></div>
  </form>
</div>

<div class="frontdesk panel" hidden>
  <span class="fd-label">Front desk</span>
  <div class="fd-list"></div>
</div>

<div class="toasts"></div>
<div class="fps panel"></div>
<div class="hint-pill panel"></div>

<div class="help">
  <div class="sheet panel">
    <h2>Agent Atrium</h2>
    <p class="sub">Every coding-agent thread on this machine is a bot. Each repo gets a glass room with a desk for every thread. Bots arrive at reception, walk to their desks and get to work. Click a bot to see its staff badge and open its thread; click a room — its floor or its sign — for the repo itself, and start a new conversation there. Hide a room if you would rather not see it — its threads stay in your harness, and you can show it again from the list. Drag the floor to move, right-drag to tilt and turn, scroll to zoom in on whatever is under the cursor.</p>
    <div class="cols">
      <div>
        <div class="k"><span>Drag the floor</span><kbd>drag</kbd></div>
        <div class="k"><span>Tilt &amp; rotate</span><kbd>right-drag</kbd></div>
        <div class="k"><span>&nbsp;</span><kbd>⌃ or ⇧ + drag</kbd></div>
        <div class="k"><span>Zoom to cursor</span><kbd>scroll</kbd></div>
        <div class="k"><span>Move / zoom</span><kbd>arrows</kbd> <kbd>+ −</kbd></div>
        <div class="k"><span>Reset view</span><kbd>0</kbd></div>
        <div class="k"><span>Hide all UI</span><kbd>H</kbd> <kbd>${IS_MAC ? '⌘' : 'Ctrl'}\\</kbd></div>
        <div class="k"><span>Settings</span><kbd>S</kbd></div>
        <div class="k"><span>Screenshot</span><kbd>P</kbd></div>
      </div>
      <div>
        <div class="k"><span>Next needing you</span><kbd>N</kbd></div>
        <div class="k"><span>Open thread</span><kbd>Enter</kbd></div>
        <div class="k"><span>Message the bot</span><kbd>R</kbd></div>
        <div class="k"><span>Mark viewed</span><kbd>V</kbd></div>
        <div class="k"><span>Archive</span><kbd>A</kbd></div>
        <div class="k"><span>New conversation</span><kbd>C</kbd></div>
        <div class="k"><span>Orbit mode</span><kbd>O</kbd></div>
        <div class="k"><span>Office style</span><kbd>Tab</kbd></div>
        <div class="k"><span>Mute</span><kbd>M</kbd></div>
        <div class="k"><span>Deselect</span><kbd>Esc</kbd></div>
        <div class="k"><span>This sheet</span><kbd>?</kbd></div>
      </div>
    </div>
    <div style="margin-top:16px">
      <div class="legend-row"><i class="badge" style="background:#1a2b46;color:#8fb4ee">?</i> waiting on your reply. It also joins the front desk at the top</div>
      <div class="legend-row"><i class="badge" style="background:#3d1c1c;color:#e88b8b">!</i> the session hit an error</div>
      <div class="legend-row"><i class="badge" style="background:#16301f;color:#7fd39a">⌨</i> typing at its desk right now</div>
      <div class="legend-row"><i class="badge" style="background:#332b12;color:#e6c67f">✓</i> its pull request landed</div>
      <div class="legend-row"><i class="badge" style="background:#1d1f2e;color:#a9a8c0">z</i> quiet for three days, dozing by its desk</div>
    </div>
    <div style="margin-top:18px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btn-help-close">Got it</button>
    </div>
  </div>
</div>
`
