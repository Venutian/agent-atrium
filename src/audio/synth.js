/**
 * Procedural sound. Every name the registry knows can be made from Web Audio nodes alone,
 * so the atrium is fully audible with not one audio file in the repository — and when a real
 * sample does turn up in the manifest, it slots into exactly the same `Voice` shape, so the
 * mixer never has to know which it got.
 *
 * Two rules keep this honest for an always-open window. Nothing here allocates on a frame
 * unless it is actually making a new sound — a bed sitting idle is a buffer source, a filter
 * and a gain, and its `update` is a few multiplies. And nothing ever changes a gain by
 * assignment: every level goes through `setTargetAtTime` or a ramp, because a stepped gain is
 * a click, and one click is enough to get the whole layer muted for good.
 */

/** Noise loops are this long. Long enough that the ear never catches the repeat. */
const NOISE_SECONDS = 5
/** How much of the tail is blended back into the head so the loop point is inaudible. */
const NOISE_CROSSFADE = 0.5

const TAU = Math.PI * 2
const rand = (lo, hi) => lo + Math.random() * (hi - lo)

/**
 * One buffer each of white, pink and brown noise, built once per context. Generated a
 * crossfade's worth *longer* than the loop and folded over: the head is a blend of the true
 * head and the samples that would have followed the tail, so the last sample runs straight
 * into the first. For brown noise especially, whose whole character is low frequency, a
 * plain wrap is a thud every five seconds.
 */
export function createNoiseBuffers(ctx) {
  const rate = ctx.sampleRate
  const length = Math.floor(NOISE_SECONDS * rate)
  const fade = Math.floor(NOISE_CROSSFADE * rate)
  const total = length + fade

  const white = new Float32Array(total)
  const pink = new Float32Array(total)
  const brown = new Float32Array(total)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, walk = 0
  for (let i = 0; i < total; i++) {
    const w = Math.random() * 2 - 1
    white[i] = w
    // Paul Kellet's pink filter: cheap, and flat enough for wind.
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    pink[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
    b6 = w * 0.115926
    // Leaky integrator; the leak is what stops it wandering off to one rail.
    walk = (walk + 0.02 * w) / 1.02
    brown[i] = walk * 3.5
  }

  const out = {}
  for (const [name, data] of [['white', white], ['pink', pink], ['brown', brown]]) {
    const buffer = ctx.createBuffer(1, length, rate)
    const ch = buffer.getChannelData(0)
    let mean = 0
    for (let i = 0; i < length; i++) mean += data[i]
    mean /= length
    let peak = 1e-6
    for (let i = 0; i < length; i++) {
      let v = data[i] - mean
      if (i < fade) {
        // Equal-power blend keeps the loudness flat through the seam.
        const t = (i / fade) * Math.PI * 0.5
        v = (data[length + i] - mean) * Math.cos(t) + v * Math.sin(t)
      }
      ch[i] = v
      if (Math.abs(v) > peak) peak = Math.abs(v)
    }
    const norm = 0.9 / peak
    for (let i = 0; i < length; i++) ch[i] *= norm
    out[name] = buffer
  }
  return out
}

/**
 * A sound that is currently playing. Owns its own output gain so whoever started it can fade
 * it out and drop it without knowing what is behind it — three oscillators or one sample.
 * `until` is the context time by which a one-shot has finished; loops leave it infinite.
 */
export class Voice {
  constructor(ctx, dest) {
    this.ctx = ctx
    this.out = ctx.createGain()
    this.out.connect(dest)
    this.until = Infinity
    this.isSample = false
    this._sources = []
    this._nodes = [this.out]
  }

  /** Register a started source so `stop` reaches it. */
  source(node) {
    this._sources.push(node)
    return node
  }

  /** Register an intermediate node so `dispose` disconnects it. */
  node(node) {
    this._nodes.push(node)
    return node
  }

  /** Called every frame while alive — LFOs, swells, scheduled taps. Most voices do nothing. */
  update(dt, now) {}

  /** The pool's idea of how loud this source is (0..1); a rotor pitches up with it. */
  setLevel(level) {}

  stop(when) {
    for (let i = 0; i < this._sources.length; i++) {
      // A source that has already ended throws on a second stop; nothing to do about it.
      try {
        this._sources[i].stop(when)
      } catch {}
    }
  }

  dispose() {
    this.stop(this.ctx.currentTime)
    for (let i = 0; i < this._nodes.length; i++) {
      try {
        this._nodes[i].disconnect()
      } catch {}
    }
  }
}

/** A decoded file standing in for a synth. Loops with the manifest's trim, or plays once. */
export class SampleVoice extends Voice {
  constructor(ctx, dest, buffer, entry, loop) {
    super(ctx, dest)
    this.isSample = true
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const trim = Array.isArray(entry?.trim) ? entry.trim : null
    const start = trim ? Math.max(0, trim[0]) : 0
    const end = trim ? Math.min(buffer.duration, trim[1]) : buffer.duration
    src.connect(this.out)
    const now = ctx.currentTime
    if (loop) {
      src.loop = true
      src.loopStart = start
      src.loopEnd = end
      // A random offset so two copies of the same loop do not phase against each other.
      src.start(now, start + Math.random() * Math.max(0, end - start - 0.1))
    } else {
      src.start(now, start, Math.max(0.01, end - start))
      this.until = now + (end - start)
    }
    this.source(src)
  }
}

// ---------------------------------------------------------------------------------------------
// Small building blocks.

function looped(ctx, buffer, dest) {
  const s = ctx.createBufferSource()
  s.buffer = buffer
  s.loop = true
  s.connect(dest)
  // Random phase, for the same reason as the sample loop above.
  s.start(ctx.currentTime, Math.random() * buffer.duration * 0.9)
  return s
}

/** A slice of a noise buffer, played once. */
function burst(ctx, buffer, dest, when, duration) {
  const s = ctx.createBufferSource()
  s.buffer = buffer
  s.connect(dest)
  const offset = Math.random() * Math.max(0, buffer.duration - duration - 0.05)
  s.start(when, offset, duration)
  return s
}

function osc(ctx, type, freq, dest, when) {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.value = freq
  o.connect(dest)
  o.start(when)
  return o
}

function filter(ctx, type, freq, q = 1) {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  return f
}

function gain(ctx, value, dest) {
  const g = ctx.createGain()
  g.gain.value = value
  if (dest) g.connect(dest)
  return g
}

/**
 * Attack-hold-decay on a param. The decay is an exponential approach, which is what a
 * struck or blown thing actually does; `decay` is the time to fall to about 2%.
 * Returns when the envelope is effectively over.
 */
function envelope(param, now, peak, attack, decay, hold = 0) {
  param.setValueAtTime(0, now)
  param.linearRampToValueAtTime(peak, now + attack)
  param.setTargetAtTime(0, now + attack + hold, decay / 4)
  return now + attack + hold + decay
}

/**
 * One FM chirp: a sine that glides from `f0` to `f1`, optionally wobbled by a modulator, with
 * an attack/decay. Every bird here is a handful of these with a different contour.
 */
function chirp(ctx, dest, when, o) {
  const g = gain(ctx, 0, dest)
  const c = ctx.createOscillator()
  c.type = o.type || 'sine'
  c.frequency.setValueAtTime(o.f0, when)
  if (o.fMid !== undefined) {
    c.frequency.exponentialRampToValueAtTime(o.fMid, when + o.dur * 0.4)
    c.frequency.exponentialRampToValueAtTime(o.f1, when + o.dur)
  } else {
    c.frequency.exponentialRampToValueAtTime(o.f1, when + o.dur)
  }
  c.connect(g)
  c.start(when)
  let end = envelope(g.gain, when, o.gain, o.attack ?? 0.01, o.decay ?? 0.08, Math.max(0, o.dur - (o.attack ?? 0.01)))
  c.stop(end + 0.05)
  if (o.modF) {
    const m = ctx.createOscillator()
    m.frequency.value = o.modF
    const md = gain(ctx, o.modD, c.frequency)
    m.connect(md)
    m.start(when)
    m.stop(end + 0.05)
  }
  return end
}

// ---------------------------------------------------------------------------------------------
// The room-tone bed: a looping layer, cheap, driven a little from `update` so it never sits still.

/**
 * Noise through a lowpass whose cutoff wanders. The random walk lives in `update`, not in an
 * LFO node, because wind is not periodic — the moment it is, you hear the loop.
 */
class WindVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.lo = o.lo
    this.hi = o.hi
    this.base = o.base
    this.swell = o.swell
    this.rate = o.rate ?? 1
    this.cutoff = (o.lo + o.hi) * 0.5
    this.level = 0.5
    this.velocity = 0
    this.acc = 0
    this.filter = this.node(filter(ctx, o.type || 'lowpass', this.cutoff, o.q ?? 0.7))
    this.filter.connect(this.out)
    this.source(looped(ctx, noise[o.noise || 'pink'], this.filter))
    this.out.gain.value = o.base
  }

  update(dt, now) {
    // Cutoff and loudness move together: a gust is both louder and brighter.
    this.velocity += (Math.random() - 0.5) * 3 * this.rate * dt
    this.velocity *= 1 - 0.8 * dt
    this.level += this.velocity * dt
    if (this.level < 0) {
      this.level = 0
      this.velocity = Math.abs(this.velocity) * 0.3
    } else if (this.level > 1) {
      this.level = 1
      this.velocity = -Math.abs(this.velocity) * 0.3
    }
    this.acc += dt
    if (this.acc < 0.08) return
    this.acc = 0
    const cutoff = this.lo + (this.hi - this.lo) * this.level
    this.filter.frequency.setTargetAtTime(cutoff, now, 0.25)
    this.out.gain.setTargetAtTime(this.base * (1 - this.swell + this.swell * this.level), now, 0.25)
  }
}

/**
 * Somebody typing: short bright key clicks in bursts — a word, a pause, a few words, a longer
 * think — never an even patter, which is what turns typing into a clock.
 */
class TypingVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.noise = noise
    this.base = o.base
    this.next = ctx.currentTime + rand(0, 0.6)
    this.left = 0
    this.out.gain.value = 1
  }

  update(dt, now) {
    const ctx = this.ctx
    while (this.next < now + 0.25) {
      const t = Math.max(this.next, now)
      const tick = gain(ctx, 0, this.out)
      const bp = filter(ctx, 'bandpass', rand(2600, 4200), 1.6)
      bp.connect(tick)
      burst(ctx, this.noise.white, bp, t, 0.018)
      envelope(tick.gain, t, this.base * rand(0.35, 0.6), 0.001, 0.025)
      if (this.left <= 0) {
        // A new word: three to eight keys, then a gap; now and then a longer think.
        this.left = Math.floor(rand(3, 9))
        this.next = t + (Math.random() < 0.15 ? rand(0.9, 2.2) : rand(0.18, 0.4))
      } else {
        this.left--
        this.next = t + rand(0.07, 0.13)
      }
    }
  }
}

/** A rotor: sine plus a little saw, amplitude-modulated at the blade-pass rate. */
class DroneVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    const now = ctx.currentTime
    const lp = this.node(filter(ctx, 'lowpass', 2400, 0.7))
    lp.connect(this.out)
    const am = this.node(gain(ctx, 0.65, lp))
    const depth = this.node(gain(ctx, 0.35, am.gain))
    this.source(osc(ctx, 'sine', 55, depth, now))
    this.sine = this.source(osc(ctx, 'sine', 210, am, now))
    const sawMix = this.node(gain(ctx, 0.22, am))
    this.saw = this.source(osc(ctx, 'sawtooth', 210, sawMix, now))
    this.out.gain.value = o.base
  }

  setLevel(level) {
    // Throttle pitches the rotor up a touch; the pool sets the loudness itself.
    const f = 210 * (0.92 + 0.16 * level)
    const now = this.ctx.currentTime
    this.sine.frequency.setTargetAtTime(f, now, 0.3)
    this.saw.frequency.setTargetAtTime(f, now, 0.3)
  }
}

// ---------------------------------------------------------------------------------------------
// One-shots. Each is a function (ctx, dest, now, level) → end time, wrapped into a Voice.

const ONE_SHOTS = {
  droneDrop(ctx, dest, now, level, noise) {
    const g = gain(ctx, 0, dest)
    const o = osc(ctx, 'square', 2400, g, now)
    o.stop(envelope(g.gain, now, level * 0.12, 0.002, 0.03) + 0.02)
    const hp = filter(ctx, 'highpass', 4000, 0.8)
    const ng = gain(ctx, 0, dest)
    hp.connect(ng)
    burst(ctx, noise.white, hp, now, 0.02)
    envelope(ng.gain, now, level * 0.25, 0.001, 0.02)
    chirp(ctx, dest, now + 0.09, { f0: 140, f1: 55, dur: 0.1, gain: level * 0.8, attack: 0.004, decay: 0.12 })
    return now + 0.4
  },
  /**
   * Two soft marimba-ish notes a fifth apart. The one sound allowed to interrupt, so it is
   * built to be un-hateable: slow attack, a long even decay, nothing above the fourth partial.
   */
  chime(ctx, dest, now, level) {
    const note = (f, t) => {
      const g = gain(ctx, 0, dest)
      const a = osc(ctx, 'sine', f, g, t)
      const pg = gain(ctx, 0.22, g)
      const p = osc(ctx, 'sine', f * 4, pg, t)
      pg.gain.setTargetAtTime(0, t + 0.02, 0.12) // the bright partial dies first
      const end = envelope(g.gain, t, level, 0.02, 1.4)
      a.stop(end + 0.05)
      p.stop(end + 0.05)
      return end
    }
    note(523.25, now)
    return note(783.99, now + 0.22)
  },
}

/**
 * A robot's word: a run of short square-ish chirps, each gliding from one pitch to the next
 * with a hair of space between them. The tables are [from Hz, to Hz, seconds] per syllable.
 */
function robotPhrase(syllables) {
  return (ctx, dest, now, level) => {
    let t = now
    for (const [f0, f1, dur] of syllables) {
      chirp(ctx, dest, t, { f0, f1, dur, gain: level * 0.5, attack: 0.008, decay: dur * 0.9 })
      t += dur + 0.035
    }
    return t + 0.15
  }
}

/**
 * A little robot's beep-boop: round sine blips, each with a soft octave partial and a hair
 * of pitch droop at the end, like a toy. The table is [Hz, seconds] per blip.
 */
function beepBoop(blips) {
  return (ctx, dest, now, level) => {
    let t = now
    for (const [f, dur] of blips) {
      chirp(ctx, dest, t, { f0: f, f1: f * 0.94, dur, gain: level * 0.42, attack: 0.006, decay: dur * 0.7 })
      chirp(ctx, dest, t, { f0: f * 2, f1: f * 1.9, dur: dur * 0.6, gain: level * 0.09, attack: 0.004, decay: dur * 0.4 })
      t += dur + 0.05
    }
    return t + 0.12
  }
}

function oneShot(fn) {
  return (ctx, dest, o, noise) => {
    const v = new Voice(ctx, dest)
    // Contours are written at unit level; the engine sets the actual loudness outside.
    v.until = fn(ctx, v.out, ctx.currentTime, 1, noise, o) + 0.05
    return v
  }
}

// ---------------------------------------------------------------------------------------------
// The generator table the registry points at. Each is (ctx, dest, opts, noise) → Voice.

export const GENERATORS = {
  // The office's own air: ventilation in a big room, brown noise kept low and slow, so the
  // quiet is a place rather than a dead tab.
  'room-tone': (ctx, d, o, n) => new WindVoice(ctx, d, n, { lo: 140, hi: 420, base: 0.2, swell: 0.18, rate: 0.25, noise: 'brown' }),

  // One-shots
  'drone-drop': oneShot(ONE_SHOTS.droneDrop),
  'select-1': oneShot(robotPhrase([[880, 1320, 0.09], [1320, 1180, 0.12]])),
  'select-2': oneShot(beepBoop([[1318, 0.08], [659, 0.13]])), // beep, boop
  'select-3': oneShot(beepBoop([[784, 0.07], [1046, 0.07], [1568, 0.11]])), // boo-dee-beep
  'select-4': oneShot(robotPhrase([[520, 780, 0.08], [780, 1040, 0.08], [1040, 1300, 0.12]])),
  'select-5': oneShot(robotPhrase([[980, 980, 0.07], [980, 980, 0.07], [1470, 1240, 0.14]])),
  'select-6': oneShot(robotPhrase([[1200, 900, 0.1], [600, 1000, 0.16]])),
  'chime-attention': oneShot(ONE_SHOTS.chime),

  // Positional loops
  'work-typing': (ctx, d, o, n) => new TypingVoice(ctx, d, n, { base: 0.45 }),
  'drone-whine': (ctx, d, o, n) => new DroneVoice(ctx, d, n, { base: 0.22 }),
}
