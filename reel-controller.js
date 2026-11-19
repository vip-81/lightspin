/* ============================================================================
 * 5x3 Reel 滾動與停止控制器（純邏輯，零渲染綁定）
 *
 * 設計重點：
 * 1. 全局 FSM：Idle -> SpinUp -> LoopScroll -> SpinDown -> Bounce -> ResultShow
 * 2. 每軸有獨立相位（phase），支援 200ms 交錯停止； reel 0 先停、reel 4 最後停。
 * 3. Stop 使用三次多項式，同時滿足：起點速度 = 目前速度、終點速度 = 0、精確落在目標格。
 * 4. Bounce 使用 sin²(t) * e^(-kt)，起點與終點速度皆為 0，產生向下超調後回彈。
 * 5. 中獎結果完全由輸入矩陣決定；控制器內**沒有任何中獎計算**，只做表現層。
 *
 * 座標慣例（很重要，渲染請依此對齊）：
 * - position 單位 = 「 symbol 格數」，數值增加 = 輪帶向下捲動。
 * - 第 k 格的螢幕 Y = (position - k) * symbolHeight。
 * - 因此停穩時：k = P    -> 第 0 列（最上）
 *                 k = P-1  -> 第 1 列（中間）
 *                 k = P-2  -> 第 2 列（最下）
 * ========================================================================== */
'use strict';

/** @typedef {'Idle'|'SpinUp'|'LoopScroll'|'SpinDown'|'Bounce'|'ResultShow'} GlobalState */
/** @typedef {'IDLE'|'SPIN_UP'|'LOOP'|'SPIN_DOWN'|'BOUNCE'|'SETTLED'} ReelPhase */
/** @typedef {string} Sym  符號，可換成 {id:string,...} 物件，邏輯不需改動 */

/** @typedef {Object} SpinResult
 * @property {Sym[][]} matrix   後端回傳 [reel][row]，5 軸 × 3 列。前端不得竄改或用來算中獎。
 * @property {number[]} paylines 後端回傳的中獎線索引，前端只呈現、不解讀。
 * @property {string} [token]   請求序號，用於過期回應防呆。
 */

/** @typedef {Object} ReelFrame
 * @property {number} index
 * @property {ReelPhase} phase
 * @property {number} position      格數（浮點）
 * @property {number} offsetPx      position * symbolHeight
 * @property {number} velocity      格/秒（帶正負）
 * @property {number} velocityPx    px/秒
 * @property {number|null} targetIndex 目標格 P（整數），未決定前為 null
 * @property {Array<{index:number,symbol:Sym,y:number}>} window  渲染視窗內的符號與 Y 座標
 */

/** @typedef {Object} Frame
 * @property {GlobalState} state
 * @property {number} timeMs
 * @property {boolean} resultVisible  僅 ResultShow 為 true；前端應等此旗標才顯示中獎
 * @property {SpinResult|null} result 原始、已 freeze 的後端資料
 * @property {number[]} paylines
 * @property {ReelFrame[]} reels
 */

const DEFAULTS = Object.freeze({
  reelCount: 5,
  rowCount: 3,
  symbolHeight: 120,        // px，僅供 offsetPx / y 換算
  maxVelocity: 18,          // 格/秒
  spinUpMs: 520,            // 啟動加速時間
  minLoopMs: 320,           // 最少勻速捲動時間（自動停止用）
  stopStaggerMs: 200,       // 相鄰軸停止間隔
  stripePeriod: 60,         // 輪帶週期（格）；目標符號每 60 格重複一次，避免停止瞬間跳符號
  baseLead: 10,             // 停止時至少再走幾格
  extraLeadPerReel: 3,      // 右邊的軸多走幾格，讓節奏更明顯
  spinDownRatio: 2.2,       // r = v0*T/D，必須 <= 3，否則速度會變負（倒轉）
  bounceMs: 440,
  bounceAmplitude: 0.22,    // 超調峰值（格）
  maxFrameDtMs: 50,         // 單幀 dt 上限，避免分頁背景切回時跳幀
  fillerSymbols: ['A', 'B', 'C', 'D', 'E', 'F'],
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (u) => u * u * (3 - 2 * u);
const mod = (n, m) => ((n % m) + m) % m;

class ReelController {
  /** @param {Partial<typeof DEFAULTS>} [cfg] */
  constructor(cfg = {}) {
    /** @type {typeof DEFAULTS} */
    this.cfg = Object.freeze({ ...DEFAULTS, ...cfg });
    this.time = 0;
    /** @type {GlobalState} */
    this.state = 'Idle';
    /** @type {SpinResult|null} */
    this.result = null;
    /** @type {number[]} */
    this.paylines = Object.freeze([]);
    /** @type {string|null} */
    this.token = null;
    this.stopRequested = false;
    this.loopStartTime = 0;
    this.reels = Array.from({ length: this.cfg.reelCount }, (_, i) => this._makeReel(i));
  }

  _makeReel(i) {
    return {
      index: i,
      /** @type {ReelPhase} */
      phase: 'IDLE',
      position: 0,
      velocity: 0,
      phaseStart: 0,
      startPos: 0,
      baseIndex: 8 + i * 3, // P0：目標符號在輪帶上的基準相位
      /** @type {number|null} */
      targetIndex: null,
      stopAt: 0,
      /** @type {null|{startPos:number,P:number,D:number,T:number,a:number,b:number,c:number,start:number}} */
      sd: null,
      bounceStart: 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 公開 API                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 啟動旋轉。傳入的結果必須完全來自後端。
   * @param {SpinResult} result
   */
  spin(result) {
    if (!result || !Array.isArray(result.matrix)) throw new Error('spin(): 缺少 matrix');
    if (result.matrix.length !== this.cfg.reelCount) {
      throw new Error(`spin(): 需要 ${this.cfg.reelCount} 軸，收到 ${result.matrix.length}`);
    }
    for (let i = 0; i < result.matrix.length; i++) {
      if (!Array.isArray(result.matrix[i]) || result.matrix[i].length !== this.cfg.rowCount) {
        throw new Error(`spin(): 第 ${i} 軸需要 ${this.cfg.rowCount} 列`);
      }
    }

    // 深拷貝 + freeze：防止前端意外（或惡意）改動結果，也強調前端不算中獎。
    const matrix = Object.freeze(
      result.matrix.map((col) => Object.freeze(col.slice()))
    );
    this.result = Object.freeze({
      matrix,
      paylines: Object.freeze(Array.isArray(result.paylines) ? result.paylines.slice() : []),
      token: result.token,
    });
    this.paylines = this.result.paylines;
    this.token = result.token ?? null;

    this.stopRequested = false;
    this.loopStartTime = 0;
    this.reels.forEach((r) => {
      r.phase = 'SPIN_UP';
      r.position = 0;
      r.velocity = 0;
      r.phaseStart = this.time;
      r.startPos = 0;
      r.targetIndex = null;
      r.sd = null;
      r.stopAt = Infinity;
    });
    this.state = 'SpinUp';
  }

  /** 要求開始交錯停止；可在任何時刻呼叫，實際停止會在進入 LoopScroll 後生效。 */
  beginStop() {
    this.stopRequested = true;
    if (this.state === 'LoopScroll') this._scheduleStop(this.time);
  }

  /** 重置到 Idle。 */
  reset() {
    this.state = 'Idle';
    this.result = null;
    this.paylines = Object.freeze([]);
    this.token = null;
    this.stopRequested = false;
    this.loopStartTime = 0;
    this.reels = Array.from({ length: this.cfg.reelCount }, (_, i) => this._makeReel(i));
  }

  /** 用來過濾亂序抵達的舊請求回應。 */
  isCurrent(token) { return token != null && token === this.token; }

  /** 取得原始結果（已 freeze）。前端不得據此計算賠付。 */
  getResult() { return this.result; }

  /**
   * 給渲染層查詢任意整數格的符號。
   * 命中 landing 區（P, P-1, P-2）時回傳後端矩陣，其餘回傳裝飾用符號。
   */
  symbolAt(reelIndex, index) {
    const r = this.reels[reelIndex];
    if (!r) return '?';
    if (this.result) {
      const m = mod(r.baseIndex - index, this.cfg.stripePeriod);
      if (m < this.cfg.rowCount) return this.result.matrix[reelIndex][m];
    }
    const fillers = this.cfg.fillerSymbols;
    // 確定性 hash：同一格永遠同一符號，避免幀間閃爍。
    let h = (Math.imul(index, 2654435761) ^ Math.imul(reelIndex + 1, 40503)) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 1274126177) >>> 0;
    return fillers[h % fillers.length];
  }

  /** 推進一個 frame 並回傳快照。dtMs 由外部 rAF 提供。 */
  update(dtMs) {
    const dtMsClamped = clamp(Number.isFinite(dtMs) ? dtMs : 0, 0, this.cfg.maxFrameDtMs);
    const dt = dtMsClamped / 1000;
    this.time += dtMsClamped;

    if (dt > 0 && this.state !== 'Idle' && this.state !== 'ResultShow') {
      for (const r of this.reels) this._stepReel(r, dt);
      this._advanceState();

      // 沒有外部介入時，勻速一段時間後自動停止，方便單機展示。
      if (this.state === 'LoopScroll' && !this.stopRequested &&
          this.time - this.loopStartTime >= this.cfg.minLoopMs) {
        this.beginStop();
      }
    }
    return this.getFrame();
  }

  /** 只讀取目前快照，不推進時間。 */
  getFrame() {
    /** @type {ReelFrame[]} */
    const reels = this.reels.map((r) => {
      const base = Math.floor(r.position);
      const window = [];
      for (let k = base - 2; k <= base + 4; k++) {
        window.push({
          index: k,
          symbol: this.symbolAt(r.index, k),
          y: (r.position - k) * this.cfg.symbolHeight,
        });
      }
      return {
        index: r.index,
        phase: r.phase,
        position: r.position,
        offsetPx: r.position * this.cfg.symbolHeight,
        velocity: r.velocity,
        velocityPx: r.velocity * this.cfg.symbolHeight,
        targetIndex: r.targetIndex,
        window,
      };
    });
    return {
      state: this.state,
      timeMs: this.time,
      resultVisible: this.state === 'ResultShow',
      result: this.result,
      paylines: this.paylines,
      reels,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 內部：每軸物理                                                      */
  /* ------------------------------------------------------------------ */

  /** @param {any} r @param {number} dt */
  _stepReel(r, dt) {
    const c = this.cfg;
    switch (r.phase) {
      case 'SPIN_UP': {
        const T = c.spinUpMs / 1000;
        const u = clamp((this.time - r.phaseStart) / c.spinUpMs, 0, 1);
        // 解析積分：∫ smoothstep = u³ - u⁴/2，避免數值累積誤差。
        r.position = r.startPos + c.maxVelocity * T * (u * u * u - (u * u * u * u) / 2);
        r.velocity = c.maxVelocity * smoothstep(u);
        if (u >= 1) {
          r.velocity = c.maxVelocity;
          r.phase = 'LOOP';
        }
        break;
      }
      case 'LOOP': {
        if (this.stopRequested && this.time >= r.stopAt) {
          this._enterSpinDown(r);
        } else {
          r.position += c.maxVelocity * dt;
          r.velocity = c.maxVelocity;
        }
        break;
      }
      case 'SPIN_DOWN': {
        const sd = r.sd;
        const u = clamp((this.time - sd.start) / sd.T, 0, 1);
        // p(u) = a u³ + b u² + c u + d；p'(1) = 0，保證零速落點。
        r.position = sd.a * u * u * u + sd.b * u * u + sd.c * u + sd.startPos;
        r.velocity = (3 * sd.a * u * u + 2 * sd.b * u + sd.c) / sd.T;
        if (u >= 1) {
          r.position = sd.P;
          r.velocity = 0;
          r.phase = 'BOUNCE';
          r.bounceStart = this.time;
        }
        break;
      }
      case 'BOUNCE': {
        const u = clamp((this.time - r.bounceStart) / c.bounceMs, 0, 1);
        const A = 2 * c.bounceAmplitude; // sin² 峰值約 0.5A，乘 2 讓峰值 ≈ amplitude
        const s = Math.sin(Math.PI * u);
        const e = Math.exp(-1.5 * u);
        r.position = r.targetIndex + A * s * s * e;
        r.velocity = (A * e * (Math.PI * Math.sin(2 * Math.PI * u) - 1.5 * s * s)) /
                     (c.bounceMs / 1000);
        if (u >= 1) {
          r.position = r.targetIndex;
          r.velocity = 0;
          r.phase = 'SETTLED';
        }
        break;
      }
      default:
        break;
    }
  }

  /** 進入減速：求出整數落點 P，並解出三次多項式係數。 */
  _enterSpinDown(r) {
    const c = this.cfg;
    const lead = c.baseLead + r.index * c.extraLeadPerReel;
    const k = Math.ceil((r.position + lead - r.baseIndex) / c.stripePeriod);
    const P = r.baseIndex + k * c.stripePeriod; // 與 P0 同餘，保證 landing 符號對齊
    const D = P - r.position;                    // 剩餘距離（格）
    const v0 = Math.max(r.velocity, c.maxVelocity * 0.01);
    // r = v0*T/D 必須 <= 3，否則 p'(u) 會出現負值（輪帶倒轉）。
    const ratio = clamp(c.spinDownRatio, 0.2, 2.98);
    const T = (ratio * D) / v0;
    const V = v0 * T; // = ratio * D
    r.sd = {
      startPos: r.position,
      P, D, T,
      a: V - 2 * D,
      b: 3 * D - 2 * V,
      c: V,
      start: this.time,
    };
    r.targetIndex = P;
    r.phase = 'SPIN_DOWN';
  }

  _scheduleStop(now) {
    for (const r of this.reels) r.stopAt = now + r.index * this.cfg.stopStaggerMs;
  }

  _advanceState() {
    const phases = this.reels.map((r) => r.phase);
    if (this.state === 'SpinUp' && phases.every((p) => p !== 'SPIN_UP')) {
      this.state = 'LoopScroll';
      this.loopStartTime = this.time;
      if (this.stopRequested) this._scheduleStop(this.time);
    } else if (this.state === 'LoopScroll' && phases.includes('SPIN_DOWN')) {
      this.state = 'SpinDown';
    } else if (this.state === 'SpinDown' &&
               phases.every((p) => p === 'BOUNCE' || p === 'SETTLED')) {
      this.state = 'Bounce';
    } else if (this.state === 'Bounce' && phases.every((p) => p === 'SETTLED')) {
      this.state = 'ResultShow';
    }
  }
}

/* ============================================================================
 * Mock 後端 + 最小展示用驅動（不屬於控制器，可整段刪除）
 * ========================================================================== */

/** 題目給的範例矩陣：每軸 3 列。中獎線由後端給，前端不推導。 */
const MOCK_RESULT = Object.freeze({
  matrix: Object.freeze([
    Object.freeze(['A', 'B', 'C']),
    Object.freeze(['B', 'C', 'D']),
    Object.freeze(['E', 'A', 'B']),
    Object.freeze(['C', 'D', 'A']),
    Object.freeze(['B', 'B', 'C']),
  ]),
  paylines: Object.freeze([1, 3, 5]),
});

let mockSeq = 0;
function mockFetchSpinResult(delayMs = 350) {
  const token = `req-${++mockSeq}`;
  return new Promise((resolve) => {
    setTimeout(() => resolve({ ...MOCK_RESULT, token }), delayMs);
  });
}

// 同時支援 Node（CommonJS）與瀏覽器（全域變數），方便直接除錯。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ReelController, MOCK_RESULT, mockFetchSpinResult, DEFAULTS };
}
if (typeof globalThis !== 'undefined') {
  globalThis.ReelController = ReelController;
  globalThis.MOCK_RESULT = MOCK_RESULT;
}
