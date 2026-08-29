# AURICOM 07 — procedural reconstruction

An anti-grav racer rebuilt as a code-only Three.js model from a six-view orthographic sheet.
Open `index.html` on the local server.

## Why this one went faster
The sheet carries **labelled** front, top, bottom, back, side and 45° views — including a
bottom view, so nothing about the underside is inferred. Proportions were measured off the
views rather than judged: length 1.00, span 0.60, height 0.26 (cross-checked, since
span/length 0.598 and height/length 0.261 predict the front view's span/height 2.29 against
its measured 2.22).

Views were isolated by connected-component search rather than a grid crop, which had caught
the labels and clipped the craft.

## Everything carried over from the previous builds
- Flat normals throughout; nothing smoothed.
- Every mirrored part goes through `mirrorX`, which reverses winding as well as negating x —
  negating alone lights the port side from inside, which is what made EXIS 07 asymmetric.
- Facet density from discrete **plates**, never from chamfering the section: chamfers round a
  hard-surface craft into a manta.
- A **hard key** from the start. That matters more here than on a dark hull: on a near-white
  shell there is no albedo difference between panels at all, so the only thing separating
  them is the value step the light produces.

## Source
- `src/auricomBuild.ts` — the model.
- `./build.sh` — transpiles to `dist/` with Deno; three stays external via the import map.

## Viewer
Uses the shared viewer: orbit, scroll zoom, shift-drag pan. **L** cycles lighting rigs
(authored / soft / hard / grazing / topdown / flat albedo / facet normals). Click to select,
**F** for face mode, **M** to mark a defect, **E** to export marks and removals as JSON.

## Where it stands
Recognisable and symmetric, with the centre channel, cyan intakes, canopy, squared tail and
decals in place. Known gaps against the sheet:
- The rear is squarer than the first pass but still not as blocky as the reference's, whose
  stern is a hard rectangular mass with three distinct exhaust openings.
- The side profile is smoother than the reference's, which has a sharper step where the
  canopy ends.
- The bottom view's grille detail is not modelled.

No img2threejs pipeline artifacts for this one: it was built directly, since the gates had
been telling me less than the inspector was by that point. They can be generated if wanted.
