import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AnalysisResult } from '../common/interfaces';
import { SeverityService } from '../severity/severity.service';
import { MarketSignalService } from '../market-signal/market-signal.service';

/**
 * AnalysisService: PhÃ¢n tÃ­ch bÃ i viáº¿t Trump báº±ng Grok AI + Ensemble Scoring.
 *
 * Pipeline má»›i (3 táº§ng):
 * 1. Rule-based Severity (SeverityService) â†’ severityScore + hardRule
 * 2. Grok AI (LLM) â†’ modelProb + direction + reasoning
 * 3. Market Signal (MarketSignalService) â†’ marketSignalScore
 *
 * Ensemble combiner:
 *   ensembleProb = 0.50 * modelProb + 0.35 * severity*100 + 0.15 * market*100
 *   â†’ Náº¿u hardRule = true â†’ override: ensembleProb = max(ensembleProb, MIN_HARD_PROB)
 *
 * Trá»ng sá»‘ cÃ³ thá»ƒ cáº­p nháº­t sau khi cÃ³ dá»¯ liá»‡u backtest.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly grokApiKey: string;
  private readonly grokApiUrl = 'https://api.x.ai/v1/chat/completions';

  // Trá»ng sá»‘ ensemble (tá»•ng = 1.0)
  private readonly W_MODEL    = 0.50;
  private readonly W_SEVERITY = 0.35;
  private readonly W_MARKET   = 0.15;

  constructor(
    private readonly configService: ConfigService,
    private readonly severityService: SeverityService,
    private readonly marketSignalService: MarketSignalService,
  ) {
    const apiKey = this.configService.get<string>('GROK_API_KEY');
    if (!apiKey) {
      this.logger.warn('GROK_API_KEY chÆ°a Ä‘Æ°á»£c cáº¥u hÃ¬nh trong .env!');
    }
    this.grokApiKey = apiKey || '';
  }

  /**
   * PhÃ¢n tÃ­ch má»™t bÃ i viáº¿t cá»§a Trump â€” pipeline hybrid 3 táº§ng.
   */
  async analyzePost(content: string): Promise<AnalysisResult> {
    this.logger.log(`Báº¯t Ä‘áº§u phÃ¢n tÃ­ch bÃ i viáº¿t (len=${content.length})`);

    // Táº§ng 1 + 3 cháº¡y song song vá»›i Táº§ng 2 Ä‘á»ƒ tiáº¿t kiá»‡m thá»i gian
    const [severityResult, marketSignal, modelResult] = await Promise.all([
      Promise.resolve(this.severityService.evaluate(content)),
      this.marketSignalService.getMarketSignal(),
      this.callGrok(content),
    ]);

    // Ensemble combiner
    const rawEnsemble =
      this.W_MODEL    * modelResult.btcInfluenceProbability +
      this.W_SEVERITY * severityResult.severityScore * 100 +
      this.W_MARKET   * marketSignal.marketSignalScore * 100;

    let ensembleProbability = Math.round(Math.min(100, Math.max(0, rawEnsemble)));

    // Hard-rule override: náº¿u rule máº¡nh kÃ­ch hoáº¡t â†’ Ã©p probability tá»‘i thiá»ƒu
    if (severityResult.hardRule) {
      const minHard = this.severityService.getMinHardProb();
      if (ensembleProbability < minHard) {
        this.logger.warn(
          `Hard rule override: ensemble ${ensembleProbability}% â†’ ${minHard}% (rules: ${severityResult.matchedRules.join(', ')})`,
        );
        ensembleProbability = minHard;
      }
    }

    // HÆ°á»›ng Æ°u tiÃªn: hard rule direction > model direction
    const finalDirection = severityResult.hardRule
      ? severityResult.hardDirection
      : modelResult.btcDirection;

    const result: AnalysisResult = {
      ...modelResult,
      btcDirection: finalDirection,
      ensembleProbability,
      severityScore: severityResult.severityScore,
      marketSignalScore: marketSignal.marketSignalScore,
      hardRule: severityResult.hardRule,
      matchedRules: severityResult.matchedRules,
    };

    this.logger.log(
      `PhÃ¢n tÃ­ch xong: model=${modelResult.btcInfluenceProbability}% | ` +
      `severity=${(severityResult.severityScore * 100).toFixed(0)}% | ` +
      `market=${(marketSignal.marketSignalScore * 100).toFixed(0)}% | ` +
      `ensemble=${ensembleProbability}% (${finalDirection})` +
      (severityResult.hardRule ? ` âš ï¸ HARD RULE` : ''),
    );

    return result;
  }

  /** Gá»i Grok API vÃ  tráº£ vá» káº¿t quáº£ model thuáº§n. */
  private async callGrok(content: string): Promise<Omit<AnalysisResult, 'ensembleProbability' | 'severityScore' | 'marketSignalScore' | 'hardRule' | 'matchedRules'>> {
    const prompt = this.buildPrompt(content);
    this.logger.debug(`Prompt length: ${prompt.length}`);

    try {
      const response = await axios.post(
        this.grokApiUrl,
        {
          messages: [
            {
              role: 'system',
              content: `Báº¡n lÃ  chuyÃªn gia phÃ¢n tÃ­ch tÃ i chÃ­nh cáº¥p cao chuyÃªn vá» Bitcoin (BTC) vá»›i hiá»ƒu biáº¿t sÃ¢u vá» má»‘i quan há»‡ giá»¯a sá»± kiá»‡n vÄ© mÃ´ vÃ  biáº¿n Ä‘á»™ng giÃ¡ crypto.

KIáº¾N THá»¨C Ná»€N Báº®T BUá»˜C ÃP Dá»¤NG:

1. Báº¢N CHáº¤T KÃ‰P Cá»¦A BTC:
   - BTC lÃ  "risk asset": khi thá»‹ trÆ°á»ng sá»£ hÃ£i (risk-off), nhÃ  Ä‘áº§u tÆ° bÃ¡n BTC cÃ¹ng chá»©ng khoÃ¡n Ä‘á»ƒ giá»¯ tiá»n máº·t
   - BTC lÃ  "safe haven / digital gold": khi máº¥t niá»m tin vÃ o tiá»n tá»‡ fiat hoáº·c há»‡ thá»‘ng ngÃ¢n hÃ ng, dÃ²ng tiá»n cháº¡y vÃ o BTC
   - PHÃ‚N BIá»†T: Ä‘á»‹a chÃ­nh trá»‹ thÃ´ng thÆ°á»ng â†’ risk-off â†’ BTC giáº£m; khá»§ng hoáº£ng USD/ngÃ¢n hÃ ng/fiat â†’ safe haven â†’ BTC tÄƒng

2. CÃC NHÃ‚N Tá» Máº NH NHáº¤T TÃC Äá»˜NG BTC:
   - Fed lÃ£i suáº¥t / chÃ­nh sÃ¡ch tiá»n tá»‡: tÄƒng â†’ thanh khoáº£n rÃºt â†’ BTC giáº£m; cáº¯t â†’ bÆ¡m tiá»n â†’ BTC tÄƒng
   - USD (DXY index): USD máº¡nh â†’ BTC giáº£m; USD yáº¿u â†’ BTC tÄƒng (tÆ°Æ¡ng quan nghá»‹ch)
   - Quy Ä‘á»‹nh/thuáº¿ crypto trá»±c tiáº¿p: ráº¥t nháº¡y cáº£m, hÆ°á»›ng rÃµ rÃ ng theo ná»™i dung
   - Chiáº¿n tranh thÆ°Æ¡ng máº¡i / thuáº¿ quan: áº£nh hÆ°á»Ÿng giÃ¡n tiáº¿p qua triá»ƒn vá»ng tÄƒng trÆ°á»Ÿng vÃ  USD
   - GiÃ¡ dáº§u tÄƒng Ä‘á»™t biáº¿n â†’ láº¡m phÃ¡t â†’ Fed hawkish â†’ BTC giáº£m

3. TIá»€N Lá»† Lá»ŠCH Sá»¬ QUAN TRá»ŒNG:
   - Xung Ä‘á»™t Ukraine 2022: BTC ban Ä‘áº§u giáº£m máº¡nh cÃ¹ng cá»• phiáº¿u (risk-off), sau phá»¥c há»“i nhanh
   - CÄƒng tháº³ng Trung ÄÃ´ng thÃ´ng thÆ°á»ng: tÃ¡c Ä‘á»™ng BTC ráº¥t nhá», khÃ´ng á»•n Ä‘á»‹nh
   - COVID crash 3/2020: BTC rÆ¡i -50% trong 2 ngÃ y (risk-off tuyá»‡t Ä‘á»‘i), sau tÄƒng vá»t do stimulus
   - SVB bank collapse 3/2023: BTC TÄ‚NG (safe haven khi ngÃ¢n hÃ ng sá»¥p Ä‘á»•)
   - Announcement thuáº¿ Trump 4/2025: BTC giáº£m cÃ¹ng cá»• phiáº¿u (global recession fear)

4. NGUYÃŠN Táº®C Äá»ŒC HÆ¯á»šNG TÃC Äá»˜NG:
   - Sá»± kiá»‡n lÃ m suy yáº¿u USD / tÄƒng cung tiá»n / chá»‘ng láº¡i há»‡ thá»‘ng tÃ i chÃ­nh truyá»n thá»‘ng â†’ BTC tÄƒng
   - Sá»± kiá»‡n lÃ m tÄƒng lo ngáº¡i suy thoÃ¡i / tháº¯t cháº·t thanh khoáº£n / giáº£m appetite rá»§i ro â†’ BTC giáº£m
   - Sá»± kiá»‡n Ä‘á»‹a chÃ­nh trá»‹: Ä‘Ã¡nh giÃ¡ qua lÄƒng kÃ­nh "liá»‡u cÃ³ khiáº¿n Fed pháº£i pháº£n á»©ng khÃ´ng?" vÃ  "má»©c Ä‘á»™ shock toÃ n cáº§u?"

CHá»ˆ tráº£ vá» JSON theo format yÃªu cáº§u. KHÃ”NG thÃªm báº¥t ká»³ text nÃ o khÃ¡c.`,
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          model: 'grok-3',
          temperature: 0.2,
          max_tokens: 900,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.grokApiKey}`,
          },
        },
      );

      const messageContent = response.data?.choices?.[0]?.message?.content ?? '';
      if (!messageContent) throw new Error('Grok tráº£ vá» response rá»—ng');

      let parsed: any = null;
      try {
        parsed = JSON.parse(messageContent);
      } catch (parseErr) {
        this.logger.error('KhÃ´ng thá»ƒ parse JSON tá»« Grok. Raw:\n' + messageContent);
        throw parseErr;
      }

      return {
        summary: parsed.summary || 'KhÃ´ng thá»ƒ tÃ³m táº¯t',
        btcInfluenceProbability: Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0)),
        btcDirection: this.normalizeDirection(parsed.btcDirection),
        reasoning: parsed.reasoning || '',
      };
    } catch (error) {
      this.logger.error('Lá»—i khi gá»i Grok API:', error.message);
      throw error;
    }
  }

  private buildPrompt(content: string): string {
    return `PhÃ¢n tÃ­ch bÃ i Ä‘Äƒng sau cá»§a Donald Trump trÃªn Truth Social vÃ  Ä‘Ã¡nh giÃ¡ tÃ¡c Ä‘á»™ng lÃªn giÃ¡ Bitcoin (BTC).

BÃ€I VIáº¾T:
"${content}"

---
THá»°C HIá»†N PHÃ‚N TÃCH THEO 3 BÆ¯á»šC (thá»ƒ hiá»‡n trong trÆ°á»ng "reasoning"):

BÆ¯á»šC 1 - PHÃ‚N LOáº I Sá»° KIá»†N:
XÃ¡c Ä‘á»‹nh bÃ i viáº¿t thuá»™c loáº¡i nÃ o vÃ  táº¡i sao:
â€¢ Loáº¡i A â€“ Crypto trá»±c tiáº¿p (70-100%): Ä‘á» cáº­p BTC/crypto, USD, Fed, láº¡m phÃ¡t, quy Ä‘á»‹nh tÃ i chÃ­nh sá»‘, stablecoin
â€¢ Loáº¡i B â€“ Kinh táº¿ vÄ© mÃ´ (40-70%): thuáº¿ quan, chiáº¿n tranh thÆ°Æ¡ng máº¡i Má»¹-Trung, chÃ­nh sÃ¡ch tÃ i khÃ³a lá»›n, dáº§u má»/nÄƒng lÆ°á»£ng cÃ³ thá»ƒ gÃ¢y láº¡m phÃ¡t
â€¢ Loáº¡i C â€“ Äá»‹a chÃ­nh trá»‹ (15-50%): xung Ä‘á»™t, cÄƒng tháº³ng quÃ¢n sá»± â€” pháº£i phÃ¢n tÃ­ch riÃªng: risk-off hay USD-crisis?
â€¢ Loáº¡i D â€“ KhÃ´ng liÃªn quan (0-15%): chÃ­nh trá»‹ ná»™i Ä‘á»‹a, xÃ£ há»™i, thá»ƒ thao

BÆ¯á»šC 2 - CÆ  CHáº¾ TÃC Äá»˜NG (báº¯t buá»™c xÃ©t Cáº¢ HAI chiá»u):
â€¢ Con Ä‘Æ°á»ng BTC TÄ‚NG: sá»± kiá»‡n nÃ y cÃ³ thá»ƒ dáº«n Ä‘áº¿n BTC tÄƒng qua cÆ¡ cháº¿ nÃ o cá»¥ thá»ƒ?
â€¢ Con Ä‘Æ°á»ng BTC GIáº¢M: sá»± kiá»‡n nÃ y cÃ³ thá»ƒ dáº«n Ä‘áº¿n BTC giáº£m qua cÆ¡ cháº¿ nÃ o cá»¥ thá»ƒ?
â€¢ Tiá»n lá»‡: cÃ³ sá»± kiá»‡n tÆ°Æ¡ng tá»± nÃ o trong lá»‹ch sá»­? BTC Ä‘Ã£ pháº£n á»©ng tháº¿ nÃ o?

BÆ¯á»šC 3 - Káº¾T LUáº¬N:
â€¢ So sÃ¡nh sá»©c náº·ng cá»§a hai chiá»u trÃªn â†’ xÃ¡c Ä‘á»‹nh hÆ°á»›ng TRá»˜I HÆ N
â€¢ XÃ¡c Ä‘á»‹nh xÃ¡c suáº¥t (0-100%) dá»±a trÃªn má»©c Ä‘á»™ liÃªn quan thá»±c sá»± tá»›i thá»‹ trÆ°á»ng tÃ i chÃ­nh/BTC
â€¢ Giáº£i thÃ­ch táº¡i sao hÆ°á»›ng nÃ y Ä‘Æ°á»£c chá»n thay vÃ¬ hÆ°á»›ng kia

---
Tráº£ vá» JSON (KHÃ”NG thÃªm text nÃ o khÃ¡c ngoÃ i JSON):
{
  "summary": "TÃ³m táº¯t ná»™i dung bÃ i viáº¿t báº±ng tiáº¿ng Viá»‡t (2-3 cÃ¢u)",
  "btcInfluenceProbability": <sá»‘ nguyÃªn 0-100>,
  "btcDirection": <"increase" | "decrease" | "neutral">,
  "reasoning": "PhÃ¢n tÃ­ch Ä‘áº§y Ä‘á»§ 3 bÆ°á»›c: loáº¡i sá»± kiá»‡n â†’ cÆ¡ cháº¿ tÃ¡c Ä‘á»™ng cá»¥ thá»ƒ cáº£ hai chiá»u tÄƒng/giáº£m cÃ³ tiá»n lá»‡ â†’ káº¿t luáº­n rÃµ lÃ½ do chá»n hÆ°á»›ng nÃ y. Tá»‘i thiá»ƒu 5-6 cÃ¢u, khÃ´ng Ä‘Æ°á»£c viáº¿t chung chung."
}`;
  }

  private normalizeDirection(direction?: string): 'increase' | 'decrease' | 'neutral' {
    const normalized = (direction || '').toLowerCase().trim();
    if (normalized === 'increase' || normalized === 'up') return 'increase';
    if (normalized === 'decrease' || normalized === 'down') return 'decrease';
    return 'neutral';
  }
}
