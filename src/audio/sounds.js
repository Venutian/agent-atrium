import { GENERATORS } from './synth.js'

/**
 * Every sound the atrium can make, by name.
 *
 * A name is the whole contract between the world and the audio: an office style asks for its
 * bed by name, the integrator tags sources by name, `play` takes a name. Behind each one sits
 * a synth from `synth.js`, and optionally a real file from the manifest that overrides it. So
 * a sample can be dropped in or pulled out without touching any code that asks for sounds,
 * and the registry refuses to load at all if a name has no synth — there is no such thing
 * here as a sound that might be silent.
 *
 * `kind` decides how the engine treats it:
 *   bed    — loops forever as the office's room tone
 *   event  — plays once and cleans itself up
 *   loop   — loops while a positional source exists (a desk being typed at, a drone)
 * `gain` is a final trim on top of the synth's own level, so the mix can be balanced in
 * one place without touching the recipes.
 */

const TABLE = {
  /** Ventilation: the air of a big glass room. */
  'room-tone': { kind: 'bed', gain: 1 },
  /** People talking somewhere across the floor, too far off to be words. */
  'office-murmur': { kind: 'bed', gain: 1 },

  /** Now and then, somewhere in the office. */
  'mug-clink': { kind: 'event', gain: 0.8 },
  'chair-roll': { kind: 'event', gain: 0.7 },
  'printer': { kind: 'event', gain: 0.6 },
  'distant-keys': { kind: 'event', gain: 0.8 },

  /** A cardboard thump and a latch — a drone just set a parcel down. */
  'drone-drop': { kind: 'event', gain: 0.7 },
  /**
   * "Yes?" — what a bot says when you click it. Six of them, picked at random, so a
   * crowd does not answer in one voice: two or three soft blips each.
   */
  'select-1': { kind: 'event', gain: 0.55 },
  'select-2': { kind: 'event', gain: 0.55 },
  'select-3': { kind: 'event', gain: 0.55 },
  'select-4': { kind: 'event', gain: 0.55 },
  'select-5': { kind: 'event', gain: 0.55 },
  'select-6': { kind: 'event', gain: 0.55 },
  /**
   * "Somebody needs you." The only sound that is allowed to interrupt, so it is the one
   * that must never grate: a soft three-note glass bell, and nothing else.
   */
  'chime-attention': { kind: 'event', gain: 0.6 },

  'work-typing': { kind: 'loop', gain: 0.9 },
  'drone-whine': { kind: 'loop', gain: 1 },
}

/** name → { kind, gain, synth(ctx, dest, opts, noise) → Voice } */
export const SOUNDS = {}
for (const name of Object.keys(TABLE)) {
  const synth = GENERATORS[name]
  if (typeof synth !== 'function') throw new Error(`[audio] "${name}" is registered without a synth`)
  SOUNDS[name] = { kind: TABLE[name].kind, gain: TABLE[name].gain, synth }
}
