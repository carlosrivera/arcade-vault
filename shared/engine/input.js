// input.js — keyboard state for games that poll held keys each frame.
//
// Games need three separate things from the keyboard, and hand-rolling them
// per game is where the inconsistencies creep in:
//   - held state, sampled every frame (thrust, steering)
//   - edge events, fired once per press (fire, toggle camera, restart)
//   - browser housekeeping: stop arrows/space scrolling the page, and drop
//     every key when the window loses focus

const DEFAULT_PREVENT = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export class Keyboard {
  /**
   * @param {object} [options]
   * @param {string[]} [options.preventDefault] key codes whose default browser
   *   action is suppressed. Pass [] to leave the page alone.
   */
  constructor({ preventDefault = DEFAULT_PREVENT } = {}) {
    this._down = new Set();
    this._pressHandlers = new Map();
    this._prevent = new Set(preventDefault);

    this._onKeyDown = (e) => {
      if (this._prevent.has(e.code)) e.preventDefault();
      // Ignore auto-repeat for edge events so holding a key fires once.
      const isRepeat = this._down.has(e.code);
      this._down.add(e.code);
      if (isRepeat) return;
      const handlers = this._pressHandlers.get(e.code);
      if (handlers) for (const fn of handlers) fn(e);
    };

    this._onKeyUp = (e) => {
      this._down.delete(e.code);
      // Releasing one Shift while the other is still held reports only the
      // released code, but releasing both during a drag can drop the event
      // entirely. Trust the modifier flag over our own bookkeeping.
      if (!e.shiftKey) {
        this._down.delete('ShiftLeft');
        this._down.delete('ShiftRight');
      }
    };

    // Without this, alt-tabbing mid-throttle leaves the key stuck down forever.
    this._onBlur = () => this._down.clear();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /** Is this key currently held? */
  isDown(code) {
    return this._down.has(code);
  }

  /** Is any of these keys held? Convenient for "KeyW or ArrowUp". */
  anyDown(...codes) {
    return codes.some((code) => this._down.has(code));
  }

  /**
   * A -1 / 0 / +1 axis from two key groups, the shape every steering and
   * throttle input wanted. Each side takes a code or an array of codes.
   */
  axis(negative, positive) {
    const neg = Array.isArray(negative) ? negative : [negative];
    const pos = Array.isArray(positive) ? positive : [positive];
    return (this.anyDown(...pos) ? 1 : 0) - (this.anyDown(...neg) ? 1 : 0);
  }

  /**
   * Run a handler once per physical press (auto-repeat suppressed).
   * @returns {() => void} unsubscribe
   */
  onPress(code, handler) {
    if (!this._pressHandlers.has(code)) this._pressHandlers.set(code, new Set());
    this._pressHandlers.get(code).add(handler);
    return () => this._pressHandlers.get(code)?.delete(handler);
  }

  /** Forget every held key, e.g. when returning to a menu. */
  clear() {
    this._down.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this._pressHandlers.clear();
    this._down.clear();
  }
}
