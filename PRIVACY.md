# Quyền riêng tư của bản phát hành

Bộ cài AE_CodexTeam chỉ đóng gói chương trình, extension VSIX, engine AE dùng chung và plugin native. Mỗi tệp payload được liệt kê và kiểm tra SHA-256. VSIX chỉ chứa metadata, tài liệu, tài nguyên UI và bundle ứng dụng.

Không đóng gói cấu hình tài khoản, API key, token, SecretStorage, .env, cấu hình Codex/Claude/VS Code của máy nguồn, skill cá nhân, lịch sử chat, request/job/result/heartbeat/lock, dữ liệu .ae-team, danh mục plugin/SFX, dự án hoặc media người dùng. Thư mục fixture và kho thủ tục riêng sources/ ở máy phát triển được giữ lại tại máy nguồn, không xuất bản.

Người nhận tự dùng tài khoản/key trên máy của mình. Ứng dụng tiếp tục lưu key bằng VS Code SecretStorage; key không nằm trong bộ cài hay repo. Các tên biến môi trường hoặc đoạn mã xử lý API trong source không phải thông tin đăng nhập đã lưu.

Kiểm tra trước phát hành bằng tools/Verify-ReleasePrivacy.ps1 với đường dẫn payload. Kiểm tra chạy riêng trước khi upload; không thêm timer, quét nền hoặc tiêu thụ RAM trong AE. Kiểm tra mẫu nhận diện không thay thế việc rà soát source; báo cáo chỉ ghi tên tệp và loại phát hiện, không ghi giá trị bí mật.

Bộ cài cục bộ chưa ký số. Hash công khai xác nhận tệp tải xuống đúng bản phát hành, không thay thế chứng thư nhà phát hành.
