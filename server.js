// server.js — HireMind server: sessions, uploads, AI pipeline, chat, interview, cover letter.
// Load .env from the app's own folder (works under cPanel/Passenger where cwd differs).
require('./dotenv').loadEnv(__dirname);
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { processSession, sessionDir, readSession, writeSession, patchSession, withSession, DATA_DIR } = require('./lib/pipeline');
const { chatTurn, interviewSystem, parseInterviewTurn, generateCoverLetter } = require('./lib/services');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');

// ---------- Security headers (helmet-lite) — BEFORE static so every response carries them ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://r.jina.ai",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
});

app.use(express.json({ limit: '60mb' })); // client sends base64 PDF page images for OCR

// Static: HTML luôn mới (no-cache) — bump ?v= lo phần còn lại; css/js/img cache dài.
// Nguyên nhân: LiteSpeed gắn mặc định max-age 7 ngày cho cả HTML → user thấy bản cũ vĩnh viễn.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // ponytail: no-cache + ETag cho mọi asset — sửa file là ăn ngay, không phải bump ?v=.
    // Cần cache mạnh thì đổi sang: css/js → 'public, max-age=31536000, immutable' + bump ?v= mỗi lần sửa.
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Session page route — serve the SPA for /s/:id
app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'session.html'));
});

// ---------- Session storage ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function newSessionId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(DATA_DIR, req.sessionId, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\- ]+/g, '_').slice(-80);
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { files: 12, fileSize: 15 * 1024 * 1024 }, // 15MB/file
});

// Create (or extend) the pending session dir for this upload batch
app.use('/api/upload', (req, res, next) => {
  // Client sends its own pending session id (from /api/session/new) so multiple tabs don't collide.
  // Validated here BEFORE multer writes any file — blocks path traversal via the header.
  const id = req.headers['x-session-id'] || newSessionId();
  if (!/^[a-f0-9]{12}$/.test(id)) {
    return res.status(400).json({ error: 'Session id không hợp lệ' });
  }
  req.sessionId = id;
  next();
});

// ---------- Simple rate limiter (per-IP token bucket, no dependency) ----------
// AI-backed endpoints are expensive; a generous cap keeps one visitor from draining the quota
// while never getting in a real user's way (demo/test-friendly).
const RATE_LIMITS = { chat: 60, interview: 90, coverLetter: 30, analyze: 25 };
const rateBuckets = new Map(); // key -> { tokens, last }
setInterval(() => rateBuckets.clear(), 10 * 60 * 1000).unref();

function rateLimit(kind) {
  const max = RATE_LIMITS[kind] || 20;
  return (req, res, next) => {
    const key = `${kind}:${req.ip || 'unknown'}`;
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b) { b = { tokens: max, last: now }; rateBuckets.set(key, b); }
    b.tokens = Math.min(max, b.tokens + ((now - b.last) / 60000) * (max / 2)); // refill: half the cap per minute
    b.last = now;
    if (b.tokens < 1) return res.status(429).json({ error: 'Bạn thao tác quá nhanh — thử lại sau ít phút.' });
    b.tokens -= 1;
    next();
  };
}

// ---------- API ----------

// Create a fresh pending session (no files yet). Returns shareable link.
app.post('/api/session/new', (req, res) => {
  const id = newSessionId();
  fs.mkdirSync(sessionDir(id), { recursive: true });
  const session = {
    id,
    status: 'uploading', // uploading → processing → ready | error
    createdAt: new Date().toISOString(),
    files: [],
    meta: {},
  };
  fs.writeFileSync(path.join(sessionDir(id), 'session.json'), JSON.stringify(session, null, 2));
  res.json({ id, url: `${req.protocol}://${req.get('host')}/s/${id}` });
});

// Upload files + metadata. Processing starts immediately in background — user can leave.
app.post('/api/upload', rateLimit('analyze'), upload.array('files', 12), (req, res) => {
  const id = req.sessionId;
  const dir = sessionDir(id);
  if (!fs.existsSync(path.join(dir, 'session.json'))) {
    return res.status(404).json({ error: 'Phiên không tồn tại. Hãy tạo phiên mới.' });
  }
  const session = readSession(id);

  const files = (req.files || []).map(f => ({
    stored: f.filename,
    name: Buffer.from(f.originalname, 'latin1').toString('utf8'), // multer mis-decodes UTF-8 names
    size: f.size,
    type: f.mimetype,
  }));
  session.files.push(...files);

  // Metadata: role, experience, JD link, manual JD text, client-extracted PDF text/images
  try {
    if (req.body.meta) Object.assign(session.meta, JSON.parse(req.body.meta));
  } catch { /* ignore bad meta */ }
  if (req.body.clientPdfText) session.clientPdfText = req.body.clientPdfText;
  if (req.body.clientPdfImages) {
    try {
      session.clientPdfImages = JSON.parse(req.body.clientPdfImages);
    } catch { /* ignore */ }
  }

  session.status = 'processing';
  session.stage = 'queued';
  session.stageLabel = 'Đang chờ xử lý...';
  writeSession(session);

  // Fire and forget — user can close the tab
  setImmediate(() => processSession(id).catch(e => console.error(e)));

  res.json({ id, url: `${req.protocol}://${req.get('host')}/s/${id}` });
});

// Poll session status (frontend polls until ready)
app.get('/api/session/:id', (req, res) => {
  try {
    const s = readSession(req.params.id);
    res.json(publicSession(s));
  } catch {
    res.status(404).json({ error: 'Không tìm thấy phiên' });
  }
});

function publicSession(s) {
  const { clientPdfText, clientPdfImages, ...pub } = s;
  return pub;
}

// ---------- Chat ----------
// History persists in session.json (chatHistory) — survives tab switches & reloads.
// The user's message is persisted IMMEDIATELY (chatPending=true) so leaving the tab
// mid-answer never loses it; the reply is appended when the AI finishes.
app.post('/api/session/:id/chat', rateLimit('chat'), async (req, res) => {
  try {
    const s = readSession(req.params.id);
    if (s.status !== 'ready') return res.status(400).json({ error: 'Phiên chưa sẵn sàng' });
    const { message, images } = req.body;
    if (!message && !(images && images.length)) return res.status(400).json({ error: 'Thiếu tin nhắn' });
    const imgs = (Array.isArray(images) ? images : []).slice(0, 3)
      .filter(im => im && im.base64 && im.base64.length < 4 * 1024 * 1024)
      .map(im => ({ base64: String(im.base64), mime: String(im.mime || 'image/png') }));

    // Persist user turn + pending flag BEFORE the slow AI call (qua hàng đợi ghi)
    const { history } = await withSession(req.params.id, s => {
      const hist = Array.isArray(s.chatHistory) ? s.chatHistory.slice(-12) : [];
      s.chatHistory = [...hist, { role: 'user', content: String(message || '[ảnh]') }];
      s.chatPending = true;
      return { history: hist };
    });
    const reply = await chatTurn(s, String(message || '').slice(0, 4000), history, imgs);
    await withSession(req.params.id, s2 => {
      s2.chatHistory = [...(s2.chatHistory || []), { role: 'assistant', content: reply }];
      s2.chatPending = false;
    });
    const final = readSession(req.params.id);
    res.json({ reply, history: final.chatHistory });
  } catch (e) {
    console.error('[chat]', e);
    // Clear pending so the UI doesn't hang on a dead typing indicator
    try {
      await withSession(req.params.id, s => { s.chatPending = false; });
    } catch { /* ignore */ }
    res.status(500).json({ error: e.friendly || 'AI không phản hồi được. Thử lại sau ít phút.' });
  }
});

// Export any markdown as .docx
app.post('/api/export/docx', (req, res) => {
  try {
    const { title, markdown } = req.body || {};
    if (!markdown) return res.status(400).json({ error: 'Thiếu nội dung' });
    const { buildDocx } = require('./lib/docx');
    const buf = buildDocx(String(title || 'HireMind'), String(markdown).slice(0, 60000));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="hiremind-export.docx"');
    res.send(buf);
  } catch (e) {
    console.error('[docx]', e);
    res.status(500).json({ error: 'Không tạo được file Word' });
  }
});

// ---------- Mock Interview ----------
// Interview transcript persists in session.json (interviewMessages + interviewReport).
// In-memory map mirrors live state to avoid re-reading the file per turn.
const interviews = new Map(); // id -> { messages, ended, report }

function ivState(id) {
  if (!interviews.has(id)) {
    const s = readSession(id);
    interviews.set(id, { messages: s.interviewMessages || null });
  }
  return interviews.get(id);
}

app.post('/api/session/:id/interview/start', rateLimit('interview'), async (req, res) => {
  const s = readSession(req.params.id);
  if (s.status !== 'ready') return res.status(400).json({ error: 'Phiên chưa sẵn sàng' });
  const { prep } = req.body || {};
  const system = interviewSystem(s, { waitForReady: !!prep });
  const messages = [{ role: 'system', content: system }];
  // Kick off with the interviewer's first message
  messages.push({ role: 'user', content: prep
    ? '(Ứng viên vừa bấm nút luyện các câu hỏi khó từ báo cáo. Hãy mở đầu theo chế độ chuẩn bị: chào, giới thiệu, giải thích luồng, rồi chờ họ nói "sẵn sàng".)'
    : '(Bắt đầu buổi phỏng vấn. Hãy chào ứng viên ngắn gọn và hỏi câu hỏi đầu tiên.)' });
  interviews.set(req.params.id, { messages });
  await withSession(req.params.id, s => {
    s.interviewMessages = messages;
    s.interviewReport = null;
  });
  chatWithInterview(req.params.id, res);
});

app.post('/api/session/:id/interview/reply', rateLimit('interview'), async (req, res) => {
  const { message } = req.body;
  if (!interviews.has(req.params.id)) {
    // Page reloaded mid-interview — rebuild from persisted transcript
    const st = ivState(req.params.id);
    if (!st.messages) return res.status(400).json({ error: 'Buổi phỏng vấn chưa bắt đầu' });
  }
  if (!message) return res.status(400).json({ error: 'Thiếu câu trả lời' });
  const st = interviews.get(req.params.id);
  if (st.ended) return res.status(400).json({ error: 'Buổi phỏng vấn đã kết thúc. Bấm "Luyện lại" để bắt đầu buổi mới.' });
  st.messages.push({ role: 'user', content: String(message).slice(0, 4000) });
  await withSession(req.params.id, s => { s.interviewMessages = st.messages; });
  chatWithInterview(req.params.id, res);
});

app.post('/api/session/:id/interview/stop', (req, res) => {
  let st;
  if (!interviews.has(req.params.id)) {
    st = ivState(req.params.id);
    if (!st.messages) return res.status(400).json({ error: 'Buổi phỏng vấn chưa bắt đầu' });
  } else st = interviews.get(req.params.id);
  if (st.ended) { res.json({ question: '', ended: true, report: st.report }); return; }
  st.messages.push({ role: 'user', content: '(Ứng viên muốn kết thúc buổi phỏng vấn. Hãy kết thúc và xuất báo cáo tổng kết.)' });
  chatWithInterview(req.params.id, res);
});

// Resume an in-progress interview after reload
app.get('/api/session/:id/interview/state', (req, res) => {
  try {
    const s = readSession(req.params.id);
    if (s.interviewReport) return res.json({ hasSession: true, ended: true, report: s.interviewReport, mood: s.interviewMood || null });
    const st = ivState(req.params.id);
    if (!st.messages) return res.json({ hasSession: false });
    // User bấm "Kết thúc" và AI đang viết báo cáo → tín hiệu riêng để UI hiện màn "đang tổng hợp báo cáo"
    const lastMsg = st.messages[st.messages.length - 1];
    if (s.interviewPending && lastMsg?.role === 'user' && /muốn kết thúc buổi phỏng vấn/.test(lastMsg.content || '')) {
      return res.json({ hasSession: true, ending: true, pending: true });
    }
    // Last assistant message = current question
    const lastAssistant = [...st.messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) return res.json({ hasSession: true, ended: false, question: null, pending: !!s.interviewPending });
    const { parseInterviewTurn } = require('./lib/services');
    const { question, ended, report } = parseInterviewTurn(lastAssistant.content);
    if (ended) return res.json({ hasSession: true, ended: true, report: report || s.interviewReport, mood: s.interviewMood || null });
    return res.json({ hasSession: true, ended: false, question, pending: !!s.interviewPending, mood: s.interviewMood || null });
  } catch (e) {
    console.error('[interview-state]', e);
    res.json({ hasSession: false });
  }
});

// ---------- Interview history (nhiều buổi) ----------
// Transcript của buổi hiện tại (mood từng lượt interviewer) — để UI rebuild như chat coach
app.get('/api/session/:id/interview/transcript', (req, res) => {
  try {
    const s = readSession(req.params.id);
    const msgs = Array.isArray(s.interviewMessages) ? s.interviewMessages : [];
    const { parseInterviewTurn } = require('./lib/services');
    const turns = [];
    for (const m of msgs) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        const content = String(m.content).replace(/^\(.*?\)\s*/, '');
        if (content && !content.startsWith('(')) turns.push({ role: 'user', content });
      } else {
        const { question, mood } = parseInterviewTurn(m.content);
        if (question) turns.push({ role: 'interviewer', content: question, mood: mood || null });
      }
    }
    res.json({ turns });
  } catch {
    res.json({ turns: [] });
  }
});

// "Buổi mới": lưu buổi hiện tại vào interviewHistory[] rồi reset state.
app.post('/api/session/:id/interview/archive', rateLimit('interview'), async (req, res) => {
  try {
    const { historyCount } = await withSession(req.params.id, s => {
      s.interviewHistory = Array.isArray(s.interviewHistory) ? s.interviewHistory : [];
      // Archive buổi hiện tại (nếu có nội dung)
      if (Array.isArray(s.interviewMessages) && s.interviewMessages.length > 1) {
        const { parseInterviewTurn } = require('./lib/services');
        const transcript = [];
        for (const m of s.interviewMessages) {
          if (m.role === 'system') continue;
          if (m.role === 'user') {
            const content = String(m.content).replace(/^\(.*?\)\s*/, '');
            if (content && !content.startsWith('(')) transcript.push({ role: 'user', content });
          } else {
            const { question, mood } = parseInterviewTurn(m.content);
            if (question) transcript.push({ role: 'interviewer', content: question, mood: mood || null });
          }
        }
        if (transcript.length) {
          s.interviewHistory.unshift({
            endedAt: new Date().toISOString(),
            report: s.interviewReport || null,
            mood: s.interviewMood || null,
            transcript,
          });
        }
      }
      s.interviewMessages = null;
      s.interviewReport = null;
      s.interviewPending = false;
      s.interviewMood = null;
      return { historyCount: s.interviewHistory.length };
    });
    interviews.delete(req.params.id);
    res.json({ ok: true, historyCount });
  } catch (e) {
    console.error('[interview-archive]', e);
    res.status(500).json({ error: 'Không lưu được buổi phỏng vấn' });
  }
});

// Danh sách buổi đã lưu (tóm tắt)
app.get('/api/session/:id/interview/history', (req, res) => {
  try {
    const s = readSession(req.params.id);
    const history = (s.interviewHistory || []).map((h, i) => ({
      index: i,
      endedAt: h.endedAt,
      score: h.report?.overallScore ?? null,
      verdict: h.report?.verdict || null,
      turns: h.transcript?.length ?? 0,
    }));
    res.json({ history });
  } catch {
    res.json({ history: [] });
  }
});

// Chi tiết 1 buổi đã lưu
app.get('/api/session/:id/interview/history/:index', (req, res) => {
  try {
    const s = readSession(req.params.id);
    const h = (s.interviewHistory || [])[+req.params.index];
    if (!h) return res.status(404).json({ error: 'Không tìm thấy buổi' });
    res.json(h);
  } catch {
    res.status(500).json({ error: 'Lỗi đọc lịch sử' });
  }
});

async function chatWithInterview(id, res) {
  const st = interviews.get(id);
  try {
    // Mark pending so a reload during the AI call knows a question is coming
    await withSession(id, s0 => { s0.interviewPending = true; }).catch(() => {});
    const { chat } = require('./lib/ai');
    const raw = await chat(st.messages, { maxTokens: 4000, temperature: 0.6 });
    let { question, ended, report, mood } = parseInterviewTurn(raw);
    // Report JSON bị cắt (AI trả lời quá dài) → hỏi lại đúng một lượt chỉ để lấy báo cáo
    if (ended && !report) {
      try {
        const retryMsgs = [...st.messages, { role: 'user', content: '(Báo cáo vừa rồi bị cắt. Hãy xuất LẠI: in ===INTERVIEW_END=== trước, sau đó CHỈ MỘT JSON object đúng định dạng đã yêu cầu, ngắn gọn hơn.)' }];
        const raw2 = await chat(retryMsgs, { maxTokens: 4000, temperature: 0.4 });
        report = parseInterviewTurn(raw2).report;
      } catch { /* giữ report null — UI có màn hình dự phòng */ }
    }
    st.messages.push({ role: 'assistant', content: raw });
    if (mood) st.mood = mood;
    if (ended) {
      st.ended = true;
      st.report = report;
      await withSession(id, s => {
        s.interviewMessages = st.messages;
        s.interviewReport = report || null;
        s.interviewPending = false;
        if (mood) s.interviewMood = mood;
      }).catch(() => { /* session dir missing */ });
    } else {
      await withSession(id, s => {
        s.interviewMessages = st.messages;
        s.interviewPending = false;
        if (mood) s.interviewMood = mood;
      }).catch(() => { /* ignore */ });
    }
    res.json({ question, ended, report, mood: st.mood || mood || null });
  } catch (e) {
    console.error('[interview]', e);
    try {
      await withSession(id, s0 => { s0.interviewPending = false; });
    } catch { /* ignore */ }
    res.status(500).json({ error: e.friendly || 'AI không phản hồi được. Thử lại.' });
  }
}

// ---------- Cover Letter ----------
// Persisted like chat/interview: coverLetter + coverLetterMeta saved when done,
// coverLetterPending=true while generating — user can leave the tab and come back.
app.post('/api/session/:id/cover-letter', rateLimit('coverLetter'), async (req, res) => {
  try {
    const s = readSession(req.params.id);
    if (s.status !== 'ready') return res.status(400).json({ error: 'Phiên chưa sẵn sàng' });
    const { tone, language, extraNote } = req.body || {};

    // Đã có thư cùng option → trả lại luôn (không tốn AI call)
    const optsKey = JSON.stringify({ tone: tone || 'professional', language: language || 'vi', extraNote: extraNote || null });
    if (s.coverLetter && s.coverLetterMeta === optsKey) {
      return res.json({ ...s.coverLetter, cached: true });
    }

    await withSession(req.params.id, s2 => {
      s2.coverLetterPending = true;
      s2.coverLetterMeta = optsKey;
    });

    try {
      const result = await generateCoverLetter(s, { tone, language, extraNote });
      await withSession(req.params.id, s2 => {
        s2.coverLetter = result;
        s2.coverLetterPending = false;
      });
      res.json(result);
    } catch (e) {
      await withSession(req.params.id, s2 => { s2.coverLetterPending = false; });
      throw e;
    }
  } catch (e) {
    console.error('[cover-letter]', e);
    res.status(500).json({ error: e.friendly || 'Không tạo được cover letter. Thử lại.' });
  }
});

// Passenger (cPanel "Setup Node.js App") requires the app to listen on the port it
// provides via env var; fall back to 3000 for local dev.
const server = app.listen(PORT, () => {
  console.log(`HireMind running at http://localhost:${PORT}`);
  // Startup sweep: sessions stuck in "processing" from a previous run are dead —
  // their background pipeline died with the old process. Mark them so users see a
  // friendly error instead of an endless spinner.
  try {
    for (const id of fs.readdirSync(DATA_DIR)) {
      if (!/^[a-f0-9]{12}$/.test(id)) continue;
      const file = path.join(DATA_DIR, id, 'session.json');
      if (!fs.existsSync(file)) continue;
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s.status === 'processing') {
        patchSession(id, {
          status: 'error',
          error: 'Máy chủ đã khởi động lại giữa lúc xử lý phiên này. Hãy tạo phiên mới — xin lỗi vì sự bất tiện.',
          chatPending: false,
          interviewPending: false,
          coverLetterPending: false,
        });
        console.log(`[startup] marked stale session ${id} as error`);
      }
    }
  } catch (e) {
    console.warn('[startup] sweep failed:', e.message);
  }
});
