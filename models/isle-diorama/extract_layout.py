#!/usr/bin/env python3
"""Recover a plan-view biome mask from the isometric reference painting.

The reference is the authority on layout: which quadrant each landmark occupies and
where the coastline runs. Rather than projecting its pixels onto the mesh (see
projection-route.md for why that is wrong here), classify them into biome classes and
inverse the isometric transform to get a top-down map the terrain generator can consume.
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / '.claude/skills/img2threejs/forge/stage1_intake'))
sys.path.insert(0, str(Path.home() / '.claude/skills/img2threejs/forge/_shared'))
from extract_pbr_evidence import read_png, write_png_rgb  # noqa: E402

W_OUT = 192  # plan-view mask resolution

# Biome classes keyed by observed palette. Ordered: first match wins, so the
# narrow, high-saturation classes (foam, snow) are tested before the broad ones.
CLASSES = [
    ('cloud',    (243, 246, 250), 26),
    ('snow',     (226, 236, 245), 30),
    ('foam',     (214, 238, 245), 26),
    ('shallow',  ( 92, 198, 216), 46),
    ('sea',      ( 30, 112, 186), 60),
    ('deepsea',  ( 20,  70, 140), 46),
    ('beach',    (226, 208, 158), 40),
    ('mesa',     (206, 168, 106), 44),
    ('field',    (150, 186,  92), 40),
    ('grass',    ( 96, 168,  70), 52),
    ('darkgrass',( 54, 118,  58), 42),
    ('rock',     (126, 128, 140), 40),
    ('mountain', ( 88, 122, 176), 46),
    ('earth',    (140,  92,  56), 46),
    # Shade variants. The painting darkens every form toward its base; without
    # these the shadowed side of each landmass fell nearest to a sea centroid.
    ('darkgrass', ( 38,  86,  52), 40),
    ('rock',      ( 84,  86, 104), 40),
    ('sea',       ( 46, 140, 200), 40),
    ('deepsea',   ( 24,  86, 158), 40),
    ('mountain',  (120, 156, 205), 40),
    ('mesa',      (176, 132,  78), 40),
    ('grass',     (126, 190,  80), 40),
]

# Unique code per class. First letters collide - foam/field, sea/snow/shallow,
# deepsea/darkgrass, mesa/mountain - and a consumer decoding by initial silently mixes
# them up (it painted shallow-water cyan part way up the mountainside).
CODE = {'deepsea': 'D', 'sea': 'S', 'shallow': 'H', 'foam': 'F', 'beach': 'B',
        'grass': 'G', 'field': 'C', 'darkgrass': 'K', 'rock': 'R', 'mesa': 'M',
        'mountain': 'N', 'snow': 'W', 'earth': 'E', 'cloud': 'L', 'none': '.'}


def classify(r, g, b):
    # Nearest centroid, no cutoff. A tolerance-gated version left 27% of cells
    # unclassified - all of them mid-tones and shading between palette centres -
    # and an unclassified cell is indistinguishable from sea downstream, which
    # silently ate coastline. Every cell must resolve to some class.
    best, bestd = 'sea', 1e18
    for name, (cr, cg, cb), _tol in CLASSES:
        d = (r-cr)**2 + (g-cg)**2 + (b-cb)**2
        if d < bestd:
            best, bestd = name, d
    return best

def main():
    w, h, px = read_png(Path('reference.png'))

    # Isometric frame solved from the slab's four visible corners, read off the
    # reference by eye. Screen-space corners of the slab's TOP face, in pixels.
    # Order: west(left), north(top), east(right), south(bottom).
    corners = {'W': (48, 505), 'N': (770, 108), 'E': (1500, 505), 'S': (775, 985)}
    Wc, Nc, Ec, Sc = (corners[k] for k in 'WNES')
    # Plan axes: u runs W->S along one slab edge, v runs W->N along the other.
    ux, uy = (Sc[0]-Wc[0], Sc[1]-Wc[1])
    vx, vy = (Nc[0]-Wc[0], Nc[1]-Wc[1])
    det = ux*vy - uy*vx

    counts = {}
    grid = []
    for j in range(W_OUT):          # v axis, 0 at W edge -> 1 at N
        row = []
        for i in range(W_OUT):      # u axis, 0 at W edge -> 1 at S
            u = (i + 0.5) / W_OUT
            v = (j + 0.5) / W_OUT
            sx = Wc[0] + u*ux + v*vx
            sy = Wc[1] + u*uy + v*vy
            xi, yi = int(sx), int(sy)
            if 0 <= xi < w and 0 <= yi < h:
                r, g, b, _ = px[yi*w + xi]
                c = classify(r, g, b)
            else:
                c = 'none'
            counts[c] = counts.get(c, 0) + 1
            row.append(c)
        grid.append(row)

    # Cloud cells sit in FRONT of whatever is behind them: they are holes in the
    # evidence, not terrain. Fill each from its nearest non-cloud neighbour by
    # ring search, so a cloud over the mesa inherits mesa rather than punching sea
    # through the middle of a landmass.
    holes = [(j, i) for j in range(W_OUT) for i in range(W_OUT) if grid[j][i] == 'cloud']
    for (j, i) in holes:
        found = None
        for rad in range(1, 14):
            tally = {}
            for dj in range(-rad, rad+1):
                for di in range(-rad, rad+1):
                    if max(abs(dj), abs(di)) != rad:
                        continue
                    nj, ni = j+dj, i+di
                    if 0 <= nj < W_OUT and 0 <= ni < W_OUT and grid[nj][ni] != 'cloud':
                        tally[grid[nj][ni]] = tally.get(grid[nj][ni], 0) + 1
            if tally:
                found = max(tally.items(), key=lambda kv: kv[1])[0]
                break
        grid[j][i] = found or 'sea'

    LAND = ('beach','mesa','field','grass','darkgrass','rock','mountain','snow','earth')
    # Majority filter: single stray cells are classifier noise, not islets. Real
    # islets in the reference are several cells across and survive this.
    for _ in range(2):
        snap = [row[:] for row in grid]
        for j in range(1, W_OUT-1):
            for i in range(1, W_OUT-1):
                ring = [snap[j+dj][i+di] for dj in (-1,0,1) for di in (-1,0,1) if (dj or di)]
                isl = sum(1 for c in ring if c in LAND)
                if snap[j][i] in LAND and isl <= 1:
                    grid[j][i] = 'sea'
                elif snap[j][i] not in LAND and isl >= 7:
                    grid[j][i] = max(set(c for c in ring if c in LAND),
                                     key=lambda c: ring.count(c))
    land = [[1 if c in LAND else 0 for c in row] for row in grid]

    # Elevation per class, in slab-thickness units. These are the tier heights the
    # plateau-and-cliff landform grammar is built from: flat tables at discrete
    # levels, with the riser between them coming from the tier gap, not a slope.
    ELEV = {'deepsea': -0.30, 'sea': -0.18, 'shallow': -0.05, 'foam': 0.00,
            'beach': 0.02, 'grass': 0.16, 'field': 0.18, 'darkgrass': 0.22,
            'rock': 0.34, 'mesa': 0.46, 'mountain': 0.72, 'snow': 1.00,
            'earth': 0.10, 'cloud': 0.16}
    elev = [[ELEV[c] for c in row] for row in grid]

    # Smooth before quantising. Elevation here is derived from per-cell CLASS, so a rock
    # cell beside a grass cell jumps several tiers and the terraced mesh turns every class
    # boundary into a tall thin wall - the first build came out a pin cushion of black
    # spikes. Blurring makes the field a coherent surface first; quantisation then produces
    # a few real risers instead of thousands of one-cell ones.
    for _ in range(4):
        nxt = [row[:] for row in elev]
        for j in range(W_OUT):
            for i in range(W_OUT):
                tot, n = 0.0, 0
                for dj in (-2, -1, 0, 1, 2):
                    for di in (-2, -1, 0, 1, 2):
                        nj, ni = j+dj, i+di
                        if 0 <= nj < W_OUT and 0 <= ni < W_OUT:
                            tot += elev[nj][ni]; n += 1
                nxt[j][i] = tot / n
        elev = nxt
    # Water must stay at or below sea level after blurring, and land above it, or the
    # coastline drifts away from the classified one.
    for j in range(W_OUT):
        for i in range(W_OUT):
            if land[j][i]:
                elev[j][i] = max(elev[j][i], 0.04)
            else:
                elev[j][i] = min(elev[j][i], -0.02)

    out = {
        'planResolution': W_OUT,
        'slabCornersScreen': corners,
        'classCounts': dict(sorted(counts.items(), key=lambda kv: -kv[1])),
        'landFraction': round(sum(map(sum, land)) / (W_OUT*W_OUT), 4),
        'classCodes': CODE,
        'grid': [''.join(CODE[c] for c in row) for row in grid],
        'land': [''.join(str(v) for v in row) for row in land],
        'elevation': [[round(v, 3) for v in row] for row in elev],
        'elevationUnits': 'fraction of maximum terrain height above sea level',
        'cloudHolesFilled': len(holes),
        'note': ('Plan view recovered assuming ground height 0; plateau tops carry an '
                 'up-screen offset proportional to their elevation (see projection-route.md). '
                 'Cloud-classified cells are evidence holes, not terrain.'),
    }
    # Landmark plan positions. Screen coordinates are read off the reference by eye
    # (agent vision decides WHERE), then run through the same inverse isometric transform
    # as the biome grid so landmarks and terrain land in one coordinate system.
    LANDMARKS = {
        'mountain-peak': (770, 180), 'stone-ring': (555, 372), 'waterfall': (440, 500),
        'arch-bridge': (612, 488), 'castle': (856, 464), 'lighthouse': (856, 626),
        'windmill': (1156, 512), 'watchtower-a': (1036, 330), 'watchtower-b': (1072, 376),
        'pier': (976, 616), 'mesa-centre': (1140, 400), 'village-east': (1130, 552),
        'hamlet-nw': (470, 430), 'hamlet-w': (400, 560),
    }
    # Invert [ux vx; uy vy] to take screen (x,y) back to plan (u,v).
    plan = {}
    for name, (sx, sy) in LANDMARKS.items():
        dx, dy = sx - Wc[0], sy - Wc[1]
        u = ( vy*dx - vx*dy) / det
        v = (-uy*dx + ux*dy) / det
        plan[name] = [round(u, 4), round(v, 4)]
    out['landmarksPlan'] = plan
    out['landmarksNote'] = ('Screen positions read by eye, un-projected with the same '
                            'transform as the grid. Carries the same height-zero assumption, '
                            'so a landmark on a high plateau sits slightly toward the viewer.')

    Path('layout.json').write_text(json.dumps(out, indent=1))

    # Visual check: write the mask back out as a PNG so the extraction can be eyeballed.
    palette = {'cloud':(255,255,255),'snow':(230,240,250),'foam':(200,235,245),
               'shallow':(90,200,220),'sea':(30,110,185),'deepsea':(18,66,135),
               'beach':(228,210,160),'mesa':(206,168,106),'field':(150,186,92),
               'grass':(96,168,70),'darkgrass':(54,118,58),'rock':(126,128,140),
               'mountain':(88,122,176),'earth':(140,92,56),'none':(0,0,0)}
    buf = bytearray()
    for row in grid:
        for c in row:
            buf.extend(palette[c])
    write_png_rgb(Path('layout-mask.png'), W_OUT, W_OUT, bytes(buf))
    print(json.dumps({'landFraction': out['landFraction'],
                      'top': list(out['classCounts'].items())[:9]}, indent=1))

main()
