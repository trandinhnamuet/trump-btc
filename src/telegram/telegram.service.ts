import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import TelegramBot = require('node-telegram-bot-api');
import { AnalysisResult, PostRecord, TruthSocialPost, UserConfig } from '../common/interfaces';
import { AnalysisService } from '../analysis/analysis.service';
import { BtcPriceService } from '../btc-price/btc-price.service';
import { StorageService } from '../storage/storage.service';
import { TruthSocialService } from '../truth-social/truth-social.service';

/**
 * TelegramService: Gửi thông báo alert đến danh sách users khi Trump đăng bài
 * có xác suất ảnh hưởng BTC cao.
 *
 * Danh sách users được đọc từ data/users.json.
 * Bot chạy ở chế độ "send-only" (polling: false) vì chỉ cần gửi tin nhắn.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);

  private bot: TelegramBot | null = null;
  private users: UserConfig['users'] = [];

  // Timer để tránh schedule restart polling nhiều lần liên tiếp
  private pollingRestartTimer: ReturnType<typeof setTimeout> | null = null;
  // Watchdog: kiểm tra định kỳ polling còn sống không
  private pollingWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  // Thời điểm cuối polling_error xảy ra
  private lastPollingErrorAt = 0;

  // Đường dẫn file danh sách users
  private readonly usersFile = path.join(process.cwd(), 'data', 'users.json');
  // File log lưu các alert đã gửi (JSON per line)
  private readonly alertsFile = path.join(process.cwd(), 'data', 'alerts.log');

  // Ngưỡng mặc định toàn cục từ .env (dùng khi user chưa set /thr)
  private readonly globalThreshold: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly analysisService: AnalysisService,
    private readonly btcPriceService: BtcPriceService,
    private readonly storageService: StorageService,
    private readonly truthSocialService: TruthSocialService,
  ) {
    this.globalThreshold = parseInt(
      this.configService.get<string>('BTC_INFLUENCE_THRESHOLD') || '0',
      10,
    );
  }

  /** Khởi tạo bot và load danh sách users khi app start */
  onModuleInit() {
    this.initBot();
    this.loadUsers();
  }

  /** Khởi tạo Telegram Bot */
  private initBot() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN chưa được cấu hình. Telegram alerts sẽ bị bỏ qua.',
      );
      return;
    }

    // polling: true = nhận lệnh từ users, có thể handle /start để lấy Chat ID
    this.bot = new TelegramBot(token, { polling: true });
    
    // Handle /start command để tự động add user vào danh sách
    this.bot.onText(/\/start/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      const userName = msg.chat.first_name || `User${chatId}`;

      try {
        const added = this.addUserToList(chatId, userName);
        if (added) {
          const message = `✅ Xin chào <b>${userName}</b>!\n\n👤 <b>Chat ID:</b> <code>${chatId}</code>\n\n🎉 Bạn đã được thêm vào danh sách nhận alerts từ Trump!`;
          this.bot?.sendMessage(chatId, message, { parse_mode: 'HTML' });
          this.logger.log(`✅ User /start: Đã add ${userName} (${chatId}) vào danh sách`);
        } else {
          const message = `✅ Xin chào <b>${userName}</b>!\n\n👤 <b>Chat ID:</b> <code>${chatId}</code>\n\n📌 Bạn đã có trong danh sách nhận alerts rồi!`;
          this.bot?.sendMessage(chatId, message, { parse_mode: 'HTML' });
          this.logger.log(`ℹ️ User /start: ${userName} (${chatId}) đã tồn tại`);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi xử lý /start: ${errMsg}`);
        this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // Handle /test command để phân tích nội dung do user cung cấp
    // Accept both space and newline after /test and capture all following text
    this.bot.onText(/^\/test(?:\s+)([\s\S]+)/i, async (msg: any, match: any) => {
      const chatId = String(msg.chat.id);
      const content = (match && match[1]) ? match[1].trim() : '';

      // If user sent only '/test' without content, reply with usage help
      if (!content) {
        await this.bot?.sendMessage(
          chatId,
          'ℹ️ Vui lòng gửi nội dung sau lệnh /test, ví dụ:\n/test Tin tức về USD và tỷ giá hối đoái...',
        );
        return;
      }

      // Kiểm tra nếu content là post ID thuần (chỉ số) hoặc Truth Social URL chứa post ID
      const postIdMatch = content.match(/(?:truthsocial\.com\/[^\s]+\/|^)(\d{15,25})(?:\s*$)/);
      if (postIdMatch) {
        const postId = postIdMatch[1];
        await this.bot?.sendMessage(chatId, `⏳ Đang lấy bài viết <code>${postId}</code> từ Truth Social...`, { parse_mode: 'HTML' });
        try {
          const post = await this.truthSocialService.getPostById(postId);
          if (!post || (!post.content && (!post.mediaUrls || !post.mediaUrls.length))) {
            await this.bot?.sendMessage(chatId, `❌ Không tìm thấy bài viết <code>${postId}</code> trên Truth Social.`, { parse_mode: 'HTML' });
            return;
          }
          const previewText = post.content
            ? post.content.substring(0, 200)
            : `[Ảnh đính kèm: ${post.mediaUrls?.length} ảnh]`;
          await this.bot?.sendMessage(chatId, `⏳ Đang phân tích...\n\n<i>${previewText}</i>`, { parse_mode: 'HTML' });
          const analysis = await this.analysisService.analyzePost(post.content, post.mediaUrls);
          const btcPrice = await this.btcPriceService.getCurrentPrice();
          const message = this.buildMessage(post, analysis, btcPrice);
          await this.bot?.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
          this.logger.log(`✅ /test postId ${postId}: ${analysis.btcInfluenceProbability}% (${analysis.btcDirection})`);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`❌ Lỗi /test postId: ${errMsg}`);
          await this.bot?.sendMessage(chatId, `❌ Lỗi lấy bài viết: ${errMsg}`);
        }
        return;
      }

      // Kiểm tra nếu content chỉ là URL
      const isUrlOnly = /^(RT:\s+)?https?:\/\/\S+(\s+https?:\/\/\S+)*\s*$/.test(content.trim());
      if (isUrlOnly) {
        await this.bot?.sendMessage(
          chatId,
          '⚠️ Nội dung bạn gửi chỉ là một URL — AI không thể phân tích link, sẽ bịa nội dung.\n\nVui lòng gửi <b>nội dung văn bản</b> của bài viết.',
          { parse_mode: 'HTML' },
        );
        return;
      }

      try {
        await this.bot?.sendMessage(chatId, '⏳ Đang phân tích...');

        // Analyze the provided content
        const analysis = await this.analysisService.analyzePost(content);

        // Get current BTC price
        const btcPrice = await this.btcPriceService.getCurrentPrice();

        // Format and send the analysis result
        const message = this.buildTestMessage(content, analysis, btcPrice);
        await this.bot?.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });

        this.logger.log(
          `✅ Phân tích /test từ user ${msg.chat.first_name}: xác suất = ${analysis.btcInfluenceProbability}%`,
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi xử lý /test: ${errMsg}`);
        await this.bot?.sendMessage(
          chatId,
          `❌ Lỗi phân tích: ${errMsg}`,
        );
      }
    });

    // Handle /thr command — set per-user alert threshold
    this.bot.onText(/^\/thr(?:\s+(\d+))?$/, async (msg: any, match: any) => {
      const chatId = String(msg.chat.id);
      const numStr = match?.[1];

      // No argument → show current threshold
      if (!numStr) {
        const user = this.users.find(u => u.chatId === chatId);
        if (!user) {
          await this.bot?.sendMessage(chatId, '❌ Bạn chưa đăng ký. Gửi /start trước.');
          return;
        }
        const current = user.threshold ?? this.globalThreshold;
        await this.bot?.sendMessage(
          chatId,
          `📊 <b>Ngưỡng thông báo của bạn:</b> <b>${current}%</b>\n\nDùng <code>/thr 60</code> để đặt ngưỡng mới (0–100).`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      const num = parseInt(numStr, 10);
      if (isNaN(num) || num < 0 || num > 100) {
        await this.bot?.sendMessage(chatId, '❌ Ngưỡng phải là số từ 0 đến 100.\nVí dụ: <code>/thr 60</code>', { parse_mode: 'HTML' });
        return;
      }

      try {
        this.setUserThreshold(chatId, num);
        await this.bot?.sendMessage(
          chatId,
          `✅ Đã đặt ngưỡng thông báo: <b>${num}%</b>\nBạn sẽ chỉ nhận thông báo khi Ensemble Score ≥ ${num}%.`,
          { parse_mode: 'HTML' },
        );
        this.logger.log(`✅ /thr: ${msg.chat.first_name} (${chatId}) đặt ngưỡng = ${num}%`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ /thr lỗi: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // Handle /menu command
    this.bot.onText(/^\/menu$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      const user = this.users.find(u => u.chatId === chatId);
      const currentThr = user?.threshold ?? this.globalThreshold;
      const message = `📋 <b>DANH SÁCH LỆNH</b>\n\n` +
        `🟢 /start — Đăng ký nhận alert tự động từ Trump\n` +
        `💰 /btc — Xem giá BTC hiện tại\n` +
        `📊 /check — 7 bài viết mới nhất có xác suất ảnh hưởng BTC &gt;=30% (kèm link)\n` +
        `📊 /check-all — Tất cả bài viết có xác suất ảnh hưởng BTC &gt;=30% (kèm link)\n` +
        `📅 /check2 — Bảng các tin có xác suất ảnh hưởng BTC &gt;=30% trong 10 ngày gần nhất\n` +        `🔄 /latest — Phân tích lại và gửi lại alert bài mới nhất\n` +        `🧪 /test &lt;nội dung&gt; — Phân tích thủ công một đoạn văn bản\n` +
        `🗑️ /clear dd-mm-yyyy — Xóa các bài viết trước ngày (ví dụ: /clear 31-03-2026)\n` +
        `🎚 /thr &lt;số&gt; — Đặt ngưỡng nhận thông báo (hiện tại: <b>${currentThr}%</b>)\n` +
        `📋 /menu — Hiển thị danh sách lệnh này`;
      await this.bot?.sendMessage(chatId, message, { parse_mode: 'HTML' });
    });

    // Handle /btc command
    this.bot.onText(/^\/btc$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        await this.bot?.sendMessage(chatId, '⏳ Đang lấy giá BTC...');
        const price = await this.btcPriceService.getCurrentPrice();
        const text = price !== null
          ? `💰 <b>Giá BTC hiện tại:</b> <b>$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>
🕐 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`
          : '❌ Không lấy được giá BTC lúc này, vui lòng thử lại sau.';
        await this.bot?.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /btc: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // Handle /check-all command - show all posts with rate >= 30%
    this.bot.onText(/^\/check-all$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        const posts = this.storageService.getAllPosts();
        const filtered = posts
          .filter(p => (p.btcInfluenceProbability ?? 0) >= 30)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        if (filtered.length === 0) {
          await this.bot?.sendMessage(chatId, '📭 Chưa có bài viết nào có xác suất ảnh hưởng BTC &gt;=30%.');
          return;
        }

        const message = this.buildCheckMessage(filtered, 30);
        await this.bot?.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /check-all: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // Handle /check command - show 7 most recent posts with rate >= 30%
    this.bot.onText(/^\/check$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        const posts = this.storageService.getAllPosts();
        const filtered = posts
          .filter(p => (p.btcInfluenceProbability ?? 0) >= 30)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 7);

        if (filtered.length === 0) {
          await this.bot?.sendMessage(chatId, '📭 Chưa có bài viết nào có xác suất ảnh hưởng BTC &gt;=30%.');
          return;
        }

        const message = this.buildCheckMessage(filtered, 30);
        await this.bot?.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /check: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // Handle /clear command - delete posts before a date (format: dd-mm-yyyy)
    this.bot.onText(/^\/clear\s+(\d{2})-(\d{2})-(\d{4})$/, async (msg: any, match: any) => {
      const chatId = String(msg.chat.id);
      try {
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10);
        const year = parseInt(match[3], 10);

        // Validate date
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          await this.bot?.sendMessage(chatId, '❌ Ngày không hợp lệ. Định dạng: /clear dd-mm-yyyy');
          return;
        }

        // Create date at 00:00:00 UTC
        const beforeDate = new Date(year, month - 1, day);
        const deletedCount = this.storageService.deletePostsBefore(beforeDate);

        await this.bot?.sendMessage(
          chatId,
          `✅ Đã xóa <b>${deletedCount}</b> bài viết trước ngày ${day.toString().padStart(2, '0')}-${month.toString().padStart(2, '0')}-${year}`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /clear: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // Handle /check2 command (last 10 days only, rate >= 30%)
    this.bot.onText(/^\/check2$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        const now = new Date();
        const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

        const posts = this.storageService.getAllPosts();
        const filtered = posts
          .filter(p => (p.btcInfluenceProbability ?? 0) >= 30 && new Date(p.createdAt).getTime() >= tenDaysAgo.getTime())
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        if (filtered.length === 0) {
          await this.bot?.sendMessage(chatId, '📭 Chưa có bài viết nào có xác suất ảnh hưởng BTC &gt;=30% trong 10 ngày gần nhất.');
          return;
        }

        const message = this.buildCheckMessage(filtered, 30);
        await this.bot?.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /check2: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // Handle /latest command - re-analyze and resend alert for latest post
    this.bot.onText(/^\/latest$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        const posts = this.storageService.getAllPosts();
        if (posts.length === 0) {
          await this.bot?.sendMessage(chatId, '📭 Chưa có bài viết nào trong storage.');
          return;
        }

        const latestPost = [...posts].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )[0];

        const postedAt = new Date(latestPost.createdAt).toLocaleString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
        });
        await this.bot?.sendMessage(
          chatId,
          `⏳ Đang phân tích lại bài mới nhất...\n\n<i>${latestPost.content.substring(0, 150)}</i>\n\n🕐 Đăng lúc: ${postedAt}`,
          { parse_mode: 'HTML' },
        );

        const analysis = await this.analysisService.analyzePost(latestPost.content, latestPost.mediaUrls);
        const btcPrice = await this.btcPriceService.getCurrentPrice();

        // Cập nhật lại phân tích trong storage
        this.storageService.updatePost(latestPost.id, {
          summary: analysis.summary,
          btcInfluenceProbability: analysis.btcInfluenceProbability,
          ensembleProbability: analysis.ensembleProbability,
          severityScore: analysis.severityScore,
          marketSignalScore: analysis.marketSignalScore,
          hardRule: analysis.hardRule,
          matchedRules: analysis.matchedRules,
          btcDirection: analysis.btcDirection,
          reasoning: analysis.reasoning,
        });

        const post: TruthSocialPost = {
          id: latestPost.id,
          content: latestPost.content,
          createdAt: latestPost.createdAt,
          url: latestPost.url,
        };

        // Gửi alert đến tất cả users (bỏ qua ngưỡng - đây là re-send thủ công)
        this.loadUsers();
        const message = this.buildMessage(post, analysis, btcPrice);
        let sentCount = 0;
        for (const user of this.users) {
          try {
            await this.bot?.sendMessage(user.chatId, message, {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            });
            sentCount++;
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            this.logger.error(`❌ /latest: Không gửi được đến ${user.name}: ${errMsg}`);
          }
        }

        this.logger.log(
          `✅ /latest: Phân tích lại ${latestPost.id} → ${analysis.btcInfluenceProbability}% (${analysis.btcDirection}), gửi cho ${sentCount} users`,
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /latest: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // Suppress noisy polling errors (e.g. 404 when token is a placeholder)
    // Without this handler the error event crashes the process.
    (this.bot as any).on('polling_error', (err: Error) => {
      const msg = err.message || String(err);
      if (msg.includes('404') || msg.includes('401')) {
        this.logger.warn(`Telegram polling: token không hợp lệ hoặc chưa cấu hình (${msg.split('\n')[0]}). Bot sẽ không nhận lệnh cho đến khi token đúng.`);
        // Stop retrying — token won't fix itself at runtime
        this.bot?.stopPolling();
      } else {
        this.lastPollingErrorAt = Date.now();
        this.logger.warn(`Telegram polling error: ${msg.split('\n')[0]}`);
        // Với lỗi mạng (EFATAL, ETIMEDOUT, ECONNRESET...), tự động restart polling sau 5s
        this.schedulePollingRestart();
      }
    });

    // Watchdog: mỗi 2 phút kiểm tra nếu polling bị dừng thì khởi động lại
    this.pollingWatchdogTimer = setInterval(() => this.checkAndRestorePolling(), 2 * 60 * 1000);

    this.logger.log('Telegram Bot đã khởi tạo thành công (polling mode enabled)');
  }

  /** Schedule restart polling sau lỗi mạng, tránh restart nhiều lần liên tiếp */
  private schedulePollingRestart() {
    if (this.pollingRestartTimer) return; // Đã có timer chờ, không thêm nữa
    this.pollingRestartTimer = setTimeout(async () => {
      this.pollingRestartTimer = null;
      await this.restartPolling('network error recovery');
    }, 5000);
  }

  /** Kiểm tra polling còn hoạt động không; nếu tắt thì khởi động lại */
  private async checkAndRestorePolling() {
    if (!this.bot) return;
    const isPolling = (this.bot as any).isPolling?.() ?? false;
    if (!isPolling) {
      this.logger.warn('⚠️ Phát hiện Telegram polling đã dừng (watchdog). Đang khởi động lại...');
      await this.restartPolling('watchdog');
    }
  }

  /** Dừng và khởi động lại polling */
  private async restartPolling(reason: string) {
    if (!this.bot) return;
    try {
      await this.bot.stopPolling();
    } catch (_) { /* bỏ qua lỗi stop */ }
    try {
      await this.bot.startPolling();
      this.logger.log(`🔄 Telegram polling đã được khởi động lại (${reason})`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.error(`❌ Không thể restart Telegram polling: ${errMsg}`);
    }
  }

  /** Load danh sách users từ data/users.json */
  loadUsers() {
    try {
      if (!fs.existsSync(this.usersFile)) {
        this.logger.warn(`Không tìm thấy file ${this.usersFile}`);
        return;
      }
      const raw = fs.readFileSync(this.usersFile, 'utf-8');
      const config: UserConfig = JSON.parse(raw);
      this.users = config.users || [];
      this.logger.log(`Đã load ${this.users.length} Telegram users`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Lỗi đọc file users.json: ' + errMsg);
    }
  }

  /**
   * Cập nhật ngưỡng thông báo của một user.
   */
  private setUserThreshold(chatId: string, threshold: number): void {
    const user = this.users.find(u => u.chatId === chatId);
    if (!user) throw new Error('User chưa đăng ký. Gửi /start trước.');
    user.threshold = threshold;
    const config: UserConfig = { users: this.users };
    fs.writeFileSync(this.usersFile, JSON.stringify(config, null, 2), 'utf-8');
    this.logger.log(`✅ setUserThreshold: ${chatId} → ${threshold}%`);
  }

  /**
   * Thêm user mới vào danh sách nếu chưa tồn tại.
   * @param chatId Telegram Chat ID (string)
   * @param name Tên user
   * @returns true nếu user được thêm mới, false nếu user đã tồn tại
   */
  private addUserToList(chatId: string, name: string): boolean {
    try {
      // Kiểm tra xem user đã tồn tại chưa
      const userExists = this.users.some(u => u.chatId === chatId);
      if (userExists) {
        this.logger.debug(`User ${chatId} đã tồn tại trong danh sách`);
        return false;
      }

      // Thêm user mới
      this.users.push({ chatId, name });

      // Tạo dataDir nếu chưa tồn tại
      const dataDir = path.dirname(this.usersFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Ghi lại file
      const config: UserConfig = { users: this.users };
      fs.writeFileSync(this.usersFile, JSON.stringify(config, null, 2), 'utf-8');

      this.logger.log(`✅ Đã thêm user mới: ${name} (${chatId})`);
      return true;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Lỗi thêm user: ${errMsg}`);
      throw error;
    }
  }

  /**
   * Gửi thông báo alert đến TẤT CẢ users trong danh sách.
   *
   * @param post Bài viết gốc của Trump
   * @param analysis Kết quả phân tích OpenAI
   * @param btcPrice Giá BTC hiện tại (USD)
   * @param silent Nếu true: gửi không có âm thanh (xác suất < 10%)
   */
  async sendAlert(
    post: TruthSocialPost,
    analysis: AnalysisResult,
    btcPrice: number | null,
    silent = false,
  ): Promise<void> {
    if (!this.bot) {
      this.logger.warn('Telegram Bot chưa được cấu hình, bỏ qua alert');
      return;
    }

    if (this.users.length === 0) {
      this.logger.warn('Danh sách Telegram users trống, bỏ qua alert');
      return;
    }

    // Tải lại danh sách users từ file (cho phép cập nhật hot reload)
    this.loadUsers();

    const message = this.buildMessage(post, analysis, btcPrice, silent);

    // Lưu bản ghi alert vào file log (để audit sau này)
    try {
      this.saveAlertToFile(post, analysis, btcPrice, message);
      this.logger.debug(`Đã ghi alert vào file ${this.alertsFile}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Không thể ghi alert vào file: ${errMsg}`);
    }

    // Gửi đến từng user trong danh sách (kiểm tra ngưỡng riêng của từng user)
    const ensembleProb = analysis.ensembleProbability;
    for (const user of this.users) {
      const userThreshold = user.threshold ?? this.globalThreshold;
      if (ensembleProb < userThreshold) {
        this.logger.debug(
          `Bỏ qua ${user.name} (${user.chatId}): ensemble ${ensembleProb}% < ngưỡng ${userThreshold}%`,
        );
        continue;
      }
      try {
        await this.bot.sendMessage(user.chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: silent,
        });
        this.logger.log(
          `Đã gửi alert đến ${user.name} (${user.chatId}) [thr=${userThreshold}%]${silent ? ' [silent]' : ''}`,
        );
      } catch (error) {
        // Không throw - tiếp tục gửi cho các user khác dù 1 user lỗi
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Không thể gửi đến ${user.name} (${user.chatId}): ${errMsg}`,
        );
      }
    }
  }

  /**
   * Ghi một bản ghi alert vào file local để audit.
   * Mỗi dòng là một JSON object chứa thông tin cần thiết.
   */
  private saveAlertToFile(
    post: TruthSocialPost,
    analysis: AnalysisResult,
    btcPrice: number | null,
    message: string,
  ) {
    const dataDir = path.dirname(this.usersFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const record = {
      timestamp: new Date().toISOString(),
      postId: post.id,
      postUrl: post.url,
      postCreatedAt: post.createdAt,
      recipients: this.users.map((u) => u.chatId),
      analysis: {
        summary: analysis.summary,
        btcInfluenceProbability: analysis.btcInfluenceProbability,
        btcDirection: analysis.btcDirection,
        reasoning: analysis.reasoning,
      },
      btcPriceAtSend: btcPrice ?? null,
      messagePreview: message.substring(0, 200),
    };

    fs.appendFileSync(this.alertsFile, JSON.stringify(record) + '\n', 'utf-8');
  }

  /**
   * Xây dựng nội dung tin nhắn Telegram (HTML format).
   */
  private buildMessage(
    post: TruthSocialPost,
    analysis: AnalysisResult,
    btcPrice: number | null,
    silent = false,
  ): string {
    const header = silent
      ? '📋 <b>TRUMP POST</b> <i>(xác suất thấp)</i>'
      : '🚨 <b>TRUMP POST - BTC ALERT!</b>';
    // Build direction indicator with arrow
    let directionDisplay = '';
    if (analysis.btcDirection === 'increase') {
      directionDisplay = '↑ TĂNG';
    } else if (analysis.btcDirection === 'decrease') {
      directionDisplay = '↓ GIẢM';
    } else {
      directionDisplay = '─ TRUNG LẬP';
    }

    const ensembleProb = analysis.ensembleProbability ?? analysis.btcInfluenceProbability;
    const probabilityBar = this.buildProbabilityBar(ensembleProb, analysis.btcDirection);

    const btcPriceText = btcPrice
      ? `$${btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'Không lấy được';

    const postedAt = new Date(post.createdAt).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    // Rút ngắn nội dung nếu quá dài (Telegram giới hạn 4096 ký tự)
    let preview: string;
    if (post.content) {
      preview = post.content.length > 300 ? post.content.substring(0, 297) + '...' : post.content;
    } else if (post.mediaUrls?.length) {
      preview = `[Bài đăng chỉ có ${post.mediaUrls.length} ảnh, không có văn bản]`;
    } else {
      preview = '[Không có nội dung]';
    }

    // Breakdown line: model / severity / market
    const severityPct = Math.round((analysis.severityScore ?? 0) * 100);
    const marketPct = Math.round((analysis.marketSignalScore ?? 0) * 100);
    const breakdownLine = `<i>🤖 Model: ${analysis.btcInfluenceProbability}% | 🔍 Severity: ${severityPct}% | 📈 Market: ${marketPct}%</i>`;

    // Hard rule warning
    const hardRuleLine = analysis.hardRule && analysis.matchedRules?.length
      ? `\n⚠️ <b>HARD RULE:</b> <i>${analysis.matchedRules.join(', ')}</i>`
      : '';

    return `${header}

📢 <b>Bài viết gốc:</b>
<i>${preview}</i>

📝 <b>Tóm tắt:</b>
${analysis.summary}

💡 <b>Lý do:</b> ${analysis.reasoning}

📊 <b>Ensemble Score:</b>
${probabilityBar} <b>${ensembleProb}% ${directionDisplay}</b>
${breakdownLine}${hardRuleLine}

💰 <b>Giá BTC hiện tại:</b> ${btcPriceText}

🕐 <b>Đăng lúc:</b> ${postedAt}
🔗 <a href="${post.url}">Xem bài viết gốc</a>`;
  }

  /**
   * Xây dựng tin nhắn bảng tổng hợp cho /check command.
   * Hiển thị các bài >= threshold kèm link và 4 cột giá BTC.
   */
  private buildCheckMessage(posts: PostRecord[], threshold: number = 30): string {
    const fmtPrice = (p: number | null | undefined): string => {
      if (p == null) return '⏳';
      return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    };

    const fmtChange = (base: number | undefined, later: number | null | undefined): string => {
      if (base == null || later == null) return '';
      const pct = ((later - base) / base) * 100;
      const sign = pct >= 0 ? '+' : '';
      return ` (${sign}${pct.toFixed(1)}%)`;
    };

    const lines: string[] = [`📊 <b>BÀI CÓ XÁC SUẤT ẢNH HƯỞNG BTC &gt;=${threshold}% (${posts.length} bài)</b>\n`];

    posts.forEach((p, i) => {
      const dir = p.btcDirection === 'increase' ? '↑' : p.btcDirection === 'decrease' ? '↓' : '─';
      const date = new Date(p.createdAt).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      const base = p.btcPriceAtPost;
      const link = p.url ? `<a href="${p.url}">🔗 Link</a>` : '';
      lines.push(
        `<b>${i + 1}. [${date}]</b> <b>${p.btcInfluenceProbability}% ${dir}</b> ${link}\n` +
        `   📌 ${(p.summary ?? p.content).substring(0, 80)}...\n` +
        `   💰 Lúc đăng: <code>${fmtPrice(base)}</code>\n` +
        `   ⏱ +1h:  <code>${fmtPrice(p.btcPriceAt1h)}${fmtChange(base, p.btcPriceAt1h)}</code>\n` +
        `   📅 +1d:  <code>${fmtPrice(p.btcPriceAt1d)}${fmtChange(base, p.btcPriceAt1d)}</code>\n` +
        `   📆 +7d:  <code>${fmtPrice(p.btcPriceAt7d)}${fmtChange(base, p.btcPriceAt7d)}</code>`
      );
    });

    return lines.join('\n\n');
  }

  /** Tạo thanh tiến độ dạng text để hiển thị %, với màu sắc dựa vào hướng ảnh hưởng */
  private buildProbabilityBar(probability: number, direction: 'increase' | 'decrease' | 'neutral'): string {
    const filled = Math.round(probability / 10);
    const empty = 10 - filled;

    let filledEmoji = '🟩'; // Green for increase (default)
    let emptyEmoji = '⬜'; // White for empty

    if (direction === 'decrease') {
      filledEmoji = '🟥'; // Red for decrease
    } else if (direction === 'neutral') {
      filledEmoji = '⬜'; // Gray for neutral
    }

    return filledEmoji.repeat(filled) + emptyEmoji.repeat(empty);
  }

  /**
   * Xây dựng tin nhắn phản hồi cho /test command.
   * Format tương tự buildMessage nhưng không có URL bài viết gốc.
   */
  private buildTestMessage(
    content: string,
    analysis: AnalysisResult,
    btcPrice: number | null,
  ): string {
    const ensembleProb = analysis.ensembleProbability ?? analysis.btcInfluenceProbability;
    const probabilityBar = this.buildProbabilityBar(ensembleProb, analysis.btcDirection);

    const btcPriceText = btcPrice
      ? `$${btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'Không lấy được';

    // Rút ngắn nội dung nếu quá dài (Telegram giới hạn 4096 ký tự)
    const preview =
      content.length > 300 ? content.substring(0, 297) + '...' : content;

    // Build direction indicator with arrow
    let directionDisplay = '';
    if (analysis.btcDirection === 'increase') {
      directionDisplay = '↑ TĂNG';
    } else if (analysis.btcDirection === 'decrease') {
      directionDisplay = '↓ GIẢM';
    } else {
      directionDisplay = '─ TRUNG LẬP';
    }

    // Breakdown line: model / severity / market
    const severityPct = Math.round((analysis.severityScore ?? 0) * 100);
    const marketPct = Math.round((analysis.marketSignalScore ?? 0) * 100);
    const breakdownLine = `<i>🤖 Model: ${analysis.btcInfluenceProbability}% | 🔍 Severity: ${severityPct}% | 📈 Market: ${marketPct}%</i>`;

    // Hard rule warning
    const hardRuleLine = analysis.hardRule && analysis.matchedRules?.length
      ? `\n⚠️ <b>HARD RULE:</b> <i>${analysis.matchedRules.join(', ')}</i>`
      : '';

    return `📋 <b>TEST PHÂN TÍCH</b>

📝 <b>Nội dung:</b>
<i>${preview}</i>

📝 <b>Tóm tắt:</b>
${analysis.summary}

💡 <b>Lý do:</b> ${analysis.reasoning}

📊 <b>Ensemble Score:</b>
${probabilityBar} <b>${ensembleProb}% ${directionDisplay}</b>
${breakdownLine}${hardRuleLine}

💰 <b>Giá BTC hiện tại:</b> ${btcPriceText}`;
  }
}
