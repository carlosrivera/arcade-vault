# Projection route decision — NOT REQUIRED

## Decision
Skip `solve_camera_pose.py` / `delight_albedo.py` / `bake_projected_texture.py`.

## Why
Projection is the right lever when a reference's SURFACE carries the identity and a
procedural material would get it visibly wrong - a patterned weapon finish, a face. This
craft is the opposite case:

1. **The surface is four flat colours.** Charcoal hull, tinted canopy, cyan emissive, orange
   vent. There is no pattern, no wear, no grime, no gradient map to recover. A solid albedo
   per material IS the reference finish, which is exactly the rule of thumb in
   `threejs_texture_reference.md`: solid albedo for flat paint, reference crop for patterned.
2. **The value structure is geometry, not texture.** Faces differ in brightness because they
   face different directions. That is reproduced by modelling the facets and lighting them -
   projecting it would bake one lighting solution into the albedo and kill the response.
3. **The strips are recessed channels.** Projecting them onto flat faces would lose the
   groove that reads as inset in the three-quarter view, and they would stop being emissive.

## Decals are the one textured element, and they are generated, not projected
"07", "EXIS" and the arrow logo are the only pattern on the craft. They are drawn to a
canvas at build time and applied as decal maps. Generated rather than cropped because:
- the pipeline emits code and ships no image assets;
- the marks are text and a simple glyph, so a canvas reproduces them at any resolution,
  where a crop would be resolution-locked and carry the reference's own lighting;
- projection would need a solved camera per decal and would still bake in shading.

The arrow logo is below the reference's resolution to read exactly; it is reproduced as a
chevron-in-triangle approximation and labelled as an approximation in the spec.
