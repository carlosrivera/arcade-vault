// pixel-sprites.js — hand-drawn pixel icons with no external assets.
//
// A sprite is a grid of characters plus a palette mapping each character to a
// colour. Rendering it to an offscreen canvas at boot yields a crisp data URL
// usable anywhere an <img> is — no image files, no emoji, no font dependency,
// and it scales to any UI size without a network request.
//
// The artwork itself belongs to each game; this is only the machinery.

/** Character meaning "leave this pixel transparent". */
export const TRANSPARENT = '.';

/**
 * Render a character grid to a PNG data URL.
 *
 * Rows are read top-to-bottom, characters left-to-right; every row should be
 * `size` characters wide. Unmapped characters render magenta, which is far
 * easier to spot in the UI than a silently missing pixel.
 *
 * @param {string[]} rows    one string per pixel row
 * @param {Record<string,string>} palette  character -> CSS colour
 * @param {number} [size=16] grid width/height in pixels
 */
export function drawSprite(rows, palette, size = 16) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  for (let y = 0; y < size; y++) {
    const row = rows[y];
    if (!row) continue;
    for (let x = 0; x < size; x++) {
      const ch = row[x];
      if (!ch || ch === TRANSPARENT) continue;
      ctx.fillStyle = palette[ch] || '#ff00ff';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL('image/png');
}

/**
 * Swap every `<span data-icon="name">` placeholder in the DOM for its sprite.
 *
 * Markup declares which icon it wants and at what size; the game supplies the
 * lookup. That keeps the HTML free of data URLs and lets icons be restyled
 * without touching templates.
 *
 * @param {ParentNode} root
 * @param {(name: string, size: number) => string} renderIcon  returns HTML
 * @param {object} [options]
 * @param {number} [options.defaultSize=18] used when data-size is absent
 * @param {string} [options.appliedClass='pix'] added to each filled element
 */
export function applyPixelIcons(root, renderIcon, { defaultSize = 18, appliedClass = 'pix' } = {}) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.dataset.icon;
    const size = Number(el.dataset.size || defaultSize);
    el.innerHTML = renderIcon(name, size);
    el.classList.add(appliedClass);
  }
}
