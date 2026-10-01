# HireMind — MEMORY (file ghi nhớ dự án)

> **File này là nguồn sự thật khi làm việc với AI/trợ lý trên dự án.**
> Quy tắc bảo trì: sau MỖI phiên có thay đổi code hoặc quyết định mới, cập nhật phần
> "Nhật ký thay đổi" + các mục liên quan, và **index lại codebase-memory MCP**
> (tên project `hiremind`, đường dẫn thư mục này). Xem phần "Quy trình cuối phiên".

---

## 1. Thông tin dự án

| Mục | Giá trị |
|---|---|
| Tên | **HireMind** — AI đối chiếu CV với tin tuyển dụng thật (không chấm chung chung) |
| Loại | Hackathon 2026 — Track: AI application |
| Nhóm | Tạ Tuấn Tú (nhóm trưởng), Nguyễn Mạnh Đạt, Đặng Văn Hải, Đinh Hoàng Thiện |
| Stack | Node.js ≥18 + Express 4, Vanilla JS SPA (không build step), storage file JSON (không DB, không login), AI OpenAI-compatible |
| Bản hiện tại | **v15** — v14 + CV Rewrite & Reshape + vòng kiểm chứng (2026-09-30). Git repo local (branch `main`, baseline `a218dee`, v15 = 6 commit granular). **Chưa push lên GitHub** — chủ ý: quy định ngày thi yêu cầu logic nghiệp vụ commit GitHub trong giờ thi, push bản đầy đủ trước đó sẽ vi phạm |
| Host | cPanel LiteSpeed/Passenger, `hackathon.uggiare.vn`, user `uggiare1`, app root `/home/uggiare1/hackathon.uggiare.vn` |
| Deploy | cPanel "Setup Node.js App" — **API key / base URL / model điền ở Environment Variables của app trên host** (user xác nhận 2026-09-30: bản này chạy OK) |
| AI provider | OpenAI-compatible endpoint; model id do env `AI_MODEL` quyết định (thời điểm test: text → glm-5.3, vision → deepseek-v4.1-flash tự route phía endpoint) |

## 2. Bản đồ code (thư mục chính: `Downloads/HireMind/`)

| File | Vai trò |
|---|---|
| `server.js` | Toàn bộ API: session/new, upload (multer), poll, chat, interview (start/reply/stop/state/transcript/archive/history), cover-letter, export DOCX. Rate limit token-bucket tự viết, security headers, chặn path traversal (regex id `^[a-f0-9]{12}$`) |
| `lib/ai.js` | Client OpenAI-compatible (stream SSE, ghép delta), `extractJson` quét ngoặc cân bằng, `ocrImage` vision |
| `lib/jd.js` | Fetch JD 3 tầng: direct → r.jina.ai → Playwright Chromium (đảo thứ tự với TopCV/ITviec); SSRF guard `assertPublicUrl`; Playwright lazy-require |
| `lib/pipeline.js` | Pipeline nền 4 bước (extract → validate → jd → analyze), `setImmediate` sau upload; stage ghi vào session.json; caps số mục; fallback hireAssessment |
| `lib/services.js` | Prompts: Chat Coach, Interviewer (8 mood qua marker `===MOOD:xxx===`; kết thúc `===INTERVIEW_END===` + JSON report có `bluntVerdict`), Cover Letter |
| `lib/docx.js` | Markdown → DOCX tự viết OOXML zip (không dependency); `buildCvDocx()` — **CV thiết kế**: banner màu, header 2 cột với ô dán ảnh 3×4 (user tự Insert→Pictures), heading màu + kẻ line, ngày tab căn phải, skill 2 cột; parse rỗng → fallback buildDocx |
| `public/` | SPA: `index.html` (landing + wizard 3 bước, pdf.js client-side), `session.html` (dashboard 7 tabs, poll 2.5s), `css/` design tokens light/dark, `js/` wizard/session/processing/theme/effects |
| `data/<id>/` | `session.json` + `uploads/` — mọi trạng thái persist (chat/interview/pending) |
| `docs/` | ARCHITECTURE / DECISIONS / PROGRESS (log v1→v14 rất chi tiết) + screenshots |

## 3. Trạng thái & lưu ý quan trọng (đọc trước khi đụng code)

1. **Bản host đang chạy ổn** — coi source này là baseline, không sửa tùy tiện. Config AI nằm ở cPanel app env, KHÔNG ở file.
2. **`.htaccess` — ĐÃ XỬ LÝ (2026-09-30)**: block `SetEnv` chứa key cũ + tunnel URL đã xóa theo yêu cầu user; giữ lại block Passenger của CloudLinux (host cần để chạy app, không chứa bí mật), kèm chú thích config AI nằm ở cPanel app env. Key cũ từng lộ trong file — **nên rotate nếu còn hiệu lực** (chưa làm).
3. **`session.js` ở thư mục GỐC là bản CŨ của `public/js/session.js`** (1373 vs 1457 dòng, không ai tham chiếu) — rác, xóa được. Chưa xóa.
4. **`.env` local đã có + đã chuẩn (2026-09-30)**: `AI_MODEL=main` (text) + `AI_VISION_MODEL=main_model` (vision). ⚠️ **Phát hiện quan trọng**: alias `main` của provider route text OK nhưng vision LÚC CÓ LÚC KHÔNG (glm-5.3-flash không có vision → OCR báo "[NOT_DOCUMENT]"); alias `main_model` vision chuẩn (deepseek-v4.1-flash) nhưng TEXT bị 404 *"No active credentials for provider: openai"* (lỗi phía provider). Nên code tách 2 biến. ⚠️ **CẦN KIỂM TRA HOST**: nếu cPanel env trên host cũng dùng alias không có vision → upload CV ảnh sẽ hỏng trên host; thêm `AI_VISION_MODEL` vào cPanel env (lib/ai.js mới đọc biến này, fallback về AI_MODEL nếu trống). `.env.example` từng bị xóa khi user tạo `.env` — đã tạo lại có thêm AI_VISION_MODEL.
5. **Thư mục `scripts/` — ĐÃ TÁI TẠO (2026-09-30)**: `shot.js` (Playwright tự chụp light/dark/mobile, chờ selector phù hợp cả 2 trạng thái rewrite) + `e2e-v15.js` (E2E 7 bước). Lưu ý: chạy script cần `npm install` (playwright là devDep; Chromium đã tải ở cache user-level).
6. `stderr.log` là log host cũ (lỗi MODULE_NOT_FOUND, AI 530 tunnel chết, 402 hết tiền) — chỉ mang tính lịch sử, các lỗi đó đã xử lý từ phía host.
7. `data/` chứa 5 session test thật (4 ready, 1 error) — CV test "Nguyễn Mai Loan". Gitignore đã chặn `data/` + `.env`.
8. Thư mục chính **chưa phải git repo** (chưa từng init). Template ngày thi thì đã init.
9. Giới hạn đã chấp nhận (DECISIONS.md §9): session data lưu vĩnh viễn chưa có TTL; interview Map in-memory (có rebuild từ file); 1 model cho mọi tác vụ; **ghi session.json nhiều nơi có thể chồng nhau (race) — chưa fix**.
10. Chi tiết deploy: [DEPLOY-CPANEL.md](DEPLOY-CPANEL.md).

## 4. Quy định ngày thi & khung trắng

Quy định (user cung cấp 2026-09-30):
1. Được chuẩn bị trước **khung code trắng** (Project Template, cài sẵn Database/Thư viện).
2. **Toàn bộ dòng code logic nghiệp vụ** phải thực hiện + commit GitHub trong **thời gian thi**.

Thời lượng thực tế (user cập nhật 2026-09-30): ngày thi **9 tiếng** (có 3 tiếng chấm điểm);
kế hoạch nhóm = **8 tiếng xây dựng + 1 tiếng cuối bàn luận với thành viên**.

Đã chuẩn bị:
- **Khung trắng tại `Downloads/hiremind-template/`** — deps cài sẵn (express, multer, mammoth, pdf-parse + playwright devDep), Chromium Playwright đã tải (cache user-level, dùng chung). **Không chứa logic nghiệp vụ** — `server.js` chỉ bootstrap + health, `lib/*` là stub TODO, `public/*` là shell HTML.
- **GitHub đã nối + push**: `https://github.com/Hacogiye/HireMind.git` (remote `origin`, branch `main`; commit `2f1b38d` khung trắng, `6f1367e` kế hoạch thi).
- `docs/EXAM-PLAN.md` trong template: mốc 8 giờ từng giờ (sau mốc Dashboard ~6:30 phải demo được end-to-end vì có 3 tiếng chấm điểm xen ngày), giờ thứ 9 = bàn luận nhóm, bẫy đã biết, checklist biên, thứ tự cắt giảm nếu thiếu giờ.
- **Yêu cầu thêm từ user (2026-09-30): commit liên tục trong lúc thi** — giám khảo đọc timeline commit trên GitHub để xác minh quá trình làm thật, tránh nghi copy. EXAM-PLAN có mục "Quy tắc commit": commit mỗi 15–30 phút / sau mỗi đơn vị chạy được, 1 commit = 1 việc, fix bug = commit `fix:` riêng, KHÔNG amend/force-push/rebase khi thi, push sau mỗi mốc (giám khảo xem GitHub chứ không xem máy), kèm ví dụ chuỗi commit theo từng mốc.
- Việc còn thiếu trước ngày thi: test AI endpoint bằng `.env` local; chuẩn bị dữ liệu demo (CV PDF + ảnh, link JD TopCV + site thường, file không phải CV); rehearse demo.

**Nguyên tắc tuân thủ:** bản HireMind đầy đủ ở `Downloads/HireMind/` chỉ là **bản tham chiếu thiết kế** — không copy code/prompt vào template. Template giữ trắng.

## 5. Kế hoạch cải tiến

**Feedback giám khảo vòng chung kết (2026-09-30)**: sản phẩm dừng ở chẩn đoán (lỗi + skill gap), thiếu bước "hành động trực tiếp trên CV" — cần tích hợp **CV Rewrite & Reshape** (tự động gợi ý cấu trúc, sửa format, viết lại CV theo từng JD mục tiêu). Pitching phải nhấn: AI là "trợ lý trực tiếp sửa CV", không chỉ "người chấm/phỏng vấn giả lập". *(Đánh giá của AI: feedback hợp lý, khả thi cao vì mọi nguyên liệu đã có trong session — xem nhật ký.)*

Thứ tự đề xuất mới (đề xuất 2026-09-30, chờ user chốt):
1. ~~Hàng đợi ghi session.json~~ — **XONG v15** (`withSession`).
2. ~~Map lỗi AI thân thiện + ngừng retry 402~~ — **XONG v15** (`aiHttpError` + `noRetry`).
3. ~~CV Rewrite & Reshape~~ — **XONG v15**: `rewriteCV()` + `POST /rewrite` + tab "CV viết lại" + hậu xử lý phục hồi liên hệ thật.
4. ~~Nạp CV mới → so sánh trước/sau~~ — **XONG v15**: `POST /reupload` + panel so sánh delta.
5. Xuất báo cáo PDF (print CSS) — rẻ.
6. TTL tự dọn session cũ + nút "Xóa phiên".
7. So sánh 1 CV với nhiều JD — để sau.

Ghi chú v15: chênh lệch điểm giữa 2 lần chấm cùng CV có thể lớn (67 vs 20 trong test) — đã giảm temperature 0.3→0.15 và có disclaimer trong panel so sánh; nếu cần hơn nữa có thể chấm 2 lần lấy trung bình (tốn token).

Hệ quả với EXAM-PLAN (nếu chốt): CV Rewrite thành tính năng ưu tiên cao nhất sau Dashboard — xếp ngay sau mốc Dashboard, TRƯỚC Chat/Interview; thứ tự cắt giảm đổi thành: Cover Letter → Interview → DOCX→ (giữ Rewrite vì là điểm nhấn giám khảo chỉ đạo).

## 6. Nhật ký thay đổi

| Ngày | Thay đổi |
|---|---|
| 2026-09-30 | Lấy lại source từ host sau khi máy cũ hỏng; AI (ZCode) đọc toàn bộ dự án, đối chiếu docs ↔ code, xác nhận baseline v14 khớp tài liệu |
| 2026-09-30 | Xác nhận từ user: host chạy OK, AI config nằm ở cPanel app env |
| 2026-09-30 | Tạo khung trắng ngày thi tại `Downloads/hiremind-template/` (git init, commit `2f1b38d`, npm install xong, health endpoint verify OK); Chromium Playwright cài nền |
| 2026-09-30 | Tạo file MEMORY.md này; index dự án vào codebase-memory MCP (tên `hiremind`) |
| 2026-09-30 | Nối remote GitHub `Hacogiye/HireMind.git` + push khung trắng (`2f1b38d`) và kế hoạch thi 8+1 tiếng (`6f1367e`) |
| 2026-09-30 | Xóa block `SetEnv` chứa key cũ khỏi `.htaccess` (giữ block Passenger); cập nhật EXAM-PLAN theo thời lượng thực tế 9h = 8h xây + 1h bàn luận |
| 2026-09-30 | Thêm "Quy tắc commit liên tục" vào EXAM-PLAN (giám khảo đọc timeline, tránh nghi copy) — push `62e7181` |
| 2026-09-30 | User set `.env` local (đã verify: endpoint AI 200 OK, model `main` → glm-5.3-flash). Nhận feedback giám khảo chung kết → hướng **CV Rewrite & Reshape**; đề xuất lại thứ tự cải tiến (chờ chốt) |
| 2026-10-01 | **v15.4 — Nhãn đánh giá do AI tự viết**: `hireAssessment.verdictLabel` + `match.verdictLabel` do AI đặt trong analyzeCV (prompt + cap 40/30 ký tự); hero chip dùng nhãn AI, session cũ fallback mapping. Test: 45% → "Ranh giới mong manh", ATS 61 → "Khá ổn, còn thiếu chứng minh". Commit `3add023` |
| 2026-10-01 | **v15.3 — Fix hero màn hình lớn + nhãn uncertain**: `.hero-compact` thêm `display: block` ghi đè flex gốc (trước đó hc-extra mở rộng bị đẩy sang cạnh, toggle bóp dọc); toggle chuyển vào `.hc-main`; `PASS_VERDICT.uncertain` "Cân bằng 50/50" → **"Chưa rõ ràng"** (42%/55% không phải 50/50). Commit `4b5eb58`, screenshot `v17-*` |
| 2026-09-30 | **v15.2 — Hero compact**: hero cũ ~700px (trùng lặp nội dung tab) → 1 dải ~90px: 3 stat chip bấm nhảy tab + nút "Tóm tắt & kỹ năng ▾" gói phần dài; mobile grid 3 cột. Playwright test tương tác pass. Commit `004f555`, screenshot `v16-*` |
| 2026-09-30 | **v15.1 — Xuất CV thiết kế (.docx)**: `buildCvDocx()` (banner màu, ô dán ảnh 3×4 để user tự dán, heading màu, ngày căn phải, skill 2 cột) + `POST /api/export/cv-docx` + nút ở tab CV viết lại & CV gốc. Verify bằng LibreOffice convert PDF (2 vòng fix). Commit `58792d1`. **Host không cần LibreOffice** — sinh docx thuần Node zlib, LibreOffice chỉ là tool verify phía dev |
| 2026-09-30 | **v15 hoàn thành + tự test + tự đánh giá UI**: git init baseline `a218dee` → 6 commit granular; F1 hàng đợi ghi (unit test 10 mutation song song OK); F2 lỗi thân thiện + noRetry; F3 rewrite backend+frontend; F4 reupload + panel so sánh; E2E 7 bước pass với AI thật. Bug bắt được khi tự test: (a) alias model không có vision → tách `AI_VISION_MODEL`; (b) OCR trả hội thoại → kiểm tra định dạng + retry; (c) model che email/SĐT thành placeholder → hậu xử lý phục hồi từ cleanedCv; (d) panel so sánh đọc nhầm `meta.parentSessionId` → sửa; (e) server cũ kẹt cổng 3111 → taskkill. 12 screenshot `docs/screenshots/v15-*` (light/dark/mobile, panel so sánh OK). Server test đang chạy local port 3111, 2 session demo: `f603f88665dd` (có JD + rewrite), `7380a1334a51` (phiên kiểm chứng) |

*(Lịch sử v1→v14 xem `docs/PROGRESS.md` — giữ nguyên, không lặp lại ở đây.)*

## 7. Quy trình cuối phiên (bắt buộc khi có thay đổi)

1. Cập nhật mục "Nhật ký thay đổi" + mục liên quan ở file này (ghi ngày, việc đã làm, việc còn treo).
2. **Index lại** codebase-memory MCP: `index_repository(repo_path = thư mục này, mode = moderate, name = hiremind)`.
   - Lưu ý phạm vi: indexer tự loại `public/`, `docs/`, `data/`, `tmp/` — index chỉ phủ backend (`server.js`, `lib/*`). Sửa frontend thì đọc file trực tiếp, đừng tìm trong index.
3. Nếu tạo/xóa file lớn hoặc đổi kiến trúc → cập nhật "Bản đồ code" ở trên.
4. Việc treo (chưa làm xong) → ghi rõ vào §3 hoặc §5 để phiên sau nhặt tiếp.
