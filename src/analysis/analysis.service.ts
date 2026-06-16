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
  private currentModel = 'openai/gpt-oss-120b:free';
  private readonly DAILY_LIMIT = 500;

  // Static model list for OpenRouter free models (ordered by capability: strongest → weakest)
  // Synced with OpenRouter /api/v1/models on 2026-06-07. vision: true = multimodal.
  // maxTokens: per-model override for /testall (reasoning models need more tokens to finish thinking before JSON output)
  static readonly STATIC_MODELS: Array<{ name: string; inputPrice: number; outputPrice: number; vision?: boolean; maxTokens?: number }> = [
    { name: 'nousresearch/hermes-3-llama-3.1-405b:free',                     inputPrice: 0, outputPrice: 0              },
    { name: 'google/gemma-4-31b-it:free',                                    inputPrice: 0, outputPrice: 0, vision: true  },
    { name: 'openai/gpt-oss-120b:free',                                      inputPrice: 0, outputPrice: 0              },
    { name: 'qwen/qwen3-next-80b-a3b-instruct:free',                         inputPrice: 0, outputPrice: 0              },
    // nemotron-ultra: reasoning model, NVIDIA free tier returns HTTP 200+{error:500} intermittently — needs high maxTokens
    { name: 'nvidia/nemotron-3-ultra-550b-a55b:free',                        inputPrice: 0, outputPrice: 0, maxTokens: 1500 },
    { name: 'nvidia/nemotron-3-super-120b-a12b:free',                        inputPrice: 0, outputPrice: 0              },
    { name: 'openrouter/owl-alpha',                                          inputPrice: 0, outputPrice: 0              },
    { name: 'meta-llama/llama-3.3-70b-instruct:free',                        inputPrice: 0, outputPrice: 0              },
    { name: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', inputPrice: 0, outputPrice: 0              },
    { name: 'google/gemma-4-26b-a4b-it:free',                               inputPrice: 0, outputPrice: 0, vision: true  },
    { name: 'nvidia/nemotron-3-nano-30b-a3b:free',                           inputPrice: 0, outputPrice: 0              },
    { name: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',            inputPrice: 0, outputPrice: 0              },
    { name: 'nvidia/nemotron-nano-12b-v2-vl:free',                           inputPrice: 0, outputPrice: 0, vision: true  },
    // laguna models are deep reasoning models: content=null, JSON only produced after long thinking — needs high maxTokens
    { name: 'poolside/laguna-m.1:free',                                      inputPrice: 0, outputPrice: 0, maxTokens: 1500 },
    { name: 'openai/gpt-oss-20b:free',                                       inputPrice: 0, outputPrice: 0              },
    { name: 'qwen/qwen3-coder:free',                                         inputPrice: 0, outputPrice: 0              },
    { name: 'poolside/laguna-xs.2:free',                                     inputPrice: 0, outputPrice: 0, maxTokens: 1500 },
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

  /** Kiểm tra model có hỗ trợ vision không */
  private modelSupportsVision(modelName: string): boolean {
    return AnalysisService.STATIC_MODELS.find(m => m.name === modelName)?.vision === true;
  }

  /** Trả về danh sách model có thể dùng (OpenRouter free models) */
  getAvailableModels(): Array<{ name: string; inputPrice: number; outputPrice: number; vision?: boolean }> {
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

    // Nếu có ảnh và model hiện tại không hỗ trợ vision → tạm đổi sang vision model mạnh nhất đầu danh sách
    let modelOverride: string | null = null;
    if (hasMedia && !this.modelSupportsVision(this.currentModel)) {
      const visionModel = AnalysisService.STATIC_MODELS.find(m => m.vision);
      if (visionModel) {
        modelOverride = visionModel.name;
        this.logger.log(`[VISION] Bài có ảnh, chuyển tạm sang ${modelOverride} (vision model)`);
      }
    }

    const prevModel = this.currentModel;
    if (modelOverride) this.currentModel = modelOverride;
    let modelResult: Omit<AnalysisResult, 'ensembleProbability' | 'severityScore' | 'marketSignalScore' | 'hardRule' | 'matchedRules'>;
    try {
      modelResult = await this.callOpenAI(textContent, mediaUrls, market);
    } finally {
      if (modelOverride) this.currentModel = prevModel;
    }

    const result: AnalysisResult = {
      ...modelResult,
      ensembleProbability: modelResult.btcInfluenceProbability,
      severityScore: 0,
      marketSignalScore: market.marketSignalScore,
      hardRule: false,
      matchedRules: [],
      modelUsed: modelResult.modelUsed,
    };

    this.logger.log(
      `[DONE] ${result.btcInfluenceProbability}% (${result.btcDirection}) ` +
      `| market=${market.trendLabel} | price=$${market.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} ` +
      `| calls today: ${this.dailyCallCount}/${this.DAILY_LIMIT}`,
    );

    return result;
  }

  /**
   * Gọi OpenRouter API. Nếu model hỗ trợ vision và có ảnh → gửi ảnh kèm theo.
   * Tự động fallback sang model tiếp theo nếu gặp 429/404/empty/JSON-error.
   */
  private async callOpenAI(
    content: string,
    mediaUrls: string[] | undefined,
    market: MarketContextResult,
    failedModels: Set<string> = new Set(),
  ): Promise<Omit<AnalysisResult, 'ensembleProbability' | 'severityScore' | 'marketSignalScore' | 'hardRule' | 'matchedRules'>> {
    failedModels.add(this.currentModel);

    // Helper: thử model tiếp theo chưa bị lỗi
    // Nếu có ảnh → ưu tiên vision model chưa thử, rồi mới dùng text model
    const tryFallback = async (reason: string): Promise<Omit<AnalysisResult, 'ensembleProbability' | 'severityScore' | 'marketSignalScore' | 'hardRule' | 'matchedRules'>> => {
      const hasImages = (mediaUrls?.length ?? 0) > 0;
      const nextModel = hasImages
        ? (AnalysisService.STATIC_MODELS.find(m => m.vision && !failedModels.has(m.name)) ??
           AnalysisService.STATIC_MODELS.find(m => !failedModels.has(m.name)))
        : AnalysisService.STATIC_MODELS.find(m => !failedModels.has(m.name));
      if (!nextModel) {
        this.logger.error(
          `[FALLBACK] Đã thử tất cả ${failedModels.size}/${AnalysisService.STATIC_MODELS.length} models, ` +
          `không còn model nào khả dụng. Lý do cuối: ${reason}`,
        );
        throw new Error(`Tất cả models đều thất bại. Lý do: ${reason}`);
      }
      this.logger.warn(
        `[FALLBACK] ${reason} → chuyển sang ${nextModel.name} ` +
        `(đã thử: ${failedModels.size}/${AnalysisService.STATIC_MODELS.length})`,
      );
      const prevModel = this.currentModel;
      this.currentModel = nextModel.name;
      try {
        return await this.callOpenAI(content, mediaUrls, market, failedModels);
      } finally {
        this.currentModel = prevModel;
      }
    };

    const prompt = this.buildPrompt(content, market, (mediaUrls?.length ?? 0) > 0);
    const supportsVision = this.modelSupportsVision(this.currentModel);
    const hasImages = (mediaUrls?.length ?? 0) > 0 && supportsVision;
    this.logger.log(
      `[API] Gọi ${this.currentModel} via OpenRouter (${content.length} chars` +
      `${hasImages ? `, ${mediaUrls!.length} ảnh` : supportsVision ? '' : ', vision bỏ qua'})`,
    );

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
            {
              role: 'user',
              content: hasImages
                ? [
                    { type: 'text', text: prompt },
                    ...mediaUrls!.slice(0, 4).map(url => ({
                      type: 'image_url',
                      image_url: { url },
                    })),
                  ]
                : prompt,
            },
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
          timeout: 30000,
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
      if (status === 429 || status === 404) {
        // Không tốn call thực — hoàn trả counter
        this.dailyCallCount = Math.max(0, this.dailyCallCount - 1);
        return tryFallback(`HTTP ${status}`);
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
    if (!raw) {
      this.logger.error(`[EMPTY RESPONSE] ${this.currentModel} trả về content rỗng sau ${elapsedMs}ms`);
      return tryFallback(`empty response`);
    }

    const parsed = this.extractJson(raw);
    if (!parsed) {
      this.logger.error(`[JSON ERROR] Không parse được response từ ${this.currentModel}. Raw (${raw.length} chars):\n${raw.substring(0, 300)}`);
      return tryFallback(`JSON parse error`);
    }

    return {
      summary: parsed.summary || 'Không thể tóm tắt',
      btcInfluenceProbability: Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0)),
      btcDirection: this.normalizeDirection(parsed.btcDirection),
      reasoning: parsed.reasoning || '',
      modelUsed: this.currentModel,
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

  /**
   * Chạy phân tích song song với tất cả STATIC_MODELS.
   * Market context được fetch 1 lần duy nhất rồi chia sẻ cho tất cả model.
   * Không tính daily limit — chỉ dùng cho /testall command.
   */
  async analyzeWithAllModels(
    content: string,
  ): Promise<Array<{ model: string; probability: number; direction: 'increase' | 'decrease' | 'neutral'; error?: string; durationMs: number; explanation?: string }>> {
    const safeContent = content?.trim() ?? '';
    if (!safeContent) {
      return AnalysisService.STATIC_MODELS.map(m => ({
        model: m.name,
        probability: 0,
        direction: 'neutral' as const,
        error: 'no content',
        durationMs: 0,
      }));
    }

    const results: Array<{ model: string; probability: number; direction: 'increase' | 'decrease' | 'neutral'; error?: string; durationMs: number; explanation?: string }> = [];
    const BATCH = 4;
    const DELAY_MS = 2000;

    for (let i = 0; i < AnalysisService.STATIC_MODELS.length; i += BATCH) {
      const batch = AnalysisService.STATIC_MODELS.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(async m => {
          const r = await this.callSingleModel(safeContent, m.name);
          return { model: m.name, ...r };
        }),
      );
      results.push(...batchResults);
      if (i + BATCH < AnalysisService.STATIC_MODELS.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }

    return results;
  }

  /** Gọi 1 model cụ thể, không fallback, không đếm daily limit. Retry 1 lần sau 8s nếu gặp 429. */
  private async callSingleModel(
    content: string,
    modelName: string,
    isRetry = false,
    callStart = Date.now(),
  ): Promise<{ probability: number; direction: 'increase' | 'decrease' | 'neutral'; error?: string; durationMs: number; explanation?: string }> {
    const modelMeta = AnalysisService.STATIC_MODELS.find(m => m.name === modelName);
    const maxTokens = modelMeta?.maxTokens ?? 500;
    const ms = () => Date.now() - callStart;

    // Prompt ngắn cho /testall: system role định dạng JSON, user message chỉ có nội dung
    // Tránh verbose Vietnamese (gây truncation) nhưng vẫn giữ system role (cần cho nemotron/laguna)
    const testPrompt = `Trump post: "${content.substring(0, 350)}"\nRate Bitcoin price impact: set btcInfluenceProbability (0-100) and btcDirection.`;
    try {
      const response = await axios.post(
        this.openrouterApiUrl,
        {
          model: modelName,
          messages: [
            {
              role: 'system',
              content:
                'Bitcoin market analyst. Reply with ONLY this JSON (fill values, no extra text):\n' +
                '{"btcInfluenceProbability":0-100,"btcDirection":"increase"|"decrease"|"neutral","summary":"brief","reasoning":"brief"}',
            },
            { role: 'user', content: testPrompt },
          ],
          temperature: 0.1,
          max_tokens: maxTokens,
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

      // Some providers return HTTP 200 with {error: ...} instead of {choices: [...]}
      if (response.data?.error && !response.data?.choices?.length) {
        const errMsg = response.data.error?.message ?? 'provider error';
        const errCode = response.data.error?.code ?? '';
        return { probability: 0, direction: 'neutral', error: `provider ${errCode}: ${String(errMsg).substring(0, 40)}`, durationMs: ms() };
      }

      const msg = response.data?.choices?.[0]?.message;
      // Some reasoning models (e.g. laguna, nemotron-ultra) return content=null and put response in 'reasoning' field
      let raw: string = msg?.content ?? '';
      if (!raw?.trim() && msg?.reasoning) raw = msg.reasoning;
      if (!raw || !raw.trim()) return { probability: 0, direction: 'neutral', error: 'response rỗng', durationMs: ms() };

      const parsed = this.extractJson(raw);
      if (!parsed) {
        this.logger.warn(`[TESTALL] JSON parse failed for ${modelName}. Raw: ${raw.substring(0, 200)}`);
        const preview = raw.substring(0, 40).replace(/\n/g, ' ').trim();
        return { probability: 0, direction: 'neutral', error: `JSON lỗi: "${preview}…"`, durationMs: ms() };
      }

      const explanationRaw = parsed.summary || parsed.reasoning;
      return {
        probability: Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0)),
        direction: this.normalizeDirection(parsed.btcDirection),
        explanation: explanationRaw ? String(explanationRaw).substring(0, 200) : undefined,
        durationMs: ms(),
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429 && !isRetry) {
        await new Promise(resolve => setTimeout(resolve, 8000));
        return this.callSingleModel(content, modelName, true, callStart);
      }
      if (status === 429) {
        const body = err?.response?.data?.error?.message ?? '';
        const meta = err?.response?.data?.error?.metadata?.raw ?? '';
        if (body.includes('free-models-per-day')) return { probability: 0, direction: 'neutral', error: '429: giới hạn ngày (free tier)', durationMs: ms() };
        if (meta.includes('Venice') || body.includes('Venice')) return { probability: 0, direction: 'neutral', error: '429: Venice quá tải', durationMs: ms() };
        if (meta || body.includes('upstream')) return { probability: 0, direction: 'neutral', error: '429: nhà cung cấp quá tải', durationMs: ms() };
        return { probability: 0, direction: 'neutral', error: '429: rate limit', durationMs: ms() };
      }
      if (status === 400) {
        const msg = err?.response?.data?.error?.message ?? '';
        if (msg.includes('not a valid model')) return { probability: 0, direction: 'neutral', error: 'model không tồn tại', durationMs: ms() };
        if (msg.includes('403') && msg.includes('image')) return { probability: 0, direction: 'neutral', error: '400: ảnh bị chặn (403)', durationMs: ms() };
        return { probability: 0, direction: 'neutral', error: `400: ${msg.substring(0, 40)}`, durationMs: ms() };
      }
      if (!status) return { probability: 0, direction: 'neutral', error: 'timeout (>35s)', durationMs: ms() };
      return { probability: 0, direction: 'neutral', error: `HTTP ${status}`, durationMs: ms() };
    }
  }

  /**
   * Trích xuất JSON từ response text của model.
   * Xử lý: <think> blocks, markdown fences, trailing text sau JSON (brace matching).
   */
  private extractJson(raw: string): any | null {
    // Xóa think blocks (deepseek-r1, nemotron reasoning, v.v.)
    let text = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```json\s*\n?/im, '')
      .replace(/\n?```\s*$/im, '')
      .trim();

    // Thử parse trực tiếp (response sạch)
    try { return JSON.parse(text); } catch {}

    // Brace matching: tìm JSON object đầu tiên, xử lý trailing text sau closing }
    // Ví dụ nemotron trả về: {"summary":"...","btcInfluenceProbability":90,...}\n\nExplanation...
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}' && --depth === 0) {
          try { return JSON.parse(text.substring(start, i + 1)); } catch {}
          break;
        }
      }
    }

    return null;
  }
}
