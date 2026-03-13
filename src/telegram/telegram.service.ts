import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import TelegramBot = require('node-telegram-bot-api');
import { AnalysisResult, TruthSocialPost, UserConfig } from '../common/interfaces';

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

  constructor(private readonly configService: ConfigService) {}

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
    
    // Handle /start command để user lấy Chat ID của mình
    this.bot.onText(/\/start/, (msg: any) => {
      const chatId = msg.chat.id;
      const message = `✅ Xin chào!\n\n👤 <b>Chat ID của bạn:</b> <code>${chatId}</code>\n\n💡 Thêm ID này vào <code>data/users.json</code> để nhận alerts từ Trump.\n\n📝 Format:\n<code>{"chatId": "${chatId}", "name": "Tên của bạn"}</code>`;
      this.bot?.sendMessage(chatId, message, { parse_mode: 'HTML' });
      this.logger.log(`📱 User /start: Chat ID = ${chatId}, Name = ${msg.chat.first_name}`);
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
    const directionEmoji =
      analysis.btcDirection === 'increase'
        ? '📈 TĂNG'
        : analysis.btcDirection === 'decrease'
          ? '📉 GIẢM'
          : '➡️ TRUNG LẬP';

    const probabilityBar = this.buildProbabilityBar(analysis.btcInfluenceProbability);

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
${probabilityBar} <b>${analysis.btcInfluenceProbability}%</b>

${directionEmoji} <b>Hướng ảnh hưởng dự đoán</b>

💰 <b>Giá BTC hiện tại:</b> ${btcPriceText}

🕐 <b>Đăng lúc:</b> ${postedAt}
🔗 <a href="${post.url}">Xem bài viết gốc</a>`;
  }

  /** Tạo thanh tiến độ dạng text để hiển thị % */
  private buildProbabilityBar(probability: number): string {
    const filled = Math.round(probability / 10);
    const empty = 10 - filled;
    return '🟩'.repeat(filled) + '⬜'.repeat(empty);
  }
}
