# Reference suitability verdict — reference.png

**Verdict: CONDITIONAL -> stylized reconstruction.** Not an unqualified pass, and not a reject.

## Against the Pass column
- One obvious target object: **yes**. The subject is a bounded diorama slab with a hard cut
  edge; the frame's black vignette is background, not subject.
- Occupies enough of the frame: **yes**, ~85% of the image area.
- At least one strong silhouette: **yes** — the slab's near corner gives an unambiguous
  three-face read of the bounding cuboid.
- Major materials visible: **yes** — water, grass, rock, sand, snow, earth stratum, roof tile.
- Hidden side reasonably inferred: **partly**. The three visible slab faces are constructed
  identically, so the fourth is safe to infer; the mountain's rear and all rear-facing cliffs
  are not.
- Approximable with procedural primitives: **yes** — heightfield top, extruded slab sides,
  cones/cuboids/cylinders for props.

## Against the Reject column — the one that needs answering
"Photo is a scene, not an object reference" applies in part, and it is the reason this is
conditional rather than pass. The interior IS a scene: dozens of independent sub-objects
(houses, trees, bridge, windmill, castle) rather than one article with one component tree.
It is admitted because the **slab makes it a bounded object** — it has a silhouette, a
finite volume, and cut faces that define its extent. The consequence is recorded honestly
below rather than waved away.

No other reject criterion applies: the target is unambiguous, nothing identity-critical is
cropped, and the scene does not depend on caustics, smoke, or lace.

## Against the Conditional column
- Single view, but the slab's cut faces are constructionally repeated -> inferable.
- Occlusion present (cloud over the rear-right mesa) but the macro shape is clear.
- Fine detail (cliff striation, field boundaries, foam) is procedurally representable.
- Organic target with stylization accepted: the user asked for the reference's own painted
  look, which is the stylization this pipeline can actually deliver.

## What this verdict commits me to
The output is a **stylized reinterpretation that matches composition, landform grammar,
palette and identity features** — not a pixel-matched copy. Specifically:
- Prop *positions* reproduce the reference layout; prop *counts* within clusters are
  approximate and are stated as such.
- Rear-facing terrain is invented plausibly and flagged as inference, not observation.
- The mesa fortress is low-confidence (cloud-occluded) and is built as a mass, not detailed.

## Missing input that would raise the ceiling
A second view (rotated 90 deg in plan) would convert the rear terrain from inference to
observation. Not requested, because the user asked for this image and a stylized result,
and the front three faces support that goal.
