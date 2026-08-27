# GRAVPULSE 2097 :: NEON CIRCUIT

An anti-gravity racing tournament that runs entirely in the browser using pure web standards.
Built with Three.js (vendored locally in `shared/vendor/`) — zero build step, zero transpilation.

## Run it

```bash
# From project root
pnpm dlx serve . -p 8137
# Open http://localhost:8137/games/gravpulse/
```

Add `/?autostart` to skip straight into a race (handy for tooling).

## Controls

| Key | Action |
| --- | --- |
| `↑` / `W` | Thrust (in race) / Increase laps (in menu) |
| `↓` / `S` | Brake (in race) / Decrease laps (in menu) |
| `←` `→` / `A` `D` | Steer (in race) / Select track (in menu) |
| `Enter` / click | Start race |
| `Space` | Fire weapon (rockets / mines / shields) |
| `Esc` | Return to main menu / Clear race |
| `R` | Restart race |
| `P` | Pause |
| `M` | Mute sound |

## What's in

- **Multiple Tracks:** VELOCITY DOME (Beginner), NEON CIRCUIT (Medium), and QUANTUM CANYON (Expert)
- **Combat & Shields:** Rockets, plasma mines, and shields protecting from collisions & hazards
- **Pure Web Standards:** 100% native ES modules, WebGL & procedural Web Audio chiptunes / synth soundtrack
