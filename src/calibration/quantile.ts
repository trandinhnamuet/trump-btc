/**
 * Chuẩn hóa phân vị theo từng model.
 *
 * Đây là liều thuốc trực tiếp cho triệu chứng "model A luôn chấm cao, model B
 * luôn chấm thấp". Thay vì so điểm thô của model với một ngưỡng cố định, ta hỏi:
 * *điểm này đứng ở phân vị nào trong chính phân phối điểm lịch sử của model đó?*
 *
 * Phép biến đổi này bất biến với mọi hàm đơn điệu tăng áp lên điểm thô. Một model
 * chấm {0.6, 0.7, 0.9} và một model chấm {0.05, 0.10, 0.20} cho ra cùng một bộ
 * phân vị {0.17, 0.5, 0.83}. Bias cộng tính và co giãn thang đo biến mất hoàn toàn.
 *
 * Khác với isotonic ở chỗ: quantile không cần nhãn kết quả, nên dùng được ngay
 * từ ngày đầu. Isotonic cần nhãn, nhưng cho ra xác suất thật.
 */

/** Số mẫu tối thiểu trong buffer để phân vị có ý nghĩa. */
export const MIN_BUFFER = 40;

export interface QuantileState {
  model: string;
  /** các điểm thô gần đây nhất, theo thứ tự thời gian */
  buffer: number[];
  capacity: number;
}

export class QuantileNormalizer {
  private readonly states = new Map<string, QuantileState>();

  constructor(private readonly capacity = 200) {}

  /** Ghi nhận một điểm thô mới của model. */
  push(model: string, score: number): void {
    let s = this.states.get(model);
    if (!s) {
      s = { model, buffer: [], capacity: this.capacity };
      this.states.set(model, s);
    }
    s.buffer.push(score);
    if (s.buffer.length > s.capacity) s.buffer.shift();
  }

  /** Số mẫu hiện có của model. */
  size(model: string): number {
    return this.states.get(model)?.buffer.length ?? 0;
  }

  /**
   * Phân vị của `score` trong phân phối lịch sử của `model`, thuộc [0, 1].
   * Trả về null khi chưa đủ mẫu — bên gọi phải lui về thang neo cố định.
   *
   * Dùng mid-rank cho các giá trị bằng nhau, nếu không các model hay nhả số tròn
   * (70, 80, 90) sẽ dồn hết vào một phân vị duy nhất.
   */
  percentile(model: string, score: number): number | null {
    const s = this.states.get(model);
    if (!s || s.buffer.length < MIN_BUFFER) return null;

    let below = 0;
    let equal = 0;
    for (const v of s.buffer) {
      if (v < score) below++;
      else if (v === score) equal++;
    }
    return (below + equal / 2) / s.buffer.length;
  }

  /** Trạng thái để persist xuống đĩa. */
  snapshot(): QuantileState[] {
    return [...this.states.values()].map(s => ({ ...s, buffer: [...s.buffer] }));
  }

  /** Khôi phục trạng thái đã persist. */
  restore(states: QuantileState[]): void {
    this.states.clear();
    for (const s of states) {
      this.states.set(s.model, { ...s, buffer: s.buffer.slice(-this.capacity) });
    }
  }
}
