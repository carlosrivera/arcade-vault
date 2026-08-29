# Layered observation — EXIS 07 strike craft

Reference: reference.png (1448x1086), a four-view orthographic sheet on white.
Views cropped to crops/{top,side,rear,threequarter}.png, all four admitted.
Observation stated separately from inference; 3D object-space terms throughout.

## Layer 1 — Identification & classification
- Work type: **single-seat atmospheric/space strike craft** (concept sheet render).
- Broad classification: hard-surface vehicle, low-poly faceted style.
- `primaryDomain`: `object`. Confidence 0.97.
- Four views of ONE object, isolated on white. This is the ideal case for this pipeline:
  the hidden-side problem that forced the diorama to be `conditional` does not arise here.

## Layer 2 — Overall form & silhouette
- Bounding volume: a flattened **arrowhead**. Length >> span >> height.
  Measured off the side and top crops: length 1.00, span ~0.62, height ~0.26.
- Symmetry: **bilateral**, exact, about the XY plane (centreline).
- Shape language: **hard-surface faceted** - every surface is a flat polygon meeting its
  neighbours at a visible crease. No smooth or lofted surfaces anywhere. This is the single
  most important formal fact: the object is a polyhedron, not a swept fuselage.
- Planform: sharp wedge nose -> chine flaring to a wide delta -> rear fans into layered
  swept plates. Side profile is a shallow wedge, deepest at mid-body, flat underside.

## Layer 3 — Macro -> meso -> micro
- Macro: hull; canopy assembly; wing pair; dorsal fin pair; propulsion cluster.
- Meso: nose wedge; forward chine rail; mid-hull body; canopy glass + surround; wing root;
  wing panel; wingtip pod; rear feather plates (3-4 per side); central engine housing;
  outboard engine housings (2); dorsal fins (2).
- Micro: engine grille bars (4-5 per nozzle); orange intake vents (3-4); emissive strip
  runs; nose chevron strip; wingtip emissive slot; decals (arrow logo, "07" x2, "EXIS").

## Layer 4 — Spatial relationships
- `<canopy, embedded-in, hull-spine>` contact: embed, flush with the raised spine.
- `<dorsal-fin, attached-to, hull-spine-rear>` contact: butt, one per side, splayed.
- `<wing, continuous-with, hull>` - no seam; the wing IS the hull's flare, not a bolted part.
- `<wingtip-pod, terminates, wing>` contact: butt; each pod houses one outboard engine.
- `<engine-nozzle, recessed-into, housing>` contact: socket. Three total.
- `<feather-plate, layered-over, wing-trailing-edge>` contact: overlap, stacked in Z.
- `<emissive-strip, inset-into, panel-crease>` - the strips sit IN recessed channels along
  panel joins, they are not decals lying on flat faces. Visible as a groove in the 3/4 view.
- `<orange-vent, recessed-into, upper-surface>` contact: socket.

## Layer 5 — Materials & surface (PBR)
Four materials only, which is what makes this tractable.
- **Hull**: dark charcoal, albedo ~#2f333a, dielectric, metalness low (~0.15),
  roughness ~0.42 - a satin automotive finish. Facets read by value alone: lit faces go to
  ~#4a5058, shadowed to ~#1c1f24. No texture, no wear, no grime.
- **Canopy glass**: very dark blue, albedo ~#232a44, low roughness (~0.15), reads opaque
  with a hard specular - tinted, not transparent. No interior is visible in any view.
- **Emissive cyan**: ~#29b8ff core blowing out to white at the centre of each strip.
  Unlit-bright: it reads at full intensity on shadowed faces too, so it is emissive, not
  a lit material. Bloom halo around every run.
- **Orange vent**: ~#e2761f, matte (~0.6), NOT emissive - it takes shading like the hull.

## Layer 6 — Colour & finish
Near-monochrome charcoal, carried entirely by two accents. Value range is wide and the
finish is satin - specular highlights track the light along each facet crease.
Hull stops (lit -> shade): #4a5058 0.00, #2f333a 0.5, #1c1f24 1.00.
Emissive stops (core -> edge): #ffffff 0.00, #6fd4ff 0.35, #1f9ae0 1.00.

## Layer 7 — Identity-defining features
1. Faceted low-poly hull with visible creases - the style itself.
2. Cyan emissive strips inset into panel channels: a long chine run nose-to-tail, a nose
   chevron, and a large angular loop on each rear wing.
3. **Three** engine nozzles - one large central, two outboard in the wingtip pods - each an
   octagonal recess with horizontal grille bars.
4. Twin swept dorsal fins with emissive outer strips.
5. Layered rear feather plates fanning aft, 3-4 per side.
6. Orange recessed vents: two on the dorsal spine, one per side aft.
7. Dark blue hexagonal canopy set into a raised spine.
8. Decals: arrow-in-triangle logo, "07" on nose and mid-hull, "EXIS" wordmark.
9. Wingtip pods with a cyan emissive slot on the leading face.
10. Sharp wedge nose with a chine rail running the full length.

## Layer 8 — Uncertainty & single-image limits
- Underside: **hidden** in all four views. Reads flat from the side profile; will be built
  as a flat faceted belly and flagged as inference.
- Canopy interior: **hidden** (opaque tint). No cockpit modelled.
- Exact facet topology on the rear feather plates is **uncertain** - the side view shows
  3-4 stacked plates, the 3/4 view suggests 4. Building 4 per side.
- Nozzle grille bar count: 4-5, **uncertain**; reads 5 on the central, 4 on the outboards.
- The arrow logo's internal geometry is small and **uncertain** at this resolution;
  reproduced as a chevron-in-triangle approximation.
