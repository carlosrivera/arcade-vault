// hud.js — fighter HUD rendered on a 2D canvas overlaying the WebGL view.
//
// Elements: pitch ladder (artificial horizon) with roll, heading tape,
// airspeed/altitude tapes, flight-path marker, G / AoA / Mach readouts,
// throttle bar, radar, target designator boxes with range + closure,
// missile lock reticle, and master-mode warnings (STALL / PULL UP / MISSILE).

import * as THREE from 'three';
import { RADAR_CHART } from './radarChartMeta.js';

const GREEN = 'rgba(120, 255, 170, 0.92)';
const GREEN_DIM = 'rgba(120, 255, 170, 0.5)';
const AMBER = 'rgba(255, 186, 80, 0.95)';
const RED = 'rgba(255, 72, 84, 0.95)';

const fontStack = '"Courier New", ui-monospace, monospace';

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.lockProgress = 0;
    this.time = 0;
    // Precomputed elevation chart (see tools/bake_radar.js). Loaded async; the
    // radar falls back to the plain scope until it arrives.
    this.radarChart = new Image();
    this.radarChart.src = RADAR_CHART.file;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.w = w; this.h = h;
  }

  // ---------------------------------------------------------------- helpers
  text(s, x, y, size, color, align = 'left', bold = true) {
    const ctx = this.ctx;
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${fontStack}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }

  line(x1, y1, x2, y2, color = GREEN, width = 1.5) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  rect(x, y, w, h, color = GREEN, width = 1.5) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.strokeRect(x, y, w, h);
  }

  // ---------------------------------------------------------------- main draw
  draw(dt, fm, world, warnings) {
    const ctx = this.ctx;
    this.time += dt;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 3;

    const cx = this.w / 2, cy = this.h / 2;

    this.drawPitchLadder(fm, cx, cy);
    this.drawHeadingTape(fm, cx);
    this.drawSpeedTape(fm, cx, cy);
    this.drawAltTape(fm, cx, cy);
    this.drawFpm(fm, cx, cy);
    this.drawGunCross(cx, cy);
    this.drawStatusBlock(fm);
    this.drawRadar(world, fm);
    this.drawTargets(world, fm);
    this.drawWarnings(warnings, cx);
    ctx.shadowBlur = 0;
  }

  // ---------------------------------------------------------------- ladder
  drawPitchLadder(fm, cx, cy) {
    const ctx = this.ctx;
    const pitch = THREE.MathUtils.degToRad(fm.pitchDeg());
    const roll = THREE.MathUtils.degToRad(fm.rollDeg());

    // pixels per degree of pitch — compress so 90° fits
    const ppd = this.h / 120;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-roll);
    ctx.translate(0, pitch * ppd);

    const lw = Math.min(this.w * 0.09, 100);   // half-length of ladder rungs
    const gap = 26;                            // center gap half-width

    // horizon line
    this.line(-lw - 40, 0, -gap, 0, GREEN, 2);
    this.line(gap, 0, lw + 40, 0, GREEN, 2);

    for (let d = -90; d <= 90; d += 5) {
      if (d === 0) continue;
      const y = -d * ppd;
      if (Math.abs(y) > this.h * 0.62) continue;
      const major = d % 10 === 0;
      const half = major ? lw : lw * 0.55;
      const isNeg = d < 0;
      // negative rungs are dashed
      ctx.setLineDash(isNeg ? [10, 8] : []);
      if (major) {
        this.line(-half - gap, y, -gap, y, GREEN_DIM, 1.5);
        this.line(gap, y, half + gap, y, GREEN_DIM, 1.5);
        // end ticks point toward horizon
        const tick = d > 0 ? 10 : -10;
        this.line(-half - gap, y, -half - gap, y + tick, GREEN_DIM, 1.5);
        this.line(half + gap, y, half + gap, y + tick, GREEN_DIM, 1.5);
        this.text(Math.abs(d), -half - gap - 8, y, 13, GREEN_DIM, 'right');
        this.text(Math.abs(d), half + gap + 8, y, 13, GREEN_DIM, 'left');
      } else {
        this.line(-gap - half * 0.5, y, -gap, y, GREEN_DIM, 1);
        this.line(gap, y, gap + half * 0.5, y, GREEN_DIM, 1);
      }
      ctx.setLineDash([]);
    }
    ctx.restore();

    // aircraft datum (fixed)
    this.line(cx - 42, cy, cx - 15, cy, GREEN, 2.5);
    this.line(cx + 15, cy, cx + 42, cy, GREEN, 2.5);
    this.line(cx - 42, cy, cx - 34, cy + 8, GREEN, 2.5);
    this.line(cx + 42, cy, cx + 34, cy + 8, GREEN, 2.5);
  }

  // ---------------------------------------------------------------- heading
  drawHeadingTape(fm, cx) {
    const ctx = this.ctx;
    const y = 34;
    const hdg = fm.headingDeg();
    const pxPerDeg = 6.5;
    const halfSpan = Math.min(this.w * 0.24, 320);
    const spanDeg = halfSpan / pxPerDeg;

    // tape line
    this.line(cx - halfSpan, y, cx + halfSpan, y, GREEN_DIM, 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - halfSpan, 0, halfSpan * 2, 58);
    ctx.clip();

    for (let d = Math.ceil(hdg - spanDeg); d <= hdg + spanDeg; d++) {
      const dd = ((d % 360) + 360) % 360;
      const x = cx + (d - hdg) * pxPerDeg;
      const major10 = dd % 10 === 0;
      if (major10) {
        this.line(x, y, x, y - 12, GREEN_DIM, 1.5);
        const label = dd % 30 === 0
          ? { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[dd] || (dd / 10).toString().padStart(2, '0')
          : null;
        if (label) this.text(label, x, y - 24, 14, GREEN, 'center');
      } else if (dd % 5 === 0) {
        this.line(x, y, x, y - 6, GREEN_DIM, 1);
      }
    }
    ctx.restore();

    // caret + digital readout
    this.line(cx, y + 3, cx - 7, y + 12, GREEN, 2);
    this.line(cx, y + 3, cx + 7, y + 12, GREEN, 2);
    this.boxText(Math.round(hdg).toString().padStart(3, '0'), cx, y + 26, GREEN);
  }

  boxText(s, x, y, color) {
    const ctx = this.ctx;
    ctx.font = `bold 17px ${fontStack}`;
    const w = ctx.measureText(s).width + 16;
    this.rect(x - w / 2, y - 13, w, 26, color, 1.5);
    this.text(s, x, y, 16, color, 'center');
  }

  // ---------------------------------------------------------------- tapes
  drawSpeedTape(fm, cx, cy) {
    const ctx = this.ctx;
    const x = cx - Math.min(this.w * 0.36, 470);
    const H = 300;
    const top = cy - H / 2;
    // knots for flavor (m/s * 1.94)
    const knots = fm.speed * 1.944;
    const pxPerKt = 1.15;

    this.line(x, top, x, top + H, GREEN_DIM, 1.5);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 130, top, 130, H);
    ctx.clip();
    const lo = knots - H / 2 / pxPerKt, hi = knots + H / 2 / pxPerKt;
    for (let k = Math.ceil(lo / 50) * 50; k <= hi; k += 50) {
      const y = cy - (k - knots) * pxPerKt;
      this.line(x - 12, y, x, y, GREEN_DIM, 1.5);
      this.text(k, x - 18, y, 14, GREEN_DIM, 'right');
    }
    for (let k = Math.ceil(lo / 10) * 10; k <= hi; k += 10) {
      if (k % 50 === 0) continue;
      const y = cy - (k - knots) * pxPerKt;
      this.line(x - 6, y, x, y, GREEN_DIM, 1);
    }
    ctx.restore();

    // current value box
    this.boxText(Math.round(knots).toString(), x - 62, cy, GREEN);
    this.text('KIAS', x - 62, cy + 24, 12, GREEN_DIM, 'center');
    this.text(`M ${fm.mach.toFixed(2)}`, x - 62, cy - 62, 14, GREEN, 'center');
    this.text(`G ${fm.gLoad >= 0 ? '+' : ''}${fm.gLoad.toFixed(1)}`, x - 62, cy - 84, 14,
      Math.abs(fm.gLoad) > 7.5 ? AMBER : GREEN, 'center');
    this.text(`AOA ${(THREE.MathUtils.radToDeg(fm.aoa)).toFixed(0)}°`, x - 62, cy + 46, 12,
      Math.abs(THREE.MathUtils.radToDeg(fm.aoa)) > 20 ? RED : GREEN_DIM, 'center');
  }

  drawAltTape(fm, cx, cy) {
    const ctx = this.ctx;
    const x = cx + Math.min(this.w * 0.36, 470);
    const H = 300;
    const top = cy - H / 2;
    const alt = Math.max(fm.altitude, 0);
    const pxPerFt = 0.06;   // feet, compressed
    const feet = alt * 3.281;

    this.line(x, top, x, top + H, GREEN_DIM, 1.5);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, top, 130, H);
    ctx.clip();
    const step = 1000;
    const lo = feet - H / 2 / pxPerFt, hi = feet + H / 2 / pxPerFt;
    for (let k = Math.ceil(lo / step) * step; k <= hi; k += step) {
      const y = cy - (k - feet) * pxPerFt;
      if (y < top || y > top + H) continue;
      this.line(x, y, x + 12, y, GREEN_DIM, 1.5);
      this.text(k, x + 18, y, 14, GREEN_DIM, 'left');
    }
    ctx.restore();

    this.boxText(Math.round(feet).toLocaleString('en-US'), x + 62, cy, GREEN);
    this.text('ALT FT', x + 62, cy + 24, 12, GREEN_DIM, 'center');
    // radar altitude (AGL) — caller supplies terrain height via fm._agl
    if (fm._agl !== undefined) {
      this.text(`R ${Math.max(0, Math.round(fm._agl * 3.281)).toLocaleString('en-US')}`,
        x + 62, cy + 46, 12, fm._agl < 250 ? RED : GREEN_DIM, 'center');
    }
  }

  // ---------------------------------------------------------------- markers
  drawFpm(fm, cx, cy) {
    const ctx = this.ctx;
    // flight path marker: where the velocity vector points, in screen space
    if (this._fpmScreen) {
      const { x, y } = this._fpmScreen;
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.moveTo(x - 18, y); ctx.lineTo(x - 10, y);
      ctx.moveTo(x + 10, y); ctx.lineTo(x + 18, y);
      ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 16);
      ctx.stroke();
    }
  }

  drawGunCross(cx, cy) {
    const ctx = this.ctx;
    const x = cx, y = cy - 8;
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.moveTo(x - 44, y); ctx.lineTo(x - 10, y);
    ctx.moveTo(x + 10, y); ctx.lineTo(x + 44, y);
    ctx.stroke();
  }

  drawStatusBlock(fm) {
    const ctx = this.ctx;
    const x = this.w - 30, y = this.h - 130;
    // throttle
    this.text('THR', x - 108, y, 12, GREEN_DIM, 'right');
    this.rect(x - 100, y - 6, 104, 14, GREEN_DIM, 1);
    const thr = fm.controls.throttle;
    ctx.fillStyle = fm.controls.afterburner ? AMBER : GREEN;
    ctx.fillRect(x - 98, y - 4, 100 * thr, 10);
    if (fm.controls.afterburner) this.text('AB', x - 108, y + 22, 14, AMBER, 'right');

    this.text(`GUN ${fm.gunAmmo}`, x, y + 46, 15, fm.gunAmmo > 0 ? GREEN : GREEN_DIM, 'right');
    this.text(`MSL ${fm.missileCount}`, x, y + 68, 15, fm.missileCount > 0 ? GREEN : GREEN_DIM, 'right');
    this.text(`KILL ${world_kills()}`, x, y + 92, 13, GREEN_DIM, 'right');
    this.text(`HULL ${Math.max(0, Math.round(fm.hull))}%`, x, y + 114, 13,
      fm.hull < 35 ? RED : GREEN_DIM, 'right');
  }

  // ---------------------------------------------------------------- radar
  drawRadar(world, fm) {
    const ctx = this.ctx;
    const x = 44, y = this.h - 44, R = 74;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(4, 14, 8, 0.55)';
    ctx.fillRect(x - R, y - R, R * 2, R * 2);
    ctx.restore();

    ctx.strokeStyle = GREEN_DIM;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, R / 2, 0, Math.PI * 2); ctx.stroke();

    const hdg = THREE.MathUtils.degToRad(fm.headingDeg());
    const range = 12000;

    // heading-up terrain chart. headingDeg() is a compass heading (0 = north
    // = -z, clockwise positive), so the world->radar rotation is
    //   rx = dx*cos(h) + dz*sin(h),  ry = dx*sin(h) - dz*cos(h)
    // applied here to the chart and to the blips below — terrain and contacts
    // can never disagree about where "ahead" is.
    if (this.radarChart.complete && this.radarChart.naturalWidth > 0) {
      const m = RADAR_CHART;
      const half = (m.size * m.mpp) / 2;
      const k = R / range;
      const s = Math.sin(hdg), c = Math.cos(hdg);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, R - 1, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(x, y);
      ctx.transform(k * c, -k * s, k * s, k * c, 0, 0);
      ctx.translate(-fm.position.x, -fm.position.z);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.radarChart,
        m.centerX - half, m.centerZ - half, m.size * m.mpp, m.size * m.mpp);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    const blip = (wx, wz, color, size = 3) => {
      const dx = wx - fm.position.x, dz = wz - fm.position.z;
      // compass heading-up frame (0 = north = -z, clockwise) — same mapping
      // as the terrain chart above
      const s = Math.sin(hdg), c = Math.cos(hdg);
      const rx = dx * c + dz * s;
      const ry = dx * s - dz * c;
      const px = x + (rx / range) * R;
      const py = y - (ry / range) * R;
      ctx.fillStyle = color;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
      return { px, py };
    };

    for (const e of world.enemies) {
      if (!e.alive) continue;
      blip(e.fm.position.x, e.fm.position.z, e === world.target ? AMBER : RED, e === world.target ? 6 : 4);
    }
    for (const m of world.enemyMissiles) {
      blip(m.pos.x, m.pos.z, RED, 3);
    }
    // player
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(x, y - 6); ctx.lineTo(x - 4, y + 4); ctx.lineTo(x + 4, y + 4);
    ctx.closePath(); ctx.fill();
    // FOV cone
    ctx.strokeStyle = GREEN_DIM;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x - R * Math.sin(Math.PI / 4), y - R * Math.cos(Math.PI / 4));
    ctx.moveTo(x, y); ctx.lineTo(x + R * Math.sin(Math.PI / 4), y - R * Math.cos(Math.PI / 4));
    ctx.stroke();
    this.text('RADAR 12KM', x, y + R + 14, 10, GREEN_DIM, 'center');
  }

  // ---------------------------------------------------------------- targets
  drawTargets(world, fm) {
    const ctx = this.ctx;
    for (const e of world.enemies) {
      if (!e.alive) continue;
      const p = this._project(e.fm.position);
      if (!p) continue;
      const isSel = e === world.target;
      const dist = e.fm.position.distanceTo(fm.position);
      const boxSize = THREE.MathUtils.clamp(2600 / dist, 16, 56);

      const color = isSel ? AMBER : RED;
      // corner-box designator
      const x = p.x, y = p.y, s = boxSize, c = s * 0.38;
      this.line(x - s, y - s + c, x - s, y - s, color, 2);
      this.line(x - s, y - s, x - s + c, y - s, color, 2);
      this.line(x + s - c, y - s, x + s, y - s, color, 2);
      this.line(x + s, y - s, x + s, y - s + c, color, 2);
      this.line(x + s, y + s - c, x + s, y + s, color, 2);
      this.line(x + s, y + s, x + s - c, y + s, color, 2);
      this.line(x - s + c, y + s, x - s, y + s, color, 2);
      this.line(x - s, y + s, x - s, y + s - c, color, 2);

      if (isSel) {
        const closure = fm.velocity.clone().sub(e.fm.velocity)
          .dot(e.fm.position.clone().sub(fm.position).normalize());
        this.text(`${(dist / 1000).toFixed(1)}KM`, x + s + 10, y - s + 8, 13, AMBER);
        this.text(`${closure > 0 ? '+' : ''}${Math.round(closure * 1.944)}KT`, x + s + 10, y - s + 26, 12, AMBER);
        this.text('BANDIT', x - s - 10, y - s + 8, 12, AMBER, 'right');

        // lock ring
        if (world.lockState === 'locking') {
          const t = world.lockProgress;
          ctx.strokeStyle = AMBER;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.arc(x, y, s + 22, 0, Math.PI * 2 * Math.max(0.05, t));
          ctx.stroke();
          ctx.setLineDash([]);
          this.text('LOCKING', x, y + s + 26, 12, AMBER, 'center');
        } else if (world.lockState === 'locked') {
          const pulse = 1 + Math.sin(this.time * 8) * 0.08;
          ctx.strokeStyle = RED;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(x, y, (s + 18) * pulse, 0, Math.PI * 2);
          ctx.stroke();
          this.text('SHOOT', x, y + s + 26, 13, RED, 'center');

          // lead indicator for cannon
          const tof = dist / 1000; // rough time of flight
          const aim = e.fm.position.clone()
            .addScaledVector(e.fm.velocity, tof)
            .add(new THREE.Vector3(0, -0.5 * 9.81 * tof * tof, 0));
          const lp = this._project(aim);
          if (lp) {
            ctx.strokeStyle = GREEN;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(lp.x, lp.y, 5, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }

    // incoming missile carets
    for (const m of world.enemyMissiles) {
      const p = this._project(m.pos);
      if (!p) continue;
      const t = Math.sin(this.time * 14) > 0;
      if (!t) continue;
      ctx.fillStyle = RED;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 10); ctx.lineTo(p.x - 8, p.y + 6); ctx.lineTo(p.x + 8, p.y + 6);
      ctx.closePath(); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- warnings
  drawWarnings(list, cx) {
    const y = this.h * 0.24;
    const blink = Math.sin(this.time * 10) > -0.2;
    if (!blink || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      this.text(w.text, cx, y + i * 40, 26, w.level === 'danger' ? RED : AMBER, 'center');
    }
  }

  // set externally before draw: camera + fpm projection
  setProjection(camera, velocityDirWorld) {
    this._camera = camera;
    if (velocityDirWorld) {
      this._fpmScreen = this._project(
        camera.position.clone().addScaledVector(velocityDirWorld, 1000)
      );
    } else {
      this._fpmScreen = null;
    }
  }

  _project(worldPos) {
    if (!this._camera) return null;
    const v = worldPos.clone().project(this._camera);
    if (v.z > 1 || v.z < -1) return null;
    // behind-camera check
    const camDir = new THREE.Vector3();
    this._camera.getWorldDirection(camDir);
    const toT = worldPos.clone().sub(this._camera.position);
    if (toT.dot(camDir) < 0) return null;
    return {
      x: (v.x * 0.5 + 0.5) * this.w,
      y: (-v.y * 0.5 + 0.5) * this.h,
    };
  }
}

// tiny bridge so the status block can show kills without plumbing
let _kills = 0;
export function setHudKills(n) { _kills = n; }
function world_kills() { return _kills; }
