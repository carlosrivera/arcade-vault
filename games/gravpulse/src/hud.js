// HUD: DOM readouts, center messages, minimap, telemetry, and results panel.
export class Hud {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      lapCur: document.getElementById('lap-cur'),
      posNum: document.getElementById('pos-num'),
      tTotal: document.getElementById('t-total'),
      tLap: document.getElementById('t-lap'),
      tBest: document.getElementById('t-best'),
      spd: document.getElementById('spd-num'),
      boostFill: document.getElementById('boost-fill'),
      fx: document.getElementById('fx'),
      msgText: document.getElementById('msg-text'),
      menu: document.getElementById('menu'),
      results: document.getElementById('results'),
      resTable: document.getElementById('res-table'),
      map: document.getElementById('map'),
      hint: document.getElementById('controls-hint'),
      toast: document.getElementById('toast'),
      weapon: document.getElementById('hud-weapon'),
      shield: document.getElementById('hud-shield'),
      menuSub: document.getElementById('menu-track-sub'),
      lapTotal: document.getElementById('lap-total'),
      lapCountDisplay: document.getElementById('lap-count-display'),
      brakeL: document.getElementById('hud-brake-l'),
      brakeR: document.getElementById('hud-brake-r'),
      camBadge: document.getElementById('hud-cam-badge'),
    };
    this.mapCtx = this.el.map.getContext('2d');
    this._mapPts = null;
    this._mapBounds = null;
    this._toastTimer = null;
  }

  setLapCount(laps) {
    if (this.el.lapCountDisplay) {
      this.el.lapCountDisplay.textContent = `${laps} ${laps === 1 ? 'LAP' : 'LAPS'}`;
    }
    if (this.el.lapTotal) {
      this.el.lapTotal.textContent = `/${laps}`;
    }
  }

  updateSelectedTrack(index, config) {
    if (this.el.menuSub && config) {
      this.el.menuSub.textContent = `// ${config.name} · ${config.difficulty} //`;
    }
    const cards = document.querySelectorAll('.track-card');
    cards.forEach((c) => {
      const idx = parseInt(c.getAttribute('data-track'), 10);
      c.classList.toggle('active', idx === index);
    });
  }

  setMinimapTrack(pts) {
    this._mapPts = pts;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const pad = 24;
    const w = this.el.map.width;
    const h = this.el.map.height;
    const sx = (w - pad * 2) / (maxX - minX);
    const sz = (h - pad * 2) / (maxZ - minZ);
    const sc = Math.min(sx, sz);
    const ox = (w - (maxX - minX) * sc) / 2;
    const oz = (h - (maxZ - minZ) * sc) / 2;
    this._mapBounds = { sc, ox, oz, minX, minZ };
    this._mapPath = pts.map((p) => ({
      x: (p.x - minX) * sc + ox,
      y: (p.z - minZ) * sc + oz,
    }));
  }

  _proj(x, z) {
    const b = this._mapBounds;
    return { x: (x - b.minX) * b.sc + b.ox, y: (z - b.minZ) * b.sc + b.oz };
  }

  drawMinimap(racers, _trackLength, _isMenu = false) {
    if (!this._mapPath || this._mapPath.length === 0) return;
    const g = this.mapCtx;
    const w = this.el.map.width;
    const h = this.el.map.height;
    g.clearRect(0, 0, w, h);

    // Outer glow for track
    g.strokeStyle = 'rgba(53,240,255,0.22)';
    g.lineWidth = 14;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(this._mapPath[0].x, this._mapPath[0].y);
    for (const p of this._mapPath) g.lineTo(p.x, p.y);
    g.closePath();
    g.stroke();

    // Main neon track line
    g.strokeStyle = 'rgba(53,240,255,0.85)';
    g.lineWidth = 7;
    g.stroke();

    // Inner dark racing lane
    g.strokeStyle = 'rgba(10,12,26,0.92)';
    g.lineWidth = 3;
    g.stroke();

    // Start line notch
    g.fillStyle = '#fff';
    g.shadowColor = '#35f0ff';
    g.shadowBlur = 8;
    const s0 = this._mapPath[0];
    g.fillRect(s0.x - 4, s0.y - 4, 8, 8);
    g.shadowBlur = 0;

    // Draw ships
    if (racers) {
      const drawOrder = [...racers].sort((a, b) => (a.isPlayer ? 1 : 0) - (b.isPlayer ? 1 : 0));
      for (const r of drawOrder) {
        const fr = r.lastFr;
        if (!fr?.pos) continue;
        const q = this._proj(fr.pos.x, fr.pos.z);
        g.beginPath();
        g.arc(q.x, q.y, r.isPlayer ? 8 : 5.5, 0, Math.PI * 2);
        g.fillStyle = r.scheme.body;
        g.shadowColor = r.scheme.body;
        g.shadowBlur = r.isPlayer ? 10 : 4;
        g.fill();
        if (r.isPlayer) {
          g.strokeStyle = '#fff';
          g.lineWidth = 2.5;
          g.stroke();
        }
        g.shadowBlur = 0;
      }
    }
  }

  setAirbrakes(left, right) {
    if (this.el.brakeL) {
      this.el.brakeL.classList.toggle('active', left > 0.1);
    }
    if (this.el.brakeR) {
      this.el.brakeR.classList.toggle('active', right > 0.1);
    }
  }

  setCameraMode(modeName) {
    if (this.el.camBadge) {
      this.el.camBadge.textContent = `CAM: ${modeName} [C]`;
    }
  }

  setCombat(weapon, shieldTime) {
    if (weapon) {
      this.el.weapon.textContent = weapon === 'rocket' ? '◆ ROCKET — SPACE' : '◆ MINE — SPACE';
      this.el.weapon.style.color = weapon === 'rocket' ? 'var(--amber)' : '#ff7ae0';
      this.el.weapon.style.opacity = 1;
    } else {
      this.el.weapon.style.opacity = 0;
    }
    if (shieldTime > 0) {
      this.el.shield.textContent = `◈ SHIELD ${Math.ceil(shieldTime)}s`;
      this.el.shield.style.opacity = 1;
    } else {
      this.el.shield.style.opacity = 0;
    }
  }

  showHud(on) {
    this.el.hud.style.display = on ? 'block' : 'none';
  }
  showMenu(on) {
    this.el.menu.style.display = on ? 'flex' : 'none';
  }
  showResults(on) {
    this.el.results.style.display = on ? 'flex' : 'none';
  }

  reset(totalLaps = 3) {
    this.showHud(false);
    this.showResults(false);
    this.setCombat(null, 0);
    this.setAirbrakes(0, 0);
    this.setStatus(1, 4, 0, 0, Infinity, 0, 0, totalLaps);
    if (this.el.msgText) {
      this.el.msgText.textContent = '';
      this.el.msgText.classList.remove('pop');
    }
    if (this.el.fx) {
      this.el.fx.classList.remove('boost');
    }
    if (this.el.hint) {
      this.el.hint.style.opacity = 1;
    }
  }

  setStatus(lap, pos, totalT, lapT, bestT, speed, boostNorm, totalLaps = 3) {
    this.el.lapCur.textContent = Math.max(1, Math.min(totalLaps, lap));
    if (this.el.lapTotal) this.el.lapTotal.textContent = `/${totalLaps}`;
    this.el.posNum.textContent = pos;
    this.el.tTotal.textContent = fmt(totalT);
    this.el.tLap.textContent = fmt(lapT);
    this.el.tBest.textContent = bestT === Infinity ? '--:--.---' : fmt(bestT);
    this.el.spd.textContent = Math.round(speed * 1.15);
    this.el.boostFill.style.width = `${Math.min(100, boostNorm * 100)}%`;
  }

  message(text, color = '') {
    const m = this.el.msgText;
    m.textContent = text;
    m.style.color = color || 'var(--cyan)';
    m.classList.remove('pop');
    void m.offsetWidth;
    m.classList.add('pop');
  }

  flashBoost() {
    this.el.fx.classList.add('boost');
    clearTimeout(this._fxTimer);
    this._fxTimer = setTimeout(() => this.el.fx.classList.remove('boost'), 900);
  }

  toast(text) {
    this.el.toast.textContent = text;
    this.el.toast.style.opacity = 1;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.el.toast.style.opacity = 0;
    }, 1400);
  }

  fadeHint() {
    this.el.hint.style.opacity = 0;
  }

  results(rows) {
    let html = '';
    rows.forEach((r, i) => {
      html +=
        `<tr${r.me ? ' class="me"' : ''}><td>P${i + 1}</td><td>${r.name}</td>` +
        `<td class="num">${r.best === Infinity ? '--:--.---' : fmt(r.best)}</td>` +
        `<td class="num">${fmt(r.total)}</td></tr>`;
    });
    this.el.resTable.innerHTML = html;
  }
}

function fmt(t) {
  if (!Number.isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
