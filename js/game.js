/* ============================================================
   LightSpin — 輕量老虎機核心（純 Canvas 2D，零依賴）
   重點：FSM、物件池粒子、緩動、Web Audio、DPR 自適應
   注意：此示範的 RNG 僅供視覺展示；正式博弈結果必須由伺服器決定。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 常數 ---------- */
  const STATE = Object.freeze({
    IDLE: 'IDLE',
    SPINNING: 'SPINNING',
    STOPPING: 'STOPPING',
    EVALUATING: 'EVALUATING'
  });

  // 符號定義：value 為中獎倍數（僅示範）
  const SYMBOLS = Object.freeze([
    { id: 'cherry',   color: '#ff4d6d', value: 2  },
    { id: 'lemon',    color: '#ffd23f', value: 3  },
    { id: 'star',     color: '#ffcb45', value: 5  },
    { id: 'seven',    color: '#ff5d8f', value: 10 },
    { id: 'diamond',  color: '#5ee7ff', value: 20 },
    { id: 'bell',     color: '#ffe9a8', value: 8  }
  ]);

  const REEL_COUNT = 3;

  /* ---------- 緩動函式 ---------- */
  const easeOutCubic  = t => 1 - Math.pow(1 - t, 3);
  const easeOutBounce = t => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  };
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---------- 簡易音效（Web Audio） ---------- */
  class SoundKit {
    constructor() { this.ctx = null; }
    unlock() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    beep(freq, duration, type = 'square', gain = 0.05) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const amp = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      amp.gain.setValueAtTime(gain, t);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(amp).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + duration);
    }
    spin()  { this.beep(420, 0.08, 'square', 0.03); }
    stop()  { this.beep(660, 0.12, 'triangle', 0.06); }
    win()   { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.beep(f, 0.18, 'sine', 0.07), i * 90)); }
  }

  /* ---------- 粒子系統（物件池） ---------- */
  class ParticlePool {
    constructor(size = 160) {
      this.items = Array.from({ length: size }, () => ({
        active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, color: '#ffcb45', size: 6
      }));
    }
    spawn(opts) {
      let p = this.items.find(o => !o.active);
      if (!p) p = this.items[(Math.random() * this.items.length) | 0]; // 池滿則覆蓋最舊
      Object.assign(p, opts, { active: true, life: opts.maxLife });
      return p;
    }
    update(dt) {
      for (const p of this.items) {
        if (!p.active) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 900 * dt;          // 重力
        p.life -= dt;
        if (p.life <= 0) p.active = false;
      }
    }
    draw(ctx) {
      for (const p of this.items) {
        if (!p.active) continue;
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    burst(x, y, count, colors) {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 220 + Math.random() * 380;
        this.spawn({
          x, y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s - 260,
          maxLife: 0.7 + Math.random() * 0.6,
          color: colors[(Math.random() * colors.length) | 0],
          size: 4 + Math.random() * 5
        });
      }
    }
  }

  /* ---------- 遊戲本體 ---------- */
  class SlotGame {
    constructor(canvas, callbacks) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.cb = callbacks || {};
      this.sound = new SoundKit();
      this.particles = new ParticlePool();

      this.state = STATE.IDLE;
      this.balance = 1000;
      this.bet = 10;
      this.lastWin = 0;
      this.reels = [];
      this.shake = 0;
      this.dpr = 1;
      this.w = 0;
      this.h = 0;
      this.lastTime = 0;
      this.reducedMotion = global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches;

      this._initReels();
      this._bindResize();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    /* 初始化三軸：每軸記錄目前符號、目標、動畫進度 */
    _initReels() {
      this.reels = Array.from({ length: REEL_COUNT }, (_, i) => ({
        index: (i * 2) % SYMBOLS.length,
        target: 0,
        startIndex: 0,
        spinOffset: Math.random() * 100,
        speed: 0,
        stopAt: 0,      // 停止時間點（毫秒）
        t: 0,           // 停止動畫進度
        stopping: false
      }));
    }

    _bindResize() {
      const resize = () => {
        const rect = this.canvas.getBoundingClientRect();
        this.dpr = Math.min(global.devicePixelRatio || 1, 2); // 限制 DPR 上限以保效能
        this.w = rect.width;
        this.h = rect.height;
        this.canvas.width = Math.round(this.w * this.dpr);
        this.canvas.height = Math.round(this.h * this.dpr);
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      };
      resize();
      if ('ResizeObserver' in global) {
        new ResizeObserver(resize).observe(this.canvas);
      } else {
        global.addEventListener('resize', resize, { passive: true });
      }
    }

    unlockAudio() { this.sound.unlock(); }

    spin() {
      if (this.state !== STATE.IDLE) return false;
      if (this.balance < this.bet) {
        this._notify('餘額不足，請重置遊戲。');
        return false;
      }
      this.balance -= this.bet;
      this.lastWin = 0;
      this.state = STATE.SPINNING;
      this._notify('旋轉中…');
      this.sound.unlock();
      this.sound.spin();

      const now = performance.now();
      const n = SYMBOLS.length;
      const cellH = Math.max(1, this.h * 0.62);
      this.reels.forEach((r, i) => {
        r.stopping = false;
        r.t = 0;                           // 重要：重置進度，避免上一輪的 t=1 造成提前結算
        r.spinOffset %= n * cellH;         // 避免長時間遊玩數值無限增大
        r.speed = 900 + i * 120;
        r.stopAt = now + 500 + i * 320;   // 交錯停止，製造節奏感
      });
      this._syncUI();
      return true;
    }

    reset() {
      if (this._evalTimer) { clearTimeout(this._evalTimer); this._evalTimer = null; }
      this.balance = 1000;
      this.lastWin = 0;
      this.state = STATE.IDLE;
      this._initReels();
      this._notify('已重置，準備就緒。');
      this._syncUI();
    }

    /* ---------- 主迴圈 ---------- */
    _loop(now) {
      const dt = Math.min((now - this.lastTime) / 1000 || 0, 0.05);
      this.lastTime = now;
      this._update(dt, now);
      this._draw();
      requestAnimationFrame(this._loop);
    }

    _update(dt, now) {
      // 軸更新：優先處理正在停止的軸，再處理仍在旋轉的軸。
      // 注意：不可寫成 if (state===SPINNING) {...} else if (r.stopping)，
      // 否則已停止中的軸會在 SPINNING 狀態下被重复重置 t，永遠無法結算。
      for (const r of this.reels) {
        if (r.stopping) {
          r.t = Math.min(1, r.t + dt / 0.55);
          // 以 bounce 緩動捲向精確落點，避免停止瞬間跳幀
          r.spinOffset = lerp(r.stopFrom, r.stopTo, easeOutBounce(r.t));
          if (r.t >= 1) {
            r.stopping = false;
            r.index = r.target;
            r.spinOffset = r.stopTo;
          }
        } else if (this.state === STATE.SPINNING) {
          r.spinOffset += r.speed * dt;
          if (now >= r.stopAt) {
            r.stopping = true;
            // 示範 RNG：正式環境應由伺服器回傳 target
            r.target = (Math.random() * SYMBOLS.length) | 0;
            r.t = 0;
            // 計算向前捲動的落點，使目標符號恰好停在窗格中央
            const n = SYMBOLS.length;
            const cellH = Math.max(1, this.h * 0.62);
            r.stopFrom = r.spinOffset;
            r.stopTo = Math.ceil((r.stopFrom + 1) / (n * cellH)) * n + r.target * cellH;
            this.sound.stop();
          }
        }
      }

      // 狀態轉移：全部停止 → 結算
      if (this.state === STATE.SPINNING && this.reels.every(r => !r.stopping && r.t >= 1)) {
        this.state = STATE.EVALUATING;
        this._evaluate();
      }
      if (this.state === STATE.EVALUATING) {
        // 短暫停留後回到待機
        if (!this._evalTimer) {
          this._evalTimer = setTimeout(() => {
            this.state = STATE.IDLE;
            this._evalTimer = null;
            this._notify('準備就緒 · 按空白鍵或點擊旋轉');
          }, 900);
        }
      }

      this.particles.update(dt);
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }

    _evaluate() {
      const [a, b, c] = this.reels.map(r => r.index);
      let win = 0;
      if (a === b && b === c) {
        win = this.bet * SYMBOLS[a].value;
      } else if ((a === b) || (b === c) || (a === c)) {
        win = Math.floor(this.bet / 2); // 兩軸相同的小額安慰獎
      }
      this.lastWin = win;
      this.balance += win;

      if (win > 0) {
        const cx = this.w / 2, cy = this.h / 2;
        const colors = SYMBOLS.map(s => s.color);
        this.particles.burst(cx, cy, this.reducedMotion ? 24 : 90, colors);
        this.shake = this.reducedMotion ? 0 : 1;
        this.sound.win();
        this._notify(`恭喜中獎！獲得 ${win} 分`);
      } else {
        this._notify('未中獎，再試一次！');
      }
      this._syncUI();
    }

    _notify(msg) { if (typeof this.cb.onStatus === 'function') this.cb.onStatus(msg); }
    _syncUI() { if (typeof this.cb.onUpdate === 'function') this.cb.onUpdate(this); }

    /* ---------- 繪圖 ---------- */
    _draw() {
      const ctx = this.ctx, w = this.w, h = this.h;
      ctx.save();
      // 螢幕震動
      if (this.shake > 0) {
        const mag = this.shake * 8;
        ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
      }

      // 背景
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#111a3a');
      g.addColorStop(1, '#070b18');
      ctx.fillStyle = g;
      ctx.fillRect(-10, -10, w + 20, h + 20);

      // 三個轉軸窗格
      const pad = Math.max(12, w * 0.04);
      const gap = pad * 0.5;
      const reelW = (w - pad * 2 - gap * 2) / REEL_COUNT;
      const reelH = h * 0.62;
      const top = h * 0.13;

      this.reels.forEach((r, i) => {
        const x = pad + i * (reelW + gap);
        this._drawReel(ctx, r, x, top, reelW, reelH);
      });

      // 粒子（前景）
      this.particles.draw(ctx);

      // 中獎標題
      if (this.state === STATE.EVALUATING && this.lastWin > 0) {
        ctx.fillStyle = '#ffcb45';
        ctx.font = `900 ${Math.max(28, h * 0.11)}px ${getComputedStyle(document.body).fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`+${this.lastWin}`, w / 2, h * 0.9);
      }
      ctx.restore();
    }

    _drawReel(ctx, r, x, y, w, h) {
      // 窗格外框
      ctx.fillStyle = '#0a0f24';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();

      const cellH = h;
      const baseIndex = Math.floor(r.spinOffset / cellH);
      const frac = r.spinOffset / cellH - baseIndex;

      // 畫出目前、上一個、下一個符號，形成捲動感
      for (let k = -1; k <= 1; k++) {
        const idx = ((baseIndex + k) % SYMBOLS.length + SYMBOLS.length) % SYMBOLS.length;
        const sy = y + (k + frac) * cellH;
        this._drawSymbol(ctx, SYMBOLS[idx], x + w / 2, sy + cellH / 2, Math.min(w, cellH) * 0.34);
      }
      ctx.restore();

      // 停止時的目標符號（覆蓋以確保精確）
      if (!r.stopping && r.t >= 1 && this.state !== STATE.SPINNING) {
        this._drawSymbol(ctx, SYMBOLS[r.index], x + w / 2, y + h / 2, Math.min(w, h) * 0.34);
      }
    }

    /* 以幾何圖形繪製符號，避免 emoji 字型相容性問題 */
    _drawSymbol(ctx, sym, cx, cy, s) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = sym.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = Math.max(2, s * 0.06);

      switch (sym.id) {
        case 'cherry':
          ctx.beginPath(); ctx.arc(-s * 0.28, s * 0.18, s * 0.28, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(s * 0.28, s * 0.18, s * 0.28, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#3ddc84'; ctx.lineWidth = s * 0.08;
          ctx.beginPath(); ctx.moveTo(0, s * 0.1); ctx.quadraticCurveTo(s * 0.1, -s * 0.5, s * 0.45, -s * 0.6); ctx.stroke();
          break;
        case 'lemon':
          ctx.beginPath(); ctx.ellipse(0, 0, s * 0.55, s * 0.36, -0.3, 0, Math.PI * 2); ctx.fill();
          break;
        case 'star': {
          ctx.beginPath();
          for (let i = 0; i < 10; i++) {
            const ang = -Math.PI / 2 + i * Math.PI / 5;
            const rad = i % 2 === 0 ? s * 0.6 : s * 0.26;
            const px = Math.cos(ang) * rad, py = Math.sin(ang) * rad;
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.closePath(); ctx.fill();
          break;
        }
        case 'seven':
          ctx.font = `900 ${s * 1.1}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('7', 0, s * 0.05);
          break;
        case 'diamond':
          ctx.beginPath();
          ctx.moveTo(0, -s * 0.6); ctx.lineTo(s * 0.5, 0);
          ctx.lineTo(0, s * 0.6); ctx.lineTo(-s * 0.5, 0);
          ctx.closePath(); ctx.fill();
          break;
        case 'bell':
          ctx.beginPath();
          ctx.moveTo(0, -s * 0.5);
          ctx.quadraticCurveTo(s * 0.55, -s * 0.4, s * 0.45, s * 0.3);
          ctx.lineTo(-s * 0.45, s * 0.3);
          ctx.quadraticCurveTo(-s * 0.55, -s * 0.4, 0, -s * 0.5);
          ctx.fill();
          ctx.beginPath(); ctx.arc(0, s * 0.42, s * 0.12, 0, Math.PI * 2); ctx.fill();
          break;
      }
      ctx.restore();
    }
  }

  global.SlotGame = SlotGame;
  global.SLOT_STATE = STATE;
})(window);
