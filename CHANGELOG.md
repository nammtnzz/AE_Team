## 1.1.2

- Trình quản lý cài đặt đổi tên thành AE_Team.exe và lối tắt Desktop AE_Team.lnk, đặt trong thư mục cài AE_Team.
- Lối tắt AE_CodexTeam.lnk cũ bị xóa khi nó trỏ vào file không còn tồn tại hoặc thư mục cài cũ.
## 1.1.1

- Thư mục cài đổi thành %LOCALAPPDATA%AE_Team. Bản cài AE_CodexTeam cũ được chuyển tự động: gỡ loader/MCP cũ an toàn, chép inventory và kho kiến thức sang chỗ mới; thư mục cũ giữ làm dự phòng.
- Extension tìm engine và kho kiến thức ở AE_Team trước, rồi tới AE_CodexTeam.
- Không đóng gói lối tắt .lnk vào VSIX.
## 1.1.0

- Vị trí thứ 10 **Học tập** (Claude Opus 5): tự học After Effects animation từ web, YouTube và lịch sử làm việc mỗi lần mở VS Code; thanh tiến trình, Dừng học/Tiếp tục trên bảng điều phối.
- Kiến thức học được viết thành cách làm từng bước và giao cho đúng kỹ sư (không cho PO); QA và kỹ sư nhận trong task và khi trò chuyện.
- Kho kiến thức chỉ thêm/sửa, sao lưu hằng ngày (60 bản), không bao giờ bị dọn; đi kèm bộ cài và được gộp vào máy mới.
- Tự kết nối Claude theo cấu hình Claude Code của từng máy (gateway, API key, tài khoản Claude, apiKeyHelper); không hỏi key. Máy chỉ có Claude chạy được cả đội (vai trò GPT tự dùng Claude Sonnet 5.5).
- Bộ cài kèm skill tạo ảnh iw-imagegen và cài vào ~/.claude/skills (không kèm key); vị trí Tạo ảnh ưu tiên skill này.
- Launcher MCP cố định cho Codex, tác vụ dọn ẩn 10 ngày, tự gỡ bản cũ cả khi MCP bị tắt; giữ đường dẫn tiếng Việt khi cài.
- Sửa: mã model claude-haiku-5.5 sai → claude-haiku-5-5; bộ cài từng đóng gói extension cũ; key không còn bị gửi nhầm tới API chính thức; token luôn được che trong lỗi.
## 1.0.1

- Bản phát hành GitHub được đóng trong thư mục tách biệt, loại fixture và dữ liệu máy khỏi VSIX/bộ cài.
- Đồng bộ phiên bản package-lock và metadata repo. Không đổi chức năng AE hoặc model.
- Thêm kiểm tra quyền riêng tư cho payload và archive VSIX trước khi chia sẻ.

# AE_CodexTeam 1.0.0

Đánh số lại từ 1.0.0 (gộp các bản thử nghiệm trước). Nội dung bên dưới là lịch sử phát triển của bản này.

## Lịch sử phát triển

- Định danh riêng, không dùng chung với Codex AE: 44 chức năng đổi thành `team.*` (vd `team.comp.create`), schema `aect-*` (plan `aect-functions/v1`, heartbeat, job, kết quả, cài đặt), MCP tool `aect_*`, công cụ model `aect_find/aect_schema/aect_read/aect_library/aect_propose_plan`, bundle `jsx/AECT Engine.jsx`, biến `__AECT_*`. Bộ cài vẫn đọc được bản cài tên cũ để nâng cấp; plan đã lưu theo định dạng cũ không chạy lại được.

- Chạy song song với Codex AE: panel "AE_CodexTeam Bridge" (giao diện tím), engine ExtendScript riêng `aeCodexTeamBridge`, thư mục `%LOCALAPPDATA%\AE_CodexTeam`, MCP `ae_codexteam`, helper nền `AE_CodexTeam.Background.*`. Engine 1.4.0.
- Nâng cấp từ 1.2.x: chuyển catalog, gỡ bản cũ bằng bộ gỡ của chính nó và xóa loader cũ bị bỏ sót; nếu Codex AE đã chiếm `CodexAE` thì không đụng vào, chỉ lấy catalog và tắt mục tự chạy cũ.
- Sửa bộ gỡ engine không nhận ra loader của chính nó (khác `/` và `\`).
- VSIX không đóng gói thư mục `sources/`.

- PO điều phối: mỗi kỹ sư một việc riêng mỗi task PO; kỹ sư làm ngay, kết quả gửi thẳng về PO không qua bước duyệt task con. Đề xuất file/AE của kỹ sư vẫn chặn duyệt task PO tới khi CEO xử lý.
- Các delegate_task trong cùng lượt PO chạy song song (giới hạn maxParallel). Subagent dùng ngữ cảnh rút gọn, tối đa 8 vòng công cụ; kết quả trả PO tối đa 12.000 ký tự. Lệnh đọc AE song song được xếp hàng.
- Tạo ảnh truyền prompt qua --prompt-file, tránh vượt giới hạn dòng lệnh Windows.
- Dừng QA chỉ áp dụng cho phiên đang chọn.
- Kiểm tra /models cho cả route Codex/OpenAI và Claude/Anthropic (chỉ GET, không gọi model trả phí).
- Báo rõ khi chưa cài engine thay vì trỏ vào thư mục engine không có trong VSIX.
- Build chỉ giữ thư mục stage tạm mới nhất trong work/.
- Từ PO Team Live (ai-studio-team), chuyển sang luật duyệt của AE_CodexTeam:
  - Phạm vi việc (file/thư mục, comp:<tên>), việc trùng phạm vi chạy lần lượt; đề xuất file ngoài phạm vi bị từ chối.
  - Tiêu chí nghiệm thu ae/file/analysis với report_checks; chỉ tính đã xác minh khi bằng chứng khớp nhật ký công cụ hoặc đề xuất.
  - propose_patch (oldText → newText) thay vì gửi lại cả file; PO nhận tóm tắt + SHA-256 và chỉ đọc chi tiết khi cần.
  - Báo cáo bàn giao trong task PO; Dừng riêng một kỹ sư; đổi model một vị trí khi vị trí đó rảnh.
  - Ngân sách lượt gọi/token mỗi phiên (tạm dừng trước request vượt) và bảng giá tùy chọn để ước tính chi phí.
  - Không lấy: tự retry HTTP, tự đổi model khi lỗi, ghi file/tải file trực tiếp, nạp skill/MCP bên ngoài.
- Bỏ định dạng Unity khỏi công cụ đọc file; thêm .csv, .tsv, .srt, .vtt.
- Skill, plugin và MCP từ Codex/Claude: quét thủ công; skill chỉ đọc; server MCP bật từng cái; tool chỉ đọc chạy ngay, tool ghi/sửa vào Hàng chờ MCP để CEO duyệt, không tự chạy lại, lệnh chưa rõ kết quả khóa hàng chờ. Bỏ qua server AE_Codex; không lưu hay gửi token. Thêm phụ thuộc smol-toml (BSD-3).

# AE_CodexTeam 1.2.5

- Thêm thanh trạng thái từng vị trí trong Team và Office: đỏ “Đang xử lý”, xanh “Xong”; giữ riêng trạng thái chờ duyệt.
- Đồng bộ trạng thái task, chat/QA và tạo ảnh theo đúng phiên. Lỗi, dừng hoặc gián đoạn không hiển thị hoàn tất.
- Lưu vòng đời tạo ảnh qua lần mở lại VS Code; Dừng trước khi khởi chạy không gửi yêu cầu tạo ảnh.
- Chuyển động loading chỉ chạy khi cần và tôn trọng giảm chuyển động; không thêm polling.

# AE_CodexTeam 1.2.4

- Tinh gọn Product Manager còn một màn hình trạng thái chính; gom hướng dẫn, thư mục dữ liệu và log vào “Chi tiết & chẩn đoán”.
- Ba nút chính, bố cục co giãn và phần chi tiết cuộn trong cửa sổ. Tự bỏ chọn Team Studio khi thiếu VS Code; làm mới phiên bản sau cài đặt.
- Giữ nguyên cài đặt/sửa chữa, kiểm tra AE, mở AE/Team Studio, cleanup an toàn và bảo toàn dữ liệu.

# AE_CodexTeam 1.2.3

- Bấm PO hoặc từng kỹ sư mở ngay bảng chat cùng danh sách tác vụ; lưu nháp khi trạng thái cập nhật.
- Lịch sử góp ý riêng cho từng người và từng phiên, trả lời bằng model đã chọn. Góp ý được chuyển vào ngữ cảnh tác vụ tiếp theo; PO xem được góp ý cho các kỹ sư trong phiên.
- Có Dừng, ghi rõ yêu cầu lỗi hoặc bị ngắt, không tự gửi lại hay chạy lại tác vụ. Tạo ảnh ghi nhận góp ý và chỉ gọi iw-imagegen khi bấm tạo ảnh.
- Giữ lịch sử QA cũ, dữ liệu và các bước duyệt AE/file; cập nhật tại chỗ.

# AE_CodexTeam 1.2.2

- Bấm thẻ kỹ sư trong Team / model mở tác vụ của người đó trong phiên hiện tại; ưu tiên việc đang chạy, có trạng thái, tiến độ duyệt và chi tiết task con PO giao.
- Cập nhật bảng tác vụ theo state; đóng khi chuyển phiên để tránh hiển thị dữ liệu phiên cũ. Model giữ tại Proxy & model, tạo ảnh và QA vẫn có lối vào riêng.
- Số vị trí trong Team và Office lấy theo cấu hình thực tế.

# AE_CodexTeam 1.2.1

- Luồng CEO → PO → kỹ sư: phiên mới chỉ giao PO, PO gọi và tổng hợp kết quả subagent; phiên cũ giữ nguyên.
- Sửa thiếu cơ chế subagent: model có thể dùng delegate_task gọi vai trò khác qua model/giao thức đã cấu hình, nhận kết quả thật và theo dõi task cha/con.
- Giữ giới hạn số lượt chạy, Stop, duyệt task con trước cha, không tự retry lỗi hoặc replay AE.
- Kiểm thử gọi chéo Claude/Codex, maxParallel=1, giới hạn một cấp và dừng cha/con.

# AE_CodexTeam 1.2.0

- Chọn model theo Claude/Codex; bổ sung ID từ /models và nhập model tùy chỉnh.
- Thêm vai trò Tạo ảnh dùng Codex skill iw-imagegen, model gpt-image-2.5-sunburst riêng.
- Thêm QA tiếp nhận câu hỏi và góp ý bằng claude-haiku-5.5, lưu hội thoại và hỗ trợ Dừng.
- Tự nâng cấu hình 7 vai trò thành 9, giữ lịch sử, model và prompt cũ; Office và thống kê hiển thị đủ 9 vai trò.
- Không thêm idle polling; kiểm thử mô phỏng, không gọi API trả phí.

# AE_CodexTeam 1.1.0

- Product Manager C# riêng: danh sách thành phần, chẩn đoán, mở AE/VS Code, sửa bản cài thủ công.
- Tùy chọn engine/panel không cần VS Code; giữ phiên bản extension khi bỏ qua cài Team.
- Kết nối kiểm tra loader, certificate và heartbeat; nhãn hết hạn sau 15 giây.
- project.open mở trực tiếp, từ chối project chưa lưu; nút mở/lưu tạo plan chờ duyệt.
- Snapshot project có timestamp xem được khi AE tắt, không giả là đọc .aep offline.
- Panel AE đổi tên/màu, giữ Stop và thủ công quét SFX. Native .aex chờ SDK.

# AE_CodexTeam 1.0.0

- Hợp nhất engine và extension trong EXE, Việt hóa 7 vai trò và thêm tìm FX/SFX.
- Dọn code cũ sau xác minh; giữ dữ liệu, duyệt plan và chống replay.
