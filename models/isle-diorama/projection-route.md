# Projection route decision — NOT REQUIRED (texture projection), layout extraction instead

## Decision
Skip `solve_camera_pose.py` / `delight_albedo.py` / `bake_projected_texture.py`.
Do NOT bake the reference's pixels onto the mesh.

## Why projection is wrong here, specifically
Projection-first is the right lever when a reference's *surface* carries the identity and a
procedural material would approximate it wrongly (a Doppler finish, a decal, a face). That is
not this case, and projecting would actively damage the result:

1. **The reference's pixels are not a surface — they are a scene.** Houses, trees, the windmill,
   the castle and the clouds are all *in* the image. Projecting bakes those objects into the
   ground albedo, so the model would carry painted trees on the terrain AND geometric trees
   standing on top of them.
2. **Occluders would smear.** Clouds sit at and below plateau height and cover the rear-right
   mesa. Those cloud pixels have no ground behind them in this view; projection would paint
   white cloud onto the mesa's rock.
3. **Oblique incidence on the risers.** The view is isometric at ~30 deg elevation. Cliff faces
   are near-vertical, so they receive pixels at grazing incidence and would stretch into
   vertical smears — and the cliff striation is an enumerated identity detail.
4. **Baked light is the point of the art.** De-lighting is a hard requirement before projection.
   The reference's value structure IS its painted lighting; de-lighting it would strip the very
   quality the user asked to preserve ("render as it is").

## What replaces it — plan-view layout extraction
The reference's real fidelity lever here is **layout, not texture**: which quadrant each
landmark sits in, and where the coastline runs. So the reference is used as *geometric*
evidence rather than as pixels-on-a-mesh:

- Colour-classify the reference into biome classes (deep sea / shallow / foam / beach / grass /
  field / rock / snow / ochre-mesa / cloud).
- Inverse the isometric projection to recover a plan-view mask.
- Drive the heightfield's coastline and biome assignment from that mask.

This is evidence extraction into the spec, not an MCP-only scene mutation: the derived mask is
written to disk and consumed by the generated factory.

## Known error in the extraction, stated up front
The inverse isometric transform assumes ground height h = 0. A point at height h appears
displaced up-screen by h*cos(elevation), so plateau tops un-project with an offset toward the
viewer proportional to their elevation. Plateau height is ~8% of slab width here, so the
worst-case planar error is a few percent of the island's extent — acceptable for a stylized
reconstruction, and it is an approximation, not a measurement.
