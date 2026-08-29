# Reference suitability verdict — EXIS 07

**Verdict: PASS.** Unqualified, unlike the diorama's `conditional`.

## Against the Pass column
- One obvious target object: **yes** - a single craft, isolated on white, no scene.
- Occupies enough of the frame: **yes**, four views each covering 37-55% of their crop.
- At least one strong silhouette: **yes** - the top view gives an unambiguous planform and
  the rear view an unambiguous cross-section.
- Major materials visible: **yes** - all four (hull, canopy, emissive, vent) are legible.
- Hidden side reasonably inferred: **yes for everything except the belly.** Four views cover
  top, side, rear and three-quarter; only the underside is unseen, and the side profile
  constrains it to a flat faceted plane.
- Approximable with procedural primitives: **yes, unusually well.** The subject is already a
  polyhedron - every surface is a flat facet - so authored vertex geometry reproduces it
  exactly rather than approximating a curved surface.

## Against the Reject column
None applies. The target is unambiguous, nothing identity-critical is cropped or blurred,
and the object depends on no caustics, smoke, fur or lace. The one reject criterion that
caught the diorama - "photo is a scene, not an object reference" - is inapplicable: this is
an object reference in the strict sense.

## Why this rates higher than the previous subject
The diorama was a scene admitted on the strength of its bounding slab, so its interior was
dozens of independent objects and its fidelity ceiling was layout-level. This is one article
with one component tree, four views, four materials and hard-edged geometry. The pipeline's
assumptions hold here.

## Accepted approximations, stated up front
- Underside is inference, constrained by the side profile.
- Decals ("07", "EXIS", arrow logo) are reproduced as generated canvas textures, not
  projected reference crops - see projection-route.md.
- Facet counts on the rear feather plates and nozzle grilles are read to the nearest
  plausible integer where the render is ambiguous, and named in the assessment's unknowns.

## Admission result — the sheet itself is NOT the reference
`check_reference_admission.py` **rejects** the full four-view sheet, correctly:
`largest connected blob is 0.46 of foreground < 0.6 (fragmented/scattered subject)`.
That is the gate doing its job — a sheet of four separate renders is not one admissible
reference, and using it as ground truth would let a fidelity comparison score the layout of
the sheet rather than the craft.

The four view crops are each admitted individually (coverage 0.37-0.55, largest component
0.95-1.00). They are the reference set. `crops/threequarter.png` is the primary view for
review captures, being the only one that resolves all three axes at once.
