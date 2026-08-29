#!/usr/bin/env python3
"""Author the EXIS 07 spec on top of the generated skeleton.

Components and materials are deep-copied from the skeleton's own templates so every schema
field is present by construction. Known skeleton traps fixed up front: the template material
carries transmission.base 1.0 (which renders every surface invisible) and materialId 'base'
(which does not exist in the authored list).
"""
import copy, json

spec = json.load(open('object-sculpt-spec.json'))
CT, MT = copy.deepcopy(spec['componentTree'][0]), copy.deepcopy(spec['materials'][0])
MATS = {}

def comp(id, name, level, role, primitive, topo, rationale, parent=None, material=None,
         dims=(1,1,1), pos=(0,0,0), conf=0.85, features=None, contact=None):
    c = copy.deepcopy(CT)
    c.update({'id': id, 'name': name, 'level': level, 'role': role, 'primitive': primitive,
              'topologyClass': topo, 'topologyRationale': rationale, 'parent': parent,
              'confidence': conf, 'importance': 0.9 if level == 'macro' else 0.6})
    c['dimensions'].update({'width': dims[0], 'height': dims[1], 'depth': dims[2],
                            'units': 'relative', 'confidence': conf})
    c['transform']['position'] = list(pos)
    resolved = material or 'hull'
    c['materialId'] = resolved
    c['materialLayers'] = [resolved]
    def rebind(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str) and v == 'base' and 'material' in k.lower():
                    node[k] = resolved
                else: rebind(v)
        elif isinstance(node, list):
            for v in node: rebind(v)
    rebind(c)
    c['localFeatures'] = features or []
    if parent:
        ct = contact or 'butt'
        c['attachment'] = {
            'parentId': parent, 'parentSocket': f'{parent}-surface', 'contactType': ct,
            'localStart': [0.0, 0.0, 0.0], 'localEnd': [0.0, dims[1], 0.0],
            'embedDepth': (0.22 if ct in ('embed','socket') else 0.06) * max(dims[1], 1e-4),
            'overlap': (0.15 if ct == 'overlap' else 0.05) * max(dims[1], 1e-4),
            'gapTolerance': 0.002, 'confidence': conf}
    pal = MATS.get(resolved, ['#2F3D4D'])
    def rgba(hx):
        h = hx.lstrip('#')
        return 'rgba(%d, %d, %d, 1.0)' % tuple(int(h[i:i+2],16) for i in (0,2,4))
    CLASS = {'canopy': ('glass', 0.75), 'emissive': ('plastic', 0.6),
             'nozzle-glow': ('plastic', 0.6), 'vent-orange': ('metal', 0.6)}
    mclass, mconf = CLASS.get(resolved, ('metal', 0.8))
    c['colorMaterialRecipe'] = {
        'baseColor': pal[0], 'dominantAlbedo': rgba(pal[0]),
        'secondaryAlbedo': rgba(pal[1] if len(pal) > 1 else pal[0]),
        'materialClass': mclass, 'materialClassConfidence': mconf,
        'gradientStops': [{'position': 0.0, 'color': pal[0]},
                          {'position': 0.5, 'color': pal[1] if len(pal)>1 else pal[0]},
                          {'position': 1.0, 'color': pal[2] if len(pal)>2 else pal[0]}],
        'finishStyle': 'emissive' if resolved in ('emissive','nozzle-glow')
                       else 'gloss' if resolved == 'canopy' else 'satin',
        'shadingModel': 'faceted-pbr-with-flat-normals',
        'note': 'Flat shading throughout: the value read comes from facet orientation.'}
    return c

OVERRIDES = {
 'hull': [
   {'id':'facet-value-step','description':'Adjacent facets separate by value alone; the step across a crease is the primary read of the form.','channel':'albedo'},
   {'id':'crease-specular','description':'A satin specular tracks each crease line as the view moves, brightest where a facet turns toward the key.','channel':'roughness'},
   {'id':'recess-occlusion','description':'Panel recesses, channel grooves and nozzle sockets darken from ambient occlusion; without it they read as painted lines.','channel':'ao'}],
 'hull-dark': [
   {'id':'panel-darkening','description':'Certain panels - undersides, recess walls, feather plates - sit darker than facet angle alone explains.','channel':'albedo'},
   {'id':'cavity-ao','description':'Deep occlusion inside the nozzle housings and between stacked feather plates.','channel':'ao'}],
 'canopy': [
   {'id':'tint-depth','description':'The glazing darkens toward its centre where the tint is seen through more depth.','channel':'albedo'},
   {'id':'hard-specular','description':'A tight, hard-edged specular that does not blur across facets, which is what separates glazing from painted hull.','channel':'roughness'}],
 'emissive': [
   {'id':'core-to-edge','description':'Each run blows to near-white at its core and falls to #1f7ac0 at the channel edge - a gradient across the strip width, not a flat fill.','channel':'emissive'},
   {'id':'channel-shadow','description':'The channel walls either side of a strip stay dark, which is what makes the light read as inset.','channel':'ao'}],
 'nozzle-glow': [
   {'id':'bar-banding','description':'Discrete horizontal bars with dark gaps between them, not a continuous glowing plate.','channel':'emissive'},
   {'id':'recess-falloff','description':'The glow dims toward the recess walls where the housing occludes it.','channel':'ao'}],
 'vent-orange': [
   {'id':'shaded-not-emissive','description':'Takes the full lighting solution like the hull. This is the one override that exists to record a NEGATIVE: the vent must never gain an emissive channel.','channel':'albedo'}],
 'decal': [
   {'id':'glyph-edges','description':'Hard-edged white glyphs following the hull surface, slightly off-white (#F2F5F8 measured) rather than pure white.','channel':'albedo'}],
}

def mat(id, name, color, rough, metal, palette, pattern, amp, notes, emissive=None):
    m = copy.deepcopy(MT)
    m.update({'id': id, 'name': name, 'baseColor': color, 'color': color, 'type': 'standard',
              'shaderModel': 'MeshStandardMaterial / faceted PBR',
              'roughness': rough, 'metalness': metal, 'notes': notes})
    m['albedo'] = {'dominant': color, 'secondary': palette[1:3], 'samplingNotes': notes}
    m['colorVariation'] = {'palette': palette, 'pattern': pattern, 'amplitude': amp,
                           'heightCorrelation': 0.2}
    if emissive:
        m['emissive'] = emissive['color']
        m['emissiveIntensity'] = emissive['intensity']
    m['localOverrides'] = OVERRIDES.get(id, [])
    MATS[id] = palette
    return m

FACETED = ('Flat-shaded satin finish. The reference reads its form entirely through facet '
           'orientation, so normals must stay per-face; smoothing them destroys the design '
           'language. No wear, grime or texture appears anywhere on this craft.')
spec['materials'] = [
 mat('hull','Hull satin charcoal','#2F3D4D',0.42,0.15,['#2F3D4D','#3A485C','#16222D'],
     'faceted',0.30, 'Measured from the sunlit upper hull. '+FACETED,
     ),
 mat('hull-dark','Hull shadow panel','#16222D',0.46,0.15,['#16222D','#1F2C39','#101A23'],
     'faceted',0.22,
     'Measured from the shadowed lower flank. A second darker hull tone is authored rather '
     'than left to lighting alone, because the reference darkens certain panels (undersides, '
     'recess walls) beyond what facet angle explains. '+FACETED),
 mat('canopy','Canopy tint','#2A3645',0.15,0.30,['#2A3645','#3A4A63','#1B2430'],
     'faceted',0.25,
     'Dark blue tinted glass, faceted like the hull. Rendered OPAQUE: no interior is visible '
     'in any of the four views, so transmission would invent a cockpit the reference does '
     'not show. Low roughness gives the hard specular the reference has.'),
 mat('emissive','Cyan channel light','#25b9f5',0.30,0.0,['#9AFBFC','#25b9f5','#1f7ac0'],
     'gradient',0.5,
     'Emissive, not lit: it reads at full brightness on faces turned away from the key, so '
     'it must emit rather than reflect. Blows to near-white at the strip core, measured '
     '#9AFBFC, falling to #1f7ac0 at the channel edge.',
     emissive={'color': '#37c8ff', 'intensity': 2.6}),
 mat('nozzle-glow','Engine core glow','#8ef6ff',0.25,0.0,['#90FBFC','#37c8ff','#0C4493'],
     'banded',0.55,
     'The grille bars inside each nozzle recess. Brighter than the hull strips - it is the '
     'hottest thing on the craft - and banded horizontally.',
     emissive={'color': '#7fe9ff', 'intensity': 3.4}),
 mat('vent-orange','Intake vent','#EC761A',0.60,0.20,['#EC761A','#F58A2E','#B85510'],
     'flat',0.15,
     'Matte orange. NOT emissive: it takes shading like the hull in every view, which is the '
     'only thing separating it from a second accent light.'),
 mat('decal','Hull decals','#F2F5F8',0.55,0.05,['#F2F5F8','#FFFFFF','#C9D2DA'],
     'glyph',0.1,
     'White marks drawn to a canvas at build time: arrow-in-triangle logo, "07" on nose and '
     'mid-hull, "EXIS" wordmark. Generated rather than cropped - see projection-route.md.'),
]

C = []
C.append(comp('root','EXIS 07 Strike Craft','macro','assembly-root','extrude','assembled-solid',
  'The craft is a polyhedron; the root is its bounding assembly.', dims=(0.62,0.26,1.0), conf=0.95))
C.append(comp('hull','Faceted hull','macro','body','extrude','assembled-solid',
  'An authored polyhedron built from explicit vertices. Not a lathe or sweep: every surface '
  'is a flat facet, so vertex authoring reproduces it exactly instead of approximating it.',
  parent='root', material='hull', dims=(0.62,0.20,1.0), conf=0.95, contact='flush',
  features=[{'id':'hull-faceting','description':'Flat facets meeting at hard creases over the whole surface; no smooth transitions.','evidenceRef':'crops/threequarter.png'},
            {'id':'chine-rail','description':'A chine edge runs the full length at mid-height, separating upper and lower hull.','evidenceRef':'crops/side.png'}]))
C.append(comp('nose-wedge','Nose wedge','meso','body-section','extrude','assembled-solid',
  'A sharp tapering wedge; flat facets converging to a point.',
  parent='hull', material='hull', dims=(0.18,0.09,0.30), pos=(0,0,0.42), conf=0.9))
C.append(comp('canopy','Canopy','meso','glazing','extrude','assembled-solid',
  'A faceted glazing panel set into the spine; a low polyhedron, not a swept bubble.',
  parent='hull', material='canopy', dims=(0.15,0.05,0.30), pos=(0,0.10,0.16), conf=0.9,
  contact='embed',
  features=[{'id':'canopy-glass','description':'Elongated hexagonal plan, faceted, dark blue tint reading opaque with a hard specular.','evidenceRef':'crops/threequarter.png'}]))
C.append(comp('dorsal-spine','Dorsal spine','meso','body-section','extrude','assembled-solid',
  'The raised centreline ridge running from behind the nose to the fin roots. It is the '
  'section the canopy is recessed into and the fins spring from, so modelling it as part of '
  'the hull loses both attachment points.',
  parent='hull', material='hull', dims=(0.16,0.09,0.55), pos=(0,0.09,0.02), conf=0.9,
  features=[{'id':'spine-ridge','description':'Raised ridge carrying the canopy recess forward and the fin roots aft.','evidenceRef':'crops/threequarter.png'}]))
C.append(comp('wing','Wing panel','macro','aerofoil','extrude','assembled-solid',
  'The wing is the hull flare continued outboard, built as faceted panels; mirrored about '
  'the centreline, so the pair is a reflection and not a rotation.',
  parent='hull', material='hull', dims=(0.24,0.05,0.55), pos=(0.20,-0.01,-0.05), conf=0.9,
  features=[{'id':'wing-loop','description':'A large angular emissive loop traces the rear wing panel, following panel breaks with hard corners.','evidenceRef':'crops/top.png'}]))
C.append(comp('wingtip-pod','Wingtip pod','meso','housing','extrude','assembled-solid',
  'A faceted block terminating the wing and housing an outboard engine.',
  parent='wing', material='hull', dims=(0.09,0.07,0.26), pos=(0.30,0,-0.10), conf=0.9,
  features=[{'id':'tip-slot','description':'A cyan emissive slot on the pod leading face.','evidenceRef':'crops/top.png'}]))
C.append(comp('dorsal-fin','Dorsal fin','meso','stabiliser','extrude','assembled-solid',
  'A swept flat plate, one per side, splayed outboard from the rear spine.',
  parent='hull', material='hull', dims=(0.03,0.14,0.22), pos=(0.06,0.14,-0.30), conf=0.9,
  features=[{'id':'fin-strip','description':'Emissive strip along the outer face, parallel to the swept leading edge.','evidenceRef':'crops/side.png'}]))
C.append(comp('feather-plate','Trailing feather plate','meso','fairing','extrude','assembled-solid',
  'Layered swept plates fanning aft from the wing trailing edge, each overlapping the one '
  'below - a stack of thin polyhedra, not one slab.',
  parent='wing', material='hull-dark', dims=(0.16,0.02,0.20), pos=(0.16,0.02,-0.40),
  conf=0.85, contact='overlap',
  features=[{'id':'feather-plates','description':'Four plates per side, each stepped up and aft of the one below.','evidenceRef':'crops/side.png'}]))
C.append(comp('propulsion','Propulsion cluster','macro','assembly','extrude','assembled-solid',
  'Grouping node for the three engines so the cluster can be inspected as one unit.',
  parent='root', material='hull-dark', dims=(0.50,0.12,0.16), pos=(0,0,-0.44), conf=0.9))
C.append(comp('engine-central','Central engine housing','meso','housing','extrude','assembled-solid',
  'An octagonal recessed housing - eight flat walls, which is what the rear view shows; a '
  'cylinder would round off the corners the reference keeps sharp.',
  parent='propulsion', material='hull-dark', dims=(0.16,0.11,0.10), pos=(0,0.01,-0.46),
  conf=0.95, contact='socket',
  features=[{'id':'nozzle-recess','description':'Octagonal recess, walls stepping inward to the grille.','evidenceRef':'crops/rear.png'}]))
C.append(comp('engine-outboard','Outboard engine housing','meso','housing','extrude','assembled-solid',
  'The same octagonal recess at smaller scale, one inside each wingtip pod.',
  parent='wingtip-pod', material='hull-dark', dims=(0.11,0.08,0.09), pos=(0.30,-0.01,-0.34),
  conf=0.9, contact='socket'))
C.append(comp('nozzle-core','Engine grille','micro','emitter','box','assembled-solid',
  'Horizontal emissive bars filling each nozzle recess.',
  parent='engine-central', material='nozzle-glow', dims=(0.10,0.07,0.01), conf=0.9,
  features=[{'id':'grille-bars','description':'Five bars on the central nozzle, four on each outboard.','evidenceRef':'crops/rear.png'}]))
C.append(comp('chine-strip','Chine light channel','micro','emitter','extrude','surface-relief',
  'An emissive run INSET into a recessed channel along the chine - relief cut into the hull '
  'surface, not a decal lying on it.',
  parent='hull', material='emissive', dims=(0.02,0.01,0.80), conf=0.95, contact='embed',
  features=[{'id':'chine-strip','description':'Unbroken cyan run from nose to tail along the mid-hull chine.','evidenceRef':'crops/threequarter.png'}]))
C.append(comp('nose-chevron','Nose chevron light','micro','emitter','extrude','surface-relief',
  'A V-shaped emissive channel wrapping the underside of the nose.',
  parent='nose-wedge', material='emissive', dims=(0.30,0.01,0.16), conf=0.9, contact='embed',
  features=[{'id':'nose-chevron','description':'V run with the apex pointing forward.','evidenceRef':'crops/top.png'}]))
C.append(comp('vent-block','Intake vent','micro','vent','box','assembled-solid',
  'A matte orange block seated in a recessed socket.',
  parent='hull', material='vent-orange', dims=(0.035,0.02,0.07), conf=0.9, contact='socket',
  features=[{'id':'vent-block','description':'Two on the dorsal spine, one per side aft; shaded, not emissive.','evidenceRef':'crops/threequarter.png'}]))
C.append(comp('decal-set','Hull decals','micro','marking','plane-card','surface-relief',
  'Flat marks on the hull surface, drawn to a canvas at build time.',
  parent='hull', material='decal', dims=(0.10,0.001,0.10), conf=0.8, contact='overlap',
  features=[{'id':'decal-set','description':'Arrow logo and "07" on the nose, "EXIS" and "07" on the mid-hull side.','evidenceRef':'crops/threequarter.png'}]))
spec['componentTree'] = C

spec['repetitionSystems'] = [
 {'id':'feather-stack','name':'Trailing feather plates','componentRef':'feather-plate',
  'buildsGeometry':True,'realization':'instanced-geometry','count':8,
  'distribution':'Four per side, mirrored. Each plate is stepped aft and up from the one '
                 'below, with decreasing chord, so the stack fans rather than stacking square.',
  'seed':20260901,'jitter':0.0,
  'instances':{'mode':'array','anchorSurface':'wing','alignToNormal':False},
  'evidenceRefs':['crops/side.png']},
 {'id':'grille-bars','name':'Nozzle grille bars','componentRef':'nozzle-core',
  'buildsGeometry':True,'realization':'instanced-geometry','count':13,
  'distribution':'Five bars in the central nozzle, four in each outboard, evenly spaced '
                 'horizontally and inset behind the recess lip.',
  'seed':20260902,'jitter':0.0,
  'instances':{'mode':'array','anchorSurface':'engine-central'},
  'evidenceRefs':['crops/rear.png']},
 {'id':'vent-array','name':'Orange intake vents','componentRef':'vent-block',
  'buildsGeometry':True,'realization':'instanced-geometry','count':4,
  'distribution':'Two on the dorsal spine (fore and mid) and one per side aft, all recessed '
                 'into sockets rather than sitting proud.',
  'seed':20260903,'jitter':0.0,
  'instances':{'mode':'array','anchorSurface':'hull'},
  'evidenceRefs':['crops/threequarter.png']},
]

spec['coordinateFrame'] = {'front':'+Z','up':'+Y',
  'scaleReference':'Overall length = 1.0 relative unit; span 0.62; height 0.26.'}
spec['silhouette'] = {
 'boundingShape':'flattened arrowhead, length 1.00 : span 0.62 : height 0.26',
 'aspectRatios':[{'name':'span-to-length','value':0.62},{'name':'height-to-length','value':0.26},
                 {'name':'height-to-span','value':0.42}],
 'symmetry':'bilateral about the centreline plane',
 'dominantCurves':['none - every edge is straight; the silhouette is polygonal throughout'],
 'negativeSpaces':['the gap between the twin dorsal fins',
                   'the octagonal voids of the three nozzle recesses',
                   'the slots between stacked feather plates',
                   'the recessed channels the emissive strips sit in'],
 'landmarks':['wedge nose with chine rail','hexagonal canopy in a raised spine',
              'twin swept dorsal fins','three octagonal nozzles',
              'four feather plates per side','wingtip pods with emissive slots',
              'chine emissive run','nose chevron','wing emissive loop','orange vents'],
}
spec['referenceCamera'] = {'solved':True,'projection':'perspective','fovDegrees':28.0,'aspect':1.33,
 'orientation':{'azimuthDegrees':38.0,'elevationDegrees':22.0,'rollDegrees':0.0},
 'positionHint':[1.6,0.75,2.0],
 'note':'Matched to the three-quarter view: a long lens (~28 deg) with mild convergence, '
        'looking down about 22 degrees from ahead and to port.'}
spec['assumptions'] = [
 'Underside is inference, constrained by the side profile: a flat faceted belly.',
 'No cockpit interior; the canopy is opaque in every view.',
 'Feather plate count is four per side, read from the three-quarter view.',
 'Grille bars: five central, four per outboard, read from the rear view.',
 'The arrow logo is reproduced as a chevron-in-triangle approximation; its internal '
 'geometry is below the reference resolution.',
]
spec['risks'] = [
 {'id':'smooth-shading','description':'Computed vertex normals would smooth the facets and '
  'destroy the entire design language.','severity':'high',
  'mitigation':'flatShading on every hull material; faceted-hull review target is mustPass.'},
 {'id':'emissive-as-lit','description':'Rendering the cyan as a bright lit colour instead of '
  'an emitter makes it dim on shadowed faces, which the reference never does.',
  'severity':'high','mitigation':'emissive channel with intensity 2.6-3.4, checked on a '
  'face turned away from the key light.'},
 {'id':'orange-as-emissive','description':'The orange vents are matte and shaded; treating '
  'them as a second accent light is the easy mistake.','severity':'medium',
  'mitigation':'vent-orange carries no emissive channel at all.'},
 {'id':'nozzle-count','description':'Three nozzles, not two or four - only the rear view '
  'shows this.','severity':'medium','mitigation':'propulsion-cluster review target.'},
]
spec['performanceBudget'].update({'targetTriangles':60000,'maxDrawCalls':30,'fpsTarget':60,
  'qualityPriority':'quality',
  'optimizationPolicy':'authored low-poly; instance the feather plates and grille bars'})
json.dump(spec, open('object-sculpt-spec.json','w'), indent=2)
print(f"components={len(C)} materials={len(spec['materials'])} repetition={len(spec['repetitionSystems'])}")
