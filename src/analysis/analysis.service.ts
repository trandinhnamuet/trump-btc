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

  /** Kiểm tra xem content có phải là URL thuần hoặc RT+URL không có text thực */
  private isUrlOnlyContent(content: string): boolean {
    const stripped = content.trim();
    return /^(RT:\s+)?https?:\/\/\S+(\s+https?:\/\/\S+)*\s*$/.test(stripped);
  }

  /** Mô tả nội dung ảnh bằng Grok Vision */
  private async describeImages(imageUrls: string[]): Promise<string> {
    if (!imageUrls.length) return '';
    this.logger.log(`Đang đọc ${imageUrls.length} ảnh bằng Grok Vision...`);
    const imageContent = imageUrls.map(url => ({
      type: 'image_url',
      image_url: { url },
    }));
    const response = await axios.post(
      this.grokApiUrl,
      {
        messages: [{
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: 'Hãy mô tả chi tiết nội dung ảnh/các ảnh này bằng tiếng Việt. Bao gồm: đây là ảnh gì, có chứa văn bản không (nếu có hãy đọc toàn bộ), người trong ảnh là ai, bối cảnh/chủ đề của ảnh là gì.',
            },
          ],
        }],
        model: 'grok-2-vision-latest',
        temperature: 0.1,
        max_tokens: 600,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.grokApiKey}`,
        },
      },
    ).catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Grok Vision error: ' + errMsg);
      throw err;
    });
    return response.data?.choices?.[0]?.message?.content ?? '';
  }

  async analyzePost(content: string, mediaUrls?: string[]): Promise<AnalysisResult> {
    const safeContent = content ?? '';
    this.logger.log(`Phân tích bài viết (len=${safeContent.length}, images=${mediaUrls?.length ?? 0})`);

    const hasMedia = mediaUrls && mediaUrls.length > 0;
    const isUrlOnly = this.isUrlOnlyContent(safeContent);

    // Nếu không có gì để phân tích → trả về 0% ngay
    if ((!safeContent.trim() && !hasMedia) || (isUrlOnly && !hasMedia)) {
      this.logger.warn(`Không có nội dung hoặc chỉ là URL, bỏ qua Grok và trả về 0%`);
      const market = await this.marketSignalService.getMarketContext();
      return {
        summary: 'Bài đăng không có nội dung văn bản hay hình ảnh để phân tích.',
        btcInfluenceProbability: 0,
        btcDirection: 'neutral',
        reasoning: 'Không thể phân tích tác động BTC vì bài đăng không có nội dung văn bản hay hình ảnh.',
        ensembleProbability: 0,
        severityScore: 0,
        marketSignalScore: market.marketSignalScore,
        hardRule: false,
        matchedRules: [],
      };
    }

    // Nếu có ảnh → dùng Grok Vision để mô tả, ghép vào content
    let analysisContent = isUrlOnly ? '' : safeContent;
    if (hasMedia) {
      try {
        const imageDesc = await this.describeImages(mediaUrls);
        if (imageDesc) {
          if (analysisContent) {
            analysisContent += `\n\n[Hình ảnh đính kèm]: ${imageDesc}`;
          } else {
            analysisContent = `[Bài đăng chỉ có hình ảnh, không có văn bản. Mô tả ảnh]: ${imageDesc}`;
          }
          this.logger.log(`Grok Vision mô tả ảnh: ${imageDesc.substring(0, 100)}...`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Grok Vision thất bại: ${errMsg}`);
      }
    }

    // Sau khi xử lý ảnh, nếu vẫn không có nội dung → trả về 0%
    if (!analysisContent.trim()) {
      this.logger.warn(`Không có nội dung sau khi xử lý ảnh (Grok Vision thất bại hoặc trả về rỗng), trả về 0%`);
      const market = await this.marketSignalService.getMarketContext();
      return {
        summary: 'Bài đăng chỉ có hình ảnh nhưng không đọc được nội dung ảnh.',
        btcInfluenceProbability: 0,
        btcDirection: 'neutral',
        reasoning: 'Grok Vision không thể đọc nội dung hình ảnh trong bài đăng này.',
        ensembleProbability: 0,
        severityScore: 0,
        marketSignalScore: market.marketSignalScore,
        hardRule: false,
        matchedRules: [],
      };
    }


    const market = await this.marketSignalService.getMarketContext();
    const modelResult = await this.callGrok(analysisContent, market);

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
        max_tokens: 600,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.grokApiKey}`,
        },
      },
    ).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('Grok API error: ' + errMsg);
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
  "summary": "2-3 cau tom tat CHINH XAC NOI DUNG BAI VIET (Trump dang noi/viet/dang gi? Chu de chinh la gi?). KHONG duoc viet ve tac dong BTC o day.",
  "btcInfluenceProbability": <so nguyen 0-100>,
  "btcDirection": <"increase" | "decrease" | "neutral">,
  "reasoning": "Phan tich ngan gon, toi da 50-75 chu, 1-2 cau. Giai thich tac dong tu noi dung toi BTC. VIET BANG TIENG VIET."
}`;
  }

  private normalizeDirection(d?: string): 'increase' | 'decrease' | 'neutral' {
    const s = (d || '').toLowerCase().trim();
    if (s === 'increase' || s === 'up') return 'increase';
    if (s === 'decrease' || s === 'down') return 'decrease';
    return 'neutral';
  }

  /**
   * Lấy thông tin credit/balance còn lại từ Grok/OpenAI billing endpoints.
   * Trả về một chuỗi mô tả hoặc ném lỗi nếu không thể lấy.
   */
  public async getRemainingCredits(): Promise<string> {
    if (!this.grokApiKey) {
      return 'GROK_API_KEY chưa được cấu hình. Vui lòng thêm vào .env hoặc biến môi trường và khởi động lại ứng dụng.';
    }

    // Các endpoint billing có thể khác nhau hoặc không được public.
    // Thử một vài endpoint billing trước, nếu không có kết quả thì kiểm tra endpoint models
    const billingCandidates = [
      'https://api.x.ai/v1/dashboard/billing/credit_grants',
      'https://api.openai.com/v1/dashboard/billing/credit_grants',
      'https://api.x.ai/v1/billing/credits',
      'https://api.x.ai/v1/credits',
    ];

    for (const url of billingCandidates) {
      try {
        const resp = await axios.get(url, {
          headers: { Authorization: `Bearer ${this.grokApiKey}` },
          timeout: 7000,
        });
        const d = resp.data;
        if (!d) continue;

        // Thử đọc các trường hay gặp
        if (typeof d.total_granted !== 'undefined' || typeof d.total_used !== 'undefined') {
          const granted = Number(d.total_granted ?? d.total_available ?? 0);
          const used = Number(d.total_used ?? d.total_usage ?? 0);
          const remaining = Math.max(0, granted - used);
          return `Còn lại: ${remaining} (đã cấp: ${granted}, đã dùng: ${used}) — nguồn: ${url}`;
        }
        if (typeof d.balance !== 'undefined') {
          return `Còn lại: ${d.balance} — nguồn: ${url}`;
        }
        if (typeof d.credits !== 'undefined') {
          return `Còn lại: ${d.credits} — nguồn: ${url}`;
        }

        // Nếu response khác, trả về một bản tóm tắt ngắn
        try {
          const pretty = JSON.stringify(d, null, 2);
          return `Kết quả (billing endpoint ${url}): ${pretty.substring(0, 1000)}`;
        } catch {
          return `Không thể đọc response từ ${url}`;
        }
      } catch (err: any) {
        // Nếu bị 401/403 → key không hợp lệ hoặc bị chặn
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          return `GROK_API_KEY không hợp lệ hoặc bị từ chối truy cập (HTTP ${status}).`;
        }
        // khác thì tiếp tục thử endpoint khác
        continue;
      }
    }

    // Nếu không lấy được billing, kiểm tra endpoint models để xác nhận key còn hợp lệ
    const modelCandidates = ['https://api.x.ai/v1/models', 'https://api.openai.com/v1/models'];
    for (const url of modelCandidates) {
      try {
        const resp = await axios.get(url, {
          headers: { Authorization: `Bearer ${this.grokApiKey}` },
          timeout: 7000,
        });
        if (resp.status === 200 && resp.data) {
          const data = resp.data.data ?? resp.data.models ?? resp.data;
          let models: string[] = [];
          if (Array.isArray(data)) {
            models = data.slice(0, 5).map((m: any) => m.id ?? m.name ?? String(m));
          }
          const modelList = models.length ? models.join(', ') : JSON.stringify(resp.data).substring(0, 200);
          return `API key hợp lệ. Models truy cập: ${modelList}. Lưu ý: API không cung cấp thông tin credit công khai qua endpoint billing; kiểm tra dashboard billing để biết chi tiết.`;
        }
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          return `GROK_API_KEY không hợp lệ hoặc bị từ chối truy cập (HTTP ${status}).`;
        }
        continue;
      }
    }

    // Fallback: không lấy được thông tin từ API
    return 'Không thể lấy thông tin credit từ Grok/OpenAI thông qua API. Có thể endpoint này không public; vui lòng kiểm tra biến môi trường GROK_API_KEY hoặc dashboard nhà cung cấp để biết chi tiết.';
  }

  /**
   * Trả về template prompt hiện tại để người dùng xem cấu trúc
   */
  public async getPromptTemplate(): Promise<string> {
    // Lấy dữ liệu thị trường hiện tại làm ví dụ
    const market = await this.marketSignalService.getMarketContext();
    
    // Tạo prompt mẫu với nội dung ví dụ
    const exampleContent = '[Ví dụ: Nội dung bài viết từ Trump trên Truth Social]';
    return this.buildPrompt(exampleContent, market);
  }

  /**
   * Trả về prompt cho nội dung bài viết cụ thể
   * (sử dụng dữ liệu thị trường hiện tại)
   */
  public async buildPromptForContent(content: string): Promise<string> {
    const market = await this.marketSignalService.getMarketContext();
    return this.buildPrompt(content, market);
  }
}
