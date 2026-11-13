# Sơ đồ kiến trúc và luồng nghiệp vụ

Bộ sơ đồ này mô tả `omp-cairn-blackboard` v0.9.6 theo mã nguồn ở commit `72a5a5e`. Repo chỉ giữ PNG (nhúng trong README) và JSON nguồn trong [`src/`](src/); mỗi node trong JSON ghi file và dòng nguồn (`sources`) để đối chiếu với code. Bản HTML tương tác (zoom, focus, xuất SVG) sinh lại được từ JSON nhưng không được commit vì nặng ~840 KB mỗi file.

| # | Sơ đồ | Loại | Trả lời câu hỏi |
|---|---|---|---|
| 01 | [Tổng quan hệ thống](01-overview.png) | architecture | Các thành phần nào có mặt, ai ghi vào SQLite, ranh giới tin cậy ở đâu? |
| 02 | [Mô hình dữ liệu](02-data-model.png) | ERD | Một board lưu gì, các cạnh của đồ thị nằm ở bảng nào? |
| 03 | [Vòng lặp cairn-search](03-cairn-search-loop.png) | workflow | Controller và worker phối hợp thế nào từ `board_init` đến `board_complete`? |
| 04 | [Vòng đời intent và lease](04-intent-lease.png) | lifecycle | Intent đi qua trạng thái nào, lease hết hạn thì chuyện gì xảy ra? |
| 05 | [Một vòng Reason + Explore](05-explore-roundtrip.png) | sequence | Thứ tự gọi tool và ghi SQLite trong một vòng làm việc. |
| 06 | [Vòng đời board](06-board-completion.png) | lifecycle | Khi nào board bị từ chối ghi, khi nào mở lại được? |
| 07 | [Pipeline hook `tool_call`](07-hook-pipeline.png) | workflow | Cảnh báo mutating gate, auto-heartbeat, nudge và dispatcher chạy theo thứ tự nào? |
| 08 | [Phục hồi sau compaction](08-compaction-recovery.png) | sequence | Agent lấy lại lease token thế nào sau khi context bị nén? |
| 09 | [Luồng dữ liệu viewer](09-viewer-dataflow.png) | dataflow | `/fact-board` đọc, dựng đồ thị và phục vụ dữ liệu ra sao? |
| 10 | [Vệ sinh dữ liệu](10-redaction-update.png) | dataflow | Redaction chạy ở đâu, bản kiểm tra cập nhật làm gì và không làm gì? |

## Cách đọc nhanh

Bắt đầu từ 01, sau đó theo luồng bạn quan tâm:

- **Dùng board để điều phối subagent**: 03, 05, 04.
- **Hiểu độ an toàn khi nhiều tiến trình ghi**: 05, 04, 02.
- **Hiểu các tin nhắn tự động trong session**: 07, 08.
- **Vận hành viewer và dữ liệu nhạy cảm**: 09, 10.

## Tái tạo

Sinh HTML từ JSON bằng skill `archify`, ví dụ:

```bash
node <archify>/bin/archify.mjs finalize <type> docs/diagrams/src/<file>.json <out>.html --repo-root . --quality showcase
```

`meta.output` trong JSON đang trỏ vào `.archify/docs-diagrams/` (thư mục git bỏ qua); đổi sang nơi bạn muốn trước khi chạy. PNG xuất từ phần tử SVG chính của HTML (2x, theme sáng). Khi code đổi, vẽ lại và cập nhật `meta.repository.revision` trong từng JSON.
