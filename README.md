# Trump BTC Signal Bot

Bot NestJS theo dõi bài viết của Trump trên Truth Social theo thời gian thực, dùng AI (OpenRouter free models) phân tích xác suất ảnh hưởng đến giá Bitcoin, và gửi thông báo qua Telegram.

---

## Cách hoạt động

```
Truth Social (mỗi 90-120 giây)
      ↓ fetch-posts.py — browser impersonation (curl_cffi)
PollingService
      ├── AnalysisService   → OpenRouter LLM phân tích nội dung
      ├── MarketSignalService → Binance: bối cảnh thị trường BTC
      ├── BtcPriceService   → Binance / CoinGecko: giá BTC hiện tại
      ├── StorageService    → data/posts.json (không dùng database)
      └── TelegramService   → Gửi alert + nhận lệnh từ users
```

### Luồng xử lý bài viết mới

1. Scraper phát hiện bài mới → lấy giá BTC → lưu vào storage
2. Gọi OpenRouter LLM → nhận `btcInfluenceProbability` (0–100%) + `btcDirection`
3. `< 10%` → gửi Telegram **silent** (không âm thanh)  
   `≥ 10%` → gửi Telegram **alert** (có âm thanh)
4. Mỗi user có thể đặt ngưỡng cá nhân bằng lệnh `/thr`

### Theo dõi độ chính xác (cron mỗi 1 phút)

Sau mỗi bài viết, bot tự động ghi lại giá BTC tại 3 mốc:
- **+1 giờ** sau khi Trump đăng
- **+1 ngày** sau khi Trump đăng
- **+7 ngày** sau khi Trump đăng

Sau 7 ngày, bot log so sánh dự đoán vs thực tế để đánh giá độ chính xác.

---

## Cài đặt

### Yêu cầu

- Node.js 18+
- Python 3.10+ với `curl_cffi`: `pip install curl_cffi`
- PM2 (production): `npm install -g pm2`

### 1. Cài dependencies

```bash
npm install
```

### 2. Cấu hình `.env`

```bash
cp .env.example .env
```

Điền các giá trị:

```env
# OpenRouter — lấy API key tại https://openrouter.ai/keys (miễn phí)
OPENROUTER_API_KEY=sk-or-v1-...

# Telegram bot token — tạo qua @BotFather
TELEGRAM_BOT_TOKEN=123456789:AAF...

# Ngưỡng alert toàn cục (0 = gửi tất cả, 90 = chỉ gửi khi >= 90%)
BTC_INFLUENCE_THRESHOLD=0

# Truth Social — dùng để scrape (không cần token nếu curl_cffi hoạt động)
# TRUTH_SOCIAL_ACCESS_TOKEN=...   (tuỳ chọn)
TRUTHSOCIAL_USERNAME=your_username
TRUTHSOCIAL_PASSWORD=your_password
```

### 3. Đăng ký nhận alert

Sau khi bot chạy, nhắn tin `/start` cho bot trên Telegram — bot sẽ tự động thêm bạn vào danh sách nhận alert. Không cần sửa file `data/users.json` thủ công.

### 4. Chạy

```bash
# Development (có auto-reload)
npm run start:dev

# Production
npm run build
pm2 start ecosystem.config.js
pm2 logs trump-btc
```

---

## AI & Model

Bot dùng **OpenRouter** với các free model, tự động fallback khi gặp lỗi 429/404.

**Model mặc định:** `openai/gpt-oss-120b:free`

**Fallback queue** (18 models, từ mạnh → yếu):

| # | Model | Vision |
|---|-------|--------|
| 1 | `google/gemini-2.5-flash-preview:free` | ✅ |
| 2 | `qwen/qwen2.5-vl-72b-instruct:free` | ✅ |
| 3 | `openai/gpt-oss-120b:free` ← *default* | |
| 4 | `deepseek/deepseek-r1:free` | |
| 5 | `nvidia/nemotron-3-super-120b-a12b:free` | |
| … | *(13 models còn lại)* | |

Khi bài viết có ảnh đính kèm, bot tự động chuyển sang vision model.  
Giới hạn: **500 API calls/ngày**, reset lúc 0:00 (gửi cảnh báo Telegram khi vượt).

---

## Lệnh Telegram Bot

| Lệnh | Chức năng |
|------|-----------|
| `/start` | Đăng ký nhận alert tự động |
| `/btc` | Giá BTC hiện tại |
| `/check` | 7 bài có xác suất ≥30% gần nhất (kèm link + giá BTC +1h/+1d/+7d) |
| `/check-all` | Tất cả bài ≥30% |
| `/check2` | Bảng 10 ngày gần nhất, xác suất ≥30% |
| `/latest` | Phân tích lại + gửi lại alert bài mới nhất |
| `/test <nội dung>` | Phân tích thủ công đoạn văn bất kỳ |
| `/test <postId>` | Phân tích bài Truth Social theo ID hoặc URL |
| `/prompt` | Xem prompt AI hiện tại |
| `/prompt <nội dung>` | Xem prompt AI cho bài viết cụ thể |
| `/model` | Xem model đang dùng |
| `/model <tên>` | Đổi sang model khác |
| `/models` | Danh sách model theo thứ tự fallback |
| `/model-list` | Bảng model đầy đủ (monospace) |
| `/credit` | Kiểm tra trạng thái OpenRouter API key |
| `/thr` | Xem ngưỡng thông báo cá nhân |
| `/thr <số>` | Đặt ngưỡng thông báo (0–100%) |
| `/clear dd-mm-yyyy` | Xóa bài viết cũ khỏi storage |
| `/skipped` | Danh sách bài bị bỏ qua do >1h trong hàng chờ |
| `/menu` | Hiển thị danh sách lệnh này |

---

## Cấu trúc dự án

```
trump-btc/
├── src/
│   ├── polling/          # Orchestrator chính, cron jobs
│   ├── truth-social/     # Scraper (gọi fetch-posts.py)
│   ├── analysis/         # OpenRouter LLM + fallback chain
│   ├── market-signal/    # Bối cảnh thị trường BTC từ Binance
│   ├── btc-price/        # Giá BTC (Binance → CoinGecko fallback)
│   ├── telegram/         # Bot Telegram: alert + commands
│   ├── severity/         # Rule-based keyword scoring (9 nhóm)
│   ├── storage/          # Persistence: data/posts.json
│   └── common/           # TypeScript interfaces dùng chung
├── fetch-posts.py        # Python scraper Truth Social (curl_cffi)
├── ecosystem.config.js   # PM2 config
├── data/
│   ├── posts.json        # Bài viết + phân tích (auto-generated)
│   ├── alerts.log        # Lịch sử alert (JSON per line)
│   ├── users.json        # Danh sách Telegram users (auto-generated)
│   └── skipped-analysis.json
└── .env                  # Credentials (không commit)
```

---

## Troubleshooting

### Truth Social trả về 403

Bot dùng `curl_cffi` để giả lập browser — không cần đăng nhập. Nếu vẫn bị block:

- Server bị Cloudflare block tạm thời → bot tự backoff (5→10→20→60 phút)
- Kiểm tra IP server không bị blacklist
- Thêm `TRUTH_SOCIAL_ACCESS_TOKEN` vào `.env` nếu có token hợp lệ

### OpenRouter 429 (rate limit)

Bot tự động fallback sang model tiếp theo trong queue. Nếu tất cả model đều 429:
- Kiểm tra `/credit` để xem daily call count
- Giới hạn mặc định: 500 calls/ngày
- Free tier OpenRouter có thể bị giới hạn theo giờ — bot sẽ tự retry sau khi restart

### Telegram bot không nhận lệnh

- Kiểm tra `TELEGRAM_BOT_TOKEN` hợp lệ
- Đảm bảo chỉ có 1 instance bot đang chạy (polling conflict)
- Xem log: `pm2 logs trump-btc | grep -i telegram`
