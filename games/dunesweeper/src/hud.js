/**
 * DUNESWEEPER - Tactical Archaeologist HUD & Minimap
 * Matching the layout, avatar, tools, objectives, logs, hotbar, and radar minimap
 */

import { CELL_STATE, GAME_STATUS } from './game_state.js';
import { pixIcon } from './pixel_sprites.js';

export class HUD {
  constructor(gameState, audioManager, onAction) {
    this.gameState = gameState;
    this.audioManager = audioManager;
    this.onAction = onAction;

    this.activeTool = 'dig'; // 'dig' | 'brush' | 'flag' | 'compass'

    // DOM References
    this.elLevelTitle = document.getElementById('level-title');
    this.elLives = document.getElementById('hud-lives-icons');
    this.elTimer = document.getElementById('hud-timer-text');
    this.elRelicsText = document.getElementById('obj-relics-text');
    this.elExitText = document.getElementById('obj-exit-text');
    this.elLogBox = document.getElementById('log-entries');
    this.minimapCanvas = document.getElementById('minimap-canvas');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;

    // Counts in tools sidebar
    this.elCountBrush = document.getElementById('count-pala');
    this.elCountFlag = document.getElementById('count-flag');
    this.elCountShield = document.getElementById('count-shield');
    this.elCountCompass = document.getElementById('count-compass');
    this.elCountMap = document.getElementById('count-map');

    // Hotbar buttons
    this.hotbarSlots = {
      dig: document.getElementById('hotbar-dig'),
      brush: document.getElementById('hotbar-brush'),
      flag: document.getElementById('hotbar-flag'),
      shield: document.getElementById('hotbar-shield'),
      compass: document.getElementById('hotbar-compass'),
    };

    // Modals
    this.modalContainer = document.getElementById('game-modal');
    this.modalTitle = document.getElementById('modal-title');
    this.modalBody = document.getElementById('modal-body');
    this.modalBtnRestart = document.getElementById('modal-btn-restart');
    this.modalBtnNext = document.getElementById('modal-btn-next');

    this.initEventListeners();
    this.bindGameState();
    this.updateAll();
    this.drawMinimap();
  }

  setGameState(newGameState) {
    this.gameState = newGameState;
    this.bindGameState();
    this.updateAll();
    this.drawMinimap();
  }

  bindGameState() {
    this.gameState.on('onLivesChanged', () => this.updateLives());
    this.gameState.on('onCellFlagged', () => {
      this.updateTools();
      this.drawMinimap();
    });
    this.gameState.on('onCellRevealed', () => {
      this.updateObjectives();
      this.drawMinimap();
    });
    this.gameState.on('onRelicFound', () => this.updateObjectives());
    this.gameState.on('onExitUnlocked', () => this.updateObjectives());
    this.gameState.on('onToolsChanged', () => this.updateTools());
    this.gameState.on('onStatusChanged', (e) => this.handleStatusChange(e.status));
    this.gameState.on('onLogMessage', ({ message, type }) => this.addLogEntry(message, type));
  }

  initEventListeners() {
    // Hotbar tool switching
    this.hotbarSlots.dig?.addEventListener('click', () => this.setActiveTool('dig'));
    this.hotbarSlots.brush?.addEventListener('click', () => this.setActiveTool('brush'));
    this.hotbarSlots.flag?.addEventListener('click', () => this.setActiveTool('flag'));
    this.hotbarSlots.shield?.addEventListener('click', () => {
      this.onAction({ type: 'use_shield' });
    });
    this.hotbarSlots.compass?.addEventListener('click', () => {
      this.setActiveTool(this.activeTool === 'compass' ? 'dig' : 'compass');
    });

    // Sidebar tool clicks
    document.getElementById('tool-dig-row')?.addEventListener('click', () => {
      this.setActiveTool('dig');
    });
    document.getElementById('tool-pala-row')?.addEventListener('click', () => {
      this.setActiveTool('brush');
    });
    document
      .getElementById('tool-flag-row')
      ?.addEventListener('click', () => this.setActiveTool('flag'));
    document.getElementById('tool-shield-row')?.addEventListener('click', () => {
      this.onAction({ type: 'use_shield' });
    });
    document.getElementById('tool-compass-row')?.addEventListener('click', () => {
      this.setActiveTool(this.activeTool === 'compass' ? 'dig' : 'compass');
    });
    document.getElementById('tool-map-row')?.addEventListener('click', () => {
      this.onAction({ type: 'use_map' });
    });

    // Settings button -> trigger settings / difficulty dialog
    document.getElementById('btn-settings')?.addEventListener('click', () => {
      const newSeed = prompt('Expedición / Semilla:', this.gameState.seed);
      if (newSeed && newSeed.trim() !== '') {
        this.onAction({ type: 'change_seed', seed: newSeed.trim() });
      }
    });

    // Modal buttons
    this.modalBtnRestart?.addEventListener('click', () => {
      this.hideModal();
      this.onAction({ type: 'restart' });
    });

    this.modalBtnNext?.addEventListener('click', () => {
      this.hideModal();
      this.onAction({ type: 'next_expedition' });
    });
  }

  setActiveTool(tool) {
    this.activeTool = tool;
    for (const key in this.hotbarSlots) {
      if (this.hotbarSlots[key]) {
        this.hotbarSlots[key].classList.toggle('active', key === tool);
      }
    }
  }

  updateAll() {
    if (this.elLevelTitle) {
      this.elLevelTitle.textContent = this.gameState.levelName || 'KHEPRI RUINS';
    }
    this.updateLives();
    this.updateTools();
    this.updateObjectives();
  }

  updateLives() {
    if (!this.elLives) return;
    let heartsHtml = '';
    for (let i = 0; i < this.gameState.maxLives; i++) {
      const name = i < this.gameState.lives ? 'heart' : 'heartEmpty';
      heartsHtml += pixIcon(name, 15);
    }
    this.elLives.innerHTML = heartsHtml;
  }

  updateTools() {
    if (this.elCountBrush) this.elCountBrush.textContent = this.gameState.brushes;
    if (this.elCountFlag) this.elCountFlag.textContent = '∞';
    if (this.elCountShield) this.elCountShield.textContent = this.gameState.shields;
    if (this.elCountCompass) this.elCountCompass.textContent = this.gameState.compasses;
    if (this.elCountMap) this.elCountMap.textContent = this.gameState.maps ?? 0;
  }

  updateObjectives() {
    if (this.elRelicsText) {
      this.elRelicsText.innerHTML = `${pixIcon('relic', 14)} Relics: ${this.gameState.relicsFound}/${this.gameState.targetRelics}`;
      this.elRelicsText.style.display = 'flex';
      this.elRelicsText.style.alignItems = 'center';
      this.elRelicsText.style.gap = '6px';
    }
    if (this.elExitText) {
      const unlocked = this.gameState.exitUnlocked;
      this.elExitText.innerHTML = unlocked
        ? `${pixIcon('temple', 14)} Exit: Unlocked`
        : `Exit: Not Found`;
      this.elExitText.style.display = unlocked ? 'flex' : 'block';
      this.elExitText.style.alignItems = 'center';
      this.elExitText.style.gap = '6px';
      this.elExitText.style.color = unlocked ? '#4ade80' : '#a8a29e';
    }
  }

  updateTimer(seconds) {
    if (!this.elTimer) return;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    this.elTimer.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  addLogEntry(message, type = 'info') {
    if (!this.elLogBox) return;

    let icon = 'scroll';
    if (type === 'flag') icon = 'flag';
    if (type === 'relic') icon = 'gem';
    if (type === 'trap') icon = 'skull';
    if (type === 'shield') icon = 'shield';
    if (type === 'exit') icon = 'temple';
    if (type === 'victory') icon = 'trophy';

    const entry = document.createElement('div');
    entry.className = 'log-item';
    entry.innerHTML = `<span class="log-icon pix">${pixIcon(icon, 14)}</span> <span>${message}</span>`;

    this.elLogBox.prepend(entry);
    // Keep max 4 recent entries
    while (this.elLogBox.children.length > 4) {
      this.elLogBox.removeChild(this.elLogBox.lastChild);
    }
  }

  /**
   * Draw tactical 2D Minimap Radar
   */
  drawMinimap() {
    if (!this.minimapCanvas || !this.minimapCtx) return;
    const ctx = this.minimapCtx;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;

    ctx.fillStyle = '#1c1917';
    ctx.fillRect(0, 0, w, h);

    const gw = this.gameState.width;
    const gh = this.gameState.height;
    const cellW = (w - 16) / gw;
    const cellH = (h - 16) / gh;

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const cell = this.gameState.grid[y][x];
        const px = 8 + x * cellW;
        const py = 8 + y * cellH;

        if (cell.state === CELL_STATE.REVEALED) {
          ctx.fillStyle = cell.isSunkenChamber ? '#78350f' : '#d6c4a5';
        } else if (cell.state === CELL_STATE.FLAGGED) {
          ctx.fillStyle = '#ef4444';
        } else {
          ctx.fillStyle = '#ca8a04';
        }

        ctx.fillRect(px + 1, py + 1, cellW - 2, cellH - 2);
      }
    }

    // Draw central explorer indicator
    const cx = w / 2;
    const cy = h / 2;
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(cx - 3, cy - 3, 6, 6);
  }

  handleStatusChange(status) {
    if (status === GAME_STATUS.WON) {
      this.showVictoryModal();
    } else if (status === GAME_STATUS.LOST) {
      this.showDefeatModal();
    }
  }

  showVictoryModal() {
    if (!this.modalContainer) return;
    const timeStr = this.elTimer ? this.elTimer.textContent : '00:00';

    this.modalTitle.textContent = 'EXPEDITION COMPLETE!';
    this.modalTitle.style.color = '#facc15';
    this.modalBody.innerHTML = `
      <p style="margin-bottom:12px; font-size:16px;">You unearthed the ruins and reached the exit successfully!</p>
      <div style="background:rgba(255,255,255,0.06); padding:14px 16px; margin:16px 0; text-align:left; font-size:14px; line-height:1.9;">
        <div class="modal-stat-row">${pixIcon('temple', 16)} <b>Site:</b>&nbsp;${this.gameState.levelName}</div>
        <div class="modal-stat-row">${pixIcon('relic', 16)} <b>Relics:</b>&nbsp;${this.gameState.relicsFound}/${this.gameState.targetRelics}</div>
        <div class="modal-stat-row">${pixIcon('timer', 16)} <b>Time:</b>&nbsp;${timeStr}</div>
        <div class="modal-stat-row">${pixIcon('scroll', 16)} <b>Seed:</b>&nbsp;<code>${this.gameState.seed}</code></div>
      </div>
    `;

    if (this.modalBtnNext) this.modalBtnNext.style.display = 'inline-block';
    this.modalContainer.style.display = 'flex';
  }

  showDefeatModal() {
    if (!this.modalContainer) return;

    this.modalTitle.textContent = 'EXPEDITION FAILED';
    this.modalTitle.style.color = '#ef4444';
    this.modalBody.innerHTML = `
      <p style="margin-bottom:10px; font-size:16px; display:flex; justify-content:center;">
        ${pixIcon('skull', 32)}
      </p>
      <p style="margin-bottom:10px; font-size:15px;">The ancient traps have overcome your defenses.</p>
      <p style="font-size:13px; color:#a8a29e; margin-top:8px;">Use the Compass and Shields to secure your path.</p>
    `;

    if (this.modalBtnNext) this.modalBtnNext.style.display = 'none';
    this.modalContainer.style.display = 'flex';
  }

  hideModal() {
    if (this.modalContainer) {
      this.modalContainer.style.display = 'none';
    }
  }
}
