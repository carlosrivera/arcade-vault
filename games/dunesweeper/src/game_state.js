/**
 * DUNESWEEPER - Logical Game State & Solver
 * Pure logical representation of the Minesweeper board, solver, and expedition state
 */

import { CONFIG } from './config.js';
import { PRNG } from './prng.js';

export const CELL_STATE = {
  COVERED: 'covered',
  REVEALED: 'revealed',
  FLAGGED: 'flagged',
  TRIGGERED: 'triggered',
};

export const GAME_STATUS = {
  READY: 'ready',
  PLAYING: 'playing',
  WON: 'won',
  LOST: 'lost',
};

export class GameState {
  constructor(difficultyKey = 'explorer', seed = null) {
    this.difficultyKey = difficultyKey;
    this.difficulty = CONFIG.DIFFICULTIES[difficultyKey] || CONFIG.DIFFICULTIES.explorer;
    this.seed = seed || `expedition_${Math.floor(Math.random() * 90000 + 10000)}`;
    this.prng = new PRNG(this.seed);

    this.width = this.difficulty.width;
    this.height = this.difficulty.height;
    this.trapCount = this.difficulty.traps;
    this.targetRelics = this.difficulty.relics;

    // Pick level name deterministically from seed
    const nameIdx = Math.abs(PRNG.hashString(this.seed)) % CONFIG.EXPEDITION_NAMES.length;
    this.levelName = CONFIG.EXPEDITION_NAMES[nameIdx];

    this.status = GAME_STATUS.READY;
    this.lives = this.difficulty.lives;
    this.maxLives = this.difficulty.lives;
    this.shields = this.difficulty.shields || 1;
    this.brushes = this.difficulty.brushes;
    this.compasses = this.difficulty.compasses;
    this.maps = this.difficulty.maps || 0;
    this.paused = false;

    this.startTime = 0;
    this.elapsedTime = 0;
    this.timerInterval = null;

    this.relicsFound = 0;
    this.flagsCount = 0;
    this.revealedCount = 0;
    this.safeCellsTotal = this.width * this.height - this.trapCount;
    this.exitUnlocked = false;
    this.exitPosition = null;

    this.grid = [];
    this.firstClickDone = false;

    // Listeners for UI & FX
    this.listeners = {
      onCellRevealed: [],
      onCellFlagged: [],
      onTrapTriggered: [],
      onRelicFound: [],
      onExitUnlocked: [],
      onLivesChanged: [],
      onToolsChanged: [],
      onStatusChanged: [],
      onCompassScan: [],
      onLogMessage: [],
    };

    this.initGrid();
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      for (const cb of this.listeners[event]) {
        cb(data);
      }
    }
  }

  log(message, type = 'info') {
    this.emit('onLogMessage', { message, type });
  }

  initGrid() {
    this.grid = [];
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        row.push({
          x,
          y,
          isTrap: false,
          state: CELL_STATE.COVERED,
          neighborTraps: 0,
          relicType: null, // 'idol' | 'amethyst' | 'chest'
          isExit: false,
          isSunkenChamber: false,
          hazardType: 'spider', // 'spider' | 'altar' | 'scorpion'
          variation: Math.floor(this.prng.next() * 5),
        });
      }
      this.grid.push(row);
    }
  }

  getCell(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return null;
    return this.grid[y][x];
  }

  getNeighbors(x, y) {
    const neighbors = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const cell = this.getCell(x + dx, y + dy);
        if (cell) neighbors.push(cell);
      }
    }
    return neighbors;
  }

  /**
   * Generates traps and ensures safe starting area
   */
  populateBoard(firstX, firstY) {
    const forbidden = new Set();
    forbidden.add(`${firstX},${firstY}`);
    for (const nb of this.getNeighbors(firstX, firstY)) {
      forbidden.add(`${nb.x},${nb.y}`);
    }

    const available = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (!forbidden.has(`${x},${y}`)) {
          available.push({ x, y });
        }
      }
    }

    this.prng.shuffle(available);

    const hazardChamberTypes = ['spider', 'altar', 'scorpion'];
    const trapsToPlace = Math.min(this.trapCount, available.length);

    for (let i = 0; i < trapsToPlace; i++) {
      const pos = available[i];
      const cell = this.getCell(pos.x, pos.y);
      cell.isTrap = true;
      cell.hazardType = hazardChamberTypes[i % hazardChamberTypes.length];
      cell.isSunkenChamber = true; // Traps sit in deep excavation pits
    }

    // Calculate neighbor traps count
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.grid[y][x];
        if (cell.isTrap) {
          cell.neighborTraps = -1;
        } else {
          cell.neighborTraps = this.getNeighbors(x, y).filter((nb) => nb.isTrap).length;
        }
      }
    }

    // Place Relics in safe cells (away from start)
    const relicCandidates = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.grid[y][x];
        if (!cell.isTrap && !forbidden.has(`${x},${y}`)) {
          relicCandidates.push(cell);
        }
      }
    }
    this.prng.shuffle(relicCandidates);

    const relicTypes = ['idol', 'amethyst', 'chest'];
    const relicsPlaced = Math.min(this.targetRelics, relicCandidates.length);
    for (let i = 0; i < relicsPlaced; i++) {
      relicCandidates[i].relicType = relicTypes[i % relicTypes.length];
      relicCandidates[i].isSunkenChamber = true; // Relics sit in sunken ancient rooms
    }

    // Place exit stairway in a safe location furthest from start
    let maxDist = -1;
    let exitCell = null;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.grid[y][x];
        if (!cell.isTrap && !cell.relicType) {
          const dist = Math.hypot(x - firstX, y - firstY);
          if (dist > maxDist) {
            maxDist = dist;
            exitCell = cell;
          }
        }
      }
    }
    if (exitCell) {
      exitCell.isExit = true;
      this.exitPosition = { x: exitCell.x, y: exitCell.y };
    }

    this.firstClickDone = true;
    this.status = GAME_STATUS.PLAYING;
    this.startTimer();
    this.emit('onStatusChanged', { status: this.status });
  }

  startTimer() {
    this.startTime = Date.now() - this.elapsedTime * 1000;
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      if (this.status === GAME_STATUS.PLAYING) {
        this.elapsedTime = Math.floor((Date.now() - this.startTime) / 1000);
      }
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /** Pause/unpause: freezes the clock and blocks all board actions. */
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.elapsedTime = Math.floor((Date.now() - this.startTime) / 1000);
      this.stopTimer();
    } else if (this.status === GAME_STATUS.PLAYING) {
      this.startTimer();
    }
  }

  get actionable() {
    return (
      !this.paused && (this.status === GAME_STATUS.PLAYING || this.status === GAME_STATUS.READY)
    );
  }

  /**
   * Primary action: Dig / Excavate a cell
   */
  excavate(x, y) {
    if (!this.actionable) return [];
    const cell = this.getCell(x, y);
    if (!cell || cell.state !== CELL_STATE.COVERED) return [];

    if (!this.firstClickDone) {
      this.populateBoard(x, y);
    }

    const revealedBatch = [];

    // Trap triggered!
    if (cell.isTrap) {
      cell.state = CELL_STATE.TRIGGERED;

      // Check if player has an active shield
      if (this.shields > 0) {
        this.shields--;
        this.emit('onToolsChanged', {
          shields: this.shields,
          brushes: this.brushes,
          compasses: this.compasses,
          maps: this.maps,
        });
        this.log('Shield activated! Trap neutralized.', 'shield');
      } else {
        this.lives = Math.max(0, this.lives - 1);
        this.emit('onLivesChanged', { lives: this.lives, maxLives: this.maxLives });
        this.log('Caution! A trap caused damage.', 'trap');
      }

      this.emit('onTrapTriggered', { cell });

      if (this.lives <= 0) {
        this.status = GAME_STATUS.LOST;
        this.stopTimer();
        this.revealAllTraps();
        this.emit('onStatusChanged', { status: this.status });
      }
      return [cell];
    }

    // Safe cell revealed
    const queue = [cell];
    const visited = new Set();
    visited.add(`${x},${y}`);

    let stepDelay = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      current.state = CELL_STATE.REVEALED;
      this.revealedCount++;

      if (current.relicType) {
        this.relicsFound++;
        this.log(`Unearthed a relic (${this.relicsFound}/${this.targetRelics})!`, 'relic');
        this.emit('onRelicFound', { cell: current, relicType: current.relicType });
      }

      if (current.isExit) {
        this.exitUnlocked = true;
        this.log('Discovered the expedition exit!', 'exit');
        this.emit('onExitUnlocked', { cell: current });
      }

      revealedBatch.push({ cell: current, delay: stepDelay });

      // If zero neighbor traps, cascade
      if (current.neighborTraps === 0) {
        stepDelay += 35;
        for (const nb of this.getNeighbors(current.x, current.y)) {
          const key = `${nb.x},${nb.y}`;
          if (!visited.has(key) && nb.state === CELL_STATE.COVERED && !nb.isTrap) {
            visited.add(key);
            queue.push(nb);
          }
        }
      }
    }

    this.emit('onCellRevealed', { batch: revealedBatch });
    this.checkWinCondition();
    return revealedBatch;
  }

  /**
   * Toggle flag stake
   */
  toggleFlag(x, y) {
    if (!this.actionable) return;
    const cell = this.getCell(x, y);
    if (!cell || cell.state === CELL_STATE.REVEALED || cell.state === CELL_STATE.TRIGGERED) return;

    if (cell.state === CELL_STATE.COVERED) {
      cell.state = CELL_STATE.FLAGGED;
      this.flagsCount++;
      this.log('Marked a possible trap.', 'flag');
    } else if (cell.state === CELL_STATE.FLAGGED) {
      cell.state = CELL_STATE.COVERED;
      this.flagsCount--;
      this.log('Removed marker.', 'flag');
    }

    this.emit('onCellFlagged', { cell, isFlagged: cell.state === CELL_STATE.FLAGGED });
  }

  /**
   * Chord action on revealed number
   */
  chord(x, y) {
    if (!this.actionable) return;
    const cell = this.getCell(x, y);
    if (!cell || cell.state !== CELL_STATE.REVEALED || cell.neighborTraps <= 0) return;

    const neighbors = this.getNeighbors(x, y);
    const flagCount = neighbors.filter((nb) => nb.state === CELL_STATE.FLAGGED).length;

    if (flagCount === cell.neighborTraps) {
      for (const nb of neighbors) {
        if (nb.state === CELL_STATE.COVERED) {
          this.excavate(nb.x, nb.y);
        }
      }
    }
  }

  /**
   * Tool: Safe Brush — clears ONE guaranteed-safe covered cell. Can be aimed:
   * brushing a dangerous cell is refused without spending the charge.
   */
  useBrush(targetX, targetY) {
    if (!this.actionable || this.brushes <= 0) return null;

    if (!this.firstClickDone) {
      const tx = targetX ?? Math.floor(this.width / 2);
      const ty = targetY ?? Math.floor(this.height / 2);
      this.brushes--;
      this.emit('onToolsChanged', {
        shields: this.shields,
        brushes: this.brushes,
        compasses: this.compasses,
        maps: this.maps,
      });
      return this.excavate(tx, ty);
    }

    if (targetX === undefined || targetY === undefined) {
      // No aim provided: fall back to a random cell bordering revealed ground
      const candidates = [];
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          const c = this.grid[y][x];
          if (c.state === CELL_STATE.COVERED && !c.isTrap) candidates.push(c);
        }
      }
      if (candidates.length === 0) return null;
      const pick = candidates[Math.floor(this.prng.next() * candidates.length)];
      targetX = pick.x;
      targetY = pick.y;
    }

    const target = this.getCell(targetX, targetY);
    if (!target || target.state !== CELL_STATE.COVERED) {
      this.log('Nothing left to brush there.', 'tool');
      return null;
    }
    if (target.isTrap) {
      // Guarantee holds: refuse without charging the brush
      this.log('The ground feels unstable there — you keep your brush.', 'flag');
      return null;
    }

    this.brushes--;
    this.emit('onToolsChanged', {
      shields: this.shields,
      brushes: this.brushes,
      compasses: this.compasses,
      maps: this.maps,
    });
    this.log('Brush cleared a safe cell.', 'tool');
    return this.excavate(targetX, targetY);
  }

  /**
   * Tool: Old Map — reveals a handful of open dig sites elsewhere on the board.
   */
  useMap() {
    if (!this.actionable || this.maps <= 0) return null;
    if (!this.firstClickDone) {
      this.populateBoard(Math.floor(this.width / 2), Math.floor(this.height / 2));
    }

    const safe = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.grid[y][x];
        if (c.state === CELL_STATE.COVERED && !c.isTrap) safe.push(c);
      }
    }
    if (safe.length === 0) {
      this.log('The map is blank — no open ground remains.', 'tool');
      return null;
    }

    this.prng.shuffle(safe);
    const markCount = Math.max(3, Math.round(this.width * 0.4));
    const picks = safe.slice(0, Math.min(markCount, safe.length));

    this.maps--;
    this.emit('onToolsChanged', {
      shields: this.shields,
      brushes: this.brushes,
      compasses: this.compasses,
      maps: this.maps,
    });
    this.log(`An old map fragment marks ${picks.length} open dig sites!`, 'tool');
    for (const pick of picks) {
      this.excavate(pick.x, pick.y);
    }
    return picks.map((c) => ({ x: c.x, y: c.y }));
  }

  /**
   * Tool: Compass
   */
  useCompass(x, y) {
    if (!this.actionable || this.compasses <= 0) return null;
    const center = this.getCell(x, y);
    if (!center) return null;

    if (!this.firstClickDone) {
      this.populateBoard(x, y);
    }

    const area = [center, ...this.getNeighbors(x, y)];
    const hiddenTraps = area.filter((c) => c.isTrap && c.state !== CELL_STATE.TRIGGERED).length;

    this.compasses--;
    this.emit('onToolsChanged', {
      shields: this.shields,
      brushes: this.brushes,
      compasses: this.compasses,
      maps: this.maps,
    });
    this.log(`Compass: Detected ${hiddenTraps} traps in the sector.`, 'compass');
    this.emit('onCompassScan', { center, area, count: hiddenTraps });

    return { center, area, count: hiddenTraps };
  }

  revealAllTraps() {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.grid[y][x];
        if (cell.isTrap && cell.state !== CELL_STATE.TRIGGERED) {
          cell.state = CELL_STATE.REVEALED;
        }
      }
    }
  }

  checkWinCondition() {
    if (this.status !== GAME_STATUS.PLAYING) return;

    const allSafeExcavated = this.revealedCount >= this.safeCellsTotal;
    const exitCell = this.exitPosition
      ? this.getCell(this.exitPosition.x, this.exitPosition.y)
      : null;
    const relicObjectiveComplete =
      this.relicsFound >= this.targetRelics && exitCell && exitCell.state === CELL_STATE.REVEALED;

    if (allSafeExcavated || relicObjectiveComplete) {
      this.status = GAME_STATUS.WON;
      this.stopTimer();
      this.log('Expedition successfully completed!', 'victory');
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          const cell = this.grid[y][x];
          if (cell.isTrap && cell.state === CELL_STATE.COVERED) {
            cell.state = CELL_STATE.FLAGGED;
            this.emit('onCellFlagged', { cell, isFlagged: true });
          }
        }
      }
      this.emit('onStatusChanged', { status: this.status });
    }
  }

  destroy() {
    this.stopTimer();
    this.listeners = {};
  }
}
