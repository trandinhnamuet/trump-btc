import { Injectable, Logger } from '@nestjs/common';

/**
 * SeverityService v2 â€” Rule-based severity vá»›i compound patterns + negation guard.
 *
 * Váº¥n Ä‘á» v1: dÃ¹ng single-keyword `/\bnuclear\b/` â†’
 *   "I'm not gonna use nuclear bomb" â†’ khá»›p â†’ 88% DECREASE â† SAI HOÃ€N TOÃ€N.
 *
 * Cáº£i tiáº¿n v2:
 * 1. Compound patterns: yÃªu cáº§u keyword + action-verb/context cá»¥ thá»ƒ
 *    (e.g. "nuclear bomb" hoáº·c "launched nuclear" thay vÃ¬ chá»‰ "nuclear")
 * 2. Negation guard: náº¿u text chá»©a "not gonna / will not / ruled out / denied"
 *    gáº§n vá»›i pattern â†’ Há»¦Y hard rule, chá»‰ tÃ­nh Ä‘iá»ƒm má»m Ã—0.15
 * 3. Hard rule chá»‰ kÃ­ch hoáº¡t cho hÃ nh Ä‘á»™ng XÃC NHáº¬N (confirmed actions),
 *    KHÃ”NG pháº£i cáº£nh bÃ¡o, phá»§ Ä‘á»‹nh, hay giáº£ Ä‘á»‹nh
 */

export interface SeverityResult {
  severityScore: number;                // 0â€“1
  hardRule: boolean;                    // true â†’ override ensembleProb lÃªn â‰¥ MIN_HARD_PROB
  hardDirection: 'increase' | 'decrease' | 'neutral';
  matchedRules: string[];
}

interface RuleGroup {
  name: string;
  keywords: RegExp[];
  weight: number;
  direction: 'increase' | 'decrease' | 'neutral';
  isHard: boolean;
  minMatches?: number;
  /**
   * Náº¿u regex nÃ y khá»›p trong TOÃ€N Bá»˜ vÄƒn báº£n â†’ coi lÃ  phá»§ Ä‘á»‹nh:
   * - KhÃ´ng kÃ­ch hoáº¡t hard rule
   * - Äiá»ƒm severity = weight Ã— 0.15 (soft fallback)
   */
  negationGuard?: RegExp;
}

@Injectable()
export class SeverityService {
  private readonly logger = new Logger(SeverityService.name);

  private readonly MIN_HARD_PROB = 88;

  private readonly ruleGroups: RuleGroup[] = [

    // â”€â”€â”€ NHÃ“M 1: Háº¡t nhÃ¢n / WMD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Chá»‰ trigger khi cÃ³ compound context: vÅ© khÃ­ + Ä‘á»™ng tá»« hÃ nh Ä‘á»™ng
    // "nuclear bomb" âœ… | "nuclear policy" âŒ | "not gonna use nuclear" â†’ negated âœ…
    {
      name: 'NUCLEAR_WMD',
      keywords: [
        // nuclear + weapon/action noun (forward order)
        /\bnuclear\s+(?:attack|strike|bomb(?:ed|ing)?|missile[s]?|warhead[s]?|war\b)/i,
        // nuclear weapon + modal/action verb
        /\bnuclear\s+weapons?\s+(?:(?:will\s+(?:be\s+)?|are\s+(?:being\s+)?|were\s+(?:being\s+)?))?(?:use[sd]?|deploy(?:ed)?|launch(?:ed)?|fire[sd]?|detona(?:te[sd]?|ting))\b/i,
        // action verb + nuclear (reverse order: "launched nuclear", "will use nuclear")
        /\b(?:launch(?:ed|ing)?|fire[sd]?|deploy(?:ed|ing)?|detona(?:te[sd]?|ting)|drop(?:ped|ping)?|us(?:e[sd]?|ing)|will\s+use)\s+(?:a\s+|the\s+)?nuclear\b/i,
        // atomic bomb/attack
        /\batomic\s+(?:bomb(?:ed|ing)?|attack|strike|weapon[s]?)\b/i,
        // nuke as confirmed action verb
        /\bnuke[sd]\s+\w+/i,
        // WMD confirmed use
        /\bWMD[s]?\s+(?:use[sd]|deploy(?:ed)?|launch(?:ed)?|detona(?:te[sd]?))\b/i,
        // post-event radiation
        /\bnuclear\s+fallout\b/i,
        /\bradioactive\s+(?:fallout|cloud|contamination)\b/i,
      ],
      // Phá»§ Ä‘á»‹nh rÃµ rÃ ng: "not gonna", "will not", "never", "ruled out", "denied"
      negationGuard: /\b(?:not\s+(?:going\s+to|gonna|planning\s+to|using?|launching?|deploying?|considering)|will\s+not\b|won't\b|never\s+(?:use|launch|deploy|fire)|no\s+(?:plans?|intention)\s+(?:to\s+)?(?:use|launch|deploy)|refus(?:ed?|ing)\s+to|denied?\s+(?:any|the|that)|rul(?:e[sd]?|ing)\s+out|not\s+(?:use|authorize[sd]?|allow|approve[sd]?)(?:\s+\w+)?\s+nuclear|not\s+have\s+nuclear)\b/i,
      weight: 0.90,
      direction: 'decrease',
      isHard: true,
    },

    // â”€â”€â”€ NHÃ“M 2: Táº¥n cÃ´ng quÃ¢n sá»± xÃ¡c nháº­n â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Compound patterns yÃªu cáº§u tÃªn Ä‘á»‹a Ä‘iá»ƒm/quá»‘c gia hoáº·c Ä‘á»™ng tá»« quÃ¡ khá»©
    {
      name: 'MILITARY_STRIKE',
      keywords: [
        /\b(?:missile|air|drone)\s+strike[s]?\b/i,
        /\bbombs?\s+(?:drop(?:ped)?|launch(?:ed)?)\b/i,
        /\bbomb(?:ed|ing)\s+\w+/i,          // "bombed Tehran"
        /\bwar\s+(?:broke?\s+out|declared|erupted|started)\b/i,
        /\battacked?\s+(?:iran|israel|taiwan|china|russia|ukraine|north\s*korea|the\s+us|america)\b/i,
        /\binvad(?:ed|ing)\s+\w+/i,         // "invaded Taiwan"
        /\btroops?\s+(?:enter(?:ed)?|cross(?:ed)?|invad(?:ed|ing))\b/i,
        /\bground\s+(?:invasion|offensive|assault)\s+(?:begin|began|started|launch(?:ed)?)\b/i,
      ],
      negationGuard: /\b(?:not|never|won'?t|will\s+not|no\s+(?:attack|strike|invasion|war|military\s+action)|rul(?:e[sd]?|ing)\s+out|denied?|refus(?:e[sd]?|ing)|against\s+(?:attack|war|invasion)|ceasefire|peace\s+deal)\b/i,
      weight: 0.70,
      direction: 'decrease',
      isHard: true,
    },

    // â”€â”€â”€ NHÃ“M 3: Khá»§ng hoáº£ng tÃ i chÃ­nh há»‡ thá»‘ng â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      name: 'FINANCIAL_SYSTEM_CRISIS',
      keywords: [
        /\bfed(?:eral\s+reserve)?\s+(?:collapse[sd]?|default(?:ed)?|bankrupt)\b/i,
        /\b(?:us|u\.s\.)\s+dollar\s+(?:collapse[sd]?|crash(?:ed)?|worthless|hyperinflation)\b/i,
        /\bsystemic\s+(?:bank|financial|credit)\s+(?:failure|collapse|crisis)\b/i,
        /\bbank\s+runs?\b/i,
        /\bgold\s+standard\b/i,
      ],
      weight: 0.75,
      direction: 'increase',
      isHard: true,
    },

    // â”€â”€â”€ NHÃ“M 4: Quy Ä‘á»‹nh crypto trá»±c tiáº¿p â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      name: 'CRYPTO_REGULATION',
      keywords: [
        /\bbitcoin\s+(?:ban(?:ned)?|illegal|criminali[sz]ed?)\b/i,
        /\bcrypto\s+(?:ban(?:ned)?|crackdown|outlawed)\b/i,
        /\bsec\s+(?:approved?|denied?)\s+(?:bitcoin|crypto|eth)\s+etf\b/i,
        /\bbitcoin\s+(?:etf\s+approved|strategic\s+reserve|legal\s+tender)\b/i,
        /\bstrategic\s+(?:bitcoin|crypto)\s+reserve\b/i,
        /\bnational\s+bitcoin\s+reserve\b/i,
      ],
      weight: 0.80,
      direction: 'increase',
      isHard: true,
    },

    // â”€â”€â”€ NHÃ“M 5: Fed / lÃ£i suáº¥t â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      name: 'FED_INTEREST_RATE',
      keywords: [
        /\binterest\s+rates?\b/i,
        /\bfed\s+(?:cut[s]?|hike[s]?|pause[sd]?|pivot)\b/i,
        /\brate\s+(?:cut|hike|increase|decrease|pivot)\b/i,
        /\bquantitative\s+(?:easing|tightening)\b/i,
        /\bmonetary\s+policy\b/i,
      ],
      weight: 0.40,
      direction: 'neutral',
      isHard: false,
    },

    // â”€â”€â”€ NHÃ“M 6: Thuáº¿ quan / chiáº¿n tranh thÆ°Æ¡ng máº¡i â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      name: 'TARIFF_TRADE_WAR',
      keywords: [
        /\btariff[s]?\b/i,
        /\btrade\s+war\b/i,
        /\bsanction[s]?\b/i,
        /\bembargo\b/i,
      ],
      weight: 0.35,
      direction: 'decrease',
      isHard: false,
    },

    // â”€â”€â”€ NHÃ“M 7: Suy thoÃ¡i kinh táº¿ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      name: 'RECESSION_DEPRESSION',
      keywords: [
        /\brecession\b/i,
        /\bdepression\b/i,
        /\bdebt\s+(?:ceiling|default|crisis)\b/i,
        /\bsovereign\s+default\b/i,
        /\bgdp\s+(?:fell|crash(?:ed)?|collapse[sd]?)\b/i,
      ],
      weight: 0.35,
      direction: 'decrease',
      isHard: false,
    },

    // â”€â”€â”€ NHÃ“M 8: Äá»‹a chÃ­nh trá»‹ trung bÃ¬nh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      name: 'GEOPOLITICAL_TENSION',
      keywords: [
        /\bwar\b/i,
        /\bconflict\b/i,
        /\bcrisis\b/i,
        /\bceasefire\b/i,
        /\bcoup\b/i,
        /\b(?:north\s*korea|iran|russia|china)\b/i,
      ],
      weight: 0.20,
      direction: 'decrease',
      isHard: false,
    },

    // â”€â”€â”€ NHÃ“M 9: TÃ­n hiá»‡u thá»i gian thá»±c â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    {
      name: 'REALTIME_SIGNAL',
      keywords: [
        /\bjust\s+(?:happened|occurred|launched|struck|bombed)\b/i,
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
   * ÄÃ¡nh giÃ¡ má»©c Ä‘á»™ nghiÃªm trá»ng cá»§a bÃ i viáº¿t.
   *
   * Logic:
   * - Náº¿u group.keywords cÃ³ â‰¥ minMatches hits trong text:
   *   - Kiá»ƒm tra negationGuard (náº¿u cÃ³): phá»§ Ä‘á»‹nh â†’ Ä‘iá»ƒm Ã—0.15, KHÃ”NG hard rule
   *   - KhÃ´ng phá»§ Ä‘á»‹nh â†’ Ä‘iá»ƒm Ä‘áº§y Ä‘á»§, hard rule (náº¿u isHard=true)
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

      if (hits < minMatches) continue;

      // Kiá»ƒm tra ngá»¯ cáº£nh phá»§ Ä‘á»‹nh (chá»‰ cÃ³ Ã½ nghÄ©a vá»›i hard groups)
      const negated = group.negationGuard ? group.negationGuard.test(text) : false;

      // Náº¿u phá»§ Ä‘á»‹nh: tÃ­nh Ä‘iá»ƒm nhá» (signal váº«n liÃªn quan nhÆ°ng tháº¥p), khÃ´ng hard rule
      const effectiveWeight = negated ? +(group.weight * 0.15).toFixed(2) : group.weight;
      totalScore += effectiveWeight;

      matchedRules.push(
        negated
          ? `${group.name}(NEGATED,+${effectiveWeight})`
          : `${group.name}(hits=${hits},+${effectiveWeight})`,
      );

      if (group.isHard && !negated) {
        hardRule = true;
        if (group.weight > highestHardWeight) {
          highestHardWeight = group.weight;
          hardDirection = group.direction;
        }
      }
    }

    const severityScore = Math.min(1.0, totalScore);

    if (matchedRules.length > 0) {
      this.logger.debug(
        `Severity: [${matchedRules.join(', ')}] â†’ score=${severityScore.toFixed(2)}, hardRule=${hardRule}`,
      );
    }

    return { severityScore, hardRule, hardDirection, matchedRules };
  }

  getMinHardProb(): number {
    return this.MIN_HARD_PROB;
  }
}

