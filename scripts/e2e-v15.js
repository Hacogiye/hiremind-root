// scripts/e2e-v15.js — E2E test v15: upload → ready → rewrite → cache → reupload → compare.
// Chạy: node scripts/e2e-v15.js [đường-dẫn-CV-tương-đối-scripts]  (server phải đang chạy ở BASE)
const BASE = process.env.BASE || 'http://localhost:3111';
const fs = require('fs');
const path = require('path');

const CV_FILE = process.argv[2] || '../data/8a7bfe3a5bd6/uploads/1790300478483_mau cv.jpg';
const JD_MANUAL = `Trưởng phòng Hành chính — Công ty TNHH ABC
Mô tả công việc: Quản lý bộ phận hành chính 10 người; xây dựng quy trình vận hành nội bộ (SOP); quản lý văn phòng, tài sản, hợp đồng; tổ chức sự kiện nội bộ; đàm phán và quản lý nhà cung cấp dịch vụ.
Yêu cầu: Tốt nghiệp Đại học Quản trị kinh doanh/Hành chính; 2+ năm kinh nghiệm hành chính nhân sự; kỹ năng tổ chức và quản lý thời gian tốt; thành thạo Excel, Google Workspace; giao tiếp, đàm phán với nhà cung cấp; ưu tiên đã xây dựng quy trình SOP.
Quyền lợi: Lương 15-25 triệu; thưởng theo quý; BHXH đầy đủ; review lương 6 tháng/lần.`;
const TARGET_ROLE = 'Trưởng phòng Hành chính';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollReady(id, maxMs = 420000) {
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${BASE}/api/session/${id}`);
    const s = await res.json();
    if (s.status === 'ready') return s;
    if (s.status === 'error') throw new Error('Session error: ' + s.error);
    if (Date.now() - t0 > maxMs) throw new Error('Timeout chờ ready');
    await sleep(3000);
  }
}

(async () => {
  const buf = fs.readFileSync(path.join(__dirname, CV_FILE));

  // 1. Tạo phiên + upload CV ảnh (kèm JD dán tay)
  const nr = await fetch(`${BASE}/api/session/new`, { method: 'POST' }).then(r => r.json());
  console.log('1. session/new →', nr.id);
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), 'mau-cv.jpg');
  fd.append('meta', JSON.stringify({ targetRole: TARGET_ROLE, experienceLevel: 'Dưới 1 năm', jdManual: JD_MANUAL }));
  const up = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd, headers: { 'X-Session-Id': nr.id } }).then(r => r.json());
  if (up.error) throw new Error('upload: ' + up.error);
  console.log('2. upload →', up.id, up.url);

  // 2. Poll đến ready
  const s = await pollReady(nr.id);
  console.log(`3. ready: candidate="${s.cv.candidateName}" score=${s.result.overallScore} ats=${s.result.match?.matchScore} pass=${s.result.hireAssessment?.passProbability}% jd="${s.jd?.title}"`);

  // 3. Rewrite
  const t0 = Date.now();
  const rw = await fetch(`${BASE}/api/session/${nr.id}/rewrite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
  if (rw.error) throw new Error('rewrite: ' + rw.error);
  console.log(`4. rewrite (${((Date.now() - t0) / 1000).toFixed(0)}s): note="${(rw.note || '').slice(0, 90)}" | changes=${rw.changes?.length} | unfixableGaps=${rw.unfixableGaps?.length} | cvLen=${rw.rewrittenCv?.length}`);
  console.log('   CV preview:', (rw.rewrittenCv || '').slice(0, 220).replace(/\n/g, ' ⏎ '));
  if (rw.changes?.length) console.log('   change[0]:', JSON.stringify(rw.changes[0]).slice(0, 180));
  if (rw.unfixableGaps?.length) console.log('   gap[0]:', JSON.stringify(rw.unfixableGaps[0]).slice(0, 140));
  if (!rw.rewrittenCv || rw.rewrittenCv.length < 500) throw new Error('rewrittenCv quá ngắn — bất thường');
  if (!Array.isArray(rw.changes)) throw new Error('changes không phải mảng');

  // 4. Gọi lại → phải cache
  const rw2 = await fetch(`${BASE}/api/session/${nr.id}/rewrite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
  console.log('5. gọi lại rewrite → cached =', rw2.cached === true ? 'OK' : 'FAILED (không có cờ cached)');
  if (rw2.cached !== true) throw new Error('Cache không hoạt động');

  // 5. Reupload kiểm chứng (cùng CV — kết quả phải ~ ngang bố)
  const fd2 = new FormData();
  fd2.append('files', new Blob([buf], { type: 'image/jpeg' }), 'mau-cv.jpg');
  const ru = await fetch(`${BASE}/api/session/${nr.id}/reupload`, { method: 'POST', body: fd2 }).then(r => r.json());
  if (ru.error) throw new Error('reupload: ' + ru.error);
  console.log('6. reupload →', ru.id);
  const s2 = await pollReady(ru.id);
  console.log(`7. child ready: parentSessionId=${s2.parentSessionId} | score=${s2.result.overallScore} (gốc ${s.result.overallScore}) | ats=${s2.result.match?.matchScore} (gốc ${s.result.match?.matchScore}) | jd="${s2.jd?.title}"`);
  if (s2.parentSessionId !== nr.id) throw new Error('parentSessionId không trỏ về phiên gốc');
  if (!s2.meta.targetRole) throw new Error('Phiên con không kế thừa targetRole');
  console.log('E2E OK ✔ — tất cả bước đều pass');
})().catch(e => { console.error('E2E FAILED:', e.message); process.exit(1); });
