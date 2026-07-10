/**
 * Kiểu dữ liệu dùng chung cho tầng hiệu chuẩn (calibration) và đánh giá (eval).
 *
 * Sự kiện đích được định nghĩa chính xác như sau:
 *
 *   r  = ln( P(t0 + 60m) / P(t0) )          log-return 1 giờ sau khi Trump đăng bài
 *   σ  = EWMA std của log-return theo giờ, tính trên dữ liệu TRƯỚC t0
 *   z  = r / σ                               abnormal return đã chuẩn hóa theo vol
 *
 *   moved = |z| >= Z_THRESHOLD               có biến động bất thường hay không
 *   up    = z > 0                            hướng, chỉ có nghĩa khi moved = true
 *
 * Chuẩn hóa theo vol là bắt buộc: 0.5% lúc thị trường lặng là tín hiệu,
 * 0.5% lúc thị trường sôi là nhiễu.
 */

/** Ngưỡng z để coi là "có biến động bất thường". */
export const Z_THRESHOLD = 2.0;

/** Hệ số EWMA cho phương sai của log-return theo giờ (halflife ≈ 72 giờ). */
export const EWMA_LAMBDA = Math.exp(-Math.LN2 / 72);

/** Số log-return theo giờ tối thiểu cần có trước t0 để σ đáng tin. */
export const MIN_HOURLY_RETURNS = 72;

/** Cửa sổ lịch sử nạp trước t0 để tính σ (ngày). */
export const VOL_LOOKBACK_DAYS = 14;

/** Một nến (kline) đã rút gọn: chỉ giữ thời điểm mở và giá đóng. */
export interface Bar {
  /** openTime, epoch milliseconds (UTC, đã căn theo phút) */
  t: number;
  /** giá đóng của nến */
  c: number;
}

/** Nhãn kết quả thực tế cho một bài viết. */
export interface Label {
  postId: string;
  /** thời điểm Trump đăng bài, epoch ms */
  t0: number;
  /** giá tại t0 */
  p0: number;
  /** giá tại t0 + 60 phút */
  p1h: number;
  /** log-return 1 giờ */
  r1h: number;
  /** EWMA std của log-return theo giờ, tính trên dữ liệu trước t0 */
  sigma: number;
  /** r1h / sigma */
  z: number;
  /** |z| >= Z_THRESHOLD */
  moved: boolean;
  /** z > 0 — chỉ có nghĩa khi moved = true */
  up: boolean;
  /**
   * Các bài có cửa sổ kết quả [t0, t0+1h] chồng lấn nhau chia sẻ cùng một
   * kết quả thị trường. Nếu đánh giá chúng như các quan sát độc lập, tín hiệu
   * sẽ bị thổi phồng. Backtest phải khử trùng lặp theo clusterId.
   */
  clusterId: number;
}

/** Bài viết không gắn nhãn được, kèm lý do. */
export interface UnlabeledPost {
  postId: string;
  t0: number | null;
  reason: string;
}

/** Kết quả của một lần chạy build-dataset. */
export interface Dataset {
  builtAt: string;
  symbol: string;
  zThreshold: number;
  ewmaLambda: number;
  volLookbackDays: number;
  labels: Label[];
  unlabeled: UnlabeledPost[];
  /** tần suất nền: tỉ lệ bài có moved = true, sau khi khử trùng lặp cluster */
  baseRate: number;
  /** tỉ lệ bài moved = true và up = true, trong số các bài moved */
  upRateGivenMove: number;
}
