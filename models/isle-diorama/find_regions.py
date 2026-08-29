#!/usr/bin/env python3
"""Locate the purest window in the reference for each authored material.

Rather than eyeballing bounding boxes, slide a window over the image and keep the one
whose mean distance to the material's observed colour is lowest. That makes the crop a
measurement of where the material actually is, and its purity score an honest confidence.
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.home()/'.claude/skills/img2threejs/forge/stage1_intake'))
from extract_pbr_evidence import read_png

w, h, px = read_png(Path('reference.png'))

# Search boxes, in reference pixels, naming where each material was OBSERVED in the
# crop pass. An unconstrained search cannot separate snow from cloud from plaster from
# foam - they are all near-white - and it put cliff rock in the sky. Agent vision decides
# WHERE the material is; the script only decides which window inside that region is purest.
SEARCH = {
 'sea':           ( 700, 760, 1120,  950),
 'slab-water':    (1300, 588, 1462,  612),
 'foam':          ( 762, 782,  900,  858),
 'beach-sand':    ( 660, 520,  770,  610),
 'grass':         ( 500, 600,  710,  730),
 'field-crop':    ( 580, 595,  760,  705),
 'cliff-rock':    ( 470, 450,  575,  540),
 'mesa-stone':    (1010, 325, 1220,  445),
 'mountain-rock': ( 720, 155,  880,  305),
 'snow':          ( 760, 125,  860,  225),
 'earth-stratum': (1280, 560, 1470,  650),
 'roof-tile':     (1080, 532, 1215,  572),
 'wall-plaster':  (1080, 532, 1215,  572),
 'conifer':       ( 560, 470,  760,  620),
 'cloud-mass':    ( 640, 245,  820,  335),
 'timber':        ( 940, 604, 1005,  636),
 'waterfall':     ( 415, 465,  465,  565),
}

# (materialId, target rgb, window px, registry family/subtype/finish, componentId)
TARGETS = [
 ('sea',            ( 30,112,186), 150, 'glass','clear','polished',            'sea-surface'),
 ('slab-water',     ( 47,143,208), 12,  'glass','clear','polished',            'slab-water-band'),
 ('foam',           (220,240,247), 10,  'glass','frosted','rough-transmissive','foam-ring'),
 ('beach-sand',     (226,208,158), 45,  'stone','natural','rough-or-polished', 'beach-band'),
 ('grass',          ( 96,168, 70), 90,  'stone','natural','rough-or-polished', 'landmass'),
 ('field-crop',     (150,186, 92), 60,  'stone','natural','rough-or-polished', 'farmland'),
 ('cliff-rock',     (126,128,140), 55,  'stone','natural','rough-or-polished', 'cliff-band'),
 ('mesa-stone',     (206,168,106), 60,  'stone','natural','rough-or-polished', 'ne-mesa'),
 ('mountain-rock',  ( 88,122,176), 80,  'stone','natural','rough-or-polished', 'mountain-massif'),
 ('snow',           (230,240,250), 55,  'stone','natural','rough-or-polished', 'mountain-massif'),
 ('earth-stratum',  (140, 92, 56), 45,  'stone','natural','rough-or-polished', 'slab-earth-stratum'),
 ('roof-tile',      (194, 69, 44),  8,  'ceramic','glazed','glossy',           'house-roof'),
 ('wall-plaster',   (240,232,220),  8,  'ceramic','glazed','glossy',           'house-unit'),
 ('conifer',        ( 74,146, 88), 46,  'stone','natural','rough-or-polished', 'conifer-unit'),
 ('cloud-mass',     (248,250,252), 70,  'stone','natural','rough-or-polished', 'cloud-puff'),
 ('timber',         (138,100, 64),  8,  'wood','generic','unfinished',         'pier'),
 ('waterfall',      (232,244,250), 20,  'glass','frosted','rough-transmissive','waterfall'),
]

STEP = 8
regions, report = [], []
for mid, (tr,tg,tb), win, fam, sub, fin, comp in TARGETS:
    # Maximise the FRACTION of pixels close to the target, not the mean distance.
    # Mean distance is minimised by any large flat area, which is how the first run put
    # 'beach-sand' and 'mountain-rock' in the blown-out sky at the top of the frame: the
    # sky is uniform, so its mean error beat a real but slightly varied beach.
    TOL2 = 36 * 36
    x0, y0, x1, y1 = SEARCH.get(mid, (0, 0, w, h))
    win = min(win, max(8, x1-x0-2), max(8, y1-y0-2))
    best, bestfrac, bestd = None, -1.0, 1e18
    for y in range(y0, max(y0+1, y1-win), 4):
        for x in range(x0, max(x0+1, x1-win), 4):
            hit, tot, n = 0, 0.0, 0
            for yy in range(y, y+win, max(2, win//8)):
                for xx in range(x, x+win, max(2, win//8)):
                    r,g,b,_ = px[yy*w+xx]
                    d2 = (r-tr)**2 + (g-tg)**2 + (b-tb)**2
                    if d2 <= TOL2: hit += 1
                    tot += d2
                    n += 1
            frac, mean = hit/n, tot/n
            if frac > bestfrac or (frac == bestfrac and mean < bestd):
                bestfrac, bestd, best = frac, mean, (x,y)
    purity = bestfrac
    regions.append({'componentId': comp, 'regionId': mid, 'sourceImage': 'reference.png',
                    'bbox': {'x': best[0], 'y': best[1], 'width': win, 'height': win},
                    'family': fam, 'subtype': sub, 'finish': fin, 'materialSpecId': mid})
    report.append((mid, best, win, round(bestd**0.5,1), round(purity,3)))

json.dump({'referenceId': 'iso-front-corner', 'regions': regions},
          open('material-regions.json','w'), indent=1)

# Contact sheet: every chosen crop side by side, so the choice can be checked by eye
# rather than trusted because a number looked high.
from extract_pbr_evidence import write_png_rgb
CELL, COLS = 96, 6
rows = (len(regions) + COLS - 1) // COLS
sheet = [[(24, 24, 28)] * (CELL*COLS) for _ in range(CELL*rows)]
for idx, reg in enumerate(regions):
    bx, by, bw = reg['bbox']['x'], reg['bbox']['y'], reg['bbox']['width']
    cx, cy = (idx % COLS) * CELL, (idx // COLS) * CELL
    for j in range(CELL-4):
        for i in range(CELL-4):
            sx, sy = bx + i * bw // (CELL-4), by + j * bw // (CELL-4)
            if 0 <= sx < w and 0 <= sy < h:
                sheet[cy+j+2][cx+i+2] = px[sy*w+sx][:3]
buf = bytearray()
for row in sheet:
    for c in row: buf.extend(c)
write_png_rgb(Path('material-crops.png'), CELL*COLS, CELL*rows, bytes(buf))
print('order:', ' '.join(r['regionId'] for r in regions))
print(f"{'material':16s} {'x,y':>12s} {'win':>4s} {'rms':>6s} {'purity':>7s}")
for mid, (x,y), win, rms, pur in report:
    flag = '' if pur >= 0.7 else '   <- low, approximation'
    print(f'{mid:16s} {x:5d},{y:5d} {win:4d} {rms:6.1f} {pur:7.3f}{flag}')
