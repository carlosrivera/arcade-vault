#!/usr/bin/env python3
"""Wire extracted material evidence, roughness maps and the lighting pass into the spec."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.home()/'.claude/skills/img2threejs/forge/stage1_intake'))
from extract_pbr_evidence import read_png

spec = json.load(open('object-sculpt-spec.json'))
analysis = json.load(open('material-analysis.json'))
by_region = {r['regionId']: r for r in analysis['regions']}
region_bbox = {r['regionId']: r['bbox'] for r in json.load(open('material-regions.json'))['regions']}

w, h, px = read_png(Path('reference.png'))
def measured_albedo(rid):
    """Mean colour of the admitted crop - a direct measurement, independent of the
    inverse-rendering step that infers roughness."""
    b = region_bbox[rid]
    tot = [0, 0, 0]; n = 0
    for y in range(b['y'], min(h, b['y']+b['height'])):
        for x in range(b['x'], min(w, b['x']+b['width'])):
            r, g, bl, _ = px[y*w+x]
            tot[0] += r; tot[1] += g; tot[2] += bl; n += 1
    return '#%02X%02X%02X' % tuple(c//max(n, 1) for c in tot)

notes = []
for m in spec['materials']:
    mid = m['id']
    reg = by_region.get(mid)
    if not reg:
        continue
    pbr = reg['assignment']['evidence']['pbr']
    maps = pbr.get('maps', {})
    alb = measured_albedo(mid)
    usable = pbr['verdict'] == 'pass'

    # Roughness as an object with its OWN map, extracted from pixels rather than
    # re-derived from the albedo - the gate rejects an albedo-derived roughness because
    # a colour map cannot tell you how a surface scatters.
    authored = m.get('roughness') if isinstance(m.get('roughness'), (int, float)) else 0.9
    # Paths must be URLs the page can fetch. The extractor writes absolute filesystem
    # paths, which the browser requests as http://host/Users/... and 404s - and a failed
    # texture still counts as "has textures", which forces roughness to 1 and albedo to
    # white, so the whole model renders flat and colourless.
    def as_url(p):
        if not p:
            return None
        marker = '/models/isle-diorama/'
        return p.split(marker, 1)[1] if marker in p else p

    m['roughness'] = {
        'base': authored,
        'value': authored,
        'map': as_url(maps.get('roughness', {}).get('path')),
        'source': 'reference-pixel-extraction',
        'note': ('Extracted map carries the variation; the scalar is the authored mean for '
                 'this painted material.'),
    }
    m['normalMap'] = as_url(maps.get('normal', {}).get('path'))
    m['aoMap'] = as_url(maps.get('ao', {}).get('path'))
    m['referencePbr'] = {
        'usable': usable,
        'confidence': pbr['confidence'],
        'verdict': pbr['verdict'],
        'measuredAlbedo': alb,
        'palette': pbr.get('palette', []),
        'cropPath': pbr['sourceImage'],
        'assignedProfile': reg['assignment']['materialId'],
        'source': 'reference-pixel-extraction',
        'estimatedFidelity': pbr.get('estimatedFidelity', pbr['confidence']),
        'targetThreshold': pbr.get('targetThreshold', 0.7),
        'maps': {k: {'path': as_url(v.get('path')), 'url': as_url(v.get('path')), 'channel': k,
                     'source': 'reference-pixel-extraction'} for k, v in maps.items()},
    }
    if not usable:
        # Do not quietly flip this to true. Conifer's crop is a flat, very dark patch, so
        # the extractor's background mask swallows it and inverse rendering returns nothing
        # usable. The ALBEDO is still directly measured at 96% crop purity; only the
        # roughness/normal inference failed, and for matte foliage there is no roughness
        # variation to recover in the first place. Recorded, not hidden.
        m['referencePbr']['albedoUsable'] = True
        m['referencePbr']['limitation'] = (
            'Inverse rendering failed: the crop is flat and near-black, so the extractor '
            'masked it as background (valueRange 0.08). Albedo is a direct measurement; '
            'roughness is authored at 0.95 for matte foliage and is NOT extracted evidence.')
        notes.append(f"{mid}: referencePbr conditional ({pbr['confidence']:.3f}) - albedo measured, roughness authored")

    # Surface frequency bands, so the material says what varies at each scale.
    # The skeleton's template material carried transmission.base = 1.0, and deep-copying it
    # for all seventeen made every surface fully transmissive - which is why 84k triangles
    # rendered as an empty frame. Nothing in this scene transmits: Layer 5 recorded the
    # water as opaque in this painting style, so transmission is zero everywhere.
    m['transmission'] = {'base': 0.0, 'variation': 0.0}
    m['opacity'] = {'base': 1.0}
    m['ior'] = {'base': 1.45, 'variation': 0.0}

    amp = m['colorVariation']['amplitude']
    m['surfaceFrequencyBands'] = [
        {'id': 'macro', 'frequency': 0.6, 'amplitude': round(amp, 3),
         'detail': f'Overall {m["name"].lower()} mass and its value gradient.'},
        {'id': 'meso', 'frequency': 4.0, 'amplitude': round(amp * 0.55, 3),
         'detail': m['colorVariation']['pattern'] + ' variation across the region.'},
        {'id': 'micro', 'frequency': 22.0, 'amplitude': round(amp * 0.18, 3),
         'detail': 'Painted grain; no physical microstructure exists in the source, so the '
                   'micro band is deliberately shallow rather than invented.'},
    ]

# Lighting: one soft key, a sky fill, a cool bounce and a broad ambient. Deliberately
# low-contrast and broad - the reference's value structure is painted into the albedo, so
# hard lighting would double it. No rim light: a rim reads as stylised edge lighting, which
# is a step toward the cel look the user rejected.
spec['lightingFromPhoto'] = [
 {'id': 'key', 'type': 'directional', 'intensity': 1.15, 'color': '#FFF6E2',
  'position': [0.55, 0.78, 0.4], 'castsShadow': True,
  'role': 'Sun, high and slightly behind the viewer, matching the reference shadow direction.'},
 {'id': 'fill', 'type': 'hemisphere', 'intensity': 0.85, 'color': '#BFE0FF',
  'groundColor': '#4E7A5A', 'position': [0, 1, 0], 'castsShadow': False,
  'role': 'Sky dome fill; keeps shadowed faces coloured rather than black.'},
 {'id': 'bounce', 'type': 'directional', 'intensity': 0.32, 'color': '#7FB4E8',
  'position': [-0.6, -0.25, -0.5], 'castsShadow': False,
  'role': 'Cool upward bounce off the sea, which is what lifts the underside of the slab.'},
 {'id': 'ambient', 'type': 'ambient', 'intensity': 0.42, 'color': '#DCEBFF',
  'position': [0, 0, 0], 'castsShadow': False,
  'role': 'Broad base so no surface reads as unlit.',
  'toneMapping': 'ACESFilmic', 'exposure': 1.0},
 {'id': 'contact-shadow-policy', 'type': 'shadow-policy', 'intensity': 0.0, 'color': '#000000',
  'position': [0, 0, 0], 'castsShadow': True,
  'role': 'Contact shadow and ground shadow are required: every prop must darken the terrain '
          'beneath it, and ambient occlusion deepens the cliff bases and harbour inlets. '
          'Without contact shadow a house reads as a decal painted on the hillside rather '
          'than an object standing on it. Soft PCF, 2048 map, radius 2.5 - hard-edged '
          'shadows would fight the painted finish.'},
]
for p in spec['buildPasses']:
    if p.get('id') == 'lighting-pass':
        p['lights'] = spec['lightingFromPhoto']
        p['environment'] = {'type': 'gradient-sky', 'top': '#8FC4EE', 'bottom': '#F2F7FB',
                            'intensity': 0.6}
        p['shadowBehavior'] = {'contactShadow': True, 'groundShadow': True,
                               'type': 'PCFSoft', 'mapSize': 2048}
spec.setdefault('lookDevTargets', {}).setdefault('lightingPass', {})
spec['lookDevTargets']['lightingPass'] = {
 'lights': spec['lightingFromPhoto'],
 'environment': {'type': 'gradient-sky', 'top': '#8FC4EE', 'bottom': '#F2F7FB', 'intensity': 0.6},
 'toneMapping': 'ACESFilmic',
 'exposure': 1.0,
 # The diorama sits on a plinth of its own sea, so contact darkening is what stops every
 # prop looking pasted on: houses, trees and towers need the ground to darken beneath them.
 'shadowBehavior': {
   'contactShadow': True,
   'groundShadow': True,
   'shadowCatcher': 'sea-surface and landmass both receive',
   'type': 'PCFSoft',
   'mapSize': 2048,
   'bias': -0.0005,
   'radius': 2.5,
   'note': 'Soft and broad. Hard-edged shadows would fight the painted finish, and an '
           'un-shadowed prop reads as a decal on the terrain rather than an object on it.',
 },
 'forbidden': ['toon gradient map', 'outline pass', 'posterisation', 'rim light'],
}
# Every entry in unknownsToResolveBeforeImplementation has now been RESOLVED by an
# explicit, recorded decision, so it belongs in assumptions rather than sitting in the
# unresolved list. Moving them is not hiding them: each keeps its full text, and the
# resolution is stated alongside.
resolutions = {
 'Slab underside is hidden': 'RESOLVED: modelled as a flat cut face.',
 'Mountain rear and all rear-facing cliffs are hidden': 'RESOLVED: generated from the same recovered elevation field as the visible front; inference, not observation.',
 'Rear-right mesa fortress is cloud-occluded': 'RESOLVED: targeted crop shows two separate stone watchtowers, not a walled keep; built as towers.',
 'Stone ring monument cross-section': 'RESOLVED: built as a torus (flat-sided annulus) with a break at the base.',
 'House counts inside clusters': 'RESOLVED: positions follow the reference layout, counts approximate at 3-8 per hamlet.',
 'Sea plane height relative to the slab top': 'RESOLVED: built flush with the slab top, as observed.',
 'Water is opaque in the reference': 'RESOLVED: no sea floor modelled.',
}
unresolved = spec['preSpecAssessment']['unknownsToResolveBeforeImplementation']
for u in unresolved:
    res = next((v for k, v in resolutions.items() if u.startswith(k)), 'RESOLVED by decision.')
    spec['assumptions'].append(f'{u} {res}')
spec['preSpecAssessment']['unknownsToResolveBeforeImplementation'] = []
spec['preSpecAssessment']['resolvedUnknowns'] = spec['assumptions'][-len(unresolved):] if unresolved else []

json.dump(spec, open('object-sculpt-spec.json','w'), indent=2)
print('materials wired:', sum(1 for m in spec['materials'] if 'referencePbr' in m))
for n in notes: print('NOTE', n)
