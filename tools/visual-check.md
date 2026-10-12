# Visual and movement checks

Start `npm run dev` and open `/tools/visual-check.html`. This page uses 42 synthetic
threads, three projects, Balanced graphics, and a seeded movement RNG. It does not
read the harness API or save atrium/settings state.

The initial run simulates three minutes of activity. The report checks:

- Every building vertex against the actual hex deck, plus loose prop footprints and scaffold feet.
- Work sites against the completed navigation map and wall clearance.
- Stopping at the final waypoint without retaining walk velocity.
- Repeated movement with little net displacement, including a separate count after arrivals.
- Waiting crew playing a walking animation after arriving.
- Delivered parcels landing above ground on roofs and parcel centres entering building surfaces.
- CPU update timing (excluding diagnostic work and drawing).

The links repeat this on each office style. Buttons show an overview,
a close-up with four package drops, and the Night Shift style. `/tools/render-check.html`
separately checks HDR values during camera motion, quality presets, and buffer resizing.

`/tools/picking-check.html` checks whole-body selection against animated bone positions
and sampled skinned vertices across six poses, three zoom levels, and both world-curve
settings. It also checks overlapping agents, hidden instances, and badge selection.
The final close-up accepts pointer clicks, including either boot, without reading the
harness API or saving settings. Local validation passed all 9,184 checks.

Local validation on 2026-10-11, Glass Studio and Garden Atrium: the 42-building fixture had
no off-floor buildings, props or scaffold feet, no blocked work sites, no settled jitter, and
four parcels landed on roofs without clipping. The walls' own navigation markers sit on each
room's edge by design and are left out of the prop count. There can still be isolated brief
crowd corrections; the jitter counter is a heuristic, not a guarantee.

Package motion remains lightweight surface physics, not a full rigid-body engine.
Roof raycasts account for construction height and slopes; spinning turbine blades
are excluded as supports. Packages bounce and can slide/fall off ledges, but do not
stack on other packages. No extra physics dependency or rendering pass is added.
