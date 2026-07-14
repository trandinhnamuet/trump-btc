import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import TelegramBot = require('node-telegram-bot-api');
import { DetectionResult, PostRecord, TruthSocialPost, UserConfig } from '../common/interfaces';
import { BtcPriceService } from '../btc-price/btc-price.service';
import { StorageService } from '../storage/storage.service';
import { TruthSocialService } from '../truth-social/truth-social.service';
import { DetectorService } from '../detector/detector.service';

/**
 * TelegramService: giao diện người dùng của hệ thống.
 *
 * Hai loại tin gửi đi:
 * 1. 🚨 Detector alert — sự kiện lớp A, gửi mọi user, luôn có âm thanh.
 * 2. 📋 Feed im lặng — mọi bài không phải sự kiện lớp A, không âm thanh,
 *    để user vẫn theo dõi được dòng bài đăng.
 *
 * Bot chạy polling mode để nhận lệnh; có watchdog tự khởi động lại polling
 * khi lỗi mạng hoặc rơi vào zombie state.
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
  // Thời điểm polling được (re)start lần cuối — để phát hiện zombie state
  private pollingStartedAt = 0;

  private readonly usersFile = path.join(process.cwd(), 'data', 'users.json');
  // File log lưu các alert đã gửi (JSON per line)
  private readonly alertsFile = path.join(process.cwd(), 'data', 'alerts.log');

  constructor(
    private readonly configService: ConfigService,
    private readonly btcPriceService: BtcPriceService,
    private readonly storageService: StorageService,
    private readonly truthSocialService: TruthSocialService,
    private readonly detectorService: DetectorService,
  ) {}

  onModuleInit() {
    this.initBot();
    this.loadUsers();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Khởi tạo bot + đăng ký lệnh
  // ─────────────────────────────────────────────────────────────────────────

  private initBot() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN chưa được cấu hình. Telegram alerts sẽ bị bỏ qua.');
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });

    // Log trạng thái API key một lần khi khởi động
    this.detectorService.getRemainingCredits()
      .then(info => this.logger.log(`OpenRouter check: ${info}`))
      .catch(err => this.logger.warn(`OpenRouter check failed: ${err instanceof Error ? err.message : String(err)}`));

    // ── /start — đăng ký nhận alert ────────────────────────────────────────
    this.bot.onText(/\/start/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      const userName = msg.chat.first_name || `User${chatId}`;
      try {
        const added = this.addUserToList(chatId, userName);
        const message = added
          ? `✅ Xin chào <b>${userName}</b>!\n\n👤 <b>Chat ID:</b> <code>${chatId}</code>\n\n🎉 Bạn đã được thêm vào danh sách nhận alert sự kiện lớn từ Trump!`
          : `✅ Xin chào <b>${userName}</b>!\n\n👤 <b>Chat ID:</b> <code>${chatId}</code>\n\n📌 Bạn đã có trong danh sách rồi!`;
        this.bot?.sendMessage(chatId, message, { parse_mode: 'HTML' });
        this.logger.log(`${added ? '✅ Đã add' : 'ℹ️ Đã tồn tại'}: ${userName} (${chatId})`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi xử lý /start: ${errMsg}`);
        this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // ── /btc — giá BTC hiện tại ────────────────────────────────────────────
    this.bot.onText(/^\/btc$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        await this.bot?.sendMessage(chatId, '⏳ Đang lấy giá BTC...');
        const price = await this.btcPriceService.getCurrentPrice();
        const text = price !== null
          ? `💰 <b>Giá BTC hiện tại:</b> <b>$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>\n🕐 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`
          : '❌ Không lấy được giá BTC lúc này, vui lòng thử lại sau.';
        await this.bot?.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /btc: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // ── /detect — chạy detector thủ công trên nội dung hoặc postId/URL ─────
    this.bot.onText(/^\/detect(?:@[\w_]+)?(?:\s+([\s\S]+))?$/i, async (msg: any, match: any) => {
      const chatId = String(msg.chat.id);
      let content = match?.[1]?.trim();

      if (!content) {
        await this.bot?.sendMessage(
          chatId,
          'ℹ️ Dùng: <code>/detect &lt;nội dung | postId | URL&gt;</code> — kiểm tra bài có thuộc sự kiện lớp A không.',
          { parse_mode: 'HTML' },
        );
        return;
      }

      // Nếu là post ID thuần hoặc URL Truth Social → fetch nội dung trước
      const postIdMatch = content.match(/(?:truthsocial\.com\/[^\s]+\/|^)(\d{15,25})(?:\s*$)/);
      if (postIdMatch) {
        const postId = postIdMatch[1];
        await this.bot?.sendMessage(chatId, `⏳ Đang lấy bài <code>${postId}</code> từ Truth Social...`, { parse_mode: 'HTML' });
        try {
          const post = await this.truthSocialService.getPostById(postId);
          if (!post?.content) {
            await this.bot?.sendMessage(chatId, `❌ Không tìm thấy bài <code>${postId}</code>.`, { parse_mode: 'HTML' });
            return;
          }
          content = post.content;
        } catch (err) {
          await this.bot?.sendMessage(chatId, `❌ Lỗi lấy bài: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }

      try {
        await this.bot?.sendMessage(chatId, '⏳ Đang chạy detector (tripwire + checklist 5 model)...');
        const sevenDaysAgo = Date.now() - 7 * 24 * 3_600_000;
        const recentContents = this.storageService
          .getAllPosts()
          .filter(p => new Date(p.createdAt).getTime() >= sevenDaysAgo)
          .map(p => p.content);

        // Lệnh thủ công: không ghi dedup để không chặn alert thật sau đó
        const d = await this.detectorService.detect(content, recentContents, { skipDedup: true });

        const votesStr = d.votes.length
          ? d.votes
              .map(v => `• <code>${this.escapeHtml(v.model.split('/').pop() ?? v.model)}</code>: ${v.eventClass}${v.confirmed ? ' ✓xác nhận' : ''}${v.newAction ? ' ★mới' : ''}`)
              .join('\n')
          : '<i>(tripwire đã quyết định — không cần gọi model)</i>';

        const lines = [
          d.alert
            ? `🚨 <b>PHÁT HIỆN SỰ KIỆN LỚP ${d.eventClass}</b> — ${this.escapeHtml(d.eventClassName ?? '')}`
            : `✅ <b>Không thuộc sự kiện lớp A</b>${d.suppressedBy ? ` <i>(tín hiệu khớp nhưng bị chặn: ${d.suppressedBy === 'repeat' ? 'bài lặp lại chủ đề gần đây' : 'đã alert lớp này trong 24h'})</i>` : ''}`,
          ``,
          `🧩 Tripwire: ${d.matchedRules.length ? d.matchedRules.map(r => `<code>${r}</code>`).join(', ') : 'không khớp'}`,
          `🗳 Phiếu model:\n${votesStr}`,
          `🆕 Độ mới so với 7 ngày: ${Math.round(d.novelty * 100)}%`,
        ];
        if (d.reasoning) lines.push(`💡 <i>${this.escapeHtml(d.reasoning.substring(0, 300))}</i>`);

        await this.bot?.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
        this.logger.log(`✅ /detect: alert=${d.alert} class=${d.eventClass ?? '-'}`);

        if (this.detectorService.consumeLimitAlert()) {
          await this.sendDailyLimitWarning();
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /detect: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // ── /check — các bài detector đã alert gần đây, kèm giá +1h/+1d/+7d ────
    this.bot.onText(/^\/check$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        const alerted = this.storageService
          .getAllPosts()
          .filter(p => p.detection?.alert === true)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        if (alerted.length === 0) {
          await this.bot?.sendMessage(chatId, '📭 Chưa có bài nào kích hoạt detector alert. (Sự kiện lớp A rất hiếm — đó là bình thường.)');
          return;
        }

        await this.bot?.sendMessage(chatId, this.buildAlertHistoryMessage(alerted), {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /check: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // ── /credit — trạng thái API key + hạn mức ngày ────────────────────────
    this.bot.onText(/^\/credit(?:@[\w_]+)?(?:\s.*)?$/i, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        await this.bot?.sendMessage(chatId, '⏳ Đang kiểm tra OpenRouter...');
        const info = await this.detectorService.getRemainingCredits();
        await this.bot?.sendMessage(chatId, `💳 <b>OpenRouter:</b>\n${this.escapeHtml(String(info))}`, { parse_mode: 'HTML' });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /credit: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi lấy credit: ${errMsg}`);
      }
    });

    // ── /clear — xoá bài cũ ────────────────────────────────────────────────
    this.bot.onText(/^\/clear\s+(\d{2})-(\d{2})-(\d{4})$/, async (msg: any, match: any) => {
      const chatId = String(msg.chat.id);
      try {
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10);
        const year = parseInt(match[3], 10);

        if (month < 1 || month > 12 || day < 1 || day > 31) {
          await this.bot?.sendMessage(chatId, '❌ Ngày không hợp lệ. Định dạng: /clear dd-mm-yyyy');
          return;
        }

        const beforeDate = new Date(year, month - 1, day);
        const deletedCount = this.storageService.deletePostsBefore(beforeDate);
        await this.bot?.sendMessage(
          chatId,
          `✅ Đã xóa <b>${deletedCount}</b> bài viết trước ngày ${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`,
          { parse_mode: 'HTML' },
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Lỗi /clear: ${errMsg}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${errMsg}`);
      }
    });

    // ── /menu ──────────────────────────────────────────────────────────────
    this.bot.onText(/^\/menu(?:@[\w_]+)?$/i, async (msg: any) => {
      const chatId = String(msg.chat.id);
      const message = `📋 <b>DANH SÁCH LỆNH</b>\n\n` +
        `Bot phát hiện <b>sự kiện lớp A</b> — các bài đăng của Trump gần như chắc chắn gây biến động mạnh giá BTC (lập crypto reserve, thuế toàn cầu, không kích...). ` +
        `Bài thường → tin im lặng; sự kiện lớp A → 🚨 alert có âm thanh đến mọi người.\n\n` +
        `🟢 /start — Đăng ký nhận alert\n` +
        `🛰 /detect &lt;nội dung | postId | URL&gt; — Kiểm tra thủ công một bài\n` +
        `📊 /check — 10 bài gần nhất đã kích hoạt alert, kèm giá BTC +1h/+1d/+7d\n` +
        `💰 /btc — Giá BTC hiện tại\n` +
        `💳 /credit — Trạng thái API key + hạn mức ngày\n` +
        `🗑️ /clear dd-mm-yyyy — Xóa bài viết trước ngày\n` +
        `📋 /menu — Danh sách lệnh này`;
      await this.bot?.sendMessage(chatId, message, { parse_mode: 'HTML' });
    });

    // ── Polling error handling + watchdog ──────────────────────────────────
    // Without this handler the error event crashes the process.
    (this.bot as any).on('polling_error', (err: Error) => {
      const msg = err.message || String(err);
      if (msg.includes('404') || msg.includes('401')) {
        this.logger.warn(`Telegram polling: token không hợp lệ hoặc chưa cấu hình (${msg.split('\n')[0]}). Bot sẽ không nhận lệnh cho đến khi token đúng.`);
        // Stop retrying — token won't fix itself at runtime
        this.bot?.stopPolling();
      } else {
        this.logger.warn(`Telegram polling error: ${msg.split('\n')[0]}`);
        // Với lỗi mạng (EFATAL, ETIMEDOUT, ECONNRESET...), tự động restart polling sau 5s
        this.schedulePollingRestart();
      }
    });

    // Watchdog: mỗi 2 phút kiểm tra nếu polling bị dừng thì khởi động lại
    this.pollingWatchdogTimer = setInterval(() => this.checkAndRestorePolling(), 2 * 60 * 1000);
    this.pollingStartedAt = Date.now();

    this.logger.log('Telegram Bot đã khởi tạo thành công (polling mode enabled)');
  }

  /** Schedule restart polling sau lỗi mạng, tránh restart nhiều lần liên tiếp */
  private schedulePollingRestart() {
    if (this.pollingRestartTimer) return;
    this.pollingRestartTimer = setTimeout(async () => {
      this.pollingRestartTimer = null;
      await this.restartPolling('network error recovery');
    }, 5000);
  }

  /** Kiểm tra polling còn hoạt động không; nếu tắt hoặc zombie thì khởi động lại */
  private async checkAndRestorePolling() {
    if (!this.bot) return;
    const isPolling = (this.bot as any).isPolling?.() ?? false;
    if (!isPolling) {
      this.logger.warn('⚠️ Phát hiện Telegram polling đã dừng (watchdog). Đang khởi động lại...');
      await this.restartPolling('watchdog: stopped');
      return;
    }
    // Zombie detection: isPolling()=true nhưng không nhận được updates.
    // Fix: force restart mỗi 30 phút để đảm bảo polling luôn tươi.
    const THIRTY_MIN = 30 * 60 * 1000;
    if (this.pollingStartedAt > 0 && Date.now() - this.pollingStartedAt > THIRTY_MIN) {
      this.logger.log('🔄 Periodic polling restart (30 phút, phòng zombie state)');
      await this.restartPolling('watchdog: periodic 30m');
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
      this.pollingStartedAt = Date.now();
      this.logger.log(`🔄 Telegram polling đã được khởi động lại (${reason})`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.error(`❌ Không thể restart Telegram polling: ${errMsg}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Gửi tin
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gửi cảnh báo sự kiện lớp A đến TẤT CẢ users — luôn có âm thanh.
   * Đây là toàn bộ lý do hệ thống tồn tại: sự kiện ~1 lần/quý.
   */
  async sendDetectorAlert(
    post: TruthSocialPost,
    detection: DetectionResult,
    btcPrice: number | null,
  ): Promise<void> {
    if (!this.bot) {
      this.logger.warn('Telegram Bot chưa được cấu hình, bỏ qua detector alert');
      return;
    }
    this.loadUsers();
    if (this.users.length === 0) return;

    const preview = post.content.length > 400 ? post.content.substring(0, 397) + '...' : post.content;
    const sourceLabel =
      detection.source === 'tripwire'
        ? '⚡ bẫy luật (phát hiện tức thì)'
        : `🗳 đồng thuận ${detection.votes.filter(v => v.eventClass === detection.eventClass && v.confirmed && v.newAction).length}/${detection.votes.length} model`;
    const btcPriceText = btcPrice
      ? `$${btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'không lấy được';
    const postedAt = new Date(post.createdAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    const message = `🚨🚨🚨 <b>SỰ KIỆN LỚP ${detection.eventClass}</b> 🚨🚨🚨
<b>${this.escapeHtml(detection.eventClassName ?? '')}</b>

📢 <b>Bài viết:</b>
<i>${this.escapeHtml(preview)}</i>

🔍 <b>Nguồn phát hiện:</b> ${sourceLabel}${
      detection.matchedRules.length ? `\n🧩 <b>Pattern khớp:</b> <code>${detection.matchedRules.join(', ')}</code>` : ''
    }${detection.reasoning ? `\n💡 <i>${this.escapeHtml(detection.reasoning.substring(0, 250))}</i>` : ''}

⚠️ <b>Kỳ vọng BTC biến động mạnh trong ~60 phút tới.</b>
<b>HƯỚNG KHÔNG CHẮC CHẮN</b> — lịch sử cho thấy cả tin "tốt" cho crypto cũng có thể làm giá GIẢM (sell-the-news).

💰 Giá BTC lúc phát hiện: <b>${btcPriceText}</b>
🕐 Đăng lúc: ${postedAt}
🔗 <a href="${post.url}">Xem bài viết gốc</a>`;

    this.logAlert(post, detection, btcPrice);

    for (const user of this.users) {
      try {
        await this.bot.sendMessage(user.chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: false, // luôn kêu
        });
        this.logger.log(`🚨 Detector alert lớp ${detection.eventClass} → ${user.name} (${user.chatId})`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Không thể gửi detector alert đến ${user.name}: ${errMsg}`);
      }
    }
  }

  /**
   * Tin feed im lặng cho bài không phải sự kiện lớp A — user theo dõi được
   * dòng bài đăng mà không bị âm thanh làm phiền.
   */
  async sendFeedMessage(post: TruthSocialPost, btcPrice: number | null): Promise<void> {
    if (!this.bot) return;
    this.loadUsers();
    if (this.users.length === 0) return;

    const preview = post.content
      ? (post.content.length > 300 ? post.content.substring(0, 297) + '...' : post.content)
      : `[Bài đăng chỉ có ${post.mediaUrls?.length ?? 0} ảnh, không có văn bản]`;
    const btcPriceText = btcPrice
      ? `$${btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'không lấy được';
    const postedAt = new Date(post.createdAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    const message = `📋 <b>TRUMP POST</b> <i>(không phải sự kiện lớp A)</i>

<i>${this.escapeHtml(preview)}</i>

💰 BTC: ${btcPriceText} · 🕐 ${postedAt}
🔗 <a href="${post.url}">Xem bài viết gốc</a>`;

    for (const user of this.users) {
      try {
        await this.bot.sendMessage(user.chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: true, // im lặng
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Không thể gửi feed đến ${user.name}: ${errMsg}`);
      }
    }
  }

  /** Cảnh báo đã chạm trần API ngày — gọi đúng một lần mỗi ngày qua consumeLimitAlert(). */
  async sendDailyLimitWarning(): Promise<void> {
    if (!this.bot) return;
    this.loadUsers();
    if (this.users.length === 0) {
      this.logger.warn('[RATE LIMIT] Không có user nào để gửi cảnh báo');
      return;
    }
    const stats = this.detectorService.getDailyCallStats();
    const message =
      `⚠️ <b>CẢNH BÁO: Bot đã đạt giới hạn API hôm nay!</b>\n\n` +
      `📊 API calls hôm nay: <b>${stats.count}/${stats.limit}</b>\n` +
      `🔒 Tầng checklist LLM tạm dừng đến <b>0:00 ngày mai</b>\n` +
      `⚡ Tripwire (bẫy luật) vẫn hoạt động bình thường — sự kiện lớn vẫn được phát hiện.`;
    for (const user of this.users) {
      try {
        await this.bot.sendMessage(user.chatId, message, { parse_mode: 'HTML' });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[RATE LIMIT] Không gửi được cảnh báo đến ${user.name}: ${errMsg}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Bảng lịch sử các bài detector đã alert, kèm giá BTC các mốc sau đó. */
  private buildAlertHistoryMessage(posts: PostRecord[]): string {
    const fmtPrice = (p: number | null | undefined): string => {
      if (p == null) return '⏳';
      return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    };
    const fmtChange = (base: number | undefined, later: number | null | undefined): string => {
      if (base == null || later == null) return '';
      const pct = ((later - base) / base) * 100;
      return ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
    };

    const lines: string[] = [`🚨 <b>LỊCH SỬ DETECTOR ALERT (${posts.length} bài gần nhất)</b>\n`];
    posts.forEach((p, i) => {
      const d = p.detection!;
      const date = new Date(p.createdAt).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      const base = p.btcPriceAtPost;
      const link = p.url ? `<a href="${p.url}">🔗 Link</a>` : '';
      lines.push(
        `<b>${i + 1}. [${date}] LỚP ${d.eventClass}</b> — ${this.escapeHtml(d.eventClassName ?? '')} ${link}\n` +
        `   📌 ${this.escapeHtml(p.content.substring(0, 80))}...\n` +
        `   💰 Lúc đăng: <code>${fmtPrice(base)}</code>\n` +
        `   ⏱ +1h:  <code>${fmtPrice(p.btcPriceAt1h)}${fmtChange(base, p.btcPriceAt1h)}</code>\n` +
        `   📅 +1d:  <code>${fmtPrice(p.btcPriceAt1d)}${fmtChange(base, p.btcPriceAt1d)}</code>\n` +
        `   📆 +7d:  <code>${fmtPrice(p.btcPriceAt7d)}${fmtChange(base, p.btcPriceAt7d)}</code>`,
      );
    });
    return lines.join('\n\n');
  }

  /** Ghi một bản ghi alert vào data/alerts.log để audit. */
  private logAlert(post: TruthSocialPost, detection: DetectionResult, btcPrice: number | null) {
    try {
      const dataDir = path.dirname(this.alertsFile);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const record = {
        timestamp: new Date().toISOString(),
        postId: post.id,
        postUrl: post.url,
        postCreatedAt: post.createdAt,
        recipients: this.users.map(u => u.chatId),
        detection: {
          eventClass: detection.eventClass,
          source: detection.source,
          matchedRules: detection.matchedRules,
          novelty: detection.novelty,
        },
        btcPriceAtSend: btcPrice ?? null,
      };
      fs.appendFileSync(this.alertsFile, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      this.logger.error(`Không thể ghi alerts.log: ${err instanceof Error ? err.message : String(err)}`);
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
   * Thêm user mới vào danh sách nếu chưa tồn tại.
   * @returns true nếu user được thêm mới, false nếu đã tồn tại
   */
  private addUserToList(chatId: string, name: string): boolean {
    const userExists = this.users.some(u => u.chatId === chatId);
    if (userExists) return false;

    this.users.push({ chatId, name });
    const dataDir = path.dirname(this.usersFile);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const config: UserConfig = { users: this.users };
    fs.writeFileSync(this.usersFile, JSON.stringify(config, null, 2), 'utf-8');
    this.logger.log(`✅ Đã thêm user mới: ${name} (${chatId})`);
    return true;
  }

  /** Escape HTML entities để tránh lỗi khi hiển thị trong HTML parse mode */
  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (char) => map[char]);
  }
}
