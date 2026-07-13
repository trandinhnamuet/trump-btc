/**
 * Phân loại học sự kiện lớp A — các sự kiện hiếm (~0.1% số bài) nhưng gần như
 * chắc chắn gây biến động mạnh giá BTC, kèm bẫy dây (tripwire) phát hiện tức thì.
 *
 * Triết lý khác hẳn pipeline chấm điểm:
 * - Đây là bài PHÂN LOẠI vào một danh sách đóng, không phải ước lượng xác suất.
 * - Ưu tiên RECALL tuyệt đối: miss một sự kiện thật là mất lý do tồn tại của hệ
 *   thống; vài báo động giả mỗi tháng là chấp nhận được.
 * - Tripwire là các pattern compound độ chính xác cao, chạy đồng bộ, 0 API call
 *   — phản ứng trong mili-giây vì với sự kiện thật, từng phút đều có giá.
 *
 * Bài học từ v1: hard-rule 88% của SeverityService chính là ý tưởng này ở dạng
 * thô. Sai lầm không phải là CÓ tripwire, mà là bắt nó nhả ra một con số giả vờ
 * đã hiệu chuẩn. Ở đây tripwire bắn ra ALERT rời rạc, tách hẳn khỏi thang %.
 *
 * Pattern viết cho TIẾNG ANH vì Trump đăng bằng tiếng Anh.
 */

export type EventClass = 'A1' | 'A2' | 'A3' | 'A4' | 'A5';

export interface EventClassInfo {
  /** tên hiển thị tiếng Việt */
  vi: string;
  /** mô tả đưa vào prompt phân loại — định nghĩa chặt, kèm ví dụ */
  prompt: string;
}

export const EVENT_CLASSES: Record<EventClass, EventClassInfo> = {
  A1: {
    vi: 'Hành động crypto của chính phủ Mỹ',
    prompt:
      'Chính phủ Mỹ HÀNH ĐỘNG trực tiếp lên crypto: ký sắc lệnh/luật lập reserve hoặc ' +
      'stockpile (BTC/ETH/XRP...), ký luật crypto/stablecoin, cấm hoặc hợp pháp hóa, ' +
      'phê duyệt/từ chối ETF. VD: "directed the Working Group to move forward on a ' +
      'Crypto Strategic Reserve", "signed the GENIUS Act into Law".',
  },
  A2: {
    vi: 'Hành động thương mại quy mô lớn',
    prompt:
      'Hành động thuế quan/thương mại quy mô toàn cầu hoặc nhắm vào nền kinh tế lớn ' +
      '(Trung Quốc, EU, Mexico, Canada...): áp/ký/nâng thuế với con số cụ thể, thuế ' +
      'đối ứng lên tất cả các nước, hoặc TẠM DỪNG thuế đã áp (pause cũng làm thị ' +
      'trường biến động mạnh). VD: "raising the Tariff charged to China to 125%, ' +
      'effective immediately", "authorized a 90 Day PAUSE".',
  },
  A3: {
    vi: 'Sốc chính sách tiền tệ',
    prompt:
      'Hành động lên Fed hoặc đồng USD: sa thải/thay thế chủ tịch Fed, can thiệp trực ' +
      'tiếp vào chính sách tiền tệ, hành động lên giá trị đồng USD. Lưu ý: Trump CHỈ ' +
      'TRÍCH Powell gần như hàng tuần — chỉ tính khi có hành động hoặc tuyên bố sa ' +
      'thải cụ thể, không tính than phiền về lãi suất.',
  },
  A4: {
    vi: 'Hành động quân sự có Mỹ tham gia',
    prompt:
      'Mỹ trực tiếp tấn công quân sự hoặc tuyên bố đã hoàn thành tấn công: không kích, ' +
      'tấn công cơ sở hạt nhân/quân sự, tuyên chiến. VD: "We have completed our very ' +
      'successful attack on the three Nuclear sites in Iran". KHÔNG tính lời đe dọa ' +
      'mơ hồ hoặc bình luận về xung đột của nước khác.',
  },
  A5: {
    vi: 'Sốc hệ thống tài chính',
    prompt:
      'Hành động gây sốc hệ thống tài chính: tuyên bố default nợ công, kiểm soát vốn, ' +
      'đóng băng tài sản quy mô lớn, rút khỏi hệ thống tài chính quốc tế.',
  },
};

/**
 * Động từ hành động — phân biệt "đã làm/đang ký" với "bàn về/khoe thành tích cũ".
 * Cố tình KHÔNG chứa các từ như "doing", "working" — bài ca ngợi hành động cũ
 * ("our Reserve is doing GREAT things") không được phép kích hoạt tripwire.
 */
const ACTION = /\b(?:sign(?:ed|ing)?|executive\s+order|authoriz(?:e[sd]?|ing)|direct(?:ed|ing)?|establish(?:ed|ing)?|creat(?:e[sd]?|ing)|launch(?:ed|ing)?|implement(?:ed|ing)?|impos(?:e[sd]?|ing)|hereby|announc(?:e[sd]?|ing)|order(?:ed|ing)\b)/i;

export interface TripwireRule {
  id: string;
  cls: EventClass;
  /** TẤT CẢ regex phải khớp (compound). Cho phép khớp ở các câu khác nhau. */
  allOf: RegExp[];
  /** Nếu khớp → hủy rule (phủ định / kế hoạch bị rút lại). */
  negation?: RegExp;
}

const COMMON_NEGATION = /\b(?:will\s+not|won'?t|never|rule[sd]?\s+out|no\s+plans?\s+to|not\s+going\s+to|cancel(?:led|ing)?|call(?:ed|ing)?\s+off)\b/i;

export const TRIPWIRES: TripwireRule[] = [
  // ── A1: crypto ─────────────────────────────────────────────────────────
  {
    id: 'A1_RESERVE_ACTION',
    cls: 'A1',
    allOf: [
      /\b(?:strategic\s+)?(?:crypto(?:currency)?|bitcoin|digital\s+assets?)\s+(?:strategic\s+)?(?:reserve|stockpile)\b/i,
      ACTION,
    ],
    negation: COMMON_NEGATION,
  },
  {
    id: 'A1_CRYPTO_LAW_SIGNED',
    cls: 'A1',
    allOf: [
      /\bsign(?:ed|ing)?\b/i,
      /\b(?:crypto(?:currency)?|bitcoin|stablecoin|digital\s+assets?|GENIUS)\b/i,
      /\b(?:act|bill|law|legislation|executive\s+order)\b/i,
    ],
    negation: COMMON_NEGATION,
  },
  {
    // Cấm crypto: yêu cầu ngôi thứ nhất + động từ cấm + crypto trong CÙNG câu,
    // để "Biden wanted to ban crypto" (công kích đối thủ) không kích hoạt.
    id: 'A1_CRYPTO_BAN',
    cls: 'A1',
    allOf: [/\b(?:I\s+(?:have\s+|am\s+)?|we\s+(?:have\s+|are\s+)?|today\s+I)\s*(?:hereby\s+)?bann?(?:ed|ing)?\b[^.!?]{0,50}\b(?:bitcoin|crypto)/i],
    negation: COMMON_NEGATION,
  },

  // ── A2: thương mại ─────────────────────────────────────────────────────
  {
    id: 'A2_RECIPROCAL_TARIFFS',
    cls: 'A2',
    allOf: [
      /\breciprocal\s+tariffs?\b/i,
      /\b(?:sign(?:ed|ing)?|executive\s+order|impos(?:e[sd]?|ing)|hereby|effective|authoriz(?:e[sd]?|ing)|announc(?:e[sd]?|ing)|lowered?)\b/i,
    ],
    negation: COMMON_NEGATION,
  },
  {
    // % cụ thể + nền kinh tế lớn + từ thuế + động từ hành động/hiệu lực
    id: 'A2_PERCENT_TARIFF_MAJOR',
    cls: 'A2',
    allOf: [
      /\b\d{2,3}\s?%/,
      /\b(?:china|chinese|mexico|canada|european\s+union|\bEU\b|japan|india|vietnam|korea)\b/i,
      /\btariff|dut(?:y|ies)|import\s+tax/i,
      /\b(?:impos(?:e[sd]?|ing)|charg(?:e[sd]?|ing)|rais(?:e[sd]?|ing)|implement(?:ed|ing)?|sign(?:ed|ing)?|hereby|effective|will\s+pay|put(?:ting)?)\b/i,
    ],
    negation: COMMON_NEGATION,
  },
  {
    // Tạm dừng thuế — sự kiện 09/04/2025 làm thị trường bùng nổ chiều NGƯỢC lại
    id: 'A2_TARIFF_PAUSE',
    cls: 'A2',
    allOf: [/\bauthoriz\w*\s+a?\s*\d+\s*[- ]?day\s+pause\b/i, /\btariff/i],
  },
  {
    id: 'A2_ALL_COUNTRIES',
    cls: 'A2',
    allOf: [
      /\btariffs?\b/i,
      /\b(?:all|every)\s+(?:countries|nations)\b|\bcountries\s+throughout\s+the\s+world\b|\bnations\s+(?:near\s+and\s+far|around\s+the\s+world)\b/i,
      ACTION,
    ],
    negation: COMMON_NEGATION,
  },

  // ── A3: tiền tệ ────────────────────────────────────────────────────────
  {
    // Powell + động từ sa thải. Lưu ý: khớp cả "Powell's termination cannot come
    // fast enough" (17/04/2025) — bài đó CHỈ là mong muốn nhưng thị trường vẫn sập;
    // với triết lý recall-first, bắn alert cho nó là chấp nhận được.
    id: 'A3_FIRE_FED_CHAIR',
    cls: 'A3',
    allOf: [
      /\b(?:powell|fed(?:eral\s+reserve)?\s+chair(?:man)?)\b/i,
      /\b(?:fir(?:e[sd]?|ing)|terminat(?:e[sd]?|ing|ion)|remov(?:e[sd]?|ing)|replac(?:e[sd]?|ing)|dismiss(?:ed|ing)?)\b/i,
    ],
    negation: COMMON_NEGATION,
  },

  // ── A4: quân sự ────────────────────────────────────────────────────────
  {
    id: 'A4_STRIKE_COMPLETED',
    cls: 'A4',
    allOf: [
      /\b(?:completed|launched|carried\s+out|conducted|executed)\b/i,
      /\b(?:attack|strike|air\s?strikes?|bombing)\b/i,
    ],
    negation: /\b(?:will\s+not|won'?t|never|no\s+(?:attack|strike)|cancel(?:led|ing)?|call(?:ed|ing)?\s+off|against\s+(?:an?\s+)?(?:attack|strike|war)|exercise|drill)\b/i,
  },
  {
    id: 'A4_STRIKE_ON_SITES',
    cls: 'A4',
    allOf: [
      /\b(?:attack|strike)s?\s+on\b/i,
      /\b(?:nuclear|military|missile)\s+(?:sites?|facilit\w*|bases?)\b/i,
    ],
    negation: /\b(?:will\s+not|won'?t|never|no\s+(?:attack|strike)|cancel(?:led|ing)?|call(?:ed|ing)?\s+off|exercise|drill)\b/i,
  },

  // ── A5: hệ thống tài chính ─────────────────────────────────────────────
  {
    id: 'A5_DEBT_DEFAULT',
    cls: 'A5',
    allOf: [/\bdefault\s+on\s+(?:our|the|US|America'?s?)\s+debt\b/i],
    negation: COMMON_NEGATION,
  },
  {
    id: 'A5_CAPITAL_CONTROLS',
    cls: 'A5',
    allOf: [/\bcapital\s+controls\b/i, ACTION],
    negation: COMMON_NEGATION,
  },
];

export interface TripwireHit {
  ruleId: string;
  cls: EventClass;
}

/** Chạy toàn bộ tripwire trên một bài. Thuần, đồng bộ, không tốn API call. */
export function runTripwires(content: string): TripwireHit[] {
  const hits: TripwireHit[] = [];
  for (const rule of TRIPWIRES) {
    if (rule.negation && rule.negation.test(content)) continue;
    if (rule.allOf.every(re => re.test(content))) {
      hits.push({ ruleId: rule.id, cls: rule.cls });
    }
  }
  return hits;
}
