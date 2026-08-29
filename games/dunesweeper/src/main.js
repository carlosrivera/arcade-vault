/**
 * DUNESWEEPER - Main Game Loop & Coordinator
 * 100% Procedural Voxel Archaeological Excavation
 */

import { AudioManager } from './audio.js';
import { ExcavationFX } from './excavation_fx.js';
import { CELL_STATE, GAME_STATUS, GameState } from './game_state.js';
import { HUD } from './hud.js';
import { applyPixelIcons } from './pixel_sprites.js';
import { VoxelRenderer } from './voxel_renderer.js';

class DunesweeperApp {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.currentDifficulty = 'explorer';
    this.currentSeed = `expedition_${Math.floor(Math.random() * 90000 + 10000)}`;

    this.audio = new AudioManager();
    this.gameState = null;
    this.renderer = null;
    this.fx = null;
    this.hud = null;

    this.lastTime = 0;
    this.touchStartTime = 0;
    this.touchStartPos = { x: 0, y: 0 };
    this.longPressTimeout = null;

    this.init();
  }

  init() {
    this.startNewGame(this.currentDifficulty, this.currentSeed);

    // Stamp all 16-bit UI icons into the DOM before the HUD builds
    applyPixelIcons();

    this.hud = new HUD(this.gameState, this.audio, (action) => this.handleHudAction(action));

    this.bindInputs();
    this.setupMainMenu();

    // Start render loop — the world idles behind the menu as a backdrop
    requestAnimationFrame((t) => this.loop(t));
  }

  /**
   * Main menu: difficulty pick + start. The shared eject button watches the
   * #menu element automatically (visible here, hidden once playing).
   */
  setupMainMenu() {
    this.menuDifficulty = 'explorer';
    this.menuEl = document.getElementById('menu');
    this.hudRoot = document.getElementById('hud-root');
    this.pauseOverlay = document.getElementById('pause-overlay');
    this.resumeBtn = document.getElementById('resume-game');

    for (const btn of document.querySelectorAll('.menu-diff')) {
      btn.addEventListener('click', () => {
        this.menuDifficulty = btn.dataset.diff;
        for (const other of document.querySelectorAll('.menu-diff')) {
          other.classList.toggle('active', other === btn);
        }
      });
    }

    document.getElementById('start-game')?.addEventListener('click', () => this.startFromMenu());
    this.resumeBtn?.addEventListener('click', () => this.resumeExpedition());
  }

  startFromMenu() {
    this.audio.ensureContext();
    // Wind starts with the expedition, not on the menu. Safe to call twice --
    // it no-ops once the drone exists.
    this.audio.startDesertAmbience();
    this.menuEl.style.display = 'none';
    this.hudRoot.style.display = 'block';
    this.resumeBtn.style.display = 'none';
    this.startNewGame(
      this.menuDifficulty,
      `expedition_${Math.floor(Math.random() * 90000 + 10000)}`,
    );
    this.hud.setGameState(this.gameState);
  }

  resumeExpedition() {
    this.audio.ensureContext();
    this.audio.startDesertAmbience();
    this.menuEl.style.display = 'none';
    this.hudRoot.style.display = 'block';
    this.setPaused(false);
  }

  /** ESC → main menu (pausing the live run); P → pause/resume overlay. */
  setPaused(paused) {
    if (!this.gameState) return;
    this.gameState.setPaused(paused);
    this.pauseOverlay.style.display = paused ? 'flex' : 'none';
  }

  returnToMenu() {
    if (this.gameState && this.gameState.status === 'playing') {
      this.setPaused(true);
      // A paused, unfinished run can be resumed from the menu
      this.resumeBtn.style.display = 'inline-block';
    } else {
      this.setPaused(false);
      this.pauseOverlay.style.display = 'none';
      this.resumeBtn.style.display = 'none';
    }
    this.menuEl.style.display = 'flex';
    this.hudRoot.style.display = 'none';
  }

  startNewGame(difficultyKey, seed) {
    if (this.gameState) {
      this.gameState.destroy();
    }
    if (this.renderer) {
      this.renderer.destroy();
    }
    if (this.fx) {
      this.fx.destroy();
    }

    this.currentDifficulty = difficultyKey;
    this.currentSeed = seed;

    this.gameState = new GameState(difficultyKey, seed);
    this.renderer = new VoxelRenderer(this.canvas, this.gameState);
    this.fx = new ExcavationFX(this.renderer.scene, this.renderer);

    this.wireGameEvents();

    if (this.hud) {
      this.hud.setGameState(this.gameState);
    }
  }

  wireGameEvents() {
    // Cell revealed & cascade
    this.gameState.on('onCellRevealed', ({ batch }) => {
      batch.forEach((item, index) => {
        const { cell, delay } = item;
        setTimeout(() => {
          this.renderer.revealCellView(cell.x, cell.y);
          const wp = this.renderer.gridToWorld(cell.x, cell.y);
          this.fx.burstCellSand(wp.x, wp.z, false);

          if (index === 0) {
            this.audio.playDig();
          } else {
            this.audio.playCascade(Math.floor(index / 2));
          }
        }, delay);
      });
    });

    // Cell Flagged
    this.gameState.on('onCellFlagged', ({ cell, isFlagged }) => {
      this.renderer.setFlagView(cell.x, cell.y, isFlagged);
      this.audio.playFlag(isFlagged);
    });

    // Trap Triggered
    this.gameState.on('onTrapTriggered', ({ cell }) => {
      this.renderer.revealCellView(cell.x, cell.y);
      const wp = this.renderer.gridToWorld(cell.x, cell.y);
      this.fx.burstCellSand(wp.x, wp.z, true);
      this.fx.triggerScreenShake(0.5);
      this.audio.playTrapHit();
    });

    // Relic Found
    this.gameState.on('onRelicFound', () => {
      this.audio.playRelicFound();
    });

    // Compass Scan
    this.gameState.on('onCompassScan', ({ area, count }) => {
      this.renderer.showCompassArea(area, count);
      this.audio.playCompass();
    });

    // Status (Win / Loss)
    this.gameState.on('onStatusChanged', ({ status }) => {
      if (status === GAME_STATUS.WON) {
        this.fx.burstVictory();
        this.audio.playVictory();
      }
    });
  }

  bindInputs() {
    // Prevent context menu for right clicks
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // Click handler for excavation / tools
    this.canvas.addEventListener('click', (e) => {
      this.audio.ensureContext();
      const coords = this.renderer.getGridCoordinatesUnderPointer(e.clientX, e.clientY);
      if (!coords) return;

      const { x, y } = coords;
      const tool = this.hud ? this.hud.activeTool : 'dig';

      if (tool === 'dig') {
        const cell = this.gameState.getCell(x, y);
        if (cell && cell.state === CELL_STATE.REVEALED) {
          // Chord check on revealed cell
          this.gameState.chord(x, y);
        } else {
          this.gameState.excavate(x, y);
        }
      } else if (tool === 'brush') {
        this.audio.playBrush();
        this.gameState.useBrush(x, y);
      } else if (tool === 'flag') {
        this.gameState.toggleFlag(x, y);
      } else if (tool === 'compass') {
        this.gameState.useCompass(x, y);
        this.hud.setActiveTool('dig'); // auto-reset to dig after survey
      }
    });

    // Right-click for instant flag toggle
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.audio.ensureContext();
      const coords = this.renderer.getGridCoordinatesUnderPointer(e.clientX, e.clientY);
      if (coords) {
        this.gameState.toggleFlag(coords.x, coords.y);
      }
    });

    // Touch support (tap to dig, long press to flag)
    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 1) {
          const touch = e.touches[0];
          this.touchStartTime = Date.now();
          this.touchStartPos = { x: touch.clientX, y: touch.clientY };

          const coords = this.renderer.getGridCoordinatesUnderPointer(touch.clientX, touch.clientY);
          if (coords) {
            this.longPressTimeout = setTimeout(() => {
              this.audio.ensureContext();
              this.gameState.toggleFlag(coords.x, coords.y);
              this.longPressTimeout = null;
            }, 450);
          }
        }
      },
      { passive: true },
    );

    this.canvas.addEventListener('touchend', (_e) => {
      if (this.longPressTimeout) {
        clearTimeout(this.longPressTimeout);
        this.longPressTimeout = null;
      }
    });

    this.canvas.addEventListener(
      'touchmove',
      () => {
        if (this.longPressTimeout) {
          clearTimeout(this.longPressTimeout);
          this.longPressTimeout = null;
        }
      },
      { passive: true },
    );

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      // ESC toggles between the main menu and the live run
      if (e.key === 'Escape') {
        const menuOpen = this.menuEl && this.menuEl.style.display !== 'none';
        if (menuOpen) {
          if (this.gameState?.paused) {
            this.resumeExpedition();
          }
        } else {
          this.returnToMenu();
        }
        return;
      }
      // P pauses / resumes the expedition
      if (e.key === 'p' || e.key === 'P') {
        const menuOpen = this.menuEl && this.menuEl.style.display !== 'none';
        if (!menuOpen) {
          this.setPaused(!this.gameState?.paused);
        }
        return;
      }
      if (this.gameState?.paused) return; // all other shortcuts ignore a paused run

      if (e.key === '1') this.hud?.setActiveTool('dig');
      if (e.key === '2' || e.key === 'f' || e.key === 'F') this.hud?.setActiveTool('flag');
      if (e.key === '3' || e.key === 'b' || e.key === 'B') {
        this.hud?.setActiveTool(this.hud.activeTool === 'brush' ? 'dig' : 'brush');
      }
      if (e.key === '4' || e.key === 'c' || e.key === 'C') this.hud?.setActiveTool('compass');
      if (e.key === '5' || e.key === 'm' || e.key === 'M') {
        this.handleHudAction({ type: 'use_map' });
      }
      if (e.key === 'r' || e.key === 'R') this.handleHudAction({ type: 'restart' });
      // Orbit the diorama
      if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowLeft') {
        this.renderer?.orbit(Math.PI / 12);
      }
      if (e.key === 'e' || e.key === 'E' || e.key === 'ArrowRight') {
        this.renderer?.orbit(-Math.PI / 12);
      }
    });
  }

  handleHudAction(action) {
    this.audio.ensureContext();

    switch (action.type) {
      case 'use_brush':
        this.audio.playBrush();
        this.gameState.useBrush();
        break;

      case 'use_map': {
        this.audio.playCompass();
        const marks = this.gameState.useMap();
        if (marks) {
          // Give each revealed dig site a small dust burst so the map
          // "marks" feel physical on the board
          for (const mark of marks) {
            const wp = this.renderer.gridToWorld(mark.x, mark.y);
            this.fx.burstCellSand(wp.x, wp.z, false);
          }
        }
        break;
      }

      case 'use_shield':
        if (this.gameState.shields > 0) {
          this.gameState.log('🛡️ Shield active. Will absorb next trap.', 'shield');
        } else {
          this.gameState.log('No shields remaining.', 'info');
        }
        break;

      case 'change_seed':
        this.startNewGame(this.currentDifficulty, action.seed);
        break;

      case 'change_difficulty':
        this.startNewGame(action.difficulty, this.currentSeed);
        break;

      case 'restart':
        this.startNewGame(this.currentDifficulty, this.currentSeed);
        break;

      case 'next_expedition': {
        const nextNum = Math.floor(Math.random() * 90000 + 10000);
        this.startNewGame(this.currentDifficulty, `expedition_${nextNum}`);
        break;
      }
    }
  }

  loop(time) {
    requestAnimationFrame((t) => this.loop(t));

    const dt = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;

    if (this.gameState && this.hud) {
      this.hud.updateTimer(this.gameState.elapsedTime);
    }

    if (this.fx) {
      this.fx.update(dt);
    }

    if (this.renderer) {
      this.renderer.render(time * 0.001);
    }
  }
}

// Boot game when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  new DunesweeperApp();
});
