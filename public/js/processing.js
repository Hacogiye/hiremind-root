// processing.js — Shared processing UI (wizard + session page).
// Animated orb, elapsed timer, 4 stages with clear states, progress bar, leave-safe link.
(function () {
  'use strict';

  const STAGES = [
    { key: 'extracting', label: 'Đọc & trích xuất nội dung CV', hint: 'OCR ảnh chụp, đọc PDF/DOCX/TXT' },
    { key: 'validating', label: 'AI đọc hiểu & hợp nhất CV', hint: 'Xác thực tài liệu, chuẩn hoá nội dung' },
    { key: 'jd', label: 'Tải & phân tích tin tuyển dụng', hint: 'Lấy JD từ link, trích yêu cầu chính' },
    { key: 'analyzing', label: 'Phân tích sâu & đối chiếu', hint: 'Chấm điểm, kỹ năng thiếu, lộ trình' },
  ];
  const ORDER = ['queued', ...STAGES.map(s => s.key), 'done'];
  const PCT = { queued: 6, extracting: 26, validating: 50, jd: 70, analyzing: 90, done: 100 };

  let state = { el: null, t0: 0, timer: null, stage: 'queued', sessionUrl: null, mounted: false };

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function shell() {
    return `
      <div class="proc-panel">
        <div class="proc-orb">
          <div class="proc-orb-core">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12.5 22h-1l-.25-12.07A4 4 0 0 1 12 2z"/><path d="M7 12c-2 0-3 1.5-3 3.5S5.5 19 7 19"/><path d="M17 12c2 0 3 1.5 3 3.5S18.5 19 17 19"/></svg>
          </div>
        </div>

        <div class="proc-head">
          <h2 class="proc-title" id="procTitle">Đang khởi tạo...</h2>
          <div class="proc-meta">
            <span class="proc-chip" id="procTimer">⏱ 00:00</span>
            <span class="proc-chip" id="procStep">Bước 0/4</span>
          </div>
        </div>

        <div class="proc-bar"><div class="proc-bar-fill" id="procBarFill"></div></div>

        <div class="proc-stages" id="procStages">
          ${STAGES.map((s, i) => `
            <div class="proc-stage" data-key="${s.key}">
              <div class="proc-stage-rail"><span class="proc-dot">${i + 1}</span></div>
              <div class="proc-stage-txt">
                <div class="proc-stage-label">${s.label}</div>
                <div class="proc-stage-hint">${s.hint}</div>
              </div>
            </div>`).join('')}
        </div>

        <div class="proc-error hidden" id="procError"></div>

        <div class="proc-leave" id="procLeave">
          <div class="proc-leave-note">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <span>Bạn có thể thoát trang ngay — AI vẫn xử lý tiếp phía server. Lưu link này để quay lại xem kết quả:</span>
          </div>
          <div class="proc-linkbox">
            <input class="input" id="procUrl" readonly>
            <button class="btn btn-soft btn-sm" id="procCopy" style="flex-shrink:0;">Copy</button>
            <a class="btn btn-primary btn-sm" id="procOpen" href="#" style="flex-shrink:0;">Mở phiên →</a>
          </div>
        </div>
      </div>`;
  }

  function tick() {
    const t = document.getElementById('procTimer');
    if (t && state.t0) t.textContent = '⏱ ' + fmt(Date.now() - state.t0);
  }

  function setStage(stage) {
    state.stage = stage;
    const idx = ORDER.indexOf(stage);            // 0 = queued, 1..4 = stages, 5 = done
    const stageIdx = Math.max(0, idx - 1);       // index within STAGES

    document.querySelectorAll('.proc-stage').forEach((el, i) => {
      const done = i < stageIdx || stage === 'done';
      const active = i === stageIdx && stage !== 'done';
      el.classList.toggle('done', done);
      el.classList.toggle('active', active);
      const dot = el.querySelector('.proc-dot');
      if (done) dot.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      else dot.textContent = i + 1;
    });

    const fill = document.getElementById('procBarFill');
    if (fill) fill.style.width = (PCT[stage] ?? 6) + '%';

    const step = document.getElementById('procStep');
    if (step) step.textContent = stage === 'done' ? 'Hoàn tất' : `Bước ${Math.min(4, Math.max(1, idx))}/4`;
  }

  function setTitle(text) {
    const t = document.getElementById('procTitle');
    if (t && text) t.textContent = text;
  }

  function setError(msg) {
    const e = document.getElementById('procError');
    if (!e) return;
    e.textContent = '⚠ ' + msg;
    e.classList.remove('hidden');
    document.getElementById('procLeave')?.classList.add('hidden');
    document.querySelector('.proc-bar')?.classList.add('hidden');
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function wire(sessionUrl) {
    state.sessionUrl = sessionUrl;
    const urlInput = document.getElementById('procUrl');
    const open = document.getElementById('procOpen');
    if (urlInput) urlInput.value = sessionUrl;
    if (open) open.href = sessionUrl;
    document.getElementById('procCopy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(sessionUrl);
        const b = document.getElementById('procCopy');
        b.textContent = '✓ Đã copy';
        setTimeout(() => { b.textContent = 'Copy'; }, 2000);
      } catch { /* clipboard blocked */ }
    });
  }

  window.HMProcessing = {
    // Mount vào container. opts: { stage, stageLabel, sessionUrl, error }
    mount(container, opts = {}) {
      state.el = container;
      state.t0 = Date.now();
      container.innerHTML = shell();
      if (opts.sessionUrl) wire(opts.sessionUrl);
      else document.getElementById('procLeave')?.classList.add('hidden');
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(tick, 1000);
      tick();
      if (opts.error) { setError(opts.error); return; }
      if (opts.stageLabel) setTitle(opts.stageLabel);
      setStage(opts.stage || 'queued');
      state.mounted = true;
    },
    update(stage, stageLabel, sessionUrl) {
      if (!state.mounted) return;
      if (sessionUrl && !state.sessionUrl) { wire(sessionUrl); document.getElementById('procLeave')?.classList.remove('hidden'); }
      if (stageLabel) setTitle(stageLabel);
      if (stage) setStage(stage);
    },
    error(msg) { setError(msg); },
    stop() { if (state.timer) { clearInterval(state.timer); state.timer = null; } state.mounted = false; },
  };
})();
