# HireMind — Quyết định kiến trúc & thiết kế

> File này ghi lại các quyết định quan trọng và lý do, giúp người đọc tài liệu hiểu "tại sao làm vậy".

## 1. Stack công nghệ

| Lựa chọn | Vì sao |
|---|---|
| **Node.js + Express** | Server nhẹ, 1 lệnh `npm start`, đúng track "không cần backend riêng" (chỉ 1 process nhỏ làm proxy + lưu file) |
| **File-based storage** (`data/<id>/session.json`) | Track cấm database. JSON file đủ dùng, dễ debug, mỗi phiên 1 thư mục rõ ràng |
| **Vanilla JS SPA, không build step** | Hackathon = dễ chạy. Không webpack/vite, không node_modules phía client |
| **pdf.js client-side** | Parse PDF ngay trong browser: lấy text + render trang scan thành ảnh gửi AI vision. Giảm tải server, tránh dependency nặng phía server |
| **mammoth** (DOCX), **pdf-parse** (fallback) | Trích text server-side cho DOCX và PDF không scan |
| **Playwright headless Chromium** | TopCV/ITviec chặn Cloudflare — curl/jina.ai đều 403. Chromium thật qua được (đã kiểm chứng: `jdSource: "browser"`) |
| **OpenAI-compatible API** (`/v1/chat/completions`) | User yêu cầu dùng OpenAI base URL để dễ setup. Đổi provider = đổi 3 env vars |

## 2. Một session = một CV (khi user upload nhiều file)

**Vấn đề:** User gửi nhiều ảnh — có thể là (a) 1 CV nhiều trang, hoặc (b) nhầm lẫn gửi 2 CV khác nhau.

**Quyết định:** Gộp tất cả thành **một CV** theo flow: AI OCR từng file → AI hợp nhất + tự đánh giá:
- Nếu là 1 CV nhiều phần → ghép thành 1 CV hoàn chỉnh (use case chính)
- Nếu phát hiện nhiều người khác nhau → flag `multiplePeople: true` + phân tích theo CV "chủ đạo", summary ghi rõ. **Không crash, không từ chối** — user vẫn nhận được phân tích và có thể tự tạo 2 phiên nếu muốn so sánh 2 CV

Lý do không tách thành 2 session tự động: mơ hồ (CV 2 trang nhưng font khác nhau vẫn là 1 người), và tạo phiên hộ user gây khó hiểu về link.

## 3. Xử lý "user thoát trang sau khi upload"

`POST /api/upload` trả về link ngay lập tức, pipeline chạy `setImmediate()` nền. Frontend chỉ poll `GET /api/session/:id`. User tắt tab → server vẫn chạy tiếp hết pipeline. Mở lại link → thấy kết quả hoặc tiến độ.

## 4. Lấy nội dung JD — 3 tầng fallback

1. **Direct fetch** — nhanh, đủ cho site đơn giản
2. **r.jina.ai** (free proxy) — site vừa phải
3. **Playwright Chromium** — site chặn bot (TopCV...). Đặt UA thật, `webdriver: undefined`, đợi 4s cho JS/anti-bot chạy xong

Thứ tự đảo ngược nếu URL thuộc danh sách job boards phổ biến VN ( NEEDS_BROWSER regex). Nếu cả 3 tầng fail + user có dán text JD thủ công → dùng text đó. Nếu không có gì → báo rõ trong `jdNotice`, phân tích tiếp phần CV (không chết).

## 5. Cảnh báo "không phải CV"

AI validate ở bước 2 trả `isCv: false` + `reason` → session vào trạng thái `error` với `notCv: true`, UI hiển thị thông báo thân thiện (không crash). Ví dụ: user upload hóa đơn/ảnh meme.

## 6. Design system (theo yêu cầu user: nền sáng dịu, thân thiện, light/dark mode, động, ấn tượng)

- **Light mode mặc định**: nền `#f6f7fb` + card trắng, indigo `#6366F1` → violet `#A855F7` gradient làm accent
- **Dark mode**: `#0F172A` nền, card `#192134` — toggle ở header, nhớ qua localStorage, lần đầu tôn trọng OS preference
- **Font**: Space Grotesk (heading) + DM Sans (body) — mood "tech startup, thân thiện"
- **Động**: aurora blobs trôi nền, score ring count-up, reveal-on-scroll, typing dots khi chờ AI, wizard step transition. Tất cả tôn trọng `prefers-reduced-motion`
- **Anti-slop**: SVG icons (Lucide inline), không emoji làm icon, contrast 4.5:1, focus states, cursor-pointer, hover 150-300ms

## 7. Tính năng "đánh vào nỗi đau" (phần mở rộng so với IDEA.md)

| Nỗi đau | Tính năng giải quyết |
|---|---|
| Nộp CV không hồi âm, không biết rớt ở đâu | ATS Red Flags — chỉ rõ cái gì khiến CV bị lọc |
| Đọc JD không biết mình thiếu gì | Đối chiếu JD từng yêu cầu có bằng chứng + severity |
| Sinh viên mới ra trường không biết học gì | **Skill Roadmap** — lộ trình từng bước có thời gian + nguồn học |
| Không có người sửa CV | **Chat Coach** — hỏi theo đúng CV của mình |
| Sợ phỏng vấn | **Mock Interview** — AI hỏi theo CV, chấm từng câu, báo cáo tổng |
| Viết thư ứng tuyển khó | **Cover Letter** — từ CV thật + JD, chọn giọng văn, xuất PDF |

## 8. Model & provider

Mọi rule đều dùng 1 provider/model như user chỉ định: `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` (env vars hoặc default trong `lib/ai.js`). Endpoint tự route model phù hợp phía sau (glm-5.3 cho text, deepseek-v4.1-flash cho vision) — client không cần biết.

## 9. Giới hạn đã chấp nhận (prototype)

- Session data lưu vĩnh viễn trong `data/` (chưa có TTL/cleanup) — thêm khi có DB
- Interview state in-memory — reload trang giữa buổi phỏng vấn phải bắt đầu lại (chấp nhận được vì buổi phỏng vấn ngắn)
- 1 model duy nhất cho mọi tác vụ — có thể tách model rẻ/mạnh cho từng bước sau này
