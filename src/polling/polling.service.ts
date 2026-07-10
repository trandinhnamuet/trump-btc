import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { TruthSocialService } from '../truth-social/truth-social.service';
import { AnalysisService, DailyLimitExceededException } from '../analysis/analysis.service';
import { BtcPriceService } from '../btc-price/btc-price.service';
import { TelegramService } from '../telegram/telegram.service';
import { StorageService } from '../storage/storage.service';
import { PostRecord, TruthSocialPost } from '../common/interfaces';

/**
 * PollingService: Orchestrator chính của ứng dụng.
 *
 * Chịu trách nhiệm:
 * 1. Mỗi 90-120 giây: Kiểm tra bài viết mới của Trump trên Truth Social
 * 2. Mỗi 1 phút: Kiểm tra và cập nhật giá BTC tại các mốc (1h, 1 ngày, 7 ngày)
 */
@Injectable()
export class PollingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PollingService.name);

  // Ngưỡng xác suất để gửi alert (lấy từ .env, mặc định 90%)
  private readonly threshold: number;

  // Flag để tránh chạy song song nếu lần poll trước chưa xong
  private isPolling = false;
  private isCheckingPrices = false;
  private isRefitting = false;

  // Dynamic polling fields
  private pollTimer: NodeJS.Timeout | null = null;
  private consecutive403 = 0;
  private pauseUntil = 0;
  private readonly POLL_MIN_MS = 90_000;  // 90 seconds
  private readonly POLL_MAX_MS = 120_000; // 120 seconds

  constructor(
    private readonly truthSocialService: TruthSocialService,
    private readonly analysisService: AnalysisService,
    private readonly btcPriceService: BtcPriceService,
    private readonly telegramService: TelegramService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {
    this.threshold = parseInt(
      this.configService.get<string>('BTC_INFLUENCE_THRESHOLD') || '90',
    );
    this.logger.log(`Ngưỡng gửi alert: ${this.threshold}% xác suất ảnh hưởng BTC`);
  }

  onModuleInit() {
    // Warm-up delay 10s then start dynamic polling at 90-120s intervals
    this.schedulePoll(10_000);
    // Backfill: re-process any stored posts that never got OpenAI analysis
    setTimeout(() => this.reprocessUnanalyzed(), 5_000);
  }

  onModuleDestroy() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Schedule the next poll with a random 90-120s interval (or a custom delay for backoff). */
  private schedulePoll(delayMs?: number) {
    const jitter = this.POLL_MIN_MS + Math.floor(Math.random() * (this.POLL_MAX_MS - this.POLL_MIN_MS));
    const delay = delayMs !== undefined ? delayMs : jitter;
    this.pollTimer = setTimeout(async () => {
      await this.pollTruthSocial();
      // If still in backoff, wait out the remaining time before next poll
      const remaining = this.pauseUntil - Date.now();
      if (remaining > 0) {
        this.logger.warn(`Next poll after backoff: ${Math.round(remaining / 60000)} phút nữa`);
        this.schedulePoll(remaining + 5_000);
      } else {
        this.schedulePoll();
      }
    }, delay);
    this.logger.debug(`Poll tiếp theo sau ${Math.round(delay / 1000)}s`);
  }

  /**
   * Chạy 1 lần khi khởi động: re-process các bài trong storage chưa có phân tích OpenAI.
   * Xảy ra khi app bị crash giữa chừng trước khi OpenAI trả về kết quả.
   */
  private async reprocessUnanalyzed() {
    const unanalyzed = this.storageService.getUnanalyzedPosts();
    if (unanalyzed.length === 0) return;

    this.logger.log(`🔄 Backfill: tìm thấy ${unanalyzed.length} bài chưa được phân tích, đang xử lý lại...`);
    const EXPIRY_MS = 60 * 60 * 1000; // 1 giờ
    const now = Date.now();

    for (const record of unanalyzed) {
      // Bỏ qua nếu bài đã quá 1 giờ trong hàng chờ (tính theo fetchedAt)
      const fetchedAt = record.fetchedAt ? new Date(record.fetchedAt).getTime() : 0;
      const ageMs = now - fetchedAt;
      if (fetchedAt > 0 && ageMs > EXPIRY_MS) {
        const ageMinutes = Math.round(ageMs / 60_000);
        this.storageService.addSkippedExpiredPost({
          postId: record.id,
          content: record.content.substring(0, 150),
          fetchedAt: record.fetchedAt,
          skippedAt: new Date().toISOString(),
          ageMinutes,
          url: record.url,
        });
        // Đánh dấu đã xử lý để không retry vô hạn
        this.storageService.updatePost(record.id, {
          btcInfluenceProbability: 0,
          ensembleProbability: 0,
          btcDirection: 'neutral',
          summary: `Bỏ qua: bài đã ${ageMinutes} phút trong hàng chờ (>60 phút).`,
          reasoning: `Skipped by expiry check — fetchedAt=${record.fetchedAt}`,
        });
        continue;
      }

      const post = { id: record.id, content: record.content, createdAt: record.createdAt, url: record.url, mediaUrls: record.mediaUrls };
      try {
        const btcPrice = record.btcPriceAtPost ?? null;
        // Backfill: bỏ qua mediaUrls vì URL ảnh Truth Social hết hạn nhanh → gây invalid_image_url
        // Nếu bài chỉ có ảnh (không có text), gate sẽ chặn mà không tốn API call
        const analysis = await this.analysisService.analyzePost(post.content, [], post.id, post.createdAt);
        this.storageService.updatePost(post.id, {
          summary: analysis.summary,
          btcInfluenceProbability: analysis.btcInfluenceProbability,
          ensembleProbability: analysis.ensembleProbability,
          severityScore: analysis.severityScore,
          marketSignalScore: analysis.marketSignalScore,
          hardRule: analysis.hardRule,
          matchedRules: analysis.matchedRules,
          btcDirection: analysis.btcDirection,
          reasoning: analysis.reasoning,
          modelUsed: analysis.modelUsed,
          scoring: analysis.scoring,
        });
        this.logger.log(
          `🔄 Backfill bài ${post.id}: model=${analysis.btcInfluenceProbability}% ensemble=${analysis.ensembleProbability}% (${analysis.btcDirection})${
            analysis.hardRule ? ' ⚠️ HARD RULE' : ''
          }`,
        );
        const silent = analysis.ensembleProbability < 10;
        this.logger.log(
          silent
            ? `📋 Backfill bài ${post.id}: ensemble ${analysis.ensembleProbability}% < 10% → Gửi silent`
            : `🚨 Backfill bài ${post.id}: ensemble ${analysis.ensembleProbability}% >= 10% → Gửi alert!`,
        );
        await this.telegramService.sendAlert(
          { id: post.id, content: post.content, createdAt: post.createdAt, url: post.url },
          analysis,
          btcPrice,
          silent,
        );
        this.storageService.updatePost(post.id, { alerted: true });
      } catch (err) {
        if (err instanceof DailyLimitExceededException) {
          this.logger.error(
            `[BACKFILL] Dừng backfill: ${err.message} | Đã xử lý một phần, còn lại sẽ được backfill sau khi restart.`,
          );
          if (err.shouldAlert) {
            await this.telegramService.sendDailyLimitWarning();
          }
          break; // Dừng backfill loop ngay
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        // 429 = OpenRouter rate limit → dừng backfill, thử lại sau
        const is429 = errMsg.includes('status code 429') || (err as any)?.response?.status === 429;
        if (is429) {
          this.logger.warn(`[BACKFILL] OpenRouter 429 rate limit — dừng backfill, sẽ thử lại sau khi restart.`);
          break;
        }
        this.logger.error(`Backfill lỗi bài ${post.id}: ${errMsg}`);
        // Lỗi 400 (invalid_image_url, nội dung bị từ chối...) là lỗi vĩnh viễn
        // Đánh dấu đã phân tích để tránh retry vô hạn mỗi lần restart
        const isPermError =
          errMsg.includes('status code 400') ||
          (err as any)?.response?.status === 400;
        if (isPermError) {
          this.storageService.updatePost(post.id, {
            btcInfluenceProbability: 0,
            ensembleProbability: 0,
            btcDirection: 'neutral',
            summary: 'Phân tích thất bại: URL ảnh không hợp lệ hoặc đã hết hạn.',
            reasoning: errMsg,
          });
          this.logger.warn(
            `[BACKFILL] Bài ${post.id}: lỗi 400 vĩnh viễn → đánh dấu đã phân tích (0%) để bỏ qua lần sau.`,
          );
        }
      }
    }
    this.logger.log('🔄 Backfill hoàn tất.');
  }

  /** Poll Truth Social for new posts. Called by schedulePoll. */
  async pollTruthSocial() {
    if (this.isPolling) {
      this.logger.debug('Poll đang chạy, bỏ qua lần này...');
      return;
    }

    this.isPolling = true;
    try {
      const lastPostId = this.storageService.getLastPostId();
      this.logger.debug(`Polling Truth Social... (lastPostId: ${lastPostId || 'chưa có'})`);

      // Lấy tất cả bài mới từ lần check cuối
      // Nếu là lần đầu (lastPostId = null), chỉ lấy 1 bài mới nhất để tránh spam
      let posts: TruthSocialPost[];
      if (!lastPostId) {
        // Lần đầu chạy: chỉ lấy bài mới nhất, lưu ID, không xử lý
        const initialPosts = await this.truthSocialService.getLatestPosts(null);
        if (initialPosts.length > 0) {
          // initialPosts đã được reverse (cũ nhất trước), bài mới nhất là cuối mảng
          const latestPost = initialPosts[initialPosts.length - 1];
          this.storageService.setLastPostId(latestPost.id);
          this.logger.log(
            `Lần đầu khởi động. Lưu ID bài mới nhất: ${latestPost.id}. Sẽ watch từ bài tiếp theo.`,
          );
        }
        return;
      }

      // Các lần tiếp theo: lấy tất cả bài mới hơn lastPostId
      posts = await this.truthSocialService.getLatestPosts(lastPostId);
      // Fetch thành công → reset backoff
      this.consecutive403 = 0;
      this.pauseUntil = 0;

      if (posts.length === 0) {
        this.logger.debug('Không có bài viết mới.');
        return;
      }

      this.logger.log(`🆕 Tìm thấy ${posts.length} bài viết mới của Trump!`);

      // Xử lý tuần tự từng bài (từ cũ đến mới - đã được reverse trong TruthSocialService)
      for (const post of posts) {
        await this.processPost(post);
      }
    } catch (error) {
      const msg: string = error instanceof Error && error.message ? error.message : String(error);
      if (msg.includes('HTTP 403')) {
        // Exponential backoff: 5 min → 10 min → 20 min … cap 1 hour
        this.consecutive403++;
        const base = 5 * 60 * 1000;
        const cap = 60 * 60 * 1000;
        const backoffMs = Math.min(cap, base * Math.pow(2, this.consecutive403 - 1));
        this.pauseUntil = Date.now() + backoffMs;
        this.logger.warn(`Truth Social 403 (lần #${this.consecutive403}); backoff ${Math.round(backoffMs / 60000)} phút`);
      } else if (error instanceof DailyLimitExceededException) {
        this.logger.warn(`[RATE LIMIT] Dừng poll cycle: đã đạt giới hạn API ngày hôm nay.`);
      } else {
        this.logger.error('Lỗi trong quá trình polling:', msg);
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * CRON JOB 2: Chạy mỗi 1 phút.
   * Kiểm tra các bài viết cần cập nhật giá BTC (1h, 1 ngày, 7 ngày sau khi đăng).
   * Đây là cơ chế để đánh giá độ chính xác của dự đoán.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async updateBtcPrices() {
    if (this.isCheckingPrices) return;

    this.isCheckingPrices = true;
    try {
      // Lấy danh sách bài cần kiểm tra giá
      const pendingPosts = this.storageService.getPostsPendingPriceCheck();

      if (pendingPosts.length === 0) {
        return;
      }

      this.logger.log(`Cập nhật giá BTC cho ${pendingPosts.length} bài viết...`);

      // Lấy giá BTC hiện tại một lần (dùng cho tất cả bài đến hạn)
      const currentPrice = await this.btcPriceService.getCurrentPrice();
      if (currentPrice === null) {
        this.logger.warn('Không lấy được giá BTC, bỏ qua cập nhật lần này');
        return;
      }

      const now = new Date();

      for (const post of pendingPosts) {
        const updates: Partial<PostRecord> = {};
        let updated = false;

        // Kiểm tra mốc 1 giờ
        if (
          post.checkAt1h &&
          post.btcPriceAt1h == null &&
          new Date(post.checkAt1h) <= now
        ) {
          updates.btcPriceAt1h = currentPrice;
          updated = true;
          this.logger.log(`📊 Cập nhật giá BTC 1h cho bài ${post.id}: $${currentPrice.toLocaleString()}`);
        }

        // Kiểm tra mốc 1 ngày
        if (
          post.checkAt1d &&
          post.btcPriceAt1d == null &&
          new Date(post.checkAt1d) <= now
        ) {
          updates.btcPriceAt1d = currentPrice;
          updated = true;
          this.logger.log(`📊 Cập nhật giá BTC 1d cho bài ${post.id}: $${currentPrice.toLocaleString()}`);
        }

        // Kiểm tra mốc 7 ngày
        if (
          post.checkAt7d &&
          post.btcPriceAt7d == null &&
          new Date(post.checkAt7d) <= now
        ) {
          updates.btcPriceAt7d = currentPrice;
          updated = true;
          this.logger.log(`📊 Cập nhật giá BTC 7d cho bài ${post.id}: $${currentPrice.toLocaleString()}`);

          // Khi đã có đủ 7d, log tóm tắt độ chính xác
          this.logAccuracySummary(post, updates.btcPriceAt7d, currentPrice);
        }

        if (updated) {
          this.storageService.updatePost(post.id, updates);
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Lỗi khi cập nhật giá BTC: ' + errMsg);
    } finally {
      this.isCheckingPrices = false;
    }
  }

  /**
   * Xử lý một bài viết mới: phân tích → lưu → gửi alert nếu cần.
   */
  private async processPost(post: TruthSocialPost): Promise<void> {
    this.logger.log(`Đang xử lý bài viết: ${post.id} (${post.createdAt})`);
    this.logger.log(`Nội dung: ${post.content.substring(0, 100)}...`);

    // Bước 0: Bỏ qua nếu bài đã được phân tích thành công trước đó
    const existing = this.storageService.getPostById(post.id);
    if (existing?.btcInfluenceProbability != null) {
      this.logger.log(`Bài ${post.id} đã được phân tích trước đó (${existing.btcInfluenceProbability}%), bỏ qua.`);
      this.storageService.setLastPostId(post.id);
      return;
    }

    const postTime = new Date(post.createdAt);

    // Bước 1: Lấy giá BTC hiện tại (trước khi phân tích để có timestamp chính xác)
    const btcPrice = await this.btcPriceService.getCurrentPrice();

    // Bước 2: Lưu bài viết vào storage ngay (với basic data trước)
    // Các mốc check giá dựa trên thời gian Trump đăng bài
    const record: PostRecord = {
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      url: post.url,
      fetchedAt: new Date().toISOString(),
      alerted: false,
      btcPriceAtPost: btcPrice ?? undefined,
      btcPriceAt1h: null,
      btcPriceAt1d: null,
      btcPriceAt7d: null,
      mediaUrls: post.mediaUrls,
      // Các mốc kiểm tra giá BTC sau khi bài được đăng
      checkAt1h: new Date(postTime.getTime() + 60 * 60 * 1000).toISOString(), // +1 giờ
      checkAt1d: new Date(postTime.getTime() + 24 * 60 * 60 * 1000).toISOString(), // +1 ngày
      checkAt7d: new Date(postTime.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), // +7 ngày
    };

    this.storageService.savePost(record);

    // ⭐ Cập nhật lastPostId NGAY SAU KHI lưu bài - trước khi gọi OpenAI
    // Tránh tình huống app crash giữa chừng khiến poll sau tìm lại bài cũ
    this.storageService.setLastPostId(post.id);
    this.logger.debug(`lastPostId cập nhật → ${post.id}`);

    // Bước 3: Phân tích bằng ensemble + hiệu chuẩn
    try {
      const analysis = await this.analysisService.analyzePost(
        post.content,
        post.mediaUrls,
        post.id,
        post.createdAt,
      );

      // Cập nhật record với kết quả phân tích
      // ⭐ LƯU Ý: Phân tích được LƯU VÀO STORAGE cho TẤT CẢ BÀI, không chỉ những bài > ngưỡng
      this.storageService.updatePost(post.id, {
        summary: analysis.summary,
        btcInfluenceProbability: analysis.btcInfluenceProbability,
        ensembleProbability: analysis.ensembleProbability,
        severityScore: analysis.severityScore,
        marketSignalScore: analysis.marketSignalScore,
        hardRule: analysis.hardRule,
        matchedRules: analysis.matchedRules,
        btcDirection: analysis.btcDirection,
        reasoning: analysis.reasoning,
        modelUsed: analysis.modelUsed,
        scoring: analysis.scoring,
      });
      const s = analysis.scoring;
      this.logger.log(
        `📊 Đã lưu phân tích bài ${post.id}: ${analysis.btcInfluenceProbability}% (${analysis.btcDirection})` +
          (s
            ? ` | base rate=${(s.baseRate * 100).toFixed(1)}% | ${s.calibrated ? 'isotonic' : 'prior+bằng chứng'}` +
              ` | đồng thuận=${(s.agreement * 100).toFixed(0)}%`
            : ' | gate loại'),
      );

      // Bước 4: Luôn gửi Telegram. Dùng ensembleProbability cho quyết định silent vs. alert
      const silent = analysis.ensembleProbability < 10;
      this.logger.log(
        silent
          ? `📋 Ensemble ${analysis.ensembleProbability}% < 10% → Gửi silent`
          : `🚨 ENSEMBLE ${analysis.ensembleProbability}% >= 10% → Gửi Telegram alert!`,
      );
      await this.telegramService.sendAlert(post, analysis, btcPrice, silent);
      this.storageService.updatePost(post.id, { alerted: true });
    } catch (error) {
      // Nếu OpenAI lỗi, vẫn tiếp tục (đã lưu basic data, sẽ thiếu analysis)
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Lỗi phân tích OpenAI cho bài ${post.id}: ${errMsg}`);
      if (error instanceof DailyLimitExceededException) {
        if (error.shouldAlert) {
          await this.telegramService.sendDailyLimitWarning();
        }
        // Re-throw để dừng xử lý các bài còn lại trong cùng poll cycle
        throw error;
      }
    }

    this.logger.log(`✅ Đã xử lý xong bài ${post.id}`);
  }

  /**
   * CRON JOB 3: mỗi giờ — vòng lặp đóng của hệ thống hiệu chuẩn.
   *
   * Lấy giá thật từ Binance cho các dự đoán đã quá mốc 1 giờ, gắn nhãn
   * (|z| >= 2 hay không), rồi fit lại đường hiệu chuẩn của từng model và cập nhật
   * base rate. Không có bước này, mọi con số % chỉ là phỏng đoán không kiểm chứng.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async refitCalibration() {
    if (this.isRefitting) return;
    this.isRefitting = true;
    try {
      const report = await this.analysisService.refitCalibration();
      if (report.newlyLabeled > 0) {
        const fitted = report.perModel.filter(p => p.fitted);
        this.logger.log(
          `🎯 [HIỆU CHUẨN] +${report.newlyLabeled} nhãn mới | ${report.totalLabeled} bài có nhãn | ` +
            `base rate=${(report.baseRate * 100).toFixed(1)}% | P(up|moved)=${(report.upRateGivenMove * 100).toFixed(1)}%` +
            (fitted.length
              ? ` | đã fit: ${fitted.map(p => `${p.model.split('/').pop()} (n=${p.n}, Brier=${p.brier.toFixed(3)})`).join(', ')}`
              : ' | chưa model nào đủ mẫu để fit'),
        );
      }
    } catch (err) {
      this.logger.error(`Lỗi refit hiệu chuẩn: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isRefitting = false;
    }
  }

  /**
   * Log tham khảo khi đã có đủ dữ liệu 7 ngày.
   *
   * Lưu ý: đây KHÔNG phải thước đo chính thức. Sự kiện đích của hệ thống là biến
   * động bất thường trong 1 giờ (|z| >= 2), được chấm bởi refitCalibration().
   * Ngưỡng ±1% sau 7 ngày dưới đây không tính đến độ biến động của chế độ thị
   * trường, nên gần như luôn "trúng" khi vol cao và luôn "trượt" khi vol thấp.
   */
  private logAccuracySummary(post: PostRecord, btcPrice7d: number, currentPrice: number): void {
    if (!post.btcPriceAtPost || !post.btcInfluenceProbability) return;

    const change7d = ((currentPrice - post.btcPriceAtPost) / post.btcPriceAtPost) * 100;
    const predictedDirection = post.btcDirection;
    const actualDirection = change7d > 1 ? 'increase' : change7d < -1 ? 'decrease' : 'neutral';
    const isCorrect = predictedDirection === actualDirection;

    this.logger.log(
      `📊 [7 NGÀY, tham khảo] Bài ${post.id}: ` +
      `Dự đoán=${predictedDirection} (${post.btcInfluenceProbability}%), ` +
      `Thực tế=${actualDirection} (${change7d.toFixed(2)}% sau 7 ngày), ` +
      `Kết quả=${isCorrect ? '✅ ĐÚNG' : '❌ SAI'}`,
    );
  }
}
