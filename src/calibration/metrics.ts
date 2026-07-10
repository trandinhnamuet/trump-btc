/**
 * Chỉ số đánh giá cho dự đoán xác suất.
 *
 * Thước đo trung thực duy nhất là **Brier skill score** so với một predictor
 * hằng số luôn trả về đúng base rate. Nếu skill <= 0, hệ thống không tạo ra giá
 * trị nào so với việc đoán bừa theo tần suất nền — bất kể con số nó in ra đẹp
 * đến đâu.
 */

export interface Bin {
  lo: number;
  hi: number;
  count: number;
  /** trung bình xác suất dự đoán trong bin */
  meanPred: number;
  /** tần suất thực tế quan sát được trong bin */
  meanObs: number;
}

export interface Report {
  n: number;
  baseRate: number;
  brier: number;
  brierBaseline: number;
  /** 1 − brier/brierBaseline. > 0 nghĩa là có giá trị. */
  skillScore: number;
  logLoss: number;
  logLossBaseline: number;
  /** Expected Calibration Error — độ lệch trung bình có trọng số giữa dự đoán và thực tế */
  ece: number;
  /** trung bình xác suất dự đoán. Lệch nhiều so với baseRate = bias hệ thống. */
  meanPred: number;
  /** meanPred − baseRate. Dương = model chấm cao quá. Âm = chấm thấp quá. */
  bias: number;
  /** độ lệch chuẩn của dự đoán. Gần 0 = model không phân biệt được bài nào với bài nào. */
  sd: number;
  /** AUC ROC — khả năng xếp hạng, độc lập với hiệu chuẩn. 0.5 = ngẫu nhiên. */
  auc: number;
  bins: Bin[];
}

const clamp01 = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));

export function brier(preds: number[], labels: boolean[]): number {
  if (!preds.length) return NaN;
  return preds.reduce((acc, p, i) => acc + (p - (labels[i] ? 1 : 0)) ** 2, 0) / preds.length;
}

export function logLoss(preds: number[], labels: boolean[]): number {
  if (!preds.length) return NaN;
  return (
    -preds.reduce((acc, raw, i) => {
      const p = clamp01(raw);
      return acc + (labels[i] ? Math.log(p) : Math.log(1 - p));
    }, 0) / preds.length
  );
}

export function baseRate(labels: boolean[]): number {
  if (!labels.length) return NaN;
  return labels.filter(Boolean).length / labels.length;
}

/**
 * AUC ROC qua thống kê Mann-Whitney U, có xử lý hạng đồng (ties).
 * Đây là chỉ số quan trọng nhất khi đánh giá model chưa hiệu chuẩn: nó đo khả
 * năng **xếp hạng** chứ không đo độ chính xác của con số. Một model có AUC cao
 * nhưng bias lớn vẫn cứu được bằng hiệu chuẩn; AUC ≈ 0.5 thì vô phương.
 */
export function auc(preds: number[], labels: boolean[]): number {
  const pos = preds.filter((_, i) => labels[i]);
  const neg = preds.filter((_, i) => !labels[i]);
  if (!pos.length || !neg.length) return NaN;

  const all = preds.map((p, i) => ({ p, y: labels[i] })).sort((a, b) => a.p - b.p);

  // Hạng trung bình cho các giá trị bằng nhau
  const ranks = new Array<number>(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].p === all[i].p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  const rankSumPos = all.reduce((acc, item, idx) => acc + (item.y ? ranks[idx] : 0), 0);
  return (rankSumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/**
 * Reliability diagram: chia dự đoán vào các bin, so trung bình dự đoán với tần
 * suất thực tế. Một hệ hiệu chuẩn tốt có meanPred ≈ meanObs trong mọi bin.
 *
 * Dùng bin theo phân vị (equal-count) thay vì theo giá trị, vì dự đoán thường
 * dồn cục ở một vùng hẹp — bin đều theo giá trị sẽ để trống gần hết.
 */
export function reliability(preds: number[], labels: boolean[], nBins = 10): Bin[] {
  if (!preds.length) return [];
  const idx = preds.map((_, i) => i).sort((a, b) => preds[a] - preds[b]);
  const bins: Bin[] = [];
  const per = Math.max(1, Math.floor(idx.length / nBins));

  for (let b = 0; b < nBins; b++) {
    const from = b * per;
    const to = b === nBins - 1 ? idx.length : Math.min(idx.length, (b + 1) * per);
    if (from >= to) break;
    const slice = idx.slice(from, to);
    const p = slice.map(i => preds[i]);
    const y: number[] = slice.map(i => (labels[i] ? 1 : 0));
    bins.push({
      lo: p[0],
      hi: p[p.length - 1],
      count: slice.length,
      meanPred: p.reduce((a, v) => a + v, 0) / p.length,
      meanObs: y.reduce((a, v) => a + v, 0) / y.length,
    });
  }
  return bins;
}

export function ece(bins: Bin[], n: number): number {
  if (!n) return NaN;
  return bins.reduce((acc, b) => acc + (b.count / n) * Math.abs(b.meanPred - b.meanObs), 0);
}

export function evaluate(preds: number[], labels: boolean[], nBins = 10): Report {
  const n = preds.length;
  const br = baseRate(labels);
  const constant = new Array(n).fill(br);
  const bins = reliability(preds, labels, nBins);
  const mean = preds.reduce((a, p) => a + p, 0) / n;
  const variance = preds.reduce((a, p) => a + (p - mean) ** 2, 0) / Math.max(1, n - 1);
  const b = brier(preds, labels);
  const bBase = brier(constant, labels);

  return {
    n,
    baseRate: br,
    brier: b,
    brierBaseline: bBase,
    skillScore: bBase > 0 ? 1 - b / bBase : NaN,
    logLoss: logLoss(preds, labels),
    logLossBaseline: logLoss(constant, labels),
    ece: ece(bins, n),
    meanPred: mean,
    bias: mean - br,
    sd: Math.sqrt(variance),
    auc: auc(preds, labels),
    bins,
  };
}
