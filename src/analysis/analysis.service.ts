import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AnalysisResult } from '../common/interfaces';
import { MarketSignalService, MarketContextResult } from '../market-signal/market-signal.service';

/** Thrown when the daily API call limit is exceeded. */
export class DailyLimitExceededException extends Error {
  constructor(public readonly count: number, public readonly shouldAlert: boolean) {
    super(`Đã đạt giới hạn API calls/ngày (lần gọi thứ ${count}). Tạm dừng đến 0:00 ngày mai.`);
    this.name = 'DailyLimitExceededException';
  }
}

/**
 * AnalysisService v5 — OpenRouter (free models), market-aware, rate-limited.
 *
 * - Provider: OpenRouter (https://openrouter.ai)
 * - Model mặc định: meta-llama/llama-3.3-70b-instruct:free (miễn phí)
 * - Vision: không hỗ trợ với free models → bỏ qua mediaUrls
 * - Rate limit: tối đa 500 API calls/ngày (phòng ngừa), reset lúc 0:00
 * - Logging: đầy đủ call count, lỗi chi tiết
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly openrouterApiKey: string;
  private readonly openrouterApiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  private currentModel = 'nvidia/nemotron-3-ultra-550b-a55b:free';
  private readonly DAILY_LIMIT = 500;

  // Static model list for OpenRouter free models
  static readonly STATIC_MODELS: Array<{ name: string; inputPrice: number; outputPrice: number }> = [
    { name: 'nvidia/nemotron-3-ultra-550b-a55b:free', inputPrice: 0, outputPrice: 0 },
    { name: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: 0, outputPrice: 0 },
    { name: 'meta-llama/llama-3.1-8b-instruct:free', inputPrice: 0, outputPrice: 0 },
    { name: 'google/gemma-3-27b-it:free', inputPrice: 0, outputPrice: 0 },
    { name: 'google/gemma-3-12b-it:free', inputPrice: 0, outputPrice: 0 },
    { name: 'deepseek/deepseek-r1:free', inputPrice: 0, outputPrice: 0 },
    { name: 'mistralai/mistral-7b-instruct:free', inputPrice: 0, outputPrice: 0 },
    { name: 'qwen/qwen3-8b:free', inputPrice: 0, outputPrice: 0 },
  ];

  // Daily rate limit state (in-memory, resets on restart or new calendar day)
  private dailyCallCount = 0;
  private dailyCallDate = '';      // YYYY-MM-DD (server local time)
  private limitAlertSent = false;  // Chỉ gửi cảnh báo Telegram 1 lần/ngày

  constructor(
    private readonly configService: ConfigService,
    private readonly marketSignalService: MarketSignalService,
  ) {
    const apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
    if (!apiKey) this.logger.warn('OPENROUTER_API_KEY chưa được cấu hình trong .env!');
    this.openrouterApiKey = apiKey || '';
    this.logger.log(`[CONFIG] Provider: OpenRouter | Model: ${this.currentModel} | Daily limit: ${this.DAILY_LIMIT} calls/day`);
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

  /** Trả về danh sách model có thể dùng (OpenRouter free models) */
  getAvailableModels(): Array<{ name: string; inputPrice: number; outputPrice: number }> {
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
   * Gọi OpenRouter API (text only — free models không hỗ trợ vision).
   */
  private async callOpenAI(
    content: string,
    mediaUrls: string[] | undefined,
    market: MarketContextResult,
  ): Promise<Omit<AnalysisResult, 'ensembleProbability' | 'severityScore' | 'marketSignalScore' | 'hardRule' | 'matchedRules'>> {
    const prompt = this.buildPrompt(content, market, false);
    this.logger.log(`[API] Gọi ${this.currentModel} via OpenRouter (${content.length} chars)`);

    const startMs = Date.now();
    let response: any;
    try {
      response = await axios.post(
        this.openrouterApiUrl,
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
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 600,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.openrouterApiKey}`,
            'HTTP-Referer': 'https://github.com/trump-btc',
            'X-Title': 'Trump BTC Signal Bot',
          },
          timeout: 60000,
        },
      );
    } catch (err: any) {
      const status = err?.response?.status;
      const body = JSON.stringify(err?.response?.data ?? {}).substring(0, 300);
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[API ERROR] OpenRouter call thất bại | status=${status ?? 'N/A'} | ` +
        `model=${this.currentModel} | daily_calls=${this.dailyCallCount}/${this.DAILY_LIMIT} | ` +
        `error=${errMsg} | response_body=${body}`,
      );
      // 429 = rate limit của OpenRouter free tier → hoàn trả count (không phải call thực sự)
      // và re-throw để PollingService backoff/dừng backfill
      if (status === 429) {
        this.dailyCallCount = Math.max(0, this.dailyCallCount - 1);
        this.logger.warn(`[RATE LIMIT] OpenRouter 429 — hoàn trả dailyCallCount về ${this.dailyCallCount}`);
      }
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
   * Kiểm tra trạng thái OpenRouter API key.
   */
  public async getRemainingCredits(): Promise<string> {
    if (!this.openrouterApiKey) {
      return 'OPENROUTER_API_KEY chưa được cấu hình. Thêm vào .env và restart app.';
    }

    const stats = this.getDailyCallStats();
    const statsStr = `Daily calls hôm nay (${stats.date}): ${stats.count}/${stats.limit}`;

    try {
      // Verify key qua OpenRouter /auth/key endpoint
      const resp = await axios.get('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${this.openrouterApiKey}` },
        timeout: 7000,
      });
      const d = resp.data?.data;
      if (d) {
        const credits = d.usage != null ? `Credit đã dùng: $${Number(d.usage).toFixed(4)}` : '';
        return `OpenRouter key hợp lệ ✅ | Model: ${this.currentModel} | ${statsStr}${credits ? ' | ' + credits : ''}`;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) return `OpenRouter API key không hợp lệ (HTTP 401) | ${statsStr}`;
      return `Lỗi kiểm tra OpenRouter key: ${err instanceof Error ? err.message : String(err)} | ${statsStr}`;
    }

    return `OpenRouter key OK | Model: ${this.currentModel} | ${statsStr}`;
  }

  /**

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
