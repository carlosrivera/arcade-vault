#!/usr/bin/env python3
"""Locate the purest window per material, inside a search box named from observation.

Agent vision decides WHERE each material lives; the script only picks the purest window
inside that box. An unconstrained search cannot tell a dark hull facet from a dark canopy
facet, and on the previous subject it put cliff rock in the sky.
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.home()/'.claude/skills/img2threejs/forge/stage1_intake'))
from extract_pbr_evidence import read_png, write_png_rgb

w, h, px = read_png(Path('reference.png'))

# Search boxes in reference pixels, read off the four views.
SEARCH = {
 'hull-lit':    (700, 560, 1000, 700),   # sunlit upper hull, 3/4 view
 'hull-shade':  (760, 830, 1000, 920),   # shadowed lower flank, 3/4 view
 'canopy':      (880, 600,  990, 660),   # tinted glass, 3/4 view
 'emissive':    (700, 880, 1000, 950),   # chine strip, 3/4 view
 'vent-orange': (1010, 610, 1080, 660),  # dorsal vent block, 3/4 view
 'nozzle-glow': (250, 730,  400, 810),   # central nozzle grille, rear view
}
# (materialId, target rgb, window, registry family/subtype/finish, componentId)
TARGETS = [
 ('hull',        ( 62, 68, 78), 46, 'coating','paint-over-metal','gloss-or-satin', 'hull'),
 ('hull-shade',  ( 32, 36, 42), 34, 'coating','paint-over-metal','gloss-or-satin', 'hull'),
 # 40px, not 26: a small canopy window is one flat facet, and inverse rendering on a flat
 # dark patch returns nothing usable (it came back conditional at 0.686). A wider window
 # spans two facets, which is what gives the extractor the tonal range it needs.
 ('canopy',      ( 40, 48, 76), 40, 'glass','frosted','rough-transmissive',        'canopy'),
 ('emissive',    ( 90,200,255), 20, 'plastic','generic-polymer','glossy',          'chine-strip'),
 ('vent-orange', (226,118, 31), 18, 'coating','paint-over-metal','gloss-or-satin', 'vent-block'),
 # The decals ARE measurable even though they are generated rather than projected: the white
 # ink has a colour and a finish, and sampling it is what makes the generated glyph match the
 # reference's off-white rather than pure #ffffff.
 ('decal',       (242,245,248), 16, 'plastic','generic-polymer','matte',            'decal-set'),
 ('nozzle-glow', (140,225,255), 22, 'plastic','generic-polymer','glossy',          'nozzle-core'),
]
BOX = {'hull':'hull-lit','hull-shade':'hull-shade','canopy':'canopy','emissive':'emissive',
       'vent-orange':'vent-orange','nozzle-glow':'nozzle-glow'}

regions, report = [], []
for mid, (tr,tg,tb), win, fam, sub, fin, comp in TARGETS:
    # Global search with a tight tolerance. Hand-drawn boxes were worse here than on the
    # diorama: the craft's materials are small and interleaved (a 46px hull window at any
    # plausible spot also catches an emissive strip), and the orange vents are ~15px. Every
    # target colour on this craft is distinctive enough for colour alone to find it, which
    # was NOT true of the diorama's five near-identical greens.
    # Global by default; boxed only where a global search demonstrably drifts. The canopy
    # tint is close enough to shadowed hull blue that a widened window found hull instead,
    # so that one target is constrained to the canopy's position in the three-quarter view.
    BOXED = {'canopy': (860, 575, 1095, 735)}
    x0, y0, x1, y1 = BOXED.get(mid, (0, 0, w, h))
    win = min(win, max(8, x1-x0-2), max(8, y1-y0-2))
    TOL2 = 26*26
    best, bestfrac, bestd = None, -1.0, 1e18
    for y in range(y0, max(y0+1, y1-win), 3):
        for x in range(x0, max(x0+1, x1-win), 3):
            hit, tot, n, bright = 0, 0.0, 0, 0
            for yy in range(y, y+win, max(2, win//8)):
                for xx in range(x, x+win, max(2, win//8)):
                    r,g,b,_ = px[yy*w+xx]
                    d2 = (r-tr)**2 + (g-tg)**2 + (b-tb)**2
                    if d2 <= TOL2: hit += 1
                    # Decals are white text ON the hull, so a hull window that happens to
                    # sit over "07" still scores well on the charcoal around the glyphs.
                    # Reject any window containing near-white pixels when sampling a dark
                    # material; the emissive targets are exempt because they blow to white
                    # by nature.
                    if r > 200 and g > 200 and b > 200: bright += 1
                    tot += d2; n += 1
            if tr < 150 and bright: continue  # dark targets only; decal/emissive exempt
            frac, mean = hit/n, tot/n
            if frac > bestfrac or (frac == bestfrac and mean < bestd):
                bestfrac, bestd, best = frac, mean, (x,y)
    regions.append({'componentId': comp, 'regionId': mid,
                    'sourceImage': str(Path('reference.png').resolve()),
                    'bbox': {'x': best[0], 'y': best[1], 'width': win, 'height': win},
                    'family': fam, 'subtype': sub, 'finish': fin, 'materialSpecId': mid})
    report.append((mid, best, win, round(bestd**0.5,1), round(bestfrac,3)))

json.dump({'referenceId': 'exis07-sheet', 'regions': regions},
          open('material-regions.json','w'), indent=1)
CELL, COLS = 96, 6
rows = (len(regions)+COLS-1)//COLS
sheet = [[(24,24,28)]*(CELL*COLS) for _ in range(CELL*rows)]
for idx, reg in enumerate(regions):
    bx,by,bw = reg['bbox']['x'], reg['bbox']['y'], reg['bbox']['width']
    cx,cy = (idx%COLS)*CELL, (idx//COLS)*CELL
    for j in range(CELL-4):
        for i in range(CELL-4):
            sx,sy = bx + i*bw//(CELL-4), by + j*bw//(CELL-4)
            if 0<=sx<w and 0<=sy<h: sheet[cy+j+2][cx+i+2] = px[sy*w+sx][:3]
buf = bytearray()
for row in sheet:
    for c in row: buf.extend(c)
write_png_rgb(Path('material-crops.png'), CELL*COLS, CELL*rows, bytes(buf))
print('order:', ' '.join(r['regionId'] for r in regions))
for mid,(x,y),win,rms,pur in report:
    print(f'{mid:14s} {x:5d},{y:5d} win={win:3d} rms={rms:6.1f} purity={pur:.3f}')
