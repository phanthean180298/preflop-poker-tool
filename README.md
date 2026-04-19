# GTO Preflop Wizard

Ứng dụng hỗ trợ GTO preflop cho poker tournament. Chạy local, truy cập được từ thiết bị ngoài qua LAN.

## Cấu trúc

```
gto-demo/
├── server/          # Express API server (Node.js)
│   └── src/
│       ├── engine/preflop.js   # GTO logic
│       ├── routes/             # API endpoints
│       ├── middleware/cache.js # SQLite cache
│       └── utils/db.js         # SQLite setup
└── desktop/         # Electron desktop app (Vite + Vanilla JS)
```

## Cài đặt & Chạy

```bash
# Cài dependency
npm run install:all

# Chạy server + desktop cùng lúc (development)
npm run dev

# Hoặc chạy riêng
npm run server     # chỉ server API
npm run desktop    # chỉ desktop app
```

## API Server

Server chạy tại `http://0.0.0.0:3001` — thiết bị trong cùng mạng LAN có thể gọi.

### Endpoints

#### `POST /api/preflop/query`

Lấy GTO action cho 1 hand cụ thể.

```json
{
  "action": "rfi", // "rfi" | "vs_rfi" | "vs_3bet"
  "hand": "AKs", // suit-collapsed: AKs, AKo, QQ, 72o, ...
  "position": "BTN", // EP | MP | CO | BTN | SB | BB
  "vs_position": "EP", // raiser's position (cho vs_rfi / vs_3bet)
  "stack_bb": 40, // effective stack in BB
  "ante_bb": 0.1, // ante in BB (0 nếu không có ante)
  "rfi_size_bb": 2.5, // kích thước open raise (cho vs_rfi)
  "three_bet_size_bb": 7.5 // kích thước 3bet (cho vs_3bet)
}
```

Response:

```json
{
  "action": "raise", // raise | call | fold
  "freq": 1.0, // tần suất thực hiện (1.0 = 100%)
  "sizeBB": 2.2, // kích thước bet/raise gợi ý
  "pushFoldMode": false, // true nếu stack <= 15bb
  "cached": false
}
```

#### `GET /api/preflop/range`

Lấy toàn bộ range chart.

```
GET /api/preflop/range?position=BTN&action=rfi&stack_bb=40&ante_bb=0.1
```

#### `POST /api/session/start` — Bắt đầu session

#### `POST /api/session/:id/log` — Log 1 hand

#### `GET /api/session/list` — Danh sách sessions

#### `GET /api/session/stats` — Thống kê cache & sessions

---

## Dữ liệu đầu vào cần thiết để ứng dụng chạy chính xác

| Input         | Mô tả                                         | Quan trọng      |
| ------------- | --------------------------------------------- | --------------- |
| `stack_bb`    | Effective stack tính bằng BB                  | ⭐⭐⭐ Bắt buộc |
| `position`    | Vị trí của bạn (EP/MP/CO/BTN/SB/BB)           | ⭐⭐⭐ Bắt buộc |
| `hand`        | Bài (dạng suit-collapsed: AKs, AKo, QQ)       | ⭐⭐⭐ Bắt buộc |
| `ante_bb`     | Ante tính bằng BB — ảnh hưởng lớn tới MTT     | ⭐⭐ Quan trọng |
| `vs_position` | Vị trí người raise trước (cho vs_rfi/vs_3bet) | ⭐⭐ Quan trọng |
| `action`      | Scenario (rfi / vs_rfi / vs_3bet)             | ⭐⭐⭐ Bắt buộc |

---

## Combo bài

Ứng dụng bỏ qua chất bài, dùng định dạng:

- `AKs` = AK suited (4 combos trong thực tế)
- `AKo` = AK offsuit (12 combos trong thực tế)
- `AA` = Pair (6 combos trong thực tế)

Tổng: **169 combo** thay vì 1326.

---

## Cache & Session

- Mỗi query được cache vào SQLite — query lại không tốn thời gian tính toán
- Mỗi lần chạy app được tính là 1 session, log lại các tình huống đã tra
- Xem stats tại `GET /api/session/stats`
