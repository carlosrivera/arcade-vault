# 🏺 DUNESWEEPER: Voxel Ruins

A 100% procedural voxel archaeological excavation game inspired by classic Minesweeper rules, reimagined as a tactile desert exploration diorama.

---

## 🌟 Features

- **100% Procedural Voxel Art**: Every single element—sand layers, stone tiles, 3D numbers, scorpions, snakes, spike traps, golden relics, survey flags, saguaro cacti, and palm trees—is generated procedurally at runtime from micro-voxel cube compositions. Zero external 3D models or pixel textures.
- **Classic Minesweeper Logic + Archaeological Objectives**:
  - Guaranteed safe first click.
  - Number clues indicating adjacent traps (1 = Blue, 2 = Green, 3 = Red, 4 = Purple).
  - Chain reaction cascades on zero-trap tiles.
  - Dual victory conditions: Clear all safe tiles OR discover all ancient relics and uncover the tomb descent stairs!
- **Archaeological Expedition System**:
  - **Explorer Lives (3 Hearts)**: Triggering a trap damages a heart instead of instant game over.
  - **Archaeologist Brush**: Carefully brushes away sand on a guaranteed safe tile.
  - **Ancient Compass**: Scans a 3x3 sector to detect hidden hazard counts.
- **Physical Sand FX & Procedural Audio**:
  - Upper sand cubes burst and scatter outward with physics when excavated.
  - Web Audio API procedural synthesis with musical pentatonic cascade chimes, sand digging noise, and fanfares.
- **Deterministic Seeded PRNG**: Play shareable expedition seeds (e.g. `expedition_12345`).

---

## 🎮 Controls

### Desktop
- **Left Click**: Dig with the active tool
  - **Dig [1]**: standard excavation (infinite)
  - **Safe Brush [3 / B]**: clears one guaranteed-safe covered cell — refuses dangerous ground without spending a charge
  - **Flag [2 / F]**: place / remove Survey Stake
  - **Compass [4 / C]**: scan a 3x3 sector for hidden trap counts
  - **Old Map [5 / M]**: instantly marks several open dig sites elsewhere on the board
- **Right Click**: instant flag toggle
- **Double Click (Chord)**: on a revealed number with correct flags, excavates all adjacent covered cells
- **Mouse Wheel**: Zoom diorama in / out
- **Left Drag / Arrow Keys / Q-E**: rotate & tilt the diorama
- **Keyboard Shortcuts**:
  - `1`: Dig tool
  - `2` / `F`: Flag tool
  - `3` / `B`: Use Brush
  - `4` / `C`: Use Compass
  - `R`: Restart Expedition

### Mobile & Touch
- **Tap**: Excavate / use selected tool
- **Long Press**: Place / remove Flag stake
- **Pinch**: Zoom camera
- **Toolbelt Buttons**: Switch between Dig, Flag, Brush, and Compass
