/* ============================================================
   LightSpin — 入口腳本
   負責：初始化遊戲、UI 同步、觸控/鍵盤事件、首次手勢解鎖音訊
   ============================================================ */
(function () {
  'use strict';

  const canvas   = document.getElementById('slot-canvas');
  const spinBtn  = document.getElementById('spin-btn');
  const statusEl = document.getElementById('game-status');
  const balanceEl = document.getElementById('balance');
  const betEl    = document.getElementById('bet');
  const winEl    = document.getElementById('win');

  if (!canvas || !window.SlotGame) return;

  const game = new SlotGame(canvas, {
    onStatus: (msg) => { if (statusEl) statusEl.textContent = msg; },
    onUpdate: (g) => {
      if (balanceEl) balanceEl.textContent = g.balance;
      if (betEl) betEl.textContent = g.bet;
      if (winEl) winEl.textContent = g.lastWin;
      if (spinBtn) spinBtn.disabled = g.state !== window.SLOT_STATE.IDLE;
    }
  });

  // 首次使用者手勢解鎖 Web Audio（iOS Safari 必要）
  const unlockOnce = () => {
    game.unlockAudio();
    window.removeEventListener('pointerdown', unlockOnce);
    window.removeEventListener('keydown', unlockOnce);
  };
  window.addEventListener('pointerdown', unlockOnce, { passive: true });
  window.addEventListener('keydown', unlockOnce);

  // 旋轉按鈕
  if (spinBtn) spinBtn.addEventListener('click', () => game.spin());

  // 空白鍵旋轉（避免按在按鈕上時重複觸發）
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/^(BUTTON|INPUT|TEXTAREA|SUMMARY)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      game.spin();
    }
  });

  // 點擊畫布亦可旋轉
  canvas.addEventListener('click', () => game.spin());

  // 平滑捲動（支援 prefers-reduced-motion）
  document.querySelectorAll('[data-scroll]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start'
      });
    });
  });
})();
