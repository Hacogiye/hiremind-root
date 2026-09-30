// HireMind effects — lightbox gallery (zoom + next/prev), reveal stagger (dùng chung 2 trang)
(function () {
  'use strict';

  // Báo cho CSS biết JS đang chạy (reveal chỉ ẩn khi có JS)
  document.documentElement.classList.add('js');

  // ---------- Lightbox gallery ----------
  const SEL = '.show-shot img, .msg-images img, img[data-zoom]';
  let group = [];   // danh sách src trong cùng nhóm
  let idx = 0;
  let lb = null;

  document.addEventListener('click', (e) => {
    const img = e.target.closest(SEL);
    if (!img || img.closest('.lightbox')) return;
    e.preventDefault();
    // nhóm = mọi ảnh match selector trong cùng viewport scope (trang hoặc log chat)
    const scope = img.closest('.chat-log, .iv-log-wrap, body');
    const all = Array.from(scope.querySelectorAll(SEL)).filter(i => !i.closest('.lightbox'));
    group = all.map(i => i.currentSrc || i.src);
    idx = Math.max(0, all.indexOf(img));
    open();
  });

  function open() {
    close();
    lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML =
      '<div class="lb-stage">' +
      '  <img src="" alt="Ảnh phóng to">' +
      '</div>' +
      '<button class="lb-close" aria-label="Đóng">✕</button>' +
      '<button class="lb-nav lb-prev" aria-label="Ảnh trước">‹</button>' +
      '<button class="lb-nav lb-next" aria-label="Ảnh sau">›</button>' +
      '<div class="lb-counter"></div>' +
      '<div class="lb-hint">Cuộn để zoom · ‹ › để đổi ảnh · Esc để đóng</div>';
    document.body.appendChild(lb);
    document.body.style.overflow = 'hidden';
    show();

    lb.addEventListener('click', (ev) => {
      if (ev.target === lb) { close(); return; }
      const t = ev.target;
      if (t.closest('.lb-close')) close();
      else if (t.closest('.lb-prev')) step(-1);
      else if (t.closest('.lb-next')) step(1);
      else if (t.closest('.lb-stage img')) toggleZoom(t.closest('img'));
    });
    // zoom bằng scroll wheel
    lb.addEventListener('wheel', (ev) => {
      if (ev.target.closest('.lb-stage img')) { ev.preventDefault(); setZoom(ev.deltaY < 0 ? 1 : -1); }
    }, { passive: false });
    document.addEventListener('keydown', onKey);
    // swipe mobile
    let x0 = null;
    lb.addEventListener('touchstart', (ev) => { x0 = ev.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', (ev) => {
      if (x0 == null) return;
      const dx = ev.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
      x0 = null;
    }, { passive: true });
  }

  function show() {
    if (!lb) return;
    const im = lb.querySelector('img');
    im.classList.remove('lb-zoomed');
    im.src = group[idx];
    lb.querySelector('.lb-counter').textContent = (idx + 1) + ' / ' + group.length;
    const single = group.length < 2;
    lb.querySelector('.lb-prev').style.display = single ? 'none' : '';
    lb.querySelector('.lb-next').style.display = single ? 'none' : '';
  }

  function step(d) {
    idx = (idx + d + group.length) % group.length;
    show();
  }

  function setZoom(dir) {
    const im = lb.querySelector('img');
    const zoomed = im.classList.toggle('lb-zoomed', dir > 0);
    im.style.transform = zoomed ? 'scale(2.1)' : '';
  }
  function toggleZoom(im) { setZoom(im.classList.contains('lb-zoomed') ? -1 : 1); }

  function onKey(e) {
    if (!lb) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  }
  function close() {
    if (lb) { lb.remove(); lb = null; document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); }
  }
  window.HMOpenLightbox = open;

  // ---------- Reveal stagger: card cùng lưới xuất hiện lần lượt ----------
  window.HMStagger = function (root) {
    const groups = new Map();
    (root || document).querySelectorAll('.reveal').forEach((el) => {
      const p = el.parentElement;
      if (!groups.has(p)) groups.set(p, 0);
      const i = groups.get(p);
      if (el.children.length || i < 8) el.style.setProperty('--reveal-delay', (i * 0.08) + 's');
      groups.set(p, i + 1);
    });
  };

  // ---------- Tabs trên mobile: mục active cuộn vào giữa ----------
  window.HMCenterTab = function (tabEl) {
    if (!tabEl || window.innerWidth > 700) return;
    const wrap = tabEl.parentElement;
    if (!wrap || !wrap.classList.contains('tabs')) return;
    const target = tabEl.offsetLeft - wrap.clientWidth / 2 + tabEl.clientWidth / 2;
    wrap.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  };
})();
