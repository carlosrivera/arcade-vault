#!/usr/bin/env python3
"""Wire measured evidence, roughness maps, feature targets and lighting into the spec."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.home()/'.claude/skills/img2threejs/forge/stage1_intake'))
from extract_pbr_evidence import read_png

spec = json.load(open('object-sculpt-spec.json'))
analysis = json.load(open('material-analysis.json'))
by_region = {r['regionId']: r for r in analysis['regions']}
bbox = {r['regionId']: r['bbox'] for r in json.load(open('material-regions.json'))['regions']}
w, h, px = read_png(Path('reference.png'))

# Spec material ids and measured region ids are not one-to-one: hull-dark is measured by
# the `hull-shade` crop.
#
# The decal is worth being precise about. Its GLYPHS are generated - drawn to a canvas at
# build time, not projected from the reference (projection-route.md). Its INK is measured:
# the white has a colour (#F2F5F8, not pure white) and a finish, and sampling it is what
# makes the generated glyph match the reference instead of guessing. Generated pattern,
# measured material - the two are independent, and treating "generated" as "unmeasurable"
# was wrong.
REGION_FOR = {'hull': 'hull', 'hull-dark': 'hull-shade', 'canopy': 'canopy',
              'emissive': 'emissive', 'nozzle-glow': 'nozzle-glow',
              'vent-orange': 'vent-orange', 'decal': 'decal'}

def measured(rid):
    b = bbox[rid]; tot = [0,0,0]; n = 0
    for y in range(b['y'], min(h, b['y']+b['height'])):
        for x in range(b['x'], min(w, b['x']+b['width'])):
            r,g,bl,_ = px[y*w+x]; tot[0]+=r; tot[1]+=g; tot[2]+=bl; n+=1
    return '#%02X%02X%02X' % tuple(c//max(n,1) for c in tot)

def as_url(p):
    marker = '/models/exis-07/'
    return p.split(marker,1)[1] if p and marker in p else p

notes = []
for m in spec['materials']:
    # Every material gets these three regardless of evidence: the skeleton template ships
    # transmission.base 1.0, which renders the whole craft invisible.
    m['transmission'] = {'base': 0.0, 'variation': 0.0}
    m['opacity'] = {'base': 1.0}
    m['ior'] = {'base': 1.5, 'variation': 0.0}
    amp = m['colorVariation']['amplitude']
    m['surfaceFrequencyBands'] = [
        {'id':'macro','frequency':0.5,'amplitude':round(amp,3),
         'detail':f'Overall {m["name"].lower()} mass and the value step between facets.'},
        {'id':'meso','frequency':3.5,'amplitude':round(amp*0.5,3),
         'detail':m['colorVariation']['pattern'] + ' variation across the panel.'},
        {'id':'micro','frequency':20.0,'amplitude':round(amp*0.1,3),
         'detail':'Deliberately near-flat: the reference has no visible microstructure, '
                  'so inventing grain here would contradict the source.'},
    ]
    rid = REGION_FOR.get(m['id'])
    if not rid or rid not in by_region:
        # Decals are generated, not sampled. Say so rather than leaving a silent gap.
        r0 = m['roughness']
        r0 = r0 if isinstance(r0, (int, float)) else r0.get('value', r0.get('base', 0.5))
        m['roughness'] = {'base': r0, 'value': r0, 'map': None,
                          'source': 'authored',
                          'note': 'Generated canvas decal; no reference crop exists to sample.'}
        m['referencePbr'] = {'usable': False, 'confidence': 0.0, 'verdict': 'not-applicable',
            'limitation': 'Decals are drawn procedurally at build time (see '
                          'projection-route.md); there is no measured crop and none is needed.',
            'source': 'authored'}
        notes.append(f"{m['id']}: authored, not measured (generated canvas decal)")
        continue
    pbr = by_region[rid]['assignment']['evidence']['pbr']
    maps = pbr.get('maps', {})
    # Idempotent: on a second run `roughness` is already the dict this script wrote, so
    # reading it as a float silently fell back to 0.5 and flattened every material's
    # authored finish - satin hull, glossy canopy and matte vent all became the same 0.5.
    r = m['roughness']
    authored = r if isinstance(r, (int, float)) else r.get('value', r.get('base', 0.5))
    m['roughness'] = {'base': authored, 'value': authored,
                      'map': as_url(maps.get('roughness',{}).get('path')),
                      'source': 'reference-pixel-extraction',
                      'note': 'Extracted map carries variation; the scalar is the authored mean.'}
    if m['id'] == 'canopy':
        # Glazing over a dark tint: a clearcoat is the physically right way to get the hard,
        # tight specular the reference shows without lowering the base roughness so far that
        # the facets turn mirror-like.
        m['clearcoat'] = {'base': 0.65}
        m['clearcoatRoughness'] = {'base': 0.06}
    m['normalMap'] = as_url(maps.get('normal',{}).get('path'))
    m['aoMap'] = as_url(maps.get('ao',{}).get('path'))
    m['referencePbr'] = {
        'usable': pbr['verdict'] == 'pass', 'confidence': pbr['confidence'],
        'verdict': pbr['verdict'], 'measuredAlbedo': measured(rid),
        'palette': pbr.get('palette', []), 'cropPath': pbr['sourceImage'],
        'assignedProfile': by_region[rid]['assignment']['materialId'],
        'sampledRegion': rid, 'source': 'reference-pixel-extraction',
        'patternSource': ('generated-canvas' if m['id'] == 'decal'
                          else 'geometry'),
        'estimatedFidelity': pbr.get('estimatedFidelity', pbr['confidence']),
        'targetThreshold': pbr.get('targetThreshold', 0.7),
        'maps': {k: {'path': as_url(v.get('path')), 'url': as_url(v.get('path')),
                     'channel': k, 'source': 'reference-pixel-extraction'}
                 for k, v in maps.items()}}

spec['featureReviewTargets'] = [
 {'id':'faceted-hull','name':'Faceted hull form and silhouette','tier':'critical',
  'passIds':['blockout','structural-pass'],'minimumScore':0.80,'mustPass':True,
  'componentRefs':['hull','nose-wedge','wing'],'evidenceRefs':['crops/top.png','crops/side.png']},
 {'id':'emissive-routing','name':'Cyan emissive channel routing','tier':'critical',
  'passIds':['material-pass','surface-pass'],'minimumScore':0.80,'mustPass':True,
  'componentRefs':['chine-strip','nose-chevron','wing','dorsal-fin'],
  'evidenceRefs':['crops/top.png','crops/threequarter.png']},
 {'id':'propulsion-cluster','name':'Three-nozzle tail','tier':'critical',
  'passIds':['structural-pass'],'minimumScore':0.80,'mustPass':True,
  'componentRefs':['engine-central','engine-outboard','nozzle-core'],
  'evidenceRefs':['crops/rear.png']},
 {'id':'dorsal-assembly','name':'Canopy, fins and vents','tier':'critical',
  'passIds':['structural-pass','form-refinement'],'minimumScore':0.78,'mustPass':True,
  'componentRefs':['canopy','dorsal-fin','vent-block'],
  'evidenceRefs':['crops/threequarter.png','crops/rear.png']},
 {'id':'material-response','name':'Satin hull against unlit-bright emissive','tier':'critical',
  'passIds':['material-pass','lighting-pass'],'minimumScore':0.80,'mustPass':True,
  'componentRefs':['hull','canopy','chine-strip'],'evidenceRefs':['crops/threequarter.png']},
 {'id':'trailing-structure','name':'Feather plates and wingtip pods','tier':'important',
  'passIds':['form-refinement'],'minimumScore':0.72,'mustPass':False,
  'componentRefs':['feather-plate','wingtip-pod'],'evidenceRefs':['crops/side.png']},
]

# Lighting: a studio three-point setup, because the reference IS a studio render on white -
# not a scene with a sun. Contrast is high enough for facets to separate by orientation.
spec['lightingFromPhoto'] = [
 {'id':'key','type':'directional','intensity':2.4,'color':'#FFFFFF',
  'position':[0.6,0.85,0.7],'castsShadow':True,
  'role':'Main studio key, high and to port, matching the reference highlight direction.',
  'toneMapping':'ACESFilmic','exposure':1.0},
 {'id':'fill','type':'directional','intensity':0.75,'color':'#AFC6E0',
  'position':[-0.8,0.2,0.4],'castsShadow':False,
  'role':'Cool fill from the shadow side so dark facets stay separable rather than crushing.'},
 {'id':'rim','type':'directional','intensity':1.1,'color':'#9FD8FF',
  'position':[-0.3,0.4,-1.0],'castsShadow':False,
  'role':'Back rim that catches the trailing edges and fin tips. A rim is correct HERE - '
         'this is a studio product render, not the painted diorama where a rim would have '
         'read as stylised edge lighting.'},
 {'id':'ambient','type':'ambient','intensity':0.28,'color':'#C8D6E8',
  'position':[0,0,0],'castsShadow':False,
  'role':'Low ambient floor. Kept low deliberately: facet separation depends on contrast.'},
 {'id':'shadow-policy','type':'shadow-policy','intensity':0.0,'color':'#000000',
  'position':[0,0,0],'castsShadow':True,
  'role':'Contact shadow and ground shadow on, with ambient occlusion in the nozzle recesses '
         'and the channel grooves. Without occlusion in those recesses the nozzles read as '
         'flat discs rather than sockets, and the emissive channels lose their inset depth.'},
]
for p in spec['buildPasses']:
    if p.get('id') == 'lighting-pass':
        p['lights'] = spec['lightingFromPhoto']
        p['environment'] = {'type':'studio-neutral','top':'#F4F7FA','bottom':'#DCE3EA','intensity':0.5}
        p['shadowBehavior'] = {'contactShadow':True,'groundShadow':True,'type':'PCFSoft','mapSize':2048}
spec['lookDevTargets']['lightingPass'] = {
 'lights': spec['lightingFromPhoto'],
 'environment': {'type':'studio-neutral','top':'#F4F7FA','bottom':'#DCE3EA','intensity':0.5},
 'toneMapping':'ACESFilmic','exposure':1.0,
 'shadowBehavior':{'contactShadow':True,'groundShadow':True,'type':'PCFSoft','mapSize':2048,
   'bias':-0.0004,'radius':2.0,
   'note':'Ambient occlusion in nozzle recesses and light channels is what sells them as cut '
          'into the hull rather than painted on it.'},
 'bloom':{'enabled':True,'strength':0.55,'radius':0.4,'threshold':0.85,
   'note':'The reference has a visible halo around every emissive run; without bloom the '
          'strips read as flat cyan paint.'},
 'forbidden':['toon gradient map','posterisation','smooth vertex normals on hull materials'],
}
json.dump(spec, open('object-sculpt-spec.json','w'), indent=2)
print('materials wired:', sum(1 for m in spec['materials'] if 'referencePbr' in m))
for n in notes: print('NOTE', n)
