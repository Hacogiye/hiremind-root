# 🚀 Deploy HireMind lên cPanel (Setup Node.js App)

> Làm hết ~10 phút, toàn bộ trên giao diện web cPanel — không cần gõ lệnh SSH nào ngoài 1 lần nhỏ (có nút bấm thay thế).

## Chuẩn bị trước

1. **File zip**: `hiremind-cpanel.zip` (đã có)
2. **AI provider công khai**: app cần gọi AI API. `AI_BASE_URL` phải là URL host cPanel truy cập được (KHÔNG dùng `localhost` — đó là máy bạn). Nếu bạn dùng provider có sẵn (OpenRouter, Together, GLM...) thì lấy URL + key của họ.

---

## Bước 1 — Upload & giải nén

1. cPanel → **Domains** → nhìn cột **Document Root** của `hackathon.uggiare.vn` (thường là `public_html/hackathon.uggiare.vn` hoặc `hackathon.uggiare.vn`)
2. cPanel → **File Manager** → điều hướng vào đúng thư mục Document Root đó
3. **Upload** `hiremind-cpanel.zip` vào thư mục đó
4. Click phải file zip → **Extract** → giải nén tại chỗ
5. Xóa file zip sau khi giải nén xong

Kết quả ĐÚNG: trong thư mục docroot **hiện ngay** `server.js`, `package.json`, `lib/`, `public/`... (zip này giải nén ra file nằm ngay tại chỗ — không có thư mục con bọc ngoài).

> ⚠️ Nếu sau khi extract bạn thấy `server.js` nằm trong 1 thư mục con nào đó, hãy kéo toàn bộ nội dung thư mục con đó ra docroot trước khi sang Bước 2.

---

## Bước 2 — Tạo Node.js App

1. cPanel → mục **Software** → **Setup Node.js App**
2. Bấm **Create Application**
3. Điền:
   - **Node.js version**: chọn **18.x hoặc cao hơn** (khuyến nghị 20+)
   - **Application mode**: `Production`
   - **Application root**: đường dẫn từ thư mục home đến thư mục CHỨA `server.js` — bỏ phần `/home/tên-đăng-nhập` ở đầu.
     * Cách chắc chắn 100%: trong File Manager, đứng trong thư mục chứa `server.js`, nhìn thanh đường dẫn phía trên (vd: `/home/abc123/public_html/hackathon.uggiare.vn`) → xóa phần `/home/abc123` → điền phần còn lại (`public_html/hackathon.uggiare.vn`).
     * Không có `/` ở đầu, không có `/` ở cuối.
   - **Application URL**: chọn subdomain `hackathon.uggiare.vn` từ dropdown
   - **Application startup file**: `server.js`
4. Bấm **Create**

> ✅ Tự kiểm tra: Application root trỏ tới thư mục trong đó có `server.js` + `package.json`. Nếu bấm Create mà cPanel báo không tìm thấy startup file → Application root sai đường dẫn, xem lại Bước 1.

## Bước 3 — Cấu hình biến môi trường (thay .env)

1. Trong trang app vừa tạo, tìm mục **Environment variables**
2. Thêm lần lượt 3 biến:

| Name | Value |
|---|---|
| `AI_BASE_URL` | URL AI provider công khai của bạn (vd: `https://api.xxx.com/v1`) |
| `AI_API_KEY` | key AI của bạn |
| `AI_MODEL` | tên model (vd: `main_model` hoặc model của provider) |

> Không cần tạo file `.env` — cPanel inject các biến này thẳng vào process, an toàn hơn cả `.env`.

## Bước 4 — Cài dependencies

1. Trong trang app, tìm nút **Run NPM Install** → bấm
2. Chờ 1–2 phút cho `express`, `multer`, `mammoth`, `pdf-parse` cài xong

> ⚠️ **KHÔNG cài `playwright`** — cPanel shared host không chạy được Chromium. Source đã được sửa để thiếu playwright vẫn chạy: tầng fetch JD qua browser tự tắt, còn 2 tầng direct + jina.ai hoạt động. Với TopCV (Cloudflare chặn 2 tầng đầu) thì JD fetch sẽ thất bại — **giải pháp: dán nội dung JD thủ công** vào ô "Hoặc dán nội dung JD" khi dùng. (Hoặc nếu host cho phép, bạn có thể thử `npm install playwright-core` + chỉ định Chromium có sẵn — nhưng đa số shared host chặn, không bắt buộc.)

## Bước 5 — Khởi động & kiểm tra

1. Bấm **Start App** (hoặc **Restart** nếu đã chạy)
2. Mở `https://hackathon.uggiare.vn` → thấy trang landing HireMind = OK ✅
3. Test nhanh: điền vị trí + tải CV → xem phân tích chạy

---

## Nếu có lỗi

| Triệu chứng | Nguyên nhân & cách xử lý |
|---|---|
| Trang trắng / 503 | App chưa start hoặc crash. Xem **Log** trong trang Setup Node.js App (hoặc `stderr.log` trong thư mục app). Nguyên nhân phổ biến: thiếu biến môi trường → bổ sung Bước 3 rồi Restart |
| "Cannot find module" | Chưa Run NPM Install, hoặc Application root sai đường dẫn |
| 502/Passenger error | Node version quá cũ — chọn ≥18 |
| Upload CV lớn báo lỗi | cPanel giới hạn POST size; nâng `upload_max_filesize` nếu gói cho phép, hoặc nén ảnh trước khi tải |
| Phân tích treo mãi | AI endpoint không truy cập được từ host — kiểm tra `AI_BASE_URL` có public không, thử lại |
| JD từ TopCV fail | Dự kiến với shared host (không có Chromium) — dán nội dung JD thủ công |

## Sau khi hoạt động

- **HTTPS**: cPanel → **SSL/TLS Status** → chọn subdomain → **Run AutoSSL** (miễn phí Let's Encrypt)
- **Restart khi đổi code**: File Manager sửa file → về trang Node.js App bấm **Restart**
- **Reset session data**: thư mục `data/` trong app — xóa session cũ nếu muốn
