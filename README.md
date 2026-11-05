# AE_Team 1.1.0

Ứng dụng quản lý Windows riêng và Team Studio trong VS Code. Gồm Office 3D, Bảng việc, Kết quả, Timeline, Luồng việc, Thống kê và tab After Effects. Không dùng mã hoặc thành phần của Mister Horse.

## Cài đặt và cập nhật thủ công

Mở AE_CodexTeam-Setup-1.1.0.exe → Cài đặt / Sửa chữa. EXE chứa engine, panel AE, plugin native và extension 1.1.0; không cần giải nén ZIP. Trình quản lý một màn hình, phần hướng dẫn và log nằm trong “Chi tiết & chẩn đoán”. Chương trình chạy bằng .NET Framework của Windows, không mở giao diện bằng PowerShell. Có thể mở trình quản lý khi AE tắt.

Engine cần Node.js 20+, PowerShell 7 và AE đã cài/mở ít nhất một lần. VS Code chỉ bắt buộc nếu chọn cài Team Studio. Có thể bỏ chọn extension để cài riêng engine/panel. Bộ cài kiểm tra phụ thuộc, chưa tự tải prerequisite. Không cần quyền admin, không cài vào thư mục Mister Horse.

Sau khi cập nhật: tải lại cửa sổ VS Code/MCP, đóng/mở lại Window → AE_CodexTeam Bridge (panel tím) trong AE. Dùng Kiểm tra AE để xác nhận. Nút Mở After Effects khởi chạy AE; Mở Team Studio mở VS Code. Kết nối hợp lệ phải có heartbeat dưới 15 giây, đúng revision và loader/certificate hợp lệ. Nhãn kết nối tự hết hạn; không kiểm tra mạng nền.

### Chạy song song với Codex AE

AE_CodexTeam không dùng chung tên nào với Codex AE nên hai bản cài và chạy riêng được:

| | AE_CodexTeam | Codex AE |
|---|---|---|
| Panel AE | Window → **AE_CodexTeam Bridge** (nền tím, tiêu đề "◆ AE_CodexTeam Bridge · TEAM") | Window → Codex Bridge |
| Engine ExtendScript | `aeCodexTeamBridge` | `codexAeBridge` |
| Thư mục cài | `%LOCALAPPDATA%\AE_CodexTeam` | `%LOCALAPPDATA%\CodexAE` |
| MCP trong Codex | `ae_codexteam` | `ae_functions` |
| Helper nền tự chạy | `AE_CodexTeam.Background.*` | `CodexAE.Background.*` |

Khi nâng cấp từ 1.2.x (cài trong `CodexAE`): nếu bản cũ còn là của AE_CodexTeam, bộ cài chép catalog sang thư mục mới rồi gỡ bản cũ bằng chính bộ gỡ của nó (giữ dữ liệu, sao lưu file chương trình). Nếu Codex AE đã cài đè vào `CodexAE`, bộ cài không sửa hay xóa gì ở đó; chỉ lấy catalog từ runtime AE_CodexTeam cũ còn sót và tắt mục tự chạy của helper cũ. Extension không bao giờ nhận runtime của Codex AE là của mình.

Cập nhật bằng EXE phiên bản mới do bạn chọn tải. Bộ cài mới được phát hành tại https://github.com/nammtnzz/AE_CodexTeam/releases/latest. Chưa có dịch vụ tự cập nhật.

## Giao việc

VS Code → AE_CodexTeam: Mở bảng điều phối. Nhập Yêu cầu & giao việc → Tạo phiên → Bắt đầu. Cấu hình gateway/API key tại Proxy & model. API key lưu trong SecretStorage, không nằm trong mã nguồn.

| Vị trí | Tên tiếng Việt | Model mặc định |
|---|---|---|
| 1 | Điều phối | claude-opus-5-5 |
| 2 | Kỹ thuật dự án | claude-opus-5-5 |
| 3 | Diễn hoạt | claude-sonnet-5 |
| 4 | Bố cục & máy quay | gpt-6.1-sol |
| 5 | Hình ảnh & âm thanh · Ghép hình / FX / SFX | claude-sonnet-5 |
| 6 | Chỉ đạo mỹ thuật | claude-sonnet-5 |
| 7 | Kiểm định & xuất phim | gpt-6.1-sol |
| 8 | Tạo ảnh · Codex skill iw-imagegen | gpt-image-2.5-sunburst |
| 9 | QA tiếp nhận ý kiến & câu hỏi | claude-haiku-5.5 |

Proxy & model: chọn Claude hoặc Codex ở danh sách giao thức; danh sách model đổi theo nhà cung cấp. Bấm Kiểm tra /models để bổ sung ID thực tế từ gateway đã lưu; có thể chọn Nhập ID model khác. Các ID gợi ý không bảo đảm gateway hỗ trợ.

Bấm vai trò Tạo ảnh để chạy skill iw-imagegen local; cấu hình model ảnh tách riêng, không dùng model hội thoại. Bấm QA · Câu hỏi & góp ý để trò chuyện trực tiếp (không cần tạo phiên), có lịch sử riêng trong workspace và ngữ cảnh phiên đang chọn. QA ghi nhận, giải đáp, không tự chỉnh AE hoặc giao việc; lỗi không tự retry, có nút Dừng. Hai vai trò này chạy khi người dùng gửi yêu cầu. Phiên mới theo luồng CEO → PO → kỹ sư; giữ các bước duyệt. Cấu hình 7 vai trò cũ tự bổ sung 2 vai trò mới, giữ model, prompt và lịch sử.

Model dùng ID từ gateway. Giữ ID extension và vai trò để giữ cấu hình, SecretStorage và lịch sử. Không gọi model trả phí trong kiểm thử bản này.

Mỗi vị trí có thanh trạng thái trong Team và Office: đỏ “Đang xử lý” khi đang chạy tác vụ/chat/tạo ảnh; xanh “Xong” khi có kết quả hoàn tất. Task chờ duyệt vẫn ghi “Chờ duyệt” và cần bạn duyệt như trước. Việc chưa chạy, lỗi hoặc bị dừng có nhãn riêng; không giả lập phần trăm. Trạng thái QA và tạo ảnh chỉ áp dụng cho đúng phiên. Loading dừng chuyển động khi giao diện bị ẩn hoặc bạn bật giảm chuyển động.

Bấm PO hoặc một kỹ sư trong Team / model hay Office để mở ngay bảng chat và tác vụ của người đó. Gửi câu hỏi hoặc góp ý trực tiếp, không cần bấm thêm nút mở chat. Hội thoại riêng theo thành viên và phiên, trả lời bằng model đã cấu hình; QA mặc định claude-haiku-5.5. Giữ nội dung đang nhập khi trạng thái phiên cập nhật. Có nút Dừng; yêu cầu lỗi hoặc bị ngắt không tự gửi lại.

Góp ý được lưu cho lượt chạy tác vụ tiếp theo của đúng kỹ sư; PO nhận ngữ cảnh góp ý của toàn bộ team trong phiên. Chat không tự chạy lại task hoặc thay kết quả đã duyệt. Kỹ sư Tạo ảnh ghi nhận góp ý, bổ sung vào prompt khi bạn chủ động tạo ảnh qua iw-imagegen. Danh sách tác vụ vẫn ưu tiên việc đang thực hiện, có task PO giao, kết quả và tiến độ duyệt. Chọn model qua nút Proxy & model; không thêm polling.

## Giao việc giữa các model

Bạn là CEO. Phiên mới chỉ tạo nhiệm vụ cho PO (roleId lead); PO dùng delegate_task để giao việc cho kỹ sư theo model/giao thức đã cấu hình (Claude và Codex có thể gọi chéo). Các phiên cũ giữ nguyên task và lịch sử. Task con nhận yêu cầu cụ thể, brief và bàn giao; kết quả thật trả về model cha. Bảng việc, Timeline và chi tiết task cho biết quan hệ cha/con.

Mỗi kỹ sư nhận tối đa một việc riêng trong mỗi task PO; giao lại cùng kỹ sư trả về kết quả đã có, không chạy lại. Kỹ sư làm ngay khi được giao, kết quả gửi thẳng về PO, không chờ CEO duyệt từng task con. PO tổng hợp và CEO duyệt task PO. Đề xuất file và plan AE của kỹ sư vẫn phải được CEO duyệt/áp dụng trước khi duyệt task PO. Các việc PO giao trong cùng một lượt chạy song song trong slot của PO, giới hạn bởi maxParallel (maxParallel = 1 thì chạy tuần tự). Tối đa một cấp và 24 task con mỗi phiên. Để tiết kiệm chi phí, kỹ sư chỉ nhận brief rút gọn của PO (không kèm danh sách file workspace, danh sách team hay plan AE của người khác), tối đa 8 vòng công cụ, bàn giao súc tích. Lệnh đọc AE của các kỹ sư song song được xếp hàng, một lệnh tại một thời điểm. Stop dừng cả cha/con; không tự retry subagent lỗi, không thêm vòng polling. Chỉ PO được giao subagent; các kỹ sư không tự điều phối; reviewer chỉ đọc; QA tiếp nhận ý kiến và Tạo ảnh giữ luồng riêng.

### Phạm vi, nghiệm thu và bàn giao gọn

- **Phạm vi (scope):** PO giao kèm danh sách file/thư mục hoặc `comp:<tên comp>`. Kỹ sư chỉ được đề xuất file trong phạm vi; hai việc trùng phạm vi (cùng comp, hoặc thư mục chứa nhau) chạy lần lượt, việc không trùng chạy song song. Phạm vi comp hiện dùng để xếp lịch; plan AE vẫn do CEO duyệt từng plan.
- **Tiêu chí nghiệm thu (acceptance):** tối đa 12 tiêu chí mỗi việc, loại `ae` (cần một `ae_read` thành công, ghi đúng callId), `file` (cần đề xuất file đúng path) hoặc `analysis` (bằng chứng cụ thể). Kỹ sư báo bằng `report_checks`. Tự đánh "pass" mà không có bằng chứng khớp vẫn hiện "thiếu bằng chứng"; có bằng chứng không thay việc CEO đánh giá chất lượng.
- **Bản vá thay vì cả file:** `propose_patch` gửi các đoạn `oldText → newText` (đoạn gốc phải xuất hiện đúng một lần). Diff, kiểm tra file bị sửa ngoài và nút Áp dụng giữ nguyên như `propose_file`.
- **PO nhận bản gọn:** tóm tắt 4.000 ký tự, checklist đã xác minh, danh sách đề xuất kèm kích thước và SHA-256, trạng thái plan AE. PO chỉ đọc thêm khi cần bằng `read_subagent_result` và `inspect_proposal`.
- **Báo cáo bàn giao:** chi tiết task PO hiển thị kỹ sư, file đã áp dụng/đề xuất, plan AE, tiêu chí có bằng chứng và phần chưa hoàn tất. Báo cáo được tính lại theo trạng thái hiện tại.
- **Dừng riêng một kỹ sư:** nút "Dừng riêng việc này" trong chi tiết task đang chạy. Việc đó chuyển sang Cần xử lý, PO nhận lỗi và các kỹ sư khác tiếp tục. Không tự chạy lại; CEO bấm Giao lại nếu cần.
- **Đổi model theo vị trí:** trong bảng hội thoại & tác vụ của một vị trí, chọn model rồi bấm Đổi model. Chỉ đổi khi vị trí đó đang rảnh; áp dụng từ lượt sau, không cắt hoặc gửi lại request đang chạy. Vị trí Tạo ảnh giữ model ảnh riêng.

### Skill, plugin và MCP từ Codex / Claude

Proxy & model → **Skill & MCP từ Codex / Claude** → **Quét**. Chỉ quét khi bấm, không chạy nền. Nguồn: `~/.codex/skills`, `~/.agents/skills`, `~/.claude/skills`, `.claude/skills` của workspace; server trong `~/.codex/config.toml`, `~/.claude.json` (chung và theo project), `.mcp.json` của workspace; plugin Codex đang bật (`[plugins."tên@market"] enabled = true`) và plugin Claude đã cài (`installed_plugins.json`), gồm cả skill và MCP bên trong plugin.

- **Skill** là tài liệu tham khảo chỉ đọc: PO và kỹ sư dùng `list_skills` / `read_skill` để đọc SKILL.md và file văn bản trong thư mục skill. Không chạy script của skill.
- **Server MCP mặc định tắt.** Bật từng server bạn tin dùng. Server chỉ khởi động khi model cần và đóng khi Tạm dừng.
- **Tool chỉ đọc** (server khai báo `readOnlyHint`, không `destructiveHint`) chạy ngay. **Tool khác** chỉ tạo đề xuất trong **Hàng chờ MCP** (tab After Effects): CEO duyệt từng lệnh, chạy một lệnh một lúc. Lỗi/timeout sau khi gửi → "Cần kiểm tra", khóa hàng chờ tới khi bạn xác nhận; mở lại VS Code khi đang chạy cũng vậy. Không tự chạy lại. Lệnh MCP chưa xử lý chặn duyệt task như plan AE.
- Reviewer và phiên demo chỉ được dùng tool chỉ đọc.
- Server AE_Codex (`ae_functions`) trong cấu hình Codex/Claude bị bỏ qua: After Effects chỉ đi qua engine và hàng chờ plan AE.
- Token, env và header nằm nguyên trong file cấu hình gốc, chỉ được truyền cho tiến trình/request MCP; không lưu vào workspace, không gửi cho model hay webview.
- `readOnlyHint` do server tự khai báo; extension không kiểm chứng được server làm đúng như vậy. Chỉ bật server bạn tin.

### Ngân sách và chi phí

Proxy & model có ngân sách lượt gọi và token cho mỗi phiên (0 = không giới hạn). Ngân sách được kiểm tra trước mỗi request; khi chạm giới hạn, task chờ và phiên tạm dừng, không tính là lỗi. Tăng ngân sách rồi bấm Tiếp tục. Lượt gọi và token gồm cả chat với thành viên/QA, theo usage API thực sự trả; thiếu usage thì không ước lượng. Bảng giá (USD / 1M token) là tùy chọn và chỉ để ước tính trong Thống kê; model chưa có giá hoặc chat được ghi là "chưa có giá".

## Mở, lưu và xem project

Trong tab After Effects:

- Mở project…: chọn .aep/.aepx → xem JSON plan → Duyệt & thực thi. Lệnh project.open mở trực tiếp thay project hiện tại, không import thành asset. Từ chối nếu còn thay đổi chưa lưu, không rõ trạng thái lưu, đang render hoặc file không tồn tại. Không tự bỏ thay đổi. Chạy riêng một bước.
- Lưu project…: chọn nơi lưu → xem plan → duyệt. Từ chối ghi đè một file khác nếu chưa cho phép overwrite rõ ràng.
- Đọc project: đọc trạng thái AE và lưu bản đọc gần nhất trong workspaceState.
- Bản đọc đã lưu: xem lại bản đọc có thời gian chụp khi AE tắt. Đây là snapshot có thể đã cũ, không phải đọc nội dung file .aep offline.

Engine có 44 chức năng AE dùng lại và công cụ tìm SFX ae_library_search. Chỉ dùng JSON plan/function đã cài; không sinh JSX theo mỗi yêu cầu. Giữ duyệt plan, Stop, tuần tự một lệnh và không tự replay sau lỗi/timeout.

## SFX và plugin

Vị trí 5 có FX/SFX, lập cue theo giây/frame và tìm metadata âm thanh thật. Trong tab AE có Tìm âm thanh SFX. Nếu chưa có catalog: panel AE → bật SFX → Thư mục… → Cập nhật. Chỉ quét khi người dùng bấm. Tắt hoặc đổi thư mục không dùng cache cũ. Bộ tìm kiếm có giới hạn dữ liệu/thời gian, không tải toàn bộ thư viện.

Không kèm plugin, âm thanh, model hoặc license; các thành phần này cần nguồn hợp lệ của người dùng. Không tự tải/cài plugin bên thứ ba.

## Dữ liệu và bản cũ

Cài mặc định tại %LOCALAPPDATA%/AE_CodexTeam, shortcut là AE_CodexTeam. Sau khi xác minh engine/extension, dọn code cũ có hash khớp manifest; dữ liệu và file đã sửa được giữ tại retired-data. Hoãn bản còn khóa, heartbeat mới, kết quả chưa rõ hoặc MCP đang dùng; thử lại khi mở trình quản lý. Không có vòng dọn liên tục. Giữ nguyên nguồn AE_Codex và AE_Team gốc. Không xóa file project trên ổ đĩa.

## Phần chờ SDK

Panel trong AE hiện vẫn dùng ScriptUI và runtime JSX tương thích, đã đổi tên/màu giao diện. Plugin native .aex thay vận chuyển JSX chưa triển khai vì đang chờ SDK. Việc đọc .aep nhị phân khi AE tắt cũng chưa có; SDK không tự bảo đảm đọc được định dạng này.

EXE chưa ký số. Chưa đo giảm CPU/RAM tổng thể; không tuyên bố hết mọi giới hạn.

## Phát triển

npm.cmd ci; npm.cmd test; npm.cmd run check; npm.cmd run package.

pwsh -NoProfile -File tools/Build-AeCodexTeam.ps1 -OutputDirectory <folder>

pwsh -NoProfile -File tools/Test-AeCodexTeam.ps1 -PayloadRoot <build-payload>

pwsh -NoProfile -File tools/Test-ProductManager.ps1

EXE hỗ trợ --check (xác minh payload) và --smoke-test (mở/đóng form, không cài).

## Nguồn tích hợp

Mã nguồn cũ của AE_Team nằm trong thư mục sources/AE_Team. AE_Codex là project riêng, có repo riêng (nammtnzz/AE_Codex), không còn bản sao trong AE_Team. Runtime sử dụng engine nội bộ tại thư mục engine (server MCP `ae_codexteam`, tool `aect_*`) và không phụ thuộc AE_Codex; hộp công cụ tự loại server `ae_functions` của AE_Codex để hai bên không dùng lẫn.



## Bản chia sẻ sạch

Bộ cài được dựng từ source đã lọc. Không kèm tài khoản, API key, cấu hình Codex/Claude/VS Code cá nhân, lịch sử hội thoại, job, heartbeat, thư viện effect/SFX hay media của máy nguồn. Xem PRIVACY.md. Người nhận dùng thông tin đăng nhập và thư viện trên máy của mình.

Source lưu trữ của project cũ trong sources/ không nằm trong repo chia sẻ; engine dùng chung và đầy đủ source của ứng dụng nằm trong engine/, src/, native/.
