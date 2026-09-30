# HireMind — Kiến trúc dự án

## Tổng quan

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER (SPA)                             │
│  index.html (landing + wizard)     session.html (dashboard)      │
│  • pdf.js: parse PDF → text +      • poll /api/session/:id       │
│    render trang scan → ảnh         • tabs: Overview / JD Match / │
│  • wizard 3 bước                    Roadmap / Chat / Interview / │
│  • light/dark mode                  Cover Letter / CV gốc        │
└──────────────┬──────────────────────────────┬────────────────────┘
               │ FormData (files + meta +     │ JSON REST + poll
               │ clientPdfText + ảnh base64)  │
┌──────────────▼──────────────────────────────▼────────────────────┐
│                     EXPRESS SERVER (Node.js)                     │
│  server.js — routes                                              │
│  ├─ POST /api/session/new      tạo phiên, trả link /s/:id        │
│  ├─ POST /api/upload           lưu file, kick off pipeline nền   │
│  ├─ GET  /api/session/:id      poll status/kết quả               │
│  ├─ POST /api/session/:id/chat         chat Coach                │
│  ├─ POST /api/session/:id/interview/*  mock interview            │
│  ├─ POST /api/session/:id/cover-letter cover letter              │
│  └─ GET  /s/:id                SPA session page                  │
│                                                                  │
│  lib/pipeline.js — XỬ LÝ NỀN (user có thể thoát trang)           │
│  1. extracting  : OCR ảnh (AI vision) / DOCX / TXT / PDF text    │
│  2. validating  : AI xác thực là CV? hợp nhất nhiều file → 1 CV  │
│  3. jd          : fetch JD (3 tầng) → AI trích cấu trúc JD       │
│  4. analyzing   : AI chấm điểm + đối chiếu + roadmap + red flags │
│                                                                  │
│  lib/services.js — chatTurn / interviewSystem / coverLetter      │
│  lib/jd.js       — fetchDirect → fetchJina → fetchBrowser        │
│  lib/ai.js       — OpenAI-compatible client + JSON extraction    │
└───────┬──────────────────────────────┬───────────────────────────┘
        │                              │
┌───────▼────────┐            ┌────────▼─────────────────────────┐
│  data/<id>/    │            │  AI API (OpenAI-compatible)      │
│  session.json  │            │  POST /v1/chat/completions       │
│  uploads/*     │            │  text → glm-5.3, vision →        │
└────────────────┘            │  deepseek-v4.1-flash (auto)      │
                              └──────────────────────────────────┘
        │
        └── Playwright Chromium (chỉ khi fetch JD từ site chặn bot)
```

## Luồng dữ liệu chính (Upload → Kết quả)

1. **User tạo phiên** — `POST /api/session/new` → `{ id, url }`. Không login; id là "chìa khóa" duy nhất.
2. **Wizard client-side**: với PDF, pdf.js lấy text trước. Trang nào text < 80 ký tự (PDF scan) → render canvas scale 2x → JPEG base64. Ảnh CV (JPG/PNG/WEBP) gửi nguyên file.
3. **`POST /api/upload`** — multer lưu file vào `data/<id>/uploads/`, client gửi kèm `clientPdfText` + `clientPdfImages` (base64). Server trả link **ngay**, rồi `setImmediate(processSession)`.
4. **Pipeline nền** (xem sơ đồ trên) — mỗi bước ghi `stage` + `stageLabel` vào `session.json` để UI poll hiển thị tiến độ thật.
5. **Session page** poll `/api/session/:id` mỗi 2.5s → khi `status === 'ready'` render dashboard.

## Tại sao pipeline chạy nền mà không cần job queue?

Quy mô hackathon: 1 process, pipeline 100% async I/O (fetch AI), không block event loop. `setImmediate` + file JSON là đủ. Upgrade path: đổi thành BullMQ + Redis mà không đổi contract API.

## Trích xuất đa định dạng

| Định dạng | Chiến lược | Nơi xử lý |
|---|---|---|
| PDF (text) | pdf.js client-side → text; fallback pdf-parse server | wizard.js + pipeline.js |
| PDF (scan) | pdf.js render trang → ảnh → AI vision OCR | wizard.js + pipeline.js |
| DOCX | mammoth extractRawText | pipeline.js |
| TXT/MD | fs.readFileSync | pipeline.js |
| JPG/PNG/WEBP/GIF/BMP | AI vision OCR (base64) | pipeline.js |

Mỗi file có warning riêng nếu lỗi — không để 1 file hỏng làm chết cả phiên.

## AI prompts & JSON extraction

- Mọi bước AI trả **JSON có schema rõ** (validate + retry 1 lần nếu sai)
- `extractJson`: balanced-brace scan tôn trọng string/escape — chịu được markdown fence, prose thừa
- Endpoint hay trả kèm `data: [DONE]` (SSE tail) → parse `JSON.parse(raw)` fallback `lastIndexOf('}')`
- Retry with backoff (1.5s, 3s) cho lỗi tạm thời

## Bảo mật & giới hạn

- File 15MB/file, tối đa 12 files; sanitize tên file
- JSON body 60MB (chứa ảnh base64 của PDF scan)
- Session id 12 ký tự random — khó đoán, đóng vai trò auth đơn giản (kiến thức link = quyền xem)
- AI input bị cắt (CV 14k ký tự, JD 9k) — chống token blowout
- `.slice(0, 4000)` mọi tin nhắn chat/interview từ user
