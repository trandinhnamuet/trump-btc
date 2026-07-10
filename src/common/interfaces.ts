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

/** Chi tiết chấm điểm v2 — đủ để tái dựng và kiểm toán một dự đoán về sau. */
export interface ScoringDetail {
  promptVersion: string;
  /** P(|z| >= 2 trong 1h sau khi đăng), đã hiệu chuẩn. [0,1] */
  pMove: number;
  /** P(tăng | có biến động), đã co về tần suất nền. [0,1] */
  pUp: number;
  /** khoảng dao động của pMove giữa các model trong ensemble */
  pMoveLow: number;
  pMoveHigh: number;
  /** 1 = các model đồng thuận hoàn toàn; 0 = phân tán tối đa */
  agreement: number;
  /** true khi con số đến từ isotonic đã fit trên nhãn thật, false = prior + bằng chứng */
  calibrated: boolean;
  /** tần suất nền tại thời điểm chấm — con số mà mọi dự đoán phải tôn trọng */
  baseRate: number;
  /** điểm thô của từng model, để refit đường hiệu chuẩn về sau */
  rawScores: Record<string, number>;
  /** pMove của từng model, để soi model nào lệch */
  pMoveByModel: Record<string, number>;
}

/** Kết quả phân tích một bài viết */
export interface AnalysisResult {
  summary: string; // Tóm tắt ngắn gọn
  btcInfluenceProbability: number; // 0-100 = round(pMove × 100)
  btcDirection: 'increase' | 'decrease' | 'neutral'; // Hướng ảnh hưởng
  reasoning: string; // Lý do
  modelUsed?: string; // Model đã sinh ra phần diễn giải hiển thị

  ensembleProbability: number;  // 0-100 — giữ tên cũ để tương thích; = btcInfluenceProbability
  severityScore: number;        // 0-1 (rule-based severity, nay là ĐẶC TRƯNG chứ không phải override)
  marketSignalScore: number;    // 0-1 (biến động thị trường ngắn hạn)
  hardRule: boolean;            // luôn false ở v2 — hard rule đã được gấp vào tầng hiệu chuẩn
  matchedRules: string[];       // Danh sách rule đã khớp (chỉ để hiển thị)

  scoring?: ScoringDetail;      // vắng mặt khi bài bị gate loại
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
  btcInfluenceProbability?: number;  // 0-100, đã hiệu chuẩn
  btcDirection?: 'increase' | 'decrease' | 'neutral';
  reasoning?: string;
  alerted?: boolean; // Đã gửi Telegram alert hay chưa

  // Ensemble scores
  ensembleProbability?: number;   // xác suất cuối sau ensemble
  severityScore?: number;         // điểm rule-based
  marketSignalScore?: number;     // điểm tín hiệu thị trường
  hardRule?: boolean;             // hard rule có kích hoạt không
  matchedRules?: string[];        // các rule đã khớp

  /**
   * Model đã sinh ra dự đoán. BẮT BUỘC phải lưu: không có nó, backtest không thể
   * tách bias của từng model, và cả chuỗi số trở thành một mớ không so sánh được.
   */
  modelUsed?: string;
  scoring?: ScoringDetail;

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
