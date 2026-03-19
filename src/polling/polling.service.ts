import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { TruthSocialService } from '../truth-social/truth-social.service';
import { AnalysisService } from '../analysis/analysis.service';
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
      const msg: string = (error && error.message) ? error.message : String(error);
      if (msg.includes('HTTP 403')) {
        // Exponential backoff: 5 min → 10 min → 20 min … cap 1 hour
        this.consecutive403++;
        const base = 5 * 60 * 1000;
        const cap = 60 * 60 * 1000;
        const backoffMs = Math.min(cap, base * Math.pow(2, this.consecutive403 - 1));
        this.pauseUntil = Date.now() + backoffMs;
        this.logger.warn(`Truth Social 403 (lần #${this.consecutive403}); backoff ${Math.round(backoffMs / 60000)} phút`);
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
      this.logger.error('Lỗi khi cập nhật giá BTC:', error.message);
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
      // Các mốc kiểm tra giá BTC sau khi bài được đăng
      checkAt1h: new Date(postTime.getTime() + 60 * 60 * 1000).toISOString(), // +1 giờ
      checkAt1d: new Date(postTime.getTime() + 24 * 60 * 60 * 1000).toISOString(), // +1 ngày
      checkAt7d: new Date(postTime.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), // +7 ngày
    };

    this.storageService.savePost(record);

    // Bước 3: Phân tích bằng OpenAI
    try {
      const analysis = await this.analysisService.analyzePost(post.content);

      // Cập nhật record với kết quả phân tích
      // ⭐ LƯU Ý: Phân tích được LƯU VÀO STORAGE cho TẤT CẢ BÀI, không chỉ những bài > ngưỡng
      this.storageService.updatePost(post.id, {
        summary: analysis.summary,
        btcInfluenceProbability: analysis.btcInfluenceProbability,
        btcDirection: analysis.btcDirection,
        reasoning: analysis.reasoning,
      });
      this.logger.log(
        `📊 Đã lưu phân tích bài ${post.id}: ${analysis.btcInfluenceProbability}% (${analysis.btcDirection}) -> "${analysis.summary}"`,
      );

      // Bước 4: Gửi alert nếu xác suất ảnh hưởng vượt ngưỡng
      if (analysis.btcInfluenceProbability >= this.threshold) {
        this.logger.log(
          `🚨 XÁC SUẤT ${analysis.btcInfluenceProbability}% >= ${this.threshold}% → Gửi Telegram alert!`,
        );
        await this.telegramService.sendAlert(post, analysis, btcPrice);
        this.storageService.updatePost(post.id, { alerted: true });
      } else {
        this.logger.log(
          `➡️  Xác suất ${analysis.btcInfluenceProbability}% < ${this.threshold}%, không gửi alert (nhưng phân tích đã được lưu)`,
        );
      }
    } catch (error) {
      // Nếu OpenAI lỗi, vẫn tiếp tục (đã lưu basic data, sẽ thiếu analysis)
      this.logger.error(`Lỗi phân tích OpenAI cho bài ${post.id}:`, error.message);
    }

    // Bước 5: Cập nhật lastPostId SAU KHI xử lý xong bài này
    this.storageService.setLastPostId(post.id);
    this.logger.log(`✅ Đã xử lý xong bài ${post.id}`);
  }

  /**
   * Log tóm tắt độ chính xác khi đã có đủ dữ liệu 7 ngày.
   */
  private logAccuracySummary(post: PostRecord, btcPrice7d: number, currentPrice: number): void {
    if (!post.btcPriceAtPost || !post.btcInfluenceProbability) return;

    const change7d = ((currentPrice - post.btcPriceAtPost) / post.btcPriceAtPost) * 100;
    const predictedDirection = post.btcDirection;
    const actualDirection = change7d > 1 ? 'increase' : change7d < -1 ? 'decrease' : 'neutral';
    const isCorrect = predictedDirection === actualDirection;

    this.logger.log(
      `📊 [ĐỘ CHÍNH XÁC] Bài ${post.id}: ` +
      `Dự đoán=${predictedDirection} (${post.btcInfluenceProbability}%), ` +
      `Thực tế=${actualDirection} (${change7d.toFixed(2)}% sau 7 ngày), ` +
      `Kết quả=${isCorrect ? '✅ ĐÚNG' : '❌ SAI'}`,
    );
  }
}
