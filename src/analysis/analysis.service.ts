import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { AnalysisResult } from '../common/interfaces';
import { MarketSignalService, MarketContextResult } from '../market-signal/market-signal.service';

/** Thrown when the daily API call limit (100/day) is exceeded. */
export class DailyLimitExceededException extends Error {
  constructor(public readonly count: number, public readonly shouldAlert: boolean) {
    super(`Đã đạt giới hạn 100 API calls/ngày (lần gọi thứ ${count}). Tạm dừng đến 0:00 ngày mai.`);
    this.name = 'DailyLimitExceededException';
  }
}

/**
 * AnalysisService v4 — OpenAI gpt-4o-mini, market-aware, rate-limited.
 *
 * - Model: gpt-4o-mini ($0.15/1M input, $0.60/1M output)
 * - Vision: multimodal inline (gpt-4o-mini hỗ trợ ảnh — 1 call duy nhất/post)
 * - Rate limit: tối đa 100 API calls/ngày, reset lúc 0:00 theo giờ server
 * - Logging: đầy đủ call count, tokens ước lượng, lỗi chi tiết
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly openaiApiKey: string;
  private readonly openaiApiUrl = 'https://api.openai.com/v1/chat/completions';
  private currentModel = 'gpt-4o-mini';
  private readonly DAILY_LIMIT = 100;

  // Static fallback list (used if scripts/models.json is not available)
  static readonly STATIC_MODELS: Array<{ name: string; inputPrice: number; outputPrice: number }> = [
    { name: 'gpt-3.5-turbo', inputPrice: 2, outputPrice: 2 },
    { name: 'gpt-3.5-turbo-16k', inputPrice: 3, outputPrice: 3 },
    { name: 'gpt-4', inputPrice: 15, outputPrice: 45 },
    { name: 'gpt-4.1', inputPrice: 10, outputPrice: 30 },
    { name: 'gpt-4o', inputPrice: 5, outputPrice: 15 },
    { name: 'gpt-4o-mini', inputPrice: 0.15, outputPrice: 0.60 },
    { name: 'gpt-4.1-mini', inputPrice: 0.15, outputPrice: 0.60 },
    { name: 'o4-mini', inputPrice: 0.20, outputPrice: 0.80 },
  ];

  // Daily rate limit state (in-memory, resets on restart or new calendar day)
  private dailyCallCount = 0;
  private dailyCallDate = '';      // YYYY-MM-DD (server local time)
  private limitAlertSent = false;  // Chỉ gửi cảnh báo Telegram 1 lần/ngày

  constructor(
    private readonly configService: ConfigService,
    private readonly marketSignalService: MarketSignalService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) this.logger.warn('OPENAI_API_KEY chưa được cấu hình trong .env!');
    this.openaiApiKey = apiKey || '';
    this.logger.log(`[CONFIG] Model: ${this.currentModel} | Daily limit: ${this.DAILY_LIMIT} calls/day`);
  }

  /** Kiểm tra xem content có phải là URL thuần hoặc RT+URL không có text thực */
  private isUrlOnlyContent(content: string): boolean {
    const stripped = content.trim();
    return /^(RT:\s+)?https?:\/\/\S+(\s+https?:\/\/\S+)*\s*$/.test(stripped);
  }

  /**
   * Kiểm tra và tăng bộ đếm daily call. Tự reset khi sang ngày mới.
   * Throws DailyLimitExceededException nếu đã vượt 100 calls/ngày.
   */
  private checkDailyLimit(): void {
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (ISO-like, timezone-safe)
    if (this.dailyCallDate !== today) {
      if (this.dailyCallCount > 0) {
        this.logger.log(
          `[DAILY RESET] Sang ngày ${today}. Tổng calls ngày qua (${this.dailyCallDate}): ${this.dailyCallCount}/${this.DAILY_LIMIT}`,
        );
      }
      this.dailyCallDate = today;
      this.dailyCallCount = 0;
      this.limitAlertSent = false;
    }

    this.dailyCallCount++;

    // Log ở các mốc cảnh báo
    if ([50, 75, 90, 95, 100].includes(this.dailyCallCount)) {
      this.logger.warn(
        `[RATE LIMIT] ⚠️ Daily API calls: ${this.dailyCallCount}/${this.DAILY_LIMIT} (model=${this.currentModel})`,
      );
    } else {
      this.logger.debug(`[RATE LIMIT] Daily API calls: ${this.dailyCallCount}/${this.DAILY_LIMIT}`);
    }

    if (this.dailyCallCount > this.DAILY_LIMIT) {
      const shouldAlert = !this.limitAlertSent;
      if (shouldAlert) this.limitAlertSent = true;
      this.logger.error(
        `[RATE LIMIT] 🚫 Đã vượt giới hạn ${this.DAILY_LIMIT} API calls/ngày! ` +
        `Call #${this.dailyCallCount} bị chặn. Sẽ reset lúc 0:00.` +
        (shouldAlert ? ' [TELEGRAM ALERT SẼ ĐƯỢC GỬI]' : ' [alert đã gửi trước đó]'),
      );
      throw new DailyLimitExceededException(this.dailyCallCount, shouldAlert);
    }
  }

  /** Trả về thống kê daily call để monitoring */
  getDailyCallStats(): { count: number; limit: number; date: string } {
    return { count: this.dailyCallCount, limit: this.DAILY_LIMIT, date: this.dailyCallDate };
  }

  /** Trả về model đang dùng hiện tại */
  getCurrentModel(): string {
    return this.currentModel;
  }

  /** Estimate prices (per 1M tokens) for a model id using simple heuristics */
  private estimatePrices(modelId: string): { inputPrice: number; outputPrice: number } {
    const id = (modelId || '').toLowerCase();
    const isMini = id.includes('mini') || id.includes('nano');
    const miniFactor = isMini ? 0.1 : 1;
    if (id.startsWith('gpt-5')) return { inputPrice: 25 * miniFactor, outputPrice: 75 * miniFactor };
    if (id.startsWith('gpt-4.1')) return { inputPrice: 10 * miniFactor, outputPrice: 30 * miniFactor };
    if (id.startsWith('gpt-4o')) return { inputPrice: 5 * miniFactor, outputPrice: 15 * miniFactor };
    if (id.startsWith('gpt-4')) return { inputPrice: 15 * miniFactor, outputPrice: 45 * miniFactor };
    if (id.startsWith('gpt-3.5')) return { inputPrice: 2 * miniFactor, outputPrice: 2 * miniFactor };
    return { inputPrice: 5 * miniFactor, outputPrice: 15 * miniFactor };
  }

  /** Trả về danh sách model có thể dùng — đọc từ scripts/models.json nếu có, ngược lại fallback tĩnh */
  getAvailableModels(): Array<{ name: string; inputPrice: number; outputPrice: number }> {
    try {
      const modelsPath = path.join(process.cwd(), 'scripts', 'models.json');
      const pricingPath = path.join(process.cwd(), 'scripts', 'pricing_puppeteer.json');

      // load pricing map if available
      let pricingMap: Record<string, { inputPrice: number; outputPrice: number }> = {};
      if (fs.existsSync(pricingPath)) {
        try {
          const rawP = fs.readFileSync(pricingPath, 'utf8');
          const parsedP = JSON.parse(rawP);
          const m = parsedP?.map || parsedP?.priceMap || parsedP?.map || null;
          if (m && typeof m === 'object') {
            for (const k of Object.keys(m)) {
              const entry = m[k];
              if (entry && (entry.inputPrice != null || entry.outputPrice != null)) {
                pricingMap[k.toLowerCase()] = {
                  inputPrice: Number(entry.inputPrice || entry.input || 0),
                  outputPrice: Number(entry.outputPrice || entry.output || entry.outputPrice || 0),
                };
              }
            }
          }
        } catch (e) {
          this.logger.warn(`Không đọc được scripts/pricing_puppeteer.json: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (fs.existsSync(modelsPath)) {
        const raw = fs.readFileSync(modelsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed?.data) ? parsed.data : [];
        const gptModels = items
          .filter((m: any) => typeof m.id === 'string' && m.id.toLowerCase().startsWith('gpt-'))
          .map((m: any) => {
            const modelId = m.id;
            const heur = this.estimatePrices(modelId);
            const normalized = modelId.toLowerCase();
            const priceOverride = pricingMap[normalized];
            if (priceOverride) {
              return { name: modelId, inputPrice: priceOverride.inputPrice, outputPrice: priceOverride.outputPrice };
            }
            return { name: modelId, inputPrice: heur.inputPrice, outputPrice: heur.outputPrice };
          });
        if (gptModels.length > 0) return gptModels;
      }
    } catch (err) {
      this.logger.warn(`Không đọc được scripts/models.json hoặc pricing file: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Fallback: apply pricing overrides to static list if available
    try {
      const pricingPath = path.join(process.cwd(), 'scripts', 'pricing_puppeteer.json');
      if (fs.existsSync(pricingPath)) {
        const rawP = fs.readFileSync(pricingPath, 'utf8');
        const parsedP = JSON.parse(rawP);
        const m = parsedP?.map || parsedP?.priceMap || parsedP?.map || null;
        if (m && typeof m === 'object') {
          return AnalysisService.STATIC_MODELS.map(s => {
            const override = m[s.name] || m[s.name.toUpperCase()] || m[s.name.toLowerCase()];
            if (override) return { name: s.name, inputPrice: Number(override.inputPrice || override.input || s.inputPrice), outputPrice: Number(override.outputPrice || override.output || s.outputPrice) };
            return s;
          });
        }
      }
    } catch {
      // ignore
    }

    return AnalysisService.STATIC_MODELS;
  }

  /**
   * Đổi model. Throws nếu tên không hợp lệ.
   * @returns Tên model mới
   */
  setModel(modelName: string): string {
    const normalized = modelName.trim().toLowerCase();
    const models = this.getAvailableModels();
    let found = models.find(m => m.name.toLowerCase() === normalized);
    if (!found) {
      // allow matching by prefix (e.g. user types 'gpt-4o-mini' to match 'gpt-4o-mini-2024-07-18')
      found = models.find(m => m.name.toLowerCase().startsWith(normalized));
    }
    if (!found) {
      found = models.find(m => m.name.toLowerCase().includes(normalized));
    }
    if (!found) {
      throw new Error(`Model "${modelName}" không có trong danh sách. Dùng /model-list để xem các model hợp lệ.`);
    }
    this.currentModel = found.name;
    this.logger.log(`[MODEL] Đã đổi model → ${found.name}`);
    return found.name;
  }

  async analyzePost(content: string, mediaUrls?: string[]): Promise<AnalysisResult> {
    const safeContent = content ?? '';
    this.logger.log(
      `[ANALYZE] Bài viết: len=${safeContent.length} chars, images=${mediaUrls?.length ?? 0} | ` +
      `daily_calls=${this.dailyCallCount + 1}/${this.DAILY_LIMIT}`,
    );

    // Kiểm tra rate limit TRƯỚC khi làm bất cứ điều gì (kể cả market data fetch)
    this.checkDailyLimit();

    const hasMedia = mediaUrls && mediaUrls.length > 0;
    const isUrlOnly = this.isUrlOnlyContent(safeContent);

    // Nếu không có gì để phân tích → trả về 0% ngay (không tốn API call)
    if ((!safeContent.trim() && !hasMedia) || (isUrlOnly && !hasMedia)) {
      // Hoàn trả lại 1 count vì không thực sự gọi API
      this.dailyCallCount--;
      this.logger.warn(`[SKIP] Không có nội dung hoặc chỉ là URL — bỏ qua, không gọi API`);
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

    const textContent = isUrlOnly ? '' : safeContent;
    const market = await this.marketSignalService.getMarketContext();

    // Gọi OpenAI với multimodal (ảnh + text trong 1 request duy nhất)
    const modelResult = await this.callOpenAI(textContent, mediaUrls, market);

    const result: AnalysisResult = {
      ...modelResult,
      ensembleProbability: modelResult.btcInfluenceProbability,
      severityScore: 0,
      marketSignalScore: market.marketSignalScore,
      hardRule: false,
      matchedRules: [],
    };

    this.logger.log(
      `[DONE] ${result.btcInfluenceProbability}% (${result.btcDirection}) ` +
      `| market=${market.trendLabel} | price=$${market.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} ` +
      `| calls today: ${this.dailyCallCount}/${this.DAILY_LIMIT}`,
    );

    return result;
  }

  /**
   * Gọi OpenAI gpt-4o-mini. Hỗ trợ multimodal: nếu có ảnh, đưa thẳng vào message
   * (không cần vision call riêng). 1 API call duy nhất cho cả text lẫn ảnh.
   */
  private async callOpenAI(
    content: string,
    mediaUrls: string[] | undefined,
    market: MarketContextResult,
  ): Promise<Omit<AnalysisResult, 'ensembleProbability' | 'severityScore' | 'marketSignalScore' | 'hardRule' | 'matchedRules'>> {
    const hasImages = mediaUrls && mediaUrls.length > 0;
    const prompt = this.buildPrompt(content, market, hasImages);

    // Xây dựng user message — multimodal nếu có ảnh
    let userContent: any;
    if (hasImages) {
      userContent = [
        // Đưa ảnh vào đầu message, detail=low để tiết kiệm token
        ...mediaUrls.map(url => ({ type: 'image_url', image_url: { url, detail: 'low' } })),
        { type: 'text', text: prompt },
      ];
      this.logger.log(`[API] Gọi ${this.currentModel} với ${mediaUrls.length} ảnh + text (multimodal)`);
    } else {
      userContent = prompt;
      this.logger.log(`[API] Gọi ${this.currentModel} với text only (${content.length} chars)`);
    }

    const startMs = Date.now();
    let response: any;
    try {
      response = await axios.post(
        this.openaiApiUrl,
        {
          model: this.currentModel,
          messages: [
            {
              role: 'system',
              content:
                'Bạn là chuyên gia phân tích thị trường Bitcoin hàng đầu, am hiểu sâu về cách tin tức, chính trị, và sự kiện vĩ mô tác động đến tâm lý thị trường và giá BTC. ' +
                'Bạn suy luận từ bản chất sự việc, không theo template. Mỗi phân tích phải đặc thù cho post đó và trạng thái thị trường hiện tại. ' +
                'QUAN TRỌNG: Toàn bộ phần "reasoning" và "summary" phải viết bằng TIẾNG VIỆT.',
            },
            { role: 'user', content: userContent },
          ],
          temperature: 0.3,
          max_tokens: 600,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.openaiApiKey}`,
          },
          timeout: 30000,
        },
      );
    } catch (err: any) {
      const status = err?.response?.status;
      const body = JSON.stringify(err?.response?.data ?? {}).substring(0, 300);
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[API ERROR] OpenAI call thất bại | status=${status ?? 'N/A'} | ` +
        `model=${this.currentModel} | daily_calls=${this.dailyCallCount}/${this.DAILY_LIMIT} | ` +
        `error=${errMsg} | response_body=${body}`,
      );
      throw err;
    }

    const elapsedMs = Date.now() - startMs;
    const usage = response.data?.usage;
    this.logger.log(
      `[API OK] ${this.currentModel} | ${elapsedMs}ms | ` +
      `tokens: in=${usage?.prompt_tokens ?? '?'} out=${usage?.completion_tokens ?? '?'} total=${usage?.total_tokens ?? '?'} | ` +
      `daily_calls=${this.dailyCallCount}/${this.DAILY_LIMIT}`,
    );

    const raw: string = response.data?.choices?.[0]?.message?.content ?? '';
    if (!raw) throw new Error('OpenAI trả về response rỗng');

    // Strip markdown code fences nếu có (gpt-4o-mini đôi khi wrap trong ```json```)
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      this.logger.error(`[JSON ERROR] Không parse được response. Raw (${raw.length} chars):\n${raw.substring(0, 500)}`);
      throw new Error('OpenAI response không phải JSON hợp lệ');
    }

    return {
      summary: parsed.summary || 'Không thể tóm tắt',
      btcInfluenceProbability: Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0)),
      btcDirection: this.normalizeDirection(parsed.btcDirection),
      reasoning: parsed.reasoning || '',
    };
  }


  private buildPrompt(content: string, market: MarketContextResult, hasImages = false): string {
    const contentSection = hasImages && !content.trim()
      ? '[Bài đăng chỉ có hình ảnh, không có văn bản]'
      : content;

    return `Tổng thống Trump vừa post 1 post trên Truth Social với nội dung: ${contentSection}
Bạn là 1 chuyên gia tài chính có kinh nghiệm nhiều năm trong thị trường crypto, hãy đánh giá tỉ lệ % khả năng tác động giá BTC của bài viết trên, và tác động tăng hay giảm.

Trả về ONLY valid JSON:
{
  "summary": "Tóm tắt ngắn nội dung bài viết",
  "btcInfluenceProbability": <số nguyên 0-100>,
  "btcDirection": <"increase" | "decrease">,
  "reasoning": "Giải thích ngắn gọn tác động đến BTC"
}`;
  }

  private normalizeDirection(d?: string): 'increase' | 'decrease' | 'neutral' {
    const s = (d || '').toLowerCase().trim();
    if (s === 'increase' || s === 'up') return 'increase';
    if (s === 'decrease' || s === 'down') return 'decrease';
    return 'neutral';
  }

  /**
   * Kiểm tra credit/quota OpenAI còn lại.
   * OpenAI không có public billing endpoint — chỉ verify key hợp lệ và trả về daily call stats.
   */
  public async getRemainingCredits(): Promise<string> {
    if (!this.openaiApiKey) {
      return 'OPENAI_API_KEY chưa được cấu hình. Thêm vào .env và restart app.';
    }

    const stats = this.getDailyCallStats();
    const statsStr = `Daily calls hôm nay (${stats.date}): ${stats.count}/${stats.limit}`;

    try {
      // Thử lấy billing từ OpenAI Usage API
      const billingCandidates = [
        'https://api.openai.com/v1/dashboard/billing/credit_grants',
        'https://api.openai.com/v1/dashboard/billing/subscription',
      ];
      for (const url of billingCandidates) {
        try {
          const resp = await axios.get(url, {
            headers: { Authorization: `Bearer ${this.openaiApiKey}` },
            timeout: 7000,
          });
          const d = resp.data;
          if (d?.total_available != null) {
            return `OpenAI credit còn lại: $${Number(d.total_available).toFixed(4)} | ${statsStr}`;
          }
          if (d?.hard_limit_usd != null) {
            return `OpenAI quota: hard_limit=$${d.hard_limit_usd}, soft_limit=$${d.soft_limit_usd ?? 'N/A'} | ${statsStr}`;
          }
        } catch {
          continue;
        }
      }

      // Fallback: verify key bằng cách gọi /v1/models
      const resp = await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${this.openaiApiKey}` },
        timeout: 7000,
      });
      if (resp.status === 200) {
        return `OpenAI API key hợp lệ ✅ | Model: ${this.currentModel} | ${statsStr} | Xem billing tại: platform.openai.com/usage`;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) return `OpenAI API key không hợp lệ (HTTP 401) | ${statsStr}`;
      if (status === 429) return `OpenAI rate limit / quota hết (HTTP 429) | ${statsStr}`;
      return `Lỗi kiểm tra OpenAI key: ${err instanceof Error ? err.message : String(err)} | ${statsStr}`;
    }

    return `OpenAI key OK | Model: ${this.currentModel} | ${statsStr} | Billing: platform.openai.com/usage`;
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
