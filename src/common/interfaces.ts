/**
 * Giao diện dùng chung cho toàn bộ ứng dụng.
 *
 * Lưu ý lịch sử: các trường chấm điểm xác suất (btcInfluenceProbability,
 * ensembleProbability, scoring...) đã bị loại bỏ cùng kênh chấm điểm (v3).
 * File data/posts.json cũ trên server vẫn còn các trường đó — JSON thừa trường
 * không gây lỗi parse, code đơn giản là không đọc chúng nữa.
 */

/** Bài viết từ Truth Social sau khi đã xử lý */
export interface TruthSocialPost {
  id: string;
  content: string; // Nội dung đã strip HTML
  createdAt: string; // ISO timestamp
  url: string;
  mediaUrls?: string[]; // URL ảnh đính kèm (nếu có)
}

/**
 * Kết quả của máy phát hiện sự kiện lớp A (detector).
 * Xem src/detector/taxonomy.ts cho định nghĩa các lớp.
 */
export interface DetectionResult {
  alert: boolean;
  /** A1..A5, hoặc null khi không thuộc lớp nào */
  eventClass: string | null;
  /** tên tiếng Việt của lớp, để hiển thị */
  eventClassName: string | null;
  /** nguồn kích hoạt alert */
  source: 'tripwire' | 'llm_consensus' | null;
  /** các tripwire rule đã khớp */
  matchedRules: string[];
  /** 0-1; 1 = hoàn toàn mới so với các bài 7 ngày gần nhất */
  novelty: number;
  /** true = bài lặp lại chủ đề gần đây → không alert dù khớp lớp */
  isRepeat: boolean;
  /** lý do alert bị chặn dù tín hiệu khớp */
  suppressedBy: 'repeat' | 'dedup' | null;
  /** phiếu phân loại của từng model (rỗng khi tripwire đã quyết định hoặc rules-only) */
  votes: Array<{
    model: string;
    eventClass: string;
    confirmed: boolean;
    newAction: boolean;
  }>;
  /** reasoning của một phiếu đại diện, để hiển thị */
  reasoning?: string;
}

/** Thông tin người dùng Telegram */
export interface TelegramUser {
  chatId: string;
  name: string;
  /**
   * Có nhận tin feed im lặng (bài không phải sự kiện lớp A) hay không.
   * Mặc định true khi vắng mặt (user cũ trước khi có tính năng này).
   * KHÔNG ảnh hưởng đến 🚨 detector alert — alert luôn gửi cho mọi user.
   */
  feedEnabled?: boolean;
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

  /** Đã gửi tin Telegram (feed hoặc alert) cho bài này chưa */
  alerted?: boolean;

  /** Kết quả máy phát hiện sự kiện lớp A */
  detection?: DetectionResult;

  // Giá BTC tại các mốc thời gian — để đối chiếu điều gì xảy ra sau mỗi bài,
  // đặc biệt hữu ích cho các bài detector đã alert
  btcPriceAtPost?: number; // Giá lúc đăng bài
  btcPriceAt1h?: number | null; // Giá 1h sau
  btcPriceAt1d?: number | null; // Giá 1 ngày sau
  btcPriceAt7d?: number | null; // Giá 7 ngày sau

  mediaUrls?: string[]; // URL ảnh đính kèm

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
