# Trump-BTC: Cơ chế đánh giá xác suất ảnh hưởng BTC (v2)

> **Đọc trước:** tài liệu này mô tả hệ thống **v2**. Nguyên tắc thiết kế cốt lõi:
>
> **Đừng bắt LLM đưa ra xác suất. Bắt nó đưa ra bằng chứng và thứ hạng. Để một
> tầng thống kê được hiệu chuẩn bằng dữ liệu thật sinh ra con số.**
>
> LLM giỏi *phân loại* và *so sánh*, dở tệ ở *ước lượng xác suất tuyệt đối*. Cả
> pipeline được thiết kế để khai thác đúng thứ nó giỏi.

---

## Vì sao phải làm lại (vấn đề của v1)

v1 gửi lên Telegram **con số thô của một lần gọi LLM duy nhất**, không qua bất kỳ
lớp hiệu chỉnh nào. `SeverityService` được viết ra nhưng chưa bao giờ inject;
`ensembleProbability` chỉ đơn giản bằng `btcInfluenceProbability`. Hậu quả đo được:

1. **Bài toán không được định nghĩa.** "% khả năng tác động giá BTC" không phải
   mệnh đề đúng/sai được — không có sự kiện, không có ngưỡng, không có khung thời
   gian. Không đo được thì không hiệu chỉnh được.
2. **Model roulette.** Fallback chain âm thầm đổi model giữa các bài. Mỗi model có
   thang đo riêng; trộn chúng vào một chuỗi rồi so với ngưỡng cố định. Backtest đo
   được thiệt hại: AUC gộp tụt hẳn so với AUC từng model.
3. **Con số sinh trước lý luận.** JSON để `btcInfluenceProbability` trước
   `reasoning` → model chốt số rồi mới bịa lý do.
4. **Không có neo thang đo, không có base rate.** Mỗi model tự bịa thang riêng →
   "model A tin nào cũng cao, model B tin nào cũng thấp".
5. **Bug nuốt tín hiệu.** `Number("85%") || 0` → 85% biến thành 0% không một dòng
   log. Truncation bị nhầm thành JSON hỏng → loại bỏ model viết dài thay vì model dở.
6. **Không có vòng phản hồi.** Giá thực tế đã lưu sẵn nhưng chỉ dùng để in một dòng log.

---

## Sự kiện đích (v2 — có thể phân giải được)

```
r  = ln( P(t0 + 60m) / P(t0) )       log-return 1 giờ sau khi Trump đăng bài
σ  = EWMA std của log-return theo giờ, tính trên dữ liệu TRƯỚC t0 (halflife 72h)
z  = r / σ                           abnormal return đã chuẩn hóa theo vol

moved = |z| >= 2                     CÓ biến động bất thường hay không  → p_move
up    = z > 0                        hướng, CHỈ có nghĩa khi moved       → p_up
```

Chuẩn hóa theo vol là bắt buộc: 0.5% lúc thị trường lặng là tín hiệu, 0.5% lúc
thị trường sôi là nhiễu. Ngưỡng cứng `±1%` của v1 không tính đến điều này.

Tách `p_move` và `p_up` giải quyết "một con số gánh bốn câu hỏi". Ngưỡng alert
dùng `p_move`. Hướng chỉ hiển thị khi `p_up` lệch xa 0.5.

**Baseline bắt buộc phải vượt:** một predictor hằng số luôn trả về base rate. Nếu
Brier skill score không dương so với baseline này, hệ thống không tạo ra giá trị.
Đây là thước đo trung thực duy nhất — xem `npm run backtest`.

---

## Kiến trúc pipeline

```
                        gate (0 call)
                             │  loại reblog / URL / emoji thuần
                             ▼
             market context  +  severity (đặc trưng, không override)
                             ▼
        ENSEMBLE — pool có thứ tự, lấy 3 model chạy được
          mỗi model × 3 mẫu @ temp 0.6   (self-consistency)
             │  mỗi mẫu trả về BẰNG CHỨNG + SO SÁNH THANG NEO, không phải %
             ▼
        điểm thô mỗi model  →  HIỆU CHUẨN THEO TỪNG MODEL
             │  isotonic (khi đủ nhãn) HOẶC phân vị + Bayes base-rate (khi chưa)
             ▼
        gộp có trọng số nghịch đảo Brier  →  p_move, p_up
             ▼
        ghi nhận dự đoán  →  (1 giờ sau)  refit từ giá Binance thật
```

### Tầng gate — `src/analysis/gate.ts`

Thuần heuristic, 0 API call. Loại reblog thuần, URL trần, emoji/dấu câu thuần,
bài chỉ có ảnh không text. Không cố đoán mức tác động — chỉ loại thứ chắc chắn
không có gì để phân tích.

### Tầng đặc trưng — `src/analysis/prompt-v2.ts`

Prompt v2 KHÔNG hỏi xác suất. Nó hỏi:

- `reasoning` (trường **đầu tiên** — suy luận trước, kết luận sau)
- `topics`, `actionable`, `novel` — đặc trưng quan sát được
- `beatsAnchor[6]` — với mỗi bài neo: bài mới có làm BTC biến động mạnh hơn không?
- `bucket` 0–5 theo rubric rời rạc
- `direction` + `directionConfidence` (cho phép `neutral` = "tôi không biết")

Prompt nêu thẳng **base rate** để model không rải điểm quanh khoảng giữa thang.

**Điểm thô** = `0.65 × anchorRank + 0.2 × bucket + 0.15 × severity`. Trọng số dồn
vào anchorRank vì so sánh với thang neo **bất biến với độ lệch thang đo của model**
— đây là thứ triệt tiêu bias "model A luôn cao" ngay tại nguồn.

### Tầng ensemble — `src/analysis/ensemble.service.ts`

- **Pool có thứ tự**, lấy 3 model đầu tiên cho ra kết quả. Model chết bị thay bằng
  model kế tiếp, nhưng ghi dưới **đúng tên của nó** → hiệu chuẩn theo model không lẫn.
  (v1 fallback âm thầm; v2 minh bạch và có circuit breaker khi free tier sập.)
- **3 mẫu/model @ temperature 0.6.** Độ tán xạ giữa các mẫu = độ bất định nội tại
  của model. (v1 dùng temp 0.1 → nhất quán nhưng khóa chặt bias.)
- **Truncation → nâng token, thử lại CHÍNH model đó**, không đổi model.
- Gộp: trọng số **nghịch đảo Brier** — model chấm dở tự bị giảm ảnh hưởng.

### Tầng hiệu chuẩn — `src/calibration/calibration.service.ts`

Ba chế độ, tự chuyển khi dữ liệu tích lũy:

| Chế độ | Điều kiện | Cách tính p_move |
|--------|-----------|------------------|
| Lạnh | 0 nhãn | prior = base rate; điểm thô làm bằng chứng (likelihood ratio) |
| Ấm | ≥ 40 điểm thô/model | chuẩn hóa **phân vị theo từng model** rồi mới áp prior |
| Nóng | ≥ 30 nhãn/model | **isotonic regression** fit trên nhãn thật |

Ở cả ba chế độ, con số đều tôn trọng base rate — đây là thứ chấm dứt tình trạng
mọi bài đều 40–70%. Trần xác suất = 85% (không bằng chứng nào từ một bài đủ mạnh
để chắc chắn hơn).

Hợp nhất Bayes: `posterior_odds = prior_odds × likelihood_ratio`, prior lấy từ
base rate thực nghiệm. LLM sinh **evidence weight**, không sinh posterior.

### Vòng lặp đóng — cron mỗi giờ

`PollingService.refitCalibration()` → lấy giá thật từ Binance cho các dự đoán đã
quá 1 giờ, gắn nhãn (`|z| >= 2`?), fit lại isotonic từng model, cập nhật base rate.
**Không có bước này, mọi con số % chỉ là phỏng đoán không kiểm chứng.**

---

## Severity — nay là ĐẶC TRƯNG, không phải override

`SeverityService` (9 nhóm rule, guard phủ định) vẫn chạy, nhưng kết quả đi vào
điểm thô như một **đặc trưng có trọng số 0.15**, KHÔNG còn override lên 88%.

Con số 88 của v1 cũng là một magic number không được hiệu chuẩn. Ở v2, một bài
khớp `CRYPTO_REGULATION` chỉ đẩy điểm thô lên — rồi để tầng hiệu chuẩn quyết định
điều đó tương ứng với xác suất thực nghiệm bao nhiêu. `hardRule` luôn = false.

---

## Công cụ đo lường (Giai đoạn 0)

| Lệnh | Chức năng |
|------|-----------|
| `npm run dataset:build` | Gắn nhãn lịch sử từ `posts.json` + nến 1m Binance (0 LLM call). In base rate. |
| `npm run backtest` | Brier skill score, AUC, **bias từng model**, reliability diagram, thiệt hại roulette, isotonic out-of-fold. |

Nến Binance được cache theo tháng ở `data/klines/` → chạy lại rất rẻ. Đây là nền
tảng: **từ đây mọi thay đổi prompt/model đều đo được offline**, không còn đoán mò.

---

## Lệnh Telegram mới

| Lệnh | Chức năng |
|------|-----------|
| `/calib` | Trạng thái hiệu chuẩn: base rate, P(up\|moved), model nào đã fit |
| `/refit` | Chạy vòng lặp đóng ngay: gắn nhãn dự đoán quá 1h rồi fit lại |
| `/model ensemble` | Quay lại chế độ ensemble (mặc định) sau khi đã /model \<tên\> |

---

## Kỳ vọng thực tế

**Hầu hết bài của Trump không có tác động đo được lên BTC.** Một hệ hiệu chuẩn
đúng sẽ trả về **1–3% cho phần lớn bài** và chỉ bật lên ở thiểu số bài thực sự
quan trọng. Nếu bạn thấy phần lớn bài đều ~2%, **đó là hệ thống hoạt động đúng**,
không phải hỏng.

Ràng buộc free-model giới hạn trần chất lượng, nhưng tầng hiệu chuẩn hoạt động
**bất kể model mạnh hay yếu** — nó chỉ cần model xếp hạng đúng thứ tự tương đối,
phần còn lại do dữ liệu thật quyết định.

---

## Kiến trúc code (v2)

```
src/
├── analysis/
│   ├── analysis.service.ts     # orchestrator mỏng: gate → ensemble → calibrate → record
│   ├── ensemble.service.ts     # pool resilient, self-consistency, gộp trọng số Brier
│   ├── prompt-v2.ts            # prompt neo so sánh, parse chặt, điểm thô
│   ├── gate.ts                 # lọc heuristic 0-call
│   └── openrouter.client.ts    # HTTP client, phân loại lỗi (truncation ≠ JSON hỏng)
├── calibration/
│   ├── calibration.service.ts  # 3 chế độ lạnh/ấm/nóng, vòng lặp refit
│   ├── binance-history.ts      # nến 1m, cache theo tháng, tra giá không look-ahead
│   ├── labeler.ts              # r_1h, EWMA vol, z-score, khử cluster chồng lấn
│   ├── isotonic.ts             # PAV regression điểm thô → tần suất thực nghiệm
│   ├── quantile.ts             # chuẩn hóa phân vị theo từng model
│   ├── metrics.ts              # Brier, skill, AUC, reliability, ECE
│   └── types.ts                # định nghĩa sự kiện đích, hằng số
├── eval/
│   ├── build-dataset.ts        # CLI gắn nhãn lịch sử
│   └── backtest.ts             # CLI báo cáo độ chính xác + bias từng model
├── severity/severity.service.ts # nay là đặc trưng, không override
└── ...                          # polling, telegram, storage, btc-price như cũ
```
