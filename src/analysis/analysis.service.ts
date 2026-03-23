import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AnalysisResult } from '../common/interfaces';
import { MarketSignalService, MarketContextResult } from '../market-signal/market-signal.service';

/**
 * AnalysisService v3 — AI-first, market-aware.
 *
 * Thay thế approach cũ (ensemble rule-based + AI):
 *   → Grok được cung cấp bối cảnh thị trường đầy đủ (giá, 24h/7d/30d, vị trí so ATH/ATL)
 *   → AI tự suy luận về tâm lý thị trường, macro narrative, thế vị của BTC hiện tại
 *   → Không có rule-based hard override, không có keyword matching
 *   → Reasoning tự do theo từng post — không theo template A/B/C/D
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly grokApiKey: string;
  private readonly grokApiUrl = 'https://api.x.ai/v1/chat/completions';

  constructor(
    private readonly configService: ConfigService,
    private readonly marketSignalService: MarketSignalService,
  ) {
    const apiKey = this.configService.get<string>('GROK_API_KEY');
    if (!apiKey) this.logger.warn('GROK_API_KEY chưa được cấu hình trong .env!');
    this.grokApiKey = apiKey || '';
  }

  async analyzePost(content: string): Promise<AnalysisResult> {
    this.logger.log(`Phân tích bài viết (len=${content.length})`);

    // Lấy bối cảnh thị trường song song (không còn SeverityService)
    const market = await this.marketSignalService.getMarketContext();
    const modelResult = await this.callGrok(content, market);

    const result: AnalysisResult = {
      ...modelResult,
      ensembleProbability: modelResult.btcInfluenceProbability,
      severityScore: 0,
      marketSignalScore: market.marketSignalScore,
      hardRule: false,
      matchedRules: [],
    };

    this.logger.log(
      `Phân tích xong: ${result.btcInfluenceProbability}% (${result.btcDirection}) ` +
      `| market=${market.trendLabel} | price=$${market.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    );

    return result;
  }

  private async callGrok(
    content: string,
    market: MarketContextResult,
  ): Promise<Omit<AnalysisResult, 'ensembleProbability' | 'severityScore' | 'marketSignalScore' | 'hardRule' | 'matchedRules'>> {
    const prompt = this.buildPrompt(content, market);

    const response = await axios.post(
      this.grokApiUrl,
      {
        messages: [
          {
            role: 'system',
            content:
              'You are an expert Bitcoin market analyst. You deeply understand how news, geopolitics, and macro events affect market psychology and BTC price action. ' +
              'You reason from first principles, not templates. Every analysis is specific to the post and the current market state.',
          },
          { role: 'user', content: prompt },
        ],
        model: 'grok-3',
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.grokApiKey}`,
        },
      },
    ).catch((err) => {
      this.logger.error('Grok API error:', err.message);
      throw err;
    });

    const raw: string = response.data?.choices?.[0]?.message?.content ?? '';
    if (!raw) throw new Error('Grok trả về response rỗng');

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.error('JSON parse lỗi, raw:\n' + raw);
      throw new Error('Grok response không phải JSON hợp lệ');
    }

    return {
      summary: parsed.summary || 'Không thể tóm tắt',
      btcInfluenceProbability: Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0)),
      btcDirection: this.normalizeDirection(parsed.btcDirection),
      reasoning: parsed.reasoning || '',
    };
  }

  private buildPrompt(content: string, market: MarketContextResult): string {
    const fmt  = (n: number) => n > 0 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'N/A';
    const chg  = (n: number) => (n >= 0 ? `+${n}` : `${n}`) + '%';

    const marketBlock = market.currentPrice > 0
      ? [
          '=== LIVE BTC MARKET DATA ===',
          `Price:    ${fmt(market.currentPrice)}`,
          `24h:      ${chg(market.change24h)}`,
          `7d:       ${chg(market.change7d)}`,
          `30d:      ${chg(market.change30d)}`,
          `52w range: ${fmt(market.low52w)} – ${fmt(market.high52w)}`,
          `From 52w high: ${market.pctFromHigh52w}%`,
          `Market state: ${market.trendLabel}`,
          '============================',
        ].join('\n')
      : '(Market data unavailable — analyze based on post content only)';

    return `Analyze the following Trump Truth Social post and assess how likely it is to cause a meaningful BTC price move.

POST:
"${content}"

${marketBlock}

For your analysis, consider:
- Would this news genuinely change how traders/investors perceive risk right now? Or is it noise?
- What is the PSYCHOLOGICAL impact on retail and institutional participants? Fear, greed, indifference?
- Does this affect the macro narrative currently driving BTC (liquidity, regulatory climate, USD strength, risk appetite)?
- Given the current market state (${market.trendLabel}), is BTC fragile or resilient to this type of shock?
- What’s the realistic probability this actually moves BTC in the next 24-48h vs. just being background noise?

Do NOT follow a rigid analysis template. Your reasoning should be organic and specific to THIS post.

Respond with ONLY valid JSON — no extra text:
{
  "summary": "2-3 câu tóm tắt nội dung bài viết bằng tiếng Việt",
  "btcInfluenceProbability": <integer 0-100>,
  "btcDirection": <"increase" | "decrease" | "neutral">,
  "reasoning": "Specific analysis for THIS post in context of current market. Explain the concrete chain of events from post → market psychology → BTC price. Reference current market conditions where relevant. No template, no bullet points. Minimum 4-5 sentences."
}`;
  }

  private normalizeDirection(d?: string): 'increase' | 'decrease' | 'neutral' {
    const s = (d || '').toLowerCase().trim();
    if (s === 'increase' || s === 'up') return 'increase';
    if (s === 'decrease' || s === 'down') return 'decrease';
    return 'neutral';
  }
}
