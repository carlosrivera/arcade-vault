# Layered observation — isometric diorama island

Reference: reference.png (1536x1024). Observation stated separately from inference;
3D object-space terms; single-view limits named in Layer 8.

## Layer 1 — Identification & classification
- Work type: **terrain diorama slab** — a rectangular cut block of world presented as an object.
- Broad classification: environment diorama / game-overworld map object.
- `primaryDomain`: `object` (no character present).
- Confidence: 0.95. Inference: rendered as painted 2D art, not a photo of a physical model;
  the reconstruction target is therefore the depicted object, not the painting.

## Layer 2 — Overall form & silhouette
- Bounding volume: **cuboid slab**, square footprint, thickness ~0.12 of edge length.
- Top face carries the terrain; the four side faces are a clean vertical cut.
- Viewed corner-on: plan rotated ~45 deg, camera elevation ~30 deg, near-orthographic
  (parallel slab edges, no visible convergence) -> isometric projection.
- Symmetry: **asymmetric**. Shape language: geometric base, organic top.
- Terrain reads as **stacked plateaus with cliff risers**, not smooth slopes — flat green
  tables separated by near-vertical rock faces. One dominant pyramidal massif at rear-centre.

## Layer 3 — Macro -> meso -> micro
- Macro: slab base; sea surface; landmass; mountain massif; cloud layer.
- Meso: coastal cliffs; beaches; plateau tiers; straits/rivers; field-parcel patchwork;
  conifer forests; hamlets; castle islet; lighthouse islet; windmill village; stone ring
  monument; waterfall; arch bridge; pier; rock islets; ochre mesa region (rear-right).
- Micro: single house (cuboid wall block + gable roof); conifer (cone + short trunk);
  windmill sails; castle tower conical caps; shore foam lines; dirt paths; field boundaries;
  snow patches in gullies; vertical cliff striation.

## Layer 4 — Spatial relationships
- `<landmass, sits-on, slab-top>` contact: flush.
- `<sea-surface, flush-with, slab-top>` — sea plane is the datum the land rises from.
- `<mountain, embedded-in, landmass-rear>` contact: embed (no seam at its base).
- `<cliff, bounds, plateau-edge>` contact: butt, near-vertical.
- `<beach, between, lowland and sea>` contact: overlap, a narrow band.
- `<waterfall, attached-to, cliff-edge>` falls to sea; spray at base.
- `<bridge, spans, strait>` contact: socket at both abutments.
- `<house|windmill|castle|lighthouse, sits-on, plateau|islet>` contact: butt.
- `<earth-stratum, below, water-band>` on every slab side face; interface is **ragged**, not level.
- `<cloud, floats-above, sea>` — clouds sit at and below plateau height, overlapping the slab
  in projection. Identity-relevant: they are not a distant sky, they are in the diorama.

## Layer 5 — Materials & surface (PBR)
All dielectric; no metal in the scene. Painted finish, so albedo carries most of the read.
- Sea: albedo deep blue -> turquoise shallow; roughness ~0.15; opaque in this style.
- Grass/field: albedo saturated yellow-green through mid-green and wheat-tan; roughness ~0.9.
- Cliff rock: albedo grey-violet; roughness ~0.85; relief: vertical striation.
- Earth stratum: albedo warm ochre-brown; roughness ~0.95.
- Beach sand: albedo pale cream; roughness ~0.9.
- Snow: albedo near-white; roughness ~0.7.
- Mountain rock: albedo blue-violet; roughness ~0.8.
- House wall: albedo cream; roof: albedo red-orange; roughness ~0.8.
- Conifer foliage: albedo dark blue-green; roughness ~0.95.
- Cloud: albedo white, flat-shaded mass, no visible translucency.

## Layer 6 — Colour & finish
High-key, high-saturation. Value runs light at the top of every form and darker at its base.
Sea stops (shore -> open): white foam 0.00, pale turquoise 0.05, cyan 0.15, mid blue 0.40,
deep blue 1.00. Grass stops (sunlit -> shade): yellow-green 0.00, mid green 0.55,
blue-green 1.00. Mountain stops (summit -> base): white 0.00, pale blue 0.35,
blue-violet 1.00. Finish is matte throughout except the sea, which is satin.

## Layer 7 — Identity-defining features
1. Rectangular slab with **blue water band over ochre earth** on the cut faces (ragged interface).
2. Snow-capped pyramidal mountain, rear-centre.
3. Giant upright **stone ring monument**, NW plateau.
4. Waterfall off the west cliff.
5. Multi-arch stone bridge over the central strait.
6. Windmill + red-roofed village on the right field plateau.
7. Castle with red conical tower caps on a central islet.
8. Lighthouse on a south islet.
9. Ochre mesa region with a fortress, rear-right.
10. Cloud layer AT island level, over the sea.
11. Field-parcel patchwork with hard rectilinear boundaries.
12. Rock islets each carrying a conifer, ringed by foam.

## Layer 8 — Uncertainty & single-image limits
- Slab underside: **hidden**. Assume flat.
- Rear faces of mountain, all rear-facing cliffs: **hidden**.
- Rear-right mesa region: partly **occluded** by cloud; fortress detail uncertain.
- Stone ring cross-section (torus vs flat annulus): **uncertain**.
- House counts within clusters: approximate, not countable at this resolution.
- Whether the sea plane is flush with the slab top or slightly recessed: **uncertain**;
  reads as flush.
- Sea floor beneath the water: **hidden**; the water reads opaque.
