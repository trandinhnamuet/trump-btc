import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TruthSocialService } from '../truth-social/truth-social.service';
import { BtcPriceService } from '../btc-price/btc-price.service';
import { TelegramService } from '../telegram/telegram.service';
import { StorageService } from '../storage/storage.service';
import { DetectorService } from '../detector/detector.service';
import { PostRecord, TruthSocialPost } from '../common/interfaces';

/**
 * PollingService: Orchestrator chính của ứng dụng.
 *
 * Chịu trách nhiệm:
 * 1. Mỗi 90-120 giây: kiểm tra bài viết mới của Trump trên Truth Social
 * 2. Với mỗi bài mới: chạy DETECTOR (sự kiện lớp A) → alert khẩn nếu trúng,
 *    tin feed im lặng nếu không
 * 3. Mỗi 1 phút: ghi giá BTC thật tại các mốc +1h/+1d/+7d sau mỗi bài
 *    (để đối chiếu điều gì đã xảy ra sau các bài detector alert)
 */
@Injectable()
export class PollingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PollingService.name);

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
    private readonly btcPriceService: BtcPriceService,
    private readonly telegramService: TelegramService,
    private readonly storageService: StorageService,
    private readonly detectorService: DetectorService,
  ) {}

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
      const msg: string = error instanceof Error && error.message ? error.message : String(error);
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
   * Xử lý một bài viết mới: lưu → detector → alert hoặc feed im lặng.
   */
  private async processPost(post: TruthSocialPost): Promise<void> {
    this.logger.log(`Đang xử lý bài viết: ${post.id} (${post.createdAt})`);
    this.logger.log(`Nội dung: ${post.content.substring(0, 100)}...`);

    // Bước 0: bỏ qua nếu bài đã được xử lý trước đó
    const existing = this.storageService.getPostById(post.id);
    if (existing?.alerted) {
      this.logger.log(`Bài ${post.id} đã được xử lý trước đó, bỏ qua.`);
      this.storageService.setLastPostId(post.id);
      return;
    }

    const postTime = new Date(post.createdAt);

    // Bước 1: lấy giá BTC hiện tại
    const btcPrice = await this.btcPriceService.getCurrentPrice();

    // Bước 2: lưu bài vào storage ngay, kèm các mốc kiểm giá sau này
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
      checkAt1h: new Date(postTime.getTime() + 60 * 60 * 1000).toISOString(),
      checkAt1d: new Date(postTime.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      checkAt7d: new Date(postTime.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    this.storageService.savePost(record);

    // ⭐ Cập nhật lastPostId NGAY SAU KHI lưu bài — chống app crash giữa chừng
    this.storageService.setLastPostId(post.id);
    this.logger.debug(`lastPostId cập nhật → ${post.id}`);

    // Bước 3: DETECTOR — phát hiện sự kiện lớp A
    // (tripwire nổ trong mili-giây; checklist LLM ~30s khi tripwire im lặng)
    try {
      const sevenDaysAgo = Date.now() - 7 * 24 * 3_600_000;
      const recentContents = this.storageService
        .getAllPosts()
        .filter(p => p.id !== post.id && new Date(p.createdAt).getTime() >= sevenDaysAgo)
        .map(p => p.content);

      const detection = await this.detectorService.detect(post.content, recentContents);
      this.storageService.updatePost(post.id, { detection });

      if (detection.alert) {
        this.logger.warn(
          `🚨🚨 [DETECTOR] Bài ${post.id} → SỰ KIỆN LỚP ${detection.eventClass} (${detection.eventClassName}) — gửi alert khẩn`,
        );
        await this.telegramService.sendDetectorAlert(post, detection, btcPrice);
      } else {
        // Không phải sự kiện lớp A → tin feed im lặng (không âm thanh) để user
        // vẫn theo dõi được dòng bài đăng mà không bị làm phiền
        await this.telegramService.sendFeedMessage(post, btcPrice);
      }
      this.storageService.updatePost(post.id, { alerted: true });
    } catch (err) {
      this.logger.error(`Detector lỗi bài ${post.id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Nếu lần xử lý này vừa chạm trần API ngày → cảnh báo Telegram đúng một lần
    if (this.detectorService.consumeLimitAlert()) {
      await this.telegramService.sendDailyLimitWarning();
    }

    this.logger.log(`✅ Đã xử lý xong bài ${post.id}`);
  }

  /**
   * CRON: mỗi 1 phút — ghi giá BTC thật tại các mốc +1h/+1d/+7d sau mỗi bài.
   * Đây là dữ liệu đối chiếu "điều gì đã xảy ra" cho các bài detector alert
   * (hiển thị trong /check).
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async updateBtcPrices() {
    if (this.isCheckingPrices) return;

    this.isCheckingPrices = true;
    try {
      const pendingPosts = this.storageService.getPostsPendingPriceCheck();
      if (pendingPosts.length === 0) return;

      this.logger.log(`Cập nhật giá BTC cho ${pendingPosts.length} bài viết...`);

      const currentPrice = await this.btcPriceService.getCurrentPrice();
      if (currentPrice === null) {
        this.logger.warn('Không lấy được giá BTC, bỏ qua cập nhật lần này');
        return;
      }

      const now = new Date();
      for (const post of pendingPosts) {
        const updates: Partial<PostRecord> = {};
        let updated = false;

        if (post.checkAt1h && post.btcPriceAt1h == null && new Date(post.checkAt1h) <= now) {
          updates.btcPriceAt1h = currentPrice;
          updated = true;
          this.logger.log(`📊 Giá BTC +1h cho bài ${post.id}: $${currentPrice.toLocaleString()}`);
        }
        if (post.checkAt1d && post.btcPriceAt1d == null && new Date(post.checkAt1d) <= now) {
          updates.btcPriceAt1d = currentPrice;
          updated = true;
          this.logger.log(`📊 Giá BTC +1d cho bài ${post.id}: $${currentPrice.toLocaleString()}`);
        }
        if (post.checkAt7d && post.btcPriceAt7d == null && new Date(post.checkAt7d) <= now) {
          updates.btcPriceAt7d = currentPrice;
          updated = true;
          this.logger.log(`📊 Giá BTC +7d cho bài ${post.id}: $${currentPrice.toLocaleString()}`);
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
}
