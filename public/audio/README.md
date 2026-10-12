# Sound samples

Everything the atrium can play has a procedural fallback in `src/audio/synth.js`, so this
folder can stay empty. Real recordings sound better, and they slot in by name:

1. Drop `.wav` / `.mp3` / `.ogg` files in here.
2. Write a `manifest.json` next to them:

```json
{
  "sounds": {
    "room-tone":       { "file": "audio/room-tone.wav", "gain": 0.8, "loop": true },
    "chime-attention": { "file": "audio/chime.wav",     "gain": 1.0, "loop": false },
    "work-typing":     { "file": "audio/typing.wav",    "gain": 0.8, "loop": true, "trim": [0.1, 3.9] }
  }
}
```

The names are the ones in `src/audio/sounds.js`. A name that is not in the manifest, or whose
file fails to load, falls back to its synth. Beds and loops (`loop: true`) should loop
cleanly; `trim` cuts a `[start, end]` window in seconds.

This folder is gitignored apart from this file, because sample libraries — Splice included —
license their sounds for use *in* a work, not for redistribution on their own. Sounds under
CC0 are fine to commit; add them to `CREDITS.md` if you do.
