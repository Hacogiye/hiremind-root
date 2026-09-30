// lib/pipeline.js — Session processing pipeline: extract → validate → fetch JD → AI analyze.
// Runs in background after upload; user can leave the page immediately.
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { chat, chatJson, ocrImage } = require('./ai');
const { fetchJD } = require('./jd');

const DATA_DIR = path.join(__dirname, '..', 'data');

const MAX_CV_CHARS = 14000;
const MAX_JD_CHARS = 9000;

function sessionDir(id) {
  // Reject anything that is not a plain 12-hex session id — blocks path traversal
  // (e.g. "X-Session-Id: ../../evil" would otherwise escape DATA_DIR).
  if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) {
    const err = new Error('Session id không hợp lệ');
    err.status = 400;
    throw err;
  }
  return path.join(DATA_DIR, id);
}

function readSession(id) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir(id), 'session.json'), 'utf8'));
}

function writeSession(session) {
  fs.writeFileSync(path.join(sessionDir(session.id), 'session.json'), JSON.stringify(session, null, 2));
}

// ---------- Hàng đợi ghi theo phiên ----------
// Mọi ghi session.json đi qua withSession(): mutation chạy trên dữ liệu đọc MỚI NHẤT
// và các ghi của cùng một phiên thực hiện tuần tự. Chống mất cập nhật khi pipeline +
// chat + interview + cover letter ghi chồng nhau (read-modify-write race).
const writeQueues = new Map(); // id -> Promise (đuôi hàng đợi của phiên)

function withSession(id, mutator) {
  const tail = (writeQueues.get(id) || Promise.resolve()).catch(() => {});
  const job = tail.then(async () => {
    const s = readSession(id);
    const out = await mutator(s);
    writeSession(s);
    return out === undefined ? s : out;
  });
  const tracked = job.catch(() => {});
  writeQueues.set(id, tracked);
  tracked.then(() => { if (writeQueues.get(id) === tracked) writeQueues.delete(id); });
  return job;
}

function patchSession(id, patch) {
  return withSession(id, s => { Object.assign(s, patch); });
}

async function withRetry(fn, { tries = 3, baseMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e && e.noRetry) throw e; // 4xx trừ 429 — retry không thể giúp
      if (i < tries - 1) await new Promise(r => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- File text extraction ----------

async function extractFromUploads(session) {
  const dir = path.join(sessionDir(session.id), 'uploads');
  const parts = [];
  const needsOcr = []; // { base64, mime }
  const warnings = [];

  // Client may send pre-extracted PDF text + page images (pdf.js).
  if (session.clientPdfText && session.clientPdfText.trim().length > 150) {
    parts.push({ source: 'PDF (client)', text: session.clientPdfText.trim() });
  }
  if (Array.isArray(session.clientPdfImages)) {
    needsOcr.push(...session.clientPdfImages.slice(0, 8));
  }

  for (const f of session.files) {
    const full = path.join(dir, f.stored);
    const ext = path.extname(f.name).toLowerCase();
    try {
      if (ext === '.txt' || ext === '.md') {
        const text = fs.readFileSync(full, 'utf8');
        if (text.trim()) parts.push({ source: f.name, text: text.trim() });
      } else if (ext === '.docx') {
        const { value } = await mammoth.extractRawText({ path: full });
        if (value.trim()) parts.push({ source: f.name, text: value.trim() });
        else warnings.push(`${f.name}: file DOCX không có nội dung text`);
      } else if (ext === '.pdf') {
        // text handled above via client; if client gave nothing, try server-side parse
        if (!parts.some(p => p.source === 'PDF (client)')) {
          try {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(fs.readFileSync(full));
            if (data.text && data.text.trim().length > 150) {
              parts.push({ source: f.name, text: data.text.trim() });
            } else {
              warnings.push(`${f.name}: PDF có vẻ là file scan, cần OCR`);
            }
          } catch (e) {
            warnings.push(`${f.name}: không đọc được PDF trực tiếp (${e.message.slice(0, 80)})`);
          }
        }
      } else if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) {
        const b64 = fs.readFileSync(full).toString('base64');
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.bmp' ? 'image/bmp' : 'image/png';
        needsOcr.push({ base64: b64, mime, name: f.name });
      } else {
        warnings.push(`${f.name}: định dạng không hỗ trợ, đã bỏ qua`);
      }
    } catch (e) {
      warnings.push(`${f.name}: lỗi khi xử lý (${e.message.slice(0, 80)})`);
    }
  }

  // OCR images (sequential to be gentle on the API)
  for (let i = 0; i < needsOcr.length; i++) {
    const img = needsOcr[i];
    try {
      const text = await withRetry(() => ocrImage(img.base64, img.mime), { tries: 3 });
      if (text.trim()) {
        parts.push({ source: img.name || `Trang ảnh ${i + 1} (OCR)`, text: text.trim() });
      } else {
        warnings.push(`${img.name || `Ảnh ${i + 1}`}: không trích xuất được nội dung`);
      }
    } catch (e) {
      warnings.push(`${img.name || `Ảnh ${i + 1}`}: OCR thất bại (${e.message.slice(0, 80)})`);
    }
  }

  return { parts, warnings };
}

// ---------- AI steps ----------

async function validateAndStructure(parts) {
  const combined = parts.map(p => `=== ${p.source} ===\n${p.text}`).join('\n\n');
  const prompt = `Bạn là hệ thống phân tích tài liệu tuyển dụng. Dưới đây là nội dung từ hồ sơ người dùng (tải file lên, OCR ảnh, hoặc tự điền khi chưa có file CV — nội dung tự điền vẫn là CV hợp lệ nếu có thông tin ứng viên).

${combined.slice(0, MAX_CV_CHARS)}

NHIỆM VỤ:
1. Xác định đây có phải là CV/Sơ yếu lý lịch của MỘT người hay không (thông tin học vấn/kinh nghiệm/kỹ năng của một ứng viên). Dữ liệu nhập tay lỏng lẻo vẫn tính là CV nếu nói về một người thật.
2. Nếu có nhiều phần CV, hãy ghép chúng thành MỘT CV hoàn chỉnh theo thứ tự logic.
3. Trích xuất thông tin có cấu trúc từ CV.

Trả về CHỈ một JSON object theo đúng schema:
{
  "isCv": boolean,
  "reason": "nếu không phải CV, giải thích ngắn gọn bằng tiếng Việt",
  "multiplePeople": boolean,  // true nếu phát hiện CV của nhiều người khác nhau
  "candidateName": "tên ứng viên",
  "candidateTitle": "chức danh hiện tại (vd: Kỹ sư phần mềm, Sinh viên mới ra trường)",
  "experienceYears": number,
  "cleanedCv": "toàn bộ nội dung CV đã được dọn sạch và hợp nhất, dạng Markdown, giữ nguyên thông tin gốc",
  "extractedSkills": ["kỹ năng kỹ thuật/tools", ...],
  "hasProjects": boolean,
  "hasCertifications": boolean,
  "sections": ["Mục tiêu", "Kinh nghiệm", ...]  // các mục có trong CV
}`;

  const result = await withRetry(() => chatJson([{ role: 'user', content: prompt }], { maxTokens: 6000, temperature: 0.2 }));
  if (!result || typeof result.isCv !== 'boolean') throw new Error('AI trả về kết quả validate không hợp lệ');
  return result;
}

async function structureJD(jdText, url) {
  const prompt = `Bạn là hệ thống phân tích tin tuyển dụng. Đây là nội dung được tải từ: ${url || '(người dùng dán thủ công)'}

${jdText.slice(0, MAX_JD_CHARS)}

NHIỆM VỤ: Trích xuất thông tin tin tuyển dụng có cấu trúc. Bỏ qua navigation, footer, quảng cáo, nội dung site không liên quan.

Trả về CHỈ một JSON object:
{
  "title": "tên vị trí tuyển dụng",
  "company": "tên công ty (nếu tìm thấy)",
  "location": "địa điểm",
  "salary": "mức lương (nếu có)",
  "experienceRequired": "số năm kinh nghiệm yêu cầu",
  "mustHave": ["yêu cầu bắt buộc 1", ...],
  "niceToHave": ["yêu cầu nên có 1", ...],
  "responsibilities": ["trách nhiệm chính 1", ...],
  "benefits": ["quyền lợi 1", ...]
}`;

  const result = await withRetry(() => chatJson([{ role: 'user', content: prompt }], { maxTokens: 3000, temperature: 0.2 }));
  if (!result || !Array.isArray(result.mustHave)) throw new Error('AI phân tích JD không hợp lệ');
  return result;
}

async function analyzeCV(cvText, meta, jdStructured) {
  const jdSection = jdStructured
    ? `

=== TIN TUYỂN DỤNG MỤC TIÊU ===
Vị trí: ${jdStructured.title}
Công ty: ${jdStructured.company || '—'}
Địa điểm: ${jdStructured.location || '—'}
Lương: ${jdStructured.salary || '—'}
Kinh nghiệm yêu cầu: ${jdStructured.experienceRequired || '—'}
Yêu cầu bắt buộc: ${JSON.stringify(jdStructured.mustHave)}
Yêu cầu nên có: ${JSON.stringify(jdStructured.niceToHave || [])}
Trách nhiệm: ${JSON.stringify((jdStructured.responsibilities || []).slice(0, 8))}`
    : '';

  const prompt = `Bạn là chuyên gia tuyển dụng IT/nhân sự dày dặn kinh nghiệm tại Việt Nam, am hiểu sâu cả thị trường Việt Nam và quốc tế. Hãy phân tích CV dưới đây như một nhà tuyển dụng thật, thẳng thắn nhưng mang tính xây dựng.${jdSection}

=== CV ỨNG VIÊN: ${meta.candidateName || ''} (${meta.targetRole || 'chưa rõ'} | ${meta.experienceLevel || 'chưa rõ'}) ===
${String(cvText || '').slice(0, MAX_CV_CHARS)}

${jdStructured
  ? `NHIỆM VỤ (bắt buộc có phần đối chiếu JD):
1. Chấm điểm CV tổng thể (0-100) theo 4 tiêu chí: content (nội dung, thành tích định lượng), format (trình bày, cấu trúc), relevance (liên quan vị trí mục tiêu), impact (điểm nhấn, con số).
2. Điểm mạnh / điểm yếu cụ thể — TRÍCH DẪN thẳng từ CV, không nói chung chung.
3. Đối chiếu CV với tin tuyển dụng: từng yêu cầu của JD đáp ứng hay không, TRÍCH BẰNG CHỨNG cụ thể từ CV. Chấm điểm khớp ATS (0-100).
4. Skill gap: kỹ năng còn thiếu so với JD + lộ trình học cụ thể (tên khóa/công nghệ, thời gian ước lượng, thứ tự ưu tiên).
5. Red flags ATS: những gì khiến CV bị loại bởi hệ thống lọc CV.
6. 3 câu hỏi phỏng vấn khó nhất ứng viên có thể gặp với JD này dựa trên CV hiện tại.`
  : `NHIỆM VỤ:
1. Chấm điểm CV tổng thể (0-100) theo 4 tiêu chí: content (nội dung, thành tích định lượng), format (trình bày, cấu trúc), relevance (liên quan vị trí mục tiêu "${meta.targetRole}"), impact (điểm nhấn, con số).
2. Điểm mạnh / điểm yếu cụ thể — TRÍCH DẪN thẳng từ CV, không nói chung chung.
3. Gợi ý cải thiện cụ thể (làm gì, sửa gì, thêm gì).
4. Red flags ATS: những gì khiến CV bị hệ thống lọc CV loại.
5. 3 câu hỏi phỏng vấn khó nhất ứng viên có thể gặp dựa trên CV này.`}

QUY TẮC alternativePaths: nếu điểm thấp (overallScore dưới 45) hoặc khả năng đậu dưới 25%, hoặc CV rõ ràng lệch hướng so với vị trí mục tiêu — hãy đề xuất 2-3 vị trí/công việc KHÁC mà CV này thực sự có lợi thế hơn, dựa trên bằng chứng trong CV và thực tế thị trường Việt Nam. Nếu hồ sơ vẫn hợp lý với vị trí mục tiêu thì để null.

QUY TẮC ĐỘ DÀI (bắt buộc — phản hồi phải gọn): mỗi chuỗi tối đa ~25 từ, không diễn giải dài dòng; strengths tối đa 4, weaknesses tối đa 4, improvements tối đa 3, atsRedFlags tối đa 4, match.matched tối đa 5, match.missing tối đa 5, roadmap tối đa 5 bước, alternativePaths tối đa 3.


Trả về CHỈ một JSON object:
{
  "overallScore": number,
  "breakdown": { "content": number, "format": number, "relevance": number, "impact": number },
  "hireAssessment": {
    "passProbability": number,          // 0-100: ước lượng khả năng ĐƯỢC MỜI PHỎNG VẤN với chính JD này
    "verdict": "very_likely|likely|uncertain|unlikely|very_unlikely",
    "headline": "câu kết luận ngắn gọn, trực diện, vd: 'Khả năng đậu phỏng vấn: 15% — gần như chắc chắn bị loại ở vòng lọc CV'",
    "reasons": ["lý do chính khiến tỉ lệ này (tích cực hoặc tiêu cực)"],
    "whatWouldRaise": ["hành động cụ thể giúp tăng tỉ lệ này lên đáng kể"]
  },
  "summary": "tóm tắt 2-3 câu về ứng viên, tiếng Việt",
  "strengths": [{ "point": "...", "evidence": "trích dẫn từ CV" }],
  "weaknesses": [{ "point": "...", "evidence": "...", "fix": "cách sửa cụ thể" }],
  "improvements": [{ "title": "...", "detail": "...", "priority": "high|medium|low", "impact": "why it matters" }],
  "atsRedFlags": ["..."],
  "hardQuestions": ["..."],
  "match": {  // null nếu không có JD
    "matchScore": number,
    "verdict": "excellent|good|moderate|weak",
    "matched": [{ "requirement": "...", "evidence": "..." }],
    "missing": [{ "requirement": "...", "severity": "critical|important|nice", "note": "..." }],
    "extraPoints": ["điểm cộng ứng viên có nhưng JD không yêu cầu"]
  },
  "roadmap": [  // null nếu không có JD
    { "step": 1, "skill": "...", "why": "tại sao cần", "how": "học ở đâu / làm gì cụ thể", "duration": "vd: 2 tuần", "priority": "high|medium|low" }
  ],
  "alternativePaths": [  // null nếu hồ sơ vẫn hợp lý với vị trí mục tiêu — chỉ điền khi đạt quy tắc alternativePaths ở trên
    {
      "role": "tên vị trí phù hợp hơn, vd: Chuyên viên phân tích tài chính",
      "fitScore": number,                // 0-100: mức phù hợp của CV này với vị trí đề xuất
      "why": "vì sao CV này có lợi thế ở vị trí đó — trích dẫn bằng chứng từ CV",
      "note": "điều cần chuẩn bị thêm nếu chuyển hướng sang vị trí này"
    }
  ]
}`;

  const result = await withRetry(() => chatJson([{ role: 'user', content: prompt }], { maxTokens: 8000, temperature: 0.15 }));
  if (typeof result.overallScore !== 'number') throw new Error('AI phân tích CV không hợp lệ');
  // Giới hạn số lượng mục theo prompt (AI hay bỏ qua) + fallback hireAssessment
  // Cap mảng theo QUY TẮC ĐỘ DÀI — AI thường bỏ qua, chặt ở server cho chắc
  const cap = (arr, n) => Array.isArray(arr) ? arr.slice(0, n) : arr;
  result.strengths = cap(result.strengths, 4);
  result.weaknesses = cap(result.weaknesses, 4);
  result.improvements = cap(result.improvements, 3);
  result.atsRedFlags = cap(result.atsRedFlags, 4);
  result.alternativePaths = result.alternativePaths ? result.alternativePaths.slice(0, 3) : null;
  if (result.match) {
    result.match.matched = cap(result.match.matched, 5);
    result.match.missing = cap(result.match.missing, 5);
  }
  result.roadmap = result.roadmap ? result.roadmap.slice(0, 5) : null;
  if (!result.hireAssessment || typeof result.hireAssessment.passProbability !== 'number') {
    const score = result.overallScore || 0;
    result.hireAssessment = {
      passProbability: Math.max(2, Math.min(95, Math.round(score * 0.9))),
      verdict: score >= 75 ? 'likely' : score >= 50 ? 'uncertain' : score >= 30 ? 'unlikely' : 'very_unlikely',
      headline: '',
      reasons: [],
      whatWouldRaise: [],
    };
  }
  return result;
}

// ---------- Main pipeline ----------

async function processSession(id) {
  let session;
  try {
    session = readSession(id);
    if (session.status === 'ready') return;

    // Target role is required — never spend AI tokens scoring blind
    if (!(session.meta?.targetRole || '').trim()) {
      patchSession(id, {
        status: 'error',
        error: 'Thiếu vị trí nhắm tới. HireMind đối chiếu CV với một đích cụ thể — mở lại trang, tạo phiên mới và điền "Vị trí bạn nhắm tới" (VD: Data Analyst).',
        missingRole: true,
      });
      return;
    }

    // Stage 1: extract
    patchSession(id, { stage: 'extracting', stageLabel: 'Đang đọc và trích xuất nội dung CV...' });
    const { parts, warnings } = await extractFromUploads(session);
    if (!parts.length) {
      patchSession(id, { status: 'error', error: 'Không trích xuất được nội dung nào từ các file. Hãy kiểm tra lại file (CV dạng scan cần ảnh rõ chữ).' });
      return;
    }

    // Stage 2: validate + structure CV
    patchSession(id, { stage: 'validating', stageLabel: 'AI đang đọc hiểu CV của bạn...', warnings });
    const cv = await validateAndStructure(parts);
    if (!cv.isCv) {
      patchSession(id, { status: 'error', error: cv.reason || 'Tài liệu tải lên có vẻ không phải là CV.', notCv: true });
      return;
    }

    // Stage 3: JD
    let jdStructured = null;
    let jdNotice = null;
    let jdSource = null;
    if (session.meta.jdUrl || session.meta.jdManual) {
      patchSession(id, { stage: 'jd', stageLabel: 'Đang tải và phân tích tin tuyển dụng...' });
      let jdText = null;
      if (session.meta.jdUrl) {
        try {
          const { text, via } = await withRetry(() => fetchJD(session.meta.jdUrl), { tries: 1 });
          jdText = text;
          jdSource = via;
        } catch (e) {
          if (session.meta.jdManual) {
            jdText = session.meta.jdManual;
            jdSource = 'manual';
            jdNotice = 'Không tải được tự động từ link JD, đã dùng nội dung bạn dán thủ công.';
          } else {
            jdNotice = 'Không tải được nội dung từ link JD. Phân tích tiếp theo CV (không có phần đối chiếu JD). Bạn có thể quay lại và tạo phiên mới với nội dung JD dán thủ công.';
          }
        }
      } else {
        jdText = session.meta.jdManual;
        jdSource = 'manual';
      }
      if (jdText) {
        jdStructured = await structureJD(jdText, session.meta.jdUrl);
      }
    }

    // Stage 4: analyze
    patchSession(id, { stage: 'analyzing', stageLabel: 'AI đang phân tích sâu và đối chiếu...' });
    const analysis = await analyzeCV(cv.cleanedCv || '', session.meta, jdStructured);

    patchSession(id, {
      status: 'ready',
      stage: 'done',
      stageLabel: 'Hoàn tất',
      cv,
      jd: jdStructured,
      jdSource,
      jdNotice,
      result: analysis,
      readyAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[pipeline:${id}]`, e);
    try {
      patchSession(id, { status: 'error', error: e.friendly || `Xử lý thất bại: ${e.message.slice(0, 200)}` });
    } catch (_) { /* session dir missing */ }
  }
}

module.exports = { processSession, sessionDir, readSession, writeSession, patchSession, withSession, DATA_DIR };
