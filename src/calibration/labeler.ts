import { BinanceHistory } from './binance-history';
import {
  Bar,
  EWMA_LAMBDA,
  Label,
  MIN_HOURLY_RETURNS,
  UnlabeledPost,
  VOL_LOOKBACK_DAYS,
  Z_THRESHOLD,
} from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Bài viết tối thiểu cần có để gắn nhãn. */
export interface LabelablePost {
  id: string;
  createdAt: string;
}

/**
 * EWMA std của một chuỗi log-return.
 *
 * v[i] = λ·v[i-1] + (1-λ)·r[i]²   — khởi tạo v bằng phương sai mẫu của 1/4 đầu chuỗi
 * để không bị chi phối bởi một quan sát duy nhất.
 *
 * Chỉ dùng dữ liệu trước t0, nên không có look-ahead.
 */
export function ewmaStd(returns: number[], lambda = EWMA_LAMBDA): number {
  if (returns.length < 2) return 0;

  const seedLen = Math.max(2, Math.floor(returns.length / 4));
  const seed = returns.slice(0, seedLen);
  const seedMean = seed.reduce((a, b) => a + b, 0) / seed.length;
  let v = seed.reduce((a, r) => a + (r - seedMean) ** 2, 0) / (seed.length - 1);

  for (let i = seedLen; i < returns.length; i++) {
    v = lambda * v + (1 - lambda) * returns[i] ** 2;
  }
  return Math.sqrt(v);
}

/** Log-return giữa các mốc giờ liền kề; bỏ qua mọi cặp bắc qua khoảng trống dữ liệu. */
function contiguousHourlyReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].t - bars[i - 1].t !== HOUR_MS) continue;
    if (bars[i - 1].c <= 0 || bars[i].c <= 0) continue;
    out.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  return out;
}

/**
 * Gộp các bài có cửa sổ kết quả [t0, t0+1h] chồng lấn vào cùng một cluster
 * (single-linkage, ngưỡng 1 giờ).
 *
 * Trump thường đăng liên tiếp nhiều bài trong vài phút. Các bài đó chia sẻ đúng
 * một kết quả thị trường. Nếu tính chúng như những quan sát độc lập, mọi chỉ số
 * đánh giá đều bị thổi phồng.
 */
function assignClusters(sortedT0: number[]): number[] {
  const ids: number[] = [];
  let cluster = 0;
  for (let i = 0; i < sortedT0.length; i++) {
    if (i > 0 && sortedT0[i] - sortedT0[i - 1] >= HOUR_MS) cluster++;
    ids.push(cluster);
  }
  return ids;
}

/**
 * Gắn nhãn kết quả thực tế cho danh sách bài viết.
 * `history` phải đã `load()` phủ [min(t0) − VOL_LOOKBACK_DAYS, max(t0) + 1h].
 */
export function labelPosts(
  posts: LabelablePost[],
  history: BinanceHistory,
): { labels: Label[]; unlabeled: UnlabeledPost[] } {
  const labels: Label[] = [];
  const unlabeled: UnlabeledPost[] = [];

  const parsed = posts
    .map(p => ({ id: p.id, t0: Date.parse(p.createdAt) }))
    .filter(p => {
      if (Number.isNaN(p.t0)) {
        unlabeled.push({ postId: p.id, t0: null, reason: 'createdAt không parse được' });
        return false;
      }
      return true;
    })
    .sort((a, b) => a.t0 - b.t0);

  const clusters = assignClusters(parsed.map(p => p.t0));

  parsed.forEach((post, idx) => {
    const { id, t0 } = post;

    const p0 = history.closeAtOrBefore(t0);
    if (p0 === null) {
      unlabeled.push({ postId: id, t0, reason: 'thiếu dữ liệu giá tại t0' });
      return;
    }

    const p1h = history.closeAtOrBefore(t0 + HOUR_MS);
    if (p1h === null) {
      unlabeled.push({ postId: id, t0, reason: 'thiếu dữ liệu giá tại t0+1h (bài quá mới?)' });
      return;
    }

    const volBars = history.hourlyCloses(t0 - VOL_LOOKBACK_DAYS * DAY_MS, t0);
    const volReturns = contiguousHourlyReturns(volBars);
    if (volReturns.length < MIN_HOURLY_RETURNS) {
      unlabeled.push({
        postId: id,
        t0,
        reason: `chỉ có ${volReturns.length}/${MIN_HOURLY_RETURNS} log-return theo giờ để tính σ`,
      });
      return;
    }

    const sigma = ewmaStd(volReturns);
    if (!(sigma > 0)) {
      unlabeled.push({ postId: id, t0, reason: 'σ = 0 (thị trường đứng im hoặc dữ liệu lỗi)' });
      return;
    }

    const r1h = Math.log(p1h / p0);
    const z = r1h / sigma;

    labels.push({
      postId: id,
      t0,
      p0,
      p1h,
      r1h,
      sigma,
      z,
      moved: Math.abs(z) >= Z_THRESHOLD,
      up: z > 0,
      clusterId: clusters[idx],
    });
  });

  return { labels, unlabeled };
}

/**
 * Giữ lại một bài đại diện cho mỗi cluster (bài sớm nhất).
 * Mọi chỉ số đánh giá phải chạy trên tập đã khử trùng lặp này.
 */
export function dedupeByCluster(labels: Label[]): Label[] {
  const seen = new Set<number>();
  const out: Label[] = [];
  for (const l of [...labels].sort((a, b) => a.t0 - b.t0)) {
    if (seen.has(l.clusterId)) continue;
    seen.add(l.clusterId);
    out.push(l);
  }
  return out;
}
