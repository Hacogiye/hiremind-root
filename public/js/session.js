// session.js — Session results dashboard: poll status, render report, tabs, chat, interview, cover letter.
(function () {
  'use strict';

  const sessionId = location.pathname.split('/').pop();
  const app = document.getElementById('app');
  const $ = s => document.querySelector(s);

  let SESSION = null;
  let chatHistory = [];

  // ---------- Markdown ----------
  if (window.marked) {
    marked.setOptions({ breaks: true, gfm: true });
  }
  function md(text) {
    if (!window.marked || !text) return '<div class="md">' + esc(text || '') + '</div>';
    try {
      // sanitize: strip raw html tags & event handlers before parse
      const clean = String(text).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/on\w+\s*=\s*"[^"]*"/gi, '').replace(/on\w+\s*=\s*'[^']*'/gi, '').replace(/javascript:/gi, '');
      return '<div class="md">' + marked.parse(clean) + '</div>';
    } catch {
      return '<div class="md">' + esc(text) + '</div>';
    }
  }
  // Markdown → plain text (cho body Gmail compose — không render md, giữ bullet/newline)
  function mdToPlain(t) {
    return String(t)
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^[-*+]\s+/gm, '• ');
  }

  // DOCX export helper
  async function exportDocx(title, markdown, filename) {
    try {
      const res = await fetch('/api/export/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, markdown }),
      });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || 'hiremind.docx';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Đã tải file Word (.docx)');
    } catch {
      toast('Không xuất được file Word');
    }
  }

  // CV thiết kế (.docx có banner màu + ô dán ảnh 3×4 + heading màu + skill 2 cột)
  async function exportCvDocx(markdown, name) {
    try {
      const res = await fetch('/api/export/cv-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown, name }),
      });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `CV-${(name || 'HireMind').replace(/\s+/g, '-')}.docx`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Đã tải CV (.docx) — mở file, bấm vào ô bên phải để dán ảnh 3×4');
    } catch {
      toast('Không xuất được file CV Word');
    }
  }

  // ---------- Utils ----------
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const VERDICT = {
    excellent: { cls: 'verdict-excellent', label: 'Xuất sắc' },
    good: { cls: 'verdict-good', label: 'Khá tốt' },
    moderate: { cls: 'verdict-moderate', label: 'Trung bình' },
    weak: { cls: 'verdict-weak', label: 'Cần cải thiện nhiều' },
  };
  const PASS_VERDICT = {
    very_likely: { cls: 'pass-very-likely', label: 'Rất nhiều khả năng đậu', emoji: '🎯' },
    likely: { cls: 'pass-likely', label: 'Nhiều khả năng đậu', emoji: '👍' },
    uncertain: { cls: 'pass-uncertain', label: 'Chưa rõ ràng', emoji: '⚖️' },
    unlikely: { cls: 'pass-unlikely', label: 'Nhiều khả năng trượt', emoji: '⚠️' },
    very_unlikely: { cls: 'pass-very-unlikely', label: 'Gần như chắc chắn trượt', emoji: '❌' },
  };
  // Đánh giá đậu/rớt — fallback từ overallScore nếu session cũ không có hireAssessment
  function hireAssess() {
    const r = SESSION.result || {};
    if (r.hireAssessment && typeof r.hireAssessment.passProbability === 'number') return r.hireAssessment;
    const score = r.overallScore || 0;
    const p = Math.max(2, Math.min(95, Math.round(score * 0.9)));
    return {
      passProbability: p,
      verdict: score >= 75 ? 'likely' : score >= 50 ? 'uncertain' : score >= 30 ? 'unlikely' : 'very_unlikely',
      headline: '',
      reasons: [],
      whatWouldRaise: [],
    };
  }

  // ---------- Boot ----------
  async function boot() {
    let procMounted = false;
    for (;;) {
      let d;
      try {
        const res = await fetch(`/api/session/${sessionId}`);
        if (res.status === 404) { renderNotFound(); return; }
        d = await res.json();
      } catch { await sleep(2500); continue; }

      SESSION = d;
      if (d.status === 'ready') { HMProcessing.stop(); render(); return; }
      if (d.status === 'error') { HMProcessing.stop(); renderError(d); return; }
      // Mount panel xử lý ĐÚNG MỘT LẦN — các lần poll sau chỉ update stage.
      // (Remount mỗi poll làm reset bộ đếm thời gian về 00:00 liên tục.)
      if (!procMounted) { renderProcessing(d); procMounted = true; }
      else HMProcessing.update(d.stage || 'queued', d.stageLabel, location.href);
      await sleep(2500);
    }
  }

  // ---------- States ----------
  function renderProcessing(d) {
    const stages = [
      ['extracting', 'Đọc & trích xuất nội dung CV'],
      ['validating', 'AI đọc hiểu & hợp nhất CV'],
      ['jd', 'Tải & phân tích tin tuyển dụng'],
      ['analyzing', 'Phân tích sâu & đối chiếu'],
    ];
    const order = ['queued', 'extracting', 'validating', 'jd', 'analyzing', 'done'];
    const idx = order.indexOf(d.stage || 'queued');
    document.getElementById('hdTitle').textContent = 'AI đang xử lý phiên của bạn...';
    app.innerHTML = `
      <div class="session-loading">
        <div id="procMount"></div>
      </div>`;
    HMProcessing.mount(document.getElementById('procMount'), {
      stage: d.stage || 'queued',
      stageLabel: d.stageLabel || 'Đang xử lý...',
      sessionUrl: location.href,
    });
  }

  function renderNotFound() {
    document.getElementById('hdTitle').textContent = 'Không tìm thấy phiên';
    app.innerHTML = `
      <div class="error-panel">
        <div class="e-icon"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg></div>
        <h2 style="margin-bottom: 10px;">Phiên không tồn tại</h2>
        <p class="muted mb-6">Link phiên không đúng hoặc đã bị xoá. Hãy tạo phiên mới.</p>
        <a class="btn btn-primary" href="/">Tạo phiên mới</a>
      </div>`;
  }

  function renderError(d) {
    document.getElementById('hdTitle').textContent = 'Phiên gặp lỗi';
    const isNotCv = d.notCv;
    app.innerHTML = `
      <div class="error-panel">
        <div class="e-icon"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4m0 4h.01"/></svg></div>
        <h2 style="margin-bottom: 10px;">${isNotCv ? 'Tài liệu không phải là CV' : 'Xử lý thất bại'}</h2>
        <p class="muted mb-6" style="max-width: 460px; margin-inline: auto;">${esc(d.error || 'Đã có lỗi xảy ra khi xử lý phiên này.')}</p>
        ${d.warnings && d.warnings.length ? `<div style="text-align:left; font-size: 0.88rem; color: var(--muted); margin-bottom: 20px;">${d.warnings.map(w => '• ' + esc(w)).join('<br>')}</div>` : ''}
        <a class="btn btn-primary" href="/">Thử lại với phiên mới</a>
      </div>`;
  }

  // ---------- Main render ----------
  function render() {
    const s = SESSION;
    const r = s.result || {};
    const cv = s.cv || {};
    const jd = s.jd;

    document.getElementById('hdTitle').textContent = cv.candidateName || 'Phiên phân tích';
    document.getElementById('hdSub').textContent = `${cv.candidateTitle || s.meta?.targetRole || ''} · ${s.meta?.experienceLevel || ''} · ${jd ? 'JD: ' + (jd.title || '') : 'Không có JD'}`;

    const tabs = [
      ['overview', 'Tổng quan', true],
      ['match', 'Đối chiếu JD', !!jd],
      ['roadmap', 'Lộ trình', !!(r.roadmap && r.roadmap.length)],
      ['rewrite', 'Viết lại CV', true],
      ['chat', 'Chat Coach', true],
      ['interview', 'Phỏng vấn giả lập', true],
      ['cover', 'Cover Letter', true],
      ['cv', 'CV gốc', true],
    ].filter(t => t[2]);

    app.innerHTML = `
      ${renderHero()}
      <div class="tabs mb-6" role="tablist">
        ${tabs.map(([id, label], i) => `
          <button class="tab ${i === 0 ? 'active' : ''}" data-tab="${id}" role="tab">${esc(label)}</button>`).join('')}
      </div>
      <div id="tabContent"></div>`;

    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        HMCenterTab(btn);
        renderTab(btn.dataset.tab);
      });
    });
    // Hero compact: bấm stat → nhảy đúng tab phân tích; nút mở tóm tắt + kỹ năng
    document.querySelectorAll('.hc-stat').forEach(btn => btn.addEventListener('click', () => {
      document.querySelector(`[data-tab="${btn.dataset.go}"]`)?.click();
    }));
    const hct = document.getElementById('hcToggle');
    if (hct) hct.addEventListener('click', () => {
      const ex = document.getElementById('hcExtra');
      const nowHidden = ex.classList.toggle('hidden');
      hct.classList.toggle('open', !nowHidden);
      hct.setAttribute('aria-expanded', String(!nowHidden));
    });
    renderTab('overview');
  }

  function renderHero() {
    // Hero COMPACT — chiếm ít diện tích (đặc biệt mobile): tên + 3 ô stat bấm được
    // nhảy đúng tab; tóm tắt dài + chip kỹ năng + disclaimer gói vào nút mở rộng.
    // Chi tiết đầy đủ (hire panel, ATS từng yêu cầu) nằm trong tab, không lặp ở đây.
    const r = SESSION.result, cv = SESSION.cv, jd = SESSION.jd;
    const v = VERDICT[r.match?.verdict] || null;
    const ha = hireAssess();
    const pv = PASS_VERDICT[ha.verdict] || PASS_VERDICT.uncertain;
    const stats = [
      { num: r.overallScore || 0, unit: '/100', lbl: 'Điểm CV', bar: true, tab: 'overview' },
      // Nhãn do AI tự viết (verdictLabel) — session cũ không có thì fallback mapping cố định
      ...(jd && r.match ? [{ num: r.match.matchScore, unit: '/100', lbl: 'Khớp ATS' + (r.match.verdictLabel ? ` · ${r.match.verdictLabel}` : v ? ` · ${v.label}` : ''), tab: 'match' }] : []),
      { num: ha.passProbability, unit: '%', lbl: ha.verdictLabel || pv.label, cls: 'pass-' + (ha.verdict || 'uncertain').replace('_', '-'), tab: 'overview', tip: `${pv.emoji} ${ha.headline || 'Khả năng đậu phỏng vấn — xem phân tích ở tab Tổng quan'}` },
    ];
    const hasExtra = !!r.summary || (cv.extractedSkills || []).length > 0;
    return `
      <div class="result-hero hero-compact grad-border">
        <div class="hc-main">
          <div class="hc-id">
            <div class="rh-name">${esc(cv.candidateName || 'Ứng viên')}</div>
            <div class="rh-title">${esc(cv.candidateTitle || SESSION.meta?.targetRole || '')}${cv.experienceYears ? ` · ${cv.experienceYears} năm KN` : ''}</div>
          </div>
          <div class="hc-stats">
            ${stats.map(st => `
              <button class="hc-stat ${st.cls || ''}" data-go="${st.tab}" ${st.tip ? `data-tip="${esc(st.tip)}"` : ''} aria-label="${esc(st.lbl)}">
                <span class="hs-num"><span data-count="${st.num}">0</span><span class="hs-unit">${st.unit}</span></span>
                <span class="hs-lbl">${esc(st.lbl)}</span>
                ${st.bar ? `<span class="hs-bar"><i data-target="${st.num}"></i></span>` : ''}
              </button>`).join('')}
          </div>
          ${hasExtra ? `
          <button class="hc-toggle" id="hcToggle" aria-expanded="false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            <span>Tóm tắt &amp; kỹ năng</span>
          </button>` : ''}
        </div>
        ${hasExtra ? `
        <div class="hc-extra hidden" id="hcExtra">
          ${r.summary ? `<p class="hc-sum-text">${esc(r.summary)}</p>` : ''}
          ${(cv.extractedSkills || []).length ? `<div class="rh-chips">${cv.extractedSkills.slice(0, 8).map(sk => `<span class="badge badge-indigo">${esc(sk)}</span>`).join('')}</div>` : ''}
          <div class="ai-disclaimer" style="margin-top: 12px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
            Đánh giá của AI — chỉ mang tính tham khảo, không đảm bảo kết quả tuyển dụng thực tế.
          </div>
        </div>` : ''}
      </div>`;
  }

  // ---------- Tabs ----------
  // Panes cached: switching tabs keeps the rendered panel + its polls alive in the
  // background, so Chat/Interview/Cover Letter never lose state when you come back.
  const tabPanes = {}; // id -> element
  let activeTab = null;
  const tabContent = () => document.getElementById('tabContent');

  function renderTab(id) {
    if (activeTab === id) return;
    if (activeTab && tabPanes[activeTab]) tabPanes[activeTab].classList.add('hidden');
    activeTab = id;
    let pane = tabPanes[id];
    if (!pane) {
      const renderers = {
        overview: renderOverview,
        match: renderMatch,
        roadmap: renderRoadmap,
        rewrite: renderRewrite,
        chat: renderChat,
        interview: renderInterview,
        cover: renderCover,
        cv: renderCV,
      };
      pane = document.createElement('div');
      pane.className = 'tab-pane no-anim';
      pane.innerHTML = (renderers[id] || renderOverview)();
      tabContent().appendChild(pane);
      tabPanes[id] = pane;
      // Init logic chỉ chạy 1 lần trong đời pane
      if (id === 'chat') initChat();
      if (id === 'interview') initInterview();
      if (id === 'cover') initCover();
      if (id === 'rewrite') initRewrite();
      if (id === 'cv') initCv();
    }
    pane.classList.remove('hidden');
    if (id === 'overview') {
      // Màu hire panel theo mức đậu
      const ha0 = hireAssess();
      const colorMap = { very_likely: 'var(--accent)', likely: 'var(--accent)', uncertain: 'var(--warn)', unlikely: '#e11d48', very_unlikely: 'var(--danger)' };
      app.style.setProperty('--hire-color', colorMap[ha0.verdict] || 'var(--danger)');
      animateScores();
    }
    const hqBtn = pane.querySelector('#btnPracticeHQ');
    if (hqBtn && !hqBtn.dataset.wired) {
      hqBtn.dataset.wired = '1';
      hqBtn.addEventListener('click', () => {
        window.__ivPrepMode = true;
        document.querySelector('[data-tab="interview"]').click();
      });
    }
  }

  function animateScores() {
    // pill bars + hero mini bars
    document.querySelectorAll('.sp-bar .fill[data-target], .hs-bar i[data-target]').forEach(bar => {
      if (bar.dataset.animated) { bar.style.width = (+bar.dataset.target) + '%'; return; }
      bar.dataset.animated = '1';
      requestAnimationFrame(() => { bar.style.width = (+bar.dataset.target) + '%'; });
    });
    // count-up numbers
    document.querySelectorAll('[data-count]').forEach(el => {
      if (el.dataset.animated) return; // đã chạy — giữ nguyên số, không re-animate
      el.dataset.animated = '1';
      const target = +el.dataset.count;
      const dur = 1100, t0 = performance.now();
      (function tick(t) {
        const p = Math.min(1, (t - t0) / dur);
        el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    });
  }

  // ----- Overview -----
  function renderOverview() {
    const r = SESSION.result;
    const ha = hireAssess();
    const pv = PASS_VERDICT[ha.verdict] || PASS_VERDICT.uncertain;
    const bd = r.breakdown || {};
    const bdRows = [
      ['content', 'Nội dung'], ['format', 'Trình bày'], ['relevance', 'Liên quan vị trí'], ['impact', 'Tác động'],
    ];
    // Phiên kiểm chứng (nạp lại CV đã chỉnh) — panel so sánh điểm với phiên gốc.
    // parentSessionId nằm ở top-level của session (server đặt khi reupload).
    const parentId = SESSION.parentSessionId || SESSION.meta?.parentSessionId;
    const cmpMount = parentId ? '<div class="mb-6" id="cmpMount"></div>' : '';
    if (parentId) loadCompare(parentId);
    return `
      ${cmpMount}
      ${(ha.headline || (ha.reasons && ha.reasons.length)) ? `
      <div class="panel mb-6 hire-panel">
        <div class="hire-head">
          <div class="hire-pct-wrap">
            <div class="hire-pct" style="color: var(--hire-color, var(--danger));"><span data-count="${ha.passProbability}">0</span>%</div>
            <div class="hire-pct-sub">khả năng đậu</div>
          </div>
          <div class="hire-body">
            <div class="hire-headline"><span class="pg-emoji">${pv.emoji}</span> ${esc(ha.headline || `Khả năng đậu phỏng vấn: ${ha.passProbability}% — ${pv.label.toLowerCase()}`)}</div>
            ${(ha.reasons || []).length ? `<div class="hire-reasons">${ha.reasons.map(x => `<div class="flag-item"><div class="flag-dot" style="background: var(--hire-color, var(--danger));"></div><div>${esc(x)}</div></div>`).join('')}</div>` : ''}
            ${(ha.whatWouldRaise || []).length ? `
              <div class="hire-raise">
                <div class="field-label" style="margin-bottom: 6px; color: var(--accent);">📈 Muốn tăng tỉ lệ này?</div>
                ${ha.whatWouldRaise.map(x => `<div class="flag-item"><div class="flag-dot" style="background: var(--accent);"></div><div>${esc(x)}</div></div>`).join('')}
              </div>` : ''}
            <div class="ai-disclaimer" style="margin-top: 12px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
              Ước lượng do AI đưa ra dựa trên CV &amp; JD — chỉ để tham khảo.
            </div>
          </div>
        </div>
      </div>` : ''}

      ${(r.alternativePaths && r.alternativePaths.length) ? `
      <div class="panel mb-6 alt-paths-panel">
        <div class="panel-title">
          <span class="pt-icon amber"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20"/><circle cx="12" cy="12" r="10"/></svg></span>
          Cân nhắc hướng đi khác phù hợp hơn
        </div>
        <p class="muted" style="margin-bottom: 14px;">Dựa trên CV hiện tại, AI thấy những vị trí này tận dụng tốt hơn thế mạnh của bạn:</p>
        <div class="alt-paths">
          ${r.alternativePaths.map(p => `
          <div class="alt-path-card">
            <div class="ap-head">
              <div class="ap-role">${esc(p.role || 'Vị trí đề xuất')}</div>
              ${typeof p.fitScore === 'number' ? `<div class="ap-fit" style="color: ${p.fitScore >= 60 ? 'var(--success, #16a34a)' : 'var(--warning, #d97706)'};">${p.fitScore}% phù hợp</div>` : ''}
            </div>
            <div class="ap-why">${esc(p.why || '')}</div>
            ${p.note ? `<div class="ap-note">📌 ${esc(p.note)}</div>` : ''}
          </div>`).join('')}
        </div>
        <div class="ai-disclaimer" style="margin-top: 12px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
          Gợi ý hướng đi do AI đề xuất dựa trên CV — hãy cân nhắc với mục tiêu cá nhân của bạn.
        </div>
      </div>` : ''}

      <div class="grid-2">
        <div class="panel">
          <div class="panel-title">
            <span class="pt-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 4 3 5-6"/></svg></span>
            Điểm theo tiêu chí
          </div>
          ${bdRows.map(([k, label]) => `
            <div class="bd-row">
              <div class="bd-lbl">${label}</div>
              <div class="progress-track"><div class="progress-fill" style="width: ${bd[k] || 0}%; transition-delay: 0.1s;"></div></div>
              <div class="bd-val">${bd[k] ?? '—'}</div>
            </div>`).join('')}
        </div>
        <div class="panel">
          <div class="panel-title">
            <span class="pt-icon red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4m0 4h.01"/></svg></span>
            Red flags ATS
            <span class="count">${(r.atsRedFlags || []).length}</span>
          </div>
          ${(r.atsRedFlags || []).length ? (r.atsRedFlags || []).map(f => `
            <div class="flag-item"><div class="flag-dot"></div><div>${esc(f)}</div></div>`).join('')
            : '<p class="muted">Không phát hiện red flags — tốt!</p>'}
        </div>
        <div class="panel">
          <div class="panel-title">
            <span class="pt-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
            Điểm mạnh
            <span class="count">${(r.strengths || []).length}</span>
          </div>
          ${(r.strengths || []).map(st => `
            <div class="sw-item pos">
              <div class="sw-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
              <div class="sw-body">
                <div class="sw-point">${esc(st.point)}</div>
                ${st.evidence ? `<div class="sw-evidence">"${esc(st.evidence)}"</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
        <div class="panel">
          <div class="panel-title">
            <span class="pt-icon red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span>
            Điểm yếu &amp; cách sửa
            <span class="count">${(r.weaknesses || []).length}</span>
          </div>
          ${(r.weaknesses || []).map(w => `
            <div class="sw-item neg">
              <div class="sw-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></div>
              <div class="sw-body">
                <div class="sw-point">${esc(w.point)}</div>
                ${w.evidence ? `<div class="sw-evidence">"${esc(w.evidence)}"</div>` : ''}
                ${w.fix ? `<div class="sw-fix"><strong>Cách sửa:</strong> ${esc(w.fix)}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="panel mt-6">
        <div class="panel-title">
          <span class="pt-icon amber"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg></span>
          Gợi ý cải thiện (ưu tiên theo tác động)
          <span class="count">${(r.improvements || []).length}</span>
        </div>
        ${(r.improvements || []).map(im => `
          <div class="imp-item">
            <span class="imp-pri badge ${im.priority === 'high' ? 'badge-red' : im.priority === 'medium' ? 'badge-amber' : 'badge-sky'}">${im.priority === 'high' ? 'Ưu tiên cao' : im.priority === 'medium' ? 'Nên làm' : 'Nên có'}</span>
            <div class="imp-body">
              <div class="imp-title">${esc(im.title)}</div>
              <div class="imp-detail">${esc(im.detail)}</div>
              ${im.impact ? `<div class="imp-impact"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:3px"><path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>${esc(im.impact)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>

      <div class="panel mt-6">
        <div class="panel-title">
          <span class="pt-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>
          3 câu hỏi phỏng vấn khó nhất có thể gặp
        </div>
        ${(r.hardQuestions || []).map((q, i) => `
          <div class="hq-item"><div class="hq-num">${i + 1}</div><div class="hq-q">${esc(q)}</div></div>`).join('')}
        <div class="hq-cta">
          <button class="btn btn-primary" id="btnPracticeHQ">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg>
            Luyện trả lời các câu hỏi này với AI Interviewer
          </button>
          <span class="hq-cta-note">AI sẽ đóng vai nhà tuyển dụng, chờ bạn nói "sẵn sàng" mới bắt đầu hỏi</span>
        </div>
      </div>`;
  }

  // ----- JD Match -----
  function renderMatch() {
    const jd = SESSION.jd, r = SESSION.result;
    if (!jd || !r.match) return '<div class="panel text-center muted">Phiên này không có tin tuyển dụng để đối chiếu.</div>';
    const m = r.match;
    const sevBadge = s => s === 'critical' ? '<span class="badge badge-red">Thiếu nghiêm trọng</span>' : s === 'important' ? '<span class="badge badge-amber">Thiếu quan trọng</span>' : '<span class="badge badge-sky">Thiếu (nên có)</span>';
    return `
      <div class="panel mb-6">
        <div class="panel-title">
          <span class="pt-icon sky"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15h6M9 11h2"/></svg></span>
          Tin tuyển dụng mục tiêu
        </div>
        <div class="grid-2">
          <div>
            <div style="font-family: var(--font-head); font-weight: 700; font-size: 1.15rem;">${esc(jd.title || '')}</div>
            <div class="muted mt-2">${esc([jd.company, jd.location, jd.salary].filter(Boolean).join(' · ') || '')}</div>
            ${jd.experienceRequired ? `<div class="mt-2 small muted">Kinh nghiệm yêu cầu: <strong>${esc(jd.experienceRequired)}</strong></div>` : ''}
          </div>
          <div>
            <div class="field-label" style="margin-bottom: 6px;">Yêu cầu bắt buộc (${(jd.mustHave || []).length})</div>
            ${(jd.mustHave || []).slice(0, 6).map(x => `<div class="small" style="margin-bottom: 3px;">• ${esc(x)}</div>`).join('')}
          </div>
        </div>
        ${SESSION.jdNotice ? `<div class="leave-note mt-4" style="width: 100%;"><span>${esc(SESSION.jdNotice)}</span></div>` : ''}
      </div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-title">
            <span class="pt-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
            Đã đáp ứng
            <span class="count">${(m.matched || []).length}</span>
          </div>
          ${(m.matched || []).map(x => `
            <div class="match-req">
              <div class="match-icon ok"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
              <div class="match-body">
                <div class="m-req">${esc(x.requirement)}</div>
                ${x.evidence ? `<div class="m-ev">CV: "${esc(x.evidence)}"</div>` : ''}
              </div>
            </div>`).join('') || '<p class="muted">Không có mục nào được đánh dấu đáp ứng.</p>'}
        </div>
        <div class="panel">
          <div class="panel-title">
            <span class="pt-icon red"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span>
            Còn thiếu
            <span class="count">${(m.missing || []).length}</span>
          </div>
          ${(m.missing || []).map(x => `
            <div class="match-req">
              <div class="match-icon miss"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></div>
              <div class="match-body">
                <div class="m-req">${esc(x.requirement)}</div>
                ${x.note ? `<div class="m-note">${esc(x.note)}</div>` : ''}
                <div class="m-sev">${sevBadge(x.severity)}</div>
              </div>
            </div>`).join('') || '<p class="muted">Không có mục nào còn thiếu — hoàn hảo!</p>'}
        </div>
      </div>

      ${(m.extraPoints && m.extraPoints.length) ? `
      <div class="panel mt-6">
        <div class="panel-title">
          <span class="pt-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/></svg></span>
          Điểm cộng ngoài JD (lợi thế của bạn)
        </div>
        ${m.extraPoints.map(x => `<div class="flag-item"><div class="flag-dot" style="background: var(--accent);"></div><div>${esc(x)}</div></div>`).join('')}
      </div>` : ''}`;
  }

  // ----- Roadmap -----
  function renderRoadmap() {
    const rm = SESSION.result.roadmap || [];
    if (!rm.length) return '<div class="panel text-center muted">Không có lộ trình (phiên này không có JD đối chiếu).</div>';
    const priBadge = p => p === 'high' ? '<span class="badge badge-red">Ưu tiên cao</span>' : p === 'medium' ? '<span class="badge badge-amber">Nên học</span>' : '<span class="badge badge-sky">Bổ trợ</span>';
    return `
      <div class="panel">
        <div class="panel-title">
          <span class="pt-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg></span>
          Lộ trình lấp khoảng trống kỹ năng
          <span class="count">${rm.length} bước</span>
        </div>
        <div class="roadmap">
          ${rm.map(st => `
            <div class="rm-step">
              <div class="rm-dot">${st.step || ''}</div>
              <div class="rm-head">
                <span class="rm-skill">${esc(st.skill)}</span>
                ${priBadge(st.priority)}
                ${st.duration ? `<span class="rm-dur"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>${esc(st.duration)}</span>` : ''}
              </div>
              ${st.why ? `<div class="rm-why">${esc(st.why)}</div>` : ''}
              ${st.how ? `<div class="rm-how"><strong>Cách học:</strong> ${esc(st.how)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
  }

  // ----- So sánh trước/sau (phiên kiểm chứng nạp CV đã chỉnh) -----
  async function loadCompare(parentId) {
    try {
      const res = await fetch(`/api/session/${parentId}`);
      if (!res.ok) return;
      const p = await res.json();
      const mount = document.getElementById('cmpMount');
      if (!mount) return;
      const pr = p.result || {}, nr = SESSION.result || {};
      const passFallback = s => Math.max(2, Math.min(95, Math.round((s.overallScore || 0) * 0.9)));
      const ph = pr.hireAssessment?.passProbability ?? passFallback(pr);
      const nh = nr.hireAssessment?.passProbability ?? passFallback(nr);
      const rows = [['Điểm CV', pr.overallScore, nr.overallScore, '/100']];
      if (pr.match && nr.match) rows.push(['Điểm khớp ATS', pr.match.matchScore, nr.match.matchScore, '/100']);
      rows.push(['Khả năng đậu', ph, nh, '%']);
      mount.innerHTML = `
        <div class="panel cmp-panel">
          <div class="panel-title">
            <span class="pt-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
            Kiểm chứng lại sau khi chỉnh CV
            ${p.cv?.candidateName ? `<span class="count">so với phiên gốc</span>` : ''}
          </div>
          <div class="cmp-rows">
            ${rows.map(([label, oldV, newV, unit]) => {
              const d = (newV ?? 0) - (oldV ?? 0);
              const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
              const arrow = d > 0 ? '↑' : d < 0 ? '↓' : '→';
              const sign = d > 0 ? '+' : '';
              return `<div class="cmp-row">
                <div class="cmp-lbl">${label}</div>
                <div class="cmp-vals">
                  <span class="cmp-old">${oldV ?? '—'}${unit}</span>
                  <span class="cmp-arrow">→</span>
                  <span class="cmp-new">${newV ?? '—'}${unit}</span>
                  <span class="cmp-delta cmp-${cls}">${arrow} ${sign}${d}</span>
                </div>
              </div>`;
            }).join('')}
          </div>
          <div class="cmp-foot">
            <a class="btn btn-ghost btn-sm" href="/s/${parentId}">Xem phiên gốc</a>
            <span class="small muted">AI chấm lại trên cùng vị trí &amp; JD — điểm chênh lệch chỉ mang tính tham khảo.</span>
          </div>
        </div>`;
    } catch { /* phiên gốc không đọc được — bỏ qua panel */ }
  }

  // ----- CV Rewrite & Reshape -----
  const RW_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>';

  function renderRewrite() {
    const hasJd = !!SESSION.jd;
    return `
      <div class="panel">
        <div class="panel-title">
          <span class="pt-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg></span>
          Viết lại CV — "may đo" theo vị trí nhắm tới
          <span class="count">AI tham khảo — bạn kiểm tra lại</span>
        </div>
        <p class="muted" style="margin-bottom: 14px;">Chọn chế độ viết lại, AI dựa trên toàn bộ phân tích${hasJd ? ` và tin tuyển dụng <strong>${esc(SESSION.jd.title || '')}</strong>` : ''} để làm lại CV của bạn. Kết quả là <strong>đề xuất tham khảo</strong> — hãy đọc kỹ và đánh giá lại trước khi dùng.</p>
        <div class="rw-modes">
          <label class="rw-mode"><input type="radio" name="rwMode" value="reshape" checked><span class="rwm-body"><strong>Cấu trúc &amp; làm nổi bật</strong><small>Sắp xếp lại, diễn lại câu yếu, cắt chi tiết thừa — không thêm gì mới vào CV</small></span></label>
          <label class="rw-mode"><input type="radio" name="rwMode" value="addskills"><span class="rwm-body"><strong>Bổ sung kỹ năng còn thiếu</strong><small>Thêm mục "Kỹ năng đang bổ sung" từ các gap — kèm ghi chú trung thực, bạn tự xác nhận</small></span></label>
        </div>
        ${!hasJd ? '<div class="leave-note mb-4">Phiên này không có JD — CV sẽ được tối ưu theo vị trí bạn đã điền. Tạo phiên mới kèm link/dán JD để được "may đo" sát hơn.</div>' : ''}
        <div class="rw-actions-bar">
          <button class="btn btn-primary" id="rwGen">${RW_ICON} ${SESSION.rewrite ? 'Viết lại từ đầu' : 'Viết lại CV'}</button>
          <span class="small muted">Tốn 1 lượt AI (~1 phút) · kết quả lưu tự động</span>
        </div>
        <div id="rwResult"></div>
      </div>`;
  }

  function initRewrite() {
    const btn = $('#rwGen'), out = $('#rwResult');
    let pollTimer = null;

    const pendingHtml = mode => `<div class="text-center muted" style="padding: 36px 0;"><span class="typing-dots"><span></span><span></span><span></span></span><div class="mt-3">AI đang ${mode === 'addskills' ? 'bổ sung kỹ năng & ' : ''}viết lại CV... (bạn có thể rời đi — quay lại sẽ thấy kết quả)</div></div>`;

    function renderResult(d) {
      const TYPE = {
        reorder: ['badge-indigo', 'Sắp xếp lại'],
        rephrase: ['badge-sky', 'Diễn lại'],
        emphasize: ['badge-green', 'Nhấn mạnh'],
        format: ['badge-amber', 'Định dạng'],
        add: ['badge-rose', 'Bổ sung'],
      };
      const mode = d.mode || SESSION.rewriteMode || 'reshape';
      out.innerHTML = `
        ${d.note ? `<div class="rw-note">${esc(d.note)}</div>` : ''}
        ${mode === 'addskills' ? `<div class="leave-note" style="background: var(--warn-soft); color: var(--warn); width: 100%; margin-bottom: 14px;"><strong>⚠ Chế độ bổ sung kỹ năng — ý kiến AI chỉ mang tính tham khảo:</strong> chỉ giữ những kỹ năng bạn thực sự có hoặc đang học; nhà tuyển dụng sẽ hỏi sâu về mọi kỹ năng ghi trong CV.</div>` : ''}
        <div class="rw-section-label">① Bản CV đã viết lại</div>
        <div class="rw-cv md-wrap">${md(d.rewrittenCv || '(trống)')}</div>
        <div class="rw-section-label mt-6">② Thay đổi đáng chú ý <span class="count">${(d.changes || []).length}</span></div>
        <div class="rw-changes">
          ${(d.changes || []).map(c => {
            const tm = TYPE[c.type] || ['badge-indigo', 'Chỉnh'];
            return `<div class="chg-item">
              <div class="chg-head"><span class="badge ${tm[0]}">${tm[1]}</span><strong>${esc(c.where || '')}</strong></div>
              ${(c.before || c.after) ? `<div class="chg-ba"><span class="chg-before">${esc(c.before || '')}</span><span class="chg-arrow">→</span><span class="chg-after">${esc(c.after || '')}</span></div>` : ''}
              ${c.why ? `<div class="chg-why">${esc(c.why)}</div>` : ''}
            </div>`;
          }).join('') || '<p class="muted">Không có danh sách thay đổi.</p>'}
        </div>
        ${(d.unfixableGaps || []).length ? `
        <div class="rw-section-label mt-6">③ Không sửa được bằng viết lại — phải học thêm</div>
        <div class="panel mt-2" style="background: var(--warn-soft); border-color: rgba(217,119,6,0.2); padding: 14px 16px;">
          ${d.unfixableGaps.map(g => `<div class="flag-item"><div class="flag-dot" style="background: var(--warn);"></div><div><strong>${esc(g.skill || '')}</strong>${g.why ? ` — ${esc(g.why)}` : ''}</div></div>`).join('')}
          <button class="btn btn-soft btn-sm mt-2" id="rwGoRoadmap">Xem lộ trình lấp khoảng trống</button>
        </div>` : ''}
        <div class="rw-actions mt-6">
          <button class="btn btn-soft btn-sm" id="rwCopy">Copy CV mới</button>
          <button class="btn btn-soft btn-sm" id="rwDocx">⬇ Xuất Word (.docx)</button>
          <input type="file" id="rwFile" accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.webp" multiple hidden>
          <button class="btn btn-primary btn-sm" id="rwReupload" title="Nạp CV mới (sau khi bạn chỉnh thêm nếu muốn) để AI chấm lại trên cùng vị trí — xem điểm tăng bao nhiêu">Nạp CV mới kiểm chứng…</button>
        </div>
        ${d.cached ? '<div class="small muted mt-2">↩ Kết quả đã tạo trước đó. Bấm "Viết lại từ đầu" để tạo lại (sẽ tốn 1 lượt AI mới).</div>' : ''}
        <div class="ai-disclaimer mt-4">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
          CV do AI viết lại từ CV gốc — ý kiến chỉ mang tính tham khảo; hãy đọc kỹ, kiểm chứng và đánh giá lại trước khi gửi nhà tuyển dụng.
        </div>`;
      $('#rwCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(d.rewrittenCv || ''); toast('Đã copy CV mới'); } catch { toast('Không copy được'); }
      });
      $('#rwDocx').addEventListener('click', () => exportCvDocx(d.rewrittenCv || '', SESSION.cv?.candidateName || 'CV'));
      $('#rwGoRoadmap')?.addEventListener('click', () => document.querySelector('[data-tab="roadmap"]')?.click());
      $('#rwReupload').addEventListener('click', () => $('#rwFile').click());
      $('#rwFile').addEventListener('change', async () => {
        const files = $('#rwFile').files;
        if (!files.length) return;
        const rbtn = $('#rwReupload');
        rbtn.disabled = true;
        rbtn.textContent = 'Đang nạp...';
        try {
          const fd = new FormData();
          for (const f of files) fd.append('files', f);
          const res = await fetch(`/api/session/${sessionId}/reupload`, { method: 'POST', body: fd });
          const dd = await res.json();
          if (dd.error) { toast(dd.error); rbtn.disabled = false; rbtn.textContent = 'Nạp CV mới kiểm chứng…'; }
          else { toast('Đã tạo phiên kiểm chứng — đang chuyển trang...'); setTimeout(() => { location.href = dd.url; }, 700); }
        } catch {
          toast('Lỗi kết nối — thử lại');
          rbtn.disabled = false;
          rbtn.textContent = 'Nạp CV mới kiểm chứng…';
        }
        $('#rwFile').value = '';
      });
    }

    if (SESSION.rewrite) {
      renderResult({ ...SESSION.rewrite, cached: true, mode: SESSION.rewriteMode });
    } else if (SESSION.rewritePending) {
      btn.disabled = true;
      out.innerHTML = pendingHtml(SESSION.rewriteMeta);
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/session/${sessionId}`);
          const s = await res.json();
          if (!s.rewritePending) {
            clearInterval(pollTimer); pollTimer = null;
            btn.disabled = false;
            if (s.rewrite) { renderResult({ ...s.rewrite, cached: false, mode: s.rewriteMode }); SESSION.rewrite = s.rewrite; SESSION.rewriteMode = s.rewriteMode; }
            else out.innerHTML = '';
          }
        } catch { /* poll tiếp */ }
      }, 2500);
    }

    btn.addEventListener('click', async () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      btn.disabled = true;
      const mode = document.querySelector('input[name="rwMode"]:checked')?.value || 'reshape';
      out.innerHTML = pendingHtml(mode);
      try {
          const res = await fetch(`/api/session/${sessionId}/rewrite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          });
          const d = await res.json();
          if (d.error) {
            out.innerHTML = `<div class="leave-note" style="background: var(--danger-soft); color: var(--danger); width: 100%;">⚠ ${esc(d.error)}</div>`;
          } else {
            renderResult(d);
            SESSION.rewrite = d;
            SESSION.rewriteMode = d.mode;
            btn.innerHTML = `${RW_ICON} Viết lại từ đầu`;
          }
        } catch {
          out.innerHTML = '<div class="leave-note" style="background: var(--danger-soft); color: var(--danger); width: 100%;">⚠ Lỗi kết nối — CV có thể vẫn đang được viết, quay lại tab sau ít phút.</div>';
        }
        btn.disabled = false;
    });
  }

  // ----- Chat -----
  function renderChat() {
    return `
      <div class="panel">
        <div class="panel-title">
          <span class="pt-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          Coach AI — hỏi bất cứ điều gì về CV &amp; JD của bạn
          <span class="count">lưu tự động</span>
        </div>
        <div class="chat-wrap">
          <div class="chat-log" id="chatLog"></div>
          <div class="img-attachments hidden" id="imgAtts"></div>
          <div class="chat-inputbar">
            <input type="file" id="chatImgInput" accept=".jpg,.jpeg,.png,.webp" multiple hidden>
            <button class="icon-btn attach-btn" id="chatAttach" title="Đính kèm ảnh (CV mới, screenshot...)" aria-label="Đính kèm ảnh" style="width: 46px; height: 46px; flex-shrink: 0;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            </button>
            <input class="input" id="chatInput" placeholder="Nhập câu hỏi... (Enter để gửi, có thể đính kèm ảnh)" autocomplete="off">
            <button class="btn btn-primary" id="chatSend">Gửi</button>
            <button class="btn btn-ghost btn-sm" id="chatExport" title="Xuất hội thoại ra Word" style="flex-shrink: 0;">⬇ Word</button>
          </div>
        </div>
      </div>`;
  }

  function initChat() {
    const log = $('#chatLog'), input = $('#chatInput'), send = $('#chatSend');
    const imgInput = $('#chatImgInput'), attachBtn = $('#chatAttach'), attsBar = $('#imgAtts');
    let busy = false;
    let pendingImgs = []; // { base64, mime, dataUrl }
    let pendingPoll = null;

    // Restore lịch sử từ server (session.chatHistory) — không mất khi đổi tab/reload
    chatHistory = (SESSION.chatHistory || []).slice();
    if (chatHistory.length) {
      for (let i = 0; i < chatHistory.length; i += 2) {
        const u = chatHistory[i], a = chatHistory[i + 1];
        if (u && a) {
          log.appendChild(mdBubble('user', u?.content || '', null));
          log.appendChild(mdBubble('ai', a.content || ''));
        }
      }
    } else {
      log.appendChild(mdBubble('ai', `Chào bạn! 👋 Mình đã đọc kỹ CV${SESSION.jd ? ` và tin tuyển dụng **${SESSION.jd.title || ''}**` : ''} của bạn. Hỏi mình bất cứ điều gì — ví dụ: *"mình nên bỏ mục nào?"*, *"viết lại mục tiêu nghề nghiệp giúp mình"*, *"mình cần học gì để đạt JD này?"* — hoặc đính kèm ảnh để mình xem.`));
    }

    // AI đang xử lý tin nhắn cuối (user rời tab khi chờ) → hiện typing + poll đến khi có reply
    const lastIsUser = chatHistory.length && chatHistory[chatHistory.length - 1].role === 'user';
    if (SESSION.chatPending && lastIsUser) {
      const typing = typingBubble();
      log.appendChild(typing.wrap);
      log.scrollTop = log.scrollHeight;
      input.disabled = true; send.disabled = true;
      pendingPoll = setInterval(async () => {
        try {
          const res = await fetch(`/api/session/${sessionId}`);
          const s = await res.json();
          if (!s.chatPending && s.chatHistory?.length > chatHistory.length) {
            clearInterval(pendingPoll);
            typing.wrap.remove();
            input.disabled = false; send.disabled = false;
            chatHistory = s.chatHistory;
            log.appendChild(mdBubble('ai', chatHistory[chatHistory.length - 1].content || ''));
            log.scrollTop = log.scrollHeight;
            input.focus();
          }
        } catch { /* server tạm lỗi — poll tiếp */ }
      }, 2500);
    }

    log.scrollTop = log.scrollHeight;

    attachBtn.addEventListener('click', () => imgInput.click());
    imgInput.addEventListener('change', () => {
      for (const f of imgInput.files) {
        if (pendingImgs.length >= 3) { toast('Tối đa 3 ảnh mỗi câu'); break; }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const base64 = dataUrl.split(',')[1];
          const mime = f.type || 'image/png';
          pendingImgs.push({ base64, mime, dataUrl });
          renderAtts();
        };
        reader.readAsDataURL(f);
      }
      imgInput.value = '';
    });
    function renderAtts() {
      attsBar.innerHTML = '';
      attsBar.classList.toggle('hidden', !pendingImgs.length);
      pendingImgs.forEach((im, i) => {
        const el = document.createElement('div');
        el.className = 'att';
        el.innerHTML = `<img src="${im.dataUrl}" alt=""><button class="rm" aria-label="Xoá ảnh">✕</button>`;
        el.querySelector('.rm').addEventListener('click', () => { pendingImgs.splice(i, 1); renderAtts(); });
        attsBar.appendChild(el);
      });
    }

    async function sendMsg() {
      const msg = input.value.trim();
      if ((!msg && !pendingImgs.length) || busy) return;
      busy = true;
      const imgs = pendingImgs.slice();
      input.value = '';
      pendingImgs = [];
      renderAtts();
      log.appendChild(mdBubble('user', msg || '[ảnh]', imgs));
      log.scrollTop = log.scrollHeight;
      const typing = typingBubble();
      log.appendChild(typing.wrap);
      log.scrollTop = log.scrollHeight;
      try {
        const res = await fetch(`/api/session/${sessionId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, images: imgs.map(i => ({ base64: i.base64, mime: i.mime })) }),
        });
        const d = await res.json();
        typing.wrap.remove();
        if (d.error) { log.appendChild(mdBubble('ai', '⚠ ' + d.error)); }
        else {
          log.appendChild(mdBubble('ai', d.reply));
          chatHistory = d.history || chatHistory;
        }
      } catch {
        typing.wrap.remove();
        log.appendChild(mdBubble('ai', '⚠ Mạng lỗi — thử gửi lại nhé.'));
      }
      log.scrollTop = log.scrollHeight;
      busy = false;
      input.focus();
    }
    send.addEventListener('click', sendMsg);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });

    $('#chatExport').addEventListener('click', () => {
      const mdText = chatHistory
        .map((m, i) => {
          if (m.role === 'user') return `### ❓ Bạn\n\n${m.content}`;
          return `### 💡 Coach\n\n${m.content}`;
        })
        .join('\n\n---\n\n');
      if (!mdText) { toast('Chưa có hội thoại để xuất'); return; }
      exportDocx('Hội thoại với HireMind Coach', mdText, 'hiremind-chat.docx');
    });
  }

  function mdBubble(who, text, images) {
    const el = document.createElement('div');
    el.className = `chat-msg ${who}`;
    el.innerHTML = `<div class="chat-avatar">${who === 'ai' ? 'AI' : 'Bạn'}</div><div class="msg-body" style="min-width:0;"></div>`;
    const body = el.querySelector('.msg-body');
    if (images && images.length) {
      const imgsWrap = document.createElement('div');
      imgsWrap.className = 'msg-images';
      for (const im of images) {
        const img = document.createElement('img');
        img.src = im.dataUrl;
        img.alt = 'Ảnh đính kèm';
        img.loading = 'lazy';
        // Lightbox qua delegate trong effects.js (.msg-images img)
        imgsWrap.appendChild(img);
      }
      body.appendChild(imgsWrap);
    }
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble' + (who === 'ai' ? ' md-wrap' : '');
    if (who === 'ai') bubble.innerHTML = md(text);
    else bubble.textContent = text || '';
    body.appendChild(bubble);
    return el;
  }

  function typingBubble() {
    const el = document.createElement('div');
    el.className = 'chat-msg ai';
    el.innerHTML = '<div class="chat-avatar">AI</div><div class="chat-bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>';
    return { wrap: el };
  }

  // ----- Interview -----
  function renderInterview() {
    return `
      <div class="panel">
        <div class="panel-title">
          <span class="pt-icon rose" style="background: var(--danger-soft); color: var(--danger);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
          Phỏng vấn giả lập ${SESSION.jd ? `— vị trí <em>${esc(SESSION.jd.title || '')}</em>` : ''}
        </div>
        <div id="interviewArea"></div>
      </div>`;
  }

  function initInterview() {
    const area = $('#interviewArea');
    let currentMood = null;

    // Mood metadata (client-side display; server only sends the key)
    const MOODS = {
      warm:      { label: 'Vui vẻ, cởi mở',  emoji: '😊', color: 'green', tip: 'Câu trả lời của bạn đang ghi điểm. Giữ nhịp này, nêu thêm dẫn chứng cụ thể.' },
      neutral:   { label: 'Trung lập',       emoji: '😐', color: 'sky',   tip: 'PV đang lắng nghe và đánh giá. Trả lời có cấu trúc, đi thẳng vào ý chính.' },
      skeptical: { label: 'Nghi ngờ',        emoji: '🤨', color: 'amber', tip: 'PV chưa thấy thuyết phục. Đưa số liệu/dẫn chứng cụ thể thay vì mô tả chung.' },
      annoyed:   { label: 'Khó chịu',        emoji: '😒', color: 'red',   tip: 'Câu trả lời lan man hoặc lệch trọng tâm. Dừng lan man — tóm gọn ý chính ngay.' },
      silence:   { label: 'Im lặng áp lực',  emoji: '🕰️', color: 'amber', tip: 'Im lặng là một phép thử. Giữ bình tĩnh, đừng rút lại câu trả lời; có thể hỏi "Anh/chị cần em làm rõ phần nào không ạ?"' },
      stress:    { label: 'Đá xoáy',         emoji: '⚡', color: 'red',   tip: 'Đây là stress interview — họ thử độ bình tĩnh. Đừng phản ứng quá, giữ giọng điềm tĩnh, rõ ràng.' },
      impressed: { label: 'Ấn tượng',        emoji: '🤩', color: 'green', tip: 'PV rất thích câu trả lời. Có thể nhấn thêm điểm mạnh của bạn ở câu sau.' },
      ending:    { label: 'Muốn kết thúc',   emoji: '⏳', color: 'red',   tip: 'PV đang muốn khép lại sớm. Nếu còn điểm mạnh nào chưa nói, đây là lúc chốt nhanh gọn.' },
    };

    // ---------- Mood badge ----------
    function moodBadge(mood) {
      if (!mood || !MOODS[mood]) return '';
      const m = MOODS[mood];
      return `<span class="mood-badge mood-${m.color}" title="${esc(m.tip)}">
        <span class="mood-emoji">${m.emoji}</span>${esc(m.label)}
      </span>`;
    }
    function setMood(mood) {
      currentMood = mood;
      const bar = $('#moodBar');
      if (!bar) return;
      bar.innerHTML = mood ? moodBadge(mood) + `<span class="mood-tip">${esc(MOODS[mood]?.tip || '')}</span>` : '';
      bar.classList.toggle('visible', !!mood);
      if (mood) {
        bar.classList.remove('flash');
        void bar.offsetWidth; // reflow để restart animation
        bar.classList.add('flash');
      }
      // Nền vùng chat tô màu theo cảm xúc PV (chuyển mượt 1.2s trong CSS)
      const wrap = area.querySelector('.chat-wrap');
      if (wrap) {
        wrap.classList.remove('mood-tint-green', 'mood-tint-sky', 'mood-tint-amber', 'mood-tint-red');
        if (mood && MOODS[mood]) wrap.classList.add('mood-tint-' + MOODS[mood].color);
      }
    }

    // ---------- Header bar (mood + lịch sử + buổi mới) ----------
    function renderHeaderBar() {
      return `
        <div class="iv-topbar">
          <div class="mood-bar" id="moodBar"></div>
          <div class="iv-topbar-actions">
            <button class="btn btn-ghost btn-sm" id="ivHistoryBtn">📚 Lịch sử</button>
            <button class="btn btn-soft btn-sm" id="ivNewBtn" title="Lưu buổi hiện tại và bắt đầu buổi mới">＋ Buổi mới</button>
          </div>
        </div>`;
    }

    function wireHeaderButtons(afterArchiveShowStart) {
      $('#ivHistoryBtn')?.addEventListener('click', showHistory);
      $('#ivNewBtn')?.addEventListener('click', async () => {
        try {
          await fetch(`/api/session/${sessionId}/interview/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          toast('Đã lưu buổi cũ — bắt đầu buổi mới');
          currentMood = null;
          afterArchiveShowStart ? renderInterviewStart() : initInterview();
        } catch { toast('Không lưu được buổi cũ'); }
      });
    }

    // ---------- Entry: hỏi server trạng thái ----------
    fetch(`/api/session/${sessionId}/interview/state`)
      .then(r => r.json())
      .then(st => {
        if (st.hasSession && st.ended && st.report) {
          renderInterviewReport({ report: st.report }, true);
        } else if (st.hasSession && st.ended && !st.report) {
          renderEndedNoReport();
        } else if (st.hasSession && st.ending) {
          renderEnding(); // user bấm Kết thúc — AI đang tổng hợp báo cáo
        } else if (st.hasSession && st.pending) {
          renderInterviewWaiting();
        } else if (st.hasSession && !st.ended && st.question) {
          renderInterviewChat({ question: st.question, mood: st.mood }, true);
        } else if (window.__ivPrepMode) {
          window.__ivPrepMode = false;
          startInterview(true);
        } else {
          renderInterviewStart();
        }
      })
      .catch(() => {
        if (window.__ivPrepMode) { window.__ivPrepMode = false; startInterview(true); }
        else renderInterviewStart();
      });

    // ---------- Kết thúc: AI đang tổng hợp báo cáo ----------
    function renderEnding() {
      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="interview-phase-start">
          <div class="feature-icon amber" style="margin: 0 auto 18px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>
          </div>
          <h3 style="margin-bottom: 8px;">Bạn đã kết thúc buổi phỏng vấn</h3>
          <p class="muted mb-4" style="max-width: 560px; margin-inline: auto;">Hệ thống đang tổng hợp báo cáo dựa trên toàn bộ hội thoại — chấm điểm từng phần, điểm mạnh, điểm yếu và mức độ sẵn sàng của bạn. Việc này mất khoảng <strong>1–2 phút</strong>.</p>
          <div class="ending-meta">
            <span class="proc-chip"><span class="typing-dots"><span></span><span></span><span></span></span>&nbsp;AI đang viết báo cáo...</span>
            <span class="proc-chip" id="ivEndingTimer">⏱ 00:00</span>
          </div>
          <button class="btn btn-ghost btn-sm mt-4" id="ivEndingPeek">Xem lại hội thoại trong lúc chờ</button>
          <div class="chat-wrap mt-4 hidden" id="ivEndingTranscript" style="height: 380px;">
            <div class="chat-log" id="ivEndingLog"></div>
          </div>
        </div>`;
      setMood(null);
      wireHeaderButtons(false);
      // Đếm thời gian chờ
      const t0 = Date.now();
      const timerEl = $('#ivEndingTimer');
      const timer = setInterval(() => {
        if (!timerEl || !timerEl.isConnected) { clearInterval(timer); return; }
        const s = Math.floor((Date.now() - t0) / 1000);
        timerEl.textContent = `⏱ ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }, 1000);
      // Xem transcript trong lúc chờ (mặc định ẩn)
      $('#ivEndingPeek').addEventListener('click', async () => {
        const box = $('#ivEndingTranscript');
        const firstOpen = box.classList.contains('hidden');
        box.classList.toggle('hidden');
        if (firstOpen && !box.dataset.loaded) {
          box.dataset.loaded = '1';
          try {
            const res = await fetch(`/api/session/${sessionId}/interview/transcript`);
            const { turns } = await res.json();
            const log = $('#ivEndingLog');
            (turns || []).forEach(turn => {
              if (turn.role === 'interviewer') log.appendChild(ivBubble(turn.content, turn.mood));
              else log.appendChild(mdBubble('user', turn.content, null));
            });
            log.scrollTop = log.scrollHeight;
          } catch { /* bỏ qua */ }
        }
      });
      // Poll đến khi báo cáo xong
      const poll = setInterval(async () => {
        try {
          const res = await fetch(`/api/session/${sessionId}/interview/state`);
          const st = await res.json();
          if (!st.ending) {
            clearInterval(poll);
            if (st.ended && st.report) renderInterviewReport({ report: st.report }, true);
            else if (st.ended) renderEndedNoReport();
            else if (st.question) renderInterviewChat({ question: st.question, mood: st.mood }, true);
            else initInterview();
          }
        } catch { /* poll tiếp */ }
      }, 3000);
    }

    // ---------- Waiting (AI đang soạn câu hỏi) ----------
    function renderInterviewWaiting() {
      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="chat-wrap" style="height: 480px;">
          <div class="chat-log">
            <div class="chat-msg ai"><div class="chat-avatar">PV</div><div class="chat-bubble"><span class="typing-dots"><span></span><span></span><span></span></span> <span class="muted small">Interviewer đang soạn câu hỏi...</span></div></div>
          </div>
        </div>`;
      setMood(null);
      wireHeaderButtons(false);
      const poll = setInterval(async () => {
        try {
          const res = await fetch(`/api/session/${sessionId}/interview/state`);
          const st = await res.json();
          if (!st.pending) {
            clearInterval(poll);
            if (st.ending) { renderEnding(); return; }
            if (st.ended && st.report) renderInterviewReport({ report: st.report }, true);
            else if (st.ended) renderEndedNoReport();
            else if (st.question) renderInterviewChat({ question: st.question, mood: st.mood }, true);
            else initInterview();
          }
        } catch { /* poll tiếp */ }
      }, 2500);
    }

    // ---------- Buổi đã kết thúc nhưng báo cáo lỗi (hiếm) — vẫn giữ transcript ----------
    async function renderEndedNoReport() {
      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="interview-report">
          <div class="leave-note" style="background: var(--warn-soft, #fffbeb); color: var(--warn, #b45309);">
            Buổi phỏng vấn đã kết thúc, nhưng máy chủ không tạo được báo cáo tổng kết cho buổi này. Dưới đây là toàn bộ diễn biến đã lưu — bấm "Luyện lại" để bắt đầu buổi mới.
          </div>
          <div class="field-label mt-4">Diễn biến buổi phỏng vấn</div>
          <div class="chat-wrap" style="height: 420px; border: 1px solid var(--border); border-radius: 14px; padding: 12px;">
            <div class="chat-log" id="ivNoReportLog"></div>
          </div>
          <div class="flex mt-6" style="gap: 12px;">
            <button class="btn btn-soft" id="ivNoReportRetry">Luyện lại buổi mới</button>
          </div>
        </div>`;
      setMood(null);
      wireHeaderButtons(false);
      try {
        const res = await fetch(`/api/session/${sessionId}/interview/transcript`);
        const { turns } = await res.json();
        const log = $('#ivNoReportLog');
        (turns || []).forEach(turn => {
          if (turn.role === 'interviewer') log.appendChild(ivBubble(turn.content, turn.mood));
          else log.appendChild(mdBubble('user', turn.content, null));
        });
        log.scrollTop = log.scrollHeight;
      } catch { /* leave empty */ }
      $('#ivNoReportRetry').addEventListener('click', async () => {
        await fetch(`/api/session/${sessionId}/interview/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        startInterview(false);
      });
    }

    // ---------- Start screen ----------
    function renderInterviewStart() {
      const legend = Object.entries(MOODS).map(([key, m]) => `
        <span class="mood-badge mood-${m.color}" title="${esc(m.tip)}"><span class="mood-emoji">${m.emoji}</span>${esc(m.label)}</span>`).join('');
      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="interview-phase-start">
          <div class="feature-icon rose" style="margin: 0 auto 18px;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg></div>
          <h3 style="margin-bottom: 8px;">Sẵn sàng luyện phỏng vấn?</h3>
          <p class="muted mb-2" style="max-width: 560px; margin-inline: auto;">AI sẽ đóng vai interviewer${SESSION.jd ? ` của vị trí <strong>${esc(SESSION.jd.title || '')}</strong>` : ''}, hỏi theo đúng CV của bạn. Giống phòng phỏng vấn thật, interviewer có <strong>trạng thái cảm xúc</strong> — quan sát tín hiệu và điều chỉnh cách trả lời:</p>
          <div class="mood-legend">${legend}</div>
          <p class="small muted" style="max-width: 560px; margin-inline: auto; margin-bottom: 20px;">💡 Buổi đang dở được lưu tự động. Dùng "Buổi mới" để lưu buổi này và bắt đầu lại từ đầu; "Lịch sử" xem các buổi đã luyện.</p>
          <button class="btn btn-primary" id="ivStart">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Bắt đầu phỏng vấn
          </button>
        </div>`;
      setMood(null);
      wireHeaderButtons(true);
      $('#ivStart').addEventListener('click', () => startInterview(false));
    }

    // ---------- Start ----------
    async function startInterview(prep) {
      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="text-center muted" style="padding: 40px 0;"><span class="typing-dots"><span></span><span></span><span></span><span></span></span><div class="mt-3">Interviewer đang chuẩn bị...</div></div>`;
      wireHeaderButtons(false);
      await interviewTurn('/api/session/' + sessionId + '/interview/start', { prep: !!prep });
    }

    async function interviewTurn(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.error) { area.innerHTML = `<div class="leave-note" style="background: var(--danger-soft); color: var(--danger); width: 100%;">⚠ ${esc(d.error)}</div>`; return; }
      renderInterviewChat(d);
    }

    // ---------- Live chat (buổi đang diễn ra) ----------
    function renderInterviewChat(d, resumed) {
      if (d.ended && d.report) { renderInterviewReport(d, resumed); return; }

      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="chat-wrap" style="height: 520px;">
          <div class="chat-log" id="ivLog">
            ${resumed ? '<div class="iv-resume-note">↩ Đã khôi phục buổi phỏng vấn đang dở</div>' : ''}
          </div>
          <div class="chat-inputbar">
            <input class="input" id="ivInput" placeholder="Câu trả lời của bạn..." autofocus>
            <button class="btn btn-primary" id="ivSend">Trả lời</button>
            <button class="btn btn-ghost btn-sm" id="ivStop" title="Kết thúc và nhận báo cáo">Kết thúc</button>
          </div>
        </div>`;
      const log = $('#ivLog');
      setMood(d.mood || null);
      wireHeaderButtons(false);

      // Load transcript đầy đủ từ server — trình bày giống Chat Coach
      fetch(`/api/session/${sessionId}/interview/transcript`)
        .then(r => r.json())
        .then(t => {
          (t.turns || []).forEach(turn => {
            if (turn.role === 'interviewer') log.appendChild(ivBubble(turn.content, turn.mood));
            else log.appendChild(mdBubble('user', turn.content, null));
          });
          // Current question chỉ append nếu transcript chưa chứa nó
          const lastServer = (t.turns || []).length ? t.turns[t.turns.length - 1] : null;
          const isDup = lastServer && lastServer.role === 'interviewer' && lastServer.content === d.question;
          if (!isDup) log.appendChild(ivBubble(d.question, d.mood));
          log.scrollTop = log.scrollHeight;
        })
        .catch(() => {
          log.appendChild(ivBubble(d.question, d.mood));
          log.scrollTop = log.scrollHeight;
        });

      const input = $('#ivInput');
      input.focus();
      $('#ivSend').addEventListener('click', () => reply(input.value));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') reply(input.value); });
      $('#ivStop').addEventListener('click', () => {
        $('#ivSend').disabled = true; input.disabled = true; $('#ivStop').disabled = true;
        stopInterview();
      });

      async function reply(msg) {
        const m = msg.trim();
        if (!m) return;
        log.appendChild(mdBubble('user', m, null));
        log.scrollTop = log.scrollHeight;
        input.value = '';
        const typing = typingBubble(); typing.wrap.querySelector('.chat-avatar').textContent = 'PV';
        log.appendChild(typing.wrap);
        log.scrollTop = log.scrollHeight;
        try {
          const res = await fetch(`/api/session/${sessionId}/interview/reply`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: m }),
          });
          const dd = await res.json();
          typing.wrap.remove();
          if (dd.error) { log.appendChild(mdBubble('ai', '⚠ ' + dd.error)); return; }
          if (dd.ended) { renderInterviewReport(dd); return; }
          setMood(dd.mood || null);
          log.appendChild(ivBubble(dd.question, dd.mood));
          log.scrollTop = log.scrollHeight;
          input.focus();
        } catch {
          typing.wrap.remove();
          log.appendChild(mdBubble('ai', '⚠ Lỗi kết nối — thử lại.'));
        }
      }
      async function stopInterview() {
        // Màn "đang tổng hợp báo cáo" ngay lập tức — poll tự chuyển sang report khi xong
        renderEnding();
        try {
          const res = await fetch(`/api/session/${sessionId}/interview/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const dd = await res.json();
          if (dd.ended) { renderInterviewReport(dd); return; }
          if (dd.error) {
            // Thật sự chưa kết thúc được (AI chưa trả INTERVIEW_END) — quay lại chat
            const wrap = area.querySelector('.chat-wrap');
            if (wrap) { renderInterviewChat({ question: dd.question, mood: dd.mood }, true); return; }
          }
        } catch {
          // Mất kết nối — renderEnding đang poll /interview/state, server vẫn xử lý tiếp, không cần làm gì
        }
      }
    }

    // Bubble của interviewer (giống chat coach, có mood badge nhỏ cạnh)
    function ivBubble(text, mood) {
      const el = document.createElement('div');
      el.className = 'chat-msg ai';
      el.innerHTML = `<div class="chat-avatar">PV</div><div class="msg-body" style="min-width:0;"></div>`;
      const body = el.querySelector('.msg-body');
      if (mood) {
        const badge = document.createElement('div');
        badge.innerHTML = moodBadge(mood);
        badge.className = 'iv-mood-row';
        body.appendChild(badge);
      }
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble md-wrap';
      bubble.innerHTML = md(text);
      body.appendChild(bubble);
      return el;
    }

    // ---------- History ----------
    async function showHistory() {
      const res = await fetch(`/api/session/${sessionId}/interview/history`);
      const { history } = await res.json();
      const vLabel = { excellent: 'Xuất sắc', good: 'Khá tốt', moderate: 'Trung bình', weak: 'Cần cố gắng' };
      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="panel" style="background: transparent; border: none; padding: 0;">
          <h3 class="mb-4">📚 Lịch sử buổi phỏng vấn</h3>
          ${!history.length ? '<p class="muted">Chưa có buổi nào được lưu. Bấm "Buổi mới" khi đang trong buổi, hoặc luyện xong buổi hiện tại.</p>' : ''}
          <div class="iv-history-list">
            ${history.map(h => `
              <div class="card card-hover iv-history-item" data-idx="${h.index}" role="button" tabindex="0">
                <div class="score-pill" style="width: 96px; padding: 12px 10px;">
                  <div class="sp-num"><span class="num" style="font-size: 1.6rem;">${h.score ?? '—'}</span><span class="den">/100</span></div>
                </div>
                <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: 700;">Buổi #${h.index + 1} ${h.verdict ? `<span class="badge badge-indigo">${vLabel[h.verdict] || h.verdict}</span>` : ''}</div>
                  <div class="small muted">${new Date(h.endedAt).toLocaleString('vi-VN')} · ${h.turns} lượt đối thoại</div>
                </div>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              </div>`).join('')}
          </div>
          <button class="btn btn-ghost btn-sm mt-4" id="ivBackBtn">← Quay lại</button>
        </div>`;
      wireHeaderButtons(false);
      $('#ivBackBtn')?.addEventListener('click', () => initInterview());
      area.querySelectorAll('.iv-history-item').forEach(el => {
        el.addEventListener('click', () => showHistoryDetail(+el.dataset.idx));
        el.addEventListener('keydown', e => { if (e.key === 'Enter') showHistoryDetail(+el.dataset.idx); });
      });
    }

    async function showHistoryDetail(idx) {
      const res = await fetch(`/api/session/${sessionId}/interview/history/${idx}`);
      if (!res.ok) { toast('Không đọc được buổi này'); return; }
      const h = await res.json();
      const v = h.report ? VERDICT[h.report.verdict] : null;
      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="iv-history-detail">
          <div class="flex items-center gap-3 mb-4">
            <button class="icon-btn" id="ivHistBack" style="width: 36px; height: 36px;" aria-label="Quay lại danh sách">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <h3 style="margin: 0;">Buổi #${idx + 1} — ${new Date(h.endedAt).toLocaleString('vi-VN')}</h3>
            ${h.report && v ? `<span class="verdict-chip ${v.cls}">${v.label}</span>` : ''}
          </div>
          ${h.report ? renderReportSummary(h.report) : ''}
          <div class="field-label mt-6">Diễn biến buổi phỏng vấn</div>
          <div class="chat-wrap" style="height: 420px; border: 1px solid var(--border); border-radius: 14px; padding: 12px;">
            <div class="chat-log" id="ivHistLog"></div>
          </div>
        </div>`;
      wireHeaderButtons(false);
      $('#ivHistBack').addEventListener('click', showHistory);
      const log = $('#ivHistLog');
      (h.transcript || []).forEach(turn => {
        if (turn.role === 'interviewer') log.appendChild(ivBubble(turn.content, null));
        else log.appendChild(mdBubble('user', turn.content, null));
      });
      log.scrollTop = log.scrollHeight;
    }

    function renderReportSummary(rp) {
      const v = VERDICT[rp.verdict];
      return `
        <div class="iv-summary">
          <div class="iv-sum-col">
            <div class="iv-sum-block iv-sum-green">
              <div class="iv-sum-title"><span class="iv-sum-ic">✓</span> Điểm mạnh <span class="count">${(rp.strengths || []).length}</span></div>
              ${(rp.strengths || []).map(x => `<div class="flag-item"><div class="flag-dot" style="background: var(--accent);"></div><div>${esc(x)}</div></div>`).join('') || '<p class="muted small">—</p>'}
            </div>
            <div class="iv-sum-block iv-sum-red">
              <div class="iv-sum-title"><span class="iv-sum-ic">✗</span> Cần cải thiện <span class="count">${(rp.weaknesses || []).length}</span></div>
              ${(rp.weaknesses || []).map(x => `<div class="flag-item"><div class="flag-dot" style="background: var(--danger);"></div><div>${esc(x)}</div></div>`).join('') || '<p class="muted small">—</p>'}
            </div>
          </div>
          <div class="iv-sum-block iv-sum-amber iv-sum-qf">
            <div class="iv-sum-title"><span class="iv-sum-ic">🎯</span> Chấm điểm từng phần <span class="count">${(rp.questionFeedback || []).length}</span></div>
            ${(rp.questionFeedback || []).map(q => `
              <div class="qf-item">
                <div class="qf-head"><span class="qf-topic">${esc(q.topic)}</span><span class="qf-score" style="color: ${q.score >= 70 ? 'var(--accent)' : q.score >= 40 ? 'var(--warn)' : 'var(--danger)'}">${q.score ?? '—'}/100</span></div>
                <div class="qf-comment">${esc(q.comment || '')}</div>
              </div>`).join('') || '<p class="muted small">—</p>'}
          </div>
        </div>`;
    }

    // ---------- Report (cuối buổi) ----------
    function renderInterviewReport(d, fromRestore) {
      const rp = d.report || {};
      const v = VERDICT[rp.verdict];
      const reportMd = [
        `# Báo cáo phỏng vấn giả lập — HireMind`,
        ``,
        `**Điểm tổng:** ${rp.overallScore ?? '—'}/100 ${v ? `(${v.label})` : ''}${typeof rp.passProbability === 'number' ? ` · **Khả năng đậu thật:** ${rp.passProbability}%` : ''}`,
        ``,
        rp.interviewerFeeling ? `> ${rp.interviewerFeeling.emoji || ''} **Cảm xúc phỏng vấn viên:** ${rp.interviewerFeeling.mood || ''}${rp.interviewerFeeling.attitude ? ` — ${rp.interviewerFeeling.attitude}` : ''}` : '',
        ``,
        rp.bluntVerdict ? `## Phỏng vấn viên nói thật\n\n${rp.bluntVerdict}` : '',
        ``,
        `## Tổng kết`,
        rp.summary || '',
        ``,
        `## Điểm mạnh`,
        ...(rp.strengths || []).map(x => `- ${x}`),
        ``,
        `## Cần cải thiện`,
        ...(rp.weaknesses || []).map(x => `- ${x}`),
        ``,
        `## Chấm điểm từng phần`,
        ...(rp.questionFeedback || []).map(q => `- **${q.topic}:** ${q.score ?? '—'}/100 — ${q.comment || ''}`),
        ``,
        `## Lời khuyên cho phỏng vấn thật`,
        ...(rp.advice || []).map(x => `- ${x}`),
        ``,
        rp.alternativePathsNote ? `## Cân nhắc hướng đi khác\n\n${rp.alternativePathsNote}` : '',
      ].join('\n');
      area.innerHTML = `
        ${renderHeaderBar()}
        <div class="interview-report">
          <div class="report-score-row">
            <div class="score-pill" style="width: 150px; padding: 20px 16px;">
              <div class="sp-label">Buổi PV</div>
              <div class="sp-num"><span class="num">${rp.overallScore ?? '—'}</span><span class="den">/100</span></div>
              <div class="sp-bar"><div class="fill" style="width: ${rp.overallScore || 0}%;"></div></div>
            </div>
            <div style="flex: 1; min-width: 220px;">
              <h3 style="margin-bottom: 6px;">Báo cáo buổi phỏng vấn ${v ? `<span class="verdict-chip ${v.cls}" style="vertical-align: middle; margin-left: 6px;">${v.label}</span>` : ''}</h3>
              <p class="muted">${esc(rp.summary || '')}</p>
              ${fromRestore ? '<div class="small muted mt-2">↩ Khôi phục từ buổi trước</div>' : ''}
            </div>
          </div>
          ${(rp.bluntVerdict || rp.interviewerFeeling) ? `
          <div class="blunt-box">
            <div class="blunt-head">
              <span class="blunt-emoji">${rp.interviewerFeeling?.emoji || '💬'}</span>
              <div>
                <div class="blunt-title">Phỏng vấn viên nói thật</div>
                ${rp.interviewerFeeling?.mood ? `<div class="blunt-mood">Cảm xúc: <strong>${esc(rp.interviewerFeeling.mood)}</strong>${rp.interviewerFeeling?.attitude ? ` — ${esc(rp.interviewerFeeling.attitude)}` : ''}</div>` : ''}
              </div>
              ${typeof rp.passProbability === 'number' ? `
                <div class="blunt-pass">
                  <div class="bp-num">${rp.passProbability}%</div>
                  <div class="bp-lbl">khả năng đậu thật</div>
                </div>` : ''}
            </div>
            <div class="blunt-text">"${esc(rp.bluntVerdict || '')}"</div>
            <div class="ai-disclaimer" style="margin-top: 10px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
              Lời phê bình theo vai phỏng vấn viên, do AI tạo — chỉ để tham khảo.
            </div>
          </div>` : ''}
          ${rp.alternativePathsNote ? `
          <div class="iv-altpath-note">
            <div class="iap-head">
              <span class="iap-icon">🧭</span>
              <div class="iap-title">Phỏng vấn viên gợi ý cân nhắc hướng đi khác</div>
            </div>
            <p class="iap-text">${esc(rp.alternativePathsNote)}</p>
          </div>` : ''}
          ${renderReportSummary(rp)}
          ${(rp.advice && rp.advice.length) ? `
            <div class="panel mt-4" style="background: var(--info-soft); border-color: rgba(2,132,199,0.2);">
              <div class="field-label" style="color: var(--info); margin-bottom: 10px;">💡 Lời khuyên chuẩn bị cho phỏng vấn thật</div>
              ${rp.advice.map(a => `<div class="flag-item"><div class="flag-dot" style="background: var(--info);"></div><div>${esc(a)}</div></div>`).join('')}
            </div>` : ''}
          <div class="report-actions">
            <button class="btn btn-primary" id="ivRetry">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 2.64 6.36L3 21"/><path d="M3 15v6h6" transform="rotate(-180 6 18)"/></svg>
              Luyện lại buổi mới
            </button>
            <button class="btn btn-ghost" id="ivExport">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>
              Xuất báo cáo Word
            </button>
          </div>
        </div>`;
      setMood(null);
      wireHeaderButtons(false);
      $('#ivRetry').addEventListener('click', async () => {
        await fetch(`/api/session/${sessionId}/interview/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        startInterview(false);
      });
      $('#ivExport').addEventListener('click', () => exportDocx('Báo cáo phỏng vấn giả lập — HireMind', reportMd, 'hiremind-interview-report.docx'));
    }
  }

  // ----- Cover Letter -----
  function renderCover() {
    return `
      <div class="panel">
        <div class="panel-title">
          <span class="pt-icon amber"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>
          Cover Letter — viết từ CV thật của bạn
        </div>
        <div class="cl-options">
          <div style="min-width: 180px;">
            <label class="field-label" for="clTone">Giọng văn</label>
            <select class="select" id="clTone">
              <option value="professional">Chuyên nghiệp</option>
              <option value="enthusiastic">Nhiệt huyết</option>
              <option value="concise">Súc tích</option>
            </select>
          </div>
          <div style="min-width: 150px;">
            <label class="field-label" for="clLang">Ngôn ngữ</label>
            <select class="select" id="clLang">
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
          </div>
          <div style="flex: 1; min-width: 220px;">
            <label class="field-label" for="clNote">Muốn nhấn mạnh gì thêm? (tuỳ chọn)</label>
            <input class="input" id="clNote" placeholder="VD: kinh nghiệm dự án X, tình yêu với công ty Y...">
          </div>
          <button class="btn btn-primary" id="clGen" style="flex-shrink: 0;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>
            Tạo thư
          </button>
        </div>
        ${!SESSION.jd ? '<div class="leave-note" style="width: 100%;">Lưu ý: phiên này không có JD — thư sẽ viết tổng quát hơn. Tạo phiên mới kèm JD để thư nhấn đúng điểm khớp.</div>' : ''}
        <div id="clResult"></div>
      </div>`;
  }

  function initCover() {
    const btn = $('#clGen'), out = $('#clResult');
    let pollTimer = null;

    function renderLetter(d) {
      out.innerHTML = `
        <div class="cl-result">
          <div class="cl-subject">📌 Tiêu đề email: ${esc(d.subject || '(không có)')}</div>
          <div class="cl-letter md-wrap">${md(d.letter || '')}</div>
          ${(d.tips && d.tips.length) ? `
            <div class="panel mt-4" style="background: var(--warn-soft); border-color: rgba(217,119,6,0.2);">
              <div class="field-label" style="color: var(--warn); margin-bottom: 8px;">✏️ Mẹo tùy chỉnh trước khi gửi</div>
              ${d.tips.map(t => `<div class="flag-item"><div class="flag-dot" style="background: var(--warn);"></div><div>${esc(t)}</div></div>`).join('')}
            </div>` : ''}
          ${d.cached ? '<div class="small muted mt-2">↩ Dùng lại thư đã tạo trước đó (cùng tùy chọn). Đổi giọng văn/ngôn ngữ rồi bấm "Tạo thư" để viết lại.</div>' : ''}
          <div class="export-row">
            <button class="btn btn-soft btn-sm" id="clCopy">Copy thư</button>
            <button class="btn btn-soft btn-sm" id="clDocx">⬇ Xuất Word (.docx)</button>
            <button class="btn btn-ghost btn-sm" id="clPrint">In / Xuất PDF</button>
          </div>
          <div class="cl-send">
            <input class="input" id="clMailTo" placeholder="Email người nhận — nhiều email cách nhau bằng dấu phẩy" autocomplete="off">
            <input class="input" id="clMailCc" placeholder="CC (tùy chọn)" autocomplete="off" style="flex: 0 1 200px;">
            <label><input type="checkbox" id="clMailBcc"> Ẩn danh người nhận (BCC)</label>
            <button class="btn btn-soft btn-sm" id="clGmail" title="Mở Gmail với thư đã điền sẵn — bạn xem lại và bấm Gửi trong đó">✉ Mở Gmail soạn thư</button>
          </div>
        </div>`;
      $('#clCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(d.letter || ''); toast('Đã copy thư'); } catch { toast('Không copy được'); }
      });
      $('#clDocx').addEventListener('click', () => exportDocx(d.subject || 'Cover Letter — HireMind', d.letter || '', 'hiremind-cover-letter.docx'));
      $('#clPrint').addEventListener('click', () => printLetter(d));
      $('#clGmail').addEventListener('click', () => {
        const to = $('#clMailTo').value.trim();
        const cc = $('#clMailCc').value.trim();
        const emails = `${to},${cc}`.split(',').map(s => s.trim()).filter(Boolean);
        if (!emails.length) { toast('Nhập ít nhất một email người nhận'); return; }
        const bad = emails.find(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        if (bad) { toast(`Email không hợp lệ: ${bad}`); return; }
        // Chống lặp tiêu đề: AI đôi khi vẫn chèn subject vào đầu thân thư
        let letterBody = d.letter || '';
        const su0 = (d.subject || '').trim();
        if (su0) {
          const lines = letterBody.split('\n');
          const first = lines.findIndex(l => l.trim());
          if (first !== -1 && lines[first].replace(/[*#]/g, '').trim() === su0) lines.splice(first, 1);
          letterBody = lines.join('\n');
        }
        const bcc = $('#clMailBcc').checked;
        let rcpt = '';
        if (bcc) {
          rcpt = `&bcc=${encodeURIComponent(emails.join(','))}`;
        } else {
          rcpt = `&to=${encodeURIComponent(to.split(',').map(s => s.trim()).filter(Boolean).join(','))}`;
          if (cc) rcpt += `&cc=${encodeURIComponent(cc.split(',').map(s => s.trim()).filter(Boolean).join(','))}`;
        }
        const url = `https://mail.google.com/mail/?view=cm&fs=1${rcpt}&su=${encodeURIComponent(d.subject || 'Ứng tuyển')}&body=${encodeURIComponent(mdToPlain(letterBody))}`;
        window.open(url, '_blank');
        toast('Đã mở Gmail — xem lại thư rồi bấm Gửi trong đó');
      });
    }

    // Quay lại tab khi AI vẫn đang viết (hoặc đã viết xong từ lúc trước) → restore
    if (SESSION.coverLetter) {
      renderLetter({ ...SESSION.coverLetter, cached: true });
    } else if (SESSION.coverLetterPending) {
      btn.disabled = true;
      out.innerHTML = `<div class="text-center muted" style="padding: 36px 0;"><span class="typing-dots"><span></span><span></span><span></span></span><div class="mt-3">AI đang viết thư ứng tuyển... (bạn có thể rời đi — quay lại sẽ thấy thư)</div></div>`;
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/session/${sessionId}`);
          const s = await res.json();
          if (!s.coverLetterPending) {
            clearInterval(pollTimer);
            btn.disabled = false;
            if (s.coverLetter) renderLetter({ ...s.coverLetter, cached: false });
            else out.innerHTML = '';
          }
        } catch { /* poll tiếp */ }
      }, 2500);
    }

    $('#clGen').addEventListener('click', async () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      btn.disabled = true;
      out.innerHTML = `<div class="text-center muted" style="padding: 36px 0;"><span class="typing-dots"><span></span><span></span><span></span></span><div class="mt-3">AI đang viết thư ứng tuyển... (bạn có thể rời đi — quay lại sẽ thấy thư)</div></div>`;
      try {
        const res = await fetch(`/api/session/${sessionId}/cover-letter`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tone: $('#clTone').value, language: $('#clLang').value, extraNote: $('#clNote').value.trim() || null }),
        });
        const d = await res.json();
        if (d.error) { out.innerHTML = `<div class="leave-note" style="background: var(--danger-soft); color: var(--danger); width: 100%;">⚠ ${esc(d.error)}</div>`; }
        else {
          renderLetter(d);
          SESSION.coverLetter = d; // update local state
        }
      } catch {
        out.innerHTML = '<div class="leave-note" style="background: var(--danger-soft); color: var(--danger); width: 100%;">⚠ Lỗi kết nối — thư vẫn có thể đang được tạo, quay lại tab sau ít phút.</div>';
      }
      btn.disabled = false;
    });
  }

  function printLetter(d) {
    const w = window.open('', '_blank');
    if (!w) { toast('Trình duyệt chặn popup'); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cover Letter — HireMind</title>
      <style>body{font-family:'Segoe UI',Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;line-height:1.7;color:#1e293b}
      h1{font-size:1.2rem;color:#6366f1}pre{white-space:pre-wrap;font-family:inherit}</style></head>
      <body><h1>${esc(d.subject || '')}</h1><pre>${esc(d.letter || '')}</pre>
      <script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
  }

  // ----- CV original -----
  function renderCV() {
    const cv = SESSION.cv || {};
    return `
      <div class="panel mb-6">
        <div class="panel-title">
          <span class="pt-icon sky"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>
          CV đã được AI trích xuất &amp; dọn sạch — nguồn dữ liệu cho mọi phân tích
        </div>
        <p class="muted" style="margin-bottom: 14px;">Đối chiếu với CV thật của bạn: nếu thấy sai sót ở đây (OCR đọc sai, thiếu mục) thì toàn bộ phân tích phía trên cũng dựa trên nội dung này — hãy tải lại CV ảnh rõ nét hơn hoặc dùng nhập tay.</p>
        ${cv.sections && cv.sections.length ? `<div class="skill-chips mb-4">${cv.sections.map(s => `<span class="skill-chip">${esc(s)}</span>`).join('')}</div>` : ''}
        <div class="rw-cv md-wrap">${md(cv.cleanedCv || 'Không có nội dung.')}</div>
        <div class="rw-actions mt-4">
          <button class="btn btn-soft btn-sm" id="cvCopy">Copy văn bản</button>
          <button class="btn btn-soft btn-sm" id="cvDocx">⬇ Xuất CV thiết kế (.docx)</button>
          <span class="small muted">File Word có banner màu, ô dán ảnh 3×4, heading màu — mở là chỉnh được ngay.</span>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">
          <span class="pt-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>
          File đã tải lên (${(SESSION.files || []).length})
        </div>
        ${(SESSION.files || []).map(f => `
          <div class="flag-item"><div class="flag-dot" style="background: var(--info);"></div><div>${esc(f.name)} <span class="muted small">(${(f.size / 1024).toFixed(0)} KB)</span></div></div>`).join('')}
      </div>`;
  }

  function initCv() {
    $('#cvCopy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(SESSION.cv?.cleanedCv || ''); toast('Đã copy văn bản CV'); } catch { toast('Không copy được'); }
    });
    $('#cvDocx')?.addEventListener('click', () => exportCvDocx(SESSION.cv?.cleanedCv || '', SESSION.cv?.candidateName || 'CV'));
  }

  // Copy session link
  document.getElementById('btnCopyLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Đã copy link phiên'); } catch { toast('Không copy được'); }
  });

  boot();
})();
