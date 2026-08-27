/**
 * Shared Arcade Eject Navigation
 * Automatically injects a retro floating "EJECT ⏏" button in any game
 * to return to the Arcade Vault Gallery.
 *
 * Shows when on the Main Menu / Start Screen, and hides during gameplay.
 */

(function initArcadeEject() {
  if (document.getElementById('arcade-eject-btn')) return;

  const style = document.createElement('style');
  style.id = 'arcade-eject-style';
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');

    .arcade-eject-container {
      position: fixed;
      top: 16px;
      left: 16px;
      z-index: 10000;
      font-family: 'Press Start 2P', monospace, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      transition: opacity 0.25s ease-out, transform 0.25s ease-out;
      opacity: 1;
      pointer-events: auto;
    }

    .arcade-eject-container.hidden {
      opacity: 0;
      pointer-events: none;
      transform: translateY(-8px);
    }

    .arcade-eject-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #0f1224;
      color: #8da2d8;
      text-decoration: none;
      padding: 8px 12px;
      font-size: 10px;
      letter-spacing: 1px;
      border: 3px solid #000000;
      box-shadow: 
        inset 2px 2px 0px #384270, 
        inset -2px -2px 0px #060812, 
        4px 4px 0px #000000;
      transition: all 0.12s ease-out;
      cursor: pointer;
    }

    .arcade-eject-btn:hover {
      background: #1c2242;
      color: #ff3344;
      border-color: #000000;
      transform: translate(-1px, -1px);
      box-shadow: 
        inset 2px 2px 0px #4f5d9c, 
        inset -2px -2px 0px #060812, 
        6px 6px 0px #000000;
    }

    .arcade-eject-btn:active {
      transform: translate(2px, 2px);
      box-shadow: 
        inset 2px 2px 0px #060812, 
        inset -2px -2px 0px #384270, 
        2px 2px 0px #000000;
    }

    .arcade-eject-icon {
      font-size: 13px;
      color: #ffcc00;
      display: inline-block;
      transition: transform 0.15s ease;
    }

    .arcade-eject-btn:hover .arcade-eject-icon {
      color: #ff3344;
      transform: translateY(-2px);
    }

    .arcade-eject-label {
      font-size: 9px;
      letter-spacing: 1px;
    }

    @media (max-width: 600px) {
      .arcade-eject-container {
        top: 10px;
        left: 10px;
      }
      .arcade-eject-btn {
        padding: 6px 8px;
      }
      .arcade-eject-label {
        display: none;
      }
    }
  `;
  document.head.appendChild(style);

  // Determine home path relative to current URL
  const isSubfolder = window.location.pathname.includes('/games/');
  const homeHref = isSubfolder ? '../../index.html' : './index.html';

  const container = document.createElement('div');
  container.className = 'arcade-eject-container';
  container.innerHTML = `
    <a href="${homeHref}" class="arcade-eject-btn" id="arcade-eject-btn" title="Eject Cartridge (Return to Arcade Vault)">
      <span class="arcade-eject-icon">⏏</span>
      <span class="arcade-eject-label">EJECT</span>
    </a>
  `;

  // API to control visibility
  function setVisible(visible) {
    if (visible) {
      container.classList.remove('hidden');
    } else {
      container.classList.add('hidden');
    }
  }

  window.arcadeNav = {
    show: () => setVisible(true),
    hide: () => setVisible(false),
    setVisible,
  };

  // Automatically watch for standard #menu or .game-menu element
  function setupAutoObserver() {
    const menuEl = document.getElementById('menu') || document.querySelector('.game-menu');
    if (!menuEl) return;

    const checkVisibility = () => {
      const isVisible = window.getComputedStyle(menuEl).display !== 'none';
      setVisible(isVisible);
    };

    checkVisibility();

    const observer = new MutationObserver(() => {
      checkVisibility();
    });

    observer.observe(menuEl, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  // 8-bit mechanical clank sound on click
  function playEjectSound() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const t = ctx.currentTime;

      // Mechanical clank
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(280, t);
      osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);

      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    } catch (_e) {}
  }

  const btn = container.querySelector('#arcade-eject-btn');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    playEjectSound();
    setTimeout(() => {
      window.location.href = homeHref;
    }, 150);
  });

  if (document.body) {
    document.body.appendChild(container);
    setupAutoObserver();
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      document.body.appendChild(container);
      setupAutoObserver();
    });
  }
})();
