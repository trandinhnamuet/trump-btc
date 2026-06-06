/**
 * Giao diện dùng chung cho toàn bộ ứng dụng
 */

/** Bài viết từ Truth Social sau khi đã xử lý */
export interface TruthSocialPost {
  id: string;
  content: string; // Nội dung đã strip HTML
  createdAt: string; // ISO timestamp
  url: string;
  mediaUrls?: string[]; // URL ảnh đính kèm (nếu có)
}

/** Kết quả phân tích từ OpenAI */
export interface AnalysisResult {
  summary: string; // Tóm tắt ngắn gọn
  btcInfluenceProbability: number; // 0-100 (raw model output)
  btcDirection: 'increase' | 'decrease' | 'neutral'; // Hướng ảnh hưởng
  reasoning: string; // Lý do
  modelUsed?: string; // Model đã thực sự xử lý request này

  // Ensemble scoring
  ensembleProbability: number;  // 0-100 (sau khi kết hợp model + severity + market)
  severityScore: number;        // 0-1 (rule-based severity)
  marketSignalScore: number;    // 0-1 (biến động thị trường ngắn hạn)
  hardRule: boolean;            // true = hard rule override kích hoạt
  matchedRules: string[];       // Danh sách rule đã khớp
}

/** Thông tin người dùng Telegram */
export interface TelegramUser {
  chatId: string;
  name: string;
  threshold?: number; // Ngưỡng xác suất riêng (0-100). Nếu không set → dùng BTC_INFLUENCE_THRESHOLD từ .env
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

  // Kết quả phân tích
  summary?: string;
  btcInfluenceProbability?: number;  // raw model
  btcDirection?: 'increase' | 'decrease' | 'neutral';
  reasoning?: string;
  alerted?: boolean; // Đã gửi Telegram alert hay chưa

  // Ensemble scores
  ensembleProbability?: number;   // xác suất cuối sau ensemble
  severityScore?: number;         // điểm rule-based
  marketSignalScore?: number;     // điểm tín hiệu thị trường
  hardRule?: boolean;             // hard rule có kích hoạt không
  matchedRules?: string[];        // các rule đã khớp

  // Giá BTC tại các mốc thời gian
  btcPriceAtPost?: number; // Giá lúc đăng bài
  btcPriceAt1h?: number | null; // Giá 1h sau
  btcPriceAt1d?: number | null; // Giá 1 ngày sau
  btcPriceAt7d?: number | null; // Giá 7 ngày sau

  mediaUrls?: string[]; // URL ảnh đính kèm (được lưu lại để tái phân tích)

  // Thời điểm cần check giá BTC (ISO timestamp)
  checkAt1h?: string;
  checkAt1d?: string;
  checkAt7d?: string;
}

/** Bài viết bị bỏ qua vì đã quá 1 giờ trong hàng chờ phân tích */
export interface SkippedAnalysisRecord {
  postId: string;
  content: string;       // 150 ký tự đầu
  fetchedAt: string;     // Thời điểm bài được lưu vào storage
  skippedAt: string;     // Thời điểm bị bỏ qua
  ageMinutes: number;    // Tuổi bài tính bằng phút tại lúc bị bỏ qua
  url: string;
}

/** Cấu trúc file data/posts.json */
export interface StorageData {
  lastPostId: string | null; // ID bài viết gần nhất đã lấy
  posts: PostRecord[];
}
