# Studio reflection source

`studio_small_09_1k.hdr` — Studio Small 09, Sergej Majboroda / Poly Haven.

Source: https://polyhaven.com/a/studio_small_09

License: CC0. Downloaded from Poly Haven's official 1K HDR endpoint.

Used only by `tools/model-check.html`, for photographic reflections when checking the bot
model on its own. The atrium itself never loads it: it reflects its own sky's radiance map
plus a capture of nearby rooms, so the glass answers to the office style, the time of day
and the rooms around it. Kept here rather than in `public/` so it never ships in a build.
