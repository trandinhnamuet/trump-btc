import { MarketContextResult } from '../market-signal/market-signal.service';
import { Z_THRESHOLD } from '../calibration/types';

/**
 * Prompt v2 — không hỏi model xác suất, hỏi model bằng chứng và thứ hạng.
 *
 * Ba thay đổi cốt lõi so với v1:
 *
 * 1. `reasoning` là trường ĐẦU TIÊN trong JSON. LLM sinh token tuần tự, nên ở v1
 *    (số đứng trước lý do) model buộc phải chốt con số rồi mới viết lý lẽ biện
 *    minh cho nó. Giờ nó phải suy luận trước, kết luận sau.
 *
 * 2. Thay câu hỏi "bao nhiêu %" bằng SO SÁNH với một thang neo cố định. Phán đoán
 *    so sánh bất biến với độ lệch thang đo: một model quen chấm cao vẫn sẽ nói
 *    đúng rằng "bài này yếu hơn cái neo về thuế quan". Đây là thứ triệt tiêu bias
 *    "model A luôn cao, model B luôn thấp" ngay tại nguồn.
 *
 * 3. Nêu thẳng base rate. Không có nó, model rải điểm quanh khoảng giữa thang 0-100
 *    vì thang đo "trông như" phải được dùng hết.
 *
 * Con số xác suất cuối cùng KHÔNG do model sinh ra. Nó do tầng hiệu chuẩn tính từ
 * tần suất thực nghiệm (xem calibration.service.ts).
 */

export const PROMPT_VERSION = 'v2.0';

/** Bài neo, sắp xếp từ ít tác động nhất tới nhiều tác động nhất. */
export interface Anchor {
  id: string;
  text: string;
  why: string;
}

/**
 * Thang neo bootstrap. Thứ tự phản ánh mức tác động kỳ vọng lên BTC trong 1 giờ.
 *
 * TODO: thay bằng bài THẬT đã đo được |z| sau khi `npm run dataset:build` có đủ
 * dữ liệu — khi đó thứ hạng của thang neo là quan sát thực nghiệm chứ không còn
 * là giả định của người thiết kế.
 */
export const ANCHORS: Anchor[] = [
  {
    id: 'A0',
    text: 'Chúc mừng sinh nhật một thượng nghị sĩ, kèm lời khen ngợi.',
    why: 'thuần xã giao, không có thông tin kinh tế',
  },
  {
    id: 'A1',
    text: 'MAGA! Nước Mỹ đang thắng lớn chưa từng thấy!',
    why: 'khẩu hiệu, không có thông tin mới',
  },
  {
    id: 'A2',
    text: 'Truyền thông giả mạo lại bịa đặt về tôi. Thảm hại!',
    why: 'công kích cá nhân, không liên quan thị trường',
  },
  {
    id: 'A3',
    text: 'Tuần tới tôi sẽ gặp Chủ tịch Fed để bàn về lãi suất.',
    why: 'chạm chủ đề vĩ mô nhưng không cam kết hành động cụ thể',
  },
  {
    id: 'A4',
    text: 'Tôi vừa ký sắc lệnh áp thuế 25% lên toàn bộ hàng nhập khẩu từ Trung Quốc, hiệu lực từ thứ Hai.',
    why: 'hành động vĩ mô đã xác nhận, có con số và mốc thời gian cụ thể',
  },
  {
    id: 'A5',
    text: 'Hoa Kỳ chính thức thành lập Quỹ Dự trữ Bitcoin Chiến lược. Việc mua vào bắt đầu ngay hôm nay.',
    why: 'hành động đã xác nhận, tác động trực tiếp và tức thì lên chính BTC',
  },
];

/** Định nghĩa các bậc tác động. Rời rạc, có mô tả — không phải thang 0-100 tự do. */
const BUCKET_RUBRIC = `0 = Không liên quan thị trường. Xã giao, thể thao, công kích cá nhân, khoe thành tích.
1 = Chạm chủ đề kinh tế/chính trị nhưng chỉ là quan điểm, không có thông tin mới.
2 = Nhắc lại một lập trường đã biết về vĩ mô (thuế, Fed, thương mại). Thị trường đã định giá xong.
3 = Thông tin mới, có thể ảnh hưởng vĩ mô, nhưng mơ hồ về thời điểm hoặc quy mô.
4 = Hành động cụ thể, đã xác nhận, có con số hoặc mốc thời gian, tác động vĩ mô rõ ràng.
5 = Hành động cụ thể, tức thì, tác động trực tiếp lên crypto hoặc gây sốc hệ thống tài chính.`;

export interface ModelJudgment {
  reasoning: string;
  summary: string;
  /** Chủ đề, nhãn đa lớp */
  topics: string[];
  /** Bài này có cam kết một hành động cụ thể, thi hành được không? */
  actionable: boolean;
  /** Thông tin mới, hay nhắc lại điều đã biết? */
  novel: boolean;
  /** Với mỗi neo: true nếu bài mới có khả năng làm BTC biến động MẠNH HƠN neo đó */
  beatsAnchor: boolean[];
  /** Bậc tác động 0-5 theo rubric */
  bucket: number;
  direction: 'increase' | 'decrease' | 'neutral';
  /** Model tự tin đến đâu về HƯỚNG, [0,1]. 0.5 = tung đồng xu. */
  directionConfidence: number;
}

export function buildAnalysisPrompt(
  content: string,
  market: MarketContextResult,
  baseRate: number,
  hasImages = false,
): string {
  const contentSection =
    hasImages && !content.trim() ? '[Bài đăng chỉ có hình ảnh, không có văn bản]' : content;

  const marketCtx =
    `BTC: $${market.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}` +
    ` | 24h ${market.change24h >= 0 ? '+' : ''}${market.change24h.toFixed(2)}%` +
    ` | 7d ${market.change7d >= 0 ? '+' : ''}${market.change7d.toFixed(2)}%` +
    ` | 30d ${market.change30d >= 0 ? '+' : ''}${market.change30d.toFixed(2)}%` +
    ` | cách đỉnh 52w ${market.pctFromHigh52w.toFixed(1)}%` +
    ` | xu hướng: ${market.trendLabel}`;

  const anchorList = ANCHORS.map((a, i) => `  [${i}] "${a.text}"  (${a.why})`).join('\n');
  const basePct = (baseRate * 100).toFixed(1);

  return `# Nhiệm vụ

Dưới đây là một bài Trump vừa đăng trên Truth Social. Hãy đánh giá khả năng bài này
làm giá BTC biến động bất thường trong 60 phút tiếp theo.

"Biến động bất thường" được định nghĩa chính xác: mức thay đổi giá 1 giờ vượt ${Z_THRESHOLD}
lần độ biến động thông thường của BTC ở thời điểm đó.

# Bài viết cần đánh giá

${contentSection}

# Bối cảnh thị trường

${marketCtx}

# Sự thật nền quan trọng

Trong lịch sử, chỉ khoảng ${basePct}% số bài Trump đăng đi kèm một biến động bất thường
như vậy. Tuyệt đại đa số bài KHÔNG làm thị trường nhúc nhích. Đừng cho rằng vì bài
này quan trọng về mặt chính trị thì nó sẽ làm BTC di chuyển. Hai chuyện đó khác nhau.

# Thang neo

So sánh bài trên với từng bài neo dưới đây (đã sắp từ ít tác động nhất đến nhiều nhất):

${anchorList}

Với MỖI neo, trả lời: bài cần đánh giá có khả năng làm BTC biến động mạnh hơn neo đó không?

# Bậc tác động

${BUCKET_RUBRIC}

# Định dạng trả lời

Chỉ trả về JSON hợp lệ, không kèm bất kỳ văn bản nào khác.
Viết "reasoning" và "summary" bằng TIẾNG VIỆT.
Suy luận TRƯỚC, kết luận SAU — thứ tự các trường dưới đây là bắt buộc.

{
  "reasoning": "Phân tích bản chất sự việc và cơ chế truyền dẫn tới giá BTC, 50-70 từ. Nêu rõ vì sao nó mạnh/yếu hơn các neo.",
  "summary": "Tóm tắt nội dung bài viết, 30-40 từ.",
  "topics": ["chọn từ: monetary_policy, tariffs, crypto_policy, geopolitics_kinetic, geopolitics_rhetoric, domestic_politics, personal_attack, self_promo, other"],
  "actionable": <true nếu bài cam kết một hành động cụ thể, thi hành được, có mốc thời gian>,
  "novel": <true nếu đây là thông tin mới, false nếu nhắc lại lập trường đã biết>,
  "beatsAnchor": [<6 giá trị true/false, theo đúng thứ tự neo [0]..[5]>],
  "bucket": <số nguyên 0-5 theo rubric>,
  "direction": <"increase" | "decrease" | "neutral">,
  "directionConfidence": <số thực 0.5-1.0; dùng 0.5 khi bạn thực sự không biết>
}`;
}

const VALID_DIRECTIONS = new Set(['increase', 'decrease', 'neutral']);

/** Parse chặt chẽ. Trả về null khi thiếu trường bắt buộc — bên gọi phải coi là lỗi, không im lặng cho 0. */
export function parseJudgment(parsed: any): ModelJudgment | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const bucket = coerceNumber(parsed.bucket);
  if (bucket === null || bucket < 0 || bucket > 5) return null;

  const beats = Array.isArray(parsed.beatsAnchor) ? parsed.beatsAnchor.map(Boolean) : null;
  if (!beats || beats.length !== ANCHORS.length) return null;

  const direction = String(parsed.direction ?? '').toLowerCase().trim();
  const conf = coerceNumber(parsed.directionConfidence);

  return {
    reasoning: String(parsed.reasoning ?? ''),
    summary: String(parsed.summary ?? ''),
    topics: Array.isArray(parsed.topics) ? parsed.topics.map(String) : [],
    actionable: Boolean(parsed.actionable),
    novel: Boolean(parsed.novel),
    beatsAnchor: beats,
    bucket: Math.round(bucket),
    direction: VALID_DIRECTIONS.has(direction) ? (direction as ModelJudgment['direction']) : 'neutral',
    directionConfidence: conf === null ? 0.5 : Math.min(1, Math.max(0.5, conf)),
  };
}

/**
 * Ép về số một cách an toàn.
 *
 * `Number("85%")` là NaN, và `NaN || 0` cho ra 0 — ở v1 điều này biến một dự đoán
 * 85% thành 0% mà không một dòng log nào. Ở đây ta bóc ký tự thừa rồi trả về null
 * khi thất bại, để bên gọi xử lý như một lỗi parse thật sự.
 */
export function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  const m = v.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Điểm thô [0,1] từ một phán đoán.
 *
 * Trọng số dồn vào `anchorRank` vì đó là thành phần duy nhất bất biến với thang đo
 * riêng của từng model. `bucket` chỉ dùng để phá thế hòa (thang neo 6 bậc chỉ cho 7
 * giá trị rời rạc). `severity` là bằng chứng từ luật, không còn là override 88%.
 */
export function rawScoreOf(j: ModelJudgment, severityScore: number): number {
  const anchorRank = j.beatsAnchor.filter(Boolean).length / ANCHORS.length;
  const bucketNorm = j.bucket / 5;
  return 0.65 * anchorRank + 0.2 * bucketNorm + 0.15 * Math.min(1, Math.max(0, severityScore));
}
