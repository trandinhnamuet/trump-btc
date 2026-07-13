# Cơ chế đánh giá tác động BTC — Tài liệu đầy đủ

*Phiên bản: v2.1 (pipeline chấm điểm v2 + máy phát hiện sự kiện lớp A). Cập nhật: 2026-07-14.*

Tài liệu này mô tả **toàn bộ** cơ chế đang chạy trên server: kiến trúc, từng tầng xử lý, mọi công thức, mọi hằng số quan trọng, số liệu đã đo, và giới hạn đã biết. Tài liệu chị em: `BAO-CAO-CO-CHE-V2.md` (báo cáo *vì sao phải làm lại* với số liệu backtest v1 đầy đủ).

---

## Mục lục

1. [Tổng quan và triết lý thiết kế](#1-tổng-quan-và-triết-lý-thiết-kế)
2. [Vòng đời một bài đăng](#2-vòng-đời-một-bài-đăng)
3. [Kênh 1 — Máy phát hiện sự kiện lớp A (Detector)](#3-kênh-1--máy-phát-hiện-sự-kiện-lớp-a-detector)
4. [Kênh 2 — Pipeline chấm điểm xác suất](#4-kênh-2--pipeline-chấm-điểm-xác-suất)
5. [Định nghĩa sự kiện đích và cách gắn nhãn](#5-định-nghĩa-sự-kiện-đích-và-cách-gắn-nhãn)
6. [Tầng hiệu chuẩn và vòng lặp đóng](#6-tầng-hiệu-chuẩn-và-vòng-lặp-đóng)
7. [Quy tắc gửi thông báo Telegram](#7-quy-tắc-gửi-thông-báo-telegram)
8. [Bộ công cụ đo lường](#8-bộ-công-cụ-đo-lường)
9. [Số liệu đã đo được](#9-số-liệu-đã-đo-được)
10. [Danh sách lệnh Telegram](#10-danh-sách-lệnh-telegram)
11. [Bản đồ mã nguồn và dữ liệu](#11-bản-đồ-mã-nguồn-và-dữ-liệu)
12. [Giới hạn đã biết và việc tiếp theo](#12-giới-hạn-đã-biết-và-việc-tiếp-theo)
13. [Lịch sử phiên bản](#13-lịch-sử-phiên-bản)

---

## 1. Tổng quan và triết lý thiết kế

Hệ thống theo dõi bài đăng của Trump trên Truth Social (poll mỗi 90–120 giây) và trả lời **hai câu hỏi khác nhau bằng hai kênh riêng biệt**:

| | Kênh 1: Detector | Kênh 2: Pipeline chấm điểm |
|---|---|---|
| **Câu hỏi** | Bài này có thuộc ~0.1% sự kiện chắc chắn gây biến động mạnh không? | Xác suất bài này gây biến động bất thường là bao nhiêu %? |
| **Bản chất bài toán** | Phân loại vào danh sách đóng | Ước lượng xác suất có hiệu chuẩn |
| **Đầu ra** | ALERT nhị phân (🚨 lớp A1–A5) | Con số % + hướng + khoảng tin cậy |
| **Triết lý** | Recall tuyệt đối — miss 1 sự kiện thật là fail; vài báo giả/tháng là rẻ | Hiệu chuẩn — nói 30% thì thực tế phải xảy ra ~30% số lần |
| **Tốc độ** | Tripwire: mili-giây; checklist: ~30 giây | Vài phút (ensemble nhiều model) |
| **Thứ tự chạy** | TRƯỚC, mọi bài tươi | SAU, mọi bài |

Hai nguyên tắc thiết kế xuyên suốt, rút ra từ số liệu thật (§9):

> **Nguyên tắc 1 — Đừng bắt LLM đưa ra xác suất.** LLM (nhất là free model) ước lượng xác suất tuyệt đối rất tồi (đo được trên 502 bài: AUC 0.529 ≈ ngẫu nhiên, bias +8.1%). Nhưng nó **phân loại** và **so sánh** khá ổn. Vì vậy: LLM chỉ cung cấp bằng chứng (đặc trưng, phân loại) và thứ hạng (so sánh với thang neo); con số cuối cùng do tầng thống kê hiệu chuẩn bằng dữ liệu giá thật sinh ra.

> **Nguyên tắc 2 — Hiệu chuẩn không tạo ra tín hiệu.** Tầng hiệu chuẩn chỉ sửa thang đo (bias, ECE), không tạo ra khả năng phân biệt (AUC). Đã chứng minh bằng số: áp isotonic lên dự đoán v1 xóa sạch bias (+8.1%→+0.3%) nhưng skill score vẫn ≈ 0. Nếu tầng LLM không phân biệt được bài nào với bài nào, không tầng thống kê nào cứu nổi. Đây chính là lý do detector tồn tại: với lớp sự kiện hiếm-nhưng-rõ-ràng, bỏ hẳn bài toán xác suất và làm phân loại thuần.

---

## 2. Vòng đời một bài đăng

```
fetch-posts.py (Python + curl_cffi giả lập Chrome, poll Truth Social mỗi 90–120s,
                backoff mũ 5→10→20→…60 phút khi bị 403)
        │
        ▼
PollingService.processPost(post)
        │
        ├─ Bước 0: bài đã phân tích rồi? → bỏ qua
        ├─ Bước 1: lấy giá BTC hiện tại (Binance → fallback CoinGecko)
        ├─ Bước 2: lưu PostRecord vào data/posts.json
        │          kèm 3 mốc kiểm giá: checkAt1h / checkAt1d / checkAt7d
        │          cập nhật lastPostId NGAY (chống app crash giữa chừng)
        │
        ├─ Bước 2.5: ★ DETECTOR (kênh 1) ★
        │     gate → novelty → tripwire (mili-giây, 0 call)
        │     → [LLM checklist 5 model song song, nếu tripwire im lặng]
        │     → dedup → nếu ALERT: gửi 🚨 đến MỌI user NGAY, trước khi chấm điểm
        │     (detector lỗi → chỉ log, KHÔNG chặn bước sau)
        │
        ├─ Bước 3: ★ PIPELINE CHẤM ĐIỂM (kênh 2) ★
        │     gate → severity + market context → ensemble (3 model × 3 mẫu)
        │     → hiệu chuẩn từng model → gộp trọng số Brier → pMove, pUp
        │     → ghi dự đoán vào lịch sử hiệu chuẩn (chấm điểm sau 1 giờ)
        │
        └─ Bước 4: gửi Telegram (§7)

──── Cron chạy nền ────────────────────────────────────────────────────
Mỗi 1 phút : ghi giá BTC thật tại mốc +1h / +1d / +7d cho các bài đến hạn
Mỗi 1 giờ  : VÒNG LẶP ĐÓNG — gắn nhãn các dự đoán đã quá 1h bằng giá Binance
             thật, fit lại đường hiệu chuẩn từng model, cập nhật base rate (§6.2)
Khi khởi động: backfill các bài chưa phân tích (bỏ qua bài >60 phút trong queue;
             backfill KHÔNG chạy detector — thời điểm thị trường đã qua)
```

**Ngân sách API:** tối đa **500 call/ngày** (đếm chung cả hai kênh qua một bộ đếm duy nhất, reset 0:00, cảnh báo Telegram khi vượt lần đầu trong ngày). Tiêu thụ điển hình một bài: detector 0–5 call + scoring 9 call ≈ **9–14 call**; bài bị gate chặn: **0 call**. Với ~20–30 bài/ngày và gate lọc ~50–70%, tổng tiêu thụ thực tế ~100–250 call/ngày.

---

## 3. Kênh 1 — Máy phát hiện sự kiện lớp A (Detector)

**File:** `src/detector/taxonomy.ts`, `src/detector/novelty.ts`, `src/detector/detector.service.ts`

### 3.1. Phân loại học sự kiện (taxonomy)

Danh sách **đóng** gồm 5 lớp sự kiện lịch sử đã chứng minh gây biến động mạnh:

| Lớp | Tên | Sự kiện thật minh họa |
|---|---|---|
| **A1** | Hành động crypto của chính phủ Mỹ | Crypto Strategic Reserve (02/03/2025 — BTC +8-10%), ký GENIUS Act (18/07/2025) |
| **A2** | Hành động thương mại quy mô lớn | Liberation Day (02/04/2025 — BTC $87k→<$75k), thuế 100% TQ (10/10/2025 — thanh lý ~$19B), tạm dừng thuế 90 ngày (09/04/2025 — S&P +9.5%) |
| **A3** | Sốc chính sách tiền tệ | Sa thải/thay chủ tịch Fed |
| **A4** | Hành động quân sự có Mỹ tham gia | Không kích cơ sở hạt nhân Iran (21/06/2025 — BTC xuống dưới $99k) |
| **A5** | Sốc hệ thống tài chính | Default nợ công, kiểm soát vốn |

Mỗi lớp có định nghĩa chặt trong prompt phân loại: **chỉ tính hành động đã tuyên bố / đã ký / có hiệu lực**; loại trừ quan điểm, lời dọa mơ hồ, khoe thành tích cũ. Định nghĩa lớp A3 ghi rõ: *"Trump chỉ trích Powell gần như hàng tuần — chỉ tính khi có hành động hoặc tuyên bố sa thải cụ thể"*.

### 3.2. Tầng 1 — Tripwire (bẫy luật, 0 API call)

12 rule compound viết cho **tiếng Anh** (Trump đăng tiếng Anh). Mỗi rule là mảng regex `allOf` — **tất cả phải khớp** (được phép khớp ở các câu khác nhau trong bài):

| Rule | Lớp | Logic compound |
|---|---|---|
| `A1_RESERVE_ACTION` | A1 | cụm "crypto/bitcoin/digital-asset + reserve/stockpile" **+** động từ hành động |
| `A1_CRYPTO_LAW_SIGNED` | A1 | "sign" + từ crypto/stablecoin/GENIUS + act/bill/law/executive-order |
| `A1_CRYPTO_BAN` | A1 | ngôi thứ nhất + "ban" + crypto **trong cùng một câu** (để "Biden wanted to ban crypto" không kích hoạt) |
| `A2_RECIPROCAL_TARIFFS` | A2 | "reciprocal tariffs" + động từ ký/áp/hiệu lực |
| `A2_PERCENT_TARIFF_MAJOR` | A2 | con số % + nền kinh tế lớn (China/EU/Mexico/Canada/Japan/India/Vietnam/Korea) + từ thuế + động từ hành động/hiệu lực |
| `A2_TARIFF_PAUSE` | A2 | "authorized a N-day pause" + tariff — **pause cũng là sự kiện lớn** (09/04/2025 thị trường bùng nổ chiều ngược) |
| `A2_ALL_COUNTRIES` | A2 | tariff + "all countries / countries throughout the world / nations near and far" + động từ hành động |
| `A3_FIRE_FED_CHAIR` | A3 | Powell/Fed-chair + fire/terminate/remove/replace/dismiss |
| `A4_STRIKE_COMPLETED` | A4 | completed/launched/carried-out/conducted + attack/strike/bombing |
| `A4_STRIKE_ON_SITES` | A4 | "attack/strike on" + nuclear/military/missile sites/facilities/bases |
| `A5_DEBT_DEFAULT` | A5 | "default on our/the debt" |
| `A5_CAPITAL_CONTROLS` | A5 | "capital controls" + động từ hành động |

Chi tiết thiết kế quan trọng:

- **Danh sách động từ hành động** (`sign, executive order, authorize, direct, establish, create, launch, implement, impose, hereby, announce, order`) **cố tình không chứa** "doing", "working" — để bài ca ngợi hành động cũ ("our Reserve is doing GREAT things") không kích hoạt tripwire.
- **Negation guard** trên từng rule: "will not / won't / never / ruled out / no plans to / cancelled / called off" khớp bất kỳ đâu → hủy rule. A4 thêm "exercise / drill" (tập trận ≠ tấn công).
- Chạy **đồng bộ, 0 API call, phản ứng trong mili-giây**. Tripwire nổ → alert bắn ngay, **bỏ qua tầng LLM** (tiết kiệm call và độ trễ).

Về nguồn gốc: đây là hậu duệ đúng đắn của hard-rule-88% trong v1. Sai lầm của v1 không phải là *có* tripwire — mà là bắt nó nhả ra một con số giả vờ đã hiệu chuẩn (88%). Bây giờ tripwire bắn **ALERT rời rạc**, tách hẳn khỏi thang xác suất.

### 3.3. Tầng 2 — LLM checklist (chỉ chạy khi tripwire im lặng)

- Gọi **5 model đầu pool, song song, 1 call/model**. Nhiệt độ **0.2** (phân loại cần ổn định, không cần đa dạng), max 700 token, timeout 40s.
- Prompt yêu cầu **phân loại — không phải dự đoán giá**. JSON trả về (suy luận trước, kết luận sau):

```json
{
  "reasoning":  "1-2 câu: bài tuyên bố gì, có phải hành động mới không",
  "eventClass": "A1" | "A2" | "A3" | "A4" | "A5" | "NONE",
  "confirmed":  true | false,
  "newAction":  true | false
}
```

  - `confirmed` = true **chỉ khi** bài tuyên bố hành động đã thực hiện / đã ký / có mốc thời gian cụ thể. Quan điểm ("Powell nên giảm lãi suất"), lời dọa mơ hồ ("sẽ phải trả giá"), kêu gọi → false.
  - `newAction` = true **chỉ khi** là hành động **mới tại thời điểm đăng**. Nhắc lại / ca ngợi / cập nhật về hành động đã công bố trước đó → false.

- **RAG-lite:** tối đa 8 bài trong 7 ngày gần nhất **giống bài mới nhất** (Jaccard, cắt 200 ký tự/bài) được đưa thẳng vào prompt, kèm chỉ dẫn: *"nếu bài mới chỉ nhắc lại điều đã công bố trong các bài trên → newAction = false"*. Đây là hàng rào chặn loại báo giả phổ biến nhất ngoài đời: Trump ca ngợi lại hành động cũ bằng từ ngữ khác.
- **Luật đồng thuận:** cần **≥ 2 phiếu cùng lớp** với `confirmed=true` **VÀ** `newAction=true`. Model chết / JSON hỏng bị loại êm; hết hạn mức ngày → bỏ qua model đó, không sập luồng chính.

### 3.4. Tầng 3 — Novelty và dedup

**Novelty (tính mới):** Jaccard trên tập token (bỏ URL, stopword tiếng Anh, từ <3 ký tự) giữa bài mới và **mọi bài trong 7 ngày gần nhất**. `maxSimilarity ≥ 0.5` → bài lặp → **không alert bất kể tripwire hay đồng thuận nói gì**. Lý do: bài làm thị trường rung chuyển hầu như luôn là bài **đầu tiên** công bố một hành động; các bài lặp sau đó thị trường đã định giá xong.

**Dedup theo lớp:** đã alert lớp X trong **24 giờ** và nội dung lần này giống lần đó (Jaccard ≥ 0.35) → chặn. Hai sự kiện **thật khác nhau** cùng lớp trong 24h (nội dung khác hẳn nhau) vẫn alert cả hai. Trạng thái dedup nằm trong memory — restart xoá, tệ nhất là một alert trùng sau restart (chấp nhận được với triết lý recall-first).

### 3.5. Luật quyết định và hành vi alert

```
ALERT ⟺ ( tripwire khớp   HOẶC   đồng thuận ≥2 phiếu confirmed+newAction )
        VÀ không phải bài lặp (novelty < ngưỡng)
        VÀ không trùng alert cùng lớp trong 24h (dedup)
```

Khi ALERT: gửi 🚨🚨🚨 đến **tất cả user, bỏ qua ngưỡng `/thr` cá nhân, luôn có âm thanh**, và gửi **trước khi** pipeline chấm điểm chạy (vốn mất vài phút). Nội dung tin nói rõ: *"Kỳ vọng BTC biến động mạnh trong ~60 phút — HƯỚNG KHÔNG CHẮC CHẮN"* — lịch sử cho thấy cả tin "tốt" cho crypto cũng có thể làm giá giảm (sell-the-news: chính sự kiện Crypto Reserve 03/2025 tăng rồi sập, Liberation Day là tin vĩ mô làm giá rơi cả tuần). Kết quả detector được persist vào `PostRecord.detection` để kiểm toán.

---

## 4. Kênh 2 — Pipeline chấm điểm xác suất

**File:** `src/analysis/` + `src/calibration/`

### 4.1. Gate — lọc rẻ (0 call)

Loại thẳng, không tốn API call: bài rỗng, chỉ có URL (kể cả "RT: <url>"), chỉ có emoji/ký hiệu. Bài bị chặn nhận kết quả 0% / neutral / summary giải thích. Gate **không cố đoán mức tác động** — chỉ loại thứ chắc chắn không có nội dung để phân tích.

### 4.2. Đầu vào ngữ cảnh (song song, trước khi gọi LLM)

- **Market context** (`market-signal.service.ts`): nến ngày (32 phiên) + nến tuần (53 phiên) từ Binance → giá hiện tại, %24h/7d/30d, đỉnh-đáy 52 tuần, khoảng cách đến đỉnh, nhãn xu hướng bằng lời. Tất cả đưa vào prompt để model biết chế độ thị trường.
- **Severity** (`severity.service.ts`): 9 nhóm rule từ khóa compound có negation guard:

  | Nhóm | Weight | Nhóm | Weight |
  |---|---|---|---|
  | NUCLEAR_WMD | 0.90 | FED_INTEREST_RATE | 0.40 |
  | CRYPTO_REGULATION | 0.80 | TARIFF_TRADE_WAR | 0.35 |
  | FINANCIAL_SYSTEM_CRISIS | 0.75 | RECESSION_DEPRESSION | 0.35 |
  | MILITARY_STRIKE | 0.70 | REALTIME_SIGNAL | 0.25 |
  | | | GEOPOLITICAL_TENSION | 0.20 |

  **Ở v2, severity là một ĐẶC TRƯNG đầu vào (trọng số 0.15 trong điểm thô), không còn là hard-rule override 88% như v1.** Con số 88 của v1 là magic number không được hiệu chuẩn; giờ một bài khớp CRYPTO_REGULATION chỉ đẩy điểm thô lên, rồi tầng hiệu chuẩn quyết định điều đó tương ứng bao nhiêu % thực nghiệm. Trường `hardRule` luôn = false.

### 4.3. Prompt v2 — hỏi thứ hạng, không hỏi %

Ba khác biệt cốt lõi so với v1 (mỗi cái nhắm thẳng một nguyên nhân thất bại đã đo được):

1. **`reasoning` là trường ĐẦU TIÊN trong JSON.** LLM sinh token tuần tự — v1 để con số trước lý do, buộc model chốt số rồi mới viết lý lẽ biện minh (chain-of-thought ngược). v2 ép suy luận trước, kết luận sau.

2. **Thang neo so sánh thay cho câu hỏi "%".** Prompt chứa **6 bài neo cố định**, xếp từ ít tác động nhất đến nhiều nhất:

   | # | Neo | Vì sao ở vị trí này |
   |---|---|---|
   | 0 | Chúc sinh nhật thượng nghị sĩ | thuần xã giao |
   | 1 | "MAGA! Nước Mỹ đang thắng lớn!" | khẩu hiệu, không có thông tin |
   | 2 | Công kích truyền thông | không liên quan thị trường |
   | 3 | "Tuần tới tôi sẽ gặp chủ tịch Fed bàn lãi suất" | chạm vĩ mô, chưa cam kết hành động |
   | 4 | "Vừa ký thuế 25% toàn bộ hàng Trung Quốc, hiệu lực thứ Hai" | hành động xác nhận, có số + mốc thời gian |
   | 5 | "Chính thức lập Quỹ Dự trữ Bitcoin, mua vào từ hôm nay" | tác động trực tiếp, tức thì lên chính BTC |

   Model trả lời 6 phán đoán nhị phân `beatsAnchor[6]`: *"bài này có khả năng gây biến động mạnh hơn neo [i] không?"*. Phán đoán so sánh **bất biến với độ lệch thang đo riêng của từng model** — model "quen chấm cao" vẫn nói đúng rằng bài A yếu hơn neo thuế quan. Đây là thứ triệt tiêu tận gốc triệu chứng "model A tin nào cũng chấm cao, model B tin nào cũng thấp".

3. **Nêu thẳng base rate.** Prompt ghi: *"trong lịch sử, chỉ khoảng X% số bài Trump đăng đi kèm biến động bất thường; đừng cho rằng bài quan trọng về chính trị thì sẽ làm BTC di chuyển — hai chuyện đó khác nhau"* (X đọc từ trạng thái hiệu chuẩn hiện hành). Không có mỏ neo này, model rải điểm quanh giữa thang 0–100 theo thói quen được huấn luyện "dùng hết thang đo".

Toàn bộ JSON model trả về: `reasoning, summary, topics[], actionable (có cam kết hành động cụ thể?), novel (thông tin mới hay nhắc lại?), beatsAnchor[6], bucket (0–5 theo rubric rời rạc có định nghĩa từng bậc), direction (increase|decrease|neutral), directionConfidence (0.5–1.0)`.

Hai sửa lỗi quan trọng so với v1 nằm ngay ở đây: (a) **cho phép `neutral`** — v1 cấm, ép model tung đồng xu sinh tín hiệu hướng giả; (b) **parse chặt** — thiếu `bucket` hợp lệ hoặc `beatsAnchor` đủ 6 phần tử → coi là lỗi mẫu, không âm thầm quy về 0 (v1 có bug `Number("85%") → NaN → || 0 → 0%` nuốt mất dự đoán không một dòng log; giờ số được bóc từ chuỗi an toàn).

### 4.4. Điểm thô của một phán đoán

```
anchorRank = số neo bị "đánh bại" / 6           ∈ {0, 1/6, ..., 1}
bucketNorm = bucket / 5                          ∈ {0, 0.2, ..., 1}
rawScore   = 0.65 × anchorRank + 0.20 × bucketNorm + 0.15 × severityScore
```

Trọng số dồn vào `anchorRank` vì đó là thành phần duy nhất bất biến với thang đo riêng của model; `bucket` chủ yếu để phá thế hòa (thang neo chỉ cho 7 giá trị rời rạc). ⚠️ Ba trọng số này hiện là **số đặt tay** — nâng cấp đã lên kế hoạch là học chúng bằng logistic regression trên dữ liệu nhãn (§12).

### 4.5. Ensemble — pool tự phục hồi, chấm dứt "model roulette"

- **Pool 8 model free** (OpenRouter), theo thứ tự ưu tiên:
  1. `nvidia/nemotron-nano-12b-v2-vl` (vision) 2. `openai/gpt-oss-20b` 3. `nvidia/nemotron-3-super-120b` 4. `nvidia/nemotron-3-nano-30b` 5. `openai/gpt-oss-120b` 6. `meta-llama/llama-3.3-70b` 7. `qwen/qwen3-next-80b` 8. `google/gemma-4-31b` (vision)
- Mỗi bài: duyệt pool theo thứ tự, lấy **3 model đầu tiên cho ra kết quả**; tối đa thử 5 model (circuit breaker khi cả free tier sập). Model chết (429/404/timeout/JSON hỏng cả 3 mẫu) bị bỏ qua, **nhưng model thay thế được ghi dưới đúng tên của nó** → đường hiệu chuẩn theo từng model không bao giờ bị lẫn.
  *Bối cảnh: v1 dùng fallback chain âm thầm — bài A do nemotron chấm, bài B do llama chấm, các thang đo khác nhau trộn vào một chuỗi rồi so với ngưỡng cố định. Backtest đo được thiệt hại này trực tiếp: AUC gộp thấp hơn hẳn AUC trung bình từng model.*
- **Self-consistency:** mỗi model lấy **3 mẫu ở nhiệt độ 0.6** → lấy **median** điểm thô; độ tán xạ (max−min) giữa các mẫu là ước lượng độ bất định nội tại của model. *(v1 dùng temp 0.1 — giảm variance nhưng khóa chặt bias: nhất quán không phải là chính xác, nó chỉ khiến model sai một cách ổn định hơn.)*
- **Truncation ≠ lỗi JSON:** response bị cắt (`finish_reason=length`) → **nâng max_tokens 1200→2000 và thử lại CHÍNH model đó**, không đổi model. *(v1 nhầm truncation thành JSON hỏng → fallback → vô tình loại bỏ hệ thống các model viết dài — tiếng Việt tokenize tệ — chứ không phải model dở.)*
- Bài có ảnh: chỉ model vision trong pool nhận ảnh (tối đa 4).
- Phán đoán "đại diện" để hiển thị summary/reasoning = mẫu có điểm thô gần median nhất, của model có trọng số cao nhất.

### 4.6. Hiệu chuẩn từng model rồi gộp

Điểm thô mỗi model đi qua tầng hiệu chuẩn **riêng của model đó** (§6.1) → `pMove_i`. Gộp:

```
weight_i  = 1 / (Brier_i + 0.01)      ← model chấm dở tự động mất ảnh hưởng
            (model chưa có Brier nhận trọng số trung bình của các model đã có)
pMove     = Σ wᵢ·pMoveᵢ / Σ wᵢ
band      = [min pMoveᵢ , max pMoveᵢ]                     ← hiển thị cho user
agreement = 1 − (max−min) / (2 × max(0.05, pMove))        ← 1 = đồng thuận tuyệt đối
```

**Hướng (pUp)** tách riêng khỏi pMove — giải quyết vấn đề v1 "một con số gánh bốn câu hỏi":

```
phiếu mỗi mẫu:  neutral → 0.5 | increase → confidence | decrease → 1 − confidence
rawUp = trung bình phiếu trong model, rồi gộp giữa các model theo trọng số Brier
pUp   = (n_moved × rawUp + 10 × P(up|moved)_lịch_sử) / (n_moved + 10)
        ← co về tần suất nền khi số quan sát "moved" còn ít
hiển thị:  pUp ≥ 0.6 → TĂNG ↑ | pUp ≤ 0.4 → GIẢM ↓ | còn lại → TRUNG LẬP ─
        ← vùng chết chống tín hiệu hướng giả
```

Kết quả cuối được lưu đầy đủ trong `AnalysisResult.scoring`: `pMove, pUp, pMoveLow/High, agreement, calibrated (đã dùng isotonic chưa), baseRate tại thời điểm chấm, rawScores và pMoveByModel của từng model, promptVersion` — đủ để kiểm toán lại mọi con số về sau.

---

## 5. Định nghĩa sự kiện đích và cách gắn nhãn

**File:** `src/calibration/types.ts`, `labeler.ts`, `binance-history.ts`

Đây là nền móng của mọi thứ: **một xác suất chỉ có nghĩa khi gắn với một sự kiện phân giải được**. V1 thất bại từ gốc vì "% khả năng tác động giá" không phải mệnh đề đúng/sai được — không sự kiện, không ngưỡng, không khung thời gian → không đo được → không hiệu chỉnh được.

### 5.1. Sự kiện đích

```
r     = ln( P(t₀+60 phút) / P(t₀) )     log-return 1 giờ sau khi Trump đăng
σ     = EWMA std của log-return theo giờ, tính TRƯỚC t₀   (không nhìn tương lai)
z     = r / σ                            abnormal return chuẩn hóa theo vol

moved = |z| ≥ 2        ← sự kiện mà pMove đo lường
up    = z > 0          ← sự kiện mà pUp đo lường (chỉ có nghĩa khi moved)
```

Vì sao chuẩn hóa theo vol là bắt buộc: 0.5% lúc thị trường lặng là tín hiệu thật; 0.5% lúc thị trường sôi là nhiễu. Ngưỡng cứng kiểu "±1% sau 7 ngày" (v1) gần như luôn "trúng" khi vol cao và luôn "trượt" khi vol thấp — không đo cái gì có nghĩa.

Tham số: EWMA halflife **72 giờ**; cửa sổ tính σ **14 ngày** trước t₀; yêu cầu tối thiểu **72 log-return giờ liền mạch** (bỏ mọi cặp nến bắc qua khoảng trống dữ liệu); σ = 0 hoặc thiếu dữ liệu → bài không gắn nhãn được (ghi lý do).

### 5.2. Nguồn giá và chống look-ahead

Nến **1 phút BTCUSDT** từ Binance (miễn phí, không cần API key, không giới hạn lịch sử), cache xuống đĩa **theo tháng** (`data/klines/BTCUSDT-1m-YYYY-MM.json`) — tháng đã đóng không bao giờ fetch lại; tháng hiện tại chỉ fetch phần đuôi. Giá tại thời điểm t luôn lấy bằng `closeAtOrBefore(t)`: **giá đóng của nến gần nhất kết thúc trước hoặc đúng t** — không bao giờ nhìn về tương lai. Khoảng trống dữ liệu > 5 phút → trả null.

### 5.3. Khử cluster — bắt buộc cho mọi thống kê

Trump thường đăng liên tiếp nhiều bài trong vài phút — chúng **chia sẻ cùng một kết quả thị trường**. Các bài có cửa sổ [t₀, t₀+1h] chồng lấn được gộp thành cluster (single-linkage, ngưỡng 1 giờ); **mọi chỉ số đánh giá, base rate, và tập fit isotonic chỉ dùng 1 bài đại diện/cluster** (bài sớm nhất). Số liệu thật: 2157 bài → chỉ **502 quan sát độc lập**. Không khử cluster thì mọi metric đều bị thổi phồng bởi những chuỗi bài trùng kết quả.

---

## 6. Tầng hiệu chuẩn và vòng lặp đóng

**File:** `src/calibration/calibration.service.ts`, `isotonic.ts`, `quantile.ts`, `metrics.ts` · **State:** `data/calibration.json`

### 6.1. Ba chế độ, tự chuyển khi dữ liệu tích lũy đủ (riêng cho từng model)

**Chế độ LẠNH** (mặc định khi mới deploy — chưa có gì):
```
prior_odds     = baseRate / (1 − baseRate)          (bootstrap: baseRate = 5%)
likelihood     = exp( 4.6 × (rawScore − 0.35) )     điểm thô làm BẰNG CHỨNG
posterior_odds = prior_odds × likelihood
pMove          = clamp( odds/(1+odds), 0, 0.85 )
```
LLM sinh *evidence weight*, không sinh posterior — con số luôn xoay quanh base rate. Đây là thứ chấm dứt tình trạng "mọi bài đều 40–70%" của v1.

**Chế độ ẤM** (model có ≥ 40 điểm thô trong buffer): thay `rawScore` bằng **phân vị của nó trong buffer 200 điểm gần nhất của chính model đó** (mid-rank cho giá trị trùng — các model hay nhả số tròn), pivot dịch 0.35 → 0.5. Phân vị **bất biến với mọi biến đổi đơn điệu** của thang đo model — model chấm {0.6, 0.7, 0.9} và model chấm {0.05, 0.10, 0.20} cho ra cùng bộ phân vị. Khử bias cộng tính/co giãn **mà chưa cần nhãn nào**.

**Chế độ NÓNG** (model có ≥ 30 nhãn thật): **isotonic regression** (Pool-Adjacent-Violators) học ánh xạ đơn điệu không giảm từ điểm thô → tần suất thực nghiệm, với shrinkage kéo mỗi bậc về base rate bằng pseudo-count 5 (bậc chỉ có 2 quan sát tình cờ đều "moved" sẽ không nhảy lên 100%). Đây là chế độ đích: **con số đến từ tần suất thật; model chỉ cần xếp hạng đúng thứ tự**. Một model "luôn chấm cao" và một model "luôn chấm thấp" có cùng thứ hạng sẽ cho cùng đường hiệu chuẩn — có unit test xác minh đúng tính chất này.

**Trần cứng `pMove ≤ 85%`** ở mọi chế độ: không bằng chứng nào từ một bài đăng đủ mạnh để chắc chắn hơn thế về hành vi thị trường trong 1 giờ.

### 6.2. Vòng lặp đóng (cron mỗi giờ — thứ biến hệ thống từ "mù" thành "tự sửa")

```
1. Tìm các dự đoán đã ghi (postId, t₀, model, rawScore, pMove) mà t₀+1h đã qua
2. Tải nến Binance (cache) → tính z thật → gắn nhãn moved/up
3. Khử cluster → cập nhật baseRate (cần ≥ 20 bài) và P(up|moved)
4. Mỗi model đủ ≥ 30 nhãn: fit lại isotonic + tính Brier
   (Brier quay lại làm trọng số ensemble §4.6 — model dở tự mất tiếng nói)
5. Persist toàn bộ trạng thái vào data/calibration.json
```

Có thể kích hoạt thủ công bằng lệnh `/refit`. Lưu ý: `/test` **cố tình không ghi** vào lịch sử hiệu chuẩn (tránh double-count với luồng poll thật); chỉ bài qua polling / backfill / `/latest` mới được ghi.

---

## 7. Quy tắc gửi thông báo Telegram

| Kênh | Điều kiện | Người nhận | Âm thanh |
|---|---|---|---|
| 🚨🚨🚨 Detector alert | Sự kiện lớp A (§3.5) | **Mọi user — bỏ qua /thr** | Luôn kêu |
| 🚨 Alert chấm điểm | pMove ≥ 10% | User có `/thr` ≤ pMove | Kêu |
| 📋 Tin im lặng | pMove < 10% | User có `/thr` ≤ pMove | Không |

Tin chấm điểm hiển thị: thanh xác suất + %, hướng ↑/↓/─, model đại diện + số model tham gia + phiên bản prompt, **base rate hiện hành** (để "8%" có mỏ neo — không có nó 8% trông như "chẳng có gì" trong khi thực chất là 1.6× tần suất nền), nguồn con số (isotonic / prior+bằng chứng), khoảng dao động giữa các model + % đồng thuận, P(tăng|có biến động), các severity rule khớp.

Detector alert gửi **trước** tin chấm điểm vài phút và ghi rõ *"Phân tích chi tiết (%) sẽ được gửi sau ít phút"*. Mọi alert được ghi `data/alerts.log` (JSON per line).

---

## 8. Bộ công cụ đo lường

Nguyên tắc: **mọi thay đổi cơ chế phải đo được trước khi tin**.

### `npm run dataset:build`
Gắn nhãn toàn bộ lịch sử `data/posts.json` bằng nến Binance thật (0 LLM call) → `data/labeled.json`. In: base rate, P(up|moved), số bài gắn được/không (kèm lý do), số cluster.

### `npm run backtest`
So dự đoán đã lưu với nhãn thật (sau khử cluster). Báo cáo:
- **Brier skill score** vs predictor hằng số = base rate — *thước đo trung thực duy nhất*: ≤ 0 nghĩa là không hơn gì đoán bừa theo tần suất nền, bất kể con số trông đẹp đến đâu.
- **AUC** — khả năng xếp hạng, độc lập với hiệu chuẩn. Đây là số quyết định: AUC ≈ 0.5 → không tầng hiệu chuẩn nào cứu được, phải sửa model/prompt; AUC ổn + ECE cao → chỉ cần hiệu chuẩn.
- **Bias từng model** (mean prediction − base rate) — định lượng chính xác triệu chứng "model này chấm cao, model kia chấm thấp".
- **Thiệt hại model-roulette**: AUC trung bình từng model vs AUC khi gộp chuỗi.
- **Reliability diagram** (bin theo phân vị) + ECE + log loss.
- **Isotonic out-of-fold 5 folds** — ước lượng trung thực (không nhìn trộm) hiệu chuẩn sẽ cứu được bao nhiêu.
- Độ đúng hướng, chỉ tính trên các bài thực sự moved.

### `npm run detector:eval [-- --rules-only]`
Chạy detector trên **golden set** (`src/eval/golden-set.ts`): **7 positives** (sự kiện thật dựng lại sát nguyên văn — recall bắt buộc 100%, miss là exit code fail), **2 borderline** (bắt/bỏ đều chấp nhận, chỉ báo cáo), **12 decoys** (đo báo động giả) — gồm các decoy khó nhất: ca ngợi hành động đã công bố (kèm ngữ cảnh bài gốc), than phiền Fed kiểu-hàng-tuần, dọa thuế có điều kiện, khoe thành tích thuế cũ. `--rules-only`: chỉ tripwire + novelty, 0 API call, chạy tức thì — dùng khi chỉnh pattern.

### `npx jest`
19 unit test cho toán học cốt lõi: isotonic (PAV + shrinkage + tính chất khử-bias-thang-đo), quantile, EWMA/labeler/cluster, metrics.

---

## 9. Số liệu đã đo được

### 9.1. Backtest v1 — 2157 bài server, 502 quan sát sau khử cluster (lý do làm lại toàn bộ)

| Chỉ số | Giá trị | Ý nghĩa |
|---|---|---|
| Base rate thật | **7.8%** | chỉ 7.8% bài đi kèm \|z\| ≥ 2 trong 1h |
| v1 chấm trung bình | 15.9% | **cao gấp 2× thực tế** (bias +8.1%) |
| AUC | **0.529** | ≈ ngẫu nhiên — gần như không phân biệt được bài nào với bài nào |
| Đúng hướng (trên bài moved) | 9/17 = 52.9% | tung đồng xu |
| Brier skill score | **−0.378** | tệ hơn cả đoán bừa theo base rate |
| Bài chấm đúng 0% | 27.5% | gồm cả bài trúng bug `Number("85%")→0` |
| P(up\|moved) | 66.7% | bài gây biến động thiên về tăng (bull market giai đoạn này) |

**Phát hiện quan trọng nhất:** áp isotonic out-of-fold lên chính dự đoán v1 → bias +8.1% → **+0.3%**, ECE 0.124 → **0.031**, nhưng skill score −0.378 → **−0.006** (vẫn ≈ 0). Kết luận bằng số: **hiệu chuẩn xóa được bias nhưng không chế ra được tín hiệu xếp hạng vốn không tồn tại.** Toàn bộ thiết kế v2 (thang neo) và detector (bỏ hẳn bài toán xác suất cho lớp sự kiện rõ ràng) xuất phát từ dòng này.

### 9.2. Spot-check v2 trên sự kiện lịch sử (paraphrase — chưa phải backtest đầy đủ)

| Bài | v2 chấm | Đối chiếu |
|---|---|---|
| Lập Strategic Bitcoin Reserve (BTC/ETH/XRP/SOL/ADA) | **32%** | cao nhất, đúng thứ hạng; severity CRYPTO_REGULATION khớp |
| Liberation Day — thuế toàn cầu | **12%** | trên base rate; model coi "Trump nói thuế" đã định giá một phần |
| Chúc sinh nhật (đối chứng) | **1–2%** | đúng: neo quanh/dưới base rate |

Thứ tự 32 > 12 > 1–2 khớp thực tế. Model chọn hướng **neutral** cho cả hai bài lớn — đúng một cách tinh tế: cả hai đều là sự kiện "tin tốt → giá giảm"; đoán "tăng" mới là sai. Trong reasoning, model **chủ động dẫn chiếu thang neo** ("tương đương neo 5, mạnh hơn các neo trước") — cơ chế so sánh hoạt động đúng thiết kế. **AUC thật của v2 cần 1–2 tuần tích lũy dữ liệu rồi chạy `npm run backtest` — đây là câu hỏi make-or-break còn mở.**

### 9.3. Detector trên golden set

| Thước đo | Kết quả |
|---|---|
| Recall trên 7 sự kiện thật | **7/7** — tất cả bị tripwire bắt ngay tầng luật (0 API call, mili-giây) |
| Báo động giả trên 12 decoys | **0/12** |
| Borderline | Powell-termination → **bắt** (thị trường thật đã giảm hôm đó — defensible); follow-up thêm BTC/ETH vào reserve → **bỏ** |

Ca đáng giá nhất: decoy *"ca ngợi Strategic Bitcoin Reserve đã công bố tuần trước"* — cả 2 model trả lời đều nhận ra chủ đề A1, một model đánh dấu `confirmed`, nhưng **không model nào đánh dấu `newAction`** (nhờ RAG-lite đưa bài gốc vào ngữ cảnh) → chặn đúng. Decoy *"dọa thuế có điều kiện"* — 2 model gắn A2 nhưng không `confirmed` → chặn đúng.

---

## 10. Danh sách lệnh Telegram

| Lệnh | Chức năng |
|---|---|
| `/start` | Đăng ký nhận alert |
| `/btc` | Giá BTC hiện tại |
| `/test <nội dung \| postId \| URL>` | Chạy pipeline chấm điểm thủ công (kết quả đầy đủ; **không** ghi vào lịch sử hiệu chuẩn) |
| `/detect <nội dung>` | Chạy detector thủ công: tripwire + checklist 5 model + novelty, hiện phiếu từng model |
| `/testall <nội dung \| postId>` | So sánh tất cả 17 model trong danh sách — **dùng đúng prompt production** (v1 dùng prompt khác hẳn, kết quả so sánh vô nghĩa) |
| `/testallfull <nội dung>` | Như trên + giải thích của từng model |
| `/check` / `/check-all` / `/check2` | Bài có pMove ≥ **15%** (7 gần nhất / tất cả / 10 ngày), kèm giá +1h/+1d/+7d. Ngưỡng 15 ≈ 2–3× base rate — thang v2 đã hiệu chuẩn nên ngưỡng 30% cũ của v1 gần như không bao giờ đạt |
| `/latest` | Phân tích lại + gửi alert bài mới nhất |
| `/prompt [nội dung]` | Xem prompt v2 thật đang dùng (thang neo, base rate hiện hành, rubric) |
| `/calib` | Trạng thái hiệu chuẩn: base rate, P(up\|moved), số nhãn, model nào đã có isotonic |
| `/refit` | Chạy vòng lặp đóng ngay, không đợi cron giờ |
| `/model` | Xem chế độ hiện tại (mặc định: `ensemble (3 model từ pool 8)`) |
| `/model <tên>` | Ép chạy 1 model đơn lẻ — **chỉ để thử nghiệm**, phá ổn định thang đo giữa các bài |
| `/model ensemble` | Quay lại chế độ mặc định |
| `/models` / `/model-list` | Danh sách model, đánh dấu 🎯pool#N = thứ tự ưu tiên trong ensemble pool |
| `/thr <số>` | Ngưỡng nhận tin cá nhân (⚠️ detector alert bỏ qua ngưỡng này) |
| `/credit` | Trạng thái API key + số call hôm nay / 500 |
| `/skipped` | Bài bị bỏ qua vì quá 60 phút trong hàng chờ |
| `/clear dd-mm-yyyy` | Xoá bài trước ngày |
| `/menu` | Danh sách lệnh |

---

## 11. Bản đồ mã nguồn và dữ liệu

```
src/
├── detector/                      KÊNH 1 — phát hiện sự kiện lớp A
│   ├── taxonomy.ts                  5 lớp A1–A5, 12 tripwire compound, negation guard
│   ├── novelty.ts                   tokenize / Jaccard / assessNovelty / topSimilar
│   └── detector.service.ts          tripwire → checklist 5-model → đồng thuận → dedup
├── analysis/                      KÊNH 2 — chấm điểm
│   ├── gate.ts                      lọc heuristic 0-call
│   ├── prompt-v2.ts                 thang neo 6 bậc, rubric bucket, parse chặt, rawScoreOf
│   ├── openrouter.client.ts         HTTP client, PHÂN LOẠI lỗi (truncation ≠ JSON hỏng)
│   ├── ensemble.service.ts          pool 8 model, 3 model × 3 mẫu, gộp trọng số Brier
│   └── analysis.service.ts          orchestrator + bộ đếm 500 call/ngày + /testall
├── calibration/                   NỀN MÓNG ĐO LƯỜNG
│   ├── types.ts                     định nghĩa sự kiện đích (z, ngưỡng 2, EWMA 72h)
│   ├── binance-history.ts           nến 1m, cache theo tháng, closeAtOrBefore (no look-ahead)
│   ├── labeler.ts                   r₁ₕ, EWMA σ, z-score, khử cluster chồng lấn
│   ├── isotonic.ts                  PAV + shrinkage pseudo-count 5 về base rate
│   ├── quantile.ts                  chuẩn hóa phân vị theo từng model (buffer 200)
│   ├── metrics.ts                   Brier, skill, AUC, reliability, ECE
│   ├── calibration.service.ts       3 chế độ lạnh/ấm/nóng + vòng lặp refit
│   └── calibration.spec.ts          19 unit test toán học cốt lõi
├── severity/severity.service.ts   9 nhóm rule — nay là ĐẶC TRƯNG (0.15), không override
├── market-signal/                 bối cảnh thị trường cho prompt (Binance ngày + tuần)
├── polling/polling.service.ts     orchestrator vòng đời bài + 3 cron
├── telegram/telegram.service.ts   bot: alert 2 kênh + toàn bộ lệnh
├── storage/storage.service.ts     persist data/posts.json
└── eval/                          CÔNG CỤ ĐO
    ├── build-dataset.ts             gắn nhãn lịch sử           npm run dataset:build
    ├── backtest.ts                  báo cáo độ chính xác        npm run backtest
    ├── golden-set.ts                7 positives + 2 borderline + 12 decoys
    └── eval-detector.ts             recall / báo giả detector   npm run detector:eval

data/  (không commit)
├── posts.json               mọi bài + kết quả 2 kênh + giá +1h/+1d/+7d
├── calibration.json          trạng thái hiệu chuẩn: buffer phân vị, isotonic,
│                             Brier từng model, lịch sử dự đoán (tối đa 5000 bản ghi)
├── klines/                   cache nến Binance 1m theo tháng
├── labeled.json              dataset nhãn (tái tạo được bằng dataset:build)
├── users.json                user Telegram + ngưỡng /thr
├── alerts.log                lịch sử alert đã gửi (audit)
└── skipped-analysis.json     bài bị bỏ qua vì quá hạn queue
```

---

## 12. Giới hạn đã biết và việc tiếp theo

### Giới hạn cấu trúc (không sửa được bằng code)

1. **Trần cứng của bài toán.** Dự đoán biến động BTC trong 1 giờ chỉ từ một bài đăng là việc trader chuyên nghiệp cũng không làm ổn định. Định nghĩa thành công thực tế: AUC ~0.65–0.70 và Brier skill dương rõ rệt — **không phải** "% chính xác tuyệt đối". Riêng **hướng** (tăng/giảm) gần như không đoán được từ nội dung bài: hai sự kiện lớn nhất lịch sử gần đây đều là "tin tốt cho crypto → giá giảm" (sell-the-news).
2. **Free tier OpenRouter phập phù nghiêm trọng.** Log server ghi nhận nhiều khoảng **cả 8 model cùng chết** ("Toàn bộ 8 model trong ensemble đều thất bại"). Tripwire miễn nhiễm (0 call) nhưng tầng checklist LLM và toàn bộ kênh chấm điểm mù trong các khoảng đó.

### Việc tiếp theo, xếp theo đòn bẩy

1. **Đo AUC thật của prompt v2** — chạy `npm run backtest` sau 1–2 tuần tích lũy. Make-or-break: nếu AUC vẫn ~0.5, kết luận dứt khoát free-model không đủ cho kênh chấm điểm.
2. **1 model trả phí rẻ làm backstop** (ước tính chi tiết đã làm: Haiku 4.5 ~$1/tháng nếu 1 call/bài, ~$10/tháng nếu chạy cả ensemble): vừa cứu tầng checklist khi free tier sập, vừa nâng trần xếp hạng. Với model trả phí, 1 call/bài là đủ — thang đo model mạnh tự ổn định, không cần 9 call để san bằng bias.
3. **Học trọng số `rawScoreOf` từ nhãn** (logistic regression trên 2157 bài đã gắn nhãn + đặc trưng trạng thái thị trường) thay cho 0.65/0.20/0.15 đặt tay — làm được ngay.
4. **Thay 6 bài neo viết tay bằng bài thật đã đo z** — thứ hạng thang neo trở thành quan sát thực nghiệm thay vì giả định của người thiết kế.
5. **RAG bằng chứng lịch sử cho kênh chấm điểm** ("20 bài giống nhất trong quá khứ → bao nhiêu bài moved?") — con số từ tần suất thực nghiệm thay vì cảm tính model. **Chờ đủ mẫu positive** (hiện ~40 bài moved — quá ít, truy hồi hàng xóm gần nhất từ 40 ca dễ học tương quan giả); bắt buộc đánh giá out-of-fold.
6. Sửa lỗi encoding `trendLabel` (hiện "â€”" thay vì "—" lọt vào prompt và output `/prompt`).
7. Mở rộng golden set bằng nguyên văn thật khi có archive Truth Social đầy đủ.

### Các quyết định thiết kế dễ gây thắc mắc (đọc trước khi "sửa")

- **Hầu hết bài nhận 1–3% là dấu hiệu hệ thống chạy ĐÚNG** (base rate 7.8%), không phải hỏng.
- `/test` không ghi lịch sử hiệu chuẩn — cố ý (tránh double-count với luồng poll).
- Backfill không chạy detector — cố ý (thời điểm thị trường đã qua, alert sẽ gây hiểu nhầm).
- Trần pMove 85%, vùng chết hướng 0.4–0.6, dedup in-memory, tripwire bỏ qua LLM khi đã nổ — đều là đánh đổi có chủ đích, đã ghi chú lý do trong code.
- Ngưỡng `/check` 15% (không phải 30% như v1) — thang v2 đã hiệu chuẩn quanh base rate ~8%, trần 85%; 30% gần như không bao giờ đạt.

---

## 13. Lịch sử phiên bản

| Phiên bản | Nội dung | Kết quả đo được |
|---|---|---|
| **v1** | 1 call LLM duy nhất, con số thô gửi thẳng Telegram; fallback chain âm thầm đổi model; SeverityService viết xong nhưng chưa bao giờ inject; hard-rule 88% (trên giấy) | AUC 0.529, bias +8.1%, skill −0.378, hướng 52.9% |
| **v2** (commit `10187bd`) | Định nghĩa sự kiện đích \|z\|≥2; prompt thang neo; ensemble pool 3×3; hiệu chuẩn 3 chế độ theo từng model; vòng lặp đóng hàng giờ; bộ công cụ backtest; sửa 5 bug nuốt tín hiệu | Hiệu chuẩn được chứng minh hoạt động (bias→+0.3%); AUC v2 chưa đo (cần tích lũy) |
| **v2.1** (commit `63c363e`) | Detector sự kiện lớp A: taxonomy + tripwire + checklist đồng thuận + novelty + dedup; alert khẩn trước scoring; golden set + eval; ngưỡng /check 30→15 | Recall 7/7, báo giả 0/12 trên golden set |
