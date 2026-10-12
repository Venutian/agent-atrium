# Rendering regression check

Run `npm run dev`, then open `/tools/render-check.html` on the displayed local URL.
Wait for the final `complete: true, passed: true` result. This uses synthetic threads;
it never fetches harness data or saves settings/atrium state.

The browser check needs real WebGL2. It covers:

- Pixel-identical status badges and project labels with tilt-shift disabled versus 20%/100%
  strength and a tilted focal plane, over sky, focused geometry, and distant geometry.
  Both composer buffer parities are checked, and a separate world object must still blur.
- Consecutive frozen frames on all five office styles at Low through Ultra.
- Pan/orbit/zoom sweeps on Glass Studio at Balanced, High, and Ultra, plus Night Shift at Balanced.
  It reads each offscreen post-processing target as half floats and checks for NaN/Infinity.
  If one occurs, it hides scene groups in turn to isolate the first invalid scene pixel.
- Deferred canvas resize and adaptive quality changes, including whether the last rendered
  frame survives until the next draw.
- A small rendering-only benchmark at 1280×800. Timings include GPU synchronization but
  exclude simulation and the HDR readbacks. They are not the live atrium's frame rate.

`npm test` also checks resize scheduling, preserving adaptive resolution on focus/window
resize, restoring the requested resolution, and sizing a newly enabled composer.

## Movement checks

Open `/tools/visual-check.html?all=1` on the dev server to run three minutes of synthetic
activity for each of the five styles. Every result must say `passed: true`: no blocked
standing spots, settled jitter, stuck-bot corrections, clipped parcels or off-floor props.
`npm test` also runs the navigation simulation without WebGL. It does not replace the
browser rendering check above.

## Overlay depth-of-field regression

The overlay pass originally ran between bloom and tilt-shift. Badges do not write depth,
so the blur sampled the depth of whatever house or sky was behind each badge. Drawing
overlays after both tilt-shift passes keeps them sharp while retaining tone mapping,
colour grading, and antialiasing. The check uses black geometry to change background depth
without changing its colour: any changed overlay pixels then reveal blur contamination.
