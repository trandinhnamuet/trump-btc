# Trump-BTC: Cơ chế đánh giá xác suất ảnh hưởng BTC

## Tổng quan

Hệ thống sử dụng **hybrid ensemble scoring** gồm 3 lớp kết hợp để đánh giá xác suất một bài viết của Trump ảnh hưởng đến giá BTC:

```
Ensemble = 0.50 × Model + 0.35 × Severity + 0.15 × Market
```

Nếu bài viết kích hoạt **hard rule**, xác suất cuối cùng sẽ được override lên tối thiểu **88%**.

---

## Lớp 1: Grok AI Model (trọng số 50%)

Model **grok-3** (xAI) nhận toàn bộ nội dung bài viết và trả về JSON với:

| Trường | Mô tả |
|--------|-------|
| `btcInfluenceProbability` | Xác suất ảnh hưởng BTC (0–100) |
| `btcDirection` | `increase` / `decrease` / `neutral` |
| `summary` | Tóm tắt nội dung bài viết |
| `reasoning` | Giải thích lý do đánh giá |

**Điểm mạnh:** Hiểu ngữ cảnh phức tạp, sắc thái chính trị, kinh tế.  
**Điểm yếu:** Không nhất quán với các sự kiện cực đoan (VD: "bom hạt nhân" chỉ cho 40%).

---

## Lớp 2: Severity Service - Rule-based (trọng số 35%)

Phát hiện từ khóa theo 9 nhóm quy tắc cố định. Mỗi nhóm có `weight` (mức độ ảnh hưởng) và `hard` (có override không).

### Nhóm quy tắc

| Nhóm | Weight | Hard? | Hướng | Từ khóa đại diện |
|------|--------|-------|-------|-----------------|
| `NUCLEAR_WMD` | 0.90 | ✅ | decrease | nuclear, warhead, missile launch, hydrogen bomb |
| `MILITARY_STRIKE` | 0.70 | ✅ | decrease | military strike, bomb, invade, air strike, deploy troops |
| `FINANCIAL_SYSTEM_CRISIS` | 0.75 | ✅ | increase | bank collapse, fed bankrupt, financial collapse, dollar collapse |
| `CRYPTO_REGULATION` | 0.80 | ✅ | increase | bitcoin reserve, crypto ban, bitcoin etf approved, strategic reserve |
| `FED_INTEREST_RATE` | 0.40 | ❌ | neutral | interest rate, rate cut, rate hike, federal reserve, inflation |
| `TARIFF_TRADE_WAR` | 0.35 | ❌ | decrease | tariff, trade war, sanctions, import tax, trade deal |
| `RECESSION_DEPRESSION` | 0.35 | ❌ | decrease | recession, depression, economic collapse, unemployment |
| `GEOPOLITICAL_TENSION` | 0.20 | ❌ | decrease | war, conflict, attack, invasion, crisis |
| `REALTIME_SIGNAL` | 0.25 | ❌ | neutral | breaking, just happened, 5 minutes ago, happening now |

### Cách tính Severity Score

```
severityScore = max(weight của tất cả các nhóm khớp)
```

Nếu nhiều nhóm khớp, lấy nhóm có weight cao nhất làm đại diện.

### Hard Rule Override

Nếu bất kỳ nhóm `hard=true` nào khớp:
- `hardRule = true`
- `ensembleProbability = max(ensembleProbability, 88)`
- `btcDirection` được override theo hướng của nhóm hard đó

**Ví dụ:** "Trump signs executive order launching nuclear strike on Iran"  
→ NUCLEAR_WMD khớp → hardRule=true → ensemble ≥ 88%, direction=decrease

---

## Lớp 3: Market Signal Service (trọng số 15%)

Lấy dữ liệu nến **15m** từ Binance API để đo momentum thị trường hiện tại.

```
GET /api/v3/klines?symbol=BTCUSDT&interval=15m&limit=5
```

| Biến | Mô tả |
|------|-------|
| `btcChange15m` | % thay đổi giá trong 15 phút gần nhất |
| `btcChange1h` | % thay đổi giá trong ~1 giờ gần nhất (4 nến 15m) |
| `marketSignalScore` | `min(1.0, abs(btcChange1h) / 5.0)` |

**Logic:** Khi thị trường đang biến động mạnh (BTC tăng/giảm >5% trong 1h), một bài đăng của Trump có xác suất ảnh hưởng cao hơn bình thường.

Nếu API Binance lỗi → `marketSignalScore = 0` (fallback an toàn).

---

## Công thức tổng hợp

```
rawEnsemble = 0.50 × modelProb + 0.35 × (severityScore × 100) + 0.15 × (marketSignalScore × 100)
ensembleProbability = round(clamp(rawEnsemble, 0, 100))

if (hardRule && ensembleProbability < 88):
    ensembleProbability = 88
```

---

## Quy tắc gửi thông báo Telegram

| Điều kiện | Hành động |
|-----------|-----------|
| `ensembleProbability < 10%` | Gửi **silent** (không tiếng, header: 📋 TRUMP POST) |
| `ensembleProbability >= 10%` | Gửi **bình thường** (có tiếng, header: 🚨 TRUMP POST - BTC ALERT!) |

---

## Ví dụ kịch bản

| Bài viết | Model | Severity | Market | Ensemble | Ghi chú |
|---------|-------|----------|--------|----------|---------|
| "MAGA! Great day for America" | 2% | 0% | 5% | **2%** | Silent |
| "I will impose 25% tariff on China" | 35% | 35% | 10% | **32%** | Alert |
| "We will launch nuclear strike on Iran" | 40% | 90% | 10% | **53%** → **88%** (hard) | Hard rule override |
| "Bitcoin national reserve officially signed" | 70% | 80% | 15% | **65%** → **88%** (hard) | Hard rule override |
| "Fed cutting rates by 50bps today" | 55% | 40% | 20% | **45%** | Alert |

---

## Kiến trúc code

```
src/
├── analysis/
│   └── analysis.service.ts      # Orchestrator: chạy 3 lớp song song, tính ensemble
├── severity/
│   ├── severity.service.ts      # Rule-based keyword detection
│   └── severity.module.ts
├── market-signal/
│   ├── market-signal.service.ts # Binance klines 15m
│   └── market-signal.module.ts
├── btc-price/
│   └── btc-price.service.ts     # Giá BTC hiện tại (Binance ticker)
├── telegram/
│   └── telegram.service.ts      # Gửi alert, /test command
├── polling/
│   └── polling.service.ts       # Polling Truth Social, backfill startup
└── storage/
    └── storage.service.ts       # data/posts.json persistence
```

### Flow xử lý một bài viết

```
PollingService.processPost(post)
    ↓
AnalysisService.analyzePost(content)
    ├── SeverityService.evaluate(content)     [parallel]
    ├── MarketSignalService.getMarketSignal() [parallel]
    └── callGrok(content)                     [parallel]
    ↓
tính ensemble + hard-rule override
    ↓
TelegramService.sendAlert(post, analysis, btcPrice, silent)
    ↓
StorageService.savePost(postRecord)
```

---

## Log output mẫu

```
[AnalysisService] model=35% | severity=35% | market=10% | ensemble=32% (decrease)
[AnalysisService] model=40% | severity=90% | market=10% | ensemble=53% → 88% (decrease) ⚠️ HARD RULE
```
