# STRIKEVECTOR

Air-dominance flight combat in the browser. Zero build step — vanilla ES modules + three.js.

**▶ Play:** [games/aces/index.html](index.html)

## Features

- **Realistic 6DOF flight model** — rigid-body quaternion dynamics with a
  piecewise lift curve (Cl vs AoA), induced drag, side-force, exponential
  atmosphere (density falls with altitude), afterburner thrust, airbrake,
  G-load readout, weathervane stability, and a hard stall past ~22° AoA.
- **Infinite procedural terrain** — continental fBm, vector domain warping,
  anisotropic ridged multifractals, erosion-inspired drainage carving, and
  amplitude-limited micro detail streamed as recycled 2.4 km LOD chunks. A
  world-space triplanar shader blends shore, scrub, meadow, cliff, alpine rock,
  and snow from elevation and slope without stretched textures or chunk seams.
- **Modern F-22-style HUD** — pitch-ladder artificial horizon with roll,
  heading tape, KIAS / ALT-FT tapes with Mach, G and AoA readouts, radar
  altitude, flight-path marker, gun cross, 12 km radar with FOV cone, target
  designator boxes with range/closure, lock reticle with SHOOT cue, cannon
  lead-computing pipper, and blinking master warnings (STALL / PULL UP /
  MISSILE / HULL).
- **Combat** — enemy ace AI (pursue, lead intercept, merge-orbit, evasive
  breaks, terrain avoidance), proportional-navigation seeker missiles with
  smoke trails for both sides, tracer cannon, pooled explosion sprites,
  escalating waves, hull damage and death/restart flow.
- **Procedural audio** — WebAudio engine roar keyed to throttle/AB, wind noise
  keyed to airspeed, lock tone, cannon, launch whoosh, explosion bursts.

## Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Pitch (stick fore / aft) |
| `A` / `D` | Roll |
| `Q` / `E` | Yaw (rudder) |
| `Shift` | Throttle up → afterburner |
| `Ctrl` | Throttle down → airbrake |
| `Space` | Cannon |
| `F` | Missile (requires lock) |
| `T` / `Y` | Cycle target / nearest threat |
| `C` | Cockpit / chase camera |
| `H` | Cycle terrain beauty / elevation / slope / biome-weight views |
| `R` | Restart |

## Source layout

- `src/flight.js` — flight model
- `src/terrain.js` — noise, chunk streaming, sky, clouds
- `src/jet.js` — procedural F-22-ish airframe + missile model
- `src/hud.js` — 2D canvas HUD
- `src/combat.js` — enemies, missiles, cannon, explosions
- `src/audio.js` — procedural WebAudio
- `src/main.js` — game loop, input, camera, targeting, waves
