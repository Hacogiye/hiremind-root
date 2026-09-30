# HireMind — Ý tưởng & Yêu cầu dự án

## Ý tưởng

Ứng viên đi xin việc thường không biết CV của mình có thật sự phù hợp với vị trí đang ứng tuyển hay không. Các công cụ hiện có chỉ chấm CV chung chung, không đối chiếu với tin tuyển dụng thật, nên ứng viên vẫn không biết mình còn thiếu gì.

**HireMind** giải quyết việc đó: người dùng tải CV lên và dán **link tin tuyển dụng** mong muốn. AI sẽ đọc cả hai, chỉ ra CV đã đáp ứng gì, còn thiếu gì, và cần cải thiện ra sao. Sau đó người dùng có thể chat trực tiếp với AI để hỏi "tôi cần học thêm gì", "nên bỏ gì", "trình bày lại thế nào", hoặc luyện phỏng vấn giả lập trước khi gặp nhà tuyển dụng thật.

Điểm khác biệt: **đối chiếu CV với đúng tin tuyển dụng** mà người dùng nhắm tới — không chấm chung chung.

## Yêu cầu dự án

### Người dùng tải lên
- CV dạng PDF, DOCX, TXT/MD hoặc ảnh (JPG/PNG/WEBP); chọn được nhiều ảnh cho CV nhiều trang
- Vị trí ứng tuyển + mức kinh nghiệm
- Link tin tuyển dụng (không bắt buộc)

### Hệ thống phải làm được
- Đọc được nội dung CV ở mọi định dạng trên, kể cả ảnh chụp / PDF scan
- Chấm điểm CV và nhận xét cụ thể: điểm mạnh, điểm yếu, gợi ý cải thiện
- Đối chiếu CV với tin tuyển dụng: đã đáp ứng gì, còn thiếu gì
- Chấm điểm mức độ khớp với JD (ATS) và chỉ ra kỹ năng còn thiếu
- Cho người dùng chat với AI về CV và JD: cần học gì, sửa gì, bỏ gì, trình bày lại thế nào
- Phỏng vấn giả lập: AI đóng vai interviewer, hỏi từng câu dựa trên chính CV đó, cuối buổi tổng kết
- Nếu tài liệu tải lên không phải CV thì phải cảnh báo rõ, không được crash
- Mỗi lần tải CV lên tạo một phiên riêng, trả link để người dùng mở lại xem bất cứ lúc nào

### Yêu cầu bắt buộc của track
- Có gọi API AI bên thứ ba (miễn phí), không cần backend riêng
- Luồng rõ ràng: người dùng gửi dữ liệu → gọi API thành công → kết quả AI hiển thị trên giao diện
- Có hiệu ứng loading trong lúc chờ AI trả lời
- Chạy được end-to-end trong thời gian hackathon

### Không làm
- Không cần đăng nhập, không cần database
- Không fine-tune model
