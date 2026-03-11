/**
 * Giao diện dùng chung cho toàn bộ ứng dụng
 */

/** Bài viết từ Truth Social sau khi đã xử lý */
export interface TruthSocialPost {
  id: string;
  content: string; // Nội dung đã strip HTML
  createdAt: string; // ISO timestamp
  url: string;
}

/** Kết quả phân tích từ OpenAI */
export interface AnalysisResult {
  summary: string; // Tóm tắt ngắn gọn
  btcInfluenceProbability: number; // 0-100
  btcDirection: 'increase' | 'decrease' | 'neutral'; // Hướng ảnh hưởng
  reasoning: string; // Lý do
}

/** Thông tin người dùng Telegram */
export interface TelegramUser {
  chatId: string;
  name: string;
}

/** Cấu hình danh sách user (lưu trong data/users.json) */
export interface UserConfig {
  users: TelegramUser[];
}

/** Bản ghi đầy đủ cho 1 bài viết (lưu trong data/posts.json) */
export interface PostRecord {
  id: string;
  content: string;
  createdAt: string;
  url: string;
  fetchedAt: string;

  // Kết quả phân tích OpenAI
  summary?: string;
  btcInfluenceProbability?: number;
  btcDirection?: 'increase' | 'decrease' | 'neutral';
  reasoning?: string;
  alerted?: boolean; // Đã gửi Telegram alert hay chưa

  // Giá BTC tại các mốc thời gian
  btcPriceAtPost?: number; // Giá lúc đăng bài
  btcPriceAt1h?: number | null; // Giá 1h sau
  btcPriceAt1d?: number | null; // Giá 1 ngày sau
  btcPriceAt7d?: number | null; // Giá 7 ngày sau

  // Thời điểm cần check giá BTC (ISO timestamp)
  checkAt1h?: string;
  checkAt1d?: string;
  checkAt7d?: string;
}

/** Cấu trúc file data/posts.json */
export interface StorageData {
  lastPostId: string | null; // ID bài viết gần nhất đã lấy
  posts: PostRecord[];
}
