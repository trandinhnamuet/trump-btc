import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { CalibrationService } from '../calibration/calibration.service';
import { AnalysisResult } from '../common/interfaces';
import { MarketContextResult, MarketSignalService } from '../market-signal/market-signal.service';
import { SeverityService } from '../severity/severity.service';
import { ENSEMBLE_POOL, EnsembleResult, EnsembleService } from './ensemble.service';
import { gate } from './gate';
import { extractJson, OpenRouterClient } from './openrouter.client';
import { buildAnalysisPrompt, parseJudgment, PROMPT_VERSION, rawScoreOf } from './prompt-v2';

/** Thrown when the daily API call limit is exceeded. */
export class DailyLimitExceededException extends Error {
  constructor(
    public readonly count: number,
    public readonly shouldAlert: boolean,
  ) {
    super(`Đã đạt giới hạn API calls/ngày (lần gọi thứ ${count}). Tạm dừng đến 0:00 ngày mai.`);
    this.name = 'DailyLimitExceededException';
  }
}

/**
 * AnalysisService v6 — orchestrator mỏng.
 *
 * Luồng cho một bài viết:
 *
 *   gate (0 call)  →  market context + severity  →  ensemble (K model × N mẫu)
 *       →  hiệu chuẩn theo từng model  →  gộp có trọng số Brier  →  ghi nhận để refit
 *
 * Con số xác suất cuối cùng KHÔNG do LLM sinh ra. LLM chỉ cung cấp bằng chứng
 * (đặc trưng có cấu trúc) và thứ hạng (so sánh với thang neo). Tầng hiệu chuẩn
 * biến thứ hạng đó thành xác suất bằng tần suất thực nghiệm đo từ Binance.
 *
 * Xem SCORING.md để hiểu vì sao thiết kế lại như vậy.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly client: OpenRouterClient;
  private readonly openrouterApiKey: string;
  private readonly DAILY_LIMIT = 500;

  /**
   * Ghi đè thủ công qua lệnh /model. null = dùng cả ensemble.
   * Chỉ dành cho thử nghiệm — production luôn chạy ensemble để giữ thang đo ổn định.
   */
  private singleModelOverride: string | null = null;

  // Static model list for OpenRouter free models (ordered by capability: strongest → weakest)
  // Synced with OpenRouter /api/v1/models on 2026-06-07. vision: true = multimodal.
  static readonly STATIC_MODELS: Array<{
    name: string;
    inputPrice: number;
    outputPrice: number;
    vision?: boolean;
    maxTokens?: number;
  }> = [
    { name: 'nvidia/nemotron-nano-12b-v2-vl:free',                           inputPrice: 0, outputPrice: 0, vision: true },
    { name: 'openrouter/owl-alpha',                                          inputPrice: 0, outputPrice: 0 },
    { name: 'nousresearch/hermes-3-llama-3.1-405b:free',                     inputPrice: 0, outputPrice: 0 },
    { name: 'google/gemma-4-31b-it:free',                                    inputPrice: 0, outputPrice: 0, vision: true },
    { name: 'openai/gpt-oss-120b:free',                                      inputPrice: 0, outputPrice: 0 },
    { name: 'qwen/qwen3-next-80b-a3b-instruct:free',                         inputPrice: 0, outputPrice: 0 },
    { name: 'nvidia/nemotron-3-ultra-550b-a55b:free',                        inputPrice: 0, outputPrice: 0, maxTokens: 2000 },
    { name: 'nvidia/nemotron-3-super-120b-a12b:free',                        inputPrice: 0, outputPrice: 0 },
    { name: 'meta-llama/llama-3.3-70b-instruct:free',                        inputPrice: 0, outputPrice: 0 },
    { name: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', inputPrice: 0, outputPrice: 0 },
    { name: 'google/gemma-4-26b-a4b-it:free',                                inputPrice: 0, outputPrice: 0, vision: true },
    { name: 'nvidia/nemotron-3-nano-30b-a3b:free',                           inputPrice: 0, outputPrice: 0 },
    { name: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',            inputPrice: 0, outputPrice: 0 },
    { name: 'poolside/laguna-m.1:free',                                      inputPrice: 0, outputPrice: 0, maxTokens: 2000 },
    { name: 'openai/gpt-oss-20b:free',                                       inputPrice: 0, outputPrice: 0 },
    { name: 'qwen/qwen3-coder:free',                                         inputPrice: 0, outputPrice: 0 },
    { name: 'poolside/laguna-xs.2:free',                                     inputPrice: 0, outputPrice: 0, maxTokens: 2000 },
  ];

  // Daily rate limit state (in-memory, resets on restart or new calendar day)
  private dailyCallCount = 0;
  private dailyCallDate = '';
  private limitAlertSent = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly marketSignalService: MarketSignalService,
    private readonly severityService: SeverityService,
    private readonly calibration: CalibrationService,
    private readonly ensemble: EnsembleService,
  ) {
    const apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
    if (!apiKey) this.logger.warn('OPENROUTER_API_KEY chưa được cấu hình trong .env!');
    this.openrouterApiKey = apiKey || '';
    this.client = new OpenRouterClient(this.openrouterApiKey);
    this.logger.log(
      `[CONFIG] OpenRouter | ensemble pool (${ENSEMBLE_POOL.length} model, lấy 3 model chạy được) | ` +
        `prompt ${PROMPT_VERSION} | daily limit ${this.DAILY_LIMIT} calls/day`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rate limit
  // ─────────────────────────────────────────────────────────────────────────

  /** Tăng bộ đếm daily call, tự reset khi sang ngày mới. Throws khi vượt hạn mức. */
  private checkDailyLimit(): void {
    const today = new Date().toLocaleDateString('sv-SE');
    if (this.dailyCallDate !== today) {
      if (this.dailyCallCount > 0) {
        this.logger.log(
          `[DAILY RESET] Sang ngày ${today}. Tổng calls ngày qua (${this.dailyCallDate}): ` +
            `${this.dailyCallCount}/${this.DAILY_LIMIT}`,
        );
      }
      this.dailyCallDate = today;
      this.dailyCallCount = 0;
      this.limitAlertSent = false;
    }

    this.dailyCallCount++;

    if ([100, 250, 400, 450, 490].includes(this.dailyCallCount)) {
      this.logger.warn(`[RATE LIMIT] ⚠️ Daily API calls: ${this.dailyCallCount}/${this.DAILY_LIMIT}`);
    }

    if (this.dailyCallCount > this.DAILY_LIMIT) {
      const shouldAlert = !this.limitAlertSent;
      if (shouldAlert) this.limitAlertSent = true;
      this.logger.error(
        `[RATE LIMIT] 🚫 Vượt ${this.DAILY_LIMIT} calls/ngày! Call #${this.dailyCallCount} bị chặn.` +
          (shouldAlert ? ' [TELEGRAM ALERT SẼ ĐƯỢC GỬI]' : ' [alert đã gửi trước đó]'),
      );
      throw new DailyLimitExceededException(this.dailyCallCount, shouldAlert);
    }
  }

  getDailyCallStats(): { count: number; limit: number; date: string } {
    return { count: this.dailyCallCount, limit: this.DAILY_LIMIT, date: this.dailyCallDate };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model management
  // ─────────────────────────────────────────────────────────────────────────

  getCurrentModel(): string {
    return this.singleModelOverride ?? `ensemble (3 model từ pool ${ENSEMBLE_POOL.length})`;
  }

  /** Danh sách model override cho lần chấm này, hoặc undefined để ensemble tự duyệt pool. */
  private modelOverride(): string[] | undefined {
    return this.singleModelOverride ? [this.singleModelOverride] : undefined;
  }

  private modelSupportsVision(modelName: string): boolean {
    return AnalysisService.STATIC_MODELS.find(m => m.name === modelName)?.vision === true;
  }

  getAvailableModels(): Array<{ name: string; inputPrice: number; outputPrice: number; vision?: boolean }> {
    return AnalysisService.STATIC_MODELS;
  }

  /**
   * Đặt model đơn lẻ (thử nghiệm), hoặc `ensemble` để quay lại chế độ mặc định.
   *
   * Cảnh báo: chạy model đơn lẻ làm mất tính ổn định của thang đo giữa các bài.
   * Chỉ dùng để soi một model cụ thể, không dùng cho production.
   */
  setModel(modelName: string): string {
    const normalized = modelName.trim().toLowerCase();

    if (normalized === 'ensemble' || normalized === 'default' || normalized === 'auto') {
      this.singleModelOverride = null;
      this.logger.log('[MODEL] Quay lại chế độ ensemble');
      return this.getCurrentModel();
    }

    const models = this.getAvailableModels();
    const found =
      models.find(m => m.name.toLowerCase() === normalized) ??
      models.find(m => m.name.toLowerCase().startsWith(normalized)) ??
      models.find(m => m.name.toLowerCase().includes(normalized));

    if (!found) {
      throw new Error(`Model "${modelName}" không có trong danh sách. Dùng /model-list để xem, hoặc /model ensemble.`);
    }

    this.singleModelOverride = found.name;
    this.logger.warn(
      `[MODEL] Chuyển sang chế độ model đơn lẻ → ${found.name}. ` +
        `Thang đo giữa các bài sẽ không còn ổn định. Dùng "/model ensemble" để quay lại.`,
    );
    return found.name;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phân tích
  // ─────────────────────────────────────────────────────────────────────────

  async analyzePost(content: string, mediaUrls?: string[], postId?: string, createdAt?: string): Promise<AnalysisResult> {
    const safeContent = content ?? '';

    const verdict = gate(safeContent, mediaUrls);
    if (!verdict.pass) {
      this.logger.log(`[GATE] Bỏ qua (${verdict.reason}) — không tốn API call`);
      const market = await this.marketSignalService.getMarketContext();
      return {
        summary: verdict.summary,
        btcInfluenceProbability: 0,
        btcDirection: 'neutral',
        reasoning: `Gate loại bài này: ${verdict.reason}. Không có nội dung để phân tích tác động BTC.`,
        ensembleProbability: 0,
        severityScore: 0,
        marketSignalScore: market.marketSignalScore,
        hardRule: false,
        matchedRules: [],
      };
    }

    const override = this.modelOverride();
    this.logger.log(
      `[ANALYZE] len=${safeContent.length} chars, images=${mediaUrls?.length ?? 0} | ` +
        `${override ? `model đơn lẻ: ${override[0]}` : 'ensemble (pool)'} | ` +
        `daily_calls=${this.dailyCallCount}/${this.DAILY_LIMIT}`,
    );

    const [market, severity] = await Promise.all([
      this.marketSignalService.getMarketContext(),
      Promise.resolve(this.severityService.evaluate(safeContent)),
    ]);

    const result = await this.ensemble.score(
      this.client,
      safeContent,
      market,
      severity.severityScore,
      mediaUrls,
      () => this.checkDailyLimit(),
      m => this.modelSupportsVision(m),
      override,
    );

    // Ghi nhận để chấm điểm khi mốc 1 giờ trôi qua. Không có bước này thì không
    // bao giờ có nhãn, không bao giờ hiệu chuẩn được, và cả hệ thống vĩnh viễn mù.
    if (postId && createdAt) {
      const t0 = Date.parse(createdAt);
      if (!Number.isNaN(t0)) {
        for (const p of result.perModel) {
          this.calibration.record({
            postId,
            t0,
            model: p.model,
            rawScore: p.rawScore,
            pMove: p.pMove,
            rawUp: p.rawUp,
          });
        }
      }
    }

    return this.toAnalysisResult(result, severity.severityScore, severity.matchedRules, market);
  }

  private toAnalysisResult(
    e: EnsembleResult,
    severityScore: number,
    matchedRules: string[],
    market: MarketContextResult,
  ): AnalysisResult {
    const prob = Math.round(e.pMove * 100);

    // Vùng chết quanh 0.5: dưới ngưỡng này, hướng là tung đồng xu và không nên hiển thị.
    const direction: AnalysisResult['btcDirection'] =
      e.pUp >= 0.6 ? 'increase' : e.pUp <= 0.4 ? 'decrease' : 'neutral';

    this.logger.log(
      `[DONE] pMove=${(e.pMove * 100).toFixed(1)}% [${(e.pMoveLow * 100).toFixed(0)}–${(e.pMoveHigh * 100).toFixed(0)}%] ` +
        `| pUp=${(e.pUp * 100).toFixed(0)}% → ${direction} | đồng thuận=${(e.agreement * 100).toFixed(0)}% ` +
        `| base rate=${(e.baseRate * 100).toFixed(1)}% | ${e.calibrated ? 'isotonic' : 'prior+bằng chứng'} ` +
        `| market=${market.trendLabel} | calls=${this.dailyCallCount}/${this.DAILY_LIMIT}`,
    );

    return {
      summary: e.primary.summary || 'Không thể tóm tắt',
      btcInfluenceProbability: prob,
      btcDirection: direction,
      reasoning: e.primary.reasoning || '',
      modelUsed: e.primaryModel,
      ensembleProbability: prob,
      severityScore,
      marketSignalScore: market.marketSignalScore,
      hardRule: false,
      matchedRules,
      scoring: {
        promptVersion: e.promptVersion,
        pMove: e.pMove,
        pUp: e.pUp,
        pMoveLow: e.pMoveLow,
        pMoveHigh: e.pMoveHigh,
        agreement: e.agreement,
        calibrated: e.calibrated,
        baseRate: e.baseRate,
        rawScores: Object.fromEntries(e.perModel.map(p => [p.model, p.rawScore])),
        pMoveByModel: Object.fromEntries(e.perModel.map(p => [p.model, p.pMove])),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Công cụ hỗ trợ lệnh Telegram
  // ─────────────────────────────────────────────────────────────────────────

  /** Trạng thái hiệu chuẩn, cho lệnh /calib. */
  calibrationSummary(): string {
    return this.calibration.summary();
  }

  /** Chạy lại vòng lặp đóng: gắn nhãn các dự đoán đã quá 1h rồi fit lại. */
  async refitCalibration() {
    return this.calibration.refit();
  }

  public async getPromptTemplate(): Promise<string> {
    const market = await this.marketSignalService.getMarketContext();
    return buildAnalysisPrompt(
      '[Ví dụ: Nội dung bài viết từ Trump trên Truth Social]',
      market,
      this.calibration.getBaseRate(),
    );
  }

  public async buildPromptForContent(content: string): Promise<string> {
    const market = await this.marketSignalService.getMarketContext();
    return buildAnalysisPrompt(content, market, this.calibration.getBaseRate());
  }

  public async getRemainingCredits(): Promise<string> {
    if (!this.openrouterApiKey) {
      return 'OPENROUTER_API_KEY chưa được cấu hình. Thêm vào .env và restart app.';
    }

    const stats = this.getDailyCallStats();
    const statsStr = `Daily calls hôm nay (${stats.date}): ${stats.count}/${stats.limit}`;

    try {
      const resp = await axios.get('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${this.openrouterApiKey}` },
        timeout: 7000,
      });
      const d = resp.data?.data;
      if (d) {
        const credits = d.usage != null ? `Credit đã dùng: $${Number(d.usage).toFixed(4)}` : '';
        return `OpenRouter key hợp lệ ✅ | ${this.getCurrentModel()} | ${statsStr}${credits ? ' | ' + credits : ''}`;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) return `OpenRouter API key không hợp lệ (HTTP 401) | ${statsStr}`;
      return `Lỗi kiểm tra OpenRouter key: ${err instanceof Error ? err.message : String(err)} | ${statsStr}`;
    }

    return `OpenRouter key OK | ${this.getCurrentModel()} | ${statsStr}`;
  }

  /**
   * Chạy phân tích song song với tất cả STATIC_MODELS (lệnh /testall).
   *
   * Dùng ĐÚNG prompt của production. Ở v1, /testall dùng một prompt tiếng Anh
   * ngắn, cắt nội dung còn 350 ký tự và bỏ market context — nên kết quả so sánh
   * model không hề phản ánh hành vi thật. Đó là một cái bẫy: mọi kết luận rút ra
   * từ /testall cũ đều nói về một hệ thống không tồn tại.
   */
  async analyzeWithAllModels(
    content: string,
  ): Promise<
    Array<{
      model: string;
      probability: number;
      direction: 'increase' | 'decrease' | 'neutral';
      error?: string;
      durationMs: number;
      explanation?: string;
      rawScore?: number;
    }>
  > {
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

    const market = await this.marketSignalService.getMarketContext();
    const severity = this.severityService.evaluate(safeContent);
    const baseRate = this.calibration.getBaseRate();
    const prompt = buildAnalysisPrompt(safeContent, market, baseRate);

    const results: Awaited<ReturnType<AnalysisService['analyzeWithAllModels']>> = [];
    const BATCH = 4;

    for (let i = 0; i < AnalysisService.STATIC_MODELS.length; i += BATCH) {
      const batch = AnalysisService.STATIC_MODELS.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(async m => {
          const start = Date.now();
          try {
            const res = await this.client.chat({
              model: m.name,
              system:
                'Bạn là chuyên gia phân tích thị trường Bitcoin. Chỉ trả về JSON hợp lệ, không kèm văn bản nào khác.',
              user: prompt,
              temperature: 0.6,
              maxTokens: m.maxTokens ?? 1200,
              timeoutMs: 60_000,
            });

            const judgment = parseJudgment(extractJson(res.raw));
            if (!judgment) {
              const preview = res.raw.substring(0, 40).replace(/\n/g, ' ').trim();
              return {
                model: m.name,
                probability: 0,
                direction: 'neutral' as const,
                error: `JSON lỗi: "${preview}…"`,
                durationMs: Date.now() - start,
              };
            }

            const rawScore = rawScoreOf(judgment, severity.severityScore);
            const { pMove } = this.calibration.calibrate(m.name, rawScore);
            return {
              model: m.name,
              probability: Math.round(pMove * 100),
              direction: judgment.direction,
              explanation: (judgment.summary || judgment.reasoning).substring(0, 200),
              rawScore,
              durationMs: Date.now() - start,
            };
          } catch (err) {
            return {
              model: m.name,
              probability: 0,
              direction: 'neutral' as const,
              error: err instanceof Error ? err.message.substring(0, 60) : String(err),
              durationMs: Date.now() - start,
            };
          }
        }),
      );
      results.push(...batchResults);
      if (i + BATCH < AnalysisService.STATIC_MODELS.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return results;
  }
}
