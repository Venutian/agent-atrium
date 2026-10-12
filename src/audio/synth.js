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
    // Paul Kellet's pink filter: cheap, and flat enough for air.
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
 * an attack/decay. Every blip here is one or two of these.
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
// The beds: looping layers, cheap, driven a little from `update` so they never sit still.

/**
 * Noise through a lowpass whose cutoff wanders: moving air. The random walk lives in
 * `update`, not in an LFO node, because air is not periodic — the moment it is, you hear
 * the loop.
 */
class AirVoice extends Voice {
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

/**
 * A distant room of people: speech-band noise shaped into syllables by two independent
 * talkers, each a run of short swells with pauses between phrases. Too far off and too
 * filtered to be words, which is what an open-plan office sounds like from across the floor.
 */
class MurmurVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    this.base = o.base
    this.out.gain.value = 1
    this.talkers = [[480, 1250], [620, 1650]].map(([low, high]) => {
      const level = this.node(gain(ctx, 0, this.out))
      for (const [freq, q] of [[low, 1.1], [high, 1.6]]) {
        const bp = this.node(filter(ctx, 'bandpass', freq, q))
        bp.connect(level)
        this.source(looped(ctx, noise.pink, bp))
      }
      return { level, next: ctx.currentTime + rand(0, 2), left: 0 }
    })
  }

  update(dt, now) {
    for (const t of this.talkers) {
      while (t.next < now + 0.3) {
        const at = Math.max(t.next, now)
        if (t.left <= 0) {
          // A phrase: four to twelve syllables, after a pause to listen.
          t.left = Math.floor(rand(4, 13))
          t.next = at + rand(0.6, 2.8)
          continue
        }
        const dur = rand(0.09, 0.22)
        t.level.gain.setTargetAtTime(this.base * rand(0.45, 1), at, 0.025)
        t.level.gain.setTargetAtTime(0, at + dur, 0.05)
        t.left--
        t.next = at + dur + rand(0.03, 0.09)
      }
    }
  }
}

/**
 * A small quadcopter: four rotors a few hertz apart, so they beat against each other the way
 * real props do, plus a breath of air off the blades.
 */
const ROTORS = [236, 239, 243, 247]
class RotorVoice extends Voice {
  constructor(ctx, dest, noise, o) {
    super(ctx, dest)
    const now = ctx.currentTime
    const lp = this.node(filter(ctx, 'lowpass', 1500, 0.8))
    lp.connect(this.out)
    this.rotors = ROTORS.map((freq) => this.source(osc(ctx, 'triangle', freq, this.node(gain(ctx, 0.22, lp)), now)))
    const air = this.node(filter(ctx, 'bandpass', 950, 0.9))
    air.connect(this.node(gain(ctx, 0.18, this.out)))
    this.source(looped(ctx, noise.pink, air))
    this.out.gain.value = o.base
  }

  setLevel(level) {
    // Throttle pitches the rotors up a touch; the pool sets the loudness itself.
    const now = this.ctx.currentTime
    const k = 0.93 + 0.14 * level
    this.rotors.forEach((r, i) => r.frequency.setTargetAtTime(ROTORS[i] * k, now, 0.3))
  }
}

// ---------------------------------------------------------------------------------------------
// One-shots. Each is a function (ctx, dest, now, level) → end time, wrapped into a Voice.

const ONE_SHOTS = {
  /** The parcel lands: a soft cardboard thump, then the drone's latch letting go. */
  droneDrop(ctx, dest, now, level, noise) {
    const lp = filter(ctx, 'lowpass', 420, 0.7)
    const thump = gain(ctx, 0, dest)
    lp.connect(thump)
    burst(ctx, noise.brown, lp, now, 0.12)
    envelope(thump.gain, now, level * 0.9, 0.004, 0.14)
    const click = gain(ctx, 0, dest)
    const bp = filter(ctx, 'bandpass', 3200, 2)
    bp.connect(click)
    burst(ctx, noise.white, bp, now + 0.11, 0.015)
    envelope(click.gain, now + 0.11, level * 0.35, 0.001, 0.02)
    return now + 0.35
  },
  /**
   * Somebody needs you: a three-note glass bell, rising. Soft attack, and inharmonic partials
   * that die first, so it reads as a bell on a desk rather than an alarm.
   */
  chime(ctx, dest, now, level) {
    let end = now
    for (const [f, t] of [[880, 0], [1108.73, 0.11], [1318.51, 0.22]]) {
      const at = now + t
      const g = gain(ctx, 0, dest)
      const a = osc(ctx, 'sine', f, g, at)
      const pg = gain(ctx, 0.16, g)
      const p = osc(ctx, 'sine', f * 2.76, pg, at)
      pg.gain.setTargetAtTime(0, at + 0.01, 0.08)
      end = envelope(g.gain, at, level * 0.55, 0.012, 1.1)
      a.stop(end + 0.05)
      p.stop(end + 0.05)
    }
    return end
  },
  /** A mug set down across the room: a ceramic tap, and now and then the little rebound. */
  mugClink(ctx, dest, now, level, noise) {
    const tap = (at, l) => {
      for (const [f, d, a] of [[2350, 0.22, 1], [3710, 0.14, 0.6], [5160, 0.09, 0.35]]) {
        const g = gain(ctx, 0, dest)
        osc(ctx, 'sine', f * rand(0.97, 1.03), g, at).stop(envelope(g.gain, at, l * a * 0.18, 0.001, d) + 0.02)
      }
      const n = gain(ctx, 0, dest)
      const hp = filter(ctx, 'highpass', 5000, 0.7)
      hp.connect(n)
      burst(ctx, noise.white, hp, at, 0.01)
      envelope(n.gain, at, l * 0.12, 0.001, 0.012)
    }
    tap(now, level)
    if (Math.random() < 0.5) tap(now + rand(0.07, 0.12), level * 0.4)
    return now + 0.5
  },
  /** An office chair pushed back: casters rolling on carpet, and a short creak. */
  chairRoll(ctx, dest, now, level, noise) {
    const bp = filter(ctx, 'bandpass', rand(220, 320), 0.7)
    const roll = gain(ctx, 0, dest)
    bp.connect(roll)
    burst(ctx, noise.pink, bp, now, 1.1)
    roll.gain.setValueAtTime(0, now)
    roll.gain.linearRampToValueAtTime(level * 0.5, now + 0.25)
    roll.gain.setTargetAtTime(0, now + 0.55, 0.12)
    const creak = filter(ctx, 'bandpass', 900, 7)
    const cg = gain(ctx, 0, dest)
    creak.connect(cg)
    const saw = osc(ctx, 'sawtooth', 175, creak, now + 0.05)
    saw.frequency.setValueAtTime(175, now + 0.05)
    saw.frequency.linearRampToValueAtTime(140, now + 0.3)
    saw.stop(envelope(cg.gain, now + 0.05, level * 0.12, 0.02, 0.2, 0.1) + 0.02)
    return now + 1.2
  },
  /** The printer by the commons: a motor spins up and paper feeds through in short pulls. */
  printer(ctx, dest, now, level, noise) {
    const motor = gain(ctx, 0, dest)
    const lp = filter(ctx, 'lowpass', 380, 0.8)
    lp.connect(motor)
    osc(ctx, 'sawtooth', 92, lp, now).stop(now + 2.4)
    motor.gain.setValueAtTime(0, now)
    motor.gain.linearRampToValueAtTime(level * 0.25, now + 0.3)
    motor.gain.setTargetAtTime(0, now + 2, 0.1)
    const feed = gain(ctx, 0, dest)
    const bp = filter(ctx, 'bandpass', 1800, 1.2)
    bp.connect(feed)
    burst(ctx, noise.white, bp, now + 0.35, 1.7)
    feed.gain.setValueAtTime(0, now)
    for (let t = now + 0.35; t < now + 2; t += 0.11) {
      feed.gain.setTargetAtTime(level * 0.16, t, 0.01)
      feed.gain.setTargetAtTime(0, t + 0.06, 0.015)
    }
    return now + 2.5
  },
  /** Somebody across the floor typing a quick line. */
  distantKeys(ctx, dest, now, level, noise) {
    let t = now
    for (let i = Math.floor(rand(6, 16)); i > 0; i--) {
      const g = gain(ctx, 0, dest)
      const bp = filter(ctx, 'bandpass', rand(1800, 2800), 1.4)
      bp.connect(g)
      burst(ctx, noise.white, bp, t, 0.016)
      envelope(g.gain, t, level * rand(0.12, 0.22), 0.001, 0.022)
      t += Math.random() < 0.15 ? rand(0.2, 0.35) : rand(0.07, 0.12)
    }
    return t + 0.1
  },
}

/**
 * What a bot says when you click it: two or three soft blips on a pentatonic scale, each
 * sliding up into its note with a glassy overtone on top. The table is [Hz, seconds] per blip.
 */
function botBlip(blips) {
  return (ctx, dest, now, level) => {
    let t = now
    for (const [f, dur] of blips) {
      chirp(ctx, dest, t, { type: 'triangle', f0: f * 0.94, f1: f, dur, gain: level * 0.5, attack: 0.006, decay: dur * 0.8 })
      chirp(ctx, dest, t, { f0: f * 3, f1: f * 3 * 1.001, dur: dur * 0.5, gain: level * 0.06, attack: 0.003, decay: dur * 0.4 })
      t += dur + 0.045
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
  // The office's own air: ventilation hiss in a big room, pink noise kept narrow and slow,
  // so the quiet is a place rather than a dead tab.
  'room-tone': (ctx, d, o, n) => new AirVoice(ctx, d, n, { lo: 620, hi: 880, base: 0.12, swell: 0.08, rate: 0.12, noise: 'pink' }),
  'office-murmur': (ctx, d, o, n) => new MurmurVoice(ctx, d, n, { base: 0.1 }),

  // One-shots
  'drone-drop': oneShot(ONE_SHOTS.droneDrop),
  'select-1': oneShot(botBlip([[740, 0.07], [988, 0.1]])),
  'select-2': oneShot(botBlip([[880, 0.06], [740, 0.06], [1175, 0.11]])),
  'select-3': oneShot(botBlip([[587, 0.08], [880, 0.12]])),
  'select-4': oneShot(botBlip([[988, 0.06], [1175, 0.06], [1480, 0.1]])),
  'select-5': oneShot(botBlip([[659, 0.07], [659, 0.07], [880, 0.12]])),
  'select-6': oneShot(botBlip([[1175, 0.08], [880, 0.13]])),
  'chime-attention': oneShot(ONE_SHOTS.chime),
  'mug-clink': oneShot(ONE_SHOTS.mugClink),
  'chair-roll': oneShot(ONE_SHOTS.chairRoll),
  'printer': oneShot(ONE_SHOTS.printer),
  'distant-keys': oneShot(ONE_SHOTS.distantKeys),

  // Positional loops
  'work-typing': (ctx, d, o, n) => new TypingVoice(ctx, d, n, { base: 0.45 }),
  'drone-whine': (ctx, d, o, n) => new RotorVoice(ctx, d, n, { base: 0.2 }),
}
