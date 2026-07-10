/**
 * Isotonic regression bằng thuật toán Pool Adjacent Violators (PAV).
 *
 * Đây là tầng biến điểm thô của model thành xác suất thật: nó học ánh xạ
 * đơn điệu không giảm từ `điểm model` → `tần suất thực nghiệm quan sát được`.
 *
 * Điểm mấu chốt: hàm này KHÔNG cần model chấm đúng xác suất. Nó chỉ cần model
 * **xếp hạng** đúng thứ tự. Một model luôn chấm cao (0.6→0.9) và một model luôn
 * chấm thấp (0.05→0.2) sẽ cho ra cùng một đường hiệu chuẩn nếu thứ tự xếp hạng
 * của chúng giống nhau. Đó chính là cách triệu chứng "model này luôn cao, model
 * kia luôn thấp" bị triệt tiêu.
 */

export interface IsotonicModel {
  /** điểm thô tại biên các bậc, tăng dần */
  x: number[];
  /** xác suất đã hiệu chuẩn tương ứng, không giảm */
  y: number[];
  /** tần suất nền, dùng làm giá trị lui về khi thiếu dữ liệu */
  baseRate: number;
  /** số mẫu đã dùng để fit */
  n: number;
}

/** Số mẫu tối thiểu để đường hiệu chuẩn đáng tin. Dưới ngưỡng này ta trả về base rate. */
export const MIN_FIT_SAMPLES = 30;

/**
 * Số pseudo-count kéo mỗi bậc về phía base rate.
 * Chống overfit khi một bậc chỉ có vài quan sát: bậc có 2 mẫu và tình cờ cả 2
 * đều `moved` sẽ không nhảy lên 100%.
 */
const PSEUDO_COUNT = 5;

interface Block {
  /** tổng trọng số (số quan sát) */
  w: number;
  /** tổng nhãn (số quan sát dương) */
  sy: number;
  /** giá trị fit của khối = sy / w, sau shrinkage */
  val: number;
  /** x nhỏ nhất và lớn nhất trong khối */
  xLo: number;
  xHi: number;
}

/**
 * Fit ánh xạ đơn điệu không giảm từ điểm thô `x` sang nhãn nhị phân `y`.
 * `x` và `y` phải cùng độ dài; `y[i]` là true khi sự kiện xảy ra.
 */
export function fitIsotonic(x: number[], y: boolean[]): IsotonicModel {
  const n = x.length;
  const base = n ? y.filter(Boolean).length / n : 0;

  if (n < MIN_FIT_SAMPLES) {
    return { x: [], y: [], baseRate: base, n };
  }

  const points = x
    .map((xi, i) => ({ x: xi, y: y[i] ? 1 : 0 }))
    .sort((a, b) => a.x - b.x);

  const blocks: Block[] = [];
  for (const p of points) {
    blocks.push({ w: 1, sy: p.y, val: p.y, xLo: p.x, xHi: p.x });
    // Gộp ngược khi vi phạm tính không giảm
    while (blocks.length >= 2 && blocks[blocks.length - 2].val > blocks[blocks.length - 1].val) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      const merged: Block = {
        w: a.w + b.w,
        sy: a.sy + b.sy,
        val: (a.sy + b.sy) / (a.w + b.w),
        xLo: a.xLo,
        xHi: b.xHi,
      };
      blocks.push(merged);
    }
  }

  // Shrinkage về base rate theo số quan sát của mỗi khối
  const fx: number[] = [];
  const fy: number[] = [];
  for (const b of blocks) {
    const shrunk = (b.sy + PSEUDO_COUNT * base) / (b.w + PSEUDO_COUNT);
    // Mỗi khối đóng góp hai điểm neo (đầu và cuối) để nội suy tuyến tính giữ được bậc
    fx.push(b.xLo, b.xHi);
    fy.push(shrunk, shrunk);
  }

  // Shrinkage có thể phá vỡ tính đơn điệu ở các khối nhỏ → ép lại bằng running max
  for (let i = 1; i < fy.length; i++) fy[i] = Math.max(fy[i], fy[i - 1]);

  return { x: fx, y: fy, baseRate: base, n };
}

/** Áp đường hiệu chuẩn cho một điểm thô. Nội suy tuyến tính, chặn ở hai đầu. */
export function applyIsotonic(model: IsotonicModel, score: number): number {
  if (!model.x.length) return model.baseRate;
  const { x, y } = model;

  if (score <= x[0]) return y[0];
  if (score >= x[x.length - 1]) return y[y.length - 1];

  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= score) lo = mid;
    else hi = mid;
  }

  const span = x[hi] - x[lo];
  if (span <= 0) return y[hi];
  const t = (score - x[lo]) / span;
  return y[lo] + t * (y[hi] - y[lo]);
}
