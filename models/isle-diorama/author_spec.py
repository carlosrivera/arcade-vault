#!/usr/bin/env python3
"""Author the diorama spec on top of the generated skeleton.

Components and materials are deep-copied from the skeleton's own templates and then
overridden, so every schema field the validator expects is present by construction
rather than by my remembering it.
"""
import copy, json

spec = json.load(open('object-sculpt-spec.json'))
CT, MT = copy.deepcopy(spec['componentTree'][0]), copy.deepcopy(spec['materials'][0])

def comp(id, name, level, role, primitive, topo, rationale, parent=None, material=None,
         dims=(1,1,1), pos=(0,0,0), conf=0.8, features=None, deform=None, contact=None):
    c = copy.deepcopy(CT)
    c.update({'id': id, 'name': name, 'level': level, 'role': role, 'primitive': primitive,
              'topologyClass': topo, 'topologyRationale': rationale, 'parent': parent,
              'confidence': conf, 'importance': 0.9 if level == 'macro' else 0.6})
    c['dimensions'].update({'width': dims[0], 'height': dims[1], 'depth': dims[2],
                            'units': 'relative', 'confidence': conf})
    c['transform']['position'] = list(pos)
    # Every component names a real material. The skeleton's placeholder 'base' does not
    # exist in the authored material list, so leaving it in place fails validation.
    resolved = material or 'cliff-rock'
    c['materialId'] = resolved
    c['materialLayers'] = [resolved]
    # The skeleton also carries 'base' in the destruction and surface blocks; rewrite
    # every occurrence rather than the two obvious ones, so a schema addition later
    # cannot reintroduce a dangling reference.
    def rebind(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str) and v == 'base' and ('material' in k.lower() or k == 'material'):
                    node[k] = resolved
                else:
                    rebind(v)
        elif isinstance(node, list):
            for v in node:
                rebind(v)
    rebind(c)
    c['localFeatures'] = features or []
    if deform: c['geometryDescriptor']['deformationStack'] = deform
    if parent:
        # The attachment gate wants the full contact description, not just a parent id:
        # where on the parent, how the two meet, and how deep. A part that only names its
        # parent is what lets a hat float at hip height through eight review rounds.
        ct = contact or 'butt'
        c['attachment'] = {
            'parentId': parent, 'parentSocket': f'{parent}-surface', 'contactType': ct,
            'localStart': [0.0, 0.0, 0.0], 'localEnd': [0.0, dims[1], 0.0],
            # Non-zero by necessity, not to satisfy a gate: a prop sitting exactly ON the
            # terrain shows a hairline gap wherever the ground is not level under it, so
            # everything is seated slightly into its host. Embedded parts go deeper.
            'embedDepth': (0.22 if ct in ('embed', 'socket') else 0.06) * max(dims[1], 1e-4),
            'overlap': (0.15 if ct == 'overlap' else 0.05) * max(dims[1], 1e-4),
            'gapTolerance': 0.002, 'confidence': conf,
        }
    # Painted albedo recipe: the value structure lives in the colour, so every component
    # states its own stops rather than inheriting a single averaged tint.
    pal = next((m['colorVariation']['palette'] for m in spec['materials']
                if m['id'] == resolved), ['#8A7A5F'])
    def rgba(hexstr):
        h = hexstr.lstrip('#')
        return 'rgba(%d, %d, %d, 1.0)' % tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
    CLASS = {'sea': ('glass', 0.5), 'slab-water': ('glass', 0.5), 'waterfall': ('glass', 0.5),
             'foam': ('glass', 0.4), 'cloud-mass': ('unknown', 0.35),
             'timber': ('wood', 0.85), 'conifer': ('unknown', 0.6),
             'roof-tile': ('ceramic', 0.8), 'wall-plaster': ('ceramic', 0.7)}
    mclass, mconf = CLASS.get(resolved, ('stone', 0.75))
    c['colorMaterialRecipe'] = {
        'baseColor': pal[0],
        'dominantAlbedo': rgba(pal[0]),
        'secondaryAlbedo': rgba(pal[1] if len(pal) > 1 else pal[0]),
        'materialClass': mclass,
        'materialClassConfidence': mconf,
        'gradientStops': [{'position': 0.0, 'color': pal[0]},
                          {'position': 0.5, 'color': pal[1] if len(pal) > 1 else pal[0]},
                          {'position': 1.0, 'color': pal[2] if len(pal) > 2 else pal[0]}],
        'finishStyle': 'satin' if resolved == 'sea' else 'matte',
        'shadingModel': 'painted-albedo-with-soft-lighting',
        'note': 'Not a toon ramp: the stops are painted albedo, quantisation is forbidden.',
    }
    return c

def mat(id, name, color, rough, palette, pattern, amp, notes, metal=0.0, over=None):
    m = copy.deepcopy(MT)
    m.update({'id': id, 'name': name, 'baseColor': color, 'color': color,
              'type': 'standard', 'shaderModel': 'MeshStandardMaterial / painted albedo',
              'roughness': rough, 'metalness': metal, 'notes': notes})
    m['albedo'] = {'dominant': color, 'secondary': palette[1:3],
                   'samplingNotes': notes}
    m['colorVariation'] = {'palette': palette, 'pattern': pattern,
                           'amplitude': amp, 'heightCorrelation': 0.45}
    m['localOverrides'] = over or []
    return m

# ---------------------------------------------------------------- materials
PAINTED = ('Hand-painted finish, not PBR: the value structure lives in the albedo and the '
           'lighting stays broad and soft. No toon ramp and no ink outline - the user '
           'explicitly rejected cel shading - and no specular hotspot on any matte surface.')
spec['materials'] = [
 mat('sea','Open sea','#1e70ba',0.16,['#1e70ba','#14468c','#2f8fd0'],'depth-graded',0.45,
     'Satin, the only non-matte surface in the scene. Colour is depth-graded, not flat. '+PAINTED,
     over=[{'id':'depth-gradient','description':'Deep blue offshore grading through cyan to pale turquoise in the shallows; keyed to water depth, not to distance from camera.','channel':'albedo'},
           {'id':'shallow-shelf','description':'A turquoise shelf band hugs every shore before the foam line.','channel':'albedo'}]),
 mat('foam','Shore foam','#dceef5',0.9,['#dceef5','#ffffff','#bcdfe9'],'contour-band',0.2,
     'Opaque white band at every land/water contact including islets. '+PAINTED,
     over=[{'id':'foam-crest','description':'Brightest at the contact line, dissolving outward over roughly one cell.','channel':'albedo'}]),
 mat('beach-sand','Beach sand','#e2d09e',0.92,['#e2d09e','#f0e4c0','#c9b47e'],'banded',0.18,
     'Pale cream band between lowland grass and foam, present only where the coast is low. '+PAINTED),
 mat('grass','Lowland grass','#60a846',0.93,['#60a846','#7ebc50','#36763a'],'mottled',0.22,
     'Saturated yellow-green sunlit, deepening to blue-green in shade. '+PAINTED,
     over=[{'id':'slope-shade','description':'Steeper ground darkens toward the blue-green stop.','channel':'albedo'}]),
 mat('field-crop','Farm parcel','#96ba5c',0.93,['#96ba5c','#c8c471','#6f9a45'],'rectilinear-patches',0.35,
     'Parcels alternate green, olive and wheat-tan with hard straight boundaries. '+PAINTED,
     over=[{'id':'parcel-boundary','description':'Hard rectilinear edges between parcels; no blending across a boundary.','channel':'albedo'}]),
 mat('cliff-rock','Cliff rock','#7e808c',0.88,['#7e808c','#9a9aa6','#54566a'],'vertical-fluting',0.3,
     'Grey-violet with vertical fluting and cavity-darkened lines; grass caps the lip hard. '+PAINTED,
     over=[{'id':'flute-shadow','description':'Vertical grooves read as darker lines running the full riser height.','channel':'albedo'},
           {'id':'grass-lip','description':'A hard, unblended edge where grass meets the top of the riser.','channel':'albedo'}]),
 mat('mesa-stone','Mesa sandstone','#cea86a',0.9,['#cea86a','#e0c088','#a8814e'],'horizontal-strata',0.3,
     'Arid ochre sandstone in horizontal terraces - a different biome from the green lowland. '+PAINTED,
     over=[{'id':'terrace-strata','description':'Horizontal bedding lines follow each terrace step.','channel':'albedo'}]),
 mat('mountain-rock','Mountain rock','#587ab0',0.82,['#587ab0','#8098c8','#3d5a8c'],'faceted',0.3,
     'Blue-violet, faceted, reading colder and bluer with altitude. '+PAINTED),
 mat('snow','Summit snow','#e6eef8',0.72,['#e6eef8','#ffffff','#c6d6ea'],'tongued',0.18,
     'Reaches down the gullies in tongues; the snowline follows drainage, not a level contour. '+PAINTED,
     over=[{'id':'gully-tongue','description':'Snow descends further in gullies than on ridges.','channel':'albedo'}]),
 mat('earth-stratum','Slab earth stratum','#8c5c38',0.95,['#8c5c38','#a87048','#6b4228'],'ragged-band',0.25,
     'Warm ochre-brown on the slab cut faces, below the water band. '+PAINTED,
     over=[{'id':'ragged-interface','description':'The top edge of the earth against the water band is ragged along its length, never level - a straight line reads as a printed stripe.','channel':'albedo'}]),
 mat('slab-water','Slab cut-face water band','#2f8fd0',0.35,['#2f8fd0','#4fa8dc','#1e6ca8'],'vertical-gradient',0.2,
     'The sea seen in section on the slab side, brighter than the top surface. '+PAINTED),
 mat('roof-tile','Roof tile','#c2452c',0.85,['#c2452c','#d9603f','#9a3320'],'flat',0.12,
     'Red-orange, the strongest colour accent in the scene and how hamlets read at distance. '+PAINTED),
 mat('wall-plaster','Wall plaster','#f0e8dc',0.9,['#f0e8dc','#ffffff','#d6caba'],'flat',0.1,
     'Cream-white rendered walls on houses, castle, lighthouse and windmill. '+PAINTED),
 mat('conifer','Conifer foliage','#2e6b40',0.95,['#2e6b40','#3f8850','#1e4d2e'],'clustered',0.28,
     'Dark blue-green, darker than the grass it stands on so canopies read as mass. '+PAINTED),
 mat('cloud-mass','Cloud mass','#f8fafc',0.95,['#f8fafc','#ffffff','#dde6f0'],'billowed',0.15,
     'Opaque painted white with a soft grey underside. Not volumetric and not translucent. '+PAINTED),
 mat('timber','Timber','#8a6440',0.9,['#8a6440','#a07850','#6a4a30'],'planked',0.15,
     'Pier decking and posts. '+PAINTED),
 mat('waterfall','Falling water','#e8f4fa',0.4,['#e8f4fa','#ffffff','#bcdcea'],'streaked',0.22,
     'White vertical streaking, brightest at the lip and at the spray disc. '+PAINTED),
]

# ---------------------------------------------------------------- components
HEIGHTFIELD = [{'type': 'displacement', 'source': 'layout.json elevation grid',
                'axis': 'y', 'amplitude': 1.0,
                'note': 'Plan-view elevation recovered from the reference; see projection-route.md'}]
C = []
C.append(comp('root','Isometric Diorama Island','macro','assembly-root','box','assembled-solid',
  'The whole diorama is a bounded rectangular block; the root is that bounding volume.',
  dims=(1,0.12,1), conf=0.95))

C.append(comp('slab-base','Diorama slab','macro','base-volume','box','assembled-solid',
  'A cut block with four flat vertical faces and sharp corners - a box is exactly what it is.',
  parent='root', material='earth-stratum', dims=(1,0.12,1), pos=(0,-0.06,0), conf=0.95, contact='flush',
  features=[{'id':'cut-face-strata','description':'Blue water band over ochre earth on all four faces, ragged interface, water band ~0.3 of thickness.','evidenceRef':'crops/slab-edge.png'},
            {'id':'sharp-corner','description':'Corners are square, unbevelled - the block reads as cut, not moulded.','evidenceRef':'crops/east-windmill.png'}]))
C.append(comp('slab-water-band','Water band on cut face','meso','strata-band','box','assembled-solid',
  'A band on the slab face; a box face section, not a surface carved into it.',
  parent='slab-base', material='slab-water', dims=(1,0.036,1), pos=(0,0.042,0), conf=0.9))
C.append(comp('slab-earth-stratum','Earth stratum on cut face','meso','strata-band','box','assembled-solid',
  'The lower band of the same cut face.',
  parent='slab-base', material='earth-stratum', dims=(1,0.084,1), pos=(0,-0.018,0), conf=0.9,
  features=[{'id':'ragged-top-edge','description':'Its top edge against the water band varies along the run.','evidenceRef':'crops/slab-edge.png'}]))

C.append(comp('sea-surface','Sea surface','macro','water-plane','plane-card','surface-relief',
  'A single displaced plane flush with the slab top; relief on a host surface, not a volume.',
  parent='root', material='sea', dims=(1,0.001,1), pos=(0,0,0), conf=0.9, contact='flush',
  features=[{'id':'depth-grade','description':'Colour graded by depth from the land mask.','evidenceRef':'layout-mask.png'}]))
C.append(comp('shallow-shelf','Shallow shelf band','meso','water-band','plane-card','surface-relief',
  'A contour band on the water plane.',
  parent='sea-surface', material='sea', dims=(1,0.001,1), conf=0.85))
C.append(comp('foam-ring','Shore foam band','meso','contour-band','plane-card','surface-relief',
  'A contour band hugging every coastline including islets.',
  parent='sea-surface', material='foam', dims=(1,0.001,1), conf=0.9,
  features=[{'id':'islet-collar','description':'Every rock islet carries its own closed foam collar.','evidenceRef':'crops/slab-edge.png'}]))

C.append(comp('landmass','Landmass heightfield','macro','terrain','plane-card','surface-relief',
  'The land is a displaced plane driven by the recovered elevation grid: relief on a surface. '
  'Modelling it as assembled solids would lose the continuous coastline the identity depends on.',
  parent='root', material='grass', dims=(1,0.09,1), pos=(0,0,0), conf=0.85, contact='flush',
  deform=HEIGHTFIELD,
  features=[{'id':'plateau-tiers','description':'Elevation quantised to discrete tiers so tops stay flat and the gap between tiers becomes a riser.','evidenceRef':'crops/nw-waterfall.png'}]))
C.append(comp('cliff-band','Cliff risers','meso','terrain-riser','plane-card','surface-relief',
  'The near-vertical wall between two plateau tiers - part of the same displaced surface.',
  parent='landmass', material='cliff-rock', dims=(1,0.04,1), conf=0.85,
  features=[{'id':'vertical-fluting','description':'Vertical grooves and darker cavity lines run the riser height.','evidenceRef':'crops/nw-waterfall.png'},
            {'id':'hard-grass-lip','description':'Grass stops dead at the riser lip with no blend.','evidenceRef':'crops/nw-waterfall.png'}]))
C.append(comp('beach-band','Beach band','meso','terrain-band','plane-card','surface-relief',
  'A material band on the terrain surface where the coast is low.',
  parent='landmass', material='beach-sand', dims=(1,0.002,1), conf=0.85))
C.append(comp('farmland','Farm parcels','meso','terrain-band','plane-card','surface-relief',
  'Rectilinear colour parcels lying on flat plateau tops.',
  parent='landmass', material='field-crop', dims=(0.4,0.002,0.4), conf=0.85,
  features=[{'id':'parcel-grid','description':'Axis-aligned parcels in alternating crop colours, only on flat tops.','evidenceRef':'crops/center-castle.png'},
            {'id':'dirt-paths','description':'Narrow tan paths wind between hamlets, distinct from the straight parcel edges.','evidenceRef':'crops/nw-waterfall.png'}]))
C.append(comp('mountain-massif','Mountain massif','meso','landform','plane-card','surface-relief',
  'The dominant peak is the tallest region of the same heightfield, not a separate solid.',
  parent='landmass', material='mountain-rock', dims=(0.32,0.09,0.32), pos=(0,0,-0.22), conf=0.85,
  features=[{'id':'snow-tongues','description':'Snow caps the summit and runs down the gullies.','evidenceRef':'crops/mountain.png'},
            {'id':'faceted-ridges','description':'Ridgelines read as angular facets, not smooth cones.','evidenceRef':'crops/mountain.png'}]))
C.append(comp('ne-mesa','Ochre mesa','meso','landform','plane-card','surface-relief',
  'An arid terraced highland - the same surface with a different biome and step profile.',
  parent='landmass', material='mesa-stone', dims=(0.3,0.05,0.26), pos=(0.3,0,-0.2), conf=0.8,
  features=[{'id':'horizontal-terraces','description':'Stepped terraces with horizontal bedding lines.','evidenceRef':'crops/mesa.png'}]))
C.append(comp('rock-islet','Rock islet','meso','landform','cone','assembled-solid',
  'A free-standing stack in open water; a tapered solid, separate from the heightfield.',
  parent='root', material='cliff-rock', dims=(0.03,0.03,0.03), conf=0.85, contact='embed'))

# --- built environment
C.append(comp('structures','Built environment','macro','assembly','box','assembled-solid',
  'Grouping node for every constructed object so the diorama can be explored part by part.',
  parent='root', dims=(1,0.06,1), conf=0.9))
C.append(comp('castle','Castle','meso','building','cylinder','assembled-solid',
  'Cylindrical towers with conical caps on a walled base - stacked solids of revolution.',
  parent='structures', material='wall-plaster', dims=(0.05,0.05,0.05), pos=(0.02,0,0.02), conf=0.85))
C.append(comp('lighthouse','Lighthouse','meso','building','cylinder','assembled-solid',
  'A tapered cylinder with a gallery band and a conical cap.',
  parent='structures', material='wall-plaster', dims=(0.02,0.05,0.02), pos=(-0.05,0,0.2), conf=0.9,
  features=[{'id':'gallery-band','description':'Dark band below the lantern.','evidenceRef':'crops/lighthouse-pier.png'}]))
C.append(comp('windmill','Windmill','meso','building','tapered-sweep','assembled-solid',
  'A tapering tower - a swept profile, not a straight cylinder.',
  parent='structures', material='wall-plaster', dims=(0.03,0.06,0.03), pos=(0.28,0,0.06), conf=0.9))
C.append(comp('arch-bridge','Multi-arch bridge','meso','structure','extrude','assembled-solid',
  'A repeated arch profile extruded across the span on piers.',
  parent='structures', material='cliff-rock', dims=(0.18,0.03,0.02), pos=(-0.02,0,-0.08), conf=0.85, contact='socket'))
C.append(comp('stone-ring','Stone ring monument','meso','monument','torus','assembled-solid',
  'An upright annulus - a torus is the primitive it actually is.',
  parent='structures', material='cliff-rock', dims=(0.11,0.11,0.02), pos=(-0.2,0,-0.16), conf=0.75))
C.append(comp('watchtower','Mesa watchtower','meso','building','cylinder','assembled-solid',
  'A plain stone cylinder on the mesa top.',
  parent='structures', material='mesa-stone', dims=(0.015,0.04,0.015), pos=(0.3,0,-0.24), conf=0.8))
C.append(comp('waterfall','Waterfall','meso','effect','box','assembled-solid',
  'A thin curtain of falling water. Built as a thin solid rather than a zero-thickness shell '
  'because it needs to read from both sides and carry a spray disc at its base.',
  parent='structures', material='waterfall', dims=(0.02,0.07,0.006), pos=(-0.3,0,0.02), conf=0.9, contact='overlap'))
C.append(comp('pier','Timber pier','meso','structure','box','assembled-solid',
  'A plank deck on posts.',
  parent='structures', material='timber', dims=(0.05,0.01,0.02), pos=(0.16,0,0.1), conf=0.8))

# --- micro
C.append(comp('house-unit','House','micro','building-unit','box','assembled-solid',
  'A rendered wall block; the smallest repeated building mass.',
  parent='structures', material='wall-plaster', dims=(0.012,0.01,0.011), conf=0.85))
C.append(comp('house-roof','Gable roof','micro','building-unit','extrude','assembled-solid',
  'A triangular profile extruded along the ridge - a gable, not a cone.',
  parent='house-unit', material='roof-tile', dims=(0.014,0.007,0.013), conf=0.85))
C.append(comp('conifer-unit','Conifer','micro','vegetation','cone','assembled-solid',
  'A tapering canopy on a short trunk; a cone is the correct read at this scale.',
  parent='landmass', material='conifer', dims=(0.008,0.018,0.008), conf=0.9))
C.append(comp('tower-cap','Conical tower cap','micro','building-unit','cone','assembled-solid',
  'The red cone capping every tower - the accent that identifies castle and lighthouse.',
  parent='castle', material='roof-tile', dims=(0.014,0.014,0.014), conf=0.9))
C.append(comp('windmill-sail','Windmill sail','micro','mechanism','box','assembled-solid',
  'A flat lattice arm; four arms at right angles on a hub.',
  parent='windmill', material='timber', dims=(0.03,0.006,0.002), conf=0.85))
C.append(comp('bridge-arch','Bridge arch','micro','structure-unit','extrude','assembled-solid',
  'One round arch and its pier, repeated across the span.',
  parent='arch-bridge', material='cliff-rock', dims=(0.02,0.02,0.02), conf=0.8))
C.append(comp('cloud-puff','Cloud puff','micro','volume-unit','ellipsoid','assembled-solid',
  'A squashed ellipsoid; several make one billowed mass with a flat base.',
  parent='cloud-layer', material='cloud-mass', dims=(0.06,0.03,0.05), conf=0.85))

C.append(comp('cloud-layer','Cloud layer','macro','atmosphere','instanced-cluster','assembled-solid',
  'Masses of ellipsoid puffs. They sit INSIDE the diorama at and below plateau height, '
  'which is an identity feature, not a distant skybox.',
  parent='root', material='cloud-mass', dims=(1,0.06,1), pos=(0,0.03,0), conf=0.85, contact='overlap',
  features=[{'id':'island-level-altitude','description':'Cloud bases sit at or below plateau height, over the sea and against the mountain flanks.','evidenceRef':'crops/mountain.png'},
            {'id':'cirrus-streak','description':'Thin horizontal streaks cross the summit.','evidenceRef':'crops/mountain.png'}]))
spec['componentTree'] = C

# ---------------------------------------------------------------- repetition
spec['repetitionSystems'] = [
 {'id':'conifer-scatter','name':'Conifer scatter','componentRef':'conifer-unit',
  'buildsGeometry':True,'realization':'instanced-geometry','count':1400,
  'distribution':'density-weighted by biome class from layout.json; concentrated along ridges, '
                 'cliff lips and shorelines, thinned on farm parcels, absent on sand, rock, '
                 'snow and water. Never uniform - uniform spacing reads as a plantation.',
  'seed':20260829,'jitter':0.85,
  'instances':{'mode':'scattered','anchorSurface':'landmass','alignToNormal':False},
  'evidenceRefs':['crops/east-windmill.png','layout-mask.png']},
 {'id':'hamlet-clusters','name':'Hamlet clusters','componentRef':'house-unit',
  'buildsGeometry':True,'realization':'instanced-geometry','count':64,
  'distribution':'Clusters of 3-8 houses on flat lowland near water or paths, with random yaw. '
                 'Houses never appear singly and never on slopes above the parcel threshold.',
  'seed':20260830,'jitter':0.5,
  'instances':{'mode':'clustered','clusterSize':[3,8],'anchorSurface':'landmass'},
  'evidenceRefs':['crops/center-castle.png','crops/east-windmill.png']},
 {'id':'field-parcels','name':'Farm parcel patchwork','componentRef':'farmland',
  'buildsGeometry':True,'realization':'vertex-colour-regions','count':180,
  'distribution':'Axis-aligned rectangles tiling flat plateau tops only, in alternating crop '
                 'colours with hard boundaries.',
  'seed':20260831,'jitter':0.3,
  'instances':{'mode':'grid','anchorSurface':'landmass'},
  'evidenceRefs':['crops/center-castle.png']},
 {'id':'rock-islets','name':'Rock islets','componentRef':'rock-islet',
  'buildsGeometry':True,'realization':'instanced-geometry','count':14,
  'distribution':'Standing in open water clear of the coast, each with one or two conifers '
                 'and its own foam collar.',
  'seed':20260832,'jitter':0.9,
  'instances':{'mode':'scattered','anchorSurface':'sea-surface'},
  'evidenceRefs':['crops/slab-edge.png']},
 {'id':'cloud-masses','name':'Cloud masses','componentRef':'cloud-puff',
  'buildsGeometry':True,'realization':'instanced-geometry','count':26,
  'distribution':'Masses of 5-9 puffs on a common flat base, at and below plateau height, '
                 'concentrated over water and against the mountain flanks.',
  'seed':20260833,'jitter':0.7,
  'instances':{'mode':'clustered','clusterSize':[5,9],'anchorSurface':'none'},
  'evidenceRefs':['crops/mountain.png']},
]

# ---------------------------------------------------------------- framing
spec['coordinateFrame'] = {'front':'+Z','up':'+Y',
  'scaleReference':'Slab edge length = 1.0 relative unit; slab thickness 0.12; '
                   'maximum terrain height above sea level 0.09.'}
spec['silhouette'] = {
 'boundingShape':'rectangular slab, square in plan, thickness 0.12 of edge',
 'aspectRatios':[{'name':'plan','value':1.0},{'name':'thickness-to-edge','value':0.12},
                 {'name':'peak-to-edge','value':0.09}],
 'symmetry':'asymmetric',
 'dominantCurves':['coastline meander','plateau tier contours','cumulus billow arcs'],
 'negativeSpaces':['the central strait between landmasses','bays between headlands',
                   'the gap under each bridge arch','the aperture of the stone ring'],
 'landmarks':['mountain massif rear-centre','stone ring NW plateau','waterfall west cliff',
              'multi-arch bridge central strait','windmill village east plateau',
              'castle central islet','lighthouse south islet','ochre mesa rear-right',
              'rock islets in open water','cloud masses at plateau height'],
}
spec['referenceCamera'] = {'solved':True,'projection':'orthographic','fovDegrees':0.0,'aspect':1.5,
 'orientation':{'azimuthDegrees':45.0,'elevationDegrees':30.0,'rollDegrees':0.0},
 'positionHint':[1.0,0.62,1.0],
 'note':'Isometric: slab edges stay parallel in the reference, so the projection is orthographic. '
        'Azimuth 45 puts a corner toward the viewer; elevation ~30 matches the observed ratio of '
        'the slab side face to its top face.'}
spec['assumptions'] = [
 'Slab underside is flat (hidden in the single view).',
 'Rear terrain is generated from the same recovered field as the front and is inference.',
 'Prop counts within clusters are approximate; positions follow the reference layout.',
 'The plan-view layout carries a height-dependent offset of a few percent of island extent.',
]
spec['risks'] = [
 {'id':'cel-shading-drift','description':'Toon shading is the house style of this repository, so a '
  'gradient map could be applied out of habit. The user explicitly rejected it.','severity':'high',
  'mitigation':'painted-finish feature review target with mustPass true.'},
 {'id':'uniform-scatter','description':'Evenly spaced trees would read as a plantation and destroy '
  'the painted look.','severity':'medium','mitigation':'biome-weighted density with jitter 0.85.'},
 {'id':'smooth-terrain','description':'A continuous heightfield naturally produces rolling hills; '
  'the reference is flat tables with risers.','severity':'high',
  'mitigation':'elevation quantised to tiers before displacement.'},
 {'id':'layout-offset','description':'Plan recovery assumes ground height zero.','severity':'low',
  'mitigation':'stated as approximation; landmark placement checked by quadrant, not by pixel.'},
]
spec['performanceBudget'].update({'targetTriangles':260000,'maxDrawCalls':60,'fpsTarget':60,
  'qualityPriority':'quality','optimizationPolicy':'instance every repeated unit; one draw call per scatter system'})

json.dump(spec, open('object-sculpt-spec.json','w'), indent=2)
print(f"components={len(C)} materials={len(spec['materials'])} repetition={len(spec['repetitionSystems'])}")

# --------------------------------------------------------- detail inventory
# The schema's detail taxonomy (gloss/bevel/fastener/linework/contour/seam/groove/ridge/
# decal/...) describes SURFACE micro-detail. The ten landmarks are not that: a windmill is
# not a kind of linework. Forcing them into the taxonomy would file real observations under
# wrong labels, so landmarks live where the gates actually read them - silhouette.landmarks
# and the landmark-set review target - and the inventory holds true surface detail, each
# entry pointing at a localFeature or localOverride that already exists in the spec.
DETAILS = [
 ('slab-strata-interface','seam','ragged-interface','crops/slab-edge.png',0.95,
  'The boundary between the water band and the ochre earth on each cut face is ragged along its run, never level.'),
 ('slab-corner-sharpness','bevel','sharp-corner','crops/east-windmill.png',0.9,
  'Slab corners are square and unbevelled, which is what makes the block read as cut rather than moulded.'),
 ('shore-foam-crest','contour','foam-crest','crops/slab-edge.png',0.95,
  'A white band at every land/water contact, brightest at the line and dissolving outward.'),
 ('islet-foam-collar','contour','islet-collar','crops/slab-edge.png',0.9,
  'Every rock stack in open water carries its own closed foam collar.'),
 ('sea-depth-gradient','contour','depth-gradient','layout-mask.png',0.9,
  'Water colour is graded by depth: deep blue offshore through cyan to pale turquoise inshore.'),
 ('shallow-shelf-band','contour','shallow-shelf','crops/lighthouse-pier.png',0.85,
  'A turquoise shelf band sits between the foam line and open water.'),
 ('field-parcel-grid','linework','parcel-grid','crops/center-castle.png',0.9,
  'Axis-aligned crop parcels tile the flat plateau tops in alternating colours.'),
 ('field-parcel-boundary','linework','parcel-boundary','crops/center-castle.png',0.9,
  'Parcel edges are hard; no blending crosses a boundary.'),
 ('dirt-path-network','linework','dirt-paths','crops/nw-waterfall.png',0.7,
  'Narrow tan paths wind between hamlets, visually distinct from the straight parcel edges.'),
 ('cliff-vertical-fluting','groove','vertical-fluting','crops/nw-waterfall.png',0.9,
  'Vertical grooves and cavity-darkened lines run the full height of each riser.'),
 ('cliff-grass-lip','seam','hard-grass-lip','crops/nw-waterfall.png',0.9,
  'Grass stops dead at the riser lip with no transition.'),
 ('mesa-terrace-strata','ridge','terrace-strata','crops/mesa.png',0.85,
  'Horizontal bedding lines follow each terrace step on the ochre highland.'),
 ('mesa-terrace-steps','ridge','horizontal-terraces','crops/mesa.png',0.85,
  'The mesa steps down in discrete terraces rather than sloping.'),
 ('snow-gully-tongue','contour','gully-tongue','crops/mountain.png',0.9,
  'Snow reaches further down the gullies than the ridges, so the snowline follows drainage.'),
 ('mountain-faceted-ridge','ridge','faceted-ridges','crops/mountain.png',0.85,
  'Ridgelines read as angular facets rather than a smooth cone.'),
 ('beach-sand-band','contour','beach-band','crops/center-castle.png',0.9,
  'A pale sand band lies between lowland grass and foam, absent where cliffs meet water.'),
 ('lighthouse-gallery-band','decal','gallery-band','crops/lighthouse-pier.png',0.9,
  'A dark gallery band circles the lighthouse below its lantern.'),
 ('cloud-island-altitude','contour','island-level-altitude','crops/mountain.png',0.9,
  'Cloud bases sit at or below plateau height, inside the diorama rather than behind it.'),
 ('cirrus-streak','linework','cirrus-streak','crops/mountain.png',0.8,
  'Thin horizontal streaks cross the summit.'),
 ('plateau-tier-step','ridge','plateau-tiers','crops/nw-waterfall.png',0.9,
  'Land is built of flat tables at discrete levels; the gap between tiers becomes the riser.'),
]
spec = json.load(open('object-sculpt-spec.json'))
spec['preSpecAssessment']['detailInventory']['details'] = [
 {'id': i, 'kind': k, 'description': desc, 'scale': 'micro',
  'affects': ref, 'mapsTo': {'type': 'local-feature', 'ref': ref},
  'evidenceRef': ev, 'confidence': cf,
  'region': {'x':0.0,'y':0.0,'width':1.0,'height':1.0,'units':'normalized'}}
 for (i,k,ref,ev,cf,desc) in DETAILS]

# Feature review targets mirror the quality contract's feature groups, so the gate that
# blocks `continue` reads the same list the contract defines.
spec['featureReviewTargets'] = [
 {'id':'slab-and-strata','name':'Diorama slab, cut faces and strata','tier':'critical',
  'passIds':['blockout','material-pass'],'minimumScore':0.82,'mustPass':True,
  'componentRefs':['slab-base','slab-water-band','slab-earth-stratum'],
  'evidenceRefs':['crops/slab-edge.png']},
 {'id':'landform-grammar','name':'Plateau-and-cliff landform grammar','tier':'critical',
  'passIds':['structural-pass','form-refinement'],'minimumScore':0.8,'mustPass':True,
  'componentRefs':['landmass','cliff-band','mountain-massif','ne-mesa'],
  'evidenceRefs':['crops/nw-waterfall.png','crops/mesa.png']},
 {'id':'water-system','name':'Sea, shallows and foam','tier':'critical',
  'passIds':['material-pass','surface-pass'],'minimumScore':0.8,'mustPass':True,
  'componentRefs':['sea-surface','shallow-shelf','foam-ring'],
  'evidenceRefs':['crops/slab-edge.png']},
 {'id':'landmark-set','name':'The ten identity landmarks','tier':'critical',
  'passIds':['structural-pass','interaction-pass'],'minimumScore':0.78,'mustPass':True,
  'componentRefs':['castle','lighthouse','windmill','arch-bridge','stone-ring','waterfall',
                   'watchtower','pier','mountain-massif','ne-mesa','cloud-layer'],
  'evidenceRefs':['crops/mountain.png','crops/nw-waterfall.png','crops/east-windmill.png']},
 {'id':'painted-finish','name':'Hand-painted finish, explicitly not cel shading','tier':'critical',
  'passIds':['material-pass','lighting-pass'],'minimumScore':0.82,'mustPass':True,
  'componentRefs':['landmass','sea-surface','cloud-layer'],
  'evidenceRefs':['full-object']},
 {'id':'repetition-systems','name':'Scatter systems and distribution rules','tier':'important',
  'passIds':['surface-pass'],'minimumScore':0.75,'mustPass':False,
  'componentRefs':['conifer-unit','house-unit','farmland','rock-islet','cloud-puff'],
  'evidenceRefs':['crops/east-windmill.png']},
]
json.dump(spec, open('object-sculpt-spec.json','w'), indent=2)
print('details:', len(DETAILS), 'reviewTargets:', len(spec['featureReviewTargets']))
