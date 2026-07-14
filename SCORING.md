# Cơ chế phát hiện sự kiện lớn tác động giá BTC — Tài liệu đầy đủ

*Phiên bản: v3 (detector-only). Cập nhật: 2026-07-14.*

Hệ thống làm đúng **một việc**: theo dõi bài đăng của Trump trên Truth Social và phát hiện ~0.1% bài đăng gần như chắc chắn gây biến động mạnh giá BTC — lập crypto reserve, thuế toàn cầu, không kích quân sự... Khi phát hiện: gửi 🚨 alert Telegram đến mọi người dùng trong vòng vài giây đến ~30 giây. Mọi bài khác chỉ là tin feed im lặng.

Tài liệu chị em: `BAO-CAO-CO-CHE-V2.md` — báo cáo lịch sử giải thích vì sao kênh chấm điểm xác suất (v1, v2) bị loại bỏ, kèm số liệu backtest đầy đủ.

---

## Mục lục

1. [Vì sao chỉ còn detector](#1-vì-sao-chỉ-còn-detector)
2. [Vòng đời một bài đăng](#2-vòng-đời-một-bài-đăng)
3. [Phân loại học sự kiện — 5 lớp A1–A5](#3-phân-loại-học-sự-kiện--5-lớp-a1a5)
4. [Tầng 1 — Tripwire (bẫy luật)](#4-tầng-1--tripwire-bẫy-luật)
5. [Tầng 2 — LLM checklist đồng thuận](#5-tầng-2--llm-checklist-đồng-thuận)
6. [Tầng 3 — Novelty và dedup](#6-tầng-3--novelty-và-dedup)
7. [Luật quyết định và hành vi alert](#7-luật-quyết-định-và-hành-vi-alert)
8. [Theo dõi giá sau alert](#8-theo-dõi-giá-sau-alert)
9. [Đo lường — golden set](#9-đo-lường--golden-set)
10. [Lệnh Telegram](#10-lệnh-telegram)
11. [Bản đồ mã nguồn và dữ liệu](#11-bản-đồ-mã-nguồn-và-dữ-liệu)
12. [Giới hạn đã biết và việc tiếp theo](#12-giới-hạn-đã-biết-và-việc-tiếp-theo)
13. [Lịch sử phiên bản](#13-lịch-sử-phiên-bản)

---

## 1. Vì sao chỉ còn detector

Hệ thống từng có kênh thứ hai: chấm **xác suất %** cho mọi bài đăng (v1 hỏi thẳng LLM, v2 dùng thang neo + ensemble + hiệu chuẩn isotonic). Nó bị loại bỏ vì số liệu:

- Backtest 502 bài độc lập (đối chiếu giá Binance thật): **AUC 0.529** — free model gần như không phân biệt được bài nào sẽ gây biến động, ngang tung đồng xu.
- Tầng hiệu chuẩn xóa được bias (+8.1% → +0.3%) nhưng **skill score vẫn ≈ 0**: hiệu chuẩn chỉ sửa thang đo, không tạo ra tín hiệu. Không có tín hiệu để sửa thì con số % dù "đẹp" vẫn vô giá trị.
- Trong khi đó, mục đích thật của hệ thống — bắt các sự kiện lớn hiếm — là bài **phân loại vào danh sách đóng**, việc mà cả luật regex lẫn LLM yếu đều làm tốt: đo được **recall 7/7, báo giả 0/12** trên golden set.

Kết luận thiết kế: bỏ bài toán khó không giải được (ước lượng xác suất vùng giữa), giữ bài toán dễ giải đúng (phát hiện đuôi phân phối). Kênh chấm điểm bị xóa toàn bộ ở v3 (commit lịch sử vẫn giữ code cũ nếu cần khôi phục).

**Triết lý duy nhất còn lại: recall tuyệt đối.** Sự kiện thật ~1 lần/quý. Vài báo động giả mỗi tháng là chi phí rẻ; miss một sự kiện thật là mất toàn bộ lý do tồn tại của hệ thống. Mọi đánh đổi trong tài liệu này đều nghiêng theo hướng đó.

---

## 2. Vòng đời một bài đăng

```
fetch-posts.py (Python + curl_cffi giả lập Chrome, poll Truth Social mỗi 90–120s,
                backoff mũ 5→10→20→…60 phút khi bị 403)
        │
        ▼
PollingService.processPost(post)
        │
        ├─ Bước 0: bài đã xử lý rồi? → bỏ qua
        ├─ Bước 1: lấy giá BTC hiện tại (Binance → fallback CoinGecko)
        ├─ Bước 2: lưu PostRecord vào data/posts.json
        │          kèm 3 mốc kiểm giá checkAt1h / checkAt1d / checkAt7d
        │          cập nhật lastPostId NGAY (chống crash giữa chừng)
        │
        ├─ Bước 3: ★ DETECTOR ★
        │     gate → novelty → TRIPWIRE (mili-giây, 0 call)
        │     → nếu tripwire im lặng: LLM CHECKLIST (5 model song song, ~30s)
        │     → dedup
        │
        └─ Bước 4: gửi Telegram
              sự kiện lớp A  → 🚨🚨🚨 alert MỌI user, luôn có âm thanh
              bài thường     → 📋 tin feed im lặng (không âm thanh)

──── Cron nền ──────────────────────────────────────────────────────────
Mỗi 1 phút: ghi giá BTC thật tại mốc +1h / +1d / +7d cho các bài đến hạn
            (dữ liệu "điều gì đã xảy ra" hiển thị trong /check)
```

**Ngân sách API:** tối đa **500 call/ngày** (bộ đếm trong DetectorService — nơi duy nhất gọi LLM; reset 0:00; cảnh báo Telegram một lần khi vượt). Tiêu thụ: bài trúng tripwire hoặc bị gate chặn = **0 call**; bài thường = **5 call** (checklist). ~20–30 bài/ngày → thực tế ≤150 call/ngày. Khi hết hạn mức: tầng checklist tạm dừng nhưng **tripwire vẫn hoạt động** — các sự kiện rõ nhất vẫn được phát hiện.

---

## 3. Phân loại học sự kiện — 5 lớp A1–A5

Danh sách **đóng** các lớp sự kiện lịch sử đã chứng minh gây biến động mạnh (`src/detector/taxonomy.ts`):

| Lớp | Tên | Sự kiện thật minh họa |
|---|---|---|
| **A1** | Hành động crypto của chính phủ Mỹ | Crypto Strategic Reserve (02/03/2025 — BTC +8-10% trong vài giờ), ký GENIUS Act (18/07/2025) |
| **A2** | Hành động thương mại quy mô lớn | Liberation Day (02/04/2025 — BTC $87k→<$75k trong tuần), thuế 100% TQ (10/10/2025 — thanh lý crypto ~$19B), tạm dừng thuế 90 ngày (09/04/2025 — S&P +9.5%, BTC +8%) |
| **A3** | Sốc chính sách tiền tệ | Sa thải/thay chủ tịch Fed, hành động lên USD |
| **A4** | Hành động quân sự có Mỹ tham gia | Không kích cơ sở hạt nhân Iran (21/06/2025 — BTC xuống dưới $99k) |
| **A5** | Sốc hệ thống tài chính | Default nợ công, kiểm soát vốn |

Mỗi lớp có định nghĩa chặt dùng chung cho cả prompt LLM: **chỉ tính hành động đã tuyên bố / đã ký / có hiệu lực**; loại trừ quan điểm, lời dọa mơ hồ, khoe thành tích cũ. Định nghĩa A3 ghi rõ: *"Trump chỉ trích Powell gần như hàng tuần — chỉ tính khi có hành động hoặc tuyên bố sa thải cụ thể."*

Lưu ý về **tạm dừng/đảo ngược**: pause thuế cũng là sự kiện lớp A2 — sự kiện 09/04/2025 làm thị trường bùng nổ *chiều ngược lại*. Detector báo "sắp có biến động lớn", không hứa chiều.

---

## 4. Tầng 1 — Tripwire (bẫy luật)

12 rule compound viết cho **tiếng Anh** (Trump đăng tiếng Anh). Mỗi rule là mảng regex `allOf` — **tất cả phải khớp**, được phép khớp ở các câu khác nhau trong bài:

| Rule | Lớp | Logic compound |
|---|---|---|
| `A1_RESERVE_ACTION` | A1 | cụm "crypto/bitcoin/digital-asset + reserve/stockpile" **+** động từ hành động |
| `A1_CRYPTO_LAW_SIGNED` | A1 | "sign" + từ crypto/stablecoin/GENIUS + act/bill/law/executive-order |
| `A1_CRYPTO_BAN` | A1 | ngôi thứ nhất + "ban" + crypto **trong cùng một câu** (chặn "Biden wanted to ban crypto") |
| `A2_RECIPROCAL_TARIFFS` | A2 | "reciprocal tariffs" + động từ ký/áp/hiệu lực |
| `A2_PERCENT_TARIFF_MAJOR` | A2 | con số % + nền kinh tế lớn (China/EU/Mexico/Canada/Japan/India/Vietnam/Korea) + từ thuế + động từ hành động/hiệu lực |
| `A2_TARIFF_PAUSE` | A2 | "authorized a N-day pause" + tariff |
| `A2_ALL_COUNTRIES` | A2 | tariff + "all countries / throughout the world / nations near and far" + động từ hành động |
| `A3_FIRE_FED_CHAIR` | A3 | Powell/Fed-chair + fire/terminate/remove/replace/dismiss |
| `A4_STRIKE_COMPLETED` | A4 | completed/launched/carried-out/conducted + attack/strike/bombing |
| `A4_STRIKE_ON_SITES` | A4 | "attack/strike on" + nuclear/military/missile sites/facilities/bases |
| `A5_DEBT_DEFAULT` | A5 | "default on our/the debt" |
| `A5_CAPITAL_CONTROLS` | A5 | "capital controls" + động từ hành động |

Chi tiết thiết kế:

- **Danh sách động từ hành động** (`sign, executive order, authorize, direct, establish, create, launch, implement, impose, hereby, announce, order`) **cố tình không chứa** "doing"/"working" — để bài ca ngợi hành động cũ ("our Reserve is doing GREAT things") không kích hoạt.
- **Negation guard** trên từng rule: "will not / won't / never / ruled out / no plans to / cancelled / called off" khớp bất kỳ đâu → hủy rule. A4 thêm "exercise / drill" (tập trận ≠ tấn công).
- Chạy **đồng bộ, 0 API call, phản ứng trong mili-giây** — với sự kiện thật, từng phút đều có giá. Tripwire nổ → alert bắn ngay, **bỏ qua tầng LLM** (không cần chờ, không tốn call).
- Trên golden set, **toàn bộ 7 sự kiện thật đều bị tripwire bắt** — tầng LLM là lưới an toàn cho các cách diễn đạt mới mà pattern chưa lường.

---

## 5. Tầng 2 — LLM checklist đồng thuận

Chỉ chạy khi tripwire im lặng. Đây là lưới recall thứ hai — bắt các sự kiện lớp A được diễn đạt theo cách pattern chưa lường trước.

- **5 model free của OpenRouter, gọi song song, 1 call/model** (nemotron-nano-12b-vl, gpt-oss-20b, nemotron-3-super-120b, nemotron-3-nano-30b, gpt-oss-120b). Nhiệt độ **0.2** (phân loại cần ổn định), max 700 token, timeout 40 giây.
- Prompt yêu cầu **phân loại — không phải dự đoán giá** (đây là điểm mấu chốt: phân loại nhị phân/danh mục là việc LLM yếu vẫn làm ổn; ước lượng xác suất thì không — đã đo). JSON trả về, suy luận trước kết luận sau:

```json
{
  "reasoning":  "1-2 câu: bài tuyên bố gì, có phải hành động mới không",
  "eventClass": "A1" | "A2" | "A3" | "A4" | "A5" | "NONE",
  "confirmed":  true | false,
  "newAction":  true | false
}
```

  - `confirmed` = true **chỉ khi** bài tuyên bố hành động đã thực hiện / đã ký / có mốc thời gian cụ thể. Quan điểm, lời dọa mơ hồ, kêu gọi → false.
  - `newAction` = true **chỉ khi** là hành động **mới tại thời điểm đăng**. Nhắc lại / ca ngợi / cập nhật hành động đã công bố → false.

- **RAG-lite:** tối đa 8 bài trong 7 ngày gần nhất **giống bài mới nhất** (Jaccard, cắt 200 ký tự/bài) được đưa vào prompt, kèm chỉ dẫn *"nếu bài mới chỉ nhắc lại điều đã công bố trong các bài trên → newAction = false"*. Đây là hàng rào chặn loại báo giả phổ biến nhất: Trump ca ngợi lại hành động cũ bằng từ ngữ khác.
- **Luật đồng thuận: ≥ 2 phiếu cùng lớp với `confirmed=true` VÀ `newAction=true`.** Model chết / JSON hỏng bị loại êm; hết hạn mức ngày → bỏ qua model đó, không sập luồng chính.

Hiệu quả của hai hàng rào (đo trên golden set): decoy khó nhất — *ca ngợi Strategic Bitcoin Reserve đã công bố tuần trước* — cả 2 model nhận ra chủ đề A1, một model đánh dấu `confirmed`, nhưng **không model nào đánh dấu `newAction`** → chặn đúng. Decoy *dọa thuế có điều kiện* ("will not hesitate to impose...") — 2 model gắn A2 nhưng không `confirmed` → chặn đúng.

---

## 6. Tầng 3 — Novelty và dedup

**Novelty (tính mới)** — `src/detector/novelty.ts`: Jaccard trên tập token (bỏ URL, stopword tiếng Anh, từ <3 ký tự) giữa bài mới và **mọi bài trong 7 ngày gần nhất**. `maxSimilarity ≥ 0.5` → bài lặp → **không alert bất kể tripwire hay đồng thuận nói gì**. Lý do: bài làm thị trường rung chuyển hầu như luôn là bài **đầu tiên** công bố một hành động; các bài lặp lại sau đó thị trường đã định giá xong.

**Dedup theo lớp**: đã alert lớp X trong **24 giờ** và nội dung lần này đủ giống lần đó (Jaccard ≥ 0.35) → chặn. Hai sự kiện **thật khác nhau** cùng lớp trong 24h (nội dung khác hẳn) vẫn alert cả hai. Trạng thái dedup nằm trong memory — restart xoá, tệ nhất là một alert trùng sau restart (chấp nhận được: recall-first).

---

## 7. Luật quyết định và hành vi alert

```
ALERT ⟺ ( TRIPWIRE khớp   HOẶC   ĐỒNG THUẬN ≥2 phiếu confirmed+newAction )
        VÀ không phải bài lặp   (maxSimilarity < 0.5 so với 7 ngày)
        VÀ không trùng alert cùng lớp 24h (trừ khi nội dung khác hẳn)
```

Khi ALERT — gửi đến **tất cả user, luôn có âm thanh**:

```
🚨🚨🚨 SỰ KIỆN LỚP A2 🚨🚨🚨
Hành động thương mại quy mô lớn

📢 Bài viết: <nội dung>
🔍 Nguồn phát hiện: ⚡ bẫy luật (tức thì) | 🗳 đồng thuận N/M model
🧩 Pattern khớp: A2_RECIPROCAL_TARIFFS
⚠️ Kỳ vọng BTC biến động mạnh trong ~60 phút tới.
   HƯỚNG KHÔNG CHẮC CHẮN — cả tin "tốt" cho crypto cũng có thể làm giá GIẢM.
💰 Giá BTC lúc phát hiện · 🕐 thời điểm đăng · 🔗 link bài gốc
```

Bài không phải sự kiện lớp A → tin **feed im lặng** 📋 (nội dung + giá BTC + link, không âm thanh) để user vẫn theo dõi được dòng bài đăng. Mọi alert được ghi `data/alerts.log` (JSON per line) và kết quả detector persist vào `PostRecord.detection` để kiểm toán.

Cảnh báo **hướng không chắc chắn** là có chủ đích: cả hai sự kiện lớn nhất gần đây đều là "tin tốt cho crypto → giá giảm" (sell-the-news). Detector hứa "sắp có biến động lớn", không hứa chiều.

---

## 8. Theo dõi giá sau alert

Cron mỗi phút ghi giá BTC thật tại các mốc **+1h / +1d / +7d** sau mỗi bài (nguồn: Binance ticker, fallback CoinGecko). Lệnh `/check` hiển thị 10 bài alert gần nhất kèm 3 mốc giá và % thay đổi so với lúc đăng — trả lời câu hỏi "các alert trước đây có đáng tin không" bằng dữ liệu thật.

---

## 9. Đo lường — golden set

```
npm run detector:eval                  # đầy đủ: tripwire + LLM checklist (~5 call/case)
npm run detector:eval -- --rules-only  # chỉ tripwire + novelty, 0 API call, tức thì
```

Golden set (`src/eval/golden-set.ts`):

- **7 positives** — sự kiện thật dựng lại sát nguyên văn (Crypto Reserve, GENIUS Act, Liberation Day, tariff pause, thuế 100% TQ, không kích Iran, thuế Canada/Mexico). **Recall bắt buộc 100%** — miss là exit code fail.
- **2 borderline** — ca mập mờ thật (Powell "termination cannot come fast enough"; follow-up thêm BTC/ETH vào reserve). Bắt hay bỏ đều chấp nhận, chỉ báo cáo.
- **12 decoys** — bài "trông nguy hiểm" nhưng không phải hành động mới: than phiền Fed kiểu-hàng-tuần, hô hào crypto suông, khoe thành tích thuế, dọa có điều kiện, ca ngợi hành động cũ (kèm ngữ cảnh bài gốc), xã giao/thể thao/media. Đo tỉ lệ báo động giả.

**Kết quả hiện tại: recall 7/7 (toàn bộ qua tripwire, 0 call) · báo giả 0/12 · borderline: Powell→bắt (thị trường thật đã giảm hôm đó — defensible), follow-up reserve→bỏ.**

Khi thêm/sửa tripwire pattern: chạy `--rules-only` (tức thì) để kiểm tra không phá recall; chạy bản đầy đủ trước khi deploy.

---

## 10. Lệnh Telegram

| Lệnh | Chức năng |
|---|---|
| `/start` | Đăng ký nhận alert |
| `/detect <nội dung \| postId \| URL>` | Chạy detector thủ công — hiện tripwire khớp, phiếu từng model, độ mới |
| `/check` | 10 bài gần nhất đã kích hoạt alert, kèm giá BTC +1h/+1d/+7d và % thay đổi |
| `/btc` | Giá BTC hiện tại |
| `/credit` | Trạng thái API key OpenRouter + số call hôm nay / 500 |
| `/clear dd-mm-yyyy` | Xóa bài viết trước ngày |
| `/menu` | Danh sách lệnh |

Lưu ý: `/detect` thủ công **không ghi dedup** — để lần chạy thử không chặn alert thật ngay sau đó.

---

## 11. Bản đồ mã nguồn và dữ liệu

```
src/
├── detector/                      TRÁI TIM HỆ THỐNG
│   ├── taxonomy.ts                  5 lớp A1–A5, 12 tripwire compound, negation guard
│   ├── novelty.ts                   tokenize / Jaccard / assessNovelty / topSimilar
│   ├── gate.ts                      lọc heuristic 0-call (bài rỗng / URL / emoji thuần)
│   ├── openrouter.client.ts         HTTP client, phân loại lỗi, extractJson
│   ├── detector.service.ts          tripwire → checklist → đồng thuận → dedup
│   │                                + bộ đếm 500 call/ngày + /credit status
│   └── detector.module.ts
├── polling/polling.service.ts     orchestrator: poll 90–120s + detector + cron giá
├── telegram/telegram.service.ts   bot: detector alert + feed im lặng + lệnh + watchdog polling
├── truth-social/                  fetch bài qua fetch-posts.py (curl_cffi vượt Cloudflare)
├── btc-price/                     giá BTC (Binance → CoinGecko)
├── storage/storage.service.ts     persist data/posts.json
├── common/interfaces.ts           TruthSocialPost, PostRecord, DetectionResult
└── eval/
    ├── golden-set.ts                7 positives + 2 borderline + 12 decoys
    └── eval-detector.ts             npm run detector:eval [-- --rules-only]

data/  (không commit)
├── posts.json          mọi bài + kết quả detector + giá +1h/+1d/+7d
├── users.json          danh sách user Telegram
└── alerts.log          lịch sử alert đã gửi (audit)
```

Kênh chấm điểm cũ (`src/analysis/`, `src/calibration/`, `src/severity/`, `src/market-signal/`, backtest tooling) đã bị xóa ở v3 — có thể khôi phục từ lịch sử git (tag mốc: commit `63c363e` là bản cuối còn đủ hai kênh).

---

## 12. Giới hạn đã biết và việc tiếp theo

**Giới hạn:**

1. **Tripwire chỉ bắt được kiểu diễn đạt đã lường trước.** Sự kiện lớp A với cách diễn đạt hoàn toàn mới phải dựa vào tầng checklist — và tầng đó mù khi cả 5 model free cùng chết (đã xảy ra nhiều lần theo log server). Free tier OpenRouter là điểm yếu vận hành lớn nhất.
2. **Hướng biến động không đoán được** — by design, alert không hứa chiều.
3. **Dedup in-memory** — restart có thể gây một alert trùng.
4. **Golden set là bản dựng lại**, chưa phải nguyên văn 100% các bài thật.

**Việc tiếp theo, xếp theo đòn bẩy:**

1. **1 model trả phí rẻ làm backstop cho tầng checklist** (Haiku ~$1/tháng ở mức 5 call/bài thường) — loại bỏ điểm yếu free-tier-cùng-chết. Đòn bẩy lớn nhất còn lại.
2. **Mở rộng golden set bằng nguyên văn thật** khi có archive Truth Social, thêm các sự kiện mới khi chúng xảy ra — golden set là hàng rào hồi quy duy nhất của hệ thống.
3. **Bổ sung tripwire khi xuất hiện lớp sự kiện mới** (quy trình: thêm case vào golden set trước → viết pattern → `--rules-only` xác nhận recall + không thêm báo giả).
4. Cân nhắc alert "lớp B" (mức chú ý, không âm thanh) cho các bài checklist đạt 1 phiếu — hiện đang bỏ qua hoàn toàn.

**Quyết định thiết kế dễ gây thắc mắc (đọc trước khi "sửa"):**

- Detector **không có con số %** — cố ý. Hệ thống từng có và số liệu chứng minh nó vô giá trị (§1).
- Bài lặp lại chủ đề không alert dù khớp pattern — cố ý (thị trường đã định giá bài đầu tiên).
- `/detect` không ghi dedup — cố ý (lần chạy thử không được chặn alert thật).
- Tripwire nổ thì bỏ qua LLM — cố ý (nhanh hơn, rẻ hơn, và tripwire chính xác hơn ở các ca nó bắt được).

---

## 13. Lịch sử phiên bản

| Phiên bản | Nội dung | Kết quả đo được |
|---|---|---|
| **v1** | 1 call LLM/bài, con số % thô gửi thẳng Telegram; hard-rule 88% | AUC 0.529, bias +8.1%, skill −0.378 → vô giá trị |
| **v2** (`10187bd`) | Chấm điểm hiệu chuẩn: sự kiện đích \|z\|≥2, prompt thang neo, ensemble, isotonic, vòng lặp đóng | Hiệu chuẩn hoạt động (bias→+0.3%) nhưng không tạo ra tín hiệu |
| **v2.1** (`63c363e`) | Thêm detector sự kiện lớp A chạy song song kênh chấm điểm | Recall 7/7, báo giả 0/12 trên golden set |
| **v3** (hiện tại) | **Xóa toàn bộ kênh chấm điểm** — detector là trái tim duy nhất; bài thường thành tin feed im lặng | Golden set giữ nguyên 7/7, 0/12 sau phẫu thuật |
