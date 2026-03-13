import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import TelegramBot = require('node-telegram-bot-api');
import { AnalysisResult, PostRecord, TruthSocialPost, UserConfig } from '../common/interfaces';
import { AnalysisService } from '../analysis/analysis.service';
import { BtcPriceService } from '../btc-price/btc-price.service';
import { StorageService } from '../storage/storage.service';

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

  // Đường dẫn file danh sách users
  private readonly usersFile = path.join(process.cwd(), 'data', 'users.json');
  // File log lưu các alert đã gửi (JSON per line)
  private readonly alertsFile = path.join(process.cwd(), 'data', 'alerts.log');

  constructor(
    private readonly configService: ConfigService,
    private readonly analysisService: AnalysisService,
    private readonly btcPriceService: BtcPriceService,
    private readonly storageService: StorageService,
  ) {}

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
        this.logger.error(`❌ Lỗi xử lý /start: ${error.message}`);
        this.bot?.sendMessage(chatId, `❌ Lỗi: ${error.message}`);
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
        this.logger.error(`❌ Lỗi xử lý /test: ${error.message}`);
        await this.bot?.sendMessage(
          chatId,
          `❌ Lỗi phân tích: ${error.message}`,
        );
      }
    });

    // Handle /menu command
    this.bot.onText(/^\/menu$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      const message = `📋 <b>DANH SÁCH LỆNH</b>

` +
        `🟢 /start — Đăng ký nhận alert tự động từ Trump
` +
        `💰 /btc — Xem giá BTC hiện tại
` +
        `📊 /check — Bảng các tin có xác suất ảnh hưởng BTC &gt;80%
` +
        `🧪 /test &lt;nội dung&gt; — Phân tích thủ công một đoạn văn bản
` +
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
        this.logger.error(`❌ Lỗi /btc: ${error.message}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${error.message}`);
      }
    });

    // Handle /check command
    this.bot.onText(/^\/check$/, async (msg: any) => {
      const chatId = String(msg.chat.id);
      try {
        const posts = this.storageService.getAllPosts();
        const filtered = posts
          .filter(p => (p.btcInfluenceProbability ?? 0) >= 80)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 15);

        if (filtered.length === 0) {
          await this.bot?.sendMessage(chatId, '📭 Chưa có bài viết nào có xác suất ảnh hưởng BTC &gt;80%.');
          return;
        }

        const message = this.buildCheckMessage(filtered);
        await this.bot?.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (error) {
        this.logger.error(`❌ Lỗi /check: ${error.message}`);
        await this.bot?.sendMessage(chatId, `❌ Lỗi: ${error.message}`);
      }
    });

    this.logger.log('Telegram Bot đã khởi tạo thành công (polling mode enabled)');
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
      this.logger.error('Lỗi đọc file users.json:', error.message);
    }
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
      this.logger.error(`Lỗi thêm user: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gửi thông báo alert đến TẤT CẢ users trong danh sách.
   *
   * @param post Bài viết gốc của Trump
   * @param analysis Kết quả phân tích OpenAI
   * @param btcPrice Giá BTC hiện tại (USD)
   */
  async sendAlert(
    post: TruthSocialPost,
    analysis: AnalysisResult,
    btcPrice: number | null,
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

    const message = this.buildMessage(post, analysis, btcPrice);

    // Lưu bản ghi alert vào file log (để audit sau này)
    try {
      this.saveAlertToFile(post, analysis, btcPrice, message);
      this.logger.debug(`Đã ghi alert vào file ${this.alertsFile}`);
    } catch (err) {
      this.logger.error(`Không thể ghi alert vào file: ${err.message}`);
    }

    // Gửi đến từng user trong danh sách
    for (const user of this.users) {
      try {
        await this.bot.sendMessage(user.chatId, message, {
          parse_mode: 'HTML',
          // Disable preview cho URL để tin nhắn gọn hơn
          disable_web_page_preview: true,
        });
        this.logger.log(`Đã gửi alert đến ${user.name} (${user.chatId})`);
      } catch (error) {
        // Không throw - tiếp tục gửi cho các user khác dù 1 user lỗi
        this.logger.error(
          `Không thể gửi đến ${user.name} (${user.chatId}): ${error.message}`,
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
  ): string {
    // Build direction indicator with arrow
    let directionDisplay = '';
    if (analysis.btcDirection === 'increase') {
      directionDisplay = '↑ TĂNG';
    } else if (analysis.btcDirection === 'decrease') {
      directionDisplay = '↓ GIẢM';
    } else {
      directionDisplay = '─ TRUNG LẬP';
    }

    const probabilityBar = this.buildProbabilityBar(analysis.btcInfluenceProbability, analysis.btcDirection);

    const btcPriceText = btcPrice
      ? `$${btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : 'Không lấy được';

    const postedAt = new Date(post.createdAt).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    // Rút ngắn nội dung nếu quá dài (Telegram giới hạn 4096 ký tự)
    const preview =
      post.content.length > 300 ? post.content.substring(0, 297) + '...' : post.content;

    return `🚨 <b>TRUMP POST - BTC ALERT!</b>

📢 <b>Bài viết gốc:</b>
<i>${preview}</i>

📝 <b>Tóm tắt:</b>
${analysis.summary}

💡 <b>Lý do:</b> ${analysis.reasoning}

📊 <b>Xác suất ảnh hưởng BTC:</b>
${probabilityBar} <b>${analysis.btcInfluenceProbability}% ${directionDisplay}</b>

💰 <b>Giá BTC hiện tại:</b> ${btcPriceText}

🕐 <b>Đăng lúc:</b> ${postedAt}
🔗 <a href="${post.url}">Xem bài viết gốc</a>`;
  }

  /**
   * Xây dựng tin nhắn bảng tổng hợp cho /check command.
   * Hiển thị các bài >80% kèm 4 cột giá BTC.
   */
  private buildCheckMessage(posts: PostRecord[]): string {
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

    const lines: string[] = [`📊 <b>BÀI CÓ XÁC SUẤT ẢNH HƯỞNG BTC &gt;80% (${posts.length} bài gần nhất)</b>
`];

    posts.forEach((p, i) => {
      const dir = p.btcDirection === 'increase' ? '↑' : p.btcDirection === 'decrease' ? '↓' : '─';
      const date = new Date(p.createdAt).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      const base = p.btcPriceAtPost;
      lines.push(
        `<b>${i + 1}. [${date}]</b> <b>${p.btcInfluenceProbability}% ${dir}</b>\n` +
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
    const probabilityBar = this.buildProbabilityBar(analysis.btcInfluenceProbability, analysis.btcDirection);

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

    return `📋 <b>TEST PHÂN TÍCH</b>

📝 <b>Nội dung:</b>
<i>${preview}</i>

📝 <b>Tóm tắt:</b>
${analysis.summary}

💡 <b>Lý do:</b> ${analysis.reasoning}

📊 <b>Xác suất ảnh hưởng BTC:</b>
${probabilityBar} <b>${analysis.btcInfluenceProbability}% ${directionDisplay}</b>

💰 <b>Giá BTC hiện tại:</b> ${btcPriceText}`;
  }
}
