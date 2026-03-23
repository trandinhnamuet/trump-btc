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
              'Bạn là chuyên gia phân tích thị trường Bitcoin hàng đầu, am hiểu sâu về cách tin tức, chính trị, và sự kiện vĩ mô tác động đến tâm lý thị trường và giá BTC. ' +
              'Bạn suy luận từ bản chất sự việc, không theo template. Mỗi phân tích phải đặc thù cho post đó và trạng thái thị trường hiện tại. ' +
              'QUAN TRỌNG: Toàn bộ phần "reasoning" và "summary" phải viết bằng TIẾNG VIỆT.',
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
    const fmt = (n: number) => n > 0 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'N/A';
    const chg = (n: number) => (n >= 0 ? `+${n}` : `${n}`) + '%';

    const marketBlock = market.currentPrice > 0
      ? [
          '=== DU LIEU THI TRUONG BTC HIEN TAI ===',
          `Gia hien tai: ${fmt(market.currentPrice)}`,
          `24h:          ${chg(market.change24h)}`,
          `7 ngay:       ${chg(market.change7d)}`,
          `30 ngay:      ${chg(market.change30d)}`,
          `Bien do 52 tuan: ${fmt(market.low52w)} - ${fmt(market.high52w)}`,
          `Cach dinh 52 tuan: ${market.pctFromHigh52w}%`,
          `Trang thai: ${market.trendLabel}`,
          '========================================',
        ].join('\n')
      : '(Khong co du lieu thi truong)';

    const distFromHigh = market.pctFromHigh52w < -5
      ? `cach dinh 52 tuan ${Math.abs(market.pctFromHigh52w)}%`
      : 'gan dinh 52 tuan';

    return `Phan tich bai dang sau cua Donald Trump tren Truth Social.

BAI VIET:
"${content}"

${marketBlock}

HUONG DAN PHAN TICH - suy nghi theo cac goc do lien quan nhat:

1. TAC DONG TAM LY: Tin nay gay cam xuc gi cho nha dau tu? Hung khoi, so hai, hay tho o?
2. CO CHE TAC DONG DEN BTC: Dong tien dich chuyen qua kenh nao?
3. DO MOI: Thi truong da dinh gia thong tin nay chua?
4. THUC TE: Day la hanh dong cu the hay chi tuyen bo y dinh?
5. BOI CANH: BTC dang ${distFromHigh}, xu huong "${market.trendLabel}".

CALIBRATION XAC SUAT:
- 0-10%: Khong lien quan kinh te/tai chinh
- 10-30%: Tac dong gian tiep, yeu
- 30-55%: Kinh te vi mo ro rang (thue quan, thuong chien, suy thoai, Fed)
- 55-75%: TRUC TIEP lien quan crypto/Bitcoin/USD (EO ve crypto, chinh sach quy dinh)
- 75-90%: Su kien dot pha bat ngo (My chinh thuc Bitcoin reserve, SEC approve ETF)
- 90-100%: Su kien lich su cuc hiem

LU Y: Khong duoc danh gia thap tin crypto truc tiep. EO cua Trump ve Crypto Strategic Reserve phai >= 70%.

Tra ve ONLY valid JSON:
{
  "summary": "2-3 cau tom tat bang tieng Viet",
  "btcInfluenceProbability": <so nguyen 0-100>,
  "btcDirection": <"increase" | "decrease" | "neutral">,
  "reasoning": "Phan tich cu the, giai thich chuoi tac dong tu noi dung -> tam ly -> gia BTC. Toi thieu 4-5 cau. BAT BUOC VIET BANG TIENG VIET."
}`;
  }

  private normalizeDirection(d?: string): 'increase' | 'decrease' | 'neutral' {
    const s = (d || '').toLowerCase().trim();
    if (s === 'increase' || s === 'up') return 'increase';
    if (s === 'decrease' || s === 'down') return 'decrease';
    return 'neutral';
  }
}
