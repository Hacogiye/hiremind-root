// lib/ai.js — AI client (OpenAI-compatible). Single provider/model for everything.
// Credentials come from env vars (see .env.example) — never hardcode keys in source.
const AI_BASE_URL = process.env.AI_BASE_URL;
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'main_model';

if (!AI_BASE_URL || !AI_API_KEY) {
  console.error('⚠ Thiếu AI_BASE_URL / AI_API_KEY — sao chép .env.example thành .env rồi điền thông tin AI provider.');
}

// Phân loại lỗi HTTP từ AI provider: thông điệp thân thiện cho UI + cờ noRetry
// (4xx trừ 429 — retry không thể giúp, ngừng ngay để không đốt thời gian/người dùng chờ)
function aiHttpError(status, body) {
  const map = {
    400: ['AI từ chối yêu cầu (HTTP 400) — payload có thể quá lớn hoặc model không hỗ trợ.', true],
    401: ['AI từ chối API key (HTTP 401) — kiểm tra lại AI_API_KEY.', true],
    402: ['Tài khoản AI hết số dư (HTTP 402) — nạp thêm cho AI provider rồi thử lại.', true],
    403: ['AI từ chối API key (HTTP 403) — kiểm tra quyền của AI_API_KEY.', true],
    404: ['Không tìm thấy endpoint/model AI (HTTP 404) — kiểm tra AI_BASE_URL và AI_MODEL.', true],
    429: ['AI đang quá tải (HTTP 429) — thử lại sau ít phút.', false],
  };
  const [msg, noRetry] = map[status] || [`AI provider tạm lỗi (HTTP ${status}) — thử lại sau ít phút.`, false];
  const err = new Error(`${msg}${body ? ` | ${body.slice(0, 120)}` : ''}`);
  err.friendly = msg;
  err.status = status;
  err.noRetry = noRetry;
  return err;
}

async function chat(messages, { maxTokens = 4000, temperature = 0.4 } = {}) {
  let res;
  try {
    res = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        // Stream mode: chunks flow immediately instead of one big body at the end.
        // Proxies (Cloudflare ~100s) kill long non-streaming responses — streaming
        // keeps the connection alive for the multi-minute deep-analysis calls.
        stream: true,
      }),
    });
  } catch (e) {
    const err = new Error('Không kết nối được AI endpoint — kiểm tra AI_BASE_URL / mạng.');
    err.friendly = err.message; // retryable — mạng có thể tạm thời
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw aiHttpError(res.status, body.slice(0, 300));
  }
  // Read the SSE stream and reassemble the content deltas.
  let raw = '';
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      if (raw.length > 2_000_000) break; // sanity cap
    }
  } else {
    raw = await res.text(); // no stream support — fall back to whole body
  }

  // Two shapes to handle: SSE chunks ("data: {...}") or a plain JSON body
  // (the local endpoint appends an SSE tail "data: [DONE]" after the JSON).
  let content = '';
  if (raw.trimStart().startsWith('data:')) {
    for (const line of raw.split('\n')) {
      const m = line.match(/^data:\s*(\{.*\})\s*$/);
      if (!m) continue;
      try {
        const delta = JSON.parse(m[1])?.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') content += delta.content;
      } catch { /* ignore malformed chunk */ }
    }
  } else {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const end = raw.lastIndexOf('}');
      if (end === -1) throw new Error('AI trả về nội dung không hợp lệ');
      data = JSON.parse(raw.slice(0, end + 1));
    }
    const c = data?.choices?.[0]?.message?.content;
    if (typeof c === 'string') content = c;
  }
  if (!content.trim()) {
    const err = new Error('AI trả về nội dung rỗng');
    err.friendly = 'AI trả lời rỗng — thử lại sau ít phút.';
    throw err;
  }
  return content.trim();
}

// Extract the first balanced JSON object from model output (handles ```json fences, prose).
function extractJson(text) {
  let t = text.replace(/```json\s*/gi, '```').trim();
  const fence = t.indexOf('```');
  if (fence !== -1) {
    const end = t.indexOf('```', fence + 3);
    if (end !== -1) t = t.slice(fence + 3, end);
  }
  const start = t.indexOf('{');
  if (start === -1) throw new Error('Không tìm thấy JSON trong phản hồi AI');
  // balanced-brace scan honoring strings
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error('JSON từ AI không hợp lệ (không đóng đầy đủ)');
}

async function chatJson(messages, opts) {
  const raw = await chat(messages, opts);
  try {
    return extractJson(raw);
  } catch (e) {
    // one retry with a stricter instruction
    const retry = await chat(
      [...messages, { role: 'user', content: 'Phản hồi trước của bạn không parse được JSON. Trả lại CHỈ một JSON object hợp lệ, không thêm bất kỳ chữ nào khác.' }],
      opts
    );
    return extractJson(retry);
  }
}

// Vision OCR: extract all text from a CV page image.
async function ocrImage(base64, mime) {
  const out = await chat(
    [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          { type: 'text', text: 'Trích xuất TOÀN BỘ text trong ảnh CV này ra dạng Markdown, giữ nguyên cấu trúc (tiêu đề, mục, bullet). Chỉ xuất nội dung, không bình luận. Nếu ảnh không phải trang CV/tài liệu, trả về đúng chuỗi: [NOT_DOCUMENT]' },
        ],
      },
    ],
    { maxTokens: 3000, temperature: 0.1 }
  );
  return out.includes('[NOT_DOCUMENT]') ? '' : out;
}

module.exports = { chat, chatJson, ocrImage, AI_BASE_URL, AI_MODEL };
