// wizard.js — Landing wizard: 3 bước, client-side PDF extraction (text + page images), upload, poll.
(function () {
  'use strict';

  // ---------- State ----------
  let sessionId = null;
  let sessionUrl = null;
  let files = []; // { file, id }

  // ---------- DOM ----------
  const $ = s => document.querySelector(s);
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const fileList = $('#fileList');
  const btnNext1 = $('#btnStep1Next');
  const btnNext2 = $('#btnStep2Next');
  const btnBack2 = $('#btnStep2Back');
  const panes = [$('#pane1'), $('#pane2'), $('#pane3')];
  const stepInds = document.querySelectorAll('.wstep');

  // ---------- Wizard navigation ----------
  function goStep(n) {
    panes.forEach((p, i) => p.classList.toggle('hidden', i !== n - 1));
    stepInds.forEach(ind => {
      const s = +ind.dataset.stepInd;
      ind.classList.toggle('active', s === n);
      ind.classList.toggle('done', s < n);
      const dot = ind.querySelector('.dot');
      if (s < n) dot.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
      else dot.textContent = s;
    });
    if (n !== 3) $('#start').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- File management ----------
  const FORMAT_META = {
    pdf: { cls: 'pdf', label: 'PDF' },
    docx: { cls: 'doc', label: 'DOC' },
    doc: { cls: 'doc', label: 'DOC' },
    txt: { cls: 'txt', label: 'TXT' },
    md: { cls: 'txt', label: 'MD' },
    jpg: { cls: 'img', label: 'JPG' },
    jpeg: { cls: 'img', label: 'JPG' },
    png: { cls: 'img', label: 'PNG' },
    webp: { cls: 'img', label: 'WEBP' },
    gif: { cls: 'img', label: 'IMG' },
    bmp: { cls: 'img', label: 'IMG' },
  };

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function addFiles(list) {
    for (const f of list) {
      if (files.length >= 12) { alert('Tối đa 12 file mỗi phiên.'); break; }
      if (f.size > 15 * 1024 * 1024) { alert(`"${f.name}" vượt 15MB. Hãy nén hoặc chụp lại ảnh rõ hơn.`); continue; }
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!FORMAT_META[ext]) { alert(`Định dạng "${f.name}" chưa hỗ trợ (PDF, DOCX, TXT, MD, ảnh).`); continue; }
      files.push({ file: f, id: crypto.randomUUID() });
    }
    renderFiles();
  }

  function renderFiles() {
    fileList.innerHTML = '';
    files.forEach((it, idx) => {
      const ext = (it.file.name.split('.').pop() || '').toLowerCase();
      const meta = FORMAT_META[ext] || FORMAT_META.txt;
      const el = document.createElement('div');
      el.className = 'file-item';
      el.innerHTML = `
        <div class="f-icon ${meta.cls}">${meta.label}</div>
        <div class="f-name"><div class="nm"></div><div class="sz">${fmtSize(it.file.size)}</div></div>
        <button class="f-remove" aria-label="Xoá file ${it.file.name}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>`;
      el.querySelector('.nm').textContent = it.file.name;
      el.querySelector('.f-remove').addEventListener('click', () => { files.splice(idx, 1); renderFiles(); });
      fileList.appendChild(el);
    });
    updateNextBtn();
  }

  // "Vị trí nhắm tới" is required — keep the Next button in sync while typing
  $('#targetRole').addEventListener('input', updateNextBtn);

  // ---------- CV entry mode: file | manual (form / free-write) ----------
  let cvMode = 'file'; // file | manual
  let cvTab = 'form';  // form | write (chỉ dùng khi cvMode = manual)
  const cvEntry = $('#cvEntry');
  const cvToggleBtn = $('#cvEntryToggle');

  cvToggleBtn.addEventListener('click', () => {
    cvMode = cvMode === 'file' ? 'manual' : 'file';
    cvEntry.classList.toggle('hidden', cvMode !== 'manual');
    cvToggleBtn.classList.toggle('active', cvMode === 'manual');
    updateNextBtn();
  });

  document.querySelectorAll('.cv-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      cvTab = btn.dataset.cvtab;
      document.querySelectorAll('.cv-tab').forEach(b => b.classList.toggle('active', b === btn));
      $('#cvFormPane').classList.toggle('hidden', cvTab !== 'form');
      $('#cvWritePane').classList.toggle('hidden', cvTab !== 'write');
      updateNextBtn();
    });
  });

  // Ghép form thành text CV dạng Markdown — pipeline nhận như text PDF client-side
  function buildFormCvText() {
    const v = id => ($(id).value || '').trim();
    const lines = [];
    if (v('#cfName')) lines.push(`# ${v('#cfName')}`);
    if (v('#cfContact')) lines.push(`Liên hệ: ${v('#cfContact')}`);
    if (v('#cfEdu')) lines.push('', '## Học vấn', v('#cfEdu'));
    if (v('#cfExp')) lines.push('', '## Kinh nghiệm & hoạt động', v('#cfExp'));
    if (v('#cfSkills')) lines.push('', '## Kỹ năng', v('#cfSkills'));
    if (v('#cfCert')) lines.push('', '## Chứng chỉ & giải thưởng', v('#cfCert'));
    if (v('#cfExtra')) lines.push('', '## Mục tiêu nghề nghiệp', v('#cfExtra'));
    return lines.join('\n');
  }

  function manualCvText() {
    return cvTab === 'form' ? buildFormCvText() : $('#cfWrite').value.trim();
  }

  function manualCvValid() {
    if (cvTab === 'form') {
      return $('#cfName').value.trim() && $('#cfEdu').value.trim() && $('#cfSkills').value.trim();
    }
    return $('#cfWrite').value.trim().length >= 200;
  }

  ['#cfName', '#cfEdu', '#cfSkills', '#cfWrite'].forEach(sel => {
    $(sel).addEventListener('input', updateNextBtn);
  });

  function updateNextBtn() {
    const hasRole = !!$('#targetRole').value.trim();
    if (cvMode === 'file') {
      btnNext1.disabled = files.length === 0 || !hasRole;
      btnNext1.title = !files.length ? 'Hãy tải file CV lên' : '';
    } else {
      btnNext1.disabled = !hasRole || !manualCvValid();
      btnNext1.title = !manualCvValid() ? (cvTab === 'form' ? 'Điền ít nhất Họ tên, Học vấn, Kỹ năng' : 'Tối thiểu 200 ký tự') : '';
    }
  }

  // Dropzone events
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', e => addFiles(e.dataTransfer.files));
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  // ---------- PDF client-side extraction ----------
  async function extractPdf(file) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    const pageImages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const pageText = tc.items.map(it => it.str).join(' ').trim();
      // If page text is thin (scanned PDF), render it to an image for AI vision OCR
      if (pageText.length < 80) {
        const img = await renderPageToImage(page);
        if (img) pageImages.push(img);
        text += pageText + '\n';
      } else {
        text += pageText + '\n\n';
      }
    }
    return { text: text.trim(), images: pageImages, pages: pdf.numPages };
  }

  async function renderPageToImage(page) {
    try {
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return { base64: canvas.toDataURL('image/jpeg', 0.82).split(',')[1], mime: 'image/jpeg' };
    } catch (e) {
      console.warn('render page failed', e);
      return null;
    }
  }

  // ---------- Upload & process ----------
  async function startProcessing() {
    const jdUrl = $('#jdUrl').value.trim();
    const jdManual = $('#jdManual').value.trim();
    if (!sessionId) {
      const r = await fetch('/api/session/new', { method: 'POST' });
      const d = await r.json();
      sessionId = d.id;
      sessionUrl = d.url;
    }

    goStep(3);
    const mount = document.getElementById('procMount');
    HMProcessing.mount(mount, { stage: 'queued', stageLabel: 'Đang khởi tạo phiên phân tích...' });

    try {
      const fd = new FormData();
      const meta = {
        targetRole: $('#targetRole').value.trim(),
        experienceLevel: $('#expLevel').value,
        jdUrl: jdUrl || null,
        jdManual: jdManual || null,
      };
      fd.append('meta', JSON.stringify(meta));

      const pdfTasks = [];
      for (const it of files) {
        const ext = (it.file.name.split('.').pop() || '').toLowerCase();
        if (ext === 'pdf') pdfTasks.push(extractPdf(it.file));
      }
      const pdfResults = await Promise.all(pdfTasks);

      let clientText = '';
      const images = [];
      pdfResults.forEach(r => {
        if (r.text) clientText += r.text + '\n\n';
        images.push(...r.images);
      });
      if (clientText.trim()) fd.append('clientPdfText', clientText);
      if (images.length) fd.append('clientPdfImages', JSON.stringify(images));

      // CV nhập tay (form / tự viết): gửi như text client-side — không cần file
      if (cvMode === 'manual') {
        const manualText = manualCvText();
        if (manualText) fd.append('clientPdfText', (clientText ? clientText + '\n\n' : '') + manualText);
      }

      for (const it of files) fd.append('files', it.file, it.file.name);

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'X-Session-Id': sessionId },
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Upload thất bại (${res.status})`);
      }
      const d = await res.json();
      sessionUrl = d.url;
      HMProcessing.update(null, null, sessionUrl);
      poll(sessionId);
    } catch (e) {
      HMProcessing.error(e.message);
    }
  }

  const STAGE_ORDER = ['queued', 'extracting', 'validating', 'jd', 'analyzing', 'done'];
  async function poll(id) {
    for (;;) {
      let d;
      try {
        const res = await fetch(`/api/session/${id}`);
        d = await res.json();
      } catch { await sleep(2500); continue; }
      if (d.error) { HMProcessing.error(d.error); return; }
      HMProcessing.update(d.stage || 'queued', d.stageLabel, sessionUrl);
      if (d.status === 'ready') { HMProcessing.stop(); location.href = `/s/${id}`; return; }
      if (d.status === 'error') { HMProcessing.error(d.error || 'Xử lý thất bại.'); return; }
      await sleep(2500);
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Buttons
  btnNext1.addEventListener('click', () => goStep(2));
  btnBack2.addEventListener('click', () => goStep(1));
  btnNext2.addEventListener('click', startProcessing);

  // Copy link (chỉ có trong processing UI; trang landing có thể không render)
  const btnCopy = $('#btnCopyLink');
  if (btnCopy) btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#sessionUrl').value);
      btnCopy.textContent = '✓ Đã copy';
      setTimeout(() => { btnCopy.textContent = 'Copy'; }, 2000);
    } catch { /* clipboard blocked */ }
  });
})();
