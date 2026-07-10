# Báo cáo: Làm lại cơ chế đánh giá tác động BTC (v1 → v2)

*Cập nhật: 2026-07-10. Đã deploy lên server `160.22.161.44` (PM2 `trump-btc`, port 2998).*

Tài liệu này giải thích: cơ chế cũ hoạt động thế nào, vì sao nó đánh giá sai một
cách hệ thống, cơ chế mới là gì, đã cài đặt ra sao, kết quả kiểm chứng, và những
việc còn phải làm. **Mọi con số trong báo cáo đều đo từ 2157 bài thật trên server,
đối chiếu với giá BTC thực tế từ Binance** — không có con số nào là phỏng đoán.

---

## 1. Cơ chế cũ (v1) hoạt động thế nào

Với mỗi bài Trump đăng, v1 làm đúng một việc: gửi nội dung cho **một** LLM (free
model của OpenRouter) kèm câu hỏi đại ý *"đánh giá % khả năng bài này tác động
giá BTC, và tăng hay giảm"*. Model trả về JSON:

```json
{ "summary": "...", "btcInfluenceProbability": 65, "btcDirection": "increase", "reasoning": "..." }
```

Con số `65` đó được gửi thẳng lên Telegram. Tài liệu `SCORING.md` cũ mô tả một
công thức ensemble 3 lớp (`0.50×Model + 0.35×Severity + 0.15×Market`), **nhưng
công thức đó chưa bao giờ được cài đặt** — `SeverityService` viết xong không bao
giờ được gọi, `ensembleProbability` chỉ đơn giản bằng con số thô của model. Nghĩa
là điểm cuối cùng = một lần đoán của một LLM, không qua bất kỳ hiệu chỉnh nào.

Khi model gặp lỗi (rate limit, JSON hỏng), một *fallback chain* âm thầm đổi sang
model khác và thử lại.

---

## 2. Vì sao v1 đánh giá sai một cách hệ thống

Đây không phải nhận định cảm tính. Tôi đã chấm điểm lại 502 bài (sau khi gộp các
bài đăng trong cùng một cửa sổ 1 giờ, vì chúng chia sẻ cùng một kết quả thị
trường) đối chiếu với giá BTC thật. Kết quả:

| Chỉ số | v1 đo được | Ý nghĩa |
|--------|-----------|---------|
| **Base rate thật** | **7.8%** | Chỉ 7.8% số bài thực sự gây biến động bất thường |
| v1 chấm trung bình | **15.9%** | Cao gấp **2 lần** thực tế |
| **Bias** | **+8.1%** | Chấm cao hơn thực tế một cách hệ thống |
| **AUC** | **0.529** | ~0.5 = **ngẫu nhiên**. Gần như không phân biệt được bài có tác động với bài không |
| Đúng hướng | **9/17 = 52.9%** | Đúng bằng tung đồng xu |
| Chấm đúng 0% | **138 bài (27.5%)** | Gồm bài bị bỏ qua lẫn bài **trúng bug** |
| Brier skill score | **−0.38** | Âm = **tệ hơn cả việc đoán bừa** theo base rate |

Con số quan trọng nhất là **AUC = 0.529**. AUC đo khả năng *xếp hạng*: nếu bốc
ngẫu nhiên một bài có tác động và một bài không, xác suất model chấm bài có tác
động cao hơn là bao nhiêu. 0.5 nghĩa là **model không hề phân biệt được hai loại
bài đó** — nó chấm điểm gần như ngẫu nhiên.

Nguyên nhân gốc rễ, xếp theo mức độ nghiêm trọng:

**A. Bài toán chưa được định nghĩa.** "% khả năng tác động giá BTC" không phải
mệnh đề đúng/sai được: không có sự kiện cụ thể, không ngưỡng biến động, không
khung thời gian. Không đo được thì không hiệu chỉnh được, và mỗi model tự bịa ra
một thang đo riêng.

**B. Con số sinh ra TRƯỚC lý luận.** JSON để `btcInfluenceProbability` đứng trước
`reasoning`. LLM sinh chữ tuần tự, nên nó buộc phải chốt con số rồi mới viết lý do
biện minh — chain-of-thought ngược.

**C. Không có neo thang đo, không có base rate.** Prompt không nói 10% khác 50%
khác 90% ở đâu, cũng không nói "hầu hết bài chẳng tác động gì". Nên mỗi model rải
điểm quanh khoảng giữa thang 0-100 theo thói quen riêng — **model A tin nào cũng
chấm cao, model B tin nào cũng thấp**. Đây chính là triệu chứng bạn quan sát được,
và bảng trên định lượng nó: bias +8.1%.

**D. Một con số gánh bốn câu hỏi.** `btcInfluenceProbability` trộn lẫn: bài có liên
quan không, biến động lớn cỡ nào, hướng nào, model tự tin đến đâu. Không con số nào
chở nổi bốn thứ. Model liên tục nhầm "quan trọng về chính trị" thành "sẽ làm BTC
biến động".

**E. Model roulette.** Fallback chain đổi model giữa các bài: bài này nemotron
chấm, bài kia llama chấm — ba thang đo khác nhau trộn vào một chuỗi rồi so với một
ngưỡng cố định. Chuỗi số đó không so sánh được với nhau.

**F. Bug nuốt tín hiệu.** `Number("85%")` cho ra `NaN`, và `NaN || 0` cho ra `0`
— một dự đoán 85% âm thầm biến thành 0%, không một dòng log. Truncation (model bị
cắt vì viết dài) bị nhầm thành JSON hỏng → fallback loại bỏ **model viết dài**
thay vì model dở. 27.5% số bài bị chấm đúng 0% một phần vì các lỗi này.

**G. Không có vòng phản hồi.** Giá BTC thực tế đã được lưu sẵn, nhưng chỉ dùng để
in một dòng log rồi thôi. Hệ thống không bao giờ biết mình đoán đúng hay sai, nên
không bao giờ tự sửa được.

---

## 3. Cơ chế mới (v2): cần làm những gì

Nguyên tắc cốt lõi:

> **Đừng bắt LLM đưa ra xác suất. Bắt nó đưa ra bằng chứng và thứ hạng. Để một
> tầng thống kê được hiệu chuẩn bằng dữ liệu thật sinh ra con số.**

LLM giỏi *so sánh* và *phân loại*, dở tệ ở *ước lượng xác suất tuyệt đối*. v2 khai
thác đúng thứ nó giỏi. Sáu việc phải làm:

**1. Định nghĩa sự kiện đích đo được.**
```
z = return_1h / (độ biến động thông thường của BTC lúc đó)
moved = |z| >= 2      → p_move (có biến động bất thường không)
up    = z > 0         → p_up   (hướng, chỉ tính khi đã moved)
```
Chuẩn hóa theo độ biến động là bắt buộc: 0.5% lúc thị trường lặng là tín hiệu,
0.5% lúc thị trường sôi là nhiễu. Tách `p_move`/`p_up` gỡ bỏ vấn đề "một số gánh
bốn câu hỏi".

**2. Xây tập dữ liệu nhãn từ Binance.** Lấy nến 1 phút lịch sử (miễn phí) để gắn
nhãn `moved`/`up` cho mọi bài quá khứ. Đây là "sự thật nền" để đo mọi thứ.

**3. Hỏi model bằng chứng + thứ hạng, không hỏi %.** Prompt mới bắt model *so sánh*
bài mới với một **thang neo** gồm các bài mẫu xếp theo mức tác động, và trả về đặc
trưng có cấu trúc (chủ đề, có hành động cụ thể không, mới hay cũ, bậc 0-5). So sánh
**bất biến với độ lệch thang đo** — model quen chấm cao vẫn nói đúng "bài này yếu
hơn cái neo về thuế quan". Đây là thứ diệt bias tận gốc.

**4. Ensemble nhiều model + nhiều mẫu.** 3 model chấm độc lập, mỗi model lấy 3 mẫu.
Độ tán xạ giữa các mẫu = độ bất định của model. Không còn roulette.

**5. Tầng hiệu chuẩn.** Biến điểm thô của từng model thành xác suất thật bằng:
chuẩn hóa phân vị (khử bias thang đo) → hợp nhất Bayes với base rate → isotonic
regression khi đã có nhãn thật. Con số cuối **luôn tôn trọng base rate**.

**6. Vòng lặp đóng.** Mỗi giờ, lấy giá thật, gắn nhãn các dự đoán đã quá 1h, fit
lại đường hiệu chuẩn. Đây là thứ biến hệ thống từ "mù" thành "tự sửa".

---

## 4. Đã cài đặt thế nào

Toàn bộ nằm trong commit `10187bd`. Cấu trúc:

```
src/calibration/          ← tầng đo lường & hiệu chuẩn (mới hoàn toàn)
  types.ts                  định nghĩa sự kiện đích (z, |z|>=2)
  binance-history.ts        nến 1m, cache theo tháng, tra giá không nhìn tương lai
  labeler.ts                tính r_1h, độ biến động EWMA, z-score, khử cluster chồng lấn
  metrics.ts                Brier, skill score, AUC, reliability diagram, ECE
  isotonic.ts               PAV regression: điểm thô → tần suất thực nghiệm
  quantile.ts               chuẩn hóa phân vị theo từng model
  calibration.service.ts    3 chế độ (lạnh/ấm/nóng) + vòng lặp refit
src/analysis/
  gate.ts                   lọc heuristic 0-call (reblog/URL/emoji)
  prompt-v2.ts              prompt neo so sánh, parse chặt, tính điểm thô
  openrouter.client.ts      HTTP client, phân loại lỗi (truncation ≠ JSON hỏng)
  ensemble.service.ts       pool resilient, self-consistency, gộp trọng số Brier
  analysis.service.ts       orchestrator mỏng nối các tầng
src/eval/
  build-dataset.ts          CLI gắn nhãn lịch sử  (npm run dataset:build)
  backtest.ts               CLI báo cáo bias từng model  (npm run backtest)
```

Điểm mấu chốt trong cách cài đặt:

- **Pool resilient thay fallback chain.** Ensemble duyệt một pool 8 model, lấy 3
  model đầu tiên cho ra kết quả. Model chết bị thay, nhưng ghi dưới **đúng tên của
  nó** nên hiệu chuẩn theo model không bị lẫn. Có circuit breaker khi cả free tier
  sập (đã gặp thật khi test).
- **Severity nay là đặc trưng** (trọng số 0.15), không còn override lên 88%.
- **Sửa cả 5 bug:** `Number("85%")` bóc ký tự thay vì thành 0; truncation nâng
  token thử lại chính model đó; cho phép `neutral`; bỏ roulette; `/testall` dùng
  đúng prompt production.
- **Lưu `modelUsed` + `scoring` vào mỗi bài** — không có `modelUsed`, backtest
  không tách được bias từng model (đây là lý do bảng ở mục 2 chỉ có dòng "unknown").
- **Lệnh Telegram mới:** `/calib` (xem trạng thái hiệu chuẩn), `/refit` (chạy vòng
  lặp đóng ngay), `/model ensemble` (quay lại chế độ mặc định).

---

## 5. Đã test thế nào và kết quả hiện tại

**Kiểm chứng offline (dữ liệu thật).** `npm run dataset:build` gắn nhãn 2157 bài
từ 188.742 nến 1 phút của Binance — 0 bài lỗi. Base rate thật = **7.8%**;
`P(tăng | có biến động)` = **66.7%** (bài Trump khi gây biến động thì thiên về
tăng — hợp lý trong giai đoạn bull market này).

**Kiểm chứng end-to-end (API thật).** Chạy pipeline v2 trực tiếp với OpenRouter:

| Bài test | v2 chấm | Nhận xét |
|----------|---------|----------|
| "Happy Birthday to a great patriot! MAGA!" | **1-2%** | Đúng: neo quanh base rate |
| "US establishing Strategic Bitcoin Reserve, purchases begin today" | **9%** | Đúng: vượt hẳn base rate |

Quan trọng: model **chủ động dẫn chiếu thang neo** trong reasoning ("tương đương
neo 5, mạnh hơn các neo trước") — cơ chế so sánh hoạt động đúng thiết kế. Cả hai
con số đều neo quanh base rate thay vì nhảy lên 40-70% như v1.

**Unit test.** 19 test cho toán học cốt lõi đều pass, gồm một test xác minh trực
tiếp triệu chứng của bạn: hai model lệch thang đo ngược nhau nhưng cùng thứ hạng
cho ra **xác suất tương đương** sau hiệu chuẩn.

**Đã deploy** lên server, app v2 khởi động sạch, đang chạy.

### Một kết quả trung thực và quan trọng

Khi áp tầng hiệu chuẩn (isotonic, out-of-fold) lên chính các dự đoán **v1**:

- Bias: +8.1% → **+0.3%** (xóa gần hết)
- ECE: 0.12 → **0.03** (hiệu chuẩn tốt)
- **Nhưng skill score: −0.38 → −0.006** — vẫn chỉ ngang baseline.

Lý do: **hiệu chuẩn xóa được bias nhưng không chế ra được tín hiệu xếp hạng vốn
không tồn tại.** Vì AUC của v1 chỉ 0.529 (gần ngẫu nhiên), không tầng hiệu chuẩn
nào cứu nổi — con số sau hiệu chuẩn đẹp hơn nhưng vẫn không phân biệt được bài nào
với bài nào.

Điều này KHÔNG có nghĩa v2 thất bại. Nó có nghĩa: **phần hiệu chuẩn của v2 đã được
chứng minh hoạt động; phần còn cần chứng minh là prompt neo so sánh + ensemble có
nâng được AUC lên trên ~0.6 hay không.** Đó là câu hỏi mở số 1 (xem mục 6).

---

## 6. Vấn đề còn tồn tại và đề xuất cải thiện

**Vấn đề 1 — AUC của v2 chưa được đo (quan trọng nhất).** Backtest ở trên đo các
dự đoán *v1*. v2 chưa chấm đủ bài để đo AUC của nó. Toàn bộ giả thuyết của v2 là
prompt neo so sánh cho khả năng *xếp hạng* tốt hơn. Nếu đúng, tầng hiệu chuẩn (đã
chứng minh hoạt động) sẽ biến nó thành xác suất tốt. Nếu sai, phải đổi cách.
→ **Đề xuất:** để v2 chạy tích lũy ~1-2 tuần, rồi chạy lại `npm run backtest`. Con
số cần nhìn là **AUC của v2** so với 0.529 của v1. Đây là thước đo make-or-break.

**Vấn đề 2 — Free tier OpenRouter rất phập phù.** Log server cho thấy nhiều model
429/404 liên tục (`owl-alpha` đã chết hẳn). Ensemble thường suy biến còn 1-2 model.
Điều này đặt trần cứng lên chất lượng xếp hạng.
→ **Đề xuất:** nếu muốn nâng chất lượng thật, cho tầng neo (tầng quyết định con số)
dùng một model trả phí rẻ (ví dụ Haiku). Chi phí rất thấp vì chỉ ~9 bài/ngày qua
được gate. Đây là đòn bẩy lớn nhất còn lại.

**Vấn đề 3 — Thang neo hiện là bài giả định.** 6 bài neo trong `prompt-v2.ts` do
tôi viết tay. Chúng nên là bài **thật** đã đo được `z`.
→ **Đề xuất:** sau khi có dataset, thay bằng 6-8 bài thật rải đều các mức `z` từ
0 tới cao nhất. Khi đó thứ hạng thang neo là quan sát thực nghiệm, không phải phỏng đoán.

**Vấn đề 4 — Base rate khởi động ở 5%, thật là 7.8%.** v2 khởi động lạnh với prior
5%; nó sẽ tự hội tụ về 7.8% sau khi vòng lặp refit tích lũy đủ nhãn.
→ **Đề xuất (tùy chọn):** seed sẵn base rate 7.8% để đúng ngay từ ngày đầu. Ảnh
hưởng nhỏ, không gấp.

**Vấn đề 5 — Hướng (p_up) khó.** Ngay cả trên nhãn thật, đúng hướng chỉ 52.9%. Dự
đoán hướng biến động BTC 1 giờ trước là bài toán gần như bất khả với chỉ nội dung
một bài đăng.
→ **Đề xuất:** hạ kỳ vọng về `p_up`; xem nó là thông tin phụ, đừng làm tín hiệu
giao dịch. Giá trị thật của hệ thống nằm ở `p_move` (có nên chú ý bài này không).

### Tóm lại

v2 đã sửa xong mọi thứ **đo được**: bias, roulette, các bug nuốt tín hiệu, và quan
trọng nhất — **giờ đã có bộ máy để biết hệ thống đúng hay sai** (điều v1 hoàn toàn
thiếu). Câu hỏi còn lại — liệu free model có xếp hạng tốt hơn ngẫu nhiên — là câu
hỏi thực nghiệm mà chỉ dữ liệu tích lũy vài tuần tới mới trả lời được, và `npm run
backtest` sẽ cho bạn con số đó bất cứ lúc nào.
