import { Injectable, Logger } from '@nestjs/common';

/**
 * SeverityService: Phát hiện mức độ nghiêm trọng của bài viết theo rule-based.
 *
 * Cơ chế:
 * 1. Quét từ khóa theo từng nhóm nguy hiểm (mỗi nhóm có trọng số riêng)
 * 2. Phát hiện temporal proximity ("5 minutes ago", "just happened"...)
 * 3. Phát hiện đối tượng địa lý / hệ thống tài chính
 * 4. Phát ra hard_rule = true nếu sự kiện đủ điều kiện để override model
 *
 * Output:
 * - severityScore:  0.0 – 1.0  (tổng điểm rule-based, đã clamp)
 * - hardRule:       boolean     (true → override ensembleProb lên >= MIN_HARD_PROB)
 * - hardDirection:  direction hint từ rule (không phải model)
 * - matchedRules:   danh sách rule đã khớp (để debug/logging)
 */

export interface SeverityResult {
  severityScore: number;               // 0-1
  hardRule: boolean;                    // true = override mode
  hardDirection: 'increase' | 'decrease' | 'neutral';
  matchedRules: string[];
}

interface RuleGroup {
  name: string;
  keywords: RegExp[];
  weight: number;                       // điểm cộng vào severityScore
  direction: 'increase' | 'decrease' | 'neutral';
  isHard: boolean;                      // nếu khớp → hardRule = true
  minMatches?: number;                  // cần ít nhất N từ trong group mới tính điểm (default 1)
}

@Injectable()
export class SeverityService {
  private readonly logger = new Logger(SeverityService.name);

  // Probability tối thiểu khi hard rule kích hoạt
  private readonly MIN_HARD_PROB = 88;

  /**
   * Các nhóm rule, xếp từ nghiêm trọng nhất xuống.
   * weight tích luỹ → clamp [0,1] ở cuối.
   */
  private readonly ruleGroups: RuleGroup[] = [
    // ─── NHÓM 1: Sự kiện quân sự / vũ khí cực đại ────────────────────────────
    {
      name: 'NUCLEAR_WMD',
      keywords: [
        /\bnuclear\b/i, /\batom(ic)?\s+(bomb|weapon|strike|attack|warhead)\b/i,
        /\bWMD\b/, /\bweapon[s]?\s+of\s+mass\s+destruction\b/i,
        /\bnuke[sd]?\b/i, /\bradiation\s+(leak|release|cloud)\b/i,
        /\bradioactive\b/i,
      ],
      weight: 0.90,
      direction: 'decrease',
      isHard: true,
    },
    {
      name: 'MILITARY_STRIKE',
      keywords: [
        /\bbombed?\b/i, /\bmissile\s+(strike|attack|launch)\b/i,
        /\bair\s+strike[s]?\b/i, /\binvad(e[sd]?|ing|ion)\b/i,
        /\bwar\s+(broke?\s+out|declared|started)\b/i,
        /\battacked?\s+(iran|israel|taiwan|china|russia|ukraine|north\s*korea)\b/i,
      ],
      weight: 0.70,
      direction: 'decrease',
      isHard: true,
    },

    // ─── NHÓM 2: Khủng hoảng tài chính hệ thống ──────────────────────────────
    {
      name: 'FINANCIAL_SYSTEM_CRISIS',
      keywords: [
        /\bfed(eral reserve)?\s+(collapse[sd]?|default[sd]?|bankrupt)\b/i,
        /\b(us|u\.s\.)\s+dollar\s+(collapse[sd]?|crash(ed)?)\b/i,
        /\bgold\s+standard\b/i,
        /\bsystemic\s+(bank|financial|credit)\s+(failure|collapse|crisis)\b/i,
        /\bbank\s+run[s]?\b/i,
      ],
      weight: 0.75,
      direction: 'increase',   // khủng hoảng fiat → BTC safe haven
      isHard: true,
    },
    {
      name: 'CRYPTO_REGULATION',
      keywords: [
        /\bbit\s*coin\s+(ban|illegal|criminali[sz]e)\b/i,
        /\bcrypto\s+(ban|crackdown|banned|outlawed)\b/i,
        /\bsec\s+(approved?|approved?)\s+(bitcoin|crypto|etf)\b/i,
        /\bbitcoin\s+(etf|strategic\s+reserve|legal\s+tender)\b/i,
        /\bstrategic\s+(bitcoin|crypto)\s+reserve\b/i,
      ],
      weight: 0.80,
      direction: 'increase',
      isHard: true,
    },

    // ─── NHÓM 3: Kinh tế vĩ mô lớn ───────────────────────────────────────────
    {
      name: 'FED_INTEREST_RATE',
      keywords: [
        /\binterest\s+rate[s]?\b/i, /\bfed\s+(cut[s]?|hike[s]?|pause[sd]?)\b/i,
        /\brate\s+(cut|hike|increase|decrease|pivot)\b/i,
        /\bquantitative\s+(easing|tightening)\b/i,
        /\bmonetary\s+policy\b/i,
      ],
      weight: 0.40,
      direction: 'neutral',
      isHard: false,
    },
    {
      name: 'TARIFF_TRADE_WAR',
      keywords: [
        /\btariff[s]?\b/i, /\btrade\s+war\b/i,
        /\bsanction[s]?\b/i, /\bembargo\b/i,
        /\beconomic\s+war[fare]?\b/i,
      ],
      weight: 0.35,
      direction: 'decrease',
      isHard: false,
    },
    {
      name: 'RECESSION_DEPRESSION',
      keywords: [
        /\brecession\b/i, /\bdepression\b/i,
        /\bdebt\s+(ceiling|default|crisis)\b/i,
        /\bsovereign\s+default\b/i,
        /\bgdp\s+(fell|crashes?|collapses?)\b/i,
      ],
      weight: 0.35,
      direction: 'decrease',
      isHard: false,
    },

    // ─── NHÓM 4: Địa chính trị trung bình ────────────────────────────────────
    {
      name: 'GEOPOLITICAL_TENSION',
      keywords: [
        /\bwar\b/i, /\bconflict\b/i, /\bcrisis\b/i,
        /\bceasefire\b/i, /\bpeace\s+(deal|talks|agreement)\b/i,
        /\bcoup\b/i, /\bregime\s+change\b/i,
        /\b(north\s*korea|iran|russia|china)\b/i,
      ],
      weight: 0.20,
      direction: 'decrease',
      isHard: false,
    },

    // ─── NHÓM 5: Tín hiệu temporal (tăng thêm nếu sự kiện đang xảy ra) ───────
    {
      name: 'REALTIME_SIGNAL',
      keywords: [
        /\bjust\s+(happened|occurred|launched|struck|bombed)\b/i,
        /\b\d+\s+minutes?\s+ago\b/i,
        /\bright\s+now\b/i,
        /\bbreaking\b/i,
        /\bunfolding\b/i,
        /\bmoments?\s+ago\b/i,
      ],
      weight: 0.25,
      direction: 'neutral',
      isHard: false,
    },
  ];

  /**
   * Phân tích nội dung bài viết và trả về SeverityResult.
   */
  evaluate(content: string): SeverityResult {
    const text = content.toLowerCase();
    let totalScore = 0;
    const matchedRules: string[] = [];
    let hardRule = false;
    let hardDirection: 'increase' | 'decrease' | 'neutral' = 'neutral';
    let highestHardWeight = 0;

    for (const group of this.ruleGroups) {
      const minMatches = group.minMatches ?? 1;
      const hits = group.keywords.filter((kw) => kw.test(text)).length;

      if (hits >= minMatches) {
        totalScore += group.weight;
        matchedRules.push(`${group.name}(hits=${hits},+${group.weight})`);

        if (group.isHard) {
          hardRule = true;
          if (group.weight > highestHardWeight) {
            highestHardWeight = group.weight;
            hardDirection = group.direction;
          }
        }
      }
    }

    const severityScore = Math.min(1.0, totalScore);

    if (matchedRules.length > 0) {
      this.logger.debug(
        `Severity rules matched: [${matchedRules.join(', ')}] → score=${severityScore.toFixed(2)}, hardRule=${hardRule}`,
      );
    }

    return { severityScore, hardRule, hardDirection, matchedRules };
  }

  /** Giá trị probability tối thiểu khi hard rule kích hoạt */
  getMinHardProb(): number {
    return this.MIN_HARD_PROB;
  }
}
