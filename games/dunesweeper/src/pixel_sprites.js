/**
 * DUNESWEEPER - 16-bit Pixel Sprite System
 * Every UI icon is hand-drawn as a 16x16 indexed pixel grid and rendered to an
 * offscreen canvas at boot (crisp, zero external assets, no emoji).
 *
 * Sprite convention: '.' = transparent. Rows are exactly 16 chars.
 * 16-bit rules: dark outline + one highlight + one shade per material.
 */

const OUT = '#241a10'; // warm near-black outline

function drawSprite(rows, palette) {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  for (let y = 0; y < size; y++) {
    const row = rows[y];
    for (let x = 0; x < 16; x++) {
      const ch = row[x];
      if (!ch || ch === '.') continue;
      ctx.fillStyle = palette[ch] || '#ff00ff';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL('image/png');
}

const HEART_ROWS = [
  '................',
  '...OO......OO...',
  '..OLRO....ORLO..',
  '.OLLRRO..ORRLLO.',
  '.OLRRRRRRRRRRDO.',
  '.OLRRRRRRRRRRDO.',
  '.ORRRRRRRRRRRDO.',
  '.ORRRRRRRRRRDDO.',
  '..ORRRRRRRRRDO..',
  '...ORRRRRRRDO...',
  '....ORRRRRDO....',
  '.....ORRRDO.....',
  '......ORDO......',
  '.......OO.......',
  '................',
  '................',
];

const HEART_PALETTE_FULL = { O: OUT, R: '#d94343', L: '#ff9b9b', D: '#8e2222' };
const HEART_PALETTE_EMPTY = { O: OUT, R: '#46464e', L: '#6f6f79', D: '#303038' };

export function buildSprites() {
  const S = {};

  S.heart = drawSprite(HEART_ROWS, HEART_PALETTE_FULL);
  S.heartEmpty = drawSprite(HEART_ROWS, HEART_PALETTE_EMPTY);

  // ---- SURVEY FLAG --------------------------------------------------------
  S.flag = drawSprite(
    [
      '................',
      '..OOOOOOOOO.....',
      '..ORRRRRRRO.....',
      '..ORWWRRRRO.....',
      '..ORRRRRRRO.....',
      '..OODDDDRRO.....',
      '..OO.OODO.......',
      '......OWO.......',
      '......OWO.......',
      '......OWO.......',
      '......OWO.......',
      '......OWO.......',
      '.....OBWWBO.....',
      '....OBWWWWBO....',
      '.....OOOOOO.....',
      '................',
    ],
    { O: OUT, R: '#cf3f3f', W: '#f6d6a8', B: '#7a5230' },
  );

  // ---- BRUSH / PICK TOOL ----------------------------------------------------
  S.brush = drawSprite(
    [
      '..........OO....',
      '.........OSSOO..',
      '........OSSSSO..',
      '.......OSSSSSO..',
      '......OSSSSSO...',
      '.....OSSSSSO....',
      '..O..OSSSSOO....',
      '.OMMOOSSSOO.....',
      '.OMMMOOOOOO.....',
      '.OGMMMWO........',
      '..OOMMWO.OO.....',
      '...OOMMWOHHO....',
      '....OOMHHHHO....',
      '.....OHHAHHO....',
      '....OHHAAHHO....',
      '.....OOOOOO.....',
    ],
    { O: OUT, S: '#c3c8d2', M: '#c48b4a', G: '#8a5a28', H: '#8a6a42', A: '#b08954', W: '#ffffff' },
  );

  // ---- SHIELD -----------------------------------------------------------------
  S.shield = drawSprite(
    [
      '................',
      '...OOOOOOOOOO...',
      '..OSLLSSSSSSSO..',
      '..OSLSSSSSSSSO..',
      '..OSLSGGGSSSSO..',
      '..OSLSGGGSSSSO..',
      '..OSLSGGGSSSSO..',
      '..OSSSGNSSSSSO..',
      '..OSSSSNNSSSSO..',
      '..OSSSSNNSSSSO..',
      '...OSSSSSSSSO...',
      '....OSSSSSSO....',
      '.....OSSSSO.....',
      '......OSSO......',
      '.......OO.......',
      '................',
    ],
    { O: OUT, S: '#5a7ba6', L: '#aac4e2', G: '#d8b04a', N: '#8a5f22' },
  );

  // ---- COMPASS ------------------------------------------------------------------
  S.compass = drawSprite(
    [
      '................',
      '.....OOOOOO.....',
      '...OOGLLLGOO....',
      '..OGLLGGGGLGO...',
      '..OLGGWGGGGGO...',
      '.OGLGWWRGGGGGO..',
      '.OLGGWWRGGGGGO..',
      '.OLGGGRWGGGGGO..',
      '.OLGGGGRWGGGGO..',
      '.OLGGGGGWGGGGO..',
      '.ODGGGGGGGGGGO..',
      '..ODGGGGGGGGO...',
      '...OODGGGGDOO...',
      '.....OOOOOO.....',
      '................',
      '................',
    ],
    { O: OUT, G: '#caa54c', L: '#efe0ae', D: '#8a6c2c', W: '#f2ede4', R: '#cf3f3f' },
  );

  // ---- RELIC AMPHORA --------------------------------------------------------------
  S.relic = drawSprite(
    [
      '................',
      '......OOOO......',
      '.....OB..BO.....',
      '......O..O......',
      '.....OOBBBBO....',
      '....OBGGGGDBO...',
      '...OBGLLGGGDBO..',
      '...OBGLLGGDDBO..',
      '...OBGLLGGDDBO..',
      '....OBGGGGDBO...',
      '.....OOODBBO....',
      '....OBDDDDBO....',
      '...OBDDDDDDBO...',
      '..OBWWWWWWWWBO..',
      '..OOOOOOOOOOOO..',
      '................',
    ],
    { O: OUT, B: '#95702c', G: '#d9a83c', L: '#f7dd96', D: '#b5892f', W: '#e8dfc8' },
  );

  // ---- HOURGLASS (timer) ------------------------------------------------------------
  S.timer = drawSprite(
    [
      '................',
      '..OOOOOOOOOOOO..',
      '..OFWWWWWWWWWFO.',
      '..OFFFFFFFFFFFFO',
      '...OFFWWWWWFFO..',
      '....OFFFWWFFO...',
      '.....OFFWFFO....',
      '......OFSFO.....',
      '.....OFFSFFO....',
      '....OFFSSFFO....',
      '...OFFSSSSFFO...',
      '..OFFFFFFFFFFFO.',
      '..OFSSSSSSSSSFO.',
      '..OOOOOOOOOOOO..',
      '................',
      '................',
    ],
    { O: OUT, F: '#efe6cd', W: '#ffffff', S: '#e2a63c' },
  );

  // ---- SKULL --------------------------------------------------------------------------
  S.skull = drawSprite(
    [
      '................',
      '.....OOOOOO.....',
      '...OOWWWWWWOO...',
      '..OWWWWWWWWWWO..',
      '..OWWWWWWWWWWO..',
      '..OWKKWWWWKKWO..',
      '..OWKKWWWWKKWO..',
      '..OWWWKWWKWWWO..',
      '...OWWKWWKWWO...',
      '...OOWWKKWWOO...',
      '....OWNNNNWO....',
      '....ON.WW.NO....',
      '....OONNNNOO....',
      '......OOOO......',
      '................',
      '................',
    ],
    { O: OUT, W: '#f2ede4', K: '#221d18', N: '#c9c0b0' },
  );

  // ---- GEM ------------------------------------------------------------------------------
  S.gem = drawSprite(
    [
      '................',
      '................',
      '.....OOOOOO.....',
      '....OCCLLCGO....',
      '...OCCLLLLCCO...',
      '..OCCLLLLLWCCO..',
      '..OCLLLLLWWLCO..',
      '..OCLLLLWWLLCO..',
      '..OCGLLLLLLCCO..',
      '...OGGLLLLCO....',
      '....OGGLLCO.....',
      '.....OGGCO......',
      '......OOO.......',
      '................',
      '................',
      '................',
    ],
    { O: OUT, G: '#2e7f7f', C: '#4fc4c4', L: '#8ff0ef', W: '#ffffff' },
  );

  // ---- TEMPLE ------------------------------------------------------------------------------
  S.temple = drawSprite(
    [
      '.......OO.......',
      '......OYYO......',
      '.....OYWYYO.....',
      '....OYYYYYYO....',
      '...OYYYYYYYYO...',
      '..OYYYYYYYYYYO..',
      '..OOOOOOOOOOOO..',
      '..OYOYOOYOYOOO..',
      '..OYYYYYYYYYYO..',
      '..OYOYYOYYOYYO..',
      '..OYYYYYYYYYYO..',
      '..OYOYYOYYOYYO..',
      '..OYYYYYYYYYYO..',
      '..OYYYYYYYYYYO..',
      '..OOOOOOOOOOOO..',
      '................',
    ],
    { O: OUT, Y: '#d9a83c', W: '#fff3c0' },
  );

  // ---- TROPHY ---------------------------------------------------------------------------------
  S.trophy = drawSprite(
    [
      '................',
      '..OOOOOOOOOOOO..',
      '.OYYYYYYYYYYYYO.',
      '.OYWYYYYYYYYYYO.',
      '.OYOYYYOOYYYOYO.',
      '.OYOYYOOOOOYOYO.',
      '.OOOYYOOOOOYOOO.',
      '....OYYYYYYO....',
      '.....OYOOYO.....',
      '......OYYO......',
      '.......OO.......',
      '......OYYO......',
      '.....OYYYYO.....',
      '....OYYYYYYO....',
      '...OOOOOOOOOO...',
      '................',
    ],
    { O: OUT, Y: '#e6bb45', W: '#fff3c0' },
  );

  // ---- GEAR (settings) --------------------------------------------------------------------------
  S.gear = drawSprite(
    [
      '.......OO.......',
      '..OO..OGGO..OO..',
      '.OGGGOOGGOOGGO..',
      '.OGGGGGGGGGGGO..',
      '..OOGGDKDGGOO...',
      '...OGDKKKKDGO...',
      '...ODKKKKKKDO...',
      '...ODKWKKKKDO...',
      '...ODKKKKKKDO...',
      '...OGDKKKKDGO...',
      '..OOGGDKDGGOO...',
      '.OGGGGGGGGGGGO..',
      '.OGGGOOGGOOGGO..',
      '..OO..OGGO..OO..',
      '.......OO.......',
      '................',
    ],
    { O: OUT, G: '#9aa0aa', D: '#6b7078', K: '#33373d', W: '#f2ede4' },
  );

  // ---- EXPLORER BUST ------------------------------------------------------
  S.explorer = drawSprite(
    [
      '................',
      '.....OOOOOO.....',
      '....OHHHHHHO....',
      '...OHHHHHHHHO...',
      '..OOOOOOOOOOOO..',
      '..OHHHHHHHHHHO..',
      '...OFFFFFFFFOO..',
      '...OFKFFFFKFO...',
      '...OFKFFFFKFO...',
      '...OFFFFFFFFO...',
      '....OFFKKFFO....',
      '.....OFFFFO.....',
      '....OSSSSSSO....',
      '...OSFOOOOFFO...',
      '....OOOOOOOO....',
      '................',
    ],
    { O: OUT, H: '#c8a05a', F: '#e8b98a', K: '#241a10', S: '#8a7340' },
  );

  // ---- DIG SHOVEL -----------------------------------------------------------
  S.dig = drawSprite(
    [
      '................',
      '..........OOO...',
      '.........OBWBO..',
      '........OOOOOO..',
      '.......OMMMMO...',
      '......OMMMMO....',
      '.....OMMMMO.....',
      '....OMMMMO......',
      '...OOMMMO.......',
      '..OSMOMOO.......',
      '.OSSSSSO........',
      '.OSLSSSO........',
      'OSLLSSSSO.......',
      'OSLSSSSSO.......',
      '.OSSSSSO........',
      '..OOOOO.........',
    ],
    { O: OUT, B: '#8a6a42', W: '#c49a62', M: '#8a6a42', S: '#b9bfc9', L: '#e8ecf2' },
  );

  // ---- SCROLL (seed / info) ----------------------------------------------------------------------
  S.scroll = drawSprite(
    [
      '................',
      '..OOOOOOOOOOO...',
      '.OPPPPPPPPPPPO..',
      '.OPWWWWWWWPPO...',
      '.OPKKKKKKWPPO...',
      '.OPPPPPPPWPPO...',
      '.OPKKKKKKWPPO...',
      '.OPWWWWWWWPPO...',
      '.OPKKKKKKWPPO...',
      '.OPPPPPPPPPPO...',
      '.OPPWWWWWPPO....',
      '..OOOOOOOOOOO...',
      '................',
      '................',
      '................',
      '................',
    ],
    { O: OUT, P: '#c9a76a', W: '#ffffff', K: '#6b5638' },
  );

  return S;
}

let SPRITES = null;

/** Get the sprite sheet (built once on first use — needs DOM for canvas). */
export function getSprites() {
  if (!SPRITES) {
    SPRITES = buildSprites();
  }
  return SPRITES;
}

/** Build an <img> tag for a sprite at a given CSS pixel size. */
export function pixIcon(name, size = 16, extraClass = '') {
  const src = getSprites()[name] || getSprites().scroll;
  return `<img class="px-img ${extraClass}" src="${src}" width="${size}" height="${size}" alt="">`;
}

/**
 * Replace every <span data-icon="name"> placeholder in the document with its
 * pixel sprite image. Called once from main.js after DOM is ready.
 */
export function applyPixelIcons(root = document) {
  getSprites(); // ensure the sheet is rendered once before any lookups
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.dataset.icon;
    const size = Number(el.dataset.size || 18);
    el.innerHTML = pixIcon(name, size);
    el.classList.add('pix');
  }
}
